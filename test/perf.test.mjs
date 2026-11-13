// What keeps dibs fast on a busy machine: no process spawned while the state
// lock is held, one machine reading shared by every dibs, and reading only the
// end of the run history.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, board, HOME, MACHINE } from './helpers.mjs';
import { history } from '../src/state.mjs';
import { machine } from '../src/config.mjs';
import { busyBetween } from '../src/platform.mjs';
import { clock } from '../src/util.mjs';

const WIN = process.platform === 'win32';
const CONFIG_MJS = fileURLToPath(new URL('../src/config.mjs', import.meta.url));
const STATE_MJS = fileURLToPath(new URL('../src/state.mjs', import.meta.url));
const STATS_MJS = fileURLToPath(new URL('../src/stats.mjs', import.meta.url));
const CONFIG = { resources: { t: { slots: 1, mem: '0.1G', cpu: 1 } } };

// ps, sysctl and vm_stat stand-ins that note each call, and whether the dibs
// that made it held the state lock at the time, then run the real command.
function spy(t, home) {
  const bin = tmp(t, 'spy');
  const log = path.join(bin, 'calls.log');
  for (const name of ['ps', 'sysctl', 'vm_stat']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh
held=free
[ "$(cat "${home}/lock/pid" 2>/dev/null)" = "$PPID" ] && held=locked
echo "$held ${name} $*" >> "${log}"
PATH="$REAL_PATH" exec ${name} "$@"
`, { mode: 0o755 });
  }
  const env = { PATH: `${bin}:${process.env.PATH}`, REAL_PATH: process.env.PATH };
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { env, calls };
}

test('dibs runs no ps or sysctl while it holds the state lock: the board, why, when, and a run that waits', { skip: WIN }, async t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(CONFIG));
  const { env, calls } = spy(t, h);
  const gate = path.join(h, 'gate');
  const holder = bg(t, h, ['run', 't', '--', 'sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done`], { agent: 'a', env });
  await until(() => board(h).held.some(l => l.who === 'a'));
  // A waiter in Node polls under the lock every second or so.
  const waiter = bg(t, h, ['run', 't', '--', 'true'], { agent: 'b', env: { ...env, DIBS_THIN: '0' } });
  await until(() => board(h).waiting?.some(q => q.who === 'b'));
  for (const args of [[], ['why'], ['when', 't'], ['who', 't']]) assert.equal(sync(h, args, { agent: 'c', env }).code, 0);
  // Two of its polls, at least: the second reads the process table.
  const polled = calls().length;
  await until(() => calls().length > polled + 1);
  fs.writeFileSync(gate, '');
  assert.equal(await holder.done, 0, holder.err);
  assert.equal(await waiter.done, 0, waiter.err);
  const all = calls();
  assert.ok(all.some(c => c.includes(' ps ')), `the stand-ins were used: ${all.join('; ')}`);
  assert.deepEqual(all.filter(c => c.startsWith('locked')), []);
});

test('one machine reading serves every dibs for 3 s, and the next takes cores in use from the CPU counters, not ps', { skip: WIN }, async t => {
  const file = path.join(HOME, 'machine.json');
  const { env, calls } = spy(t, HOME);
  const fake = process.env.DIBS_FAKE_MACHINE, oldPath = process.env.PATH;
  t.after(() => { process.env.DIBS_FAKE_MACHINE = fake; process.env.PATH = oldPath; fs.rmSync(file, { force: true }); });
  delete process.env.DIBS_FAKE_MACHINE;
  Object.assign(process.env, env);
  // Another dibs read the machine a moment ago: this one takes its reading, spawning nothing.
  fs.writeFileSync(file, JSON.stringify({ ...MACHINE, at: Date.now(), load: 3.5, cores: 10, busy: 2 }));
  const m = machine();
  assert.equal(m.load, 3.5);
  assert.equal(m.busy, 2);
  assert.deepEqual(calls(), []);

  // A reading 10 s old, with its CPU counters: a new process takes a fresh
  // reading, shares it, and works out busy from the counters.
  const stale = Date.now() - 10e3;
  fs.writeFileSync(file, JSON.stringify({ ...MACHINE, at: stale, load: 3.5, ticks: { busy: 0, total: 0 } }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { machine } = await import(${JSON.stringify(pathToFileURL(CONFIG_MJS).href)}); console.log(JSON.stringify(machine()));`],
  { env: { ...process.env, DIBS_HOME: HOME }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const fresh = JSON.parse(r.stdout);
  assert.ok(fresh.at > stale, 'a new reading');
  assert.ok(fresh.busy >= 0, `busy ${fresh.busy}`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, fresh.at, 'the new reading is shared');
  assert.deepEqual(calls().filter(c => c.includes('pcpu')), []);
});

test('cores in use from two CPU counter readings, or null when they are too close or too far apart', () => {
  const a = { busy: 1000, total: 10000 };
  assert.equal(busyBetween(a, { busy: 3000, total: 14000 }, 5000, 10), 5);
  assert.equal(busyBetween(a, { busy: 3000, total: 14000 }, 500, 10), null);
  assert.equal(busyBetween(a, { busy: 3000, total: 14000 }, 120e3, 10), null);
  assert.equal(busyBetween(null, { busy: 3000, total: 14000 }, 5000, 10), null);
  assert.equal(busyBetween(a, a, 5000, 10), null);
});

test('the run history: the newest 1000 runs from the end of a big file, the same as reading it all', t => {
  const file = path.join(HOME, 'history.jsonl');
  t.after(() => fs.rmSync(file, { force: true }));
  const all = text => text.trim().split('\n').slice(-1000).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const line = i => JSON.stringify({ key: `test|npm run case-${i} ${'x'.repeat(i % 300)}`, dur: i, who: 'a', at: i });
  // About 700 KB, past one read's worth, with a line cut short (a crash mid-append) and a
  // multibyte name at a read's edge.
  const big = Array.from({ length: 4000 }, (_, i) => (i === 3500 ? '{"key":"cut' : i % 7 ? line(i) : line(i).replace('"a"', '"éé"'))).join('\n') + '\n';
  fs.writeFileSync(file, big);
  assert.deepEqual(history(), all(big));
  const small = Array.from({ length: 30 }, (_, i) => line(i)).join('\n') + '\n\n';
  fs.writeFileSync(file, small);
  assert.deepEqual(history(), all(small));
  fs.writeFileSync(file, '');
  assert.deepEqual(history(), []);
});

test('clock reads the same as toLocaleTimeString', () => {
  for (const t of [Date.now(), 0, 1e12, Date.UTC(2026, 0, 1, 23, 59)]) assert.equal(clock(t), new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  assert.equal(clock(NaN), 'Invalid Date');
});

test('history.jsonl past 2 MB moves aside when a run ends, and learned sizes still see the newest 1000 runs across both files', async t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(CONFIG));
  const line = i => JSON.stringify({ key: `t|npm run case ${'y'.repeat(200)}`, dur: 1000 + i, who: 'a', at: i + 1 });
  const big = Array.from({ length: 9000 }, (_, i) => line(i)).join('\n') + '\n';
  assert.ok(big.length > 2 * 1024 ** 2);
  fs.writeFileSync(path.join(h, 'history.jsonl'), big);
  assert.equal(sync(h, ['run', 't', '-m', 'rotate', '--', 'true']).code, 0);
  assert.equal(fs.readFileSync(path.join(h, 'history.1.jsonl'), 'utf8'), big, 'the full file moved aside whole');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { history } = await import(${JSON.stringify(pathToFileURL(STATE_MJS).href)}); const { readRuns } = await import(${JSON.stringify(pathToFileURL(STATS_MJS).href)});`
    + ` const x = history(); console.log(JSON.stringify({ n: x.length, first: x[0].dur, last: x.at(-1).key, runs: readRuns(0).length }));`],
  { env: { ...process.env, DIBS_HOME: h }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  // The newest run is in the new file; the other 999 come from the end of the old one.
  assert.equal(got.n, 1000);
  assert.equal(got.first, 1000 + 9000 - 999);
  assert.match(got.last, /^t\|/);
  assert.equal(got.runs, 9001, 'dibs stats reads both files');
});

test('the board checks its jobs and its listeners with one ps, and finds a Claude Code session from its session file', { skip: WIN }, async t => {
  const h = tmp(t), sessions = tmp(t, 'sessions');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(CONFIG));
  const { env, calls } = spy(t, h);
  const gate = path.join(h, 'gate');
  const holder = bg(t, h, ['run', 't', '--', 'sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done`], { agent: 'a' });
  await until(() => board(h).held.length === 1);
  // A listener on record, and a Claude Code session: live processes this test started.
  const live = spawn('sleep', ['60']);
  t.after(() => live.kill());
  fs.writeFileSync(path.join(h, 'listeners.json'), JSON.stringify({ 'some-session|main': { pid: live.pid, pstart: 'x', at: Date.now() } }));
  fs.writeFileSync(path.join(sessions, `${live.pid}.json`), JSON.stringify({ pid: live.pid, sessionId: 'perf-session', name: 'perf-agent' }));
  const as = { DIBS_NO_SESSION: undefined, DIBS_AGENT: undefined, DIBS_SESSIONS: sessions, CLAUDE_CODE_SESSION_ID: 'perf-session' };
  const before = calls().length;
  const r = sync(h, [], { env: { ...env, ...as } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /You're perf-agent\b/);
  const lstart = calls().slice(before).filter(c => c.includes('lstart'));
  // One for the session's start time, one for the jobs and listeners together.
  assert.equal(lstart.length, 2, lstart.join('; '));
  assert.ok(!calls().slice(before).some(c => c.includes('comm=')), 'no walk up the process tree');
  // Under another agent program, the nearest agent is that one: walk as before.
  const other = sync(h, [], { env: { ...env, ...as, CODEX_THREAD_ID: 'x' } });
  assert.doesNotMatch(other.out, /You're perf-agent\b/);
  fs.writeFileSync(gate, '');
  assert.equal(await holder.done, 0);
});
