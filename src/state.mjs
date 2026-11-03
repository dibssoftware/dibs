// The shared state file: who holds what and who's waiting. Every change goes
// through withState, which holds the state lock for a few milliseconds.
//
// The lock (src/lock.mjs, which says why in full):
// - One holder: ~/.dibs/lock is renamed into place already holding its owner file, so it's
//   never seen without one, and of two makers one wins.
// - Stale only when its owner is dead, a zombie or stopped (ps), never for its age: a live
//   holder, however slow, is waited for, and nothing gives up. One holding past a minute is
//   reported once, loudly (stuck below), and plain dibs shows the last state instead of waiting.
// - Takeover renames the stale owner's file to the taker's own, inside the lock, so of two
//   takers one wins and a fresh lock is never moved or taken by mistake.
// - A holder checks it still holds the lock just before its rename of state.json.<pid>.tmp;
//   taken over (it was stopped), it writes nothing and makes its change again.
// - Release removes only its own lock, and never throws.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.mjs';
import { makeAlive } from './proc.mjs';
import { acquire, commit, commandOf, LostLock } from './lock.mjs';
import { stopTree, starts, liveGroups, wokeAt, OS } from './platform.mjs';
import { settle, flush } from './preempt.mjs';
import { reapPool } from './simpool.mjs';
import { queueResets, startResets, reapResets } from './reset.mjs';
import { logChanges, event } from './events.mjs';
import { die, now, say, dur, noSpace, fakeFull, unpolled, GHOST_AFTER, POLLED_EVERY, UNPOLLED } from './util.mjs';

export const KEEP_PLACE = 120e3;   // a waiter that gave up keeps its place this long
// A waiter looks at its place every second or so, and a broker for its thin waiters as often:
// a minute is plenty for one that's alive to see the owner stopped it.
export const STOP_GRACE = POLLED_EVERY;
const STOPPED_FOR = 10 * POLLED_EVERY;
const QUIET_GRACE = 2 * POLLED_EVERY;   // two stamps' time, for every waiter to look in again

export function withState(fn, wait = Infinity) {
  warm();
  for (;;) {
    const giveUp = deadline != null && wait === Infinity;
    const lock = acquire(paths.lock, { wait: giveUp ? Math.max(deadline - now(), LEAVE_GRACE) : wait, fake: () => fakeFull('lock'), files: [paths.state], onStuck: stuck });
    if (!lock && giveUp) die(`gave up waiting: the state lock stayed held past this wait's limit (dibs is stuck behind another process; dibs alerts says which). Your command did NOT run (exit 75).`, 75);
    if (!lock) return undefined;
    try { return change(fn, lock); }
    catch (e) { if (!(e instanceof LostLock)) throw e; }   // taken over while stopped, before it wrote: change again
  }
}

// A run or hold waiting in line with a limit (--max-wait, or 8m outside Claude Code) gives up with 75
// at that limit even when what holds it up is the state lock itself. Set by src/acquire.mjs while it
// waits; LEAVE_GRACE past it is still allowed, for giving its place back.
let deadline = null;
const LEAVE_GRACE = 5000;
export const setLockDeadline = at => { deadline = at; };

// A live holder is waited for however long it takes, but one holding past STUCK_AFTER is hung,
// and with it all of dibs. The first waiter to notice says so, once per holder: an event the
// alerts make loud (src/alerts.mjs), and a line on its own terminal.
export const STUCK_DIR = path.join(path.dirname(paths.lock), 'lockstuck');
function stuck(o, held) {
  fs.mkdirSync(STUCK_DIR, { recursive: true });
  try { fs.writeFileSync(path.join(STUCK_DIR, o.key), '', { flag: 'wx' }); } catch { return; }
  for (const n of fs.readdirSync(STUCK_DIR)) if (n !== o.key) try { fs.rmSync(path.join(STUCK_DIR, n), { force: true }); } catch {}
  const cmd = commandOf(o.pid);
  event({ at: now(), kind: 'lockstuck', key: o.key, pid: o.pid, cmd, held });
  say(`dibs is stuck behind pid ${o.pid}${cmd ? ` (${cmd.slice(0, 80)})` : ''}, which has held the state lock for ${dur(held)}. `
    + `Waiting for it. If it's hung, ending it lets everyone go on: kill ${o.pid}`);
}

function change(fn, lock) {
  let written = false, moved = false;
  vanished = [];
  try {
    const { s, raw } = read();
    const before = [...s.leases];
    const line = ids(s);
    const paused = new Map(before.map(l => [l.id, l.pausedAt]));
    // A live waiter stamps its place once a minute, so a state file nobody wrote for longer
    // than UNPOLLED means everyone went quiet at once (the machine slept): every place gets
    // QUIET_GRACE to be looked at again before any counts as one nobody decides for.
    let wrote = null;
    try { wrote = fs.statSync(paths.state).mtimeMs; } catch {}
    if (wrote != null && now() - wrote > UNPOLLED) s.graceUntil = now() + QUIET_GRACE;
    reap(s);
    const out = fn(s);
    settle(s, now(), history);   // resume work paused for a lease that has ended, and never leave every job paused
    queueResets(s, before.filter(l => !s.leases.some(x => x.id === l.id)));   // onRelease for every lease this change ended
    // Nothing changed, nothing written: most waiters' polls change nothing, and
    // an unchanged file tells a waiter it can poll less often (src/acquire.mjs nextPoll).
    const text = JSON.stringify(s, null, 1);
    if (text !== raw) {
      // A write cut short by a full disk leaves the old state in place, and no half file taking up space.
      if (!commit(lock, paths.state, text, { fake: () => fakeFull('state') }))
        event({ at: now(), kind: 'clobbered', pid: process.pid, why: 'the state lock was taken over between the ownership check and the write' });
      written = true;
      moved = ids(s) !== line;
    }
    logChanges(before, paused, s);
    for (const e of vanished) event(e);
    flush();   // pause and resume signals, now that the state says why
    return out;
  } finally {
    flush(false);   // a change that failed sends nothing
    lock.release();
    if (moved && kicks) try { kick(); } catch {}   // after the lock, which the broker takes next
    startResets(written);
  }
}

// Every pid the state names, whose start times reap() checks.
const pidsOf = s => [...(s.leases || []).map(l => l.pid), ...(s.queue || []).map(q => q.pid || q.keptFor), ...(s.resets || []).flatMap(x => [x.pid, x.cpid])];

// Read those start times before taking the lock, so reap() under it finds them in
// makeAlive's cache instead of running ps: on 2026-11-11 that ps (100 to 700 ms on a
// Mac at load 30) was most of every first hold, and the lock was held 83% of the time.
// On Windows each start time is a PowerShell read, about 0.4 s: twelve runs at once queued for the
// lock past its old 45 s limit on a CI runner.
function warm() {
  try { makeAlive(pidsOf(JSON.parse(fs.readFileSync(paths.state, 'utf8')))); } catch {}
}

// The broker (src/broker.mjs) ticks when kicked: one byte down its control
// FIFO whenever a change starts or ends a lease or changes the line, so the
// next waiter's turn comes at once rather than at the next tick. Never
// blocks; false when no broker is reading. The broker turns it off for itself.
const ids = s => `${s.leases.map(l => l.id)}|${s.queue.map(q => `${q.id}:${q.pid}`)}`;
let kicks = true;
export const quiet = () => { kicks = false; };
export function kick() {
  let fd;
  // ENXIO: nobody reading. Anything else (no FIFO there) is no broker either.
  try { fd = fs.openSync(paths.ctl, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); } catch { return false; }
  try { fs.writeSync(fd, 'k'); } catch (e) { if (e.code !== 'EAGAIN') throw e; } finally { fs.closeSync(fd); }
  return true;
}

// For a change that can wait for the next one (a measurement, a note of
// split-off groups): on a full disk it's skipped, and this returns undefined.
export function withStateIfRoom(fn) {
  try { return withState(fn); } catch (e) { if (noSpace(e)) return undefined; throw e; }
}

// The state as last written, without the lock and without reaping: what dibs
// web shows. Writes are a rename, so this never sees half a file; a holder that
// died shows until the next dibs call reaps it.
export function peek() { return read().s; }

function read() {
  let s = { seq: 0, leases: [], queue: [] }, raw = null;
  if (fs.existsSync(paths.state)) {
    try { raw = fs.readFileSync(paths.state, 'utf8'); s = JSON.parse(raw); }
    catch {
      const bad = `${paths.state}.corrupt-${now()}`;
      fs.copyFileSync(paths.state, bad);
      say(`state file was unreadable; saved it to ${bad} and started fresh. Running jobs keep running but aren't tracked.`);
    }
  }
  s.seq ||= 0; s.leases ||= []; s.queue ||= [];
  return { s, raw };
}

// Drop leases whose process is gone (killing anything they left running) and
// waiters who left or died.
// Waiters found dead by this change, for the history once it's written.
let vanished = [];
function reap(s) {
  const t = now();
  const alive = makeAlive(pidsOf(s));
  s.leases = s.leases.filter(l => {
    if (l.kind === 'hold') return t < l.expires && (!l.pid || alive(l.pid, l.pstart));
    if (alive(l.pid, l.pstart)) return true;
    killLease(l);
    // Its dibs was killed, so nobody recorded what it measured. A job big enough
    // to get its dibs killed is the one the next run most needs to plan for.
    if (l.peak?.mem) record(l.key, t - l.start - (l.pausedMs || 0), l.who, peakOf(l), true);
    return false;
  });
  // A waiter whose process is gone leaves the line, however it went: a place
  // left behind by a kill, or by a path that didn't clean up, would sit ahead of
  // live waiters. That includes a place kept for a thin waiter's own retry in
  // Node (src/broker.mjs keptFor), which only that process can pick up. A place
  // kept with no process on it (a wait that timed out, exit 75) stays KEEP_PLACE
  // for the same command to pick up.
  // Two places under one process (pid and start time): it decides for one at most, the one it
  // stamped last (the newer, on a tie). The other is left over and holds the line for nothing.
  const latest = new Map();
  for (const q of s.queue) {
    if (!q.pid) continue;
    const k = `${q.pid} ${q.pstart}`, o = latest.get(k);
    if (!o || (q.polledAt ?? 0) > (o.polledAt ?? 0) || ((q.polledAt ?? 0) === (o.polledAt ?? 0) && q.id > o.id)) latest.set(k, q);
  }
  const twin = q => q.pid && latest.get(`${q.pid} ${q.pstart}`) !== q;
  // The state file can look fresh across a sleep (a dark wake, Power Nap, a worker's write), so a
  // recent wake grants the same grace. Asked only when a place has gone unlooked-at: it's a sysctl.
  if (!(s.graceUntil > t) && s.queue.some(q => unpolled(q, t))) {
    const woke = wokeAt();
    if (woke && t - woke < QUIET_GRACE) s.graceUntil = woke + QUIET_GRACE;
  }
  if (s.graceUntil && t >= s.graceUntil) delete s.graceUntil;
  // A place whose process lives but no longer decides for it (its dibs stopped looking) goes after
  // GHOST_AFTER, and one the owner stopped once its waiter has had STOP_GRACE to see that: both, left
  // in, would sit in line for as long as the process lived.
  s.queue = s.queue.filter(q => {
    const owner = q.pid || (q.keptFor && !q.pid ? q.keptFor : null);
    const why = owner && !alive(owner, q.pstart) ? 'gone'
      : q.ownerStop && t - q.ownerStop > STOP_GRACE ? 'owner stop'
      : unpolled(q, t, GHOST_AFTER) && !(s.graceUntil > t) ? 'unpolled'
      : twin(q) ? 'duplicate' : null;
    if (why) {
      vanished.push({ at: t, kind: 'left', id: q.id, res: q.res, who: q.who, prio: q.prio || 'normal', type: q.kind, ms: t - q.enq, why });
      return false;
    }
    return q.pid || (q.keepUntil && t < q.keepUntil);
  });
  // What the owner stopped, for a waiter that finds its place gone to say why.
  if (s.stopped) {
    for (const id of Object.keys(s.stopped)) if (t - s.stopped[id].at > STOPPED_FOR) delete s.stopped[id];
    if (!Object.keys(s.stopped).length) delete s.stopped;
  }
  reapPool(s);
  reapResets(s, alive);
}

// Everything a run lease started: its process group and any groups its
// children split off into. Windows has no groups and recycles pids, so there
// the tree is killed only if its root is still the process we started.
export function killLease(l) {
  if (OS === 'windows') {
    if (l.pgid && makeAlive([l.pgid])(l.pgid, l.pgstart)) stopTree(l.pgid, 'SIGKILL');
    return;
  }
  // A paused run's stopped groups too: stopped, they'd wait forever.
  const all = [...new Set([l.pgid, ...(l.groups || []), ...(l.stopped || [])])].filter(Boolean);
  if (!all.length) return;
  const leaders = starts(all);
  if (!leaders) return;   // the process table can't be read: signal nothing rather than guess
  const live = liveGroups();
  const known = { ...l.groupStarts, [l.pgid]: l.pgstart };
  for (const g of all) if (stillOurs(l, g, leaders.get(g), known[g], live)) stopTree(g, 'SIGKILL');
}

// A group number is reused once its group empties, so a group is the run's
// only if its leader is the process recorded (same start time), or its leader
// has exited and the group still has members (a number can't be reused while
// its group has any). A group the run had stopped can't have emptied while
// stopped, so a leader that started before the pause is the run's too.
function stillOurs(l, g, leader, recorded, live) {
  if (!leader) return live.has(g);
  if (recorded) return leader === recorded;
  return !!l.pausedAt && (l.stopped || []).includes(g) && Date.parse(leader) <= l.pausedAt;
}

// Past run times, newest last. A line cut short (a crash mid-append) is
// skipped, not allowed to throw away every other line.
// Only the end of the file is read: it grows by every run (2 MB, 15,000 lines on
// 2026-11-11) and every waiter, the broker and the board read it. Just after the
// file is rotated (src/events.mjs) the rest comes from the end of the one before.
const HISTORY_KEEP = 1000;
const HISTORY_CHUNK = 256 * 1024;   // about 2,000 lines, so one read nearly always does
export function history() {
  const lines = tail(paths.history, HISTORY_KEEP);
  if (lines.length < HISTORY_KEEP) lines.unshift(...tail(paths.historyOlder, HISTORY_KEEP - lines.length));
  return lines.slice(-HISTORY_KEEP).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// The last `need` lines of a file (fewer if it has fewer), none for an empty or missing one.
function tail(file, need) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  let lines;
  try {
    const size = fs.fstatSync(fd).size;
    for (let want = HISTORY_CHUNK; ; want *= 2) {
      const from = Math.max(0, size - want);
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString('utf8').trim();
      lines = text ? text.split('\n') : [];
      // A read that starts mid-file starts mid-line: that first piece isn't a line.
      if (from > 0) lines.shift();
      if (from === 0 || lines.length >= need) break;
    }
  } finally { fs.closeSync(fd); }
  return lines.slice(-need);
}

// peak is the most the run was measured using (src/measure.mjs), when it ran long enough to be.
// A failed run (nonzero exit, or its dibs killed) is recorded for its size
// only: its time says nothing about a run's (schedule.mjs typical skips it).
// Run times are worth less than the run: on a full disk this one goes unrecorded.
// A lease's peak for its history line, marked when the watcher cleared caches during it.
export const peakOf = l => (l.cleaned && l.peak ? { ...l.peak, cleaned: true } : l.peak);
export function record(key, duration, who, peak, failed = false) {
  try { fs.appendFileSync(paths.history, JSON.stringify({ key, dur: duration, who, at: now(), ...(peak ? { mem: peak.mem, cpu: peak.cpu, ...(peak.fit && { fit: true }), ...(peak.in != null && { peakIn: Math.round(peak.in) }), ...(peak.ate != null && { ate: Math.round(peak.ate) }), ...(peak.cleaned && { cleaned: true }) } : {}), ...(failed && { failed: true }) }) + '\n'); }
  catch (e) { if (!noSpace(e)) throw e; }
}
