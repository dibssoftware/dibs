// The shared state file: who holds what and who's waiting. Every change goes
// through withState, which holds a mkdir lock for a few milliseconds.
import fs from 'node:fs';
import path from 'node:path';
import { paths, HOME } from './config.mjs';
import { makeAlive } from './proc.mjs';
import { stopTree, starts, liveGroups, OS } from './platform.mjs';
import { settle, flush } from './preempt.mjs';
import { reapPool } from './simpool.mjs';
import { queueResets, startResets, reapResets } from './reset.mjs';
import { logChanges, event } from './events.mjs';
import { die, now, say, sleepSync, noSpace, fakeFull } from './util.mjs';

export const KEEP_PLACE = 120e3;   // a waiter that gave up keeps its place this long

export function withState(fn) {
  fs.mkdirSync(HOME, { recursive: true });
  const t0 = now();
  const owner = path.join(paths.lock, 'pid');
  for (;;) {
    try { fs.mkdirSync(paths.lock); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Take the lock over only from a writer that died holding it, or one stuck
      // for 30s. The age check matters: the pid we read may belong to a writer
      // that just finished, while the directory is already someone's fresh lock.
      // The lock judged is the one taken over (takeOver checks its inode): judged stale, it can be
      // replaced by a fresh one before the rename, and on 2026-11-04 a takeover moved a fresh lock
      // aside before its writer had put its pid in, and that writer crashed (exit 70).
      let pid = 0, st;
      try { st = fs.statSync(paths.lock); } catch { continue; }
      try { pid = Number(fs.readFileSync(owner, 'utf8')); } catch {}
      const age = now() - st.mtimeMs;
      if (age > 30000 || (age > 3000 && (!pid || !makeAlive([pid])(pid)))) takeOver(st);
      if (now() - t0 > 45000) die(`state lock stuck; remove ${paths.lock} if no dibs is running. Your command did not run.`, 75);
      sleepSync(10 + Math.random() * 20);
      continue;
    }
    // A lock with no pid in it (a full disk) would hold everyone up until it looked stale: give it back now.
    // Gone before the pid went in (taken over by an older dibs that judged it stale): not ours, so
    // nothing to give back, and the caller waits its turn again instead of crashing.
    try { fakeFull('lock'); fs.writeFileSync(owner, String(process.pid)); break; }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      fs.rmSync(paths.lock, { recursive: true, force: true });
      throw e;
    }
  }
  let written = false, moved = false;
  vanished = [];
  try {
    const { s, raw } = read();
    const before = [...s.leases];
    const line = ids(s);
    const paused = new Map(before.map(l => [l.id, l.pausedAt]));
    reap(s);
    const out = fn(s);
    settle(s, now(), history);   // resume work paused for a lease that has ended, and never leave every job paused
    queueResets(s, before.filter(l => !s.leases.some(x => x.id === l.id)));   // onRelease for every lease this change ended
    // Nothing changed, nothing written: most waiters' polls change nothing, and
    // an unchanged file tells a waiter it can poll less often (src/acquire.mjs nextPoll).
    const text = JSON.stringify(s, null, 1);
    if (text !== raw) {
      // A write cut short by a full disk leaves the old state in place, and no half file taking up space.
      try { fakeFull('state'); fs.writeFileSync(paths.state + '.tmp', text); }
      catch (e) { fs.rmSync(paths.state + '.tmp', { force: true }); throw e; }
      fs.renameSync(paths.state + '.tmp', paths.state);
      written = true;
      moved = ids(s) !== line;
    }
    logChanges(before, paused, s);
    for (const e of vanished) event(e);
    flush();   // pause and resume signals, now that the state says why
    return out;
  } finally {
    flush(false);   // a change that failed sends nothing
    fs.rmSync(paths.lock, { recursive: true, force: true });
    if (moved && kicks) try { kick(); } catch {}   // after the lock, which the broker takes next
    startResets(written);
  }
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

// Move the stale lock aside atomically, then check it was the one we judged, by inode: its pid
// can't tell, since a fresh lock has none yet and reads as the same 0 as a pid-less stale one.
// If another waiter's lock had replaced it in between, put theirs back.
export function takeOver(judged) {
  const aside = `${paths.lock}.stale-${process.pid}-${now()}`;
  try { fs.renameSync(paths.lock, aside); } catch { return; }
  let ino = null;
  try { ino = fs.statSync(aside).ino; } catch {}
  if (ino === judged.ino) fs.rmSync(aside, { recursive: true, force: true });
  else try { fs.renameSync(aside, paths.lock); } catch { fs.rmSync(aside, { recursive: true, force: true }); }
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
  const alive = makeAlive([...s.leases.map(l => l.pid), ...s.queue.map(q => q.pid || q.keptFor), ...(s.resets || []).flatMap(x => [x.pid, x.cpid])]);
  s.leases = s.leases.filter(l => {
    if (l.kind === 'hold') return t < l.expires && (!l.pid || alive(l.pid, l.pstart));
    if (alive(l.pid, l.pstart)) return true;
    killLease(l);
    // Its dibs was killed, so nobody recorded what it measured. A job big enough
    // to get its dibs killed is the one the next run most needs to plan for.
    if (l.peak?.mem) record(l.key, t - l.start - (l.pausedMs || 0), l.who, l.peak, true);
    return false;
  });
  // A waiter whose process is gone leaves the line, however it went: a place
  // left behind by a kill, or by a path that didn't clean up, would sit ahead of
  // live waiters. That includes a place kept for a thin waiter's own retry in
  // Node (src/broker.mjs keptFor), which only that process can pick up. A place
  // kept with no process on it (a wait that timed out, exit 75) stays KEEP_PLACE
  // for the same command to pick up.
  s.queue = s.queue.filter(q => {
    const owner = q.pid || (q.keptFor && !q.pid ? q.keptFor : null);
    if (owner && !alive(owner, q.pstart)) {
      vanished.push({ at: t, kind: 'left', id: q.id, res: q.res, who: q.who, prio: q.prio || 'normal', type: q.kind, ms: t - q.enq, why: 'gone' });
      return false;
    }
    return q.pid || (q.keepUntil && t < q.keepUntil);
  });
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
export function history() {
  let text;
  try { text = fs.readFileSync(paths.history, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.trim().split('\n').slice(-1000).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// peak is the most the run was measured using (src/measure.mjs), when it ran long enough to be.
// A failed run (nonzero exit, or its dibs killed) is recorded for its size
// only: its time says nothing about a run's (schedule.mjs typical skips it).
// Run times are worth less than the run: on a full disk this one goes unrecorded.
export function record(key, duration, who, peak, failed = false) {
  try { fs.appendFileSync(paths.history, JSON.stringify({ key, dur: duration, who, at: now(), ...(peak ? { mem: peak.mem, cpu: peak.cpu, ...(peak.fit && { fit: true }), ...(peak.ate != null && { ate: Math.round(peak.ate) }) } : {}), ...(failed && { failed: true }) }) + '\n'); }
  catch (e) { if (!noSpace(e)) throw e; }
}
