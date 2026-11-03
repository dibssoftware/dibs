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
import { processes, lower, memPressure, isDibs } from './platform.mjs';
import { hogsOnce, hogHint } from './hogs.mjs';
import { pressureStep, pressurePause, pressureResume, diskStep, diskPause, diskPausesPerPass, diskLine, diskCritical, adoptPauses, diskRequeue, measured } from './preempt.mjs';
import { swapGrowing } from './schedule.mjs';
import { event } from './events.mjs';
import { notify } from './talk.mjs';
import { watchBroker } from './broker.mjs';
import { progressScan } from './notices.mjs';
import { scan as scanAlerts } from './alerts.mjs';
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

// One pass. A process must be hot on two passes in a row, so short bursts are
// left alone. Returns the processes it moved.
function throttleOnce(cfg, seen = new Map()) {
  const load = machine().load;
  const leased = new Set(withState(s => s.leases.flatMap(l => [l.pgid, ...(l.groups || [])]).filter(Boolean)));
  const moved = [];
  const next = new Map();
  for (const p of processes()) {
    // dibs itself never: a broker moved to the slow cores slows every waiter's turn.
    if (p.cpu < HOT || p.pid === process.pid || leased.has(p.pgid) || !TOOLS.test(toolName(p.args)) || isDibs(p)) continue;
    const prev = seen.get(p.pid);
    if (prev === 'done') { next.set(p.pid, 'done'); continue; }
    if (prev && load > cfg.coolLoad && lower(p.pid)) {
      moved.push({ ...p, name: toolName(p.args) });
      next.set(p.pid, 'done');
      fs.appendFileSync(LOG, `${new Date().toISOString()} load ${load.toFixed(1)}: background ${toolName(p.args)} ${p.pid} (${p.cpu}% cpu)\n`);
    } else next.set(p.pid, prev || 'hot');
  }
  seen.clear();
  for (const [k, v] of next) seen.set(k, v);
  return moved;
}

// One memory pressure reading. Under sustained critical pressure, pause the
// next idle or low lease; once it's been normal for a while, resume one.
// Returns { act, leases } when it did something.
export function pressureOnce(cfg, track, read = memPressure) {
  const act = pressureStep(track, read());
  if (!act) return null;
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
  let sampled = 0, nudged = 0;
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
    try { throttleOnce(cfg, seen); pressureOnce(cfg, track); diskOnce(cfg, track); } catch (e) { if (!noSpace(e)) throw e; }
    // Not awaited: measuring a full temp folder can take a minute, and this loop keeps the machine's pace meanwhile.
    hogsOnce(cfg, machine());
    // Alerts open and close even while nobody looks at the board (src/alerts.mjs); the scan itself keeps its pace.
    scanAlerts({ s: peek(), cfg, hist: history() });
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
