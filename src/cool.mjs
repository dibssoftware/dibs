// dibs throttle. dibs budgets the work that goes through it; this catches the
// work that doesn't. When the machine is busy, build and test processes that
// keep a core hot outside any lease are moved to background priority (the
// efficiency cores on Apple silicon, nice 10 on Linux, below normal on
// Windows). Nothing is killed. The watcher also pauses idle and low leases
// while the machine is short on memory, and leases below high while swap fills
// the disk (src/preempt.mjs), and replaces a broker that has stopped beating
// (src/broker.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, machine, loadConfig } from './config.mjs';
import { withState, history, peek } from './state.mjs';
import { singleInstance } from './proc.mjs';
import { processes, lower, memPressure, isDibs, runtimes } from './platform.mjs';
import { hogsOnce, hogHint } from './hogs.mjs';
import { pressureStep, pressurePause, pressureRequeue, pressureResume, diskStep, diskPause, diskPausesPerPass, diskLine, diskCritical, adoptPauses, diskRequeue, measured, hardStop, hardResume, HARD_STOP, HARD_RESUME } from './preempt.mjs';
import { inversions, lift } from './override.mjs';
import { swapGrowing } from './schedule.mjs';
import { event } from './events.mjs';
import { notify } from './talk.mjs';
import { watchBroker } from './broker.mjs';
import { progressScan } from './notices.mjs';
import { scan as scanAlerts, CPU_FILE } from './alerts.mjs';
import { say, sleep, now, noSpace, gb } from './util.mjs';

const PIDFILE = path.join(HOME, 'cool.pid');
const LOG = path.join(HOME, 'cool.log');
// Only tools that build, test or crunch. Apps, editors and the agents themselves are left alone.
const TOOLS = /^(node|bun|deno|python3?(\.\d+)?|ruby|java|swift-frontend|swiftc|clang(\+\+)?|ld|ld64|xcodebuild|cargo|rustc|go|gcc|g\+\+|cc1(plus)?|make|ninja|tsc|esbuild|vite|vitest|jest|headless_shell|msbuild|dotnet)$/i;
const HOT = 50;          // % of a core
const INTERVAL = 10e3;
// dibs history shows load by the hour; a reading a minute is plenty for that and costs one line.
const SAMPLE_EVERY = 60e3;

const toolName = args => path.basename(args.split(/\s+/)[0]).replace(/\.exe$/i, '');

// Cores that stopped taking work. On 2026-11-10 this Mac's 4 performance cores did:
// load went from 127 to 400 while top read a flat 40% idle, and only a restart
// fixed it. Load that high counts work that's ready to run, so with that much of
// the CPU idle the work isn't being run, and moving hot processes to background
// priority (off the performance cores) only made it worse. Past STUCK_LOAD per
// core with STUCK_IDLE or more of the CPU idle, the watcher lowers nothing, and
// after STUCK_AFTER of it (src/alerts.mjs) the person is told to restart.
const STUCK_LOAD = 5;
const STUCK_IDLE = 0.25;
export function coresStuck(m) {
  if (!(m?.cores > 0) || m.busy == null || !(m.load >= STUCK_LOAD * m.cores)) return false;
  return 1 - m.busy / m.cores >= STUCK_IDLE;
}

// Processes left behind: build and test tools outside dibs that have run for
// ORPHAN_AGE and whose script is gone. On 2026-11-10 two node testfast.mjs from a
// deleted scratchpad had run 23 hours at 17 CPU-hours each, kept hot and moved to
// background priority over and over. They're named in an alert; nothing is killed.
const ORPHAN_AGE = 3 * 36e5;
const ORPHAN_EVERY = 6e4;   // a ps over the hot ones, once a minute
const SCRIPT = /\.(c|m)?[jt]sx?$|\.py$|\.rb$/;
// The script a tool runs, when its command line names one by its full path.
export function scriptOf(args) {
  return args.split(/\s+/).slice(1).find(a => a.startsWith('/') && SCRIPT.test(a)) || null;
}
export function orphans(procs, leased, ages, gone = f => !fs.existsSync(f)) {
  const out = [];
  for (const p of procs) {
    if (leased.has(p.pgid) || !TOOLS.test(toolName(p.args)) || isDibs(p)) continue;
    const script = scriptOf(p.args), r = ages.get(p.pid);
    if (script && r && r.age >= ORPHAN_AGE && gone(script)) out.push({ pid: p.pid, name: toolName(p.args), script, age: r.age, cpu: r.cpu });
  }
  return out;
}

// One pass. A process must be hot on two passes in a row, so short bursts are
// left alone. Returns the processes it moved.
function throttleOnce(cfg, seen = new Map(), leased = leasedGroups()) {
  const m = machine(), load = m.load;
  const stuck = coresStuck(m);
  const moved = [];
  const next = new Map();
  for (const p of processes()) {
    // dibs itself never: a broker moved to the slow cores slows every waiter's turn.
    if (p.cpu < HOT || p.pid === process.pid || leased.has(p.pgid) || !TOOLS.test(toolName(p.args)) || isDibs(p)) continue;
    const prev = seen.get(p.pid);
    if (prev === 'done') { next.set(p.pid, 'done'); continue; }
    if (prev && load > cfg.coolLoad && !stuck && lower(p.pid)) {
      moved.push({ ...p, name: toolName(p.args) });
      next.set(p.pid, 'done');
      fs.appendFileSync(LOG, `${new Date().toISOString()} load ${load.toFixed(1)}: background ${toolName(p.args)} ${p.pid} (${p.cpu}% cpu)\n`);
    } else next.set(p.pid, prev || 'hot');
  }
  seen.clear();
  for (const [k, v] of next) seen.set(k, v);
  return moved;
}

const leasedGroups = () => new Set(withState(s => s.leases.flatMap(l => [l.pgid, ...(l.groups || [])]).filter(Boolean)));

// What the watcher saw that only a person can fix, for src/alerts.mjs: since when
// the cores have looked stuck, and the orphans. Every pass, with when, so a
// watcher that stopped leaves no alert standing.
function noteCpu(note) {
  try { fs.writeFileSync(`${CPU_FILE}.${process.pid}`, JSON.stringify({ at: now(), ...note })); fs.renameSync(`${CPU_FILE}.${process.pid}`, CPU_FILE); } catch {}
}

// One memory pressure reading. Under sustained critical pressure, pause the
// next idle or low lease; once it's been normal for a while, resume one.
// Returns { act, leases } when it did something.
export function pressureOnce(cfg, track, read = memPressure) {
  const act = pressureStep(track, read());
  if (!act) return null;
  if (act === 'pause') {
    const l = withState(s => pressureRequeue(s, cfg, now(), history()));
    if (l) {
      const used = measured(l) || l.mem;
      fs.appendFileSync(LOG, `${new Date().toISOString()} memory pressure still critical with jobs paused: stopped ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}), using ${gb(used)}, to run again at the front of its line: ${l.cmd.slice(0, 60)}\n`);
      event({ kind: 'requeue', id: l.id, res: l.res, who: l.who, agent: l.agent, prio: l.prio || 'normal', why: 'memory', mem: used, booked: l.mem });
      notify(l, `requeue:#${l.id}`, `your job #${l.id} (${l.purpose ? `"${l.purpose}", ` : ''}${l.cmd.slice(0, 60)}) was paused for memory pressure, and pausing frees no memory`
        + ` (a stopped job's memory goes to swap), so with the pressure still critical dibs stopped it. Its dibs run put it back at the front of its line and runs it again`
        + ` from the start once there's room. Don't run it again yourself, and don't end it: the same tool call carries on.`);
      return { act: 'requeue', leases: [l] };
    }
  }
  const ls = withState(s => (act === 'pause' ? [pressurePause(s, cfg, now(), history())].filter(Boolean) : pressureResume(s)));
  for (const l of ls)
    fs.appendFileSync(LOG, `${new Date().toISOString()} memory pressure ${act === 'pause' ? 'critical: paused' : 'eased: resumed'} ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}${l.alongside ? ', on top' : ''}): ${l.cmd.slice(0, 60)}\n`);
  return ls.length ? { act, leases: ls } : null;
}

// One disk reading. While free disk is under minDisk and still falling, pause
// one more lease each pass (two when it's falling fast); once there's room
// again, resume one a minute.
// Returns { act, leases } when it did something.
export function diskOnce(cfg, track, m = machine()) {
  const hard = hardOnce(m);
  const act = diskStep(track, m, cfg);
  if (!act) return null;
  // Swap still growing with jobs already paused: their memory is what's going to swap.
  // Stopping one of them (it requeues itself) comes before pausing anything more.
  if (act === 'pause' && swapGrowing(m)) {
    const l = withState(s => diskRequeue(s, cfg, now(), history()));
    if (l) {
      const why = `free disk is low (${(m.diskFree / 1024 ** 3).toFixed(1)}G, under ${(diskLine(cfg) / 1024 ** 3).toFixed(1)}G) and swap is still growing`;
      const over = l.requeue.why === 'over', used = measured(l);
      fs.appendFileSync(LOG, `${new Date().toISOString()} ${why}: stopped ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}), `
        + `${over ? `using ${gb(used)} of the ${gb(l.mem)} it booked` : 'paused for the disk'}, to run again at the front of its line: ${l.cmd.slice(0, 60)}\n`);
      event({ kind: 'requeue', id: l.id, res: l.res, who: l.who, agent: l.agent, prio: l.prio || 'normal', why: l.requeue.why, mem: used || l.mem, booked: l.mem, diskFree: m.diskFree });
      const job = `your job #${l.id} (${l.purpose ? `"${l.purpose}", ` : ''}${l.cmd.slice(0, 60)})`;
      notify(l, `requeue:#${l.id}`, (over
        ? `${job} was using ${gb(used)} of memory, far more than the ${gb(l.mem)} it booked, while swap filled the disk, so dibs stopped it.`
          + ` Its dibs run put it back at the front of its line booked at what it really used, and runs it again from the start once that much memory is really free.`
        : `${job} was paused for low disk, and while it sat paused its memory was going to swap and filling the disk it was waiting for, so dibs stopped it.`
          + ` Its dibs run put it back at the front of its line and runs it again from the start when there's room.`)
        + ` Don't run it again yourself, and don't end it: the same tool call carries on.`);
      return { act: 'requeue', leases: [l] };
    }
  }
  const n = act === 'pause' ? diskPausesPerPass(m) : 0;
  const hist = n ? history() : [];
  const ls = withState(s => (n ? Array.from({ length: n }, () => diskPause(s, cfg, now(), m, hist)).filter(Boolean) : pressureResume(s, false, true)));
  for (const l of ls) {
    fs.appendFileSync(LOG, `${new Date().toISOString()} disk ${act === 'pause' ? `low (${(m.diskFree / 1024 ** 3).toFixed(1)}G free, under ${(diskLine(cfg) / 1024 ** 3).toFixed(1)}G and filling): paused` : 'has room again, or has held still: resumed'} ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}): ${l.cmd.slice(0, 60)}\n`);
    // Its agent hears it now, through the hook, not only when the tool call returns: it may need to save work or free space.
    if (act === 'pause') notify(l, `diskpause:#${l.id}:${l.pausedAt}`, `your job #${l.id} (${l.purpose ? `"${l.purpose}", ` : ''}${l.cmd.slice(0, 60)}) is paused: free disk is low `
      + `(${(m.diskFree / 1024 ** 3).toFixed(1)} GB) and still falling${hogHint()}. It keeps its lease and its place and resumes once there's room. `
      + "Free what you can of your own: build output, scratch folders and merged worktrees your session made. Don't end the job or run it again.");
  }
  return ls.length ? { act, leases: ls } : null;
}

// The hard stop (src/preempt.mjs hardStop), said loudly: the board's alert for the person
// (src/alerts.mjs), a line in the log, and a notice to the job's own session.
function hardOnce(m) {
  const r = withState(s => ({ resumed: hardResume(s, m), paused: hardStop(s, now(), m) }));
  const free = gb(m.diskFree ?? 0).replace(/G$/, ' GB');
  for (const l of r.resumed) {
    fs.appendFileSync(LOG, `${new Date().toISOString()} disk back to ${free}: resumed ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}): ${l.cmd.slice(0, 60)}\n`);
    event({ kind: 'resume', id: l.id, res: l.res, who: l.who, why: 'hard stop over', diskFree: m.diskFree });
    notify(l, `hardresume:#${l.id}:${now()}`, `your job #${l.id} (${l.cmd.slice(0, 60)}) is running again: free disk is back to ${free}.`);
  }
  const l = r.paused;
  if (l) {
    fs.appendFileSync(LOG, `${new Date().toISOString()} disk at ${free}, under ${gb(HARD_STOP)}: hard stop, paused ${l.who} ${l.res.join(',')} (${l.prio || 'normal'}), writing fastest: ${l.cmd.slice(0, 60)}\n`);
    event({ kind: 'pause', id: l.id, res: l.res, who: l.who, prio: l.prio || 'normal', why: 'hard stop', diskFree: m.diskFree });
    notify(l, `hardstop:#${l.id}:${l.pausedAt}`, `your job #${l.id} (${l.purpose ? `"${l.purpose}", ` : ''}${l.cmd.slice(0, 60)}) is paused: free disk is down to ${free}, `
      + `under the ${gb(HARD_STOP).replace(/G$/, ' GB')} where every job on the machine is about to fail, and it was writing the most. It resumes once there's ${gb(HARD_RESUME).replace(/G$/, ' GB')}. `
      + "Free what you can of your own now: build output, scratch folders and merged worktrees your session made. Don't end the job or run it again.");
  }
  return r;
}

export async function throttle(o, cfg) {
  if (!o.watch) {
    const seen = new Map();
    throttleOnce(cfg, seen);
    await sleep(6000);   // past the process-table cache, so the second pass sees fresh numbers
    const moved = throttleOnce(cfg, seen);
    console.log(moved.length ? moved.map(p => `moved ${p.name} ${p.pid} (${p.cpu}%) to background priority`).join('\n')
      : `nothing to throttle (load ${machine().load.toFixed(1)}, acts above ${cfg.coolLoad})`);
    return;
  }
  await singleInstance(PIDFILE, 'already watching');
  say(`throttling: when load is over ${cfg.coolLoad}, build and test processes outside dibs go to background priority.`
    + ` Under heavy memory pressure, idle and low dibs jobs pause until it eases; when swap fills the disk, jobs below high pause until there's room. Log: ${LOG}`);
  const seen = new Map(), track = { high: 0, low: 0, diskOk: 0, diskStill: 0 };
  let sampled = 0, nudged = 0, stuckSince = null, found = [], looked = 0;
  // Disk pauses stay while the disk is still critical: the next watcher adopts them (src/preempt.mjs settle).
  const stop = () => {
    try { withState(s => pressureResume(s, diskCritical(machine(), cfg) ? 'memory' : true)); } catch {}
    try { fs.rmSync(PIDFILE); } catch {}
    process.exit(0);
  };
  // A stuck broker can be stopped while holding the state lock, and the lock is only taken from
  // a live holder after 30 s. So replace it before this watcher's first locked step: watchBroker
  // takes no lock, and once the stuck one is killed its lock is taken over in 3 s, not 30.
  const early = watchBroker();
  if (early) fs.appendFileSync(LOG, `${new Date().toISOString()} ${early}\n`);
  try { const n = withState(s => adoptPauses(s)); if (n) fs.appendFileSync(LOG, `${new Date().toISOString()} took over ${n} disk pause${n > 1 ? 's' : ''} from the last watcher\n`); } catch (e) { if (!noSpace(e)) throw e; }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (;;) {
    cfg = loadConfig();   // so dibs pace reaches a running watcher
    // A full disk skips this pass instead of stopping the watcher.
    // Thin waiters (src/broker.mjs) can't tell a stuck broker from a busy one; this can.
    // First, without the lock: a broker stuck while holding it would hold up this pass too.
    const fixed = watchBroker();
    if (fixed) fs.appendFileSync(LOG, `${new Date().toISOString()} ${fixed}\n`);
    try {
      const leased = leasedGroups();
      throttleOnce(cfg, seen, leased);
      const m = machine(), stuck = coresStuck(m);
      if (stuck !== (stuckSince != null)) fs.appendFileSync(LOG, `${new Date().toISOString()} load ${m.load.toFixed(0)} with ${Math.round(100 * (1 - m.busy / m.cores))}% of the CPU idle: `
        + `${stuck ? 'cores look stuck, lowering nothing until it passes' : 'the cores are taking work again'}\n`);
      stuckSince = stuck ? stuckSince ?? now() : null;
      if (now() - looked >= ORPHAN_EVERY) {
        looked = now();
        const hot = processes().filter(p => p.cpu >= HOT && p.pid !== process.pid);
        found = orphans(hot, leased, runtimes(hot.map(p => p.pid)));
      }
      noteCpu({ stuckSince, ...(stuck && { load: Math.round(m.load), idle: Math.round(100 * (1 - m.busy / m.cores)), cores: m.cores, swapping: m.vmPressure >= 1 || swapGrowing(m) }), orphans: found });
      pressureOnce(cfg, track); diskOnce(cfg, track);
    } catch (e) { if (!noSpace(e)) throw e; }
    // A lift whose waiter went away without leaving (kill -9) drops back here (src/override.mjs inversions).
    try { lift(withState(s => inversions(s, cfg))); } catch (e) { if (!noSpace(e)) throw e; }
    // Not awaited: measuring a full temp folder can take a minute, and this loop keeps the machine's pace meanwhile.
    hogsOnce(cfg, machine());
    // Alerts open and close even while nobody looks at the board (src/alerts.mjs); the scan itself keeps its pace.
    scanAlerts({ s: peek(), cfg, hist: history(), watcher: true });
    // Open progress tasks gone quiet or past their ETA: their agents hear about it (src/notices.mjs).
    if (now() - nudged >= SAMPLE_EVERY) { nudged = now(); progressScan(); }
    if (now() - sampled >= SAMPLE_EVERY) {
      sampled = now();
      const m = machine();
      event({ kind: 'sample', load: m.load, memFree: m.memFree ?? null, diskFree: m.diskFree ?? null });
    }
    await sleep(INTERVAL);
  }
}
