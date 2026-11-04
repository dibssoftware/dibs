// The quick lane: a command that runs in under quickUnder (15 s), learned or passed --quick,
// starts at once past the line, full shared slots, warning pressure, swap and the load
// ceiling; on the simulator, or a deploy of the same repo, it goes to the front instead.
// 2026-11-03, the person: "let one really really quick thing go instantly ... if it takes under 15 seconds".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict, quickPass, rank } from '../src/schedule.mjs';

const WIN = process.platform === 'win32';
const T = Date.now();
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, budget: '11G', cores: 10, ...o, resources: { ...DEFAULT_CONFIG.resources, ...o.resources } });
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['deploy'], who: `l${n}`, mem: 0.5 * G, cpu: 1, start: T - 60e3, pid: 1, key: 'deploy|ship.sh', ...o });
const waiter = o => ({ id: ++n, res: ['deploy'], who: 'me', mem: 0.5 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'deploy|bump.sh', kind: 'run', ...o });
const ROOMY = { memTotal: 16 * G, memFree: 67, load: 0, cores: 10, swapGrowth: 0, diskDrain: 0 };
function judge(s, me, c, m = {}, hist = []) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...ROOMY, ...m });
  try { return verdict(s, me, c, hist, T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}
const runs = (key, ...secs) => secs.map((d, i) => ({ key, dur: d * 1e3, who: 'x', at: T - (secs.length - i) * 6e4 }));

test('who gets the quick pass: --quick or an --est under 15 s the first time, then its runs decide, and a run over takes it away', () => {
  const c = cfg();
  assert.equal(quickPass(waiter({ quick: true }), [], c), true, '--quick is trusted the first time');
  assert.equal(quickPass(waiter({ est: 10e3 }), [], c), true, '--est 10s is as good as --quick');
  assert.equal(quickPass(waiter(), [], c), false, 'nothing to go on');
  assert.equal(quickPass(waiter(), runs('deploy|bump.sh', 6, 5, 7), c), true, 'learned: runs of 5 to 7 s');
  assert.equal(quickPass(waiter({ quick: true }), runs('deploy|bump.sh', 6, 5, 40), c), false, 'the last run went over: the pass is gone, --quick or not');
  assert.equal(quickPass(waiter(), runs('deploy|bump.sh', 6, 40, 5), c), true, 'one run under again, the middle under: it comes back');
  assert.equal(quickPass(waiter(), runs('deploy|bump.sh', 30, 40, 5), c), false, 'the middle still over');
  assert.equal(quickPass(waiter({ kind: 'hold', key: 'deploy|hold', quick: true }), [], c), false, 'a hold is no command');
  assert.equal(quickPass(waiter({ quick: true }), [], cfg({ quickUnder: null })), false, 'quickUnder null: no lane');
  assert.equal(quickPass(waiter(), runs('deploy|bump.sh', 20), cfg({ quickUnder: '30s' })), true, 'quickUnder sets the line');
});

test('a quick deploy of another repo starts beside a long deploy; one of the same repo goes to the front of the line', () => {
  const long = lease({ repo: '/src/api', key: 'deploy|testflight.sh' });
  const early = waiter({ who: 'early', enq: T - 10 * 6e4, key: 'deploy|other.sh', repo: '/src/web' });
  const other = waiter({ quick: true, repo: '/src/site' });
  const v = judge({ leases: [long], queue: [early, other] }, other, cfg());
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.quick, true);
  const same = waiter({ quick: true, repo: '/src/api' });
  assert.equal(judge({ leases: [long], queue: [early, same] }, same, cfg()).rule, 'slot', 'the same repo waits for its own deploy');
  // When the slot frees, it's first, ahead of a waiter that came ten minutes earlier.
  assert.equal(judge({ leases: [], queue: [early, same] }, same, cfg()).ok, true);
  assert.ok(rank({ ...same, quickPass: true }, [], T) < rank(early, [], T));
  assert.equal(judge({ leases: [], queue: [early, same] }, early, cfg()).ok, true, 'the earlier one, judged alone, could go too');
  // quickAlongside is the resource's own word: without it (and one deploy per machine, exclusiveBy null), a deploy is one at a time for everyone.
  const plain = cfg({ resources: { deploy: { ...DEFAULT_CONFIG.resources.deploy, quickAlongside: null, exclusiveBy: null } } });
  assert.equal(judge({ leases: [long], queue: [other] }, other, plain).rule, 'slot');
});

test('on the simulator a quick job never runs alongside: it waits for the slot at the front of the line', () => {
  const shot = lease({ res: ['sim'], key: 'sim|./shots.sh', mem: 3 * G });
  const early = waiter({ res: ['sim'], who: 'early', enq: T - 10 * 6e4, key: 'sim|./ui.sh', mem: 3 * G });
  const quick = waiter({ res: ['sim'], quick: true, quickPass: true, key: 'sim|xcrun simctl openurl', mem: 3 * G });
  assert.equal(judge({ leases: [shot], queue: [early, quick] }, quick, cfg()).rule, 'slot');
  const v = judge({ leases: [], queue: [early, quick] }, early, cfg());
  assert.equal(v.rule, 'ahead', 'the earlier waiter now waits behind the quick one');
  assert.equal(v.ahead.id, quick.id);
});

test('the quick lane passes full shared slots, warning pressure, swap and the load ceiling, but not the disk floor, critical pressure or another agent\'s hold', () => {
  const busy = [lease({ res: ['test'], key: 'test|npm test' }), lease({ res: ['test'], key: 'test|npm test' }), lease({ res: ['test'], key: 'test|npm test' })];
  const me = waiter({ res: ['test'], key: 'test|node --test one', quick: true, mem: 2 * G });
  const s = { leases: busy, queue: [me] };
  assert.equal(judge(s, me, cfg()).ok, true, 'past three full test slots');
  assert.equal(judge(s, { ...me, quick: false }, cfg()).rule, 'slot', 'without the pass it waits');
  assert.equal(judge(s, me, cfg(), { vmPressure: 1 }).ok, true, 'warning pressure');
  assert.equal(judge(s, me, cfg(), { swapUsed: 6 * G, swapGrowth: 1.2 * G }).ok, true, 'swap growing');
  assert.equal(judge(s, me, cfg({ maxLoad: 5 }), { load: 30, busy: 10 }).ok, true, 'the load ceiling');
  assert.equal(judge(s, me, cfg(), { vmPressure: 2 }).rule, 'pressure', 'critical pressure still holds it');
  assert.equal(judge(s, me, cfg(), { diskFree: 0.5 * G }).rule, 'disk', 'the 1 GB a deploy keeps free still holds it');
  const held = lease({ kind: 'hold', res: ['test'], pid: 9, spid: 9, expires: T + 6e5 });
  assert.equal(judge({ leases: [held], queue: [me] }, me, cfg({ resources: { test: { ...DEFAULT_CONFIG.resources.test, slots: 1 } } })).rule, 'slot', 'someone else holds it');
});

test('at most 2 quick jobs at once: a third waits like anyone', () => {
  const full = [1, 2, 3].map(() => lease({ res: ['test'], key: 'test|npm test' }));
  const quickOnes = [1, 2].map(() => lease({ res: ['test'], key: 'test|lint', quick: true }));
  const me = waiter({ res: ['test'], key: 'test|node --test one', quick: true });
  assert.equal(judge({ leases: [...full, quickOnes[0]], queue: [me] }, me, cfg()).ok, true, 'one quick running: room for another');
  assert.equal(judge({ leases: [...full, ...quickOnes], queue: [me] }, me, cfg()).rule, 'slot', 'two running: the lane is full');
});

test('a quick run goes first, shows as quick on the board, and one that runs over is told it lost the pass', { skip: WIN }, async t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ quickUnder: '1s', resources: { t: { slots: 1, mem: '0.1G', cpu: 1 } } }));
  const gate = path.join(h, 'gate');
  const first = bg(t, h, ['run', 't', '--', 'sh', '-c', `while [ ! -f '${gate}' ]; do sleep 0.1; done`], { agent: 'long' });
  await until(() => board(h).held.length === 1);
  // Over the 1s line whatever happens: it runs at least 1.2 s.
  const quick = bg(t, h, ['run', 't', '--quick', '--', 'sh', '-c', `sleep 1.2; while [ ! -f '${gate}.q' ]; do sleep 0.1; done`], { agent: 'fast' });
  await until(() => board(h).held.some(l => l.who === 'fast'));
  const row = board(h).held.find(l => l.who === 'fast');
  assert.equal(row.quick, true);
  assert.equal(row.plain.alongside, 'Quick: it runs in seconds, so it went first');
  assert.match(sync(h, ['--detail'], { agent: 'viewer' }).out, /quick: it runs in seconds, so it went first/);
  fs.writeFileSync(`${gate}.q`, '');
  assert.equal(await quick.done, 0, quick.err);
  assert.match(quick.err.replace(/\n +/g, ' '), /over the 1s the quick lane is for, so its next runs wait their turn until one finishes in under 1s/);
  // The pass is gone: the same command now waits for the slot.
  const again = sync(h, ['run', 't', '--quick', '--max-wait', '1s', '--', 'sh', '-c', `sleep 1.2; while [ ! -f '${gate}.q' ]; do sleep 0.1; done`], { agent: 'fast' });
  assert.equal(again.code, 75, again.err);
  fs.writeFileSync(gate, '');
  assert.equal(await first.done, 0);
});
