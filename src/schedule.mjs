// Who goes next. Pure functions of the state, config, history and clock, so
// they can be tested without processes.
import { resCfg, machine, hardware, RECENT, SWAP_WINDOW } from './config.mjs';
import { bytes, ms, dur, gb, now, runsOf, indexed, unpolled } from './util.mjs';
import { tag, isMine } from './proc.mjs';
import { isFiles, overlap, short, clash, coversAgent, elsewhere } from './files.mjs';
import { poolBlock } from './simpool.mjs';
import { dibsMem } from './platform.mjs';
import { alongside, merge, onTop } from './overlap.mjs';

const MIN = 6e4;

// How far each priority moves a request in line. A high job goes ahead of
// normal ones unless they have waited an hour longer, and urgent ahead of high
// the same way: on 2026-10-19 two high jobs ("owner waiting on build 125") sat
// sixth and ninth behind normal jobs that had waited 15 minutes longer, under
// the old 10-minute shift, until someone boosted them to urgent by hand.
export const PRIORITY_SHIFT = {
  urgent: 120 * MIN,    // something is broken or a person is waiting right now
  high: 60 * MIN,       // on the critical path
  normal: 0,
  low: -10 * MIN,       // nobody is waiting on it
  idle: -60 * MIN,      // only when the machine is otherwise quiet
};
export const PRIORITIES = Object.keys(PRIORITY_SHIFT);
// Also accept 1 (urgent) to 5 (idle).
export const priority = p => (/^[1-5]$/.test(String(p)) ? PRIORITIES[Number(p) - 1] : String(p).toLowerCase());
// These need a reason everyone can see, and the background ones run at low OS priority.
export const NEEDS_REASON = new Set(['urgent', 'high']);
export const BACKGROUND = new Set(['low', 'idle']);

const DEADLINE_WINDOW = 20 * MIN;          // a deadline starts to count when slack drops under this
export const DEADLINE_MAX = 60 * MIN;      // and moves a request up by at most this
// Shortest first, with aging: a waiter moves back by its expected run time,
// counted from PROBE, so a job shorter than that moves up and a longer one
// back. A 30-second check that arrives within 19 minutes of a 20-minute suite
// goes first; one that arrives later doesn't. So a job waits behind shorter work
// at most about its own run time, never more than LENGTH_MAX. On 2026-10-20 46%
// of jobs waited longer than they ran (57% over the week before).
// A command dibs has never seen counts as PROBE long, not the worst case: its
// first run teaches its length.
const PROBE = 2 * MIN;
const LENGTH_MAX = 60 * MIN;
const SHARE_WINDOW = 60 * MIN;             // recent use counted for fair share
const SHARE_MAX = 10 * MIN;                // heavy recent users move back by up to this
const SHARE_RATE = 0.2;                    // 5 minutes of use costs a minute back, so SHARE_MAX takes 50 minutes of use
export const UNKNOWN_RUN = 5 * MIN;        // run-time guess for a job with no history
// A running job always has at least this long left, so one that has overrun
// its typical time doesn't forecast its slot as free right now.
const MIN_LEFT = 30e3;
const BIG_JOB = 2 * 1024 ** 3;             // jobs this size and up wait for minFreeMem (the ram rule)
export const IDLE_MEM_FREE = 30;                  // idle work also waits for this % of memory free
// A session's hold moves its other waits up only this long after it was taken.
// Past that it's sitting on the resource, and dibs says to release it instead.
const HOLD_FRESH = 10 * MIN;

export function typical(hist, key) {
  const d = runsOf(hist, key).filter(h => !h.failed).slice(-10).map(h => h.dur).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : null;
}

// How much free disk a command eats while it runs: the middle of its last ten
// runs' shares of the disk's fall (src/measure.mjs shareDisk), or, until it has
// DISK_RUNS, its resources' last twenty.
// On 2026-10-22 a private simulator declared 6 GB, started with 6.0 GB free,
// and took the disk to 0.7 GB: the floor holds only with its real need on top.
const DISK_RUNS = 3;
const DISK_BY_RES = new WeakMap();
const mid = xs => (xs.sort((a, b) => a - b), xs[Math.floor(xs.length / 2)]);
export function typicalDisk(hist, key) {
  if (!hist) return null;
  const d = runsOf(hist, key).filter(h => h.ate != null).slice(-10).map(h => h.ate);
  if (d.length >= DISK_RUNS) return mid(d);
  const res = key?.split('|')[0];
  if (!res) return null;
  let by = DISK_BY_RES.get(hist);
  if (!by) {
    by = new Map();
    for (const h of hist) if (h.ate != null && h.key) { const r = h.key.split('|')[0]; (by.get(r) || by.set(r, []).get(r)).push(h.ate); }
    DISK_BY_RES.set(hist, by);
  }
  const r = (by.get(res) || []).slice(-20);
  return r.length >= DISK_RUNS ? mid([...r]) : null;
}

// What a command has really taken comes first; --est only stands in until dibs has seen it run.
export const expected = (x, hist) => typical(hist, x.key) || x.est || UNKNOWN_RUN;
export const known = (x, hist) => !!(x.est || typical(hist, x.key));
// Its slow runs: the 90th percentile of the last ten, for promises that mustn't
// be broken (a job let past a waiter has to be done before that one could start).
export function slow(hist, key) {
  const d = runsOf(hist, key).filter(h => !h.failed).slice(-10).map(h => h.dur).sort((a, b) => a - b);
  return d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.9))] : null;
}

// Which jobs slow each other down, from the history alone: each run is an
// interval [at - dur, at] under its key, whose first part is its resources. A
// command's runs that spent most of their time beside a run on resource r,
// against its runs that didn't: the ratio of their middle durations. Null until
// there are PAIR_RUNS of each. Two browser suites on one Mac can take twice as
// long side by side, or barely longer; this tells which.
const PAIR_RUNS = 3;
const PAIR_RECENT = 20;   // the last runs of a command that count: machines and suites change
const PAIRS = new WeakMap();
function byRes(hist) {
  let x = PAIRS.get(hist);
  if (x?.n === hist.length) return x;
  x = { n: hist.length, res: new Map(), memo: new Map() };
  for (const h of hist) {
    if (!h.at || !h.dur) continue;
    for (const r of String(h.key).split('|')[0].split(',')) (x.res.get(r) || x.res.set(r, []).get(r)).push(h);
  }
  PAIRS.set(hist, x);
  return x;
}
const middle = xs => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
export function slowdown(hist, key, r) {
  const x = byRes(hist), k = `${key}\n${r}`;
  if (x.memo.has(k)) return x.memo.get(k);
  const others = x.res.get(r) || [];
  const beside = h => others.some(o => o !== h && Math.min(o.at, h.at) - Math.max(o.at - o.dur, h.at - h.dur) >= h.dur / 2);
  const runs = runsOf(hist, key).filter(h => !h.failed && h.at && h.dur).slice(-PAIR_RECENT);
  const yes = [], no = [];
  for (const h of runs) (beside(h) ? yes : no).push(h.dur);
  const f = yes.length >= PAIR_RUNS && no.length >= PAIR_RUNS ? middle(yes) / middle(no) : null;
  x.memo.set(k, f);
  return f;
}

// Time a lease has spent paused (src/preempt.mjs), which its run clock skips.
export const pausedFor = (l, t = now()) => (l.pausedMs || 0) + (l.pausedAt ? t - l.pausedAt : 0);
// A lease paused for an urgent or high job has lent it its cores, and its
// slots of the resources that job needs. Its other slots stay its own: they're
// still taken when it resumes. With r, lent on that resource.
export const lent = (l, r) => !!l.pauses?.some(p => p.lease != null && (!r || !p.res || p.res.includes(r)));
// How far a running lease is over the memory dibs handed it, by its last
// measurement (src/measure.mjs), or 0. Footprints wobble by a few percent, so
// under OVER_SLACK past its number a job counts as on budget.
// A job planned at the budget (measure.mjs sized) is measured against what it usually uses.
const OVER_SLACK = 0.1;
export const overBy = l => { const m = Math.max(l.mem, l.usual || 0); return l.use && l.use.mem > m * (1 + OVER_SLACK) ? l.use.mem - m : 0; };

// Time left on a lease, or null when there's nothing to go on.
export function remaining(l, hist, t = now()) {
  if (l.kind === 'hold') return Math.max(l.expires - t, 0);
  const e = typical(hist, l.key) || l.est;
  return e == null ? null : Math.max(e - (t - l.start - pausedFor(l, t)), MIN_LEFT);
}

// Time an agent spent on these resources in the last hour, and which of them
// it used. Only the resources it's waiting for count: an hour of tests says
// nothing about whose turn the simulator is.
export function recentUse(hist, who, res, t = now()) {
  const want = new Set(res);
  let total = 0;
  const on = new Set();
  for (const h of indexed(hist).byWho.get(who) || []) {
    if (t - h.at >= SHARE_WINDOW) continue;
    const hit = h.res.filter(r => want.has(r));
    if (!hit.length) continue;
    total += Math.min(h.dur, SHARE_WINDOW);
    for (const r of hit) on.add(r);
  }
  return { total, res: [...on] };
}

// A waiter's place in line: arrival time, moved by each rule. Every rule is
// bounded, so a job is never passed forever. Lower goes sooner.
//   priority      urgent +2h, high +1h ... idle -60m
//   deadline      as slack drops under 20m, up to +60m
//   length        shorter than 2m moves up, longer moves back, by its expected run time (at most 60m)
//   recent use    agents who used the same resources a lot in the last hour, up to -10m (fair share)
//   holds         already holds a lease (holdingOf), moves like high
//   let ahead     someone yielded their place to you
// A waiter that already holds part of what it needs (holdingOf) moves up this
// far: enough to pass waiters that hold nothing, not past a high job.
const HOLDING_SHIFT = 10 * MIN;
export function rankParts(q, hist, t = now()) {
  const parts = [];
  const add = (label, shift) => { if (Math.abs(shift) >= 1000) parts.push({ label, shift: Math.round(shift) }); };
  // The quick lane goes to the front of its line, ahead of any priority: it's over in seconds.
  if (q.quickPass) add('quick', QUICK_FRONT);
  add(q.prio, PRIORITY_SHIFT[q.prio] || 0);
  if (q.holding && (!q.prio || q.prio === 'normal')) add(`holds ${q.holding.res.join(',')}`, HOLDING_SHIFT);
  if (q.by) {
    const slack = q.by - t - expected(q, hist);
    if (slack < DEADLINE_WINDOW) add('deadline', Math.min(DEADLINE_MAX, DEADLINE_WINDOW - slack));
  }
  const e = known(q, hist) ? expected(q, hist) : PROBE;
  add(e < PROBE ? 'short job' : 'long job', PROBE - Math.min(e, LENGTH_MAX));
  const usedRecently = recentUse(hist, q.who, q.res, t).total;
  if (usedRecently > 0) add('recent use', -Math.min(SHARE_MAX, usedRecently * SHARE_RATE));
  let value = q.enq - parts.reduce((a, p) => a + p.shift, 0);
  if (q.yieldRank != null && q.yieldRank < value) { add('let ahead', value - q.yieldRank); value = q.yieldRank; }
  return { value, parts };
}

export const rank = (q, hist, t = now()) => rankParts(q, hist, t).value;
// Each waiter's rank is worked out once per sort, not once per comparison.
export const byRank = (hist, t = now()) => {
  const memo = new Map();
  const r = q => { if (!memo.has(q)) memo.set(q, rank(q, hist, t)); return memo.get(q); };
  return (a, b) => r(a) - r(b) || a.id - b.id;
};

export const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

// Resources the waiter already has: its agent's holds, and the dibs run it's
// nested in (me.outer). They cover its own runs on the same resource, so you
// never queue behind yourself. Two subagents of one session are different
// agents when the guard told dibs which is which (src/files.mjs).
const covers = (h, x) => (h.kind === 'hold' && !!x.spid && h.pid === x.spid && coversAgent(h, x)) || (!!x.outer && h.id === x.outer);
export const holdsOf = (s, me) => new Set(s.leases.filter(l => covers(l, me)).flatMap(l => l.res));
// Slots of r in use. A run covered by its own hold or outer run doesn't count
// twice, but only while that lasts: once it ends, the run is a user again.
export const coveredNow = (s, l, r) => l.covered?.includes(r) && s.leases.some(h => h.res.includes(r) && covers(h, l));

// What a waiter already holds while it waits, or null: the dibs run it's
// nested in, unless that runs at low or idle priority, and its session's holds
// taken in the last HOLD_FRESH. Leaving those idle while it waits stalls work
// that matters (a ship holding deploy waiting for a build), so it goes ahead
// of waiters that hold nothing, like high priority, and passes the load
// ceiling. It never pauses anyone's job (preempt.mjs goes by -p only). Only
// configured resources count: a lease on a made-up name costs nobody anything,
// so wrapping work in one mustn't buy a place in line.
export function holdingOf(s, q, cfg, t = now()) {
  const ls = s.leases.filter(l => l.res.some(r => cfg.resources[r]) && ((q.outer && l.id === q.outer && !BACKGROUND.has(l.prio))
    || (l.kind === 'hold' && q.spid && l.pid === q.spid && t - l.start < HOLD_FRESH)));
  if (!ls.length) return null;
  return { res: [...new Set(ls.flatMap(l => l.res))], purpose: ls.find(l => l.purpose)?.purpose || '' };
}
// A job running on top of a full resource (src/overlap.mjs) doesn't take a slot.
export const used = (s, r) => s.leases.filter(l => l.res.includes(r) && !coveredNow(s, l, r) && !lent(l, r) && !onTop(l, r)).length;

// A resource that's one at a time per project (exclusiveBy: "repo", deploys by default):
// slots is per project, and across caps every project's together. A 6-second web deploy
// waited behind another project's TestFlight upload in the one deploy slot, and the person
// had to tell its agent to go around dibs (2026-11-03). A config that says only slots: 1
// keeps the default's exclusiveBy and across, so it reads per project too.
const byRepo = (cfg, r) => resCfg(cfg, r).exclusiveBy === 'repo';
// A lease's or waiter's project (src/files.mjs projectKey), or its folder before dibs recorded one.
export const laneOf = x => x.repo || x.cwd || null;
// The leases holding r's slots that q waits on: on a per-project resource, only its own project's.
const holdersFor = (s, q, r, cfg) => s.leases.filter(l => l.res.includes(r) && !coveredNow(s, l, r) && !lent(l, r) && !onTop(l, r)
  && (!byRepo(cfg, r) || laneOf(l) === laneOf(q)));
// Free slots of r for q, and whether the cap across projects is what's full.
export function roomFor(s, q, r, cfg) {
  const c = resCfg(cfg, r);
  if (!byRepo(cfg, r)) return { open: c.slots - used(s, r), across: false };
  const mine = c.slots - holdersFor(s, q, r, cfg).length, all = (c.across ?? c.slots) - used(s, r);
  return { open: Math.min(mine, all), across: all < mine };
}

// Time a lease should end. Without history, assume it runs at least UNKNOWN_RUN.
const endOf = (l, hist, t) => t + (remaining(l, hist, t) ?? Math.max(UNKNOWN_RUN - (t - l.start - pausedFor(l, t)), MIN_LEFT));
// When a lease's slot of r frees. A slot lent to an urgent job goes back to the
// paused job when that one ends, so it frees only after both.
const slotEnd = (s, l, hist, t, r) => endOf(l, hist, t)
  + sum(s.leases.filter(p => p.res.includes(r) && p.pauses?.some(x => x.lease === l.id)), p => endOf(p, hist, t) - t);

// Whether the machine is short on memory right now, or null. On macOS the
// OS's free-memory figure counts compressed and cached pages as free, so it
// can read 60% free while the Mac pages gigabytes to disk. Two signals don't
// lie: the OS's own memory pressure (warning or critical), and swap past
// cfg.maxSwap that grew by SWAP_GROWTH in the last 5 minutes. Swap alone
// doesn't count: macOS keeps it allocated for hours after the crunch ends.
// And swap lives on the startup disk, so it eats the free disk every job needs.
export const SWAP_GROWTH = 512 * 1024 ** 2;
// Jobs at or under this size start through swap and warning-level pressure (not critical).
export const LIGHT_MEM = 512 * 1024 ** 2;   // a few hundred MB of churn is normal; half a gigabyte in 5 minutes is paging for real
// Growing over 5 minutes and still growing now (config.mjs RECENT), at the
// same rate. The 5-minute total alone stays high for 5 minutes after swap
// stops, which held work back and paused jobs long after the crunch.
const RECENT_SHARE = RECENT / SWAP_WINDOW;
export const swapGrowing = m => (m.swapGrowth || 0) > SWAP_GROWTH && (m.swapRecent ?? m.swapGrowth ?? 0) > SWAP_GROWTH * RECENT_SHARE;
export function swapping(cfg, m = machine()) {
  if (m.vmPressure >= 1) return { rule: 'pressure', level: m.vmPressure === 1 ? 'warning' : 'critical' };
  if (cfg.maxSwap == null || m.swapUsed == null) return null;
  const limit = bytes(cfg.maxSwap);
  return m.swapUsed > limit && swapGrowing(m) && swapNotOurs(m) > limit ? { rule: 'swap', used: m.swapUsed, grew: m.swapGrowth, limit } : null;
}
// Swap less what dibs's own processes could account for. A line of idle
// waiters is the first thing macOS pages out, and starting nothing never
// shrinks it: on 2026-10-15, 45 of them held 2.4 GB while the gate waited on swap.
const swapNotOurs = m => m.swapUsed - (m.dibsMem ?? (m.dibsMem = dibsMem()));

// Free disk falling this fast is swap (or a job) filling it. An incremental
// Xcode build writes 1-2.5 GB over several minutes; 3 GB in 5 minutes is more
// than any one job here writes, and swap on 2026-10-15 drank 2 GB a minute.
export const DISK_DRAIN = 3 * 1024 ** 3;
export const diskDraining = m => (m.diskDrain || 0) > DISK_DRAIN && (m.drainRecent ?? m.diskDrain ?? 0) > DISK_DRAIN * RECENT_SHARE;
// How far ahead a falling disk is projected. Ten minutes covers a build or an
// archive finishing its writes, and is longer than the watcher needs to act.
const DRAIN_AHEAD = 10 * MIN;
// Bytes per ms free disk is falling at, over the 5-minute window.
const drainRate = m => (m.diskDrain || 0) / Math.max(m.drainMs || 0, 30e3);
// Swap needs free disk to grow into. While the machine swaps (past maxSwap or
// growing), work below urgent keeps cfg.swapRoom free on top of what it would
// need anyway; and while free disk falls fast enough to be under that within
// DRAIN_AHEAD, it waits for it to hold steady. Two builds writing 4 GB on a
// disk with 200 GB free hold nobody up. Null when neither applies.
export function diskSqueeze(cfg, need, m = machine()) {
  if (m.diskFree == null) return null;
  // Swap over maxSwap that holds still with pressure normal is left over from
  // an earlier crunch: macOS keeps it allocated for hours. On 2026-10-15 a flat
  // 4.6 GB held every start for 30 minutes with 77% of memory free.
  const paging = m.swapUsed != null && (swapGrowing(m) || m.vmPressure >= 1);
  const room = cfg.swapRoom != null ? bytes(cfg.swapRoom) : 0;
  if (cfg.swapRoom != null && paging && m.diskFree < need + room)
    return { rule: 'swaproom', free: m.diskFree, need: need + room, room, used: m.swapUsed,
             why: `disk: ${gb(m.diskFree)} free, and while the machine swaps (${gb(m.swapUsed)} of swap) dibs keeps ${gb(need + room)} free before starting anything new, so swap has room to grow (swapRoom ${gb(room)})` };
  const ahead = m.diskFree - drainRate(m) * DRAIN_AHEAD;
  if (diskDraining(m) && ahead < need + room)
    return { rule: 'drain', free: m.diskFree, fell: m.diskDrain, projected: Math.max(0, ahead),
             why: `free disk fell ${gb(m.diskDrain)} in 5 min to ${gb(m.diskFree)}, and at that rate it's under ${gb(need + room)} within ${DRAIN_AHEAD / MIN} min, so dibs starts nothing new until it holds steady` };
  return null;
}

// Said wherever the machine holds new work back, so nobody reads it as a hint to raise priority.
export const NOT_PRIORITY = 'Keep waiting: raising the priority is not the fix';
export const swapWhy = sw => (sw.rule === 'pressure'
  ? `memory pressure is high (the OS says ${sw.level}), so dibs starts nothing new while other jobs run`
  : `swap grew ${gb(sw.grew)} in 5 min, ${gb(sw.used)} in use (over maxSwap ${gb(sw.limit)}), so dibs starts nothing new while other jobs run`);

// The budgets exist to stop pile-ups, not to leave a quiet machine idle. While
// the OS reports plenty of free memory and spare cores, they don't apply. Never
// while the machine swaps (its free-memory reading is wrong then), and never
// once the budget is already used up: then the room was an illusion.
function roomy(cfg, full, m = machine()) {
  if (full || swapping(cfg, m) || swapGrowing(m)) return false;
  // Cores in use, like the load ceiling: a load average swollen by disk waits isn't work.
  const load = cpuLoad(m);
  return m.memFree >= cfg.roomyMemFree && load < (m.cores || 8) * cfg.roomyLoad;
}

// Cores a lease takes from the CPU budget: what it was last measured using
// (src/measure.mjs) once it has been, else what it asked for. Test suites and
// builds ask for their peak and spend most of a run well under it, and too
// many busy cores only slows everyone a little, where too little memory kills
// jobs. So cores go by what's in use, and memory (memOf) by the larger of the
// planned number and what's in use.
export const coresOf = l => (l.kind === 'run' && l.use?.cpu != null ? l.use.cpu : l.cpu ?? 1);
// Memory a lease takes from the budget: what it was planned at, or what its
// whole process tree was last measured using when that's more. A job that
// outgrows its number still fills the machine.
//
// Once a run is measured and its memory has stopped climbing (settled), the
// plan gives way to what it uses now. A run idle IDLE_BOOK books only that:
// it isn't climbing anywhere. A busy one books it plus BUSY_MARGIN: footprints
// move by hundreds of MB between 10-second samples, and a test worker starting
// a browser adds most of a gigabyte. On 2026-10-15 two Playwright runs booked
// 12 of 11 GB on the strength of past peaks while using 3 GB between them, one
// idle for 7 minutes, and a high deploy waited 11 minutes with 12 GB free.
//
// A run measured for BOOK_AFTER books its peak plus BUSY_MARGIN even while it
// still climbs, never more than its plan: on 2026-10-19 a test suite that asked
// 8 GB used 0.8, and three like it held 16 GB of an 11 GB budget while 18 jobs
// waited with 12 GB free. A waiter let into that gap still needs the memory to
// be really free (overBudget): the OS's pressure is the guard, not the asks.
const IDLE_BOOK = 5 * MIN;   // the same 5 minutes acquire.mjs marks a run idle at (IDLE_AFTER)
const BUSY_MARGIN = 1024 ** 3;
// Long enough for a test suite to start its workers and a build its compiler:
// eighteen 10-second samples.
const BOOK_AFTER = 3 * MIN;
export const plannedOf = l => Math.max(l.mem || 0, l.use?.mem || 0);
// What a lease uses this moment: its last measurement, or its plan until it has one.
const usedNow = l => (l.kind === 'run' && l.use?.mem != null ? l.use.mem : plannedOf(l));
export const memOf = (l, t = now()) => {
  const planned = plannedOf(l);
  if (l.kind !== 'run' || l.use?.mem == null) return planned;
  if (steady(l, t)) return l.idleSince && t - l.idleSince >= IDLE_BOOK ? l.use.mem : l.use.mem + BUSY_MARGIN;
  if (t - l.start - pausedFor(l, t) < BOOK_AFTER) return planned;
  const peak = Math.max(l.peak?.mem || 0, l.use.mem);
  return Math.min(peak + BUSY_MARGIN, Math.max(planned, peak));
};

// The lease a run sits inside, when its own hold or outer dibs run covers all
// it asked for, or null.
const coverOf = (s, l) => (l.covered && l.res.every(r => coveredNow(s, l, r)) ? s.leases.find(h => h !== l && covers(h, l)) || null : null);
// Memory every lease takes from the budget, each byte counted once. A run
// inside its own hold or dibs run uses memory that cover already reserved:
// adding both counted a simulator hold and the tests run in it twice. The
// cover counts at the larger of what it reserved and what it and the runs
// inside it use.
export function memUsed(s, of = memOf) {
  const inside = new Map();
  for (const l of s.leases) { const c = coverOf(s, l); if (c) inside.set(c.id, [...(inside.get(c.id) || []), l]); }
  const charge = (l, depth = 0) => {
    const kids = inside.get(l.id);
    if (!kids || depth > 4) return of(l);
    return Math.max(l.mem || 0, (l.use?.mem || 0) + sum(kids, k => charge(k, depth + 1)));
  };
  const top = new Set([...inside.values()].flat());
  return sum(s.leases.filter(l => !top.has(l)), l => charge(l));
}

// The leases taking the most memory, biggest first, for a memory wait to name.
// asked: what it asked for (--mem or its resource's default); use: what its
// last measurement found, or null before the first.
// Ranked by what each one was measured using, where there's a measurement: on 2026-11-03 an
// 11 GB booking using 0.1 GB took the blame for a pressure wait it wasn't causing.
const blame = l => l.use?.mem ?? memOf(l);
export const memHolders = (s, n = 3) => s.leases.filter(l => memOf(l) > 0 && !coverOf(s, l)).sort((a, b) => blame(b) - blame(a)).slice(0, n)
  .map(l => ({ id: l.id, who: l.agent || l.who, label: l.label, purpose: l.purpose || '', mem: memOf(l), asked: l.asked ?? l.mem ?? 0, use: l.use?.mem ?? null, idleSince: l.idleSince || null }));

// Memory the OS says is free right now, in bytes, or null.
export const realFree = m => (m.memFree == null ? null : m.memFree / 100 * (m.memTotal || hardware().mem));
// The free memory people are shown: free plus what the OS reclaims on demand (vm_stat, MemAvailable),
// the figure the real-memory wait uses, so the Limits line and that wait never show two numbers.
export const shownFree = m => m.memAvail ?? realFree(m);

// The room a job let into the gap between what running jobs ask for and what
// they use must really be there (overBudget): memory pressure normal, swap not
// growing, and the job plus ROOM_RESERVE free by the OS's reading (macOS's
// kern.memorystatus_level, MemAvailable on Linux). That reading counts cached
// and compressed pages as free, which is why pressure and swap must both be
// quiet too: 0.0.81 saw it say 60% free while the Mac paged gigabytes to disk.
const ROOM_RESERVE = Math.max(3 * 1024 ** 3, 0.2 * hardware().mem);   // 3 GB, or a fifth of the machine on a big one
function realRoom(q, cfg, m = machine()) {
  if (m.vmPressure >= 1 || swapGrowing(m) || swapping(cfg, m)) return false;
  const free = realFree(m);
  return free != null && free >= q.mem + ROOM_RESERVE;
}

// Leases that stand between a waiter and a machine of its own. Its own holds
// and leases that cost nothing (file leases) don't count: waiting on them
// would mean waiting on itself, or on an hour-long file hold.
const othersOf = (s, q) => s.leases.filter(l => !covers(l, q) && ((l.mem || 0) > 0 || (l.cpu ?? 1) > 0));
// A lease doing work right now. A hold with nothing running under it, a file
// lease and a paused job grow neither swap nor the disk, so they aren't
// "anything else running" for the machine's gates: on 2026-10-15 forty-odd
// idle holds and paused jobs kept every new start out while swap ate the disk,
// and nothing ever ran to end the wait. A run under a hold is its own lease.
export const working = l => l.kind === 'run' && !l.pausedAt && !l.res.every(isFiles);

// When swap, the disk swap grows on, or memory pressure has kept every start
// out for STALL while waiters wait, the smallest and shortest of them starts
// anyway, one at a time. Ten minutes is two of the 5-minute windows swap and
// disk are judged over: a real crunch has had time to pass by then, and
// waiting longer only piles more waiters up, each one more process in memory.
export const STALL = 10 * MIN;
// A job let in that way counts as settled once its measured memory hasn't
// risen more than 5% (measure.mjs peakAt) for this long: twelve samples.
const SETTLED = 2 * MIN;
// A lease dibs never measures (a hold, a run with no process group of its
// own) can't settle, and held the real-room path shut for good on 2026-10-15
// (a file hold let in past the budget). It counts as settled, and so does a
// run still unmeasured UNMEASURED after it started.
const UNMEASURED = 2 * MIN;
const steady = (l, t) => l.peakAt != null && t - l.peakAt >= SETTLED;
const settled = (l, t) => (l.peakAt != null ? steady(l, t) : l.kind !== 'run' || !l.pgid || t - l.start >= UNMEASURED);
// The last start the gates allowed: one still running, or one noted in
// s.lastStart when it started (it may have ended since).
// Only starts that passed the machine's gates (gated): a run inside its own
// hold, or urgent work, starts past them and says nothing about the stall.
const lastStart = s => Math.max(s.lastStart || 0, ...s.leases.filter(l => l.gated).map(l => l.start));
function breaksStall(s, me, cfg, hist, t, m) {
  if (m.vmPressure >= 2 || s.leases.some(l => l.breaker && !settled(l, t))) return false;
  // Waiters the machine holds back, as their last poll found (machineHeld,
  // acquire.mjs decide). An open slot isn't enough: on 2026-10-15 the breaker
  // picked a heavy job waiting its turn behind another, which never reached
  // the breaker, so nobody went.
  const held = [me, ...s.queue.filter(q => q.pid && q.id !== me.id && q.machineHeld && (q.prio || 'normal') !== 'urgent')];
  if (t - Math.max(lastStart(s), Math.min(...held.map(q => q.enq))) < STALL) return false;
  const pick = held.sort((a, b) => (a.mem || 0) - (b.mem || 0) || expected(a, hist) - expected(b, hist) || a.enq - b.enq || a.id - b.id)[0];
  return pick.id === me.id;
}
export const BREAKER_LINE = `let in: nothing had started for ${STALL / MIN} min, so dibs starts the smallest waiter, one at a time`;

// strict: the roomy rule doesn't apply (a job on top of a full resource has
// already been let past its slots once).
// Cores in use: a paused job burns none, whatever paused it.
export const cpuUsed = s => Math.round(sum(s.leases.filter(l => !lent(l) && !l.pausedAt), coresOf) * 10) / 10;
// Swap that grew in the last 5 minutes is memory jobs took that the budget
// never handed out: macOS pages it to disk instead of saying no. Counting it
// stops new work while swap climbs, not after it has eaten the disk.
// REAL_WAIT was 10 minutes (0.0.159). On 2026-10-25 twenty Xcode builds and simulator
// jobs that book 7 to 9 GB waited out nearly all of it on a Mac whose free-or-reclaimable
// memory sits near 5 GB, then ran with free memory never under 31% and nothing paused for
// them. Two minutes is enough for the readings to show anything that started before.
const YOUNG = 3 * MIN, REAL_WAIT = 2 * MIN;
export const swapTaken = m => (swapGrowing(m) ? m.swapGrowth : 0);
// noSwap: swap growth doesn't count (the stall breaker let it by).
function overBudget(s, q, cfg, strict = false, noSwap = false, t = now()) {
  // A job as big as the whole budget runs when nothing else is.
  if (!othersOf(s, q).length) return null;
  const m = machine();
  const swap = noSwap ? 0 : swapTaken(m);
  const mem = memUsed(s) + swap;
  const cpu = cpuUsed(s);
  // Memory booked never goes past the budget, however roomy the machine looks:
  // only cores, which cost a little speed when overcommitted, get the roomy rule.
  const budget = bytes(cfg.budget);
  // Booked past the budget, but what running jobs measure using right now, plus
  // this job, fits it, and the machine shows the room (pressure normal, swap not
  // growing, the job plus a reserve free): it starts. Booking keeps a job's peak
  // for minutes after it falls; on 2026-10-20 twenty jobs waited "blocked by
  // memory" with 8.6 GB free and 1 of 10 cores busy.
  // A light job can't make the paging worse, so only critical pressure takes the room away from it (as for the swap gate).
  const room = () => ((q.mem || 0) <= LIGHT_MEM && !(m.vmPressure >= 2)) || realRoom(q, cfg, m);
  const fitsUse = () => memUsed(s, usedNow) + swap + q.mem <= budget && room();
  if (mem + q.mem > budget && !fitsUse())
    return { rule: 'memory', used: mem, of: budget, need: q.mem, ...(swap && { swap }),
             why: `memory budget: ${gb(mem)} of ${gb(budget)} handed out or in use${swap ? ` (${gb(swap)} of it swap that grew in the last 5 min)` : ''}, you need ${gb(q.mem)}` };
  // It fits only because running jobs book what they were measured using, not
  // what they asked for. One of them may still grow into its ask, so the room
  // must be real: memory pressure normal, swap still, and the job plus a
  // reserve free on the machine.
  if (memUsed(s, plannedOf) + swap + q.mem > budget && !room())
    return { rule: 'memory', used: mem, of: budget, need: q.mem, pressure: true, free: realFree(m), reserve: ROOM_RESERVE, high: m.vmPressure >= 1, growing: swapGrowing(m),
             why: `memory: running jobs ask for more than they use, but the machine doesn't have the room to show for it (${realFree(m) == null ? 'free memory unknown' : `${gb(realFree(m))} free`}${m.vmPressure >= 1 ? ', memory pressure high' : ''}${swapGrowing(m) ? ', swap growing' : ''}), you need ${gb(q.mem)} plus ${gb(ROOM_RESERVE)} to spare` };
  // Within the budget, the machine must still have it: what's really available
  // (src/platform.mjs vmAvail), less what running jobs booked and haven't
  // touched yet, must hold the job (macOS still compresses idle apps' pages to
  // make a little more, so no spare on top). The budget alone counts only
  // dibs's jobs: on 2026-10-22 Claude sessions, apps and simulators held 8 GB
  // of the 16, dibs booked two 6 GB browser runs into the rest, and swap took
  // the disk to 0.7 GB. Small jobs, and the stall breaker, are let by.
  // A job that has waited REAL_WAIT on it goes once swap holds still, pressure is normal and no big job just started: the
  // watcher's swap and disk guards still stand, and on a busy Mac the room may never come.
  // A big job that started under YOUNG ago isn't in those readings yet, so the next one waits for it.
  const bigYoung = s.leases.some(l => !covers(l, q) && l.kind === 'run' && (l.mem || 0) > LIGHT_MEM && t - (l.start || 0) < YOUNG);
  const waitedOut = q.enq != null && t - q.enq >= REAL_WAIT && !bigYoung && !swapGrowing(m) && !(m.vmPressure >= 1);
  if (!noSwap && !waitedOut && m.memAvail != null && (q.mem || 0) > LIGHT_MEM) {
    // Its own hold or the dibs run it's nested in booked memory for it: that's no one else's.
    // Only a job that just started may still grow into its booking: one that has run
    // a while at less is done growing. On 2026-10-22 a ship's deploy and simulator,
    // 20 minutes in at 0 GB measured, kept 5 GB of 4.3 spoken for and held four jobs.
    // Its age by its last measurement: not measured yet is young.
    const young = l => l.use?.at == null || l.use.at - (l.start || 0) < YOUNG;
    const others = { ...s, leases: s.leases.filter(l => !covers(l, q) && young(l)) };
    const untouched = Math.max(0, memUsed(others, plannedOf) - memUsed(others, usedNow));
    if (m.memAvail - untouched < q.mem)
      return { rule: 'memory', real: true, used: mem, of: budget, need: q.mem, free: m.memAvail, untouched,
               why: `memory: ${gb(m.memAvail)} free or reclaimable on the machine${untouched ? ` (${gb(untouched)} of it booked by running jobs)` : ''}, you need ${gb(q.mem)}` };
  }
  if (!strict && roomy(cfg, mem > budget || cpu > cfg.cores, m)) return null;
  if (cpu + q.cpu > cfg.cores)
    return { rule: 'cpu', used: cpu, of: cfg.cores, need: q.cpu, why: `CPU budget: ${cpu} of ${cfg.cores} cores in use, you need ${q.cpu}` };
  return null;
}

// The 1-minute load average moves toward the real load with a 60s time
// constant, so a job started t ago shows in it as only 1 - e^(-t/60s) of its
// cores. The rest is added back here. Without it, a burst of waiters would all
// start under one reading taken before any of them. Each counts at what it
// asked for, not coresOf: a job seconds in is measured before it ramps up.
const LOAD_LAG = 60e3;
export const loadAhead = (s, m = machine()) => sum(s.leases.filter(l => l.kind === 'run' && !l.pausedAt),
  l => (l.cpu ?? 1) * Math.exp(-Math.max(0, m.at - l.start) / LOAD_LAG));

// Urgent and high work isn't held back by the load ceiling: it's rare, and says
// why. Nor is work that holds a lease while it waits.
const PAST_CEILING = new Set(['urgent', 'high']);
const pastsCeiling = q => PAST_CEILING.has((q.prio || 'normal')) || !!q.holding;
// The load as it will read once recent starts show up, when it's over maxLoad.
// What the CPU is really doing: the load average, unless it's inflated by
// processes waiting on swap or disk (memory pressure has its own guard): then
// the cores in use. Cores in use can't pass the core count, so with every core
// busy the load average is the only measure of how much more wants to run. Taking
// the smaller of the two always, as before 2026-11-02, capped the reading at the
// cores: on max pace (a ceiling of 1.5 per core) the ceiling could never hold, and
// the load ran to 12 times the cores.
const SATURATED = 0.9;
export function cpuLoad(m) {
  if (m.busy == null) return m.load;
  const cores = m.cores || hardware().cores;
  return m.busy >= cores * SATURATED ? m.load : Math.min(m.load, m.busy);
}

export function overLoad(s, cfg, m = machine()) {
  if (cfg.maxLoad == null) return null;
  const ahead = loadAhead(s, m);
  const load = cpuLoad(m);
  return load + ahead > cfg.maxLoad ? { load, ahead } : null;
}
// A job the load ceiling alone has held LOAD_STARVE starts anyway, at
// background priority (taskpolicy -b: the efficiency cores on Apple silicon),
// which barely warms the fan the ceiling is there for. On 2026-10-18 an idle
// OCR job waited 2h52m: maxLoad 5 on 10 cores, with 7.5 to 11 of load from
// work dibs doesn't run. Jobs let in that way share LOAD_SHARE of the cores,
// a little under the efficiency cores' part of these Macs; more than that only
// queues them behind each other. One that asks for more still goes alone.
export const LOAD_STARVE = 20 * MIN;
const LOAD_SHARE = 0.4;
function loadShare(s, me) {
  const share = Math.max(1, Math.floor(hardware().cores * LOAD_SHARE));
  const taken = sum(s.leases.filter(l => l.loadPast && !l.pausedAt), coresOf);
  return !taken || taken + (me.cpu ?? 1) <= share;
}
export const loadWhy = (hot, cfg) => `load ${(hot.load + hot.ahead).toFixed(1)} is over maxLoad ${cfg.maxLoad}`
  + `${hot.ahead >= 0.1 ? ` (${hot.load.toFixed(1)} now, plus ${hot.ahead.toFixed(1)} for jobs too new to show in it)` : ''}`
  + `. New work waits for it to cool down, except work finishing what it already holds; one held ${LOAD_STARVE / MIN} min starts anyway at background priority`;

// The soonest a waiter could start, judging only by what's running now.
function soonestStart(s, q, cfg, hist, t = now()) {
  const mine = holdsOf(s, q);
  let at = t;
  for (const r of q.res) {
    if (!mine.has(r) && roomFor(s, q, r, cfg).open <= 0) {
      const across = roomFor(s, q, r, cfg).across;
      at = Math.max(at, Math.min(...s.leases.filter(l => l.res.includes(r) && !lent(l, r) && !onTop(l, r) && (across || !byRepo(cfg, r) || laneOf(l) === laneOf(q))).map(l => slotEnd(s, l, hist, t, r))));
    }
  }
  if (overBudget(s, q, cfg)) at = Math.max(at, budgetFrees(s, q, cfg, hist, t));
  return at;
}
// Whether q's turn at the budget rests only on jobs whose run time dibs knows
// (--est or history) and that haven't overrun it: then its start is a real time.
// Otherwise it's a guess, and a short job of known length doesn't wait on it.
// On 2026-10-20 three 2-minute browser runs and a test run sat behind an Xcode
// build waiting for 6.4 GB, which waited on a build said to take 3 minutes
// that had run 74, while the memory they needed was free.
function budgetSure(s, q, cfg, hist, t) {
  let mem = memUsed(s), cpu = cpuUsed(s);
  const fits = () => mem + q.mem <= bytes(cfg.budget) && cpu + q.cpu <= cfg.cores;
  const ends = s.leases.filter(l => !covers(l, q) && !coverOf(s, l)).map(l => [l, likelyEnd(l, hist, t)]).sort((a, b) => a[1] - b[1]);
  for (const [l] of ends) {
    // A hold ends when it expires (dibs hold --for); a run, at its --est or usual time.
    if (l.kind === 'hold' ? !l.expires : !known(l, hist) || overran(l, hist, t)) return false;
    mem -= memOf(l);
    if (!lent(l) && !l.pausedAt) cpu -= coresOf(l);
    if (fits()) return true;
  }
  return false;
}

// When enough of what's booked ends for q to fit the memory and CPU budgets,
// leases ending in order. Not the first lease to end: on 2026-10-18 a job
// waiting on the budget behind a long hold counted as starting "soon" for
// 4.5 hours, and as the oldest waiter it held 26 jobs back, every one of
// which would have been done long before it could start.
function budgetFrees(s, q, cfg, hist, t) {
  let mem = memUsed(s), cpu = cpuUsed(s);
  const fits = () => mem + q.mem <= bytes(cfg.budget) && cpu + q.cpu <= cfg.cores;
  const ends = s.leases.filter(l => !covers(l, q) && !coverOf(s, l)).map(l => [l, likelyEnd(l, hist, t)]).sort((a, b) => a[1] - b[1]);
  for (const [l, end] of ends) {
    mem -= memOf(l);
    if (!lent(l) && !l.pausedAt) cpu -= coresOf(l);
    if (fits()) return end;
  }
  // A job as big as the whole budget runs when nothing else is.
  return ends.length ? ends.at(-1)[1] : t;
}
// When a lease will really end, for reserving memory. One already past its
// usual time isn't ending in 30 seconds (endOf's floor), over and over: count
// it as running as long again as it has so far. On 2026-10-19 a waiter for 11 GB read as starting
// "in a minute" for half an hour while the jobs it waited on overran, and as
// the head of the line it held 22 jobs, two of them high, on a quiet Mac.
const ranFor = (l, t) => t - l.start - pausedFor(l, t);
const overran = (l, hist, t) => l.kind === 'run' && ranFor(l, t) >= expected(l, hist);
const likelyEnd = (l, hist, t) => (overran(l, hist, t) ? t + ranFor(l, t) : endOf(l, hist, t));
// A waiter that needs most of the budget reserves it (holds back jobs that
// would still be running when it could start) only once it could start
// within RESERVE_SOON. Further off, it waits for a quiet moment and lets jobs
// that fit start meanwhile: reserving a whole machine on a forecast an hour
// out froze every other queue for it.
const BIG_SHARE = 0.75;
const RESERVE_SOON = 5 * MIN;
// A waiter of lower priority than me, held by the budgets: it doesn't hold me
// back by being ahead in line. High and urgent work never waits behind a
// normal job's memory reservation.
const reservesFor = (s, q, me, cfg) => !(PRIORITIES.indexOf(q.prio || 'normal') > PRIORITIES.indexOf(me.prio || 'normal') && overBudget(s, q, cfg));

// Why q could never start on this machine, whatever ends: it asks for more
// memory or cores than dibs hands out at once. Null when it could. A job
// another machine sent here (q.sent) was placed for this machine's size, as a
// VM made big enough for it is, and runs alone past the budget: only more than
// the machine itself has counts then.
export function neverFits(cfg, q) {
  const { mem, cpu: cores, whole } = mostHere(cfg, q.sent);
  if (q.mem > mem) return { what: 'memory', need: q.mem, most: mem, flag: '--mem', unit: gb, whole };
  if (q.cpu > cores) return { what: 'cores', need: q.cpu, most: cores, flag: '--cpu', unit: n => String(n), whole };
  return null;
}
// The most one job may book on this machine: the budgets, or for a job sent
// here (neverFits) the machine itself.
export function mostHere(cfg, sent) {
  const hw = sent && hardware();
  return { mem: hw ? hw.mem : bytes(cfg.budget), cpu: hw ? hw.cores : cfg.cores, whole: !!hw };
}
// What a job asked for in so many words (--mem, --cpu), which alone can make
// it never fit. A size dibs chose (the resource's default, or one learned on
// a bigger machine) is booked at most at mostHere instead: a lone job past the
// budget still runs. On 2026-10-18 a test run that had used 5 cores on the
// 10-core Mac was refused on a 4-core VM, though it asked for 3.
export const explicitAsk = q => ({ mem: q.declared ? q.asked ?? q.mem : 0, cpu: q.cpuDeclared ? q.askedCpu ?? q.cpu : 0, sent: q.sent });
export function capToMachine(cfg, q) {
  const most = mostHere(cfg, q.sent);
  let changed = false;
  if (q.mem > most.mem) { q.mem = most.mem; changed = true; }
  if (q.cpu > most.cpu) { q.cpu = most.cpu; changed = true; }
  return changed;
}

// A file lease waits for every other agent's lease on an overlapping path, and
// for other agents ahead in line for one. An agent never waits on its own. Two
// subagents of one session are different agents when the guard told dibs which
// is which (src/files.mjs); otherwise a session is one agent.
const own = (x, me) => isMine(x, me) && coversAgent(x, me);
function filesBlock(s, me, r, ahead) {
  for (const l of s.leases) {
    const x = !own(l, me) && l.res.find(y => isFiles(y) && overlap(y, r));
    if (x) return { ok: false, rule: 'files', why: `${short(x)} is leased to ${tag(l)}${elsewhere(l)}${x === r ? '' : `, which overlaps ${short(r)}`}`, on: x };
  }
  const q = ahead.find(q => !own(q, me) && q.res.some(y => isFiles(y) && overlap(y, r)));
  return q ? { ok: false, rule: 'ahead', why: `${tag(q)} is ahead of you for files overlapping ${short(r)}`, on: r, ahead: q } : null;
}

// Nearly twice as long side by side is a fight for the same thing (cores, the
// GPU, one port); sharing a machine always costs something, so less isn't held back.
const SLOW_PAIR = 1.8;
function clashOf(s, me, hist) {
  for (const l of s.leases) {
    if (l.kind !== 'run' || l.pausedAt || isMine(l, me)) continue;
    for (const r of l.res) {
      const f = slowdown(hist, me.key, r);
      if (f >= SLOW_PAIR) return { lease: l, res: r, why: `it usually runs ${f.toFixed(1)}x as long beside ${r} work, and ${tag(l)}'s is running` };
    }
    for (const r of me.res) {
      const f = slowdown(hist, l.key, r);
      if (f >= SLOW_PAIR) return { lease: l, res: r, why: `${tag(l)}'s job usually runs ${f.toFixed(1)}x as long beside ${r} work like this` };
    }
  }
  return null;
}

// A run this short (the middle of its runs) is over in seconds: featherweight below. The quick
// lane (quickPass) goes by cfg.quickUnder, which is 15 s unless set.
const INSTANT = 15e3;
// A job over in seconds that has never been seen using much memory: its middle
// run under INSTANT (or, before dibs has seen it, an --est that short with no --mem
// asked), and no run measured over LIGHT_MEM. It can't tip the machine into swap,
// so swap and warning pressure don't hold it, and its resource's default size
// (2 GB for a test run) doesn't book it past the budget. Critical pressure and
// the disk floor still do. On 2026-10-23 a 70 ms node --test of one file waited
// minutes on "memory pressure high" behind a 4 GB Docker build.
// Light by its own runs: the last ten measured at LIGHT_MEM or less, at least LIGHT_RUNS of them,
// whatever it asked for. On 2026-11-03 a deploy that asked for 6 GB and used under 0.5 GB waited on
// memory pressure that an 11 GB Xcode booking using 0.1 GB was blamed for.
const LIGHT_RUNS = 3;
export function measuredLight(me, hist) {
  const runs = runsOf(hist, me.key).slice(-10).filter(h => h.mem != null);
  return runs.length >= LIGHT_RUNS && runs.every(h => h.mem <= LIGHT_MEM);
}
export function featherweight(me, hist) {
  const d = typical(hist, me.key) ?? (me.declared ? null : me.est);
  if (d == null || d >= INSTANT) return false;
  return runsOf(hist, me.key).slice(-10).every(h => h.mem == null || h.mem <= LIGHT_MEM);
}
// Probation: a command dibs has never seen, with no --mem and no --est, has
// nothing to vouch for it, so featherweight can't pass it. On 2026-10-24, 13 of
// the 17 short jobs held on memory pressure were first runs (one-file tests,
// a tsc, a swift build), and they waited up to 7 minutes to run for seconds.
// Once it has waited PROBATION_AFTER, one such job at a time starts through
// warning pressure, on resources that can pause. Growing swap and the memory
// budget still hold it, since nothing pauses a job for those. The watcher pauses it before anyone else if the pressure turns critical
// (src/overlap.mjs pressureVictim), and once it has run, its measured size decides.
const PROBATION_AFTER = 30e3;
export function probation(s, me, cfg, hist, t) {
  if (t - me.enq < PROBATION_AFTER) return false;
  if (me.kind === 'hold' || me.declared || me.est != null || !me.key || runsOf(hist, me.key).length) return false;
  if (!me.res.every(r => !isFiles(r) && resCfg(cfg, r).pausable === true)) return false;
  return !s.leases.some(l => l.trial);
}
// The quick lane (2026-11-03, the person: "let one really really quick thing go instantly ...
// if it takes under 15 seconds"). A command whose runs here take under quickUnder at the
// middle, or one run with --quick (or an --est that short) before dibs has seen it, starts at
// once: past the line, the slots of shared and pool resources, warning memory pressure, swap
// and the load ceiling. The disk floor, critical pressure, file leases and someone else's hold
// still hold it, and it never pauses anyone. A run that went over quickUnder takes the pass
// away from its command until a run comes in under again and the middle is back under.
// On an exclusive resource it doesn't run alongside: it goes to the front of the line, unless
// the resource says quickAlongside: "other-repo" (a deploy is one at a time per project) and
// every job on it is from another repo.
export const QUICK_MAX = 2;   // quick jobs at once, machine-wide: a lane, not a way around dibs
// What the board says about a job the quick lane let in, so others see why it went first.
export const QUICK_LINE = 'quick: it runs in seconds, so it went first';
const QUICK_FRONT = 24 * 36e5;
export function quickPass(q, hist, cfg) {
  if (q.kind === 'hold' || !q.key || cfg.quickUnder === null) return false;
  const under = ms(cfg.quickUnder ?? '15s');
  const runs = runsOf(hist, q.key);
  if (runs.length && runs.at(-1).dur >= under) return false;
  const d = typical(hist, q.key);
  if (d != null) return d < under;
  // An --est that short counts as --quick, as for featherweight, unless the job asked for memory itself.
  return !!q.quick || (q.est != null && q.est < under && !q.declared);
}
// Every job on r is another repo's, so a quick one may start beside them (quickAlongside).
const otherRepos = (s, me, r) => !!me.repo && s.leases.filter(l => l.res.includes(r)).every(l => l.repo && l.repo !== me.repo);
// A hold on r by someone else: the quick lane never goes past it.
const heldByOther = (s, mine, r) => !mine.has(r) && s.leases.some(l => l.kind === 'hold' && l.res.includes(r));

// Can this waiter start now? If not: the rule that stops it (slot, ahead,
// reset, disk, pressure, swap, swaproom, drain, memory, cpu, ram, load, idle), a sentence, and what it's stuck on.
//
// Earlier waiters go first, with one exception (backfill): you may take a free
// slot ahead of someone who can't start yet anyway, if you'll be done before
// they could have started.
// What a job's own runs show it eats of the free disk: the middle of its last
// successful runs of the same command, or null until there are DISK_RUNS. Unlike
// typicalDisk, never borrowed from other commands on the resource: this one holds
// back even a job alone, or on a resource that declares no disk.
function ownDisk(hist, key) {
  const d = runsOf(hist || [], key).filter(h => h.ate != null && !h.failed).slice(-10).map(h => h.ate);
  return d.length >= DISK_RUNS ? mid(d) : null;
}

// The free disk a job needs to start, as the verdict will want it at its turn:
// { need, ate }, ate being what it usually eats (null when unknown or --disk says).
// A --disk given in so many words is the job's own: on 2026-10-26 a streaming loader that writes one
// 12 MB chunk was held for 23 GB it had "eaten" on a run whose swap grew while it sat paused.
export function diskNeed(s, me, cfg, hist) {
  const floor = floorFor(me, cfg);
  // A job that writes next to nothing keeps only ALONE_ROOM free, under the floor (tinyDisk).
  if (tinyDisk(me, hist, cfg)) return { need: (me.diskDeclared ? me.disk || 0 : 0) + ALONE_ROOM, ate: null, others: othersOf(s, me).length > 0, tiny: true };
  // With others running, a resource that declares disk (simulators, builds, browsers, heavy) also
  // counts what its kind of job usually eats. Alone, or on a resource that declares none, the
  // job's own runs still count: starting a job that always eats more than there is only fails it.
  // Alone, nothing else needs the floor while it runs, so it needs what it eats and ALONE_ROOM on top.
  const others = othersOf(s, me).length > 0;
  if (me.diskDeclared) return { need: Math.max(me.disk || 0, floor), ate: null, others };
  // What a resource declares is a guess made before any run. Once runs of this command, or of
  // its resource, show what they really eat, that wins: the simulator declares 8 GB, its 58 runs
  // here ate 0.17 GB at the middle and 1.6 GB at most, and on 2026-11-03 a hold on it was
  // refused with 7 GB free.
  const learned = (me.disk || 0) > 0 ? typicalDisk(hist, me.key) : null;
  const ate = (others ? learned : null) ?? ownDisk(hist, me.key);
  return { need: Math.max(learned ?? me.disk ?? 0, floor, ate != null ? ate + (others ? floor : ALONE_ROOM) : 0), ate, others };
}
// A job alone still leaves this much free past what it eats: the system writes while it runs too.
export const ALONE_ROOM = 1024 ** 3;

// A job the person is waiting on (high, urgent, or a --by deadline) may take the headroom
// down to this, the same hard floor the watcher pauses jobs at (src/preempt.mjs DISK_FLOOR),
// and isn't held for the room kept for swap. On 2026-11-02 and 03 a Shop ship
// (#18328) waited about a day while idle sessions' swap kept free disk under 9 GB.
const HARD_FLOOR = 3 * 1024 ** 3;
export const waitedOn = q => q.prio === 'high' || q.prio === 'urgent' || q.by != null;
const floorFor = (q, cfg) => (waitedOn(q) ? Math.min(bytes(cfg.minDisk), HARD_FLOOR) : bytes(cfg.minDisk));

// A job that eats less than this of the disk starts under minDisk: holding it back
// frees nothing. On 2026-11-02 and 03 a post-deploy check that only makes HTTP calls,
// a test suite that writes nothing (--disk 200M) and a later job that uploads a 100 MB
// archive were all refused (exit 74) with 4.4 to 5 GB free, and a prod build went out unchecked.
export const TINY_DISK = 100 * 1024 ** 2;
// Whether a job is that small. Its own runs say first: the middle of its last ten good
// runs (the most of them until there are DISK_RUNS) under TINY_DISK, and the last run,
// failed or not, under it too: one that ate more takes the exemption away until it's
// back down. A failed run alone, stopped early, says nothing about what a whole one eats.
// With no good runs, its resources say: one that declares a disk need (simulators,
// builds, browsers, heavy) is big, the rest (tests, deploys, locks) small, and an
// honest --disk on those is taken at its word (diskNeed).
export function tinyDisk(me, hist, cfg) {
  // A --disk of minDisk or more says it isn't small, whatever its resource.
  if (me.diskDeclared && (me.disk || 0) >= bytes(cfg.minDisk)) return false;
  const runs = runsOf(hist || [], me.key).filter(h => h.ate != null).slice(-10);
  if (runs.length && runs.at(-1).ate >= TINY_DISK) return false;
  const good = runs.filter(h => !h.failed).map(h => h.ate);
  if (good.length) return (good.length < DISK_RUNS ? Math.max(...good) : mid(good)) < TINY_DISK;
  return me.res.every(r => isFiles(r) || !resCfg(cfg, r).disk);
}

// The verdict, and for a job held by something else (its turn, memory, cores) a
// word that free disk will hold it next, while there's still time to free some.
// On 2026-11-02 a job waited over 10 hours on memory, then failed for disk the
// moment it started.
export function verdict(s, me, cfg, hist, t = now()) {
  const v = decide(s, me, cfg, hist, t);
  if (v.ok || v.disk || v.machine) return v;
  const m = machine();
  const { need } = diskNeed(s, me, cfg, hist);
  if (m.diskFree != null && m.diskFree < need) v.diskNext = { free: m.diskFree, need };
  return v;
}

function decide(s, me, cfg, hist, t) {
  // In the quick lane while there's room in it; the cap counts quick jobs running now.
  const quick = !!(me.quickPass ?? quickPass(me, hist, cfg)) && s.leases.filter(l => l.quick).length < QUICK_MAX;
  // A quick job dibs hasn't seen use much memory is booked small, as a featherweight is.
  const lightQuick = quick && !me.declared && runsOf(hist, me.key).slice(-10).every(h => h.mem == null || h.mem <= LIGHT_MEM);
  if ((me.mem || 0) > LIGHT_MEM && (featherweight(me, hist) || lightQuick || measuredLight(me, hist))) me = { ...me, mem: LIGHT_MEM, feather: true };
  const myRank = rank(me, hist, t);
  // When it would be done, at its slow runs: passing a waiter is a promise not to delay it.
  const myEnd = t + Math.max(expected(me, hist), slow(hist, me.key) || 0);
  const mine = holdsOf(s, me);
  const m = machine();
  const hot = overLoad(s, cfg, m);
  // The instant lane passes the load ceiling too: a job of a few seconds barely shows in a
  // 1-minute load average. On 2026-10-21 a 1-second vitest run waited 99 s at load 42.
  // A small job on an exclusive resource (a deploy, someone's lock) uses little CPU and
  // writes next to nothing: the load ceiling, the room kept for swap and a falling disk
  // don't hold it (over minDisk, it goes). On 2026-10-21 0.5 GB deploys waited 79 and 92 s
  // on the room kept for swap, and one waited 9 minutes on load.
  const lightTurn = (me.mem || 0) <= LIGHT_MEM && me.res.every(r => cfg.resources[r]?.exclusive);
  const pastCeiling = pastsCeiling(me) || quick || lightTurn;
  // Over the ceiling, a waiter that passes it doesn't wait behind ones the ceiling holds back.
  // Nor behind a place nobody is deciding for (its dibs stopped looking), or one the owner stopped:
  // neither can start, so neither holds anyone back. Just after the machine wakes (graceUntil,
  // src/state.mjs) every place is old, so none is taken for one nobody decides for.
  const ahead = s.queue
    .filter(q => q.pid && q.id !== me.id && !q.ownerStop && !(unpolled(q, t) && !(s.graceUntil > t)) && !(hot && pastCeiling && !pastsCeiling(q)))
    .filter(q => { const r = rank(q, hist, t); return r < myRank || (r === myRank && q.id < me.id); })
    .filter(q => reservesFor(s, q, me, cfg))
    .sort(byRank(hist, t));
  // A waiter ahead that needs more free disk than there is can't start, so it
  // doesn't hold back one that leaves minDisk free after its own declared disk:
  // on 2026-10-15 a heavy job needing 10 GB, with 4 to 6 GB free, held the
  // whole heavy line. It keeps its place, and once the disk has room for it,
  // it's ahead of everyone again. A job that would eat into that room waits.
  const floor = bytes(cfg.minDisk);
  const diskStuck = q => m.diskFree != null && m.diskFree < (tinyDisk(q, hist, cfg) ? (q.diskDeclared ? q.disk || 0 : 0) + ALONE_ROOM : Math.max(q.disk || 0, floor));
  const leavesRoom = m.diskFree != null && m.diskFree - floor >= (me.disk || 0);
  const blocks = q => {
    if (leavesRoom && diskStuck(q)) return false;
    // A waiter held for memory blocks a job of known length only when its own start is known, and comes first.
    if (known(me, hist) && overBudget(s, q, cfg) && !budgetSure(s, q, cfg, hist, t)) return false;
    const at = soonestStart(s, q, cfg, hist, t);
    if (q.mem >= BIG_SHARE * bytes(cfg.budget) && at - t > RESERVE_SOON) return false;
    return at < myEnd;
  };
  const side = [];
  for (const r of me.res) {
    if (mine.has(r)) continue;
    if (isFiles(r)) {
      const f = filesBlock(s, me, r, ahead.filter(blocks));
      if (f) return f;
      continue;
    }
    // A resource's own config: a name dibs doesn't know takes cfg.unknown's exclusive, which resCfg mixes into every one.
    const own = cfg.resources[r];
    if (quick && own && !heldByOther(s, mine, r) && (!own.exclusive || (own.quickAlongside === 'other-repo' && otherRepos(s, me, r)))) continue;
    const { open, across } = roomFor(s, me, r, cfg);
    if (open <= 0) {
      // Full, but the machine may have room for one more on top (src/overlap.mjs).
      const a = alongside(s, me, r, cfg, hist, t, ahead);
      if (a?.ok) { side.push(a); continue; }
      const why = !byRepo(cfg, r) ? `${r} is in use` : across ? `${r} is in use by ${resCfg(cfg, r).across} projects at once, the most at a time` : `${r} is in use for this project`;
      return { ok: false, rule: 'slot', why, on: r, ...(a && { alongside: a.why }) };
    }
    // Waiters ahead that will start before you'd finish take the open slots first; on a
    // per-project resource, only this project's (the cap across projects is room enough for the rest).
    const before = ahead.filter(q => q.res.includes(r) && blocks(q) && (!byRepo(cfg, r) || laneOf(q) === laneOf(me)));
    if (before.length >= open) return { ok: false, rule: 'ahead', why: `${tag(before[0])} is ahead of you for ${r}`, on: r, ahead: before[0] };
  }
  // Learned clashes: a job that runs SLOW_PAIR times as slow beside one running now, or
  // makes it that slow, waits for it, but no longer than its own run time since it
  // joined, so it can't starve. Both finish sooner one after the other.
  const pair = !quick && t - me.enq < expected(me, hist) && clashOf(s, me, hist);
  if (pair) return { ok: false, rule: 'together', why: pair.why, on: pair.res, ahead: pair.lease };
  // The last user's onRelease is still putting it back (src/reset.mjs).
  const reset = (s.resets || []).find(x => me.res.includes(x.res) && !mine.has(x.res));
  if (reset) return { ok: false, rule: 'reset', why: `${reset.res} is being reset after ${reset.agent || reset.who}'s turn (onRelease, at most ${dur(reset.timeout)})`, on: reset.res };
  // Holding paths runs nothing, so the machine's budgets and load don't apply.
  if (me.res.every(isFiles)) return { ok: true, covered: me.res.filter(r => mine.has(r)) };
  // A run inside your own hold already has the memory, cores and disk the hold got at its
  // grant: charging them again would queue it behind jobs that need what it already has, and
  // checking the disk again refused (exit 74) a run right after "you already have the
  // simulator, so you go ahead" (2026-11-03). The watcher's low-disk pauses still hold it.
  if (me.res.every(r => mine.has(r))) return { ok: true, covered: [...me.res] };
  // Below minDisk nothing else starts, urgent work included, but a job that writes next to
  // nothing (tinyDisk): a full disk breaks every job on the machine, and on macOS swap needs it too.
  const others = othersOf(s, me);
  // The floor plus what it usually eats (diskNeed).
  const { need: needDisk, ate, others: crowded, tiny } = diskNeed(s, me, cfg, hist);
  // An unreadable disk (null) doesn't stop work; the board and dibs run say it's unknown.
  if (m.diskFree != null && m.diskFree < needDisk)
    return { ok: false, rule: 'disk', why: `disk: ${gb(m.diskFree)} free, you need ${gb(needDisk)}${tiny ? (me.diskDeclared ? ` (the ${gb(me.disk || 0)} its --disk says, and ${gb(ALONE_ROOM)} kept free)` : ` (a job that writes next to nothing still leaves ${gb(ALONE_ROOM)} free)`) : ate != null && ate + (crowded ? floorFor(me, cfg) : ALONE_ROOM) >= needDisk ? ` (${crowded ? `the ${gb(floorFor(me, cfg))} dibs keeps free` : `${gb(ALONE_ROOM)} to spare`}, plus the ${gb(ate)} this usually takes; --disk <size> says this run needs less)` : ''}`, disk: true, free: m.diskFree, need: needDisk, ...(ate != null && { usual: ate }) };
  // While the machine swaps, only urgent work starts on top of what's running.
  // With nothing else working, one job may start: waiting can't make the swap
  // go down then, and swap the OS hasn't reclaimed yet mustn't stop dibs for good.
  const busy = others.some(working);
  // A job this small (a deploy, a lint, a quick script) can't make the paging
  // worse, so only critical pressure holds it. On 2026-10-19 a 0.5 GB deploy
  // waited on swap while the person waited on it, and its agent went around dibs.
  const light = (me.mem || 0) <= LIGHT_MEM;
  let sw = (me.prio || 'normal') !== 'urgent' && busy && swapping(cfg, m);
  let trial = false;
  if (sw && sw.level !== 'critical' && !light && sw.rule === 'pressure' && probation(s, me, cfg, hist, t)) trial = true;
  if (sw && (light || trial || quick) && sw.level !== 'critical') sw = null;
  // The same for the disk swap grows on: one job may still start alone, since waiting frees nothing then.
  // Swap grows with memory, not with what a job writes, so a job let under the floor (tinyDisk) keeps the room past the floor.
  // A light job can't grow the swap, so on a resource that writes little (exclusive, or declaring
  // no disk: tests, deploys) only the floor holds it. On 2026-10-26 every start waited on the room
  // kept for swap with 6.8 GB free, one-second test runs included.
  const writesLittle = me.res.every(r => cfg.resources[r]?.exclusive || !resCfg(cfg, r).disk);
  const squeeze = !waitedOn(me) && busy && !sw && !quick && !(light && writesLittle) && diskSqueeze(cfg, tiny ? Math.max(needDisk, bytes(cfg.minDisk)) : needDisk, m);
  let breaker = (sw || squeeze) && breaksStall(s, me, cfg, hist, t, m);
  if (sw && !breaker) return { ok: false, why: swapWhy(sw), ...sw, machine: true };
  if (squeeze && !breaker) return { ok: false, ...squeeze, machine: true };
  // A light job may pass one stuck on the budget, but not once that one has
  // waited long, unless it'll be done before that one could start. Waiters
  // stuck on something else (machine memory, disk) don't hold anyone up.
  const head = ahead.find(q => q.res.every(r => roomFor(s, q, r, cfg).open > 0) && !neverFits(cfg, q) && overBudget(s, q, cfg));
  if (!quick && head && t - head.enq > ms(cfg.starveAfter) && blocks(head))
    return { ok: false, rule: 'ahead', why: `${tag(head)} has waited ${dur(t - head.enq)}, so it goes first`, ahead: head, starved: true };
  let budget = overBudget(s, me, cfg, side.length > 0, breaker, t);
  // Nothing starts past the memory budget (0.0.125). Jobs book what they're
  // measured using once they've run a few minutes (memOf), so the gap between
  // asks and use goes to waiters that way, with the machine's pressure as the guard.
  // Held only by swap growth, the budget is a machine gate like swap itself: the stall breaker may pass it.
  const swapOnly = budget?.swap && !overBudget(s, me, cfg, side.length > 0, true);
  if (swapOnly && breaksStall(s, me, cfg, hist, t, m)) { budget = null; breaker = true; }
  // A quick job booked as a featherweight is done before the budget it would pass means
  // anything; the machine's own pressure still holds it at critical. On 2026-11-03 a
  // test whose last run took 14.9 s at 95 MB waited 29 minutes on the budget, then ran in 0.8 s (#18336).
  if (budget && quick && me.feather) budget = null;
  if (budget) return { ok: false, ...budget, ...(swapOnly && { machine: true }) };
  if (me.mem >= BIG_JOB && m.memFree < cfg.minFreeMem && s.leases.some(working) && !breaker)
    return { ok: false, rule: 'ram', why: `machine memory: ${m.memFree}% free, big jobs need ${cfg.minFreeMem}%` };
  // Stopped last time for using far more than it booked (src/preempt.mjs diskRequeue):
  // it starts again only once what it's now booked at is really free and swap
  // has stopped growing, or it would land in the same crunch.
  if (me.requeued === 'over' && ((realFree(m) ?? 0) < me.mem || swapGrowing(m)))
    return { ok: false, rule: 'oversize', machine: true, why: `${gb(me.mem)} of memory to be really free and swap to hold still, since it used far more than it booked last time`
      + ` (now ${gb(realFree(m) ?? 0)} free${swapGrowing(m) ? ', swap growing' : ''})` };
  const pool = poolBlock(s, me, cfg, mine, m);
  if (pool) return { ok: false, ...pool };
  // Squeezing in (src/overlap.mjs) may take the load past the ceiling, but never starts once it's already there.
  // since: when the ceiling started holding it (acquire.mjs decide), or now on its first poll.
  const since = me.loadSince ?? t;
  const loadPast = hot && !pastCeiling && t - since >= LOAD_STARVE && loadShare(s, me);
  if (hot && !pastCeiling && !loadPast) return { ok: false, rule: 'load', why: loadWhy(hot, cfg), load: hot.load + hot.ahead, since, by: since + LOAD_STARVE };
  if (me.prio === 'idle') {
    const busy = s.queue.find(q => q.pid && q.id !== me.id && q.prio !== 'idle');
    if (busy) return { ok: false, rule: 'idle', why: `idle work waits while anyone else is waiting (${tag(busy)})`, ahead: busy };
  }
  if ((me.prio || 'normal') === 'idle') {
    if (m.memFree < IDLE_MEM_FREE) return { ok: false, rule: 'idle', why: `idle work waits for ${IDLE_MEM_FREE}% memory free (now ${m.memFree}%)` };
  }
  return { ok: true, covered: me.res.filter(r => mine.has(r)), ...(quick && { quick: true }), ...(trial && { trial: true }), ...(side.length && { alongside: merge(side) }), ...(breaker && { breaker: true }), ...(loadPast && { loadPast: true, loadWaited: t - since }),
    ...(!breaker && (me.prio || 'normal') !== 'urgent' && { gated: true }) };
}

// When each waiter should start: hand every slot of its resources to the
// requests ahead of it in rank order, using their typical run times. Pass
// `extra` to ask where a request would land without adding it.
//
// Each start also says whether it's sure: every job it waits on has a run time
// from history or --est (a hold's end is only its longest). When it isn't,
// `after` is the lease or waiter whose unknown end it waits on.
export function forecastDetail(s, cfg, hist, t = now(), extra = null) {
  const free = {};
  const open = () => ({ at: t, sure: true, after: null });
  // A per-project resource's slots are kept per project (byRepo): the cap across projects isn't forecast.
  const slotsFor = (r, q) => {
    const lane = byRepo(cfg, r) ? laneOf(q) : null;
    const k = lane == null ? r : `${r}\0${lane}`;
    if (!free[k]) {
      // A file lease waits on any lease of an overlapping path, not just the same name.
      const busy = s.leases.filter(l => l.res.some(x => clash(x, r)) && !coveredNow(s, l, r) && !lent(l, r) && !onTop(l, r) && (lane == null || laneOf(l) === lane))
        .map(l => ({ at: slotEnd(s, l, hist, t, r), sure: l.kind !== 'hold' && remaining(l, hist, t) != null, after: l }));
      const n = Math.max(resCfg(cfg, r).slots - busy.length, 0);
      free[k] = [...busy, ...Array.from({ length: n }, open)].sort((a, b) => a.at - b.at);
    }
    return free[k];
  };
  const out = new Map();
  const line = (extra ? [...s.queue, extra] : [...s.queue]).filter(q => q.pid || q === extra);
  for (const q of line.sort(byRank(hist, t))) {
    const firsts = q.res.map(r => slotsFor(r, q)[0] ?? open());
    const startAt = Math.max(t, ...firsts.map(f => f.at));
    const unsure = firsts.find(f => f.at > t && !f.sure);
    const end = { at: startAt + expected(q, hist), sure: !unsure && known(q, hist), after: q };
    for (const r of q.res) { const sl = slotsFor(r, q); sl.shift(); sl.push({ ...end }); sl.sort((a, b) => a.at - b.at); }
    out.set(q.id, { at: startAt, sure: !unsure, after: unsure?.after || null });
  }
  return out;
}

export const forecast = (s, cfg, hist, t = now(), extra = null) =>
  new Map([...forecastDetail(s, cfg, hist, t, extra)].map(([id, f]) => [id, f.at]));
