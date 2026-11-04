// The broker: one Node process that waits for every thin waiter on this
// machine (src/thin.sh), instead of one Node per waiter. Each tick it takes
// the state lock once and runs, for each waiter in rank order, the same step
// acquire()'s loop runs for itself, then writes to the waiters' FIFOs: lines
// to print, "go", or "exit N". It keeps nothing that isn't in state.json, so
// killing it loses no place: the next waiter to notice starts another. It
// starts when someone has to wait, and exits after a quiet minute or when a
// release changes its code on disk. Nothing is installed; no daemon.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, paths, loadConfig } from './config.mjs';
import { pstart, makeAlive } from './proc.mjs';
import { processes } from './platform.mjs';
import { withState, history, kick, quiet, KEEP_PLACE } from './state.mjs';
import { decide, step, waiter, full, markIdle, saidText, abandon, POLL } from './acquire.mjs';
import { byRank } from './schedule.mjs';
import { inversions, lift } from './override.mjs';
import { noticeScan } from './notices.mjs';
import { event } from './events.mjs';
import { now, noSpace, sleepSync, signalExit, notifyLine, LEAN } from './util.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(SRC, '..', 'bin', 'dibs.mjs');
export const PIDFILE = path.join(HOME, 'broker.pid');
const STARTING = path.join(HOME, 'broker.lock');
const WAKE = path.join(HOME, 'w');
// With no thin waiter for this long, the broker exits: nothing runs while
// nobody waits. DIBS_BROKER_IDLE lets a test see it go.
const IDLE_EXIT = Number(process.env.DIBS_BROKER_IDLE) || 6e4;
// How often the broker stamps state.broker.beat. Not every tick: an unchanged
// state file isn't rewritten, and older waiters poll less while it's unchanged.
const BEAT = 10e3;
// A beat older than this is a broker that's alive but stuck: the next waiter replaces it.
const HUNG = 30e3;
// How long a waiter gives the broker it started to open the control FIFO. A
// Node start under memory pressure has taken seconds. A broker that dies
// before then is noticed within CRASH_CHECK. One still starting after it is
// slow, not broken: the waiter waits in Node and the broker takes over once up.
// DIBS_BROKER_START_WAIT (ms) lets a test see a slow start.
const START_WAIT = Number(process.env.DIBS_BROKER_START_WAIT) || 10e3;
const CRASH_CHECK = 500;
// A broker that couldn't be started marks it here. For BROKEN_FOR after, thin
// waiters don't try again: they wait in Node at once (src/thin.sh checks it too).
export const BROKEN = path.join(HOME, 'broker.broken');
const BROKEN_FOR = 6e4;
// Between kicks, a tick whose state file hasn't changed since the last one
// is skipped until this much time has passed: deciding for 50 waiters costs
// a few hundred ms of CPU, and with nothing new only the machine's readings
// (memory, swap, disk) or a wait limit can change the answer.
const QUIET_POLL = 5e3;
// FIFOs of shells that are gone are cleared this often.
const PRUNE_EVERY = 6e4;
const { O_WRONLY, O_RDWR, O_NONBLOCK } = fs.constants;

// A line to a thin waiter's FIFO: _enqueue's answer, which the shell reads
// before any broker writes. The shell holds the FIFO open, so this never blocks.
function reply(fifo, line) {
  const fd = fs.openSync(fifo, O_WRONLY | O_NONBLOCK);
  try { fs.writeSync(fd, `${line}\n`); } finally { fs.closeSync(fd); }
}

// _enqueue: getting a thin waiter in line, as dibs run or hold does, with
// its shell's pid in the entry. Each way out answers the shell: go (its turn
// now), wait (the broker has it), fat (wait in-process: a case thin waits
// don't cover), or exit 0 (nothing to wait for). Any other exit code is the
// shell's to pass on.
export function thinCall(shell, fifo) {
  if (shell === process.pid) return inlineCall(shell, fifo);
  let replied = false;
  const answer = line => { reply(fifo, line); replied = true; };
  process.on('exit', code => { if (!replied && code === 0) answer('exit 0'); });
  const call = {
    shell, fifo, handed: false,
    fat: () => { call.handed = true; answer('fat'); process.exit(0); },
    go: lease => { call.handed = true; answer(`go ${lease.id}`); process.exit(0); },
    wait: w => {
      call.handed = true;
      answer(`wait ${w.me.id}`);
      const wake = { ...w.info, path: fifo, pid: shell, talk: w.talk.save(), blocked: w.blocked, saidAhead: w.saidAhead, warnedHolding: w.warnedHolding };
      const ok = withState(s => {
        const q = s.queue.find(x => x.id === w.me.id && x.pid === shell);
        if (q) q.wake = wake;
        return !!q;
      });
      const up = ok && ensureBroker();
      if (!up) {
        event({ kind: 'thin', why: ok ? 'no broker could be started: waiting in Node' : 'place gone before the hand-over: waiting in Node', id: w.me.id, shell, res: w.me.res, who: w.me.who });
        withState(s => { const q = s.queue.find(x => x.id === w.me.id && x.pid === shell); if (q) keepFor(q, shell); });
        reply(fifo, 'fat');
      }
      process.exit(0);
    },
  };
  return call;
}

const THIN_SH = path.join(SRC, 'thin.sh');
// The shell exec'd this Node (src/thin.sh), so it is the shell, pid and all.
// Its turn now: it runs right here. Paths thin waits don't cover go on here too.
// To wait, it keeps its place for this pid and execs back into the shell, which
// gets in line again the usual way (a second Node, which picks the place up) and
// waits on its FIFO. Without process.execve (Node before 23.11) it waits here.
function inlineCall(shell, fifo) {
  return {
    shell, fifo, inline: true, handed: false,
    go: () => {},
    wait: w => {
      if (!process.execve) return 'stay';
      withState(s => { const q = s.queue.find(x => x.id === w.me.id && x.pid === shell); if (q) keepFor(q, shell); });
      process.execve('/bin/sh', ['/bin/sh', THIN_SH, BIN, ...process.argv.slice(2)], { ...process.env, DIBS_THIN_RESUME: '1' });
    },
  };
}

// Make sure a broker is up and has heard there's news. One that's alive but
// hasn't stamped its beat in HUNG is killed first (its start time checked).
// When several waiters find none at once, one starts it and the rest wait for it.
export function ensureBroker() {
  let b = null;
  try { b = JSON.parse(fs.readFileSync(paths.state, 'utf8')).broker; } catch {}
  const hung = b && now() - b.beat > HUNG && pstart(b.pid) === b.pstart;
  // Even when no broker can be started: alive, a stuck one holds its waiters'
  // FIFOs open, so their shells never see it gone and never move to Node.
  if (hung) try { process.kill(b.pid, 'SIGKILL'); } catch {}
  try { if (now() - fs.statSync(BROKEN).mtimeMs < BROKEN_FOR) return false; } catch {}
  if (!hung && kick()) return true;
  let mine = false;
  try { fs.mkdirSync(STARTING); mine = true; } catch {
    // A starter killed before it finished leaves its folder behind.
    try { if (now() - fs.statSync(STARTING).mtimeMs > START_WAIT) { fs.rmdirSync(STARTING); fs.mkdirSync(STARTING); mine = true; } } catch {}
  }
  try {
    let child = null;
    if (mine) {
      const log = fs.openSync(path.join(HOME, 'broker.log'), 'a');
      // The broker waits for everyone: nothing of the job whose waiter happened to start it.
      const env = { ...process.env };
      for (const k of ['DIBS_LEASE', 'DIBS_REMOTE_JOB', 'DIBS_LATER_JOB']) delete env[k];
      child = spawn(process.execPath, [...LEAN, BIN, '_broker'], { cwd: HOME, env, detached: true, stdio: ['ignore', 'ignore', log] });
      child.unref();
      fs.closeSync(log);
    }
    // This loop never yields, so a child that died is a zombie, not an exit event.
    const died = () => !/^[^Z]/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim());
    for (let t0 = now(), checked = t0; now() - t0 < START_WAIT; sleepSync(20)) {
      if (kick()) { try { fs.rmSync(BROKEN, { force: true }); } catch {} return true; }
      if (child && now() - checked > CRASH_CHECK) {
        checked = now();
        if (died()) break;
      }
    }
    if (!mine) return false;
    // Marked broken, it would keep every waiter in Node, and the throttle watcher from
    // replacing a stuck broker, for BROKEN_FOR: on a loaded machine that was a minute lost.
    if (!died()) { event({ kind: 'thin', why: 'the broker is slow to start: waiting in Node meanwhile', pid: child.pid }); return false; }
    event({ kind: 'thin', why: "the broker didn't start", log: path.join(HOME, 'broker.log') });
    try { fs.writeFileSync(BROKEN, `${new Date().toISOString()} the broker didn't start: see ${path.join(HOME, 'broker.log')}\n`); } catch {}
    return false;
  } finally { if (mine) try { fs.rmdirSync(STARTING); } catch {} }
}

// The throttle watcher's pass (src/cool.mjs), every 10 s: a broker that's
// alive but hasn't stamped its beat in HUNG is stuck. Replacing it here means
// its waiters don't sit until someone new gets in line. Returns what it did, for the log.
export function watchBroker() {
  let s;
  try { s = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch { return null; }
  const b = s.broker;
  if (!b || now() - b.beat <= HUNG || pstart(b.pid) !== b.pstart) return null;
  const n = thinWaiters(s).length;
  event({ kind: 'thin', why: 'stuck broker replaced', pid: b.pid, waiting: n });
  return `broker ${b.pid} stuck (no beat for ${Math.round((now() - b.beat) / 1000)}s, ${n} waiting): ${ensureBroker() ? 'replaced' : "replaced, but no new one is up yet"}`;
}

// A thin waiter's place, kept while its shell becomes Node to wait there. keptFor
// names that shell: the place goes when it dies, so a waiter killed in between
// leaves no place behind for two minutes (src/state.mjs reap).
function keepFor(q, shell) {
  Object.assign(q, { pid: null, keepUntil: now() + KEEP_PLACE, keptFor: shell });
  delete q.wake;
}

// _leave: a thin waiter's shell was interrupted (why is the signal), or gave
// up on the broker (why is keep: the place stays for its in-process retry).
// id 0: interrupted before it knew its id; its place is the one under its pid.
export function leaveLine(id, shell, why) {
  // A low job lifted for this waiter alone goes back down as it leaves (src/override.mjs inversions).
  lift(withState(s => {
    // Its place by id when it knows it, else by its pid. A place kept with nobody on it (for its own
    // retry in Node, or taken for gone) is its too: interrupted, it gives that up as well.
    const q = s.queue.find(x => (id ? x.id === id && (x.pid === shell || (why !== 'keep' && !x.pid)) : x.pid === shell)
      || (why !== 'keep' && x.keptFor === shell));
    if (!q) return [];
    if (why === 'keep') { keepFor(q, shell); return []; }
    s.queue = s.queue.filter(x => x !== q);
    if (q.wake?.notify) notified(q, signalExit(why));
    if (q.wake) event({ kind: 'left', id: q.id, res: q.res, who: q.who, prio: q.prio || 'normal', type: q.kind, ms: now() - q.enq, why });
    return inversions(s, loadConfig());
  }));
}

// --notify's line for a thin wait that ended before its command started (src/commands.mjs notifyOnExit).
function notified(q, code) {
  notifyLine(q.wake.notify, { at: new Date().toISOString(), code, started: false, res: q.res, cmd: q.cmd, cwd: q.wake.cwd,
    secs: Math.round((now() - q.wake.started) / 1000), pid: q.pid });
}

// A waiter's messages, down its FIFO. The FIFO is opened on first sight
// ("hi") and held until go or exit: while the broker holds it the shell never
// reads end of file, and when the broker dies it closes, which is how the
// shell knows to start another.
function sink(q) {
  let fd = null;
  const send = text => {
    if (fd == null) {
      try { fd = fs.openSync(q.wake.path, O_WRONLY | O_NONBLOCK); } catch { return; }   // no reader: the shell is gone, and is reaped by its pid
      text = `hi\n${text}`;
    }
    const buf = Buffer.from(text);
    // A stopped shell (Ctrl-Z) doesn't read: what doesn't fit is dropped rather than waited for.
    for (let off = 0; off < buf.length;) try { off += fs.writeSync(fd, buf, off); } catch { return; }
  };
  const lines = text => text.replace(/\n$/, '').split('\n').map(l => `out ${l}\n`).join('');
  const out = {
    done: false,
    open: () => send(''),
    say: msg => send(lines(`dibs: ${msg}`)),
    said: (...ls) => send(lines(saidText(...ls))),
    raw: text => send(lines(text)),
    die: (msg, code) => { send(lines(`dibs: ${msg}`)); return out.exit(code); },
    exit: code => { if (q.wake.notify) notified(q, code); send(`exit ${code}\n`); out.close(); return { exit: code }; },
    go: () => { send('go\n'); out.close(); },
    fat: () => { send('fat\n'); out.close(); },
    close: () => { if (fd != null) try { fs.closeSync(fd); } catch {} fd = null; out.done = true; },
  };
  return out;
}

// A liveness hint for a quiet tick, with no process table read: a waiter
// gone since the last one is reaped (pid and start time checked) by a full tick.
const running = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const thinWaiters = s => s.queue.filter(q => q.wake && q.pid && q.wake.pid === q.pid);

// _broker. Exits at once if another live broker has the job.
export function broker() {
  fs.mkdirSync(WAKE, { recursive: true });
  const me = { pid: process.pid, pstart: pstart(process.pid) };
  const mine = withState(s => {
    const b = s.broker;
    if (b && b.pid !== me.pid && now() - b.beat < HUNG && makeAlive([b.pid])(b.pid, b.pstart)) return false;
    s.broker = { ...me, beat: now() };
    return true;
  });
  if (!mine) return;
  quiet();   // its own state changes don't kick it
  // Written before the control FIFO opens, so whoever sees a kick land sees this pid too.
  fs.writeFileSync(PIDFILE, String(me.pid));
  try { fs.unlinkSync(paths.ctl); } catch {}
  if (spawnSync('mkfifo', ['-m', '600', paths.ctl], { stdio: 'ignore' }).status !== 0) throw new Error(`couldn't make the control FIFO ${paths.ctl}`);
  const ctl = new net.Socket({ fd: fs.openSync(paths.ctl, O_RDWR | O_NONBLOCK), readable: true, writable: false });
  const code = fs.readFileSync(path.join(SRC, 'version.mjs'), 'utf8');
  const waits = new Map();   // queue id -> its wait (src/acquire.mjs waiter), with its FIFO as out
  let cfg = loadConfig(), hist = history(), histAt = 0, beat = 0, idleSince = now(), pending = false, forced = false, pruned = 0, seen = '', full = 0;

  const exit = () => {
    for (const w of waits.values()) w.out.close();
    try { if (fs.readFileSync(PIDFILE, 'utf8') === String(me.pid)) fs.unlinkSync(PIDFILE); } catch {}
    process.exit(0);
  };
  // Under the lock, so a waiter handed over meanwhile either keeps this broker
  // or, after it, finds nobody reading the control FIFO and starts another.
  const leave = always => {
    const gone = withState(s => {
      if (!always && thinWaiters(s).length) return false;
      if (s.broker?.pid === me.pid) delete s.broker;
      ctl.destroy();
      return true;
    });
    if (gone) exit();
  };

  const tick = () => {
    const kicked = forced;
    pending = forced = false;
    const t = now();
    // A release changed the code: the waiters' shells start the new one.
    try { if (fs.readFileSync(path.join(SRC, 'version.mjs'), 'utf8') !== code) return leave(true); } catch {}
    if (t - pruned > PRUNE_EVERY) { pruned = t; prune(); }
    // With nobody to wait for, the lock is taken only to keep the beat fresh.
    let quietNow = false, text = '';
    try { text = fs.readFileSync(paths.state, 'utf8'); quietNow = !waits.size && !thinWaiters(JSON.parse(text)).length; } catch {}
    if (!quietNow && !kicked && text === seen && t - full < QUIET_POLL && [...waits.values()].every(w => running(w.me.pid))) return;
    if (quietNow) {
      if (t - idleSince > IDLE_EXIT) return leave(false);
      if (t - beat > BEAT) withState(s => { if (s.broker?.pid === me.pid || !s.broker) s.broker = { ...me, beat: (beat = t) }; });
      return;
    }
    processes();   // read the process table before taking the lock, not while holding it
    noticeScan();
    try { cfg = loadConfig(); } catch {}
    try { const m = fs.statSync(paths.history).mtimeMs; if (m !== histAt) { histAt = m; hist = history(); } } catch {}
    let rs;
    try {
      rs = withState(s => {
        if (s.broker && s.broker.pid !== me.pid) return null;   // taken for hung and replaced: step aside
        if (t - beat > BEAT || !s.broker) s.broker = { ...me, beat: (beat = t) };
        markIdle(s);
        const thin = thinWaiters(s).sort(byRank(hist));
        for (const [id, w] of waits) if (!thin.some(q => q.id === id)) { w.out.close(); waits.delete(id); }
        return thin.map(q => {
          let w = waits.get(q.id);
          if (!w) {
            w = waiter(q.wake, cfg, hist, sink(q));
            w.me = { ...q };
            waits.set(q.id, w);
            w.out.open();
          }
          Object.assign(w, { cfg, hist });
          return [w, decide(s, w)];
        });
      });
    } catch (e) {
      if (!noSpace(e)) throw e;
      for (const w of waits.values()) full(w);
      return done();
    }
    if (!rs) return exit();
    const follows = rs.map(([w]) => w.info.follow).filter(f => f?.pid);
    const up = follows.length ? makeAlive(follows.map(f => f.pid)) : null;
    for (const [w, r] of rs) {
      if (w.full) { w.full = false; w.out.say("there's disk space again; back in line."); }
      // A job sent from another machine ends when the worker that started it does (bin/dibs.mjs followParent).
      // Checked by the worker's own pid and start time, not by the shell's parent, which a Linux run took for gone.
      const f = w.info.follow;
      if (f?.pid && !r.lease && !up(f.pid, f.pstart)) {
        abandon(w, 'worker gone', signalExit('SIGTERM'), 'the worker that started this job is gone, so it stopped waiting. Your command did NOT run.');
        continue;
      }
      try {
        const x = step(r, w);
        if (x?.lease) w.out.go();
        // Held by load and able to ship (acquire.mjs): its shell waits in Node, keeping its place, and asks the coordinator there.
        else if (x?.ship) { withState(s => { const q = s.queue.find(y => y.id === w.me.id && y.pid === w.me.pid); if (q) keepFor(q, w.me.pid); }); w.out.fat(); }
      } catch (e) {
        event({ kind: 'thin', why: 'the broker crashed deciding for a waiter', id: w.me.id, shell: w.me.pid, res: w.me.res, who: w.me.who, error: String(e?.stack || e).slice(0, 2000) });
        w.out.die(`dibs itself crashed (a bug in dibs, not in your command; exit 70). Report it: dibs ask "..."\n${e?.stack || e}`, 70);
      }
    }
    done();
    idleSince = full = now();
    try { seen = fs.readFileSync(paths.state, 'utf8'); } catch {}
  };
  const done = () => { for (const [id, w] of waits) if (w.out.done) waits.delete(id); };
  const soon = kick => { forced ||= kick; if (!pending) { pending = true; setImmediate(tick); } };
  ctl.on('data', () => soon(true));
  ctl.on('error', () => {});
  setInterval(() => soon(false), POLL);
  tick();
}

// FIFOs of shells that are gone. Only in ~/.dibs/w, the folder dibs made for them.
function prune() {
  let names = [];
  try { names = fs.readdirSync(WAKE); } catch { return; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try { process.kill(Number(n), 0); } catch (e) { if (e.code === 'ESRCH') try { fs.unlinkSync(path.join(WAKE, n)); } catch {} }
  }
}
