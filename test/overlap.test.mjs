// Running jobs side by side on a full resource when the machine has room (src/overlap.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board } from './helpers.mjs';
import { DEFAULT_CONFIG, loadConfig, paths } from '../src/config.mjs';
import { verdict } from '../src/schedule.mjs';
import { pressurePause, pressureResume, flush } from '../src/preempt.mjs';
import { commandKey } from '../src/acquire.mjs';

const WIN = process.platform === 'win32';
// A 16 GB machine with half its memory free and nothing on its cores: roomy, so the budgets don't apply.
const ROOM = { memTotal: 16 * G, memFree: 50, load: 0, cores: 8 };
const KEY = 't|npm test';
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, overlap: 'fit',
  resources: { ...DEFAULT_CONFIG.resources, t: { slots: 1, mem: '2G', cpu: 2, pausable: true } }, ...o });
// One test run going for two minutes, so its memory is already in the free reading.
const holder = o => ({ id: 1, kind: 'run', res: ['t'], who: 'first', mem: 2 * G, cpu: 2, start: Date.now() - 120e3, pid: 1, ...o });
const waiter = o => ({ id: 2, res: ['t'], who: 'second', mem: 2 * G, cpu: 2, disk: 0, pid: 1, enq: Date.now(), key: KEY, kind: 'run', ...o });
const ran = (o = {}) => ({ key: KEY, dur: 300e3, who: 'x', at: 0, fit: true, mem: G, cpu: 1.5, ...o });
const config = (h, c) => fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(c));

function withMachine(o, fn) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...o });
  try { return fn(); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}
const judge = (s, me, c, hist, m = {}) => withMachine({ ...ROOM, ...m }, () => verdict(s, me, c, hist));

test('fit: a second test run starts next to the first when what it really uses fits, and waits when it does not', () => {
  const s = { leases: [holder()], queue: [waiter()] };
  const v = judge(s, s.queue[0], cfg(), [ran()]);
  assert.equal(v.ok, true);
  assert.equal(v.alongside.kind, 'fit');
  assert.deepEqual(v.alongside.with, ['first']);
  // 8G free, 2.4G of it kept spare (minFreeMem 15%), leaves 5.6G.
  const big = judge(s, s.queue[0], cfg(), [ran({ mem: 6 * G })]);
  assert.equal(big.rule, 'slot');
  assert.equal(big.alongside, "Can't run alongside: it usually needs 6.0 GB of memory and 5.6 GB is free.");
  const hot = judge(s, s.queue[0], cfg({ maxLoad: 4 }), [ran()], { load: 3 });
  assert.equal(hot.rule, 'slot');
  assert.match(hot.alongside, /usually keeps 1\.5 cores busy, and that would take the machine from 3\.\d past its busy limit of 4/);
});

test('fit: a job never measured and given no --mem has an unknown cost and waits; one that says --mem may start', () => {
  const s = { leases: [holder()], queue: [waiter()] };
  const v = judge(s, s.queue[0], cfg(), []);
  assert.equal(v.rule, 'slot');
  assert.match(v.alongside, /hasn't measured this command yet and it gave no --mem/);
  const said = waiter({ declared: true, mem: G });
  assert.equal(judge({ ...s, queue: [said] }, said, cfg(), []).ok, true);
});

test('a job on top takes no slot: when the slot frees, the next waiter gets it', () => {
  const top = holder({ id: 3, who: 'top', alongside: { kind: 'fit', res: ['t'], with: ['first'], mem: G } });
  const next = waiter({ key: 't|big' });
  assert.equal(judge({ leases: [top], queue: [next] }, next, cfg(), []).ok, true);
});

test('exclusive resources never overlap, however much room there is', () => {
  const hist = ['sim', 'deploy', 'sim-own', 'mylock', 'mine', 'reset'].map(r => ran({ key: `${r}|npm test` }));
  const c = cfg({ overlap: 'squeeze', resources: { ...DEFAULT_CONFIG.resources, mine: { slots: 1, exclusive: true },
    reset: { slots: 1, onRelease: 'true' }, 'sim-own': { ...DEFAULT_CONFIG.resources['sim-own'], slots: 1 } } });
  for (const r of ['sim', 'deploy', 'sim-own', 'mylock', 'mine', 'reset']) {
    const me = waiter({ res: [r], key: `${r}|npm test` });
    const v = judge({ leases: [holder({ res: [r] })], queue: [me] }, me, c, hist);
    assert.equal(v.ok, false, r);
    assert.match(v.alongside, /^Can't run alongside: the .*queue runs one job at a time\.$/, r);
  }
});

test('squeeze: a job that usually takes seconds starts next to a busy one; an unknown or slow one waits', () => {
  const c = cfg({ overlap: 'squeeze', maxLoad: 4 });
  const s = { leases: [holder()], queue: [waiter()] };
  // Its cores would take the load past the ceiling, so it doesn't fit; it's quick, so it squeezes in anyway.
  const quick = [ran({ dur: 20e3 }), ran({ dur: 40e3 }), ran({ dur: 30e3 })];
  const v = judge(s, s.queue[0], c, quick, { load: 3 });
  assert.equal(v.ok, true);
  assert.equal(v.alongside.kind, 'squeeze');
  assert.equal(v.alongside.usually, 30e3);
  const slow = judge(s, s.queue[0], c, [ran({ dur: 120e3 })], { load: 3 });
  assert.equal(slow.rule, 'slot');
  assert.match(slow.alongside, /past its busy limit/);
  assert.match(judge(s, s.queue[0], c, [], { load: 3 }).alongside, /can't tell whether it fits\. Pass --mem the first time/);
  // --est is the job's own word, not history, so it doesn't squeeze in; under 15 s it's the quick lane's (src/schedule.mjs quickPass).
  const said = waiter({ est: 5e3 });
  const q = judge({ ...s, queue: [said] }, said, c, [], { load: 3 });
  assert.deepEqual([q.ok, q.quick, q.alongside], [true, true, undefined]);
  assert.equal(judge({ ...s, queue: [waiter({ est: 20e3 })] }, waiter({ est: 20e3 }), c, [], { load: 3 }).ok, false);
  // Quick, but its memory doesn't fit: it waits.
  assert.equal(judge(s, s.queue[0], c, [ran({ dur: 20e3, mem: 7 * G })], { load: 3 }).ok, false);
  // fit alone doesn't let quick jobs past the load.
  assert.equal(judge(s, s.queue[0], { ...c, overlap: 'fit' }, quick, { load: 3 }).ok, false);
  // Once the load is already past the ceiling, not even a quick job squeezes in.
  assert.equal(judge(s, s.queue[0], c, quick, { load: 6 }).rule, 'load');
});

test('off without a pace; the paces set it, and overlap in config.json wins', () => {
  const read = c => { fs.writeFileSync(paths.config, JSON.stringify(c)); try { return loadConfig().overlap; } finally { fs.rmSync(paths.config); } };
  assert.equal(read(DEFAULT_CONFIG), 'off');
  assert.equal(read({}), 'off');
  assert.equal(read({ ...DEFAULT_CONFIG, pace: 'quiet' }), 'off');
  assert.equal(read({ ...DEFAULT_CONFIG, pace: 'normal' }), 'fit');
  assert.equal(read({ ...DEFAULT_CONFIG, pace: 'max' }), 'squeeze');
  assert.equal(read({ ...DEFAULT_CONFIG, pace: 'max', overlap: 'off' }), 'off');
  assert.equal(read({ ...DEFAULT_CONFIG, overlap: 'fit' }), 'fit');
  // Off: a full slot is just a full slot, and why says nothing about overlap.
  const s = { leases: [holder()], queue: [waiter()] };
  const v = judge(s, s.queue[0], { ...cfg(), overlap: 'off' }, [ran()]);
  assert.equal(v.rule, 'slot');
  assert.equal(v.alongside, undefined);
});

test('dibs pace says what each pace does with overlap, and anyone, agent or person, can switch it', t => {
  const h = tmp(t);
  const show = sync(h, ['pace']);
  assert.match(show.out, /^Side by side: no\. A job waits for its turn when its queue is full\.$/m);
  assert.match(show.out, /^ {2}normal .* if they fit /m);
  assert.match(show.out, /^ {2}max .* squeeze in /m);
  const set = sync(h, ['pace', 'normal'], { env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /^Side by side: when they fit\. A job may start next to the ones filling its queue/m);
  assert.equal(JSON.parse(sync(h, ['pace', '--json']).out).overlap, 'fit');
});

test('jobs started in the last few seconds count at their size before the free reading shows them', () => {
  // 5.6G of room by the reading; a 4G job that started a second ago hasn't taken its memory yet.
  const fresh = holder({ id: 3, res: ['other'], who: 'fresh', mem: 4 * G, start: Date.now() - 1000 });
  const s = { leases: [holder(), fresh], queue: [waiter()] };
  const v = judge(s, s.queue[0], cfg(), [ran({ mem: 2 * G })]);
  assert.equal(v.ok, false);
  assert.match(v.alongside, /usually needs 2\.0 GB of memory and 1\.6 GB is free/);
  // Measured at 3G already: only the last 1G is still to come.
  fresh.use = { mem: 3 * G };
  assert.equal(judge(s, s.queue[0], cfg(), [ran({ mem: 2 * G })]).ok, true);
  // A minute in, it's in the reading.
  delete fresh.use; fresh.start = Date.now() - 60e3;
  assert.equal(judge(s, s.queue[0], cfg(), [ran({ mem: 2 * G })]).ok, true);
  // Cores: three runs that just started aren't in the load average yet.
  const burst = [3, 4, 5].map(id => holder({ id, res: ['other'], who: `b${id}`, mem: 0, cpu: 2, start: Date.now() - 500 }));
  const b = judge({ leases: [holder(), ...burst], queue: [waiter()] }, waiter(), cfg({ maxLoad: 6 }), [ran()]);
  assert.equal(b.ok, false);
  assert.match(b.alongside, /take the machine from 6\.\d past its busy limit of 6/);
});

test('overlap reads history and cores the way the budgets do', () => {
  // History written before keys grew (util.mjs runsOf) counts for size and for how long it usually takes.
  const me = waiter({ key: 't|npm test / run lint' });
  const s = { leases: [holder()], queue: [me] };
  assert.equal(judge(s, me, cfg(), [ran()]).ok, true);
  const quick = [20e3, 40e3, 30e3].map(dur => ran({ dur }));
  assert.equal(judge(s, me, cfg({ overlap: 'squeeze', maxLoad: 4 }), quick, { load: 3 }).alongside.kind, 'squeeze');
  // A build planned at the 8G budget that usually uses 12G and started a second ago will take 12G, not 8G.
  const big = holder({ id: 3, res: ['other'], who: 'big', mem: 8 * G, usual: 12 * G, start: Date.now() - 1000, use: { mem: 6 * G } });
  const room = { memFree: 60 };   // 9.6G free, 2.4G kept spare: 1.2G left if it takes 12G, 5.2G if 8G
  // A budget big enough that only the free reading decides (a job on top always faces the budget).
  const roomBudget = cfg({ budget: '16G' });
  assert.equal(judge({ leases: [holder(), big], queue: [me] }, me, roomBudget, [ran({ mem: 3 * G })], room).ok, false);
  assert.equal(judge({ leases: [holder(), { ...big, usual: undefined }], queue: [me] }, me, roomBudget, [ran({ mem: 3 * G })], room).ok, true);
  // A job on top still fits the CPU budget, which counts running jobs at the cores they're measured using (schedule.mjs coresOf).
  const tight = cfg({ cores: 4, roomyLoad: 0 });
  const asked4 = holder({ cpu: 4 });
  assert.equal(judge({ leases: [asked4], queue: [me] }, me, tight, [ran()]).rule, 'cpu');
  assert.equal(judge({ leases: [{ ...asked4, use: { mem: G, cpu: 1 } }], queue: [me] }, me, tight, [ran()]).alongside.kind, 'fit');
});

test('under memory pressure, jobs on top pause first, newest first, and resume last', { skip: WIN }, () => {
  // Names a process that isn't its own (pgstart doesn't match), so nothing is ever signalled.
  const run = o => ({ kind: 'run', pgid: 999999, pgstart: 'never', res: ['test'], mem: G, cpu: 1, start: 0, ...o });
  const on = { kind: 'fit', res: ['test'], with: ['x'], mem: G };
  const s = { leases: [
    run({ id: 1, prio: 'idle', mem: 4 * G, use: { mem: 6 * G } }),
    run({ id: 2, start: 1000, alongside: on }),
    run({ id: 3, start: 2000, alongside: on }),
    run({ id: 4, start: 3000, res: ['xcode-build'], alongside: { ...on, res: ['xcode-build'] } }),   // xcode-build never pauses
    run({ id: 5 }),   // normal work, not on top: never paused
  ], queue: [] };
  const cfg = DEFAULT_CONFIG;
  assert.deepEqual([1, 2, 3, 4].map(() => pressurePause(s, cfg)?.id), [3, 2, 1, undefined]);
  assert.deepEqual([1, 2, 3].map(() => pressureResume(s)[0]?.id), [1, 2, 3]);
  flush(false);
});

test('the real CLI: a measured test run starts alongside a busy one, the board says so, and why explains a refusal', async t => {
  const h = tmp(t);
  config(h, { overlap: 'fit', resources: { t: { slots: 1, mem: '0.1G', cpu: 1, pausable: true } } });
  const gate = path.join(h, 'gate');
  const loop = ['sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done`];
  const machine = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, ...ROOM }) } };
  const first = bg(t, h, ['run', 't', '--', ...loop], { agent: 'first', ...machine });
  await until(() => board(h).held.length === 1);
  // The second command has run before and used 0.5G at its peak; the third used 7G.
  const light = ['sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done; echo light`];
  const heavy = ['sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done; echo heavy`];
  fs.writeFileSync(path.join(h, 'history.jsonl'), [light, heavy].map((c, i) =>
    JSON.stringify({ key: `t|${commandKey(c)}`, dur: 120e3, who: 'x', at: Date.now(), fit: true, mem: [0.5, 7][i] * G, cpu: 0.5 })).join('\n') + '\n');
  assert.notEqual(commandKey(light), commandKey(heavy));
  const second = bg(t, h, ['run', 't', '--', ...light], { agent: 'second', ...machine });
  // The lease is on the board a moment before its dibs says so on stderr.
  await until(() => /the t queue is full/.test(second.err));
  assert.match(second.err, /the t queue is full, so this runs alongside first: it needs about 0\.5 GB of memory, and there's room\./);
  assert.equal(board(h).held.length, 2);
  assert.match(sync(h, [], machine).out.replace(/\s+/g, ' '), /first and second are using it, .*\(second is running alongside first, since the machine had room\)/);
  assert.match(sync(h, ['--detail'], machine).out, /second .*\[running alongside first\]/);
  const third = bg(t, h, ['run', 't', '--', ...heavy], { agent: 'third', ...machine });
  await until(() => board(h).waiting.length === 1);
  assert.match(sync(h, ['why'], { agent: 'third', ...machine }).out, /Can't run alongside: it usually needs 7\.0 GB of memory and \d+\.\d GB is free\./);
  fs.writeFileSync(gate, '');
  assert.deepEqual(await Promise.all([first.done, second.done, third.done]), [0, 0, 0]);
});
