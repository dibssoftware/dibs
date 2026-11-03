// The scheduling rules, tested without processes.
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE } from './helpers.mjs';
import { rank, rankParts, forecast, verdict, byRank, holdingOf, used, priority, PRIORITIES, expected } from '../src/schedule.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { deadline } from '../src/util.mjs';
import { commandKey } from '../src/acquire.mjs';
import { learned } from '../src/measure.mjs';

const T = 1_000_000_000_000;
// roomyMemFree over 100 means the machine never counts as roomy, so the budgets always apply.
const cfg = { ...DEFAULT_CONFIG, roomyMemFree: 101, resources: { ...DEFAULT_CONFIG.resources } };
let n = 0;
const q = (o = {}) => ({ id: ++n, res: ['sim'], mem: 1 * G, cpu: 1, disk: 0, pid: 1, who: `a${n}`, enq: T, key: 'k', ...o });
const lease = (o = {}) => ({ id: ++n, res: ['sim'], mem: 1 * G, cpu: 1, kind: 'run', pid: 1, who: 'h', start: T, key: 'k', ...o });

test('earlier arrival goes first', () => {
  const a = q({ enq: T }), b = q({ enq: T + 1000 });
  assert.ok(rank(a, [], T) < rank(b, [], T));
});

test('high priority moves up an hour, low moves back 10 minutes', () => {
  assert.equal(rank(q({ prio: 'high' }), [], T), T - 60 * 6e4);
  assert.equal(rank(q({ prio: 'low' }), [], T), T + 10 * 6e4);
});

test('a high-priority newcomer passes a normal job that arrived less than an hour earlier, not more', () => {
  const old = q({ enq: T }), recent = q({ enq: T + 59 * 6e4 }), late = q({ enq: T + 61 * 6e4 });
  const hiRecent = { ...recent, prio: 'high' }, hiLate = { ...late, prio: 'high' };
  assert.ok(rank(hiRecent, [], T) < rank(old, [], T));
  assert.ok(rank(hiLate, [], T) > rank(old, [], T));
});

test('a deadline only counts once slack is under 20 minutes, and moves you at most an hour', () => {
  // A 10-minute job also moves back 8 minutes for its length (against the 2-minute probe).
  const far = q({ by: T + 3 * 3.6e6, est: 10 * 6e4 });
  assert.equal(rank(far, [], T), T + 8 * 6e4);
  const near = q({ by: T + 15 * 6e4, est: 10 * 6e4 });   // slack 5m -> moved up 15m
  assert.equal(rank(near, [], T), T - 15 * 6e4 + 8 * 6e4);
  const blown = q({ by: T - 3.6e6, est: 10 * 6e4 });
  assert.equal(rank(blown, [], T), T - 60 * 6e4 + 8 * 6e4);
});

test('a job moves by its run time against a 2-minute probe: shorter up, longer back, by at most an hour', () => {
  assert.equal(rank(q({ est: 6e4 }), [], T), T - 6e4);
  assert.equal(rank(q({ est: 30e3 }), [], T), T - 1.5 * 6e4);
  assert.equal(rank(q({ est: 20 * 6e4 }), [], T), T + 18 * 6e4);
  assert.equal(rank(q({ est: 3 * 3.6e6 }), [], T), T + 58 * 6e4);
  assert.equal(rank(q({}), [], T), T);   // never seen: a 2-minute probe, no move
});

test('agents who used a resource a lot in the last hour move back for it, by at most 10 minutes', () => {
  const hist = [{ key: 'sim|x', who: 'heavy', dur: 30 * 6e4, at: T - 6e4 }, { key: 'sim|x', who: 'old', dur: 30 * 6e4, at: T - 2 * 3.6e6 }];
  assert.equal(rank(q({ who: 'heavy' }), hist, T), T + 6 * 6e4);
  assert.equal(rank(q({ who: 'old' }), hist, T), T);
  const huge = [{ key: 'sim,xcode-build|x', who: 'heavy', dur: 3 * 3.6e6, at: T - 6e4 }];
  assert.equal(rank(q({ who: 'heavy' }), huge, T), T + 10 * 6e4);
});

test("an hour of tests doesn't cost an agent its turn on the simulator", () => {
  const hist = [{ key: 'test|npm', who: 'heavy', dur: 50 * 6e4, at: T - 6e4 }];
  assert.equal(rank(q({ who: 'heavy' }), hist, T), T);
  assert.equal(rank(q({ who: 'heavy', res: ['test'] }), hist, T), T + 10 * 6e4);
});

test('dibs why names each rule that moved you', () => {
  const { parts } = rankParts(q({ prio: 'high', est: 30e3 }), [], T);
  assert.deepEqual(parts.map(p => p.label), ['high', 'short job']);
  assert.deepEqual(rankParts(q({ est: 20 * 6e4 }), [], T).parts.map(p => p.label), ['long job']);
});

test("your own hold covers your run on the same resource", () => {
  const mine = lease({ kind: 'hold', res: ['sim'], expires: T + 6e5, pid: 77, spid: 77 });
  const me = q({ res: ['sim'], spid: 77 });
  const other = q({ res: ['sim'], spid: 88 });
  const s = { leases: [mine], queue: [me, other] };
  const v = verdict(s, me, cfg, [], T);
  assert.equal(v.ok, true);
  assert.deepEqual(v.covered, ['sim']);
  assert.equal(verdict(s, other, cfg, [], T).rule, 'slot');
});

test("a run inside your own hold starts even when the machine's budget is full and others are ahead", () => {
  const mine = lease({ kind: 'hold', res: ['sim'], expires: T + 6e5, pid: 77, spid: 77, cpu: 1 });
  const hog = lease({ kind: 'run', res: ['heavy'], pid: 66, cpu: cfg.cores });   // every core handed out
  const starving = q({ res: ['test'], spid: 88, enq: T - 10 * 6e4, cpu: 3 });    // waited past starveAfter
  const me = q({ res: ['sim'], spid: 77, enq: T, cpu: 1 });
  const s = { leases: [mine, hog], queue: [starving, me] };
  const v = verdict(s, me, cfg, [], T);
  assert.equal(v.ok, true, v.why);
  assert.deepEqual(v.covered, ['sim']);
});

test('the load ceiling goes by cores in use, not a load average inflated by swapping', t => {
  const c = { ...cfg, maxLoad: 10 };
  const me = q({ res: ['test'], spid: 88, enq: T });
  const s = { leases: [], queue: [me] };
  const before = process.env.DIBS_FAKE_MACHINE;
  t.after(() => { process.env.DIBS_FAKE_MACHINE = before; });
  const on = m => { process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...m }); return verdict(s, me, c, [], T); };
  assert.equal(on({ load: 22.5, busy: 1.2 }).ok, true, 'load 22.5 from swap, 1.2 cores busy: starts');
  assert.equal(on({ load: 22.5, busy: 14 }).rule, 'load', 'really busy: waits');
  assert.equal(on({ load: 22.5 }).rule, 'load', 'no reading of cores in use: the load average decides');
});

test('a job bigger than the budget runs when only its own hold and file leases are out, not when real work is', () => {
  const G = 1024 ** 3;
  const own = lease({ kind: 'hold', res: ['sim'], expires: T + 6e5, pid: 77, spid: 77, mem: 1 * G, cpu: 1 });
  const files = lease({ kind: 'hold', res: ['files:/repo/src'], expires: T + 36e5, pid: 55, spid: 55, mem: 0, cpu: 0 });
  const big = q({ res: ['xcode-build'], spid: 77, enq: T, mem: 14 * G, cpu: 9 });
  assert.equal(verdict({ leases: [own, files], queue: [big] }, big, cfg, [], T).ok, true);
  const work = lease({ kind: 'run', res: ['test'], pid: 66, mem: 2 * G, cpu: 3 });
  assert.equal(verdict({ leases: [own, files, work], queue: [big] }, big, cfg, [], T).rule, 'memory');
});

test('the budgets step aside on a machine that is roomy by cores in use, even when swapping inflates the load average', t => {
  const c = { ...cfg, roomyMemFree: 35, roomyLoad: 0.6, cores: 10 };
  const running = lease({ kind: 'run', res: ['test'], pid: 66, cpu: 8 });
  const me = q({ res: ['heavy'], spid: 88, enq: T, cpu: 4 });
  const s = { leases: [running], queue: [me] };
  const before = process.env.DIBS_FAKE_MACHINE;
  t.after(() => { process.env.DIBS_FAKE_MACHINE = before; });
  const on = m => { process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, cores: 10, memFree: 70, ...m }); return verdict(s, me, c, [], T); };
  assert.equal(on({ load: 9.1, busy: 4.8 }).ok, true, 'load 9.1 from swap, 4.8 cores busy: roomy, budgets skipped');
  assert.equal(on({ load: 9.1, busy: 8.5 }).rule, 'cpu', 'really busy: the CPU budget applies');
});

test('history sets the expected run time a deadline is measured against', () => {
  const hist = [{ key: 'slow', dur: 15 * 6e4 }];
  const job = q({ key: 'slow', by: T + 20 * 6e4 });          // slack 5m with history: up 15m, and back 13m for its length
  assert.equal(rank(job, hist, T), T - 2 * 6e4);
  // No history: the run is guessed at 5 minutes, so slack is 15m and it moves up 5m.
  assert.equal(rank({ ...job, key: 'new' }, [], T), T - 5 * 6e4);
});

test('a yielded place wins over a worse computed rank', () => {
  assert.equal(rank(q({ enq: T + 5e5, yieldRank: T - 1 }), [], T), T - 1);
});

test('busy resource blocks; free one admits', () => {
  const s = { leases: [lease()], queue: [] };
  const me = q();
  s.queue.push(me);
  assert.equal(verdict(s, me, cfg, [], T).ok, false);
  const other = q({ res: ['deploy'] });
  s.queue.push(other);
  assert.equal(verdict(s, other, cfg, [], T).ok, true);
});

test('nobody passes an earlier waiter for the same resource', () => {
  const first = q({ enq: T }), second = q({ enq: T + 1 });
  const s = { leases: [], queue: [first, second] };
  assert.equal(verdict(s, second, cfg, [], T).ok, false);
  assert.equal(verdict(s, first, cfg, [], T).ok, true);
});

test('memory budget: a 5G job waits behind 5G running, a 1G job fits', () => {
  const s = { leases: [lease({ res: ['heavy'], mem: 5 * G, cpu: 1 })], queue: [] };
  const big = q({ res: ['x1'], mem: 5 * G }), small = q({ res: ['x2'], mem: 1 * G, enq: T + 1 });
  s.queue.push(big, small);
  assert.equal(verdict(s, big, cfg, [], T).ok, false);   // quick now also ranks ahead (short job)
  assert.equal(verdict(s, small, cfg, [], T).ok, true);
});

test('CPU budget caps cores handed out', () => {
  const s = { leases: [lease({ res: ['heavy'], mem: 0, cpu: 4 })], queue: [] };
  const three = q({ res: ['x'], mem: 0, cpu: 3 });
  s.queue.push(three);
  assert.match(verdict(s, three, cfg, [], T).why, /CPU budget: 4 of 6/);
  three.cpu = 2;
  assert.equal(verdict(s, three, cfg, [], T).ok, true);
});

test('a job bigger than the whole budget still runs when nothing else is', () => {
  const s = { leases: [], queue: [] };
  const huge = q({ res: ['x'], mem: 20 * G, cpu: 12 });
  s.queue.push(huge);
  assert.equal(verdict(s, huge, cfg, [], T).ok, true);
});

test('the CPU budget counts what a running job was measured using, not what it asked for', () => {
  const build = lease({ res: ['xcode-build'], mem: 0, cpu: 4 });
  const three = q({ res: ['x'], mem: 0, cpu: 3 });
  assert.match(verdict({ leases: [build], queue: [three] }, three, cfg, [], T).why, /CPU budget: 4 of 6 cores in use/);
  build.use = { mem: 0, cpu: 1.2, at: T };
  assert.equal(verdict({ leases: [build], queue: [three] }, three, cfg, [], T).ok, true);
  build.use = { mem: 0, cpu: 5, at: T };
  assert.match(verdict({ leases: [build], queue: [three] }, three, cfg, [], T).why, /CPU budget: 5 of 6/);
});

test('after 3 minutes at the head of the line, a stuck heavy job stops being passed', () => {
  const s = { leases: [lease({ res: ['heavy'], mem: 5 * G })], queue: [] };
  const stuck = q({ res: ['x1'], mem: 5 * G, enq: T });
  const light = q({ res: ['x2'], mem: 1 * G, enq: T + 1 });
  s.queue.push(stuck, light);
  assert.equal(verdict(s, light, cfg, [], T + 6e4).ok, true);
  assert.match(verdict(s, light, cfg, [], T + 4 * 6e4).why, /so it goes first/);
});

test('waiters who left (no pid) do not block anyone', () => {
  const gone = q({ enq: T, pid: null, keepUntil: T + 1e5 }), me = q({ enq: T + 1 });
  assert.equal(verdict({ leases: [], queue: [gone, me] }, me, cfg, [], T).ok, true);
});

test('forecast lines waiters up behind the holder, using history', () => {
  const hist = [{ key: 'k', dur: 10 * 6e4 }];
  const s = { leases: [lease({ start: T })], queue: [q({ enq: T }), q({ enq: T + 1 })] };
  const fc = forecast(s, cfg, hist, T);
  assert.equal(fc.get(s.queue[0].id), T + 10 * 6e4);
  assert.equal(fc.get(s.queue[1].id), T + 20 * 6e4);
});

test('forecast uses every slot of a multi-slot resource', () => {
  const s = { leases: [], queue: [q({ res: ['xcode-build'] }), q({ res: ['xcode-build'], enq: T + 1 }), q({ res: ['xcode-build'], enq: T + 2 })] };
  const fc = forecast(s, cfg, [], T);
  assert.deepEqual(s.queue.map(x => fc.get(x.id)), [T, T, T + 5 * 6e4]);   // two slots; no history guesses 5 minutes
});

test('equal ranks go in arrival order', () => {
  const a = q({ enq: T }), b = q({ enq: T });
  assert.deepEqual([b, a].sort(byRank([], T)).map(x => x.id), [a.id, b.id]);
});

test('backfill: a short job takes a free slot ahead of a waiter that cannot start yet', () => {
  const hold = lease({ kind: 'hold', res: ['sim'], expires: T + 20 * 6e4, mem: 0, cpu: 0 });
  const blocked = q({ res: ['sim', 'xcode-build'], enq: T, mem: 0, cpu: 0 });
  const short = q({ res: ['xcode-build'], enq: T + 1, est: 5 * 6e4, mem: 0, cpu: 0 });
  const one = { ...cfg, resources: { ...cfg.resources, 'xcode-build': { ...cfg.resources['xcode-build'], slots: 1 } } };
  const s = { leases: [hold], queue: [blocked, short] };
  assert.equal(verdict(s, short, one, [], T).ok, true);
  const long = { ...short, est: 30 * 6e4 };
  assert.match(verdict({ ...s, queue: [blocked, long] }, long, one, [], T).why, /ahead of you for xcode-build/);
  // With two slots there's room for both: one waiter ahead doesn't fill two free slots.
  assert.equal(verdict({ ...s, queue: [blocked, long] }, long, cfg, [], T).ok, true);
});

test('a run covered by a hold counts again once the hold is gone', () => {
  const hold = lease({ kind: 'hold', res: ['sim'], pid: 77, spid: 77, expires: T + 6e5 });
  const run = lease({ res: ['sim'], spid: 77, covered: ['sim'] });
  const other = q({ res: ['sim'], spid: 88 });
  assert.match(verdict({ leases: [hold, run], queue: [other] }, other, cfg, [], T).why, /sim is in use/);
  assert.match(verdict({ leases: [run], queue: [other] }, other, cfg, [], T).why, /sim is in use/);
});

test('the starvation rule only holds others up for a waiter stuck on the budget', () => {
  const big = q({ res: ['heavy'], mem: 4 * G, enq: T - 10 * 6e4 });
  const light = q({ res: ['deploy'], mem: 0.5 * G, enq: T });
  const busy = { ...cfg, budget: '20G' };
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memFree: 5 });
  try {
    // big waits on machine memory (ram), which light doesn't make worse.
    const r = verdict({ leases: [lease({ res: ['test'], mem: 1 * G })], queue: [big, light] }, light, busy, [], T);
    assert.equal(r.ok, true, r.why);
  } finally { process.env.DIBS_FAKE_MACHINE = JSON.stringify(MACHINE); }
});

test('backfill also applies to a waiter stuck on the memory budget', () => {
  const running = lease({ res: ['heavy'], mem: 6 * G, cpu: 1, est: 30 * 6e4, start: T });
  const big = q({ res: ['xcode-build'], mem: 4 * G, enq: T });
  const quick = q({ res: ['xcode-build'], mem: 1 * G, enq: T + 1, est: 2 * 6e4 });
  const s = { leases: [running], queue: [big, quick] };
  assert.equal(verdict(s, quick, cfg, [], T).ok, true);
  assert.equal(verdict(s, big, cfg, [], T).ok, false);   // quick now also ranks ahead (short job)
});

test('five priority levels, in order, and 1-5 as aliases', () => {
  assert.deepEqual(PRIORITIES, ['urgent', 'high', 'normal', 'low', 'idle']);
  assert.equal(priority('1'), 'urgent');
  assert.equal(priority(5), 'idle');
  assert.equal(priority('HIGH'), 'high');
  const ranks = PRIORITIES.map(p => rank(q({ prio: p }), [], T));
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks);
  assert.equal(rank(q({ prio: 'idle' }), [], T), T + 60 * 6e4);
  assert.equal(rank(q({ prio: 'urgent' }), [], T), T - 120 * 6e4);
});

test('idle work waits while anyone else is waiting, on any resource', () => {
  const other = q({ res: ['deploy'], enq: T + 5 });
  const idle = q({ res: ['x'], prio: 'idle', enq: T });
  const s = { leases: [lease({ res: ['deploy'] })], queue: [idle, other] };
  assert.match(verdict(s, idle, cfg, [], T).why, /idle work waits/);
  s.queue = [idle];
  assert.equal(verdict(s, idle, cfg, [], T).ok, true);
});

test('on a roomy machine the CPU budget steps aside, never the memory budget', () => {
  const roomyCfg = { ...cfg, roomyMemFree: 35 };   // the fake machine has 90% free and load 0
  const s = { leases: [lease({ res: ['heavy'], mem: 2 * G, cpu: 6 })], queue: [] };
  const wide = q({ res: ['x'], mem: 1 * G, cpu: 4 });
  s.queue.push(wide);
  assert.equal(verdict(s, wide, cfg, [], T).rule, 'cpu');
  assert.equal(verdict(s, wide, roomyCfg, [], T).ok, true);
  const big = q({ res: ['y'], mem: 7 * G, cpu: 1 });
  assert.equal(verdict({ ...s, queue: [big] }, big, roomyCfg, [], T).rule, 'memory');
});

test('a waiter that holds a lease goes ahead of those that hold nothing, but not ahead of high or urgent work', () => {
  const holds = { res: ['deploy'], purpose: 'ship build 122' };
  assert.equal(rank(q({ holding: holds }), [], T), T - 10 * 6e4);
  const old = q({ enq: T - 5 * 6e4 }), ship = q({ holding: holds }), urgent = q({ prio: 'urgent', purpose: 'prod down' });
  assert.deepEqual([old, ship, urgent].sort(byRank([], T)).map(x => x.id), [urgent.id, ship.id, old.id]);
  assert.deepEqual(rankParts(ship, [], T).parts, [{ label: 'holds deploy', shift: 10 * 6e4 }]);
  assert.equal(rank(q({ holding: holds, prio: 'low' }), [], T), T + 10 * 6e4, 'asking for low keeps it low');
  assert.equal(rank(q({ holding: holds, prio: 'high', purpose: 'x' }), [], T), T - 60 * 6e4, "it doesn't stack on high");
});

test('what counts as holding: the run you are nested in, and your session holds taken in the last 10 minutes, on configured resources', () => {
  const ship = lease({ res: ['deploy'], purpose: 'ship build 122' });
  const bg = lease({ res: ['heavy'], prio: 'low' });
  const fresh = lease({ res: ['sim'], kind: 'hold', pid: 77, start: T - 5 * 6e4 });
  const stale = lease({ res: ['playwright'], kind: 'hold', pid: 88, start: T - 15 * 6e4 });
  const madeUp = lease({ res: ['zzz'] });
  const s = { leases: [ship, bg, fresh, stale, madeUp], queue: [] };
  assert.deepEqual(holdingOf(s, q({ res: ['xcode-build'], outer: ship.id }), cfg, T), { res: ['deploy'], purpose: 'ship build 122' });
  assert.equal(holdingOf(s, q({ res: ['xcode-build'], outer: bg.id }), cfg, T), null, 'low and idle outer runs get nothing');
  assert.equal(holdingOf(s, q({ res: ['xcode-build'], outer: madeUp.id }), cfg, T), null, 'a lease on a made-up name costs nobody, so it buys nothing');
  assert.deepEqual(holdingOf(s, q({ res: ['xcode-build'], spid: 77 }), cfg, T)?.res, ['sim']);
  assert.equal(holdingOf(s, q({ res: ['xcode-build'], spid: 88 }), cfg, T), null, 'a hold kept past 10 minutes is sitting, not shipping');
  assert.equal(holdingOf(s, q({ res: ['xcode-build'] }), cfg, T), null);
});

test('a run nested in a run that has part of what it needs waits only for the rest', () => {
  const outer = lease({ res: ['deploy'] });
  const inner = q({ res: ['deploy', 'x'], outer: outer.id });
  const s = { leases: [outer], queue: [inner] };
  const v = verdict(s, inner, cfg, [], T);
  assert.equal(v.ok, true, v.why);
  assert.deepEqual(v.covered, ['deploy']);
  s.leases.push(lease({ res: ['deploy', 'x'], covered: ['deploy'], outer: outer.id }));
  assert.equal(used(s, 'deploy'), 1, "the nested run doesn't take a second deploy slot");
});

// A deadline dibs can't read is refused with exit 2: see bad usage in cli.test.mjs.
test('deadlines: 5:00 without am/pm is whichever comes next', () => {
  const at = (h, m = 0) => { const d = new Date(2026, 9, 13, h, m); return d.getTime(); };
  assert.equal(new Date(deadline('5:00', at(16, 30))).getHours(), 17);
  assert.equal(new Date(deadline('5:00', at(3, 0))).getHours(), 5);
  assert.equal(new Date(deadline('9pm', at(10))).getHours(), 21);
  assert.equal(new Date(deadline('23:30', at(10))).getHours(), 23);
  const d = new Date(deadline('5:00', at(18)));
  assert.equal(d.getDate(), 14);
  assert.equal(d.getHours(), 5);
});

test('history keeps a build, a test and an archive of one project apart, and a temp folder does not split a command', () => {
  const xb = (...a) => commandKey(['xcodebuild', '-project', '/src/App.xcodeproj', '-scheme', 'App', '-derivedDataPath', '/tmp/x7f3/dd', ...a]);
  assert.equal(xb('build'), 'xcodebuild App.xcodeproj / App build');
  assert.equal(xb('-configuration', 'Release', 'archive'), 'xcodebuild App.xcodeproj / App Release archive');
  assert.notEqual(xb('build'), xb('test'));
  assert.equal(commandKey(['npm', 'run', 'lint']), 'npm run / lint');
  assert.notEqual(commandKey(['npm', 'run', 'lint']), commandKey(['npm', 'run', 'build']));
  assert.equal(commandKey(['npm', 'test']), 'npm test', 'one word: the key it always had');
  assert.equal(commandKey(['node', '/tmp/a1/run.mjs', '/tmp/b2/out']), commandKey(['node', '/tmp/c3/run.mjs', '/tmp/d4/out']));
  assert.equal(commandKey(['git', 'commit', '-m', 'x', 'a', 'b', 'c', 'd']).split(' / ')[1].split(' ').length, 2, 'at most three words');
});

test("history from before the key grew counts until the command has its own", () => {
  const key = 'xcode-build|xcodebuild App.xcodeproj / App build';
  const old = [{ key: 'xcode-build|xcodebuild App.xcodeproj', dur: 7 * 6e4, fit: true, mem: 14 * G, cpu: 8 }];
  assert.equal(expected({ key }, old), 7 * 6e4);
  assert.equal(learned(old, key, 10).mem, 14 * G);
  const own = [...old, { key, dur: 20e3, fit: true, mem: 1 * G, cpu: 2 }];
  assert.equal(expected({ key }, own), 20e3);
  assert.equal(learned(own, key, 10).mem, 1 * G);
});

test('a high job goes ahead of normal ones that have waited less than an hour longer, and urgent ahead of high the same way', () => {
  // 2026-10-19: two high jobs sat sixth and ninth behind normal jobs that had waited about 15 minutes longer.
  const normal = q({ enq: T - 15 * 6e4 }), high = q({ prio: 'high', purpose: 'owner waiting', enq: T });
  assert.deepEqual([normal, high].sort(byRank([], T)).map(x => x.id), [high.id, normal.id]);
  const s = { leases: [lease({ res: ['heavy'], mem: 4 * G })], queue: [normal, high] };
  assert.equal(verdict(s, high, cfg, [], T).ok, true, 'and it takes the memory first');
  assert.equal(verdict(s, normal, cfg, [], T).rule, 'ahead');
  // A normal job that has waited over an hour longer still goes first.
  const ancient = q({ enq: T - 61 * 6e4 });
  assert.deepEqual([high, ancient].sort(byRank([], T)).map(x => x.id), [ancient.id, high.id]);
  const urgent = q({ prio: 'urgent', purpose: 'prod down', enq: T });
  assert.deepEqual([q({ prio: 'high', purpose: 'x', enq: T - 50 * 6e4 }), urgent].sort(byRank([], T))[0].id, urgent.id);
});

test('two high sim-own jobs behind seven normal ones that waited 13 minutes longer go first and second, and the first takes the open slot', () => {
  // 2026-10-19: two -p high sim-own jobs sat at places 6 and 9 behind normal jobs that had waited about 13 minutes longer.
  const res = ['sim-own'];
  const normals = Array.from({ length: 7 }, (_, i) => q({ res, enq: T - 13 * 6e4 - i * 1000 }));
  const highs = [q({ res, prio: 'high', purpose: 'owner waiting on build 125', enq: T }), q({ res, prio: 'high', purpose: 'owner waiting on build 125', enq: T + 1000 })];
  const queue = [...normals.slice(0, 5), highs[0], ...normals.slice(5), highs[1]];
  assert.deepEqual(queue.slice().sort(byRank([], T)).slice(0, 2).map(x => x.id), highs.map(x => x.id));
  const slots = cfg.resources['sim-own'].slots;
  const s = { leases: Array.from({ length: slots - 1 }, () => lease({ res, mem: 0, cpu: 0 })), queue };
  assert.equal(verdict(s, highs[0], cfg, [], T).ok, true, 'the open slot is the first high job\'s');
  assert.equal(verdict(s, normals[0], cfg, [], T).rule, 'ahead', 'the normal job that waited longest is behind it');
});

test('a short job of known length starts past a memory reservation whose own start is only a guess', () => {
  // 2026-10-20: browser runs and a test run waited behind an Xcode build that needed 6.4 GB, which
  // waited on work whose end dibs couldn't know, while the memory they needed was free.
  const build = lease({ res: ['xcode-build'], mem: 4 * G, cpu: 2, start: T - 2 * 6e4 });   // no --est, no history
  const big = q({ res: ['xcode-build'], mem: 6.4 * G, cpu: 2, enq: T - 20 * 6e4, purpose: 'pitch-help' });
  const short = q({ res: ['playwright'], mem: 1 * G, cpu: 1, est: 4 * 6e4, enq: T });
  const s = { leases: [build], queue: [big, short] };
  assert.equal(verdict(s, big, cfg, [], T).rule, 'memory');
  assert.equal(verdict(s, short, cfg, [], T).ok, true, 'the reservation rests on a build of unknown length');
  // Once the build's run time is known and the reservation comes before the short job would end, it waits.
  const timed = { leases: [{ ...build, est: 5 * 6e4 }], queue: [big, short] };
  assert.equal(verdict(timed, short, cfg, [], T).rule, 'ahead');
});

// 2026-10-20: 46% of jobs waited longer than they ran (57% over the week before).
test('shortest first with aging: a 30-second check passes a 20-minute suite that arrived less than about 19 minutes before it, not more', () => {
  const key = (k, d) => Array.from({ length: 5 }, (_, i) => ({ key: k, dur: d, at: i }));
  const hist = [...key('suite', 20 * 6e4), ...key('check', 30e3)];
  const suite = q({ key: 'suite', enq: T });
  const soon = q({ key: 'check', enq: T + 15 * 6e4 }), late = q({ key: 'check', enq: T + 21 * 6e4 });
  assert.deepEqual([suite, soon].sort(byRank(hist, T + 21 * 6e4)).map(x => x.id), [soon.id, suite.id]);
  assert.deepEqual([suite, late].sort(byRank(hist, T + 21 * 6e4)).map(x => x.id), [suite.id, late.id]);
  // A command never seen ranks as a short probe, not the worst case.
  const fresh = q({ key: 'never-seen', enq: T + 15 * 6e4 });
  assert.deepEqual([suite, fresh].sort(byRank(hist, T + 21 * 6e4)).map(x => x.id), [fresh.id, suite.id]);
  // What a command has really taken beats --est.
  assert.equal(expected({ key: 'suite', est: 30e3 }, hist), 20 * 6e4);
  assert.equal(expected({ key: 'never-seen', est: 30e3 }, hist), 30e3);
});

// Two browser suites on one Mac can take twice as long side by side, or barely longer: dibs learns which from the history.
test('a job that has run 1.8 times as long or more beside a kind of work waits for it, but no longer than its own run time', async () => {
  const { slowdown } = await import('../src/schedule.mjs');
  const S = 1e12, h = [];
  // Three runs alone at a minute each, three beside another browser run at 2.5 minutes.
  for (let i = 0; i < 3; i++) h.push({ key: 'playwright|npx playwright test a', dur: 60e3, at: S + i * 3.6e6 });
  for (let i = 0; i < 3; i++) {
    const end = S + 20 * 3.6e6 + i * 3.6e6;
    h.push({ key: 'playwright|npx playwright test a', dur: 150e3, at: end }, { key: 'playwright|npx playwright test b', dur: 200e3, at: end + 10e3 });
  }
  assert.equal(slowdown(h, 'playwright|npx playwright test a', 'playwright'), 2.5);
  assert.equal(slowdown(h, 'test|npm test', 'playwright'), null, 'too few runs to say');
  const other = lease({ res: ['playwright'], key: 'playwright|npx playwright test b', who: 'b', start: T - 6e4 });
  const me = q({ res: ['playwright'], key: 'playwright|npx playwright test a', enq: T - 30e3 });
  const v = verdict({ leases: [other], queue: [me] }, me, cfg, h, T);
  assert.equal(v.rule, 'together');
  assert.match(v.why, /usually runs 2\.5x as long beside playwright work/);
  // Waited as long as it usually runs: it goes anyway.
  assert.equal(verdict({ leases: [other], queue: [{ ...me, enq: T - 10 * 6e4 }] }, { ...me, enq: T - 10 * 6e4 }, cfg, h, T).ok, true);
});

// 2026-10-21: most jobs that waited longer than they ran were checks of under a minute waiting tens of seconds for a browser slot.
test('a job whose command takes under 15 seconds (the quick lane) starts beside anything on a capacity resource, past full slots and the line', () => {
  const quick = Array.from({ length: 5 }, (_, i) => ({ key: 'playwright|npx playwright test smoke', dur: 6e3, at: i }));
  const full = [lease({ res: ['playwright'], who: 'a', mem: 0, cpu: 0 }), lease({ res: ['playwright'], who: 'b', mem: 0, cpu: 0 })];
  const ahead = q({ res: ['playwright'], enq: T - 10 * 6e4, key: 'playwright|npx playwright test big' });
  const me = q({ res: ['playwright'], key: 'playwright|npx playwright test smoke', mem: 0.5 * G, cpu: 1 });
  const v = verdict({ leases: full, queue: [ahead, me] }, me, cfg, quick, T);
  assert.equal(v.ok, true, v.why);
  assert.equal(v.quick, true);
  assert.equal(verdict({ leases: full, queue: [ahead, me] }, { ...me, key: 'never-seen' }, cfg, quick, T).ok, false, 'a command not measured waits its turn');
  // Never alongside on an exclusive resource: the one shared simulator, a deploy of the same (here unknown) repo.
  const dep = [lease({ res: ['deploy'], who: 'a', mem: 0, cpu: 0 })];
  const ship = Array.from({ length: 5 }, (_, i) => ({ key: 'deploy|./ship.sh', dur: 6e3, at: i }));
  assert.equal(verdict({ leases: dep, queue: [] }, q({ res: ['deploy'], key: 'deploy|./ship.sh' }), cfg, ship, T).rule, 'slot');
});

// 2026-10-22: a private simulator declared 6 GB, started with 6.0 GB free, and took the disk to 0.7 GB.
test('a job that usually eats disk waits for the floor plus what it eats while others run; alone, its declared disk will do', () => {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, diskFree: 7 * G });
  try {
    const c = { ...cfg, minDisk: '5G' };
    const key = 'sim-own|sh -c boot';
    const hist = [3, 2.5, 3].map((d, i) => ({ key, dur: 6e4, at: T - (3 - i) * 36e5, mem: G, ate: d * G }));
    const me = q({ res: ['sim-own'], disk: 6 * G, key });
    const busy = { leases: [lease({ res: ['test'], key: 'test|npm test' })], queue: [me] };
    const v = verdict(busy, me, c, hist, T);
    assert.equal(v.rule, 'disk', JSON.stringify(v));
    assert.equal(v.need, 8 * G, 'the 5 GB floor plus the 3 GB it usually eats');
    assert.notEqual(verdict({ leases: [], queue: [me] }, me, c, hist, T).rule, 'disk', 'alone: waiting frees nothing');
    // 2026-10-26: a streaming loader passed --disk 1G and still waited on 23 GB it had seemed to eat while paused.
    const said = { ...me, disk: G, diskDeclared: true };
    assert.notEqual(verdict({ ...busy, queue: [said] }, said, c, hist, T).rule, 'disk', 'its own --disk beats what earlier runs seemed to eat');
    const fresh = q({ res: ['sim-own'], disk: 6 * G, key: 'sim-own|sh -c other' });
    assert.equal(verdict({ ...busy, queue: [fresh] }, fresh, c, hist, T).rule, 'disk', 'a new command goes by what its resource eats');
    const deploy = q({ res: ['deploy'], key: 'deploy|ship' });
    const ate = [3, 3, 3].map(d => ({ key: 'deploy|ship', dur: 1e3, at: T - 1e3, ate: d * G }));
    // Until 2026-11-02 a resource that declared no disk was held only by the floor, and a deploy whose runs eat 3 GB started into a full disk.
    assert.equal(verdict({ ...busy, queue: [deploy] }, deploy, c, ate, T).rule, 'disk', 'a command whose own runs eat disk waits for it, whatever its resource declares');
  } finally { if (was == null) delete process.env.DIBS_FAKE_MACHINE; else process.env.DIBS_FAKE_MACHINE = was; }
});

// 2026-10-22: sessions and apps held 8 of 16 GB; dibs booked two 6 GB browser runs into the rest, and swap took the disk to 0.7 GB.
test('within the budget, a job still waits until the machine really has its memory, counting what running jobs booked and have not touched', () => {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memAvail: 4 * G });
  try {
    const c = { ...cfg, budget: '11G' };
    const running = lease({ res: ['test'], mem: 2 * G, use: { mem: 2 * G }, key: 'test|a' });
    const big = q({ res: ['playwright'], mem: 6 * G, key: 'playwright|b' });
    const v = verdict({ leases: [running], queue: [big] }, big, c, [], T);
    assert.equal(v.rule, 'memory', JSON.stringify(v));
    assert.match(v.why, /4\.0G free or reclaimable on the machine, you need 6\.0G/);
    const mid = q({ res: ['playwright'], mem: 3 * G, key: 'playwright|c' });
    assert.notEqual(verdict({ leases: [running], queue: [mid] }, mid, c, [], T).rule, 'memory', '3 GB fits in 4');
    const fresh = lease({ res: ['test'], mem: 3 * G, use: { mem: 0.5 * G, at: T }, key: 'test|d', start: T - 6e4 });
    assert.equal(verdict({ leases: [fresh], queue: [mid] }, mid, c, [], T).rule, 'memory', 'a job just started will still take the 2.5 GB it booked');
    // 2026-10-22: a ship's deploy and simulator, 20 minutes in at 0 GB, held four jobs on 5 GB they never took.
    const settled = lease({ res: ['test'], mem: 3 * G, use: { mem: 0.5 * G, at: T }, key: 'test|d', start: T - 20 * 6e4 });
    assert.notEqual(verdict({ leases: [settled], queue: [mid] }, mid, c, [], T).rule, 'memory', 'one 20 minutes in is done growing');
    assert.notEqual(verdict({ leases: [], queue: [big] }, big, c, [], T).rule, 'memory', 'alone it starts: waiting frees nothing');
    // Something started a minute ago, so the stall breaker isn't what lets it by.
    const old = { ...running, start: T - 20 * 6e4 };
    const busyNow = { leases: [old], queue: [big], lastStart: T + 9 * 6e4 };
    assert.equal(verdict({ ...busyNow, lastStart: T }, big, c, [], T + 6e4).rule, 'memory', 'a minute in, it still waits');
    // 2026-10-25: twenty 7 to 9 GB builds waited out 10 minutes each, then ran with free memory never under 31%.
    assert.notEqual(verdict(busyNow, big, c, [], T + 2 * 6e4).rule, 'memory', 'after 2 minutes with swap still, it goes');
    const justIn = lease({ res: ['sim-own'], mem: G, use: { mem: G, at: T + 2 * 6e4 }, key: 'sim-own|f', start: T + 1.5 * 6e4 });
    assert.equal(verdict({ ...busyNow, leases: [old, justIn] }, big, c, [], T + 2 * 6e4).rule, 'memory', 'not while a big job that just started is still missing from the readings');
    assert.notEqual(verdict({ ...busyNow, leases: [old, justIn] }, big, c, [], T + 5 * 6e4).rule, 'memory', 'once it shows, it goes');
    process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memAvail: 4 * G, swapUsed: 6 * G, swapGrowth: 2 * G, diskDrain: 0 });
    assert.ok(!verdict(busyNow, big, c, [], T + 2 * 6e4).ok, 'but not while swap grows');
    process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memAvail: 4 * G });
    // 2026-10-22: a ship's simulator step waited on the 2 GB its own deploy run had booked for it.
    const ship = lease({ res: ['deploy'], mem: 3 * G, use: { mem: 0.1 * G }, key: 'deploy|ship' });
    const step = q({ res: ['sim'], mem: 3 * G, key: 'sim|step', outer: ship.id });
    assert.notEqual(verdict({ leases: [running, ship], queue: [step] }, step, c, [], T).rule, 'memory', 'the booking of the run it sits in is its own');
    const tiny = q({ res: ['test'], mem: 0.4 * G, key: 'test|e' });
    process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memAvail: 0.1 * G });
    assert.notEqual(verdict({ leases: [running], queue: [tiny] }, tiny, c, [], T).rule, 'memory', 'a small job is let by');
  } finally { if (was == null) delete process.env.DIBS_FAKE_MACHINE; else process.env.DIBS_FAKE_MACHINE = was; }
});

test("vm_stat's free, inactive, speculative and purgeable pages are what a new job can take; the compressor's are not", async () => {
  const { vmAvail } = await import('../src/platform.mjs');
  const text = ['Mach Virtual Memory Statistics: (page size of 16384 bytes)', 'Pages free:  100.', 'Pages active:  900.', 'Pages inactive:  50.',
    'Pages speculative:  10.', 'Pages wired down:  400.', 'Pages purgeable:  5.', 'Pages occupied by compressor:  700.'].join('\n');
  assert.equal(vmAvail(text), 165 * 16384);
  assert.equal(vmAvail('garbage'), null);
});

// 2026-11-02: a job waited over 10 hours on memory, then failed for disk the moment it started.
test('a job whose own runs eat more disk than is free waits for disk even alone or on a resource that declares none, and a waiter held by something else hears disk is next', t => {
  const before = process.env.DIBS_FAKE_MACHINE;
  t.after(() => { process.env.DIBS_FAKE_MACHINE = before; });
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, diskFree: 6.5 * G });
  const key = 'deploy|ship.sh store';
  const hist = [1, 2, 3].map(i => ({ key, dur: 9e5, at: T - i * 36e5, ate: 6 * G }));
  const me = q({ res: ['deploy'], key, mem: 0.5 * G, enq: T });
  const alone = verdict({ leases: [], queue: [me] }, me, cfg, hist, T);
  assert.equal(alone.rule, 'disk');
  assert.equal(alone.need, 7 * G, 'alone: the 6 GB its runs eat and 1 GB to spare');
  assert.match(alone.why, /\(1\.0G to spare, plus the 6\.0G this usually takes; --disk <size> says this run needs less\)/);
  // Told in so many words, it's the job's own call.
  assert.equal(verdict({ leases: [], queue: [me] }, { ...me, disk: 1 * G, diskDeclared: true }, cfg, hist, T).ok, true);
  // Held on its turn behind another deploy: the disk it'll need at its turn is said now.
  const other = lease({ res: ['deploy'], key: 'deploy|other', mem: 0.5 * G });
  const behind = verdict({ leases: [other], queue: [me] }, me, cfg, hist, T);
  assert.equal(behind.rule, 'slot');
  assert.deepEqual(behind.diskNext, { free: 6.5 * G, need: 11 * G }, 'with another job running: the 5 GB floor plus its 6 GB');
  // A failed run that stopped early says nothing about what a whole one eats.
  const failed = hist.map(h => ({ ...h, ate: 0.01 * G, failed: true }));
  assert.equal(verdict({ leases: [], queue: [me] }, me, cfg, [...hist.slice(0, 2), ...failed], T).ok, true, 'two good runs are too few to judge by');
});

// 2026-11-02: on max pace (a ceiling of 15 on 10 cores) the load reached about 120. The reading
// was the smaller of the load average and the cores in use, and cores in use can't pass 10.
test('with every core busy, the load ceiling reads the load average, so it holds past the core count', t => {
  const c = { ...cfg, maxLoad: 15 };
  const me = q({ res: ['test'], spid: 88, enq: T });
  const s = { leases: [], queue: [me] };
  const before = process.env.DIBS_FAKE_MACHINE;
  t.after(() => { process.env.DIBS_FAKE_MACHINE = before; });
  const on = m => { process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, cores: 10, ...m }); return verdict(s, me, c, [], T); };
  assert.equal(on({ load: 120, busy: 9.8 }).rule, 'load', 'saturated: 120 runnable is 120');
  assert.equal(on({ load: 120, busy: 3 }).ok, true, 'a load of 120 on 3 busy cores is processes waiting on disk, not work');
  assert.equal(on({ load: 12, busy: 9.8 }).ok, true, 'under the ceiling');
});
