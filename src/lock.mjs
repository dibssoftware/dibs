// The lock every shared file in ~/.dibs changes under: state.json (src/state.mjs), and
// messages, questions, later jobs, the subagent ledger, alerts and the web's pairing file.
//
// A lock is a directory, <name>, as every dibs before it made, so an older dibs still running
// during a rollout and this one keep out of each other's way. What holds:
//
// 1. One holder. A process holds the lock while <name>/owner.<pid>.<start>.<nonce> is its own
//    file. The directory is made whole beside it (<name>.new.*, with that file and a pid file
//    for older dibs to read) and renamed into place. A rename onto a directory that has
//    anything in it fails (ENOTEMPTY on APFS, ENOTEMPTY or EEXIST on Linux), so of two makers
//    one wins, and no lock is ever seen without its owner.
// 2. Staleness is the owner's death, never the lock's age. A lock is stale when its owner is
//    gone (kill 0 says so, or ps shows that pid started at another time: a reused pid), a
//    zombie, or stopped (a paused job's own dibs, which nobody can resume while it holds the
//    lock everyone needs). A live owner, however slow, is waited for; one holding past
//    STUCK_AFTER is reported (onStuck), since a hung one stops every dibs command. A lock held 30 s used to be
//    taken from its live owner: at load 238 (2026-11-08) a starved holder lost it
//    mid-change, two writers ran at once, and each crashed on the other's files (exit 70).
// 3. Takeover is atomic and never moves the lock. The taker renames the stale owner's file to
//    its own owner name, inside <name>: of two takers one wins, and a fresh lock that replaced
//    the stale one has no file of that name, so it can't be taken by mistake. (Moving the whole
//    lock aside to look at it, then back, could hide a live owner's lock from it for a moment:
//    its release then left the lock in place and everyone waited on it for good.)
// 4. A holder checks its owner file is still there just before it commits (commit() below), so
//    a holder taken over while stopped never writes over its taker's change. Each writer's
//    temporary file has its pid in the name: two writers never share one.
// 5. Release removes only the holder's own lock, checked by its owner file, and never throws.
//    A lock with this process's pid and another nonce is one it no longer holds: stale.
//
// A lock made by an older dibs (a directory with only a pid file in it) is judged by that pid,
// the same way; with no pid in it after PIDLESS_STALE, its writer died before writing one.
// That older dibs can still take a lock from a live owner after 30 s (and a new lock renamed
// in the moment between its mkdir and its pid write replaces it): both end once every running
// dibs process is this version.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sleepSync } from './util.mjs';

const WIN = process.platform === 'win32';
// This process's start, to tell it from a later process given the same pid.
const START = Math.round(Date.now() - process.uptime() * 1000);
// An older dibs makes its lock empty and writes its pid just after.
const PIDLESS_STALE = 3000;
// A live owner holds for milliseconds. Held past this, ps is asked whether it's stopped, a zombie
// or a newer process under a reused pid (one ps call, at most this often per waiter).
const ASK_AFTER = 2000;
// ps gives elapsed time in whole seconds, and START is Node's own estimate: within this, the same process.
const SAME_START = 5000;
// A live owner holding this long is hung, not slow (a ps that never returns, a frozen disk, a
// debugger): waiters keep waiting, but say so once each (onStuck), so the person hears of it.
export const STUCK_AFTER = 60e3;

let made = 0;
const nonce = () => `${process.pid}.${START}.${(++made).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export class LostLock extends Error {
  constructor(lock) { super(`${lock} was taken over while this process held it`); this.code = 'ELOSTLOCK'; }
}

// Waits for the lock and returns its handle ({ owns, release }), or null once `wait` ms pass.
// fake: called while the lock is made, so a test can make that step fail as a full disk would.
// files: data files whose per-process temporary copies (commit) a dead writer may have left.
export function acquire(lock, { wait = Infinity, fake, files = [], onStuck } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const owner = `owner.${nonce()}`;
  const t0 = Date.now();
  let seen = null, told = false;
  for (;;) {
    if (make(lock, owner, fake)) return handle(lock, owner);
    const o = holder(lock);
    if (o) {
      if (seen?.key !== o.key) seen = { key: o.key, since: Date.now(), asked: 0 };
      if (stale(o, seen)) {
        if (claim(lock, o, owner)) { sweep(lock, files); return handle(lock, owner); }
        continue;
      }
    }
    if (Date.now() - t0 >= wait) return null;
    if (o && told !== o.key && onStuck) {
      const held = heldFor(lock, o);
      if (held > STUCK_AFTER) { told = o.key; try { onStuck(o, held); } catch {} }
    }
    sleepSync(10 + Math.random() * 20);
  }
}

// How long the owner has held it: its owner file dates from when it took the lock (a claim
// touches the file it renamed in); an older dibs's lock dates from its directory.
function heldFor(lock, o) {
  try { return Date.now() - (o.old ? fs.statSync(lock) : fs.statSync(path.join(lock, o.name))).mtimeMs; } catch { return 0; }
}

// Who holds the lock and for how long, for a board that mustn't wait for it: { key, pid, held }, or null.
export function heldBy(lock) {
  const o = holder(lock);
  return o ? { key: o.key, pid: o.pid, held: heldFor(lock, o) } : null;
}

// Made whole, then renamed into place: false if someone else's lock is there.
function make(lock, owner, fake) {
  const tmp = `${lock}.new.${owner.slice(6)}`;
  try {
    fs.mkdirSync(tmp);
    fake?.();
    fs.writeFileSync(path.join(tmp, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(tmp, owner), '');
    fs.renameSync(tmp, lock);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    // Windows refuses a rename onto any directory with EPERM.
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || e.code === 'ENOTDIR' || (WIN && e.code === 'EPERM')) return false;
    throw e;
  }
}

// Who holds it: { key, pid, start, name } for a lock of this version, { key, pid, ino, age, old } for an
// older dibs's, or null when it's gone or changed while being read (look again).
function holder(lock) {
  let a, names, b;
  try { a = fs.statSync(lock); names = a.isDirectory() ? fs.readdirSync(lock) : []; b = fs.statSync(lock); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  if (a.ino !== b.ino) return null;
  const name = names.find(n => n.startsWith('owner.'));
  if (name) {
    const [, pid, start] = name.split('.');
    return { key: name, name, pid: Number(pid) || 0, start: Number(start) || 0 };
  }
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')) || 0; } catch {}
  return { key: `old.${b.ino}.${pid}`, pid, ino: b.ino, age: Date.now() - b.mtimeMs, old: true };
}

const answers = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function stale(o, seen) {
  if (!o.pid) return o.age > PIDLESS_STALE;
  if (o.pid === process.pid) return true;   // single-threaded: not a lock this process is in
  if (!answers(o.pid)) return true;
  const t = Date.now();
  if (WIN || t - seen.since < ASK_AFTER || t - seen.asked < ASK_AFTER) return false;
  seen.asked = t;
  const p = psOf(o.pid);
  if (p === undefined) return false;   // can't tell: wait, rather than take a live owner's lock
  if (p === null || /^[TZ]/.test(p.stat)) return true;
  return !!o.start && Math.abs(t - p.elapsed - o.start) > SAME_START;
}

// The command line a pid runs, for saying who dibs is stuck behind, or '' when ps can't say.
export function commandOf(pid) {
  if (WIN) return '';
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return (r.stdout || '').trim().slice(0, 200);
}

// { stat, elapsed ms } from ps, null when the process is gone, undefined when ps can't say.
function psOf(pid) {
  const r = spawnSync('ps', ['-o', 'stat=,etime=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (r.status == null) return undefined;
  const m = r.stdout.trim().match(/^(\S+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return r.status === 0 ? undefined : null;
  const [, stat, d = 0, h = 0, mi, s] = m;
  return { stat, elapsed: (((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s)) * 1000 };
}

// Takes the stale lock where it stands. An older dibs's lock is claimed through its pid file the
// same way; with nothing in it to claim (it died before writing its pid), it's emptied, and the
// next make() renames a whole lock over the empty directory.
function claim(lock, o, owner) {
  const mine = path.join(lock, owner);
  try {
    if (!o.old) fs.renameSync(path.join(lock, o.name), mine);
    else if (o.pid) fs.renameSync(path.join(lock, 'pid'), mine);
    else {
      for (const n of fs.readdirSync(lock)) if (!n.startsWith('owner.')) fs.rmSync(path.join(lock, n), { recursive: true, force: true });
      return false;
    }
  } catch { return false; }
  // A pid file claimed from a lock of this version that had replaced the old one: not ours, give it back.
  try {
    if (fs.readdirSync(lock).some(n => n.startsWith('owner.') && n !== owner)) { fs.renameSync(mine, path.join(lock, 'pid')); return false; }
    const at = new Date();
    fs.utimesSync(mine, at, at);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  } catch {}
  return true;
}

// What a writer killed mid-change leaves beside the lock: a lock it was making, one it moved
// aside, its temporary data file. Only names with a pid in them, and only a dead pid's.
function sweep(lock, files) {
  const dir = path.dirname(lock), base = path.basename(lock);
  const dibsMade = [new RegExp(`^${re(base)}\\.(?:new|gone)\\.(\\d+)\\.`), new RegExp(`^${re(base)}\\.stale-(\\d+)-`),
    ...files.filter(f => path.dirname(f) === dir).map(f => new RegExp(`^${re(path.basename(f))}\\.(\\d+)\\.tmp$`))];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const pid = dibsMade.map(r => n.match(r)?.[1]).find(Boolean);
    if (pid && !answers(Number(pid))) try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {}
  }
}
const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function handle(lock, owner) {
  const mine = path.join(lock, owner);
  return {
    owns: () => fs.existsSync(mine),
    release() {
      // Nobody moves a live owner's lock (3), so the one found here is still this one when it's
      // renamed aside: whole, in one step, so nobody sees it half removed.
      try {
        if (!fs.existsSync(mine)) return false;
        const aside = `${lock}.gone.${nonce()}`;
        fs.renameSync(lock, aside);
        fs.rmSync(aside, { recursive: true, force: true });
        return true;
      } catch { return false; }
    },
  };
}

// The holder's write of a whole file: a temporary copy of its own, then a rename, only while it
// still holds the lock (LostLock if not, with nothing written). fake as in acquire.
export function commit(h, file, text, opts = {}) {
  writeWhole(file, text, { ...opts, check: () => { if (!h.owns()) throw new LostLock(path.dirname(file)); } });
}

// A whole file through a temporary copy named for this process, so no two writers share one, and a
// write cut short (a full disk) leaves the old file and no half copy. check runs just before the rename.
export function writeWhole(file, text, { mode, fake, check } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fake?.(); fs.writeFileSync(tmp, text, mode ? { mode } : undefined); check?.(); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  fs.renameSync(tmp, file);
}

// fn under the lock, done again from the start if the lock was lost before it wrote.
// null when wait passes first.
export function underLock(lock, fn, opts = {}) {
  for (;;) {
    const h = acquire(lock, opts);
    if (!h) return null;
    try { return { out: fn(h) }; }
    catch (e) { if (!(e instanceof LostLock)) throw e; }
    finally { h.release(); }
  }
}
