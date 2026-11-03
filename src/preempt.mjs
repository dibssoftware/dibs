// Pausing low-priority work instead of making urgent work wait for it.
//
// Two things pause a run lease's whole process tree (SIGSTOP on every process
// group it's spread over) without ending it:
//   - An urgent or high waiter that a low or idle lease is in the way of. The
//     paused lease lends that waiter its slot and its cores, and resumes
//     (SIGCONT) when the waiter's lease ends, however it ends.
//   - Memory pressure, seen by `dibs throttle --watch`. Jobs running on top of
//     a full resource (src/overlap.mjs) pause first, newest first, then idle
//     and low leases, furthest over their memory first, one at a time until
//     pressure eases.
//   - Free disk under minDisk while swap grows on it, also seen by the watcher.
//     Jobs on top pause first, then idle, low and normal work, newest first,
//     one each pass (two when it's falling fast) until it stops, and they resume once there's room again.
//     If swap keeps growing anyway, the paused jobs' memory is what's going to
//     swap: one is stopped each pass, and its dibs run starts it again from the
//     front of its line (diskRequeue). Only on resources marked rerun.
//
// A paused lease keeps its lease and its place, and its run clock stops.
// Stopped processes keep their memory, so a paused lease still counts against
// the memory budget: the slot and cores are lent, the memory isn't.
//
// Each pause is an entry in lease.pauses ({ lease } for a waiter, { watcher }
// for memory pressure, { watcher, disk } for the disk, { owner, by } for a dibs pause by hand, src/override.mjs). The tree is stopped while there's at least one entry.
// Signals are queued during a state change and sent once the new state is on
// disk, still under the lock (flush), so pauses and resumes from different
// processes can't cross, and a caller that dies mid-change never leaves a job
// stopped with no record of why. settle() runs at the end of every state
// change and drops entries whose lease or watcher is gone, so a crashed waker
// never leaves a job stopped past the next dibs call.
//
// Windows has no SIGSTOP. Nothing is ever paused there, and urgent work waits
// as it always did.
import fs from 'node:fs';
import path from 'node:path';
import { resCfg, HOME } from './config.mjs';
import { makeAlive, pstart, tag, isMine } from './proc.mjs';
import { descendants, stopTree, runningIn, OS } from './platform.mjs';
import { verdict, used, holdsOf, lent, coveredNow, overBy, BACKGROUND, swapGrowing, diskDraining, working, remaining, typical, pausedFor } from './schedule.mjs';
import { pressureVictim, pausedLine } from './overlap.mjs';
import { tellOverAsk } from './measure.mjs';
import { bytes, dur, say, now, sleepSync } from './util.mjs';

// Stop rounds for a pause, and the wait before each check: 25 ms lets a stop
// land on a busy machine, and 5 rounds catch a child that forks once more.
const STOP_ROUNDS = 5, STOP_GAP = 25;

// Waiters that may pause someone else's work.
const PREEMPTS = new Set(['urgent', 'high']);

// Memory pressure readings in a row before acting: two critical ones (20s at
// the watcher's 10s pace) to pause, six normal ones (a minute) to resume. A
// warning reading resets both, so nothing flaps while the machine hovers.
export const PRESSURE = { pauseAfter: 2, resumeAfter: 6 };

// A run of low or idle work whose process tree dibs knows, on resources that
// all allow pausing. Holds are never paused: their pid is the agent itself.
export function pausable(l, cfg) {
  return OS !== 'windows' && l.kind === 'run' && !!l.pgid && BACKGROUND.has((l.prio || 'normal'))
    && l.res.every(r => resCfg(cfg, r).pausable === true);
}

const pressured = l => !!l.pauses?.some(p => p.watcher);

// dibs never leaves every job paused. Stopped jobs keep their memory and their
// swap, so with none running nothing can finish and free any, and every waiter
// waits on paused memory forever. On 2026-10-15 the watcher paused a Playwright
// run while a deploy still ran; the deploy ended, and the machine sat with
// every job stopped. Only a dibs pause by hand (the person's or an agent's) may stop the last one.
// Every automatic pause goes through mayPause; heal (from settle, so on every
// state change and every watcher pass) resumes one if all are stopped anyway.
// A job ended and requeued for the disk (diskRequeue) isn't a pause: it frees
// its memory and swap, so it may be the last one running.
//
// A run inside a paused one (a nested dibs run) is stopped with it.
function stoppedBy(s, ids) {
  const out = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of s.leases) if (x.outer != null && out.has(x.outer) && !out.has(x.id)) { out.add(x.id); grew = true; }
  }
  return out;
}
// Leases making progress: runs not stopped, and holds an urgent pause was lent to.
function running(s, also = []) {
  const stopped = stoppedBy(s, [...s.leases.filter(l => l.pausedAt).map(l => l.id), ...also]);
  const lentTo = new Set(s.leases.flatMap(l => (l.pauses || []).map(p => p.lease)).filter(x => x != null));
  return s.leases.filter(l => !stopped.has(l.id) && (working(l) || lentTo.has(l.id)));
}
// Pausing a job about to finish frees nothing finishing wouldn't free sooner:
// under NEAR_END left, or the last NEAR_SHARE of its usual run. One that has
// overrun its usual time by more than NEAR_END isn't about to finish.
const NEAR_END = 2 * 60e3, NEAR_SHARE = 0.1;
function nearlyDone(l, hist, t) {
  const e = l.est || typical(hist, l.key);
  if (e == null) return false;
  const left = e - (t - l.start - pausedFor(l, t));
  return left > -NEAR_END && (left < NEAR_END || left < e * NEAR_SHARE);
}
// starting: the pause lends to a waiter that starts in this same change.
export function mayPause(s, l, hist = [], t = now(), starting = false) {
  if (nearlyDone(l, hist, t)) return false;
  return starting || running(s, [l.id]).length > 0;
}

// When every run is stopped and dibs stopped at least one, resume the one
// closest to done. Returns it, or null.
export function heal(s, t = now(), hist = () => []) {
  if (!s.leases.some(l => l.kind === 'run') || running(s).length) return null;
  // Not one inside a run that stays paused: resuming it would leave it stopped all the same.
  const inside = stoppedBy(s, s.leases.filter(l => l.pausedAt).map(l => l.id));
  const ours = s.leases.filter(l => l.pausedAt && !l.pauses?.some(p => p.owner) && !(l.outer != null && inside.has(l.outer)));
  if (!ours.length) return null;
  const h = hist();
  const left = l => remaining(l, h, t) ?? Infinity;
  const l = ours.sort((a, b) => left(a) - left(b) || a.start - b.start)[0];
  l.pauses = [];
  sync(l);
  try { fs.appendFileSync(path.join(HOME, 'cool.log'), `${new Date(t).toISOString()} every job was paused: resumed ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}), the closest to done, so something can finish\n`); } catch {}
  return l;
}

// Signals waiting for the state file to be written.
const queued = [];
export function flush(send = true) {
  for (const f of queued.splice(0)) if (send) f();
}

// The run's own process is still the one dibs started, not a reused pid.
const ours = l => !l.pgstart || makeAlive([l.pgid])(l.pgid, l.pgstart);

// Stop or continue the tree to match l.pauses, and tell its owner. Called
// under the state lock.
function sync(l) {
  if (l.pauses?.length && !l.pausedAt) {
    // Groups the run's tracker hasn't noted yet are found now. A stopped tree
    // can't start new processes, so this list is still whole at resume.
    // If the job has already ended, its numbers may belong to someone else now: stop nothing.
    const groups = new Set();
    if (ours(l)) {
      for (const g of [l.pgid, ...(l.groups || [])]) groups.add(g);
      for (const g of descendants(l.pgid)) groups.add(g);
    }
    l.stopped = [...groups];
    l.pausedAt = now();
    const { stopped } = l;
    // A child forked while the stop goes out isn't in the group yet and runs on
    // while the job reads as paused: 1 pause in 30 left one running on
    // 2026-10-16, and that child may fork again before it's caught. So stop
    // until nothing in the groups is running, and log what still is after
    // STOP_ROUNDS, rather than call it paused. The usual cost is one ps call.
    queued.push(() => {
      for (const g of stopped) stopTree(g, 'SIGSTOP');
      let left = [];
      for (let i = 0; i < STOP_ROUNDS; i++) {
        sleepSync(STOP_GAP);
        left = runningIn(stopped);
        if (!left.length) break;
        for (const g of stopped) stopTree(g, 'SIGSTOP');
      }
      // A process in the kernel (D) reads as stopped only once a stop has reached it, and one
      // forked since the last stop hasn't had one: one more, which a stopped process ignores.
      for (const g of stopped) stopTree(g, 'SIGSTOP');
      if (left.length) try { fs.appendFileSync(path.join(HOME, 'cool.log'), `${new Date().toISOString()} pausing #${l.id} (${l.who} ${l.res.join(',')}): pids ${left.join(' ')} still running after ${STOP_ROUNDS} stops\n`); } catch {}
    });
    tell(l);
  } else if (!l.pauses?.length && l.pausedAt) {
    const groups = new Set([l.pgid, ...(l.stopped || []), ...(l.groups || [])]);
    queued.push(() => { for (const g of groups) if (g) stopTree(g, 'SIGCONT'); });
    l.pausedMs = (l.pausedMs || 0) + now() - l.pausedAt;
    delete l.pausedAt; delete l.stopped; delete l.pauses;
    tell(l);
  } else if (l.pauses && !l.pauses.length) delete l.pauses;
}

// The owner's `dibs run` reads the lease and says what happened on its stderr.
// Only runs that asked for it get the signal: SIGUSR2 ends a process that
// doesn't handle it, such as a run started by an older dibs.
function tell(l) {
  const { notify, pid } = l;
  if (notify && pid) queued.push(() => { try { process.kill(pid, 'SIGUSR2'); } catch {} });
}

// Fewest new stops first: a lease already paused for memory costs nothing to
// lend. Then idle before low, then the most recently started.
const victimOrder = (a, b) => pressured(b) - pressured(a) || (b.prio === 'idle') - (a.prio === 'idle') || b.start - a.start;

// Called when an urgent or high waiter can't start because a slot is full.
// Pauses the fewest low and idle leases that would let it start now, or none:
// if pausing wouldn't get it going (budget, disk, someone ahead), nothing is
// touched. Returns the verdict with the paused leases, or null.
export function preempt(s, me, cfg, hist, t = now()) {
  if (!PREEMPTS.has(me.prio) || OS === 'windows') return null;
  // Raised by its own agent: it may pause that session's runs, nobody else's.
  const mine = holdsOf(s, me);
  const victims = [];
  for (const r of me.res) {
    if (mine.has(r)) continue;
    const need = used(s, r) - resCfg(cfg, r).slots + 1 - victims.filter(l => l.res.includes(r)).length;
    if (need <= 0) continue;
    // A run its own session's hold covers takes no slot, so pausing it frees none.
    const pick = s.leases.filter(l => l.res.includes(r) && !victims.includes(l) && !lent(l) && !coveredNow(s, l, r) && pausable(l, cfg)
      && mayPause(s, l, hist, t, true)).sort(victimOrder);
    if (pick.length < need) return null;
    victims.push(...pick.slice(0, need));
  }
  if (!victims.length) return null;
  const entry = { lease: me.id, who: tag(me), prio: me.prio, purpose: me.purpose || '', res: me.res, at: t };
  for (const l of victims) (l.pauses ||= []).push({ ...entry });
  const v = verdict(s, me, cfg, hist, t);
  if (!v.ok) {
    for (const l of victims) { l.pauses.pop(); if (!l.pauses.length) delete l.pauses; }
    return null;
  }
  for (const l of victims) sync(l);
  return { ...v, paused: victims.map(l => ({ id: l.id, who: tag(l), res: l.res, prio: l.prio })) };
}

// Drop pauses whose waker is gone and resume what that frees: the lease it
// was lent to has ended (or its process died and was reaped), or the pressure
// watcher died. Runs at the end of every state change.
//
// A disk pause outlives its watcher by WATCHER_GRACE: launchd restarts the
// watcher within seconds (every release kickstarts it), and the new one adopts
// the pauses (adoptPauses). Resuming every disk-paused job at once in a disk
// crunch would undo the pauses it took minutes to make.
export const WATCHER_GRACE = 60e3;
export function settle(s, t = now(), hist = () => []) {
  const paused = s.leases.filter(l => l.pauses || l.pausedAt);
  if (!paused.length) return;
  const ids = new Set(s.leases.map(l => l.id));
  const watchers = paused.flatMap(l => (l.pauses || []).filter(p => p.watcher).map(p => p.watcher));
  const alive = watchers.length ? makeAlive(watchers) : () => false;
  const keep = p => {
    if (p.owner) return true;
    if (!p.watcher) return ids.has(p.lease);
    if (alive(p.watcher, p.wstart)) { delete p.gone; return true; }
    if (!p.disk) return false;
    p.gone ??= t;
    return t - p.gone < WATCHER_GRACE;
  };
  for (const l of paused) {
    l.pauses = (l.pauses || []).filter(keep);
    sync(l);
  }
  heal(s, t, hist);
}

// A new watcher takes over the disk pauses a stopped one left (settle keeps
// them for WATCHER_GRACE). Returns how many it adopted.
export function adoptPauses(s, pid = process.pid, wstart = pstart(process.pid)) {
  let n = 0;
  for (const l of s.leases) for (const p of l.pauses || []) if (p.disk && p.watcher && p.watcher !== pid) { Object.assign(p, { watcher: pid, wstart }); delete p.gone; n++; }
  return n;
}

// One pressure reading: 'pause', 'resume' or null. `track` carries the
// streaks between readings.
export function pressureStep(track, level) {
  if (level == null) return null;
  if (level >= 2) {
    track.low = 0;
    if (++track.high >= PRESSURE.pauseAfter) { track.high = 0; return 'pause'; }
  } else if (level === 0) {
    track.high = 0;
    if (++track.low >= PRESSURE.resumeAfter) { track.low = 0; return 'resume'; }
  } else track.high = track.low = 0;
  return null;
}

// Free disk under minDisk while swap grows or the disk drains: the jobs running
// now are what's filling it, so holding new starts isn't enough. Swap grew 2 GB
// a minute on 2026-10-15, so 3 GB left only 90s; minDisk (5G stock) gives the
// watcher's 10s passes a few minutes. Never under DISK_FLOOR, whatever minDisk says.
export const DISK_FLOOR = 3 * 1024 ** 3;
export const diskLine = cfg => Math.max(bytes(cfg.minDisk), DISK_FLOOR);
// Still growing or falling now, not just over the last 5 minutes (schedule.mjs swapGrowing).
export const diskCritical = (m, cfg) => m.diskFree != null && m.diskFree < diskLine(cfg) && (swapGrowing(m) || diskDraining(m));

// Draining fast enough to be down to DISK_LAST within DISK_SOON, two runs pause
// each pass instead of one: at the worst rate seen, one a pass would come too late.
const DISK_LAST = 1024 ** 3, DISK_SOON = 2 * 6e4;
export function diskPausesPerPass(m) {
  if (!(m.diskDrain > 0) || m.diskFree == null) return 1;
  const perMs = m.diskDrain / Math.max(m.drainMs || 0, 30e3);   // a span under one reading apart isn't a rate
  return m.diskFree - DISK_LAST < perMs * DISK_SOON ? 2 : 1;
}

// One disk reading: 'pause' while it's critical, 'resume' once free disk has
// been back over the line pausing uses and steady for a minute. Paused jobs
// keep their memory, so their swap stays and the disk may never come back over
// the line: after DISK_STILL readings with nothing growing or falling, one
// resumes anyway, since waiting frees nothing then. `track` carries the streaks.
const DISK_STILL = 18;   // 3 minutes at the watcher's 10s pace
export function diskStep(track, m, cfg) {
  if (diskCritical(m, cfg)) { track.diskOk = track.diskStill = 0; return 'pause'; }
  const still = m.diskFree != null && !swapGrowing(m) && !diskDraining(m);
  if (!still) { track.diskOk = track.diskStill = 0; return null; }
  track.diskStill = (track.diskStill || 0) + 1;
  track.diskOk = m.diskFree >= diskLine(cfg) ? (track.diskOk || 0) + 1 : 0;
  if (track.diskOk >= PRESSURE.resumeAfter || track.diskStill >= DISK_STILL) { track.diskOk = track.diskStill = 0; return 'resume'; }
  return null;
}

// Pause the next lease while free disk is low and filling: one on top of a full
// resource first, then idle, low and normal work, newest first (the newest is
// likeliest to be the one growing). Urgent and high work, holds, and resources
// that can't pause are left alone. Nothing is killed. Returns it, or null.
const DISK_ORDER = { idle: 0, low: 1 };
export function diskPause(s, cfg, t = now(), m = {}, hist = []) {
  const rank = l => DISK_ORDER[(l.prio || 'normal')] ?? 2;
  const l = s.leases.filter(x => OS !== 'windows' && x.kind === 'run' && x.pgid && !x.pausedAt && !PREEMPTS.has((x.prio || 'normal'))
      && x.res.every(r => resCfg(cfg, r).pausable === true) && mayPause(s, x, hist, t))
    .sort((a, b) => !!b.alongside - !!a.alongside || rank(a) - rank(b) || b.start - a.start)[0];
  if (!l) return null;
  (l.pauses ||= []).push({ watcher: process.pid, wstart: pstart(process.pid), at: t, disk: true, swap: swapGrowing(m) });
  sync(l);
  return { ...l };
}

// A job paused for low disk keeps its memory, and under memory pressure that
// memory goes to swap, whose files fill the disk the job waits on: on
// 2026-10-16 two disk-paused jobs (one 6 GB) took swap from 4 to 10 GB and free
// disk from 4.5 to 0.9 GB. A job running far past what it booked does the same
// while it runs: on 2026-10-17 a test run booked at 11 GB used 16 and took swap
// to 8.9 GB. While the disk is critical and swap still grows, the watcher stops
// one such job a pass, the most memory first. Its own dibs run puts it back at
// the front of its line, booked at what it really used, and runs it again from
// the start once that much memory is really free (src/commands.mjs run), so its
// agent's call goes on. Only jobs dibs can run again without harm (every
// resource rerun: true), whose dibs run knows how (requeuable), not nearly done,
// and not paused by a person or agent.
//
// Stopping a running one may leave nothing running, and that's meant: unlike a
// pause, a stop gives back all of its memory, and a job using this much more
// than it booked is the hazard itself. Booked at its real size, it can't start
// again into the same crunch. One that goes past its booking again after that
// isn't stopped a second time (OVER_AGAIN): its pauses and the person handle it.
const OVER_FACTOR = 2, OVER_MIN = 4 * 1024 ** 3, OVER_AGAIN = 1;
export const measured = l => Math.max(l.use?.mem || 0, l.peak?.mem || 0);
// Far past its booking: at least OVER_MIN over it, and twice it or more than all
// the memory dibs shares out (a job bigger than the budget is booked at the budget).
export const overBooked = (l, cfg) => {
  const u = measured(l);
  return u - l.mem >= OVER_MIN && (u >= l.mem * OVER_FACTOR || u > bytes(cfg.budget));
};
export function diskRequeue(s, cfg, t = now(), hist = []) {
  const why = x => (x.pausedAt ? (x.pauses?.some(p => p.disk) ? 'disk' : null) : overBooked(x, cfg) && (x.requeues || 0) < OVER_AGAIN ? 'over' : null);
  const l = s.leases.filter(x => x.kind === 'run' && x.requeuable && !x.requeue && why(x) && !x.pauses?.some(p => p.owner)
      && x.res.every(r => resCfg(cfg, r).rerun === true) && !nearlyDone(x, hist, t))
    .sort((a, b) => (measured(b) || b.mem || 0) - (measured(a) || a.mem || 0))[0];
  if (!l) return null;
  l.requeue = { at: t, why: why(l) };
  // Killed where it stands: SIGKILL ends a stopped process too. Its dibs run sees it end.
  if (ours(l)) {
    const groups = [...new Set([l.pgid, ...(l.stopped || []), ...(l.groups || [])].filter(Boolean))];
    queued.push(() => { for (const g of groups) stopTree(g, 'SIGKILL'); });
  }
  return { ...l };
}

// Pause the next lease under memory pressure: a job running on top of a full
// resource first, newest first (src/overlap.mjs), since it's the extra load;
// then the one furthest over the memory it asked for (it's why the books are
// wrong), then idle before low, then the most memory. Returns it, or null when
// nothing is left to pause.
export function pressurePause(s, cfg, t = now(), hist = []) {
  const top = pressureVictim(s, cfg);
  const l = (top && mayPause(s, top, hist, t) ? top : null) || s.leases.filter(x => pausable(x, cfg) && !pressured(x) && mayPause(s, x, hist, t))
    .sort((a, b) => overBy(b) - overBy(a) || (b.prio === 'idle') - (a.prio === 'idle') || b.mem - a.mem)[0];
  if (!l) return null;
  (l.pauses ||= []).push({ watcher: process.pid, wstart: pstart(process.pid), at: t });
  sync(l);
  return { ...l };
}

// Resume one lease paused for memory pressure (or, with disk, for the disk),
// in the reverse order: jobs on top last, low before idle, then the least
// memory. With all = true, every one (the watcher is stopping); 'memory', every
// memory pause and no disk ones. Returns what it resumed.
export function pressureResume(s, all = false, disk = false) {
  const ours = p => p.watcher && (all === 'memory' ? !p.disk : all || !!p.disk === disk);
  const ls = s.leases.filter(l => l.pauses?.some(ours)).sort((a, b) => !!a.alongside - !!b.alongside || (a.alongside ? a.start - b.start : 0)
    || (a.prio === 'idle') - (b.prio === 'idle') || a.mem - b.mem);
  const out = all ? ls : ls.slice(0, 1);
  for (const l of out) { l.pauses = l.pauses.filter(p => !ours(p)); sync(l); }
  return out.map(l => ({ ...l }));
}

// The owner's pause: kept until dibs resume or the lease ends, whatever else
// pauses or resumes it in between. `by` names the agent that paused it (none:
// the person). Anyone's resume lifts every owner pause.
export function ownerPause(l, on, t = now(), by = null, reason = '') {
  if (on) (l.pauses ||= []).push({ owner: true, at: t, ...(by && { by }), ...(reason && { reason }) });
  else l.pauses = (l.pauses || []).filter(p => !p.owner);
  sync(l);
}
// Who paused it by hand: an agent's name, or 'owner' for the person.
const pausedBy = l => { const p = l.pauses?.find(x => x.owner); return p ? p.by || 'owner' : null; };

// What the board shows next to a paused lease.
export function pauseLabel(l) {
  if (!l.pausedAt) return '';
  if (pausedBy(l)) return `paused by ${pausedBy(l)}`;
  const by = (l.pauses || []).filter(p => p.lease != null).map(p => p.who);
  if (by.length) return `paused for ${[...new Set(by)].join(', ')}`;
  return l.pauses?.some(p => p.disk) ? 'paused: disk low' : 'paused: memory pressure';
}

// The SIGUSR2 handler for the owner's `dibs run`: say on its stderr that the
// job was paused or resumed. `read` returns the lease from the state file.
export function noticeHandler(read) {
  let since = null;
  return () => {
    const l = read();
    if (!l) return;
    tellOverAsk(l);
    if (l.pausedAt && !since) {
      since = l.pausedAt;
      const p = (l.pauses || []).find(x => x.lease != null);
      const by = pausedBy(l);
      const why = l.pauses.find(x => x.owner)?.reason;
      say(by ? `${by === 'owner' ? 'the owner (the person at this machine)' : by} paused your job (dibs pause ${l.id})${why ? `: "${why}"` : ''}. It keeps its lease and its place; dibs resume ${l.id} continues it.`
          + ' Its processes were stopped (SIGSTOP) and continue where they were when it resumes. Anything waiting on a server meanwhile (an HTTP request, an upload) may have timed out on the far side: check its output for timeouts.'
        : p
        ? `paused your job for ${p.who} (${p.prio}${p.purpose ? `: "${p.purpose}"` : ''}), who needed ${p.res.join(', ')}.`
          + ' It keeps its lease and its place, and resumes when their job ends.' + ' Its processes were stopped (SIGSTOP) and continue where they were when it resumes. Anything waiting on a server meanwhile (an HTTP request, an upload) may have timed out on the far side: check its output for timeouts.'
        : l.pauses?.some(x => x.disk)
        ? `paused your job: free disk is low and ${l.pauses.some(x => x.swap) ? 'swap is still growing on it' : 'still falling'}. It keeps its lease and its place, and resumes once there's room again.`
          + ' If it stays paused, free some disk space.' + ' Its processes were stopped (SIGSTOP) and continue where they were when it resumes. Anything waiting on a server meanwhile (an HTTP request, an upload) may have timed out on the far side: check its output for timeouts.'
        : l.alongside ? pausedLine()
        : `paused your ${l.prio} job: the machine is short on memory. It keeps its lease and resumes when memory pressure eases.`);
    } else if (!l.pausedAt && since) {
      say(`resumed your job after ${dur(now() - since)} paused${l.resumeReason ? `: "${l.resumeReason}"` : ''}.`);
      since = null;
    }
  };
}
