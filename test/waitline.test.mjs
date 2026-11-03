// What a waiting job is told, and that every command tells it the same:
// one line per real change, places gained and lost with the reason, and
// nothing that reads as a cue to raise priority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board, flat } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { swapWhy, loadWhy, diskSqueeze } from '../src/schedule.mjs';
import { plainBoard, whyLines } from '../src/plain.mjs';
import { talker, movedText } from '../src/acquire.mjs';

const WIN = process.platform === 'win32';
const T = Date.now();
const MIN = 6e4;
const cfg = { ...DEFAULT_CONFIG, budget: '8G', roomyMemFree: 101, resources: { ...DEFAULT_CONFIG.resources } };
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['test'], who: `l${n}`, mem: 2 * G, cpu: 1, start: T - 2 * MIN, pid: 1, key: 'k', est: 5 * MIN, ...o });
const waiter = o => ({ id: ++n, res: ['test'], who: `w${n}`, agent: `w${n}`, mem: 2 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'test|x', kind: 'run', est: 3 * MIN, ...o });
function onMachine(m, fn) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, swapGrowth: 0, diskDrain: 0, ...m });
  try { return fn(); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}

test('a waiter behind one that waits on memory has no start time either, and says what the one ahead waits for', () => {
  // A slot is free, but the budget is used up: the first waiter waits on memory, the second on the first.
  // Two test slots, one in use: the first waiter gets the open one, so the second waits on it.
  const two = { ...cfg, resources: { ...cfg.resources, test: { ...cfg.resources.test, slots: 2 } } };
  const s = { leases: [lease({ mem: 7 * G })], queue: [] };
  const a = waiter({ enq: T - MIN }), b = waiter({ mem: 0.5 * G, est: 10 * MIN });
  s.queue.push(a, b);
  const p = onMachine({}, () => plainBoard(s, two, [], T));
  const wb = p.waiting.get(b.id);
  assert.equal(p.waiting.get(a.id).startsText, 'unknown');
  assert.equal(wb.startsText, 'unknown', 'not "under a minute": the one ahead is stuck on the machine');
  assert.equal(wb.family, 'memory');
  assert.match(wb.waitingFor, new RegExp(`^${a.who} to go first, and it's waiting for room in memory: it needs 2\\.0 GB`));
  assert.match(whyLines(p, b, two)[0], /Start time unknown/);
});

// The first job is measured within a moment (DIBS_SAMPLE_MS), as a slow machine gets round to it
// sooner or later. Measured at next to nothing, it leaves room in the budget for the waiter, which
// then starts if the machine has the memory: here it doesn't, so memory holds the line however
// long the three reads below take. On 2026-11-02 that ran past the first measurement once in 3
// suites, and the waiter had started by the third read.
test('dibs when, dibs why and the wait agree while memory holds the line', { skip: WIN }, async t => {
  const h = tmp(t), cwd = tmp(t, 'job');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ budget: '4G', cores: 10, roomyMemFree: 101 }));
  const env = { DIBS_SAMPLE_MS: '100', DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, memFree: 10 }) };
  const first = bg(t, h, ['run', 'heavy', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { agent: 'a', cwd, env });
  await until(() => board(h, { env }).held[0]?.use);
  const w = bg(t, h, ['run', 'test', '--', 'true'], { agent: 'b', env });
  await until(() => board(h, { env }).waiting.length === 1);
  const when = flat(sync(h, ['when', 'test'], { agent: 'c', env }).out);
  const why = flat(sync(h, ['why'], { agent: 'b', env }).out);
  const detail = flat(sync(h, ['why', '--detail'], { agent: 'b', env }).out);
  assert.match(when, /start time unknown/);
  assert.doesNotMatch(when, /under a minute/);
  assert.match(why, /Start time unknown/);
  assert.match(detail, /start time unknown \(it waits on the machine, not a job\)/);
  assert.doesNotMatch(detail, /expect to start/);
  await until(() => /Keep waiting: raising the priority is not the fix/.test(flat(w.err)));
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await first.done, 0);
  assert.equal(await w.done, 0);
});

test('two readings of one crunch taking turns print nothing new; a real change prints once it holds', () => {
  const talk = talker();
  const line = (key, place = 3, ahead = [1, 2]) => ({ key, place, res: 'test', ahead, moved: '' });
  let t = T;
  assert.equal(talk.step(line('memory|test'), t), 'full');
  // Memory pressure and the budget take turns every poll for a minute: one kind of wait.
  for (let i = 0; i < 40; i++) assert.equal(talk.step(line('memory|test'), (t += 1500)), null);
  // The line flickers between waiting on the queue and on memory: no new line either.
  for (let i = 0; i < 20; i++) assert.equal(talk.step(line(i % 2 ? 'line|test' : 'memory|test'), (t += 1500)), null);
  // It really changes: said on the third poll in a row.
  assert.equal(talk.step(line('disk|test'), (t += 1500)), null);
  assert.equal(talk.step(line('disk|test'), (t += 1500)), null);
  assert.equal(talk.step(line('disk|test'), (t += 1500)), 'change');
  assert.equal(talk.step(line('disk|test'), (t += 1500)), null);
  // A move is said at most every 30 seconds after the last thing said about its place.
  const up = { ...line('disk|test', 2, [1]), moved: 'moved up from 3rd to 2nd in the test queue.' };
  assert.equal(talk.step(up, (t += 1500)), null);
  assert.equal(talk.step(up, (t += 30e3)), 'moved');
  assert.equal(talk.told.place, 2);
  // Nothing new for two minutes: said again.
  assert.equal(talk.step(line('disk|test', 2, [1]), (t += 2 * MIN + 1)), 'repeat');
});

test('a place lost says who went ahead and why; low priority says normal work that arrives later goes first', () => {
  const me = waiter({ prio: 'low', enq: T - 5 * MIN });
  const old = waiter({ enq: T - 6 * MIN });
  const late = waiter({ enq: T, est: undefined });
  const s = { leases: [lease()], queue: [old, me, late] };
  const p = onMachine({}, () => plainBoard(s, { ...cfg, resources: { ...cfg.resources, test: { ...cfg.resources.test, slots: 1 } } }, [], T));
  const w = p.waiting.get(me.id);
  assert.equal(w.place, 3);
  const moved = movedText(s, me, w, { place: 2, res: 'test', ahead: new Set([old.id]) }, cfg, [], T);
  assert.equal(moved, `moved back from 2nd to 3rd in the test queue. ${late.agent} went ahead: you're low priority, so normal jobs that arrive later go ahead of you.`);
  assert.equal(movedText(s, me, { ...w, place: 1, ahead: [] }, { place: 3, res: 'test', ahead: new Set() }, cfg, [], T), 'moved up from 3rd to 1st in the test queue.');
  assert.ok(w.moves.some(m => /low priority, so normal jobs that arrive later go ahead of it/.test(m.reason)));
});

test('no wait on the machine reads as a hint to raise priority', () => {
  const words = [
    swapWhy({ rule: 'pressure', level: 'critical' }),
    swapWhy({ rule: 'swap', grew: G, used: 6 * G, limit: 4 * G }),
    loadWhy({ load: 9, ahead: 0 }, { maxLoad: 8 }),
    diskSqueeze({ ...cfg }, 5 * G, { diskFree: 7 * G, swapUsed: 8 * G, swapGrowth: G, diskDrain: 0 }).why,
    diskSqueeze({ ...cfg }, 5 * G, { diskFree: 7 * G, swapUsed: 0, swapGrowth: 0, diskDrain: 5 * G, drainMs: 5 * MIN }).why,
  ];
  const s = { leases: [lease()], queue: [] };
  for (const m of [{ vmPressure: 2 }, { swapUsed: 6 * G, swapGrowth: G }, { diskFree: 7 * G, swapUsed: 2 * G, swapGrowth: G }, { diskFree: 7 * G, diskDrain: 5 * G }, { load: 20 }]) {
    const q = waiter();
    const p = onMachine(m, () => plainBoard({ ...s, queue: [q] }, { ...cfg, maxLoad: 8 }, [], T));
    const w = p.waiting.get(q.id);
    assert.ok(w.advice, JSON.stringify(m));
    words.push(w.waitingFor, w.advice);
  }
  for (const x of words) assert.doesNotMatch(x, /urgent|below urgent|high priority/i, x);
});
