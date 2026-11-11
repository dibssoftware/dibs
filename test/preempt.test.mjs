// Pausing low-priority work: real processes stopped and continued, and the
// pure rules (who may be paused, pressure hysteresis) without processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, G, tmp, sync as dibs, bg as spawnDibs, until, board, track, wait, flat, allStopped, noneStopped, groupTree, posixOnly } from './helpers.mjs';
import { pausable, preempt, pressureStep, flush, diskStep, diskPausesPerPass } from '../src/preempt.mjs';
import { pstart } from '../src/proc.mjs';
import { pressureOnce, diskOnce } from '../src/cool.mjs';
import { verdict, remaining, pausedFor, used } from '../src/schedule.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { withState } from '../src/state.mjs';
import { inKernelOrStopped } from '../src/platform.mjs';

const WIN = process.platform === 'win32';

const CONFIG = { resources: {
  t: { slots: 1, mem: '0.1G', cpu: 1, pausable: true },
  t2: { slots: 2, mem: '0.1G', cpu: 1, pausable: true },
  d: { slots: 1, mem: '0.1G', cpu: 1, pausable: false },
} };
function home(h) {
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(CONFIG));
  return h;
}
const sync = (h, agent, args) => dibs(h, args, { agent });

// A job that counts as fast as it can, so a stopped one is easy to see.
function counter(t, h, agent, res, prio = 'low') {
  const file = path.join(h, `count-${agent}`);
  const p = spawnDibs(t, h, [res, '-p', prio, '--', 'sh', '-c', `i=0; while :; do i=$((i+1)); echo $i > '${file}'; sleep 0.05; done`], { agent });
  p.count = () => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; } };
  p.lease = () => board(h).held.find(l => l.who === agent);
  p.agent = agent;
  return p;
}
// Its group paused: nothing in it still running. Checking the leader alone missed it on Linux,
// where a loop shell sits in D, not T, while the vfork child the stop caught is stopped (2026-10-25).
const stopped = pgid => allStopped(pgid);
// Paused: every process in its group stopped. Running again: none stopped.
// Watching the counter instead failed under the full suite's load, where a low
// job at background priority can go 30 seconds without a core (helpers.mjs).
// A stop sent to a process waiting for a core lands when it next runs, so a job at background
// priority that the load starves reads as running until then: under a full suite with other work
// on the machine, more than 10 s (2026-11-03). 45 s is past the longest such starving seen in a suite.
const paused = p => until(() => allStopped(p.lease()?.pgid), 45e3);
async function runs(p, ms = 30e3) {
  const pgid = p.lease()?.pgid;
  try { await until(() => noneStopped(pgid), ms); } catch { throw new Error(`${p.agent} is still stopped after ${ms}ms:\n${groupTree(pgid)}`); }
}
test('defaults: sim, xcode-build and deploy never pause; test, heavy and playwright can', () => {
  const r = DEFAULT_CONFIG.resources;
  for (const x of ['sim', 'xcode-build', 'deploy']) assert.equal(r[x].pausable, false, x);
  for (const x of ['test', 'heavy', 'playwright']) assert.equal(r[x].pausable, true, x);
  assert.equal(DEFAULT_CONFIG.unknown.pausable, false);
});

test('only low and idle runs on pausable resources can be paused', () => {
  const cfg = { ...DEFAULT_CONFIG, ...CONFIG, resources: { ...DEFAULT_CONFIG.resources, ...CONFIG.resources } };
  const l = o => ({ kind: 'run', pgid: 123, res: ['t'], prio: 'low', ...o });
  assert.equal(pausable(l(), cfg), !WIN);
  assert.equal(pausable(l({ prio: 'idle' }), cfg), !WIN);
  for (const prio of [undefined, 'normal', 'high', 'urgent']) assert.equal(pausable(l({ prio }), cfg), false, String(prio));
  assert.equal(pausable(l({ res: ['d'] }), cfg), false);
  assert.equal(pausable(l({ res: ['t', 'd'] }), cfg), false);   // every resource must allow it
  assert.equal(pausable(l({ res: ['sim'] }), cfg), false);
  assert.equal(pausable(l({ kind: 'hold' }), cfg), false);
  assert.equal(pausable(l({ pgid: null }), cfg), false);
  // A normal waiter never pauses anyone, and a waiter facing a normal holder pauses nothing.
  const s = { leases: [l({ id: 1, start: 0 })], queue: [] };
  assert.equal(preempt(s, { id: 2, res: ['t'], prio: 'normal', mem: 0, cpu: 1, enq: 0, key: 'k' }, cfg, []), null);
  const s2 = { leases: [l({ id: 1, prio: 'normal', start: 0 })], queue: [] };
  assert.equal(preempt(s2, { id: 2, res: ['t'], prio: 'urgent', mem: 0, cpu: 1, enq: 0, key: 'k' }, cfg, []), null);
  assert.equal(s2.leases[0].pauses, undefined);
});

test('a lent slot frees cores but not memory, and a paused clock stops', () => {
  const cfg = { ...DEFAULT_CONFIG, roomyMemFree: 101, budget: '4G', cores: 4,
    resources: { ...DEFAULT_CONFIG.resources, ...CONFIG.resources } };
  const T = 1e12;
  const paused = { id: 1, kind: 'run', res: ['t'], mem: 3 * G, cpu: 4, prio: 'low', start: T - 60e3, pausedAt: T - 30e3, pausedMs: 10e3,
                   pauses: [{ lease: 2 }], est: 120e3, key: 'k' };
  const s = { leases: [paused], queue: [] };
  const me = q => ({ id: 3, res: ['t2'], enq: T, key: 'x', pid: 1, ...q });
  assert.equal(verdict(s, me({ mem: 0.5 * G, cpu: 4 }), cfg, [], T).ok, true);   // its 4 cores are lent
  assert.equal(verdict(s, me({ mem: 2 * G, cpu: 1 }), cfg, [], T).rule, 'memory');   // its 3G isn't
  assert.equal(pausedFor(paused, T), 40e3);
  assert.equal(remaining(paused, [], T), 120e3 - 20e3);   // ran 60s, 40s of it paused
});

test('pressure: two critical readings in a row pause, six normal ones resume, a warning resets both', () => {
  const tr = { high: 0, low: 0 };
  const feed = levels => levels.map(x => pressureStep(tr, x));
  assert.deepEqual(feed([2]), [null]);
  assert.deepEqual(feed([2]), ['pause']);
  assert.deepEqual(feed([2, 1, 2]), [null, null, null]);   // a warning in between restarts the count
  assert.deepEqual(feed([2]), ['pause']);
  assert.deepEqual(feed([0, 0, 0, 0, 0, 1]), Array(6).fill(null));   // not quite long enough, then a warning
  assert.deepEqual(feed([0, 0, 0, 0, 0, 0]), [null, null, null, null, null, 'resume']);
  assert.deepEqual(feed([null, null]), [null, null]);   // no reading: nothing changes
  assert.deepEqual(feed([0, 2, 0, 2]), [null, null, null, null]);   // flapping does nothing
});

// 2026-11-03: under a DMG build a paused low job's shell sat in U (macOS's uninterruptible wait,
// its writes throttled behind the build's), so it read as still running and the pause as never landing.
test('a process in the kernel counts as stopped: a stop already sent takes it as it leaves (D on Linux, U on macOS)', () => {
  for (const st of ['T', 'T+', 'Z', 'D', 'U', 'UN', 'Us']) assert.equal(inKernelOrStopped(st), true, st);
  for (const st of ['R', 'S', 'Ss', 'SN', 'R+', 'I']) assert.equal(inKernelOrStopped(st), false, st);
});

test('an urgent waiter pauses a low job, borrows its slot, and resumes it when done', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const h = home(tmp(t));
  const low = counter(t, h, 'lo', 't');
  await until(() => low.lease()?.pgid);
  const pgid = low.lease().pgid;
  // The urgent job runs until the checks below are done, however slow the machine is.
  const gate = path.join(h, 'urgent-may-finish');
  const urgent = spawnDibs(t, h, ['t', '-p', 'urgent', '-m', 'prod is down', '--', 'sh', '-c', `while [ ! -f '${gate}' ]; do sleep 0.1; done`], { agent: 'boss' });
  await until(() => board(h).held.some(l => l.who === 'boss'));
  // The stop goes out once the state is written, so the board can show boss a moment before it lands.
  await paused(low);
  const l = low.lease();
  assert.ok(l.pausedAt);
  assert.equal(l.pauses[0].who, 'boss');
  assert.match(sync(h, 'viewer', ['--detail']).out, /paused for boss/);
  assert.match(flat(sync(h, 'viewer', []).out), /lo is paused so boss's urgent job could go first/);
  fs.writeFileSync(gate, '');
  assert.equal(await urgent.done, 0);
  assert.match(urgent.err, /paused lo's low priority job on t so you could start\. It picks up again when you're done\./);
  await until(() => !low.lease().pausedAt);
  assert.equal(stopped(pgid), false);
  await runs(low);
  assert.equal(low.lease().id, l.id, 'same lease throughout');
  await until(() => /resumed your job/.test(low.err));
  assert.match(low.err, /paused your job for boss \(urgent: "prod is down"\)/);
});

test('the low job resumes when the urgent job crashes, on the next state read', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const h = home(tmp(t));
  const low = counter(t, h, 'lo', 't', 'idle');
  await until(() => low.lease()?.pgid);
  const urgent = spawnDibs(t, h, ['t', '-p', 'high', '-m', 'release', '--', 'sleep', '30'], { agent: 'boss' });
  await until(() => board(h).held.some(l => l.who === 'boss'));
  // What dibs decided, not when the stop lands: the stop reaches an idle job only when it next
  // gets a core, and at load 14-16 (2026-11-04) that took over 30 s. Stopped or still pending,
  // the resume below ends it (a SIGCONT discards a stop not yet taken). The pause landing is
  // the test above's to check.
  await until(() => low.lease()?.pausedAt);
  assert.equal(low.lease().pauses[0].who, 'boss');
  urgent.kill('SIGKILL');   // no release path at all
  await urgent.done;
  await until(() => !low.lease().pausedAt);   // board reads reap the dead lease and resume
  assert.equal(stopped(low.lease().pgid), false, 'SIGCONT landed');
  await runs(low);
});

test('normal work and opted-out resources are never paused', async t => {
  const h = home(tmp(t));
  const normal = counter(t, h, 'norm', 't', 'normal');
  const optout = counter(t, h, 'dep', 'd', 'low');
  await until(() => normal.lease()?.pgid && optout.lease()?.pgid);
  for (const res of ['t', 'd']) {
    const r = sync(h, 'boss', [res, '-p', 'urgent', '-m', 'now', '--no-wait', '--', 'true']);
    assert.equal(r.code, 75, res);
  }
  await runs(normal);
  await runs(optout);
  assert.ok(board(h).held.every(l => !l.pausedAt));
});

test('nothing pauses when pausing would not let the waiter start', async t => {
  const h = home(tmp(t));
  const jobs = [counter(t, h, 'a', 't2'), counter(t, h, 'b', 't2'), counter(t, h, 'n', 'd', 'normal')];
  await until(() => jobs.every(p => p.lease()?.pgid));
  // t2 is free once one job pauses, but d is held by normal work.
  assert.equal(sync(h, 'boss', ['t2,d', '-p', 'urgent', '-m', 'now', '--no-wait', '--', 'true']).code, 75);
  assert.ok(board(h).held.every(l => !l.pausedAt));
  for (const p of jobs) await runs(p);
});

test('only as many jobs pause as the waiter needs', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const h = home(tmp(t));
  const a = counter(t, h, 'a', 't2'), b = counter(t, h, 'b', 't2');
  await until(() => [a, b].every(p => p.lease()?.pgid));
  // Two slots, both held: one pause frees enough. The board shows who while the waiter runs.
  const urgent = spawnDibs(t, h, ['t2', '-p', 'urgent', '-m', 'now', '--', 'sleep', '30'], { agent: 'boss' });
  await until(() => board(h).held.some(l => l.who === 'boss'));
  assert.equal(board(h).held.filter(l => l.pausedAt).length, 1);
  urgent.kill('SIGTERM');
  await urgent.done;
  await until(() => board(h).held.every(l => !l.pausedAt));
  await runs(a); await runs(b);
});

test('memory pressure pauses idle and low jobs, biggest first, and resumes them when it eases', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  // pressureOnce works on the in-process state, so the jobs share the in-process home.
  const h = home(HOME);
  const cfg = JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, resources: { ...DEFAULT_CONFIG.resources, ...CONFIG.resources } }));
  const small = counter(t, h, 'small', 't');
  const big = spawnDibs(t, h, ['t2', '-p', 'low', '--mem', '1G', '--', 'sh', '-c', 'while :; do sleep 0.05; done'], { agent: 'big' });
  Object.assign(big, { agent: 'big', lease: () => board(h).held.find(l => l.who === 'big') });
  const norm = counter(t, h, 'norm', 'd', 'normal');
  const lease = who => board(h).held.find(l => l.who === who);
  await until(() => ['small', 'big', 'norm'].every(w => lease(w)?.pgid));
  let level = 2;
  const tr = { high: 0, low: 0 };
  const step = () => pressureOnce(cfg, tr, () => level);
  assert.equal(step(), null);   // one critical reading isn't enough
  assert.equal(step().leases[0].who, 'big');
  // What dibs recorded, not whether the stop has landed yet: a stop sent to a job at background
  // priority lands when it next gets a core, which under a full suite can be many seconds.
  assert.ok(lease('big').pausedAt, 'recorded as paused');
  assert.equal(lease('small').pausedAt, undefined);
  step();
  assert.equal(step().leases[0].who, 'small');
  await paused(small);
  step();
  assert.equal(step(), null);   // nothing left to pause: normal work stays
  await runs(norm);
  assert.match(sync(h, 'viewer', ['--detail']).out, /paused: memory pressure/);
  assert.match(sync(h, 'viewer', []).out, /paused because the machine is short on memory/);
  level = 1;
  for (let i = 0; i < 10; i++) assert.equal(step(), null);   // warning: hold steady
  level = 0;
  const acts = [];
  for (let i = 0; i < 12; i++) { const r = step(); if (r) acts.push(r.leases[0].who); }   // room for two resumes
  assert.deepEqual(acts, ['small', 'big']);   // lighter first
  await runs(small);
  assert.equal(lease('big').pausedAt, undefined, 'recorded as running again');
  await runs(big);
  // A watcher that dies leaves nothing stopped: the next state read resumes.
  level = 2;
  step(); step();
  assert.ok(lease('big').pausedAt);
  const dead = spawnSync('true').pid;
  withState(s => { for (const l of s.leases) for (const p of l.pauses || []) p.watcher = dead; });
  await until(() => !lease('big').pausedAt);
  await runs(big);
});

test('free disk under minDisk with swap still growing pauses running work below high, newest first, two a pass when it falls fast, and resumes it once there is room', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  // diskOnce works on the in-process state, so the jobs share the in-process home.
  const h = HOME;
  const resources = { ...CONFIG.resources, w: { slots: 4, mem: '0.1G', cpu: 1, pausable: true }, hi: { slots: 1, mem: '0.1G', cpu: 1, pausable: true } };
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources }));
  const cfg = JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, resources: { ...DEFAULT_CONFIG.resources, ...resources } }));
  const lease = who => board(h).held.find(l => l.who === who);
  // Started one at a time, so newest first has an order to follow.
  const jobs = {};
  for (const [who, prio] of [['low', 'low'], ['oldest', 'normal'], ['older', 'normal'], ['newest', 'normal']]) {
    jobs[who] = counter(t, h, who, 'w', prio);
    await until(() => lease(who)?.pgid);
  }
  const boss = spawnDibs(t, h, ['hi', '-p', 'high', '-m', 'release', '--', 'sh', '-c', 'while :; do sleep 0.05; done'], { agent: 'boss' });
  await until(() => lease('boss')?.pgid);
  const tr = { diskOk: 0 };
  let m;
  const step = () => diskOnce(cfg, tr, m);
  const who = r => r?.leases.map(l => l.who);
  // Under minDisk (5G) with swap growing, still well over the old 3 GB line: one a pass.
  m = { diskFree: 4.5 * G, swapGrowth: 1.5 * G, diskDrain: 0, drainMs: 0 };
  assert.deepEqual(who(step()), ['low'], 'low before normal');
  assert.deepEqual(who(step()), ['newest'], 'then normal work, newest first');
  // Falling 2 GB a minute (08:14 to 08:16 UTC on 2026-10-15): down to 1 GB inside two minutes, so two a pass.
  m = { diskFree: 2.9 * G, swapGrowth: 1.5 * G, diskDrain: 4.2 * G, drainMs: 2 * 6e4 };
  assert.deepEqual(who(step()), ['older', 'oldest']);
  assert.equal(step(), null, 'high work is never paused');
  assert.ok(stopped(lease('older').pgid));
  await paused(jobs.oldest);
  assert.equal(lease('boss').pausedAt, undefined);
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, /paused: disk low/);
  assert.match(flat(dibs(h, [], { agent: 'viewer' }).out), /paused because free disk is low and swap is still growing on it/i);
  // Memory pressure easing doesn't resume what the disk paused.
  const mem = { high: 0, low: 0 };
  for (let i = 0; i < 12; i++) assert.equal(pressureOnce(cfg, mem, () => 0), null);
  // Still under minDisk, swap no longer growing: they stay paused.
  m = { diskFree: 4 * G, swapGrowth: 0, diskDrain: 0, drainMs: 0 };
  for (let i = 0; i < 12; i++) assert.equal(step(), null);
  // At minDisk and steady: one resumes each minute of readings.
  m = { diskFree: 5 * G, swapGrowth: 0, diskDrain: 0, drainMs: 0 };
  let resumed = 0;
  for (let i = 0; i < 24; i++) resumed += step()?.leases.length || 0;
  assert.equal(resumed, 4);
  for (const p of Object.values(jobs)) await runs(p);
  boss.kill('SIGTERM');
  await boss.done;
});

test('the disk pause line is minDisk, never under 3 GB, and two pause a pass only when free disk would reach 1 GB within two minutes', () => {
  const growing = { swapGrowth: 1 * G, diskDrain: 0, drainMs: 0 };
  const at = (free, minDisk, m = growing) => diskStep({ diskOk: 0 }, { diskFree: free, ...m }, { ...DEFAULT_CONFIG, minDisk });
  assert.equal(at(7 * G, '8G'), 'pause', 'a bigger minDisk pauses sooner');
  assert.equal(at(4.9 * G, '5G'), 'pause');
  assert.equal(at(5.1 * G, '5G'), null);
  assert.equal(at(2.9 * G, '1G'), 'pause', 'a small minDisk: 3 GB still counts');
  assert.equal(at(3.1 * G, '1G'), null);
  assert.equal(at(4 * G, '5G', { swapGrowth: 0, diskDrain: 0 }), null, 'not filling: nothing to pause');
  assert.equal(at(4 * G, '5G', { swapGrowth: 0, diskDrain: 3.5 * G, drainMs: 5 * 6e4 }), 'pause', 'draining, swap or not');
  // 2 GB a minute with 4.5 GB free: 1 GB in under two minutes. 0.5 GB a minute: not yet.
  assert.equal(diskPausesPerPass({ diskFree: 4.5 * G, diskDrain: 4 * G, drainMs: 2 * 6e4 }), 2);
  assert.equal(diskPausesPerPass({ diskFree: 4.5 * G, diskDrain: 2.5 * G, drainMs: 5 * 6e4 }), 1);
  assert.equal(diskPausesPerPass({ diskFree: 4.5 * G, diskDrain: 0 }), 1, 'swap growing, disk not falling yet');
  assert.equal(diskPausesPerPass({ diskFree: 0.8 * G, diskDrain: 0.1 * G, drainMs: 5 * 6e4 }), 2, 'already under 1 GB');
});

const MERGED = { ...DEFAULT_CONFIG, resources: { ...DEFAULT_CONFIG.resources, ...CONFIG.resources,
  a: { slots: 1, mem: '0.1G', cpu: 1, pausable: true }, b: { slots: 1, mem: '0.1G', cpu: 1, pausable: true } } };
// A lease that names a process that isn't its own (pgstart doesn't match), so nothing is ever signalled.
const fakeRun = o => ({ kind: 'run', pgid: 999999, pgstart: 'never', prio: 'low', mem: 0, cpu: 1, start: 0, ...o });

test('a paused lease lends only the slots its waker needs; its other slots stay taken', () => {
  const T = 1e12;
  const l = fakeRun({ id: 1, res: ['a', 'b'], pausedAt: T, pauses: [{ lease: 2, res: ['a'] }] });
  const s = { leases: [l, fakeRun({ id: 2, res: ['a'], prio: 'urgent' })], queue: [] };
  assert.equal(used(s, 'a'), 1);   // the urgent job's, not the paused one's
  assert.equal(used(s, 'b'), 1);   // still the paused job's: it needs it back when it resumes
  assert.equal(verdict(s, { id: 3, res: ['b'], enq: T, key: 'x', pid: 1, mem: 0, cpu: 1 }, MERGED, [], T).rule, 'slot');
});

test('a run its own hold covers is never picked to pause: that frees no slot', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, () => {
  const T = 1e12;
  const hold = { id: 1, kind: 'hold', res: ['t2'], pid: 50, mem: 0, cpu: 1, start: 0, expires: T * 2 };
  const covered = fakeRun({ id: 2, res: ['t2'], spid: 50, covered: ['t2'], start: 30 });   // newest, so first in line without the fix
  const other = fakeRun({ id: 3, res: ['t2'], spid: 60, start: 10 });
  const s = { leases: [hold, covered, other], queue: [] };
  const v = preempt(s, { id: 4, res: ['t2'], prio: 'urgent', enq: T, key: 'k', pid: 1, mem: 0, cpu: 1 }, MERGED, [], T);
  flush(false);
  assert.ok(v?.ok);
  assert.deepEqual(v.paused.map(p => p.id), [3]);
  assert.equal(covered.pauses, undefined);
});

test('pause signals go out only once the state that explains them is written', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async () => {
  const job = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const gone = new Promise(r => job.on('exit', r));
  try {
    const t = Date.now();
    const lease = { id: 9001, kind: 'run', res: ['t'], prio: 'low', mem: 0, cpu: 1, start: t, pid: process.pid, pstart: pstart(process.pid),
      pgid: job.pid, pgstart: pstart(job.pid), who: 'lo', cmd: 'sleep 30', key: 'k' };
    const me = { id: 9002, res: ['t'], prio: 'urgent', purpose: 'now', enq: t, key: 'k', pid: process.pid, mem: 0, cpu: 1, who: 'boss' };
    withState(s => { s.leases.push(lease); });
    // A change that fails part way sends nothing, so nothing is left stopped without a record.
    assert.throws(() => withState(s => { assert.ok(preempt(s, me, MERGED, [])); throw new Error('crashed'); }), /crashed/);
    assert.equal(stopped(job.pid), false);
    withState(s => {
      assert.ok(preempt(s, me, MERGED, []));
      s.leases.push({ ...me, kind: 'run', start: t, pstart: pstart(process.pid) });   // as acquire does
      assert.equal(stopped(job.pid), false, 'not before the write');
    });
    assert.ok(stopped(job.pid), 'stopped after it');
    withState(s => { s.leases = s.leases.filter(l => l.id !== 9002); });   // the urgent job ends: resume
    assert.equal(stopped(job.pid), false);
  } finally {
    withState(s => { s.leases = s.leases.filter(l => l.id !== 9001 && l.id !== 9002); });
    job.kill('SIGKILL');
    await gone;
  }
});

test('a paused lease whose owner died takes its stopped groups with it', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const job = track(t, spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }));
  t.after(() => job.kill('SIGKILL'));   // stopped, it would sit out a SIGTERM
  process.kill(-job.pid, 'SIGSTOP');
  const dead = spawnSync('true').pid;
  // Paused for an urgent job that's still running. Its root group is gone; the
  // stopped group was found at pause time and never tracked.
  withState(s => { s.leases.push(
    { id: 9004, kind: 'run', res: ['t'], prio: 'urgent', mem: 0, cpu: 1, start: Date.now(), pid: process.pid, pstart: pstart(process.pid), who: 'boss', key: 'k' },
    { id: 9003, kind: 'run', res: ['t'], prio: 'low', mem: 0, cpu: 1, start: Date.now(), pid: process.pid, pstart: pstart(process.pid),
      pgid: dead, pausedAt: Date.now(), pauses: [{ lease: 9004, res: ['t'] }], stopped: [job.pid], who: 'lo', cmd: 'sleep', key: 'k' }); });
  withState(s => { s.leases.find(l => l.id === 9003).pid = dead; });   // its owner dies
  withState(s => { s.leases = s.leases.filter(l => l.id !== 9004); });
  await until(() => job.exitCode !== null || job.signalCode !== null, 3000);
});

test('a lease whose process number now belongs to someone else stops nothing', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async () => {
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const gone = new Promise(r => other.on('exit', r));
  try {
    const t = Date.now();
    // The job dibs started has ended and its number was reused: the start time doesn't match.
    withState(s => { s.leases.push({ id: 9005, kind: 'run', res: ['t'], prio: 'low', mem: 0, cpu: 1, start: t, pid: process.pid, pstart: pstart(process.pid),
      pgid: other.pid, pgstart: 'an earlier process', who: 'lo', cmd: 'x', key: 'k' }); });
    withState(s => {
      assert.ok(preempt(s, { id: 9006, res: ['t'], prio: 'urgent', purpose: 'now', enq: t, key: 'k', pid: process.pid, mem: 0, cpu: 1, who: 'boss' }, MERGED, []));
      s.leases.push({ id: 9006, kind: 'run', res: ['t'], prio: 'urgent', mem: 0, cpu: 1, start: t, pid: process.pid, pstart: pstart(process.pid), who: 'boss', key: 'k' });
    });
    assert.equal(stopped(other.pid), false);
  } finally {
    withState(s => { s.leases = s.leases.filter(l => l.id !== 9005 && l.id !== 9006); });
    other.kill('SIGKILL');
    await gone;
  }
});
