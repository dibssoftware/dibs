// The machine's own gates on every start: free disk, swap, the memory budget
// counted at what jobs really use, and the load ceiling. No path past a full
// slot (overlap, squeeze, the roomy rule) gets around them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board, flat } from './helpers.mjs';
import { DEFAULT_CONFIG, swapGrowth, trends, SWAP_WINDOW, HOME } from '../src/config.mjs';
import { verdict, memUsed } from '../src/schedule.mjs';
import { pressureVictim } from '../src/overlap.mjs';
import { boardOf, boardLines } from '../src/board.mjs';
import { noticesIn } from '../src/notices.mjs';
import { plainBoard, whyLines } from '../src/plain.mjs';

const WIN = process.platform === 'win32';
const T = Date.now();
// The defaults with the budget at 11G, like the 16 GB Mac this was seen on.
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, budget: '11G', cores: 10, resources: { ...DEFAULT_CONFIG.resources, t: { slots: 1, mem: '2G', cpu: 2, pausable: true } }, ...o });
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['test'], who: `l${n}`, mem: 2 * G, cpu: 2, start: T - 120e3, pid: 1, key: 'k', ...o });
const waiter = o => ({ id: ++n, res: ['test'], who: 'me', mem: 2 * G, cpu: 2, disk: 0, pid: 1, enq: T, key: 'test|npm test', kind: 'run', ...o });
// A Mac whose OS reports most memory free with nothing on its cores: roomy by the old reading.
// swapGrowth and diskDrain 0 unless a test says, so in-process tests never read or write the readings file.
const ROOMY = { memTotal: 16 * G, memFree: 67, load: 0, cores: 10, swapGrowth: 0, diskDrain: 0 };
function judge(s, me, c, m = {}, hist = []) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...ROOMY, ...m });
  try { return verdict(s, me, c, hist, T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}

test('a machine whose swap is growing past maxSwap starts nothing more below urgent, however much memory the OS says is free', () => {
  const me = waiter();
  const s = { leases: [lease()], queue: [me] };
  const growing = { swapUsed: 6 * G, swapGrowth: 1.2 * G };
  const v = judge(s, me, cfg(), growing);
  assert.equal(v.rule, 'swap');
  assert.match(v.why, /swap grew 1\.2G in 5 min, 6\.0G in use \(over maxSwap 4\.0G\)/);
  assert.equal(judge(s, waiter({ prio: 'high', purpose: 'x' }), cfg(), growing).rule, 'swap', 'high waits too');
  assert.equal(judge(s, waiter({ prio: 'urgent', purpose: 'x' }), cfg(), growing).ok, true, 'urgent still starts');
  assert.equal(judge(s, me, cfg(), { swapUsed: 3 * G, swapGrowth: 1.2 * G }).ok, true, 'growing, but under maxSwap');
  assert.equal(judge(s, me, cfg(), { swapUsed: 6 * G, swapGrowth: 0.4 * G }).ok, true, 'over maxSwap, growing under 512 MB');
  assert.equal(judge(s, me, cfg({ maxSwap: null }), growing).ok, true, 'maxSwap null: no limit');
  // With nothing else out, waiting can't bring swap down, so one job starts.
  assert.equal(judge({ leases: [], queue: [me] }, me, cfg(), growing).ok, true);
});

test('swap left over from an earlier crunch, with memory pressure normal and no growth, holds nothing back', () => {
  // The machine on 2026-10-14: 5.05 GB of swap still allocated, pressure normal, 69% free.
  const me = waiter();
  const s = { leases: [lease()], queue: [me] };
  assert.equal(judge(s, me, cfg(), { swapUsed: 5.05 * G, swapGrowth: 0, vmPressure: 0, memFree: 69 }).ok, true);
});

test('memory pressure at warning or critical holds new work below urgent while anything else runs', () => {
  const me = waiter();
  const s = { leases: [lease()], queue: [me] };
  const v = judge(s, me, cfg(), { vmPressure: 1 });
  assert.equal(v.rule, 'pressure');
  assert.match(v.why, /memory pressure is high \(the OS says warning\)/);
  assert.equal(judge(s, me, cfg({ maxSwap: null }), { vmPressure: 2 }).rule, 'pressure', 'critical, whatever maxSwap says');
  assert.equal(judge(s, waiter({ prio: 'urgent', purpose: 'x' }), cfg(), { vmPressure: 2 }).ok, true, 'urgent still starts');
  assert.equal(judge({ leases: [], queue: [me] }, me, cfg(), { vmPressure: 2 }).ok, true, 'nothing else running: one starts');
  assert.equal(judge(s, me, cfg(), { vmPressure: 0 }).ok, true);
});

test('a job of 0.5 GB or less (a deploy) starts through growing swap and warning pressure, but not critical', () => {
  const s = { leases: [lease()], queue: [] };
  const light = waiter({ res: ['deploy'], mem: 0.5 * G, cpu: 1 });
  s.queue.push(light);
  assert.equal(judge(s, light, cfg(), { vmPressure: 1 }).ok, true, 'warning: a deploy goes');
  assert.equal(judge(s, light, cfg(), { swapUsed: 6 * G, swapGrowth: 1.2 * G }).ok, true, 'swap growing: a deploy goes');
  assert.equal(judge(s, light, cfg(), { vmPressure: 2 }).rule, 'pressure', 'critical holds even a deploy');
  const heavy = waiter({ mem: 0.6 * G });
  assert.equal(judge({ leases: [lease()], queue: [heavy] }, heavy, cfg(), { vmPressure: 1 }).rule, 'pressure', 'just over 0.5 GB waits');
});

test('a job over in seconds that never used much memory starts through warning pressure and growing swap, but not critical', () => {
  // 2026-10-23: a 70 ms node --test of one file waited minutes on "memory pressure high".
  const key = 'test|node --test / test/join.test.mjs';
  const quick = [1, 2, 3].map(i => ({ key, dur: 300 + i, at: T - i * 1e3 }));
  const me = waiter({ key });
  const s = { leases: [lease()], queue: [me] };
  assert.equal(judge(s, me, cfg(), { vmPressure: 1 }, quick).ok, true, 'warning: it goes');
  assert.equal(judge(s, me, cfg(), { swapUsed: 6 * G, swapGrowth: 1.2 * G }, quick).ok, true, 'swap growing: it goes');
  assert.equal(judge(s, me, cfg(), { vmPressure: 2 }, quick).rule, 'pressure', 'critical holds it');
  assert.equal(judge(s, me, cfg(), { vmPressure: 1, diskFree: 0.5 * G }, quick).rule, 'disk', 'the 1 GB a test run keeps free holds it');
  // Never seen: a short --est stands in, unless it asked for memory itself.
  assert.equal(judge(s, waiter({ key: 'test|new', est: 10e3 }), cfg(), { vmPressure: 1 }).ok, true, 'an --est of 10s goes');
  assert.equal(judge(s, waiter({ key: 'test|new', est: 10e3, declared: true }), cfg(), { vmPressure: 1 }).rule, 'pressure', 'with --mem it waits');
  // Seen using real memory, or taking longer: the usual rules.
  const fat = [...quick, { key, dur: 400, mem: 1.5 * G, at: T }];
  // Over in under a second, it's in the quick lane (src/schedule.mjs quickPass), which goes through warning pressure whatever it uses; it waits only once the lane is off.
  assert.equal(judge(s, me, cfg({ quickUnder: null }), { vmPressure: 1 }, fat).rule, 'pressure', 'once measured at 1.5 GB it waits');
  const slowRuns = [1, 2, 3].map(i => ({ key, dur: 40e3, at: T - i * 1e3 }));
  assert.equal(judge(s, me, cfg(), { vmPressure: 1 }, slowRuns).rule, 'pressure', 'a 40 s job waits');
});

test('a first run that has waited 30s starts on probation through warning pressure, one at a time, and pauses first', () => {
  // 2026-10-24: 13 of 17 short jobs held on memory pressure were commands dibs had never seen.
  const me = waiter({ key: 'test|node site-token.test.js', enq: T - 31e3 });
  const s = { leases: [lease()], queue: [me] };
  const v = judge(s, me, cfg(), { vmPressure: 1 });
  assert.equal(v.ok, true, 'warning: it goes');
  assert.equal(v.trial, true);
  assert.equal(judge(s, { ...me, enq: T - 5e3 }, cfg(), { vmPressure: 1 }).rule, 'pressure', 'under 30s in line it waits');
  assert.equal(judge(s, me, cfg(), { vmPressure: 2 }).rule, 'pressure', 'critical holds it');
  assert.equal(judge(s, me, cfg(), { swapUsed: 6 * G, swapGrowth: 1.2 * G }).rule, 'swap', 'growing swap holds it');
  assert.equal(judge({ leases: [lease({ mem: 10 * G })], queue: [me] }, me, cfg(), { vmPressure: 1 }).rule, 'memory', 'the memory budget holds it');
  assert.equal(judge(s, { ...me, declared: true }, cfg(), { vmPressure: 1 }).rule, 'pressure', 'with --mem it waits');
  const seen = [{ key: me.key, dur: 40e3, at: T - 1e3 }];
  assert.equal(judge(s, me, cfg(), { vmPressure: 1 }, seen).rule, 'pressure', 'once seen, its runs decide');
  assert.equal(judge(s, { ...me, res: ['xcode-build'] }, cfg(), { vmPressure: 1 }).ok, false, 'not on a resource that never pauses');
  const busy = { leases: [lease(), lease({ trial: true })], queue: [me] };
  assert.equal(judge(busy, me, cfg(), { vmPressure: 1 }).rule, 'pressure', 'one at a time');
  // The watcher's first pick under pressure: the probation run, newest first.
  const t = lease({ trial: true, pgid: 9, start: T - 1e3 });
  assert.equal(pressureVictim({ leases: [lease({ pgid: 8 }), t] }, cfg())?.id, t.id);
});

test('swap growth comes from readings kept in DIBS_HOME, at most one every 30s, and a broken file means no growth', () => {
  const file = path.join(HOME, 'swap.json');
  const t = Date.now();
  try {
    fs.rmSync(file, { force: true });
    assert.equal(swapGrowth(5 * G, t), 0, 'no file: no growth');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1, 'and the first reading is kept');
    assert.equal(swapGrowth(5.5 * G, t + 10e3), 0.5 * G);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1, 'under 30s since the last reading: nothing written');
    assert.equal(swapGrowth(6.25 * G, t + 31e3), 1.25 * G);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 2);
    // Readings older than the window don't count.
    assert.equal(swapGrowth(6.25 * G, t + SWAP_WINDOW + 20e3), 0);
    fs.writeFileSync(file, '{not json');
    assert.equal(swapGrowth(6 * G, t), 0, 'unreadable: no growth, no throw');
    fs.writeFileSync(file, JSON.stringify({ at: 1 }));
    assert.equal(swapGrowth(6 * G, t), 0, 'not a list: no growth, no throw');
    assert.equal(swapGrowth(undefined, t), 0);
  } finally { fs.rmSync(file, { force: true }); }
});

test('the roomy rule never skips the memory budget once running jobs already have more than it', () => {
  // 12G handed out of an 11G budget, on a machine that reads 67% free and idle.
  const s = { leases: [lease({ mem: 6 * G }), lease({ mem: 6 * G })], queue: [] };
  const me = waiter();
  s.queue.push(me);
  const v = judge(s, me, cfg());
  assert.equal(v.rule, 'memory');
  assert.equal(v.used, 12 * G);
  // Nor under it: 10 + 2 is past 11, however roomy (0.0.125).
  const light = { leases: [lease({ mem: 10 * G })], queue: [me] };
  assert.equal(judge(light, me, cfg()).rule, 'memory');
});

test('the memory budget counts what running jobs were measured using, not only what they asked for', () => {
  // Asked for 2G each, measured at 5G each, process trees included.
  const s = { leases: [lease({ use: { mem: 5 * G, cpu: 1 } }), lease({ use: { mem: 5 * G, cpu: 1 } })], queue: [] };
  const me = waiter();
  s.queue.push(me);
  const v = judge(s, me, cfg({ roomyMemFree: 101 }));
  assert.equal(v.rule, 'memory');
  assert.equal(v.used, 10 * G);
  // Using less than it asked for gives memory back only while the machine shows the room: it may still grow to its number.
  const small = { leases: [lease({ mem: 10 * G, use: { mem: 1 * G, cpu: 1 } })], queue: [me] };
  assert.equal(judge(small, me, cfg({ roomyMemFree: 101 })).ok, true);
  assert.equal(judge(small, me, cfg({ roomyMemFree: 101 }), { memFree: 25 }).rule, 'memory');
});

test('a job on top of a full resource always faces the memory budget, roomy machine or not', () => {
  const c = cfg({ overlap: 'fit', budget: '3G' });
  const holder = lease({ res: ['t'] });
  const me = waiter({ res: ['t'], key: 't|npm test' });
  const hist = [{ key: 't|npm test', dur: 300e3, who: 'x', at: 0, fit: true, mem: 1 * G, cpu: 1 }];
  const v = judge({ leases: [holder], queue: [me] }, me, c, {}, hist);
  assert.equal(v.rule, 'memory');
  // With room in the budget it still runs alongside.
  const ok = judge({ leases: [holder], queue: [me] }, me, cfg({ overlap: 'fit' }), {}, hist);
  assert.equal(ok.ok, true);
  assert.equal(ok.alongside.kind, 'fit');
});

test('a job on top never starts while the machine swaps or is past its load ceiling', () => {
  const holder = lease({ res: ['t'] });
  const me = waiter({ res: ['t'], key: 't|npm test' });
  const s = { leases: [holder], queue: [me] };
  const hist = [{ key: 't|npm test', dur: 20e3, who: 'x', at: 0, fit: true, mem: 1 * G, cpu: 1 }];
  assert.equal(judge(s, me, cfg({ overlap: 'fit' }), { swapUsed: 13.5 * G, swapGrowth: 1.2 * G }, hist).rule, 'swap');
  assert.equal(judge(s, me, cfg({ overlap: 'fit' }), { vmPressure: 1 }, hist).rule, 'pressure');
  assert.equal(judge(s, me, cfg({ overlap: 'squeeze', maxLoad: 10 }), { load: 12 }, hist).rule, 'load');
});

// Until 2026-11-03 a run inside its own hold was refused (exit 74) right after "you already
// have the simulator, so you go ahead", for disk the hold had already been granted.
test('below minDisk nothing new starts, urgent work included; a run inside its own hold goes on what the hold got', () => {
  const hold = lease({ kind: 'hold', res: ['test'], pid: 77, spid: 77, expires: T + 6e5 });
  const me = waiter({ spid: 77 });
  const s = { leases: [hold], queue: [me] };
  assert.equal(judge(s, me, cfg(), { diskFree: 1 * G }).ok, true, 'inside its own hold');
  assert.equal(judge(s, waiter({ spid: 88, res: ['heavy'] }), cfg(), { diskFree: 1 * G }).rule, 'disk', 'anyone else waits');
  assert.equal(judge(s, waiter({ prio: 'urgent', purpose: 'x', res: ['heavy'] }), cfg(), { diskFree: 1 * G }).rule, 'disk', 'urgent too');
});

// 2026-11-03: dibs hold sim exited 74 with 7 GB free, on the 8 GB the simulator declares;
// its runs here eat 0.17 GB at the middle and 1.6 GB at most.
test('once runs show what a resource really eats of the disk, that beats the size it declares', () => {
  const me = waiter({ res: ['sim'], disk: 8 * G, key: 'sim|hold', kind: 'hold' });
  const s = { leases: [], queue: [me] };
  const hist = [0.2, 0.1, 1.6, 0.17].map((d, i) => ({ key: 'sim|xcrun simctl', dur: 6e4, who: 'x', at: T - i * 36e5, ate: d * G }));
  assert.equal(judge(s, me, cfg(), { diskFree: 7 * G }).rule, 'disk', 'no runs yet: the declared 8 GB');
  assert.equal(judge(s, me, cfg(), { diskFree: 7 * G }, hist).ok, true, 'its runs eat well under the 7 GB free');
  assert.equal(judge(s, me, cfg(), { diskFree: 4 * G }, hist).rule, 'disk', 'the minDisk floor still holds');
  assert.equal(judge(s, { ...me, disk: 8 * G, diskDeclared: true }, cfg(), { diskFree: 7 * G }, hist).rule, 'disk', 'its own --disk still wins');
});

test('while the machine swaps, new work below urgent keeps swapRoom of disk free on top of minDisk, for swap to grow into', () => {
  const me = waiter();
  const s = { leases: [lease()], queue: [me] };
  // The Mac on 2026-10-15: 8.4 GB of swap in use, 7 GB of disk free, over minDisk 5G. With
  // maxSwap off, so the swap gate itself doesn't fire first on swap this size and growing.
  const v = judge(s, me, cfg({ maxSwap: null }), { swapUsed: 8.4 * G, swapGrowth: 1 * G, diskFree: 7 * G });
  assert.equal(v.rule, 'swaproom');
  assert.equal(v.need, 8 * G);
  assert.match(v.why, /disk: 7\.0G free, and while the machine swaps \(8\.4G of swap\) dibs keeps 8\.0G free before starting anything new, so swap has room to grow \(swapRoom 3\.0G\)/);
  assert.equal(judge(s, me, cfg(), { swapUsed: 2 * G, swapGrowth: 1 * G, diskFree: 7 * G }).rule, 'swaproom', 'under maxSwap, but growing');
  assert.equal(judge(s, me, cfg(), { swapUsed: 2 * G, diskFree: 7 * G }).ok, true, 'a little swap, not growing: not swapping');
  assert.equal(judge(s, me, cfg(), { swapUsed: 8.4 * G, diskFree: 9 * G }).ok, true, 'room enough');
  assert.equal(judge(s, me, cfg({ swapRoom: null }), { swapUsed: 8.4 * G, diskFree: 7 * G }).ok, true, 'swapRoom null: off');
  assert.equal(judge(s, waiter({ prio: 'urgent', purpose: 'x' }), cfg(), { swapUsed: 8.4 * G, diskFree: 7 * G }).ok, true, 'urgent still starts');
  assert.equal(judge({ leases: [], queue: [me] }, me, cfg(), { swapUsed: 8.4 * G, diskFree: 7 * G }).ok, true, 'nothing else running: one starts');
  // A job that needs disk of its own keeps the room on top of that.
  assert.equal(judge(s, waiter({ res: ['heavy'], disk: 6 * G }), cfg({ maxSwap: null }), { swapUsed: 8.4 * G, swapGrowth: 1 * G, diskFree: 8.5 * G }).need, 9 * G);
});

test('holds with nothing running under them, file leases and paused jobs do not count as running for the swap, disk and memory gates', () => {
  const me = waiter();
  // The Mac on 2026-10-15: dozens of idle holds and paused jobs, and every new start held back behind them.
  const idle = lease({ kind: 'hold', res: ['playwright'], pid: 5, spid: 5, expires: T + 6e5 });
  const files = lease({ kind: 'hold', res: ['files:src/**'], pid: 6, spid: 6, mem: 1 * G, cpu: 1 });
  const paused = lease({ pausedAt: T - 6e4, pauses: [{ watcher: 1, disk: true }] });
  const s = { leases: [idle, files, paused], queue: [me] };
  for (const m of [{ swapUsed: 8.4 * G, diskFree: 7 * G }, { swapUsed: 6 * G, swapGrowth: 1.2 * G }, { vmPressure: 1 }, { diskFree: 7.4 * G, diskDrain: 5.2 * G }])
    assert.equal(judge(s, me, cfg(), m).ok, true, JSON.stringify(m));
  assert.equal(judge(s, waiter({ mem: 4 * G }), cfg(), { memFree: 5 }).ok, true, 'a big job and low free memory: the ram rule too');
  // A job that is really running still holds new work back.
  assert.equal(judge({ leases: [...s.leases, lease()], queue: [me] }, me, cfg(), { swapUsed: 2 * G, swapGrowth: 1 * G, diskFree: 7 * G }).rule, 'swaproom');
});

test('when the machine has held every waiter back for 10 minutes, the smallest and shortest starts, one at a time', () => {
  const MIN = 6e4;
  const swap = { swapUsed: 2 * G, swapGrowth: 1 * G, diskFree: 7 * G };
  const run = lease({ start: T - 30 * MIN, gated: true });
  // machineHeld: their last poll found the machine holding them back (acquire.mjs decide).
  const small = waiter({ who: 'small', mem: 1 * G, est: 60e3, enq: T - 11 * MIN, machineHeld: true });
  const slow = waiter({ who: 'slow', mem: 1 * G, est: 600e3, enq: T - 11 * MIN, machineHeld: true });
  const big = waiter({ who: 'big', mem: 4 * G, enq: T - 20 * MIN, machineHeld: true });
  const s = { leases: [run], queue: [big, slow, small] };
  const v = judge(s, small, cfg(), swap);
  assert.equal(v.ok, true, v.why);
  assert.equal(v.breaker, true);
  assert.equal(judge(s, big, cfg(), swap).rule, 'swaproom', 'only the smallest');
  assert.equal(judge(s, slow, cfg(), swap).ok, false, 'the same size: the shorter one');
  assert.equal(judge(s, small, cfg(), { swapUsed: 6 * G, swapGrowth: 1.2 * G }).breaker, true, 'held for swap growing');
  assert.equal(judge(s, small, cfg(), { vmPressure: 1 }).breaker, true, 'held for memory pressure at warning');
  assert.equal(judge(s, small, cfg(), { vmPressure: 2 }).rule, 'pressure', 'never under critical pressure');
  assert.equal(judge({ leases: [lease({ start: T - 5 * MIN, gated: true })], queue: [big, slow, small] }, small, cfg(), swap).rule, 'swaproom', 'something started 5 min ago');
  assert.equal(judge({ ...s, lastStart: T - 5 * MIN }, small, cfg(), swap).rule, 'swaproom', 'something started and ended 5 min ago');
  const fresh = waiter({ mem: 1 * G, enq: T - 5 * MIN });
  assert.equal(judge({ leases: [run], queue: [fresh] }, fresh, cfg(), swap).rule, 'swaproom', 'nobody has waited 10 min');
  // One at a time: the next waits until the first ends or its memory holds steady.
  const first = lease({ res: ['playwright'], breaker: true, start: T - 3 * MIN, use: { mem: 1 * G }, peakAt: T - 30e3 });
  assert.equal(judge({ leases: [run, first], queue: [big, slow, small] }, small, cfg(), swap).rule, 'swaproom', 'still growing');
  assert.equal(judge({ leases: [run, { ...first, peakAt: undefined, pgid: 4242, start: T - 30e3 }], queue: [big, slow, small] }, small, cfg(), swap).rule, 'swaproom', 'not measured yet');
  assert.equal(judge({ leases: [run, { ...first, peakAt: T - 3 * MIN }], queue: [big, slow, small] }, small, cfg(), swap).breaker, true, 'steady for 3 min');
  // The board says so in words.
  const b = boardLines(boardOf({ leases: [run, first], queue: [] }, cfg(), [], T)).join('\n');
  assert.match(b, /let in: nothing had started for 10 min/);
});

test('swap growing counts against the memory budget, so new work stops before swap climbs; the stall breaker still gets through', () => {
  const MIN = 6e4;
  const me = waiter();
  const s = { leases: [lease({ mem: 8 * G, start: T - 30 * MIN })], queue: [me] };
  // Under maxSwap (4G), so the swap gate itself doesn't fire: 8G handed out, 1.5G more paged out in 5 min.
  const v = judge(s, me, cfg(), { swapUsed: 2 * G, swapGrowth: 1.5 * G });
  assert.equal(v.rule, 'memory');
  assert.match(v.why, /memory budget: 9\.5G of 11G handed out or in use \(1\.5G of it swap that grew in the last 5 min\), you need 2\.0G/);
  assert.equal(judge(s, me, cfg(), { swapUsed: 2 * G, swapGrowth: 0 }).ok, true, 'swap holding still: nothing counted');
  // Held that way for 10 minutes, the smallest waiter still goes.
  const old = waiter({ enq: T - 11 * MIN });
  assert.equal(judge({ ...s, queue: [old] }, old, cfg(), { swapUsed: 2 * G, swapGrowth: 1.5 * G }).breaker, true);
  assert.equal(judge({ ...s, queue: [old] }, old, cfg(), { swapUsed: 6 * G, swapGrowth: 1.5 * G }).breaker, true, 'and past the swap gate too');
});

test('a measured run books what it uses now: an idle one only that, a busy one that plus a margin, not a peak it has left', () => {
  const MIN = 6e4;
  // 2026-10-15: two Playwright runs booked 12 of 11 GB while using 3 between them, one of them idle for 7 minutes.
  const idle = lease({ mem: 6 * G, use: { mem: 1 * G }, peak: { mem: 5.5 * G }, peakAt: Date.now() - 5 * MIN, idleSince: Date.now() - 7 * MIN });
  const busy = lease({ mem: 6 * G, use: { mem: 2 * G }, peak: { mem: 5 * G }, peakAt: Date.now() - 4 * MIN });
  assert.equal(memUsed({ leases: [idle], queue: [] }), 1 * G, 'idle: what it holds');
  assert.equal(memUsed({ leases: [busy], queue: [] }), 3 * G, 'busy: what it uses plus 1 GB');
  assert.equal(memUsed({ leases: [{ ...busy, peakAt: Date.now() - 30e3 }], queue: [] }), 6 * G, 'still climbing: what it was planned at');
  assert.equal(memUsed({ leases: [{ ...busy, use: undefined, peakAt: undefined }], queue: [] }), 6 * G, 'not measured yet: what it was planned at');
  assert.equal(memUsed({ leases: [{ ...busy, use: { mem: 7 * G } }], queue: [] }), 8 * G, 'over its plan: what it uses, plus the margin');
  const me = waiter({ res: ['deploy'], mem: 4 * G, prio: 'high', purpose: 'hotfix' });
  assert.equal(judge({ leases: [idle, busy], queue: [me] }, me, cfg(), { memFree: 60 }).ok, true, 'the high deploy starts: 9.6 GB is really free');
  assert.equal(judge({ leases: [idle, busy], queue: [me] }, me, cfg(), { memFree: 30 }).rule, 'memory', 'but not into asks the machine can\'t back: 4.8 GB free');
});

test("a waiter ahead that needs more disk than is free lets through only jobs that leave minDisk free, and still goes first once there's room", () => {
  // 2026-10-15: a heavy job needing 10 GB, with 4 to 6 GB free, held the whole heavy queue behind it.
  const big = waiter({ res: ['heavy'], disk: 10 * G, enq: T - 6e5, who: 'big' });
  const small = waiter({ res: ['heavy'], disk: 0, who: 'small' });
  const some = waiter({ res: ['heavy'], disk: 2 * G, who: 'some' });
  const s = { leases: [], queue: [big, small, some] };
  assert.equal(judge(s, big, cfg(), { diskFree: 6 * G }).rule, 'disk');
  assert.equal(judge(s, small, cfg(), { diskFree: 6 * G }).ok, true, 'needs no disk of its own: it passes');
  const v = judge(s, some, cfg(), { diskFree: 6 * G });
  assert.equal(v.rule, 'ahead', 'would take the disk big waits for: it stays behind');
  assert.equal(v.ahead.who, 'big');
  assert.equal(judge({ leases: [], queue: [big, some] }, some, cfg(), { diskFree: 8 * G }).ok, true, 'its 2 GB still leaves minDisk free: it passes');
  // Once the disk has room for big, it goes first and nobody passes it.
  assert.equal(judge(s, big, cfg(), { diskFree: 12 * G }).ok, true);
  assert.equal(judge(s, small, cfg(), { diskFree: 12 * G }).rule, 'ahead');
  assert.equal(judge(s, small, cfg(), { diskFree: 4 * G }).ok, false, 'under minDisk nobody starts');
});

test('swap over maxSwap that holds still, with memory pressure normal, is left over: only minDisk counts', () => {
  // 2026-10-15 21:40: 4.6 GB of swap, flat, over maxSwap 4G; 77% free, pressure normal, 6.4 GB of disk. Nothing started for 30 minutes.
  const me = waiter();
  const s = { leases: [lease()], queue: [me] };
  const stale = { swapUsed: 4.6 * G, swapGrowth: 0, vmPressure: 0, memFree: 77, diskFree: 6.4 * G };
  assert.equal(judge(s, me, cfg(), stale).ok, true, judge(s, me, cfg(), stale).why);
  assert.equal(judge(s, me, cfg(), { ...stale, swapGrowth: 1 * G }).rule, 'swap', 'still growing over maxSwap: the swap gate holds');
  assert.equal(judge(s, me, cfg(), { ...stale, swapUsed: 3 * G, swapGrowth: 1 * G }).rule, 'swaproom', 'growing under maxSwap: the room for it holds');
  assert.equal(judge(s, me, cfg(), { ...stale, vmPressure: 1 }).rule, 'pressure', 'pressure above normal holds');
  const quiet = [1, 2].map(i => ({ key: 'test|npm test', dur: 6e4, who: 'x', at: T - i * 36e5, ate: 0 }));
  assert.equal(judge(s, me, cfg(), { ...stale, diskFree: 4.5 * G }, quiet).ok, true, 'a test run whose runs write nothing: under minDisk it goes');
  assert.equal(judge(s, waiter({ res: ['heavy'] }), cfg(), { ...stale, diskFree: 4.5 * G }).rule, 'disk', 'and minDisk itself still holds the rest');
});

test("the stall breaker picks among waiters the machine holds back, not ones waiting their turn, and only gated starts reset its clock", () => {
  const MIN = 6e4;
  const swap = { swapUsed: 8.4 * G, swapGrowth: 1 * G, diskFree: 7 * G };
  const run = lease({ start: T - 30 * MIN, gated: true });
  // 2026-10-15: the breaker picked a 1 GB heavy job stuck behind another heavy job, which never reached the breaker, so nobody went.
  const first = waiter({ res: ['heavy'], mem: 3 * G, enq: T - 25 * MIN, machineHeld: true });
  const behind = waiter({ res: ['heavy'], mem: 1 * G, enq: T - 20 * MIN });
  const tests = waiter({ res: ['test'], mem: 2 * G, enq: T - 15 * MIN, machineHeld: true });
  const s = { leases: [run], queue: [first, behind, tests] };
  assert.equal(judge(s, behind, cfg(), swap).rule, 'ahead');
  const v = judge(s, tests, cfg(), swap);
  assert.equal(v.ok, true, v.why);
  assert.equal(v.breaker, true);
  // A run inside its own hold started a minute ago: it skipped the gates, so the stall goes on.
  const inside = lease({ res: ['playwright'], start: T - MIN, covered: ['playwright'] });
  assert.equal(judge({ ...s, leases: [run, inside] }, tests, cfg(), swap).breaker, true);
  assert.equal(judge({ ...s, leases: [run, { ...inside, gated: true }] }, tests, cfg(), swap).ok, false, 'a gated start a minute ago: not stalled');
  // A wait on the machine says so, for the breaker to find.
  assert.equal(judge(s, first, cfg(), { ...swap, diskFree: 7 * G }, []).machine, true);
});

test('an urgent deploy starts past swap and disk-for-swap when real memory and disk are fine, inside the memory budget', () => {
  // 9 GB booked, plus the 1 GB swap grew by in the first case, plus the deploy's half: inside 11.
  const booked = { leases: [lease({ mem: 6 * G }), lease({ mem: 3 * G, res: ['playwright'] })], queue: [] };
  const ship = waiter({ res: ['deploy'], mem: 0.5 * G, prio: 'urgent', purpose: 'data leak hotfix' });
  for (const m of [{ swapUsed: 8.4 * G, swapGrowth: 1 * G, diskFree: 7 * G, memFree: 77, vmPressure: 0 }, { swapUsed: 4.6 * G, swapGrowth: 0, diskFree: 6.4 * G, memFree: 77, vmPressure: 0 }])
    assert.equal(judge(booked, ship, cfg(), m).ok, true, JSON.stringify(m));
});

test('a job held only by the load ceiling for 20 minutes starts anyway, at background priority, within a fair share of the cores', () => {
  const MIN = 6e4;
  // 2026-10-18: alex-22's idle OCR job (heavy, 2 GB, 3 cores) waited 2h52m: maxLoad 5 on 10 cores, outside load 7.5 to 11.
  const c = cfg({ maxLoad: 5 });
  const hot = { load: 9 };
  const ocr = waiter({ res: ['heavy'], prio: 'idle', mem: 2 * G, cpu: 3, enq: T - 3 * 60 * MIN, loadSince: T - 21 * MIN });
  // A start a minute ago, so the 0.0.87 stall breaker stays out of it.
  const s = { leases: [lease()], queue: [ocr], lastStart: T - 6e4 };
  const v = judge(s, ocr, c, hot);
  assert.equal(v.ok, true, v.why);
  assert.equal(v.loadPast, true);
  // Under 20 minutes it waits, and says since when and until when at the latest.
  const held = judge(s, { ...ocr, loadSince: T - 5 * MIN }, c, hot);
  assert.equal(held.rule, 'load');
  assert.equal(held.since, T - 5 * MIN);
  assert.equal(held.by, T + 15 * MIN);
  assert.equal(judge(s, { ...ocr, loadSince: undefined }, c, hot).by, T + 20 * MIN, 'first poll: 20 minutes from now');
  // A fair share: 40% of 10 cores is 4, so a second 3-core job waits while one runs that way...
  const first = lease({ res: ['heavy'], cpu: 3, loadPast: true });
  assert.equal(judge({ leases: [lease(), first], queue: [ocr] }, { ...ocr, res: ['test'] }, c, hot).rule, 'load');
  // ...and one asking for more than the share still goes when it's alone.
  assert.equal(judge(s, { ...ocr, cpu: 6 }, c, hot).loadPast, true);
  // Memory, swap and disk still hold it.
  assert.equal(judge(s, ocr, c, { ...hot, swapUsed: 6 * G, swapGrowth: 1.2 * G }).rule, 'swap');
  assert.equal(judge(s, ocr, c, { ...hot, diskFree: 1 * G }).rule, 'disk');
  // Its agent hears once, through the hook, when it starts that way.
  const n = noticesIn({ leases: [{ ...lease({ res: ['heavy'], prio: 'idle', cmd: 'ocr.sh' }), loadPast: true, loadWaited: 21 * MIN }], queue: [] }, T);
  assert.equal(n.length, 1);
  assert.match(n[0][2], /waited 21 min for the machine's load to fall, so it started anyway at background priority on the efficiency cores/);
});

test('a load wait says since when, when it starts at the latest, and what the agent can do now', () => {
  const MIN = 6e4;
  const c = cfg({ maxLoad: 5 });
  const me = waiter({ res: ['heavy'], prio: 'idle', mem: 2 * G, cpu: 3, enq: T - 6 * MIN, loadSince: T - 5 * MIN });
  const s = { leases: [lease()], queue: [me] };
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...ROOMY, load: 9 });
  try {
    const p = plainBoard(s, c, [], T);
    const words = flat(whyLines(p, me, c).join('\n'));
    assert.match(words, /held by load since \d\d:\d\d( [AP]M)?, starts by \d\d:\d\d( [AP]M)? at the latest/i);
    assert.match(words, /--on <machine>/);
    assert.match(words, /-p high -m/);
    assert.doesNotMatch(words, /runs on its own once the load falls/);
    assert.match(boardLines(boardOf(s, c, [], T)).join('\n'), /held by load since \d\d:\d\d( [AP]M)?, starts by \d\d:\d\d( [AP]M)? at the latest/);
  } finally { process.env.DIBS_FAKE_MACHINE = was; }
});

test('free disk falling fast holds new work below urgent until it holds steady', () => {
  const me = waiter();
  const s = { leases: [lease()], queue: [me] };
  // 06:43 to 06:46 UTC on 2026-10-15: free disk fell from 12.6 to 7.4 GB with no swap reading past maxSwap yet.
  const v = judge(s, me, cfg(), { diskFree: 7.4 * G, diskDrain: 5.2 * G });
  assert.equal(v.rule, 'drain');
  assert.match(v.why, /free disk fell 5\.2G in 5 min to 7\.4G, and at that rate it's under 8\.0G within 10 min, so dibs starts nothing new until it holds steady/);
  assert.equal(judge(s, me, cfg(), { diskFree: 7.4 * G, diskDrain: 2 * G }).ok, true, 'a build writing 2 GB is no reason');
  assert.equal(judge(s, waiter({ prio: 'urgent', purpose: 'x' }), cfg(), { diskFree: 7.4 * G, diskDrain: 5.2 * G }).ok, true, 'urgent still starts');
  assert.equal(judge({ leases: [], queue: [me] }, me, cfg(), { diskFree: 7.4 * G, diskDrain: 5.2 * G }).ok, true, 'nothing else running: one starts');
});

test('how far free disk fell comes from the same readings file as swap growth', () => {
  const file = path.join(HOME, 'swap.json');
  const t = Date.now();
  try {
    fs.rmSync(file, { force: true });
    const none = { swapGrowth: 0, diskDrain: 0, drainMs: 0, swapRecent: 0, drainRecent: 0 };
    assert.deepEqual(trends(5 * G, 12 * G, t), none, 'no file: nothing');
    assert.deepEqual(trends(6 * G, 10 * G, t + 31e3), { swapGrowth: 1 * G, diskDrain: 2 * G, drainMs: 31e3, swapRecent: 1 * G, drainRecent: 2 * G });
    assert.deepEqual(trends(9 * G, 4 * G, t + 62e3), { swapGrowth: 4 * G, diskDrain: 8 * G, drainMs: 62e3, swapRecent: 4 * G, drainRecent: 8 * G }, 'from the highest free disk in the window, and since when');
    assert.equal(trends(9 * G, 4 * G, t + SWAP_WINDOW + 70e3).diskDrain, 0, 'older readings drop out');
    // A file written by an older dibs has no disk readings: no drain, no throw.
    fs.writeFileSync(file, JSON.stringify([{ at: t, used: 5 * G }]));
    assert.deepEqual(trends(6 * G, 4 * G, t + 1000), { swapGrowth: 1 * G, diskDrain: 0, drainMs: 0, swapRecent: 1 * G, drainRecent: 0 });
  } finally { fs.rmSync(file, { force: true }); }
});

test('the real CLI: short of disk for swap, the wait and the board say so in words', { skip: WIN }, async t => {
  const h = tmp(t), cwd = tmp(t, 'job');
  const swap = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, swapUsed: 2 * G, swapGrowth: 1 * G, diskFree: 7 * G, diskDrain: 0 }) } };
  const first = bg(t, h, ['run', 'test', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { agent: 'a', cwd });
  await until(() => board(h).held.length === 1);
  const r = sync(h, ['run', 'test', '--no-wait', '--', 'true'], { ...swap, agent: 'b' });
  assert.equal(r.code, 75, r.err);
  assert.match(flat(r.err), /Waiting for more free disk for swap to grow into \(7\.0 GB free; while this machine swaps, dibs starts nothing new until 8\.0 GB is free/);
  assert.match(flat(sync(h, [], swap).out), /short of disk for swap to grow into.*Nothing new starts until 8\.0 GB of disk is free for swap to grow into\. Keep waiting: raising the priority is not the fix/s);
  assert.match(sync(h, ['--detail'], swap).out, /disk for swap: disk: 7\.0G free/);
  const drain = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, swapUsed: 0, swapGrowth: 0, diskFree: 9 * G, diskDrain: 4 * G }) } };
  const rd = sync(h, ['run', 'test', '--no-wait', '--', 'true'], { ...drain, agent: 'b' });
  assert.equal(rd.code, 75, rd.err);
  assert.match(flat(rd.err), /Waiting for free disk to stop falling \(it fell 4\.0 GB in 5 min to 9\.0 GB/);
  assert.match(flat(sync(h, [], drain).out), /disk filling fast \(free disk fell 4\.0 GB in 5 min\).*Nothing new starts until free disk stops falling/s);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await first.done, 0);
});

test('the real CLI: swap growing past maxSwap holds new work back, and the wait and the board say why in words', { skip: WIN }, async t => {
  const h = tmp(t);
  // Readings for the file: one four minutes ago and one now, so no dibs here writes another for 30s.
  const readings = (was, now) => fs.writeFileSync(path.join(h, 'swap.json'), JSON.stringify([{ at: Date.now() - 4 * 6e4, used: was }, { at: Date.now(), used: now }]));
  const swap = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, swapUsed: 13.5 * G }) } };
  const cwd = tmp(t, 'job');
  // A job that runs until the test says stop, so nothing depends on timing.
  const first = bg(t, h, ['run', 'test', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { agent: 'a', cwd });
  await until(() => board(h).held.length === 1);
  // Four minutes ago swap was at 12.3 GB; now it's 13.5. The growth comes from the readings file.
  readings(12.3 * G, 13.5 * G);
  const r = sync(h, ['run', 'test', '--no-wait', '--', 'true'], { ...swap, agent: 'b' });
  assert.equal(r.code, 75, r.err);
  assert.match(flat(r.err), /this machine to stop swapping \(swap grew 1\.2 GB in 5 min, 14 GB in use,/);
  assert.match(flat(sync(h, [], swap).out), /swapping \(swap grew 1\.2 GB in 5 min, 14 GB in use\).*Nothing new starts until swap stops growing/s);
  assert.match(sync(h, ['--detail'], swap).out, /swapping: swap grew 1\.2G in 5 min, 14G in use \(over maxSwap 4\.0G\)/);
  // The same swap, with no growth on record: it starts.
  readings(13.5 * G, 13.5 * G);
  assert.equal(sync(h, ['run', 'test', '--no-wait', '--', 'true'], { ...swap, agent: 'b' }).code, 0);
  const p = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, vmPressure: 2 }) } };
  const rp = sync(h, ['run', 'test', '--no-wait', '--', 'true'], { ...p, agent: 'b' });
  assert.equal(rp.code, 75, rp.err);
  assert.match(flat(rp.err), /Waiting for memory pressure to ease/);
  assert.match(flat(sync(h, [], p).out), /memory pressure is high.*Nothing new starts until memory pressure eases/s);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await first.done, 0);
});

test('the real CLI: a job that outgrew its number holds the next one back at the memory budget', { skip: WIN }, async t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ budget: '8G', roomyMemFree: 101 }));
  const foot = path.join(h, 'footprint.json');
  fs.writeFileSync(foot, '{}');
  // Sampling every 300ms instead of 10s, so the test sees a measurement within a tick or two.
  const opts = { env: { DIBS_FAKE_FOOTPRINT: foot, DIBS_SAMPLE_MS: '300' } };
  const cwd = tmp(t, 'job');
  const first = bg(t, h, ['run', 'test', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { ...opts, agent: 'a', cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  // It asked for 2G (test's default) and its tree now uses 7G.
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 7 * G }));
  await until(() => board(h, opts).held[0].use?.mem === 7 * G);
  const r = sync(h, ['run', 'test', '--no-wait', '--', 'true'], { ...opts, agent: 'b' });
  assert.equal(r.code, 75, r.err);
  // What it needs, what's left, what's really free, and who holds the most, with what each asked for.
  assert.match(flat(r.err), /Waiting for room in memory: it needs 2\.0 GB; 7\.0 GB of the 8\.0 GB dibs shares out is taken, 1\.0 GB left, and the machine has [\d.]+ GB free or reclaimable\. Taking the most: a #\d+: using 7\.0 GB, asked 2\.0 GB\. Keep waiting: raising the priority is not the fix\./);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await first.done, 0);
});


test('a job stuck on the budget for long is waited for only by jobs that would delay it: short ones backfill while a long hold keeps it out', () => {
  // 8G handed out at most. A 5G hold lasts two hours, a 1G run ends in a minute.
  // The oldest waiter needs 4G, so it can start only once the hold ends.
  const c = cfg({ budget: '8G', starveAfter: '3m' });
  const hold = lease({ kind: 'hold', res: ['heavy'], mem: 5 * G, cpu: 1, expires: T + 2 * 3600e3 });
  const quick = lease({ res: ['playwright'], mem: 1 * G, cpu: 1, est: 3 * 60e3 });
  const old = waiter({ res: ['xcode-build'], mem: 4 * G, cpu: 1, enq: T - 20 * 60e3 });
  const short = waiter({ mem: 1 * G, cpu: 1, est: 5 * 60e3 });
  const s = { leases: [hold, quick], queue: [old, short] };
  const tight = { memFree: 10 };
  assert.equal(judge(s, old, c, tight).rule, 'memory');
  assert.equal(judge(s, short, c, tight).ok, true, 'done in 5 min, long before the hold frees the memory the old one needs');
  const long = waiter({ id: short.id, mem: 1 * G, cpu: 1, est: 3 * 3600e3 });
  const v = judge({ ...s, queue: [old, long] }, long, c, tight);
  assert.equal(v.starved, true, 'one that would still run when the hold ends waits behind it');
});

test('a waiter asking for more than the budget never holds the line as its oldest', () => {
  const c = cfg({ budget: '8G', starveAfter: '3m' });
  const big = waiter({ res: ['heavy'], mem: 12 * G, cpu: 1, enq: T - 20 * 60e3 });
  const me = waiter({ mem: 1 * G, cpu: 1, est: 3 * 3600e3 });
  const s = { leases: [lease({ res: ['playwright'], mem: 6 * G, cpu: 1, est: 3600e3 })], queue: [big, me] };
  assert.equal(judge(s, me, c, { memFree: 10 }).ok, true);
});

test('memory booked never goes past the budget, however roomy the machine looks', () => {
  const s = { leases: [lease({ mem: 6 * G })], queue: [] };
  const me = waiter({ mem: 6 * G });
  const v = judge({ ...s, queue: [me] }, me, cfg());
  assert.equal(v.rule, 'memory', '6 + 6 is past 11, even with 67% of memory free and nothing on the cores');
  const small = waiter({ mem: 5 * G });
  assert.equal(judge({ ...s, queue: [small] }, small, cfg()).ok, true, '6 + 5 is the whole budget, no more');
});

test('a run measured for a few minutes books its peak plus a margin, not its ask, and the gap goes to a waiter while the machine really has room', () => {
  // Asked 8G, peaked at 1.4G, running 4 minutes and still moving (peakAt just now).
  const big = lease({ mem: 8 * G, start: T - 4 * 60e3, use: { mem: 0.8 * G, cpu: 1 }, peak: { mem: 1.4 * G }, peakAt: T });
  const me = waiter({ mem: 6 * G });
  const s = { leases: [big], queue: [me] };
  const busy = { load: 9 };   // not the roomy rule's quiet machine
  assert.equal(judge(s, me, cfg(), busy).ok, true, '2.4G booked plus 6 fits in 11');
  // Swap growing (under maxSwap, so not the swap gate itself): the asks stand.
  const v = judge(s, me, cfg(), { ...busy, swapUsed: 1 * G, swapGrowth: 0.6 * G });
  assert.equal(v.ok, false, 'with swap growing, the asks stand');
  assert.match(v.why, /running jobs ask for more than they use, but the machine doesn't have the room to show for it/);
  assert.equal(judge(s, me, cfg(), { ...busy, memFree: 40 }).ok, false, '6.4G free is less than 6G plus the reserve');
  const young = lease({ ...big, start: T - 60e3 });
  assert.equal(judge({ leases: [young], queue: [me] }, me, cfg(), { ...busy, memFree: 40 }).rule, 'memory', 'under 3 minutes in, it books its ask');
  assert.equal(judge({ leases: [young], queue: [me] }, me, cfg(), busy).ok, true, 'unless what it uses now leaves the room, and the machine shows it');
});

test('high work never waits behind a lower-priority job reserving memory, and a job that needs most of the budget reserves it only once it could start soon', () => {
  const MIN = 6e4;
  const c = cfg({ budget: '8G', starveAfter: '3m' });
  const tight = { memFree: 20 };   // short of the roomy rule's 35%, over the big-job floor's 15%
  // A 4 GB job for two more hours; a normal one waiting 20 minutes for 7 of the 8 GB.
  const long = lease({ res: ['heavy'], mem: 4 * G, cpu: 1, est: 2 * 60 * MIN, start: T - MIN });
  const whole = waiter({ res: ['playwright'], mem: 7 * G, cpu: 1, enq: T - 20 * MIN });
  const owner = waiter({ res: ['xcode-build'], mem: 3 * G, cpu: 1, prio: 'high', purpose: 'owner waiting', est: 3 * 60 * MIN });
  const s = { leases: [long], queue: [whole, owner] };
  assert.equal(judge(s, owner, c, tight).ok, true, 'high goes past a normal reservation');
  // A normal job that would outlast it: the big one is two hours from starting, so it doesn't reserve yet.
  const normal = waiter({ res: ['test'], mem: 3 * G, cpu: 1, est: 3 * 60 * MIN });
  assert.equal(judge({ ...s, queue: [whole, normal] }, normal, c, tight).ok, true, 'two hours out, the big job waits for a quiet moment');
  // Once the long job is about to end, the big one reserves: a normal job that would outlast it waits.
  const ending = lease({ ...long, est: 2 * MIN });
  const v = judge({ leases: [ending], queue: [whole, normal] }, normal, c, tight);
  assert.equal(v.starved, true, 'it still goes first once it can start soon');
});

test('a job past its usual time counts as running as long again, not as ending in 30 seconds, when it holds memory a waiter needs', () => {
  const MIN = 6e4;
  const c = cfg({ budget: '8G', starveAfter: '3m' });
  // Usually done in a minute, running for 30: a 4 GB waiter for its memory isn't starting in 30 seconds.
  const over = lease({ res: ['heavy'], mem: 5 * G, cpu: 1, est: MIN, start: T - 30 * MIN });
  const old = waiter({ res: ['playwright'], mem: 4 * G, cpu: 1, enq: T - 20 * MIN });
  const me = waiter({ res: ['test'], mem: 2 * G, cpu: 1, est: 10 * MIN });
  assert.equal(judge({ leases: [over], queue: [old, me] }, me, c, { memFree: 20 }).ok, true);
});

// 2026-10-20: two jobs booked 8.6 of 11 GB while the Mac had 8.6 GB free, swap high but still, and
// twenty waiters sat "blocked by memory".
test('booked past the budget, a job starts when what running jobs use now plus it fits, and the machine shows the room', () => {
  const c = cfg();
  const a = lease({ mem: 4.5 * G, use: { mem: 1.2 * G }, start: T - 60e3 });
  const b = lease({ mem: 4.1 * G, use: { mem: 1.0 * G }, start: T - 60e3 });
  const me = waiter({ mem: 3 * G });
  const s = { leases: [a, b], queue: [me] };
  const roomy = { memFree: 54, swapUsed: 6 * G, swapGrowth: 0 };
  assert.equal(judge(s, me, c, roomy).ok, true, 'swap high but still, 8.6 GB free: it goes');
  assert.equal(judge(s, me, c, { ...roomy, swapGrowth: 1.2 * G, swapRecent: 1.2 * G }).ok, false, 'swap growing: it waits');
  assert.equal(judge(s, me, c, { ...roomy, vmPressure: 1 }).ok, false, 'pressure: it waits');
  assert.equal(judge(s, me, c, { ...roomy, memFree: 30 }).rule, 'memory', 'not the room to show for it: it waits');
  const big = waiter({ mem: 9 * G });
  assert.equal(judge({ leases: [a, b], queue: [big] }, big, c, roomy).rule, 'memory', 'what they use plus it past the budget: it waits');
});

// 2026-10-21: 0.5 GB deploys waited 79 and 92 s on the room kept for swap, and one 9 minutes on load.
test('a small job on an exclusive resource (a deploy) or one that writes little (a test run) passes the room kept for swap, over minDisk', () => {
  const c = cfg({ maxLoad: 4 });
  const deploy = waiter({ res: ['deploy'], mem: 0.5 * G, cpu: 1 });
  const s = { leases: [lease()], queue: [deploy] };
  const squeezed = { diskFree: 6 * G, swapUsed: 3 * G, vmPressure: 1 };
  assert.equal(judge(s, deploy, c, { load: 9 }).ok, true, 'past the load ceiling');
  assert.equal(judge(s, deploy, c, squeezed).ok, true, 'past the room kept for swap');
  assert.equal(judge(s, deploy, c, { diskFree: 0.5 * G }).rule, 'disk', 'not under the 1 GB it keeps free');
  const test2 = waiter({ mem: 0.5 * G, cpu: 1 });
  // 2026-10-26: every start waited on the room kept for swap with 6.8 GB free, one-second test runs included.
  assert.equal(judge({ leases: [lease()], queue: [test2] }, test2, c, squeezed).ok, true, 'a test run of the same size goes too');
  assert.equal(judge({ leases: [lease()], queue: [test2] }, test2, c, { diskFree: 0.5 * G }).rule, 'disk', 'but not under the 1 GB it keeps free');
  const browser = waiter({ res: ['playwright'], mem: 0.5 * G, cpu: 1 });
  { const v = judge({ leases: [lease()], queue: [browser] }, browser, c, squeezed); assert.equal(v.rule, 'swaproom', JSON.stringify(v)); }
  const big = waiter({ mem: 2 * G, cpu: 1 });
  assert.ok(!judge({ leases: [lease()], queue: [big] }, big, c, squeezed).ok, 'a 2 GB test run still waits');
});
