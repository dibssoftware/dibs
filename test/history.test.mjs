// dibs history: the event log real runs write, the numbers made from it, its
// rotation, and the --json shape the Mac app reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync as dibs, bg as spawnDibs, until, board, track, env, BIN, posixOnly } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { summarize, verdict } from '../src/history.mjs';
import { clock } from '../src/util.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

// 3s on Windows, where the first look at the line can take longer than a second.
const LIMIT = { DIBS_MAX_WAIT: process.platform === 'win32' ? '3s' : '1s' };
const CONFIG = { resources: { t: { slots: 1, mem: '0.1G', cpu: 1, pausable: true } } };
const sync = (h, agent, args) => dibs(h, args, { agent, env: LIMIT });
const bg = (t, h, agent, args) => spawnDibs(t, h, args, { agent, env: LIMIT });
const events = h => {
  try { return fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};
const home = t => { const h = tmp(t); fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(CONFIG)); return h; };

// Holds t until the test says so: `release()` ends the holder's command.
async function holder(t, h, agent = 'a', args = []) {
  const gate = path.join(h, `gate-${agent}`);
  const p = bg(t, h, agent, ['t', ...args, '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done`]);
  await until(() => board(h).held.some(l => l.who === agent));
  p.release = () => fs.writeFileSync(gate, '');
  return p;
}

test('real runs record start, end with the exit code, a wait, and a timeout with how long it waited', async t => {
  const h = home(t);
  assert.equal(sync(h, 'a', ['t', '--', 'sh', '-c', 'exit 3']).code, 3);
  const a = await holder(t, h);
  assert.equal(sync(h, 'late', ['t', '--', 'true']).code, 75);
  const b = bg(t, h, 'b', ['t', '--wait', '--', 'true']);
  await until(() => events(h).some(e => e.kind === 'wait' && e.who === 'b'));
  a.release();
  assert.equal(await b.done, 0, b.err);
  await until(() => events(h).some(e => e.kind === 'end' && e.who === 'b'));

  const ev = events(h);
  const first = ev.find(e => e.kind === 'end' && e.who === 'a');
  assert.equal(first.code, 3);
  assert.deepEqual(first.res, ['t']);
  assert.equal(first.type, 'run');
  assert.ok(first.ms >= 0 && first.paused === 0);
  assert.ok(ev.some(e => e.kind === 'start' && e.who === 'a' && e.id === first.id));
  const out = ev.find(e => e.kind === 'timeout');
  assert.equal(out.who, 'late');
  assert.ok(out.ms >= 1000, `waited ${out.ms}ms`);
  assert.ok(ev.some(e => e.kind === 'wait' && e.who === 'late' && e.id === out.id));
  const start = ev.find(e => e.kind === 'start' && e.who === 'b');
  assert.ok(start.ms > 0);
  // Why it waited: the slot, for about as long as it waited.
  assert.ok(start.held?.slot > 0 && start.held.slot <= start.ms, JSON.stringify(start.held));
  assert.equal(ev.find(e => e.kind === 'wait' && e.who === 'b').rule, 'slot');
  assert.ok(ev.findIndex(e => e.kind === 'end' && e.who === 'a' && e.id !== first.id) < ev.indexOf(start), 'the holder ends before b starts');
  // A run that started at once had no wait.
  assert.ok(!ev.some(e => e.kind === 'wait' && e.who === 'a'));
});

test('a job paused for urgent work records the pause, the resume, and its paused time at the end', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const h = home(t);
  await holder(t, h, 'lo', ['-p', 'low']);
  // Only a job whose group is on record can be paused; before that, the urgent run would wait out its 1 s limit.
  await until(() => board(h).held.find(l => l.who === 'lo')?.pgid);
  const { pgid } = board(h).held.find(l => l.who === 'lo');
  const urgent = bg(t, h, 'boss', ['t', '-p', 'urgent', '-m', 'prod is down', '--', 'sleep', '0.5']);
  assert.equal(await urgent.done, 0, urgent.err);
  await until(() => events(h).some(e => e.kind === 'resume'));
  // Ended from outside: at background priority, under load, the job can go 30 s and more
  // without a core to notice a gate file (2026-11-01).
  process.kill(-pgid, 'SIGKILL');
  await until(() => events(h).some(e => e.kind === 'end' && e.who === 'lo'));
  const ev = events(h);
  assert.ok(ev.some(e => e.kind === 'pause' && e.who === 'lo' && e.prio === 'low'));
  assert.ok(ev.find(e => e.kind === 'resume').ms >= 400);
  assert.ok(ev.find(e => e.kind === 'end' && e.who === 'lo').paused >= 400);
});

test('the owner\'s boost, cap, answer and hours show in dibs history --json as override events', async t => {
  const h = home(t);
  const person = args => dibs(h, args, { agent: 'person', env: { DIBS_OWNER: '1' } });
  const a = await holder(t, h, 'lo', ['-p', 'low']);
  const { id } = board(h).held.find(l => l.who === 'lo');
  assert.equal(person(['boost', String(id), 'high']).code, 0);
  assert.equal(person(['cap', 'pushy', 'low']).code, 0);
  const q = Number(dibs(h, ['question', 'Ship it to testers?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'tests pass', '--one-way', 'it can not be taken back once done'], { agent: 'asker' }).out);
  assert.equal(person(['answer', String(q), 'yes']).code, 0);
  assert.equal(person(['hours', '09:00-23:00']).code, 0);
  a.release();
  const r = sync(h, 'viewer', ['history', '--json']);
  assert.equal(r.code, 0, r.err);
  const acts = JSON.parse(r.out).events.filter(e => e.kind === 'override');
  assert.deepEqual(acts.map(e => e.act), ['boost', 'cap', 'answer', 'hours']);
  assert.equal(acts[0].id, id);
  assert.deepEqual([acts[0].from, acts[0].prio], ['low', 'high']);
  assert.deepEqual([acts[1].who, acts[1].prio], ['pushy', 'low']);
  assert.deepEqual([acts[2].question, acts[2].answer], [q, 'yes']);
  assert.deepEqual(acts[3].hours, { start: '09:00', end: '23:00' });
});

test('a crashed run is recorded as ended, with no exit code, by whoever reads the state next', async t => {
  const h = home(t);
  const p = bg(t, h, 'gone', ['t', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  p.kill('SIGKILL');
  await p.done;
  await until(() => board(h).held.length === 0);
  const end = events(h).find(e => e.kind === 'end');
  assert.equal(end.who, 'gone');
  assert.equal(end.code, null);
});

test('when the event log can\'t be written, the run still runs and exits with its own code', async t => {
  const h = home(t);
  fs.mkdirSync(path.join(h, 'events.jsonl'));   // a folder where the file goes: every append fails
  const r = sync(h, 'a', ['t', '--', 'sh', '-c', 'echo ran; exit 4']);
  assert.equal(r.code, 4, r.err);
  assert.equal(r.out, 'ran\n');
  const a = await holder(t, h);
  assert.equal(sync(h, 'late', ['t', '--', 'true']).code, 75);
  a.release();
  assert.equal(await a.done, 0);
  const log = fs.readFileSync(path.join(h, 'dibs.log'), 'utf8');
  assert.match(log, /couldn't write .*events\.jsonl/);
  // One line per process, not one per event.
  for (const pid of new Set(log.trim().split('\n').map(l => l.match(/pid (\d+)/)[1])))
    assert.equal(log.split(`pid ${pid}.`).length - 1, 1);
});

test('the log rotates past 15 days or 10 MB, so two files keep at most 30 days and 20 MB', async t => {
  const h = home(t);
  const file = path.join(h, 'events.jsonl'), older = path.join(h, 'events.1.jsonl');
  const day = 864e5;
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 16 * day, kind: 'start', id: 900, res: ['t'], who: 'old' }) + '\n');
  assert.equal(sync(h, 'a', ['t', '--', 'true']).code, 0);
  assert.match(fs.readFileSync(older, 'utf8'), /"who":"old"/);
  assert.deepEqual(events(h).map(e => e.kind), ['start', 'end']);

  // A young file past 10 MB rotates too. Sparse, so it takes no disk.
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), kind: 'start', id: 901, res: ['t'], who: 'big' }) + '\n');
  fs.truncateSync(file, 11 * 1024 ** 2);
  assert.equal(sync(h, 'a', ['t', '--', 'true']).code, 0);
  assert.equal(fs.statSync(older).size, 11 * 1024 ** 2);
  assert.deepEqual(events(h).map(e => e.kind), ['start', 'end']);
  // Nothing older than 30 days is read back, whichever file it's in.
  fs.writeFileSync(older, JSON.stringify({ at: Date.now() - 31 * day, kind: 'timeout', id: 902, res: ['t'], who: 'ancient', ms: 5 }) + '\n');
  const j = JSON.parse(sync(h, 'viewer', ['history', '--since', '60d', '--json']).out);
  assert.ok(!j.events.some(e => e.who === 'ancient'));
  assert.deepEqual(j.events.map(e => e.kind), ['start', 'end']);
});

test('the throttle watcher writes a load sample for the hourly view', async t => {
  const h = home(t);
  const w = track(t, spawn(process.execPath, [BIN, 'throttle', '--watch'],
    { env: env(h, { load: 3.5 }), stdio: 'ignore' }));
  await until(() => events(h).some(e => e.kind === 'sample'));
  w.kill('SIGTERM');
  const s = events(h).find(e => e.kind === 'sample');
  assert.equal(s.load, 3.5);
  const j = JSON.parse(sync(h, 'viewer', ['history', '--since', '1h', '--json']).out);
  assert.ok(j.hourly.some(x => x.load === 3.5));
  assert.ok(!j.events.some(e => e.kind === 'sample'), 'samples feed the hours, not the event list');
});

// A made-up afternoon, in minutes from T.
const T = new Date(2026, 9, 12, 18, 0).getTime();
const M = 6e4;
const ev = (min, kind, id, res, who, extra = {}) => ({ at: T + min * M, kind, id, res, who, prio: 'normal', ...extra });
const DAY = [
  // a holds xcode-build from 0 to 60; b holds it from 30 to 90 (two slots).
  ev(0, 'start', 1, ['xcode-build'], 'a', { ms: 0 }), ev(60, 'end', 1, ['xcode-build'], 'a', { ms: 60 * M, code: 0 }),
  ev(30, 'start', 2, ['xcode-build', 'sim'], 'b', { ms: 0 }), ev(90, 'end', 2, ['xcode-build', 'sim'], 'b', { ms: 60 * M, code: 0 }),
  // Three overlapping waits for xcode-build: 10-60, 20-90, 40-95 (c gave up at 95).
  ev(10, 'wait', 3, ['xcode-build'], 'c'), ev(60, 'start', 3, ['xcode-build'], 'c', { ms: 50 * M }), ev(70, 'end', 3, ['xcode-build'], 'c', { ms: 10 * M, code: 1 }),
  ev(20, 'wait', 4, ['xcode-build'], 'd'), ev(90, 'start', 4, ['xcode-build'], 'd', { ms: 70 * M }), ev(100, 'end', 4, ['xcode-build'], 'd', { ms: 10 * M, code: 0 }),
  ev(40, 'wait', 5, ['xcode-build'], 'c'), ev(95, 'timeout', 5, ['xcode-build'], 'c', { ms: 55 * M }),
  // One short wait for test, 0-2.
  ev(0, 'wait', 6, ['test'], 'e'), ev(2, 'start', 6, ['test'], 'e', { ms: 2 * M }), ev(3, 'end', 6, ['test'], 'e', { ms: M, code: 0 }),
  // Started at once, so not a wait, though it reports a few ms in line.
  ev(5, 'start', 7, ['test'], 'f', { ms: 40 }), ev(6, 'end', 7, ['test'], 'f', { ms: M, code: 0 }),
  ev(30, 'sample', undefined, undefined, undefined, { load: 4 }), ev(50, 'sample', undefined, undefined, undefined, { load: 8 }),
];
const none = { leases: [], queue: [] };

test('aggregates: busy time is the union of leases, waits overlap, percentiles, and multi-resource leases count on each', () => {
  const h = summarize(DAY, none, T - 60 * M, T + 120 * M);
  const x = h.resources['xcode-build'];
  assert.equal(x.busyMs, 100 * M);   // 0-90 from a and b together, 90-100 from d
  assert.equal(x.waits, 3);
  assert.equal(x.waitMs, (50 + 70 + 55) * M);
  assert.equal(x.p50WaitMs, 55 * M);
  assert.equal(x.p90WaitMs, 70 * M);
  assert.equal(x.peakQueue, 3);
  assert.equal(x.timeouts, 1);
  assert.equal(h.resources.sim.busyMs, 60 * M);
  assert.equal(h.resources.sim.waits, 0);
  assert.deepEqual(h.resources.test, { busyMs: 2 * M, waits: 1, waitMs: 2 * M, p50WaitMs: 2 * M, p90WaitMs: 2 * M, peakQueue: 1, timeouts: 0, mostly: [new Date(T + 58 * M).getHours(), 1] });
  assert.deepEqual(h.agents.c, { runs: 1, holdMs: 10 * M, waitMs: 105 * M, timeouts: 1 });
  assert.deepEqual(h.agents.b, { runs: 1, holdMs: 60 * M, waitMs: 0, timeouts: 0 });
  const six = h.hourly.find(x => x.hour === T);
  assert.deepEqual([six.load, six.waiting, six.held], [6, 3, 2]);   // a and b; c starts as the hour ends
  assert.equal(h.hourly.find(x => x.hour === T - 60 * M).load, null);
});

test('aggregates clip to the window, and work still going counts up to now', () => {
  const now = { leases: [{ id: 9, res: ['deploy'], who: 'g', start: T + 100 * M }], queue: [{ id: 10, res: ['deploy'], who: 'h', enq: T + 110 * M }] };
  const h = summarize(DAY, now, T + 45 * M, T + 120 * M);
  const x = h.resources['xcode-build'];
  assert.equal(x.busyMs, 55 * M);                    // 45-100
  assert.equal(x.waitMs, (15 + 45 + 50) * M);        // each wait from 45
  assert.equal(x.waits, 3);                          // all three ended inside the window
  assert.equal(x.p90WaitMs, 70 * M);                 // a wait's length is all of it, not the clipped part
  assert.equal(h.resources.test, undefined);         // over before the window
  assert.deepEqual(h.resources.deploy, { busyMs: 20 * M, waits: 0, waitMs: 10 * M, p50WaitMs: 0, p90WaitMs: 0, peakQueue: 1, timeouts: 0, mostly: [new Date(T + 110 * M).getHours(), 1] });
  assert.ok(!h.events.some(e => e.at < T + 45 * M));
});

test('the verdict names the bottleneck and when, and says nothing the numbers do not show', () => {
  const h = summarize(DAY, none, T - 60 * M, T + 120 * M);
  const v = verdict(h);
  assert.equal(v[0], `Xcode builds held everyone up: agents waited 2h55m for it, mostly ${clock(T)}-${clock(T + 60 * M)}.`);
  assert.match(verdict(h, DEFAULT_CONFIG)[0], /^Xcode builds held everyone up/);
  assert.match(v[1], /^1 request gave up waiting \(exit 75\)/);
  assert.match(v[2], /^The machine was busiest in the hour from .* \(load average 6/);
  const quiet = summarize(DAY.filter(e => !['xcode-build', 'sim'].some(r => e.res?.includes(r))), none, T - 60 * M, T + 120 * M);
  assert.deepEqual(verdict(quiet).slice(0, 1), ['Nobody had to wait long: 1 wait, 2m00s in all, across 2 turns.']);
  assert.deepEqual(verdict(summarize([], none, T, T + M)), ['Nothing went through dibs in this period.']);
});

test('--json has exactly the keys the Mac app reads, and the newest 2000 events', async t => {
  const h = home(t);
  const lines = [];
  for (let i = 0; i < 2100; i++) lines.push(JSON.stringify({ at: Date.now() - (2100 - i) * 1000, kind: 'start', id: i, res: ['t'], who: 'x', prio: 'normal', ms: 0 }));
  fs.writeFileSync(path.join(h, 'events.jsonl'), lines.join('\n') + '\n');
  assert.equal(sync(h, 'a', ['t', '--', 'true']).code, 0);
  const r = sync(h, 'viewer', ['history', '--json', '--since', '24h']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), ['since', 'until', 'resources', 'agents', 'hourly', 'events']);
  assert.ok(j.until - j.since === 864e5);
  assert.deepEqual(Object.keys(j.resources.t).sort(), ['busyMs', 'mostly', 'p50WaitMs', 'p90WaitMs', 'peakQueue', 'timeouts', 'waitMs', 'waits']);
  assert.deepEqual(Object.keys(j.agents.a).sort(), ['holdMs', 'runs', 'timeouts', 'waitMs']);
  assert.equal(j.hourly.length, 25);
  for (const k of ['hour', 'load', 'waiting', 'held']) assert.ok(k in j.hourly[0], k);
  assert.equal(j.events.length, 2000);
  assert.equal(j.events.at(-1).kind, 'end');
  assert.equal(j.events.at(-1).who, 'a');
  for (const e of j.events) for (const k of ['at', 'kind', 'res', 'who', 'prio', 'code', 'ms']) assert.ok(k in e, k);
  assert.ok(j.events.every((e, i) => !i || e.at >= j.events[i - 1].at), 'oldest first');
});

test('plain history leads with the verdict; a bad --since is refused', async t => {
  const h = home(t);
  const a = await holder(t, h);
  assert.equal(sync(h, 'late', ['t', '--', 'true']).code, 75);
  a.release();
  assert.equal(await a.done, 0);
  const r = sync(h, 'viewer', ['history']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.match(lines[0], /^Nobody had to wait long/);
  assert.match(r.out, /^dibs history, last 7d: /m);
  assert.match(r.out, /^By resource\n +in use  waits  waited  typical wait/m);
  assert.match(r.out, /1 request gave up waiting/);
  assert.match(r.out, /^t\s+\d+s\s+1\s/m);
  assert.match(r.out, /^late\s+0\s+0s\s+\d+s\s+1$/m);
  const bad = sync(h, 'viewer', ['history', '--since', 'last week']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /can't read --since "last week" \(try 24h, 7d or 30d\)/);
});

test('dibs stats: waits by resource, and the share of jobs that waited longer than they ran', async () => {
  const { statsOf } = await import('../src/history.mjs');
  const T0 = 1e12;
  const job = (id, res, wait, run) => [{ at: T0 + id, kind: 'start', type: 'run', id, res: [res], ms: wait }, { at: T0 + id + run, kind: 'end', type: 'run', id, res: [res], ms: run }];
  const ev = [...job(1, 'test', 10e3, 60e3), ...job(2, 'test', 120e3, 30e3), ...job(3, 'playwright', 0, 60e3), ...job(4, 'test', 5e3, 60e3)];
  const s = statsOf(ev, T0);
  assert.equal(s.jobs, 4);
  assert.equal(s.waitedLonger, 0.25);
  assert.deepEqual(s.byRes[0], { res: 'test', jobs: 3, median: 10e3, p90: 120e3 });
  assert.equal(statsOf(ev, T0 + 4).jobs, 1, 'only jobs that started since');
});
