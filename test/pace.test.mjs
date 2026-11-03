// pace and the load ceiling: how hard dibs drives the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board, wait, flat } from './helpers.mjs';
import { DEFAULT_CONFIG, paceKnobs, loadConfig, paths } from '../src/config.mjs';
import { verdict } from '../src/schedule.mjs';

// Switching the pace is the person's call (src/owner.mjs).
const OWNER = { env: { DIBS_OWNER: '1' } };
const config = (h, c) => fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(c));
let n = 0;
const q = (o = {}) => ({ id: ++n, res: ['t'], mem: 0, cpu: 1, disk: 0, pid: 1, who: `a${n}`, enq: Date.now(), key: 'k', ...o });

// Runs fn with the in-process fake machine changed, then puts it back.
function withMachine(o, fn) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...o });
  try { return fn(); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}

test('the three paces on a 10-core 16 GB Mac', () => {
  const hw = { cores: 10, mem: 16 * G };
  assert.deepEqual(paceKnobs('quiet', hw), { cores: 4, budget: '6.5G', maxLoad: 5, coolLoad: 5, roomyLoad: 0, roomyMemFree: 35 });
  assert.deepEqual(paceKnobs('normal', hw), { cores: 6, budget: '8G', maxLoad: 10, coolLoad: 8, roomyLoad: 0.6, roomyMemFree: 35 });
  assert.deepEqual(paceKnobs('max', hw), { cores: 15, budget: '12G', maxLoad: 15, coolLoad: 12, roomyLoad: 0, roomyMemFree: 25 });
});

test('a pace sets the knobs, and a knob someone changed in config.json wins over it', () => {
  // A file dibs wrote holds every stock value: those don't count as choices.
  fs.writeFileSync(paths.config, JSON.stringify({ ...DEFAULT_CONFIG, pace: 'quiet', cores: 3, maxLoad: 7 }));
  const c = withMachine({ cores: 10, memTotal: 16 * G }, loadConfig);
  assert.equal(c.cores, 3);
  assert.equal(c.maxLoad, 7);
  assert.equal(c.budget, '6.5G');
  assert.equal(c.coolLoad, 5);
  assert.equal(c.roomyLoad, 0);
  fs.rmSync(paths.config);
});

test('without a pace or maxLoad, a loaded machine starts work as before', () => {
  fs.writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG));
  const c = loadConfig();
  for (const k of ['cores', 'budget', 'coolLoad', 'roomyLoad', 'roomyMemFree']) assert.equal(c[k], DEFAULT_CONFIG[k]);
  assert.equal(c.maxLoad, null);
  const me = q();
  assert.equal(withMachine({ load: 50 }, () => verdict({ leases: [], queue: [me] }, me, c, [])).ok, true);
  fs.rmSync(paths.config);
});

test('over maxLoad, normal work waits and says why; urgent work still starts', async t => {
  const h = tmp(t);
  config(h, { maxLoad: 4 });
  const w = bg(t, h, ['run', 't', '--', 'true'], { agent: 'w', load: 6 });
  await until(() => board(h, { load: 6 }).waiting.length === 1);
  assert.match(sync(h, ['why'], { agent: 'w', load: 6 }).out, /Waiting for the machine to cool down \(load 6\.0; new work waits while it's over 4\)\./);
  assert.match(sync(h, ['why', '--detail'], { agent: 'w', load: 6 }).out, /blocked by load: load 6\.0 is over maxLoad 4/);
  assert.match(sync(h, ['--detail'], { load: 6 }).out, /over the load ceiling/);
  assert.match(flat(sync(h, [], { load: 6 }).out), /This machine +too busy for new work: .* Nothing new starts until the machine cools down \(load 6\.0, over maxLoad 4\)\. Keep waiting: raising the priority is not the fix/);
  assert.doesNotMatch(sync(h, [], { load: 6 }).out, /urgent/, 'nothing on the board reads as a cue to raise priority');
  const u = sync(h, ['run', 't', '-p', 'urgent', '-m', 'prod is down', '--', 'true'], { agent: 'u', load: 6 });
  assert.equal(u.code, 0, u.err);
  w.kill();
});

test("a burst of starts can't all slip in under one load reading", async t => {
  const h = tmp(t);
  // Each start adds about a core that the 1-minute load doesn't show yet, so
  // with the reading stuck at 0 the fourth start takes it past 3 and the rest wait.
  config(h, { maxLoad: 3, resources: { b: { slots: 6, cpu: 1, mem: '0.1G' } } });
  const gate = path.join(h, 'gate');
  const ps = Array.from({ length: 6 }, (_, i) => bg(t, h, ['run', 'b', '--', 'sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done`], { agent: `j${i}` }));
  // Six arriving at once first queue behind each other, so the count settles
  // over a poll or two: wait for four running, then check nobody else gets in.
  await until(() => { const b = board(h); return b.held.length === 4 && b.waiting.length === 2; });
  // Two poll intervals (1.5s each) with the reading still at 0: a fifth start would show by now.
  await wait(3500);
  const b = board(h);
  assert.equal(b.held.length, 4);
  assert.equal(b.waiting.length, 2);
  fs.writeFileSync(gate, '');
  assert.deepEqual(await Promise.all(ps.map(p => p.done)), [0, 0, 0, 0, 0, 0]);
});

test('a job started minutes ago is already in the load reading, so it no longer counts on top', () => {
  const cfg = { ...DEFAULT_CONFIG, maxLoad: 3 };
  const me = q();
  const lease = start => ({ id: ++n, res: ['x'], mem: 0, cpu: 2, kind: 'run', pid: 1, who: 'h', start, key: 'k' });
  withMachine({ load: 2 }, () => {
    assert.equal(verdict({ leases: [lease(Date.now())], queue: [me] }, me, cfg, []).rule, 'load');
    assert.equal(verdict({ leases: [lease(Date.now() - 5 * 6e4)], queue: [me] }, me, cfg, []).ok, true);
  });
});

test('over the ceiling, a high waiter passes the normal waiters it holds back', () => {
  const cfg = { ...DEFAULT_CONFIG, maxLoad: 4 };
  const old = q({ enq: Date.now() - 70 * 6e4 });   // 70 minutes in line: ahead of a fresh high request, which moves up an hour
  const hi = q({ prio: 'high', purpose: 'release' });
  withMachine({ load: 9 }, () => {
    assert.equal(verdict({ leases: [], queue: [old, hi] }, old, cfg, []).rule, 'load');
    assert.equal(verdict({ leases: [], queue: [old, hi] }, hi, cfg, []).ok, true);
  });
});

test('over the ceiling, a waiter that holds a lease starts like high work', () => {
  const cfg = { ...DEFAULT_CONFIG, maxLoad: 4 };
  const old = q({ enq: Date.now() - 20 * 6e4 });
  const ship = q({ holding: { res: ['deploy'], purpose: 'ship' } });
  withMachine({ load: 9 }, () => {
    assert.equal(verdict({ leases: [], queue: [old, ship] }, old, cfg, []).rule, 'load');
    assert.equal(verdict({ leases: [], queue: [old, ship] }, ship, cfg, []).ok, true);
  });
});

test('dibs pace switches the pace and the board shows it', t => {
  const h = tmp(t);
  const set = sync(h, ['pace', 'quiet'], OWNER);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /^Speed: quiet, on this machine \(8 cores, /);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8')).pace, 'quiet');
  assert.match(sync(h, ['--detail']).out.split('\n')[0], /^pace quiet, /);
  assert.match(sync(h, []).out, /^This machine {3}quiet: .*, speed set to quiet$/m);
  assert.equal(board(h).machine.maxLoad, 4);   // the fake machine has 8 cores
  assert.equal(sync(h, ['pace', 'fast'], OWNER).code, 2);
  assert.equal(sync(h, ['pace', 'off'], OWNER).code, 0);
  assert.doesNotMatch(sync(h, []).out, /pace/);
});

test('dibs pace --json: the pace, the knobs in force and what each pace sets, for the Mac app', t => {
  const h = tmp(t);
  const read = () => JSON.parse(sync(h, ['pace', '--json']).out);
  assert.equal(read().pace, null);
  assert.equal(sync(h, ['pace', 'quiet'], OWNER).code, 0);
  const j = read();
  assert.deepEqual(Object.keys(j), ['pace', 'hardware', 'knobs', 'pinned', 'paces', 'overlap']);
  assert.equal(j.pace, 'quiet');
  assert.equal(j.knobs.maxLoad, 4);   // the fake machine has 8 cores
  assert.deepEqual(Object.keys(j.paces), ['quiet', 'normal', 'max']);
  assert.deepEqual(j.paces.quiet, paceKnobs('quiet', j.hardware));
  assert.deepEqual(j.pinned, []);
});

// 2026-10-21: a vitest run that usually takes a second waited 99 s on the load ceiling at load 42.
test('over the ceiling, a job in the instant lane (under 15 seconds) starts; a longer one waits', () => {
  const cfg = { ...DEFAULT_CONFIG, maxLoad: 4 };
  const hist = Array.from({ length: 5 }, (_, i) => ({ key: 'test|pnpm exec / vitest run', dur: 1000, at: i }));
  const quick = q({ res: ['test'], key: 'test|pnpm exec / vitest run' });
  const slow = q({ res: ['test'], key: 'test|npm test' });
  withMachine({ load: 9 }, () => {
    assert.equal(verdict({ leases: [], queue: [quick] }, quick, cfg, hist).ok, true);
    assert.equal(verdict({ leases: [], queue: [slow] }, slow, cfg, hist).rule, 'load');
  });
});
