// Notices about an agent's own jobs: what in the state earns one, and the scan
// that leaves them in the agent's inbox for the guard hook (talk.test.mjs
// covers the handing over).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { spawn, spawnSync } from 'node:child_process';
import { HOME, G, BIN, tmp, env, sync, bg, track, until } from './helpers.mjs';
import { noticesIn, noticeScan } from '../src/notices.mjs';

const MIN = 6e4;
const T = 1e12;
const run = (id, extra = {}) => ({ id, kind: 'run', res: ['test'], who: 'web-app', sessionId: 'sess-a', agentId: 'agent-7', pid: 4242, cmd: 'npm test', purpose: 'unit tests', start: T - 60 * MIN, ...extra });
const waiter = (id, res = ['test']) => ({ id, res, pid: 999, who: 'api' });

test('a run idle 20 min while others wait for what it holds is flagged to its own agent, with how to end it', () => {
  const idle = run(12, { idleSince: T - 25 * MIN });
  const [[l, once, text], ...rest] = noticesIn({ leases: [idle], queue: [waiter(13), waiter(14)] }, T);
  assert.equal(rest.length, 0);
  assert.equal(l, idle, 'addressed to the lease, which carries its session and agent');
  assert.equal(once, 'idle:#12');
  assert.match(text, /^your job #12 \("unit tests", npm test\) has used no CPU for 25 min while 2 other jobs wait for test\. If it's stuck, end it: .*kill 4242 /);
  assert.deepEqual(noticesIn({ leases: [idle], queue: [waiter(13, ['sim'])] }, T), [], 'nobody waits for what it holds: nothing to say');
  assert.deepEqual(noticesIn({ leases: [run(12, { idleSince: T - 10 * MIN })], queue: [waiter(13)] }, T), [], 'ten idle minutes is a pause, not stuck');
  assert.deepEqual(noticesIn({ leases: [idle], queue: [{ ...waiter(13), pid: null }] }, T), [], 'a place kept for a waiter that left is nobody waiting');
});

test('a job that used far more memory than it asked for, and one paused for low disk, each get one notice', () => {
  const big = run(3, { overAsk: { used: 5.1 * G, asked: 2 * G, planned: 2 * G, suggest: '6G' } });
  assert.deepEqual(noticesIn({ leases: [big], queue: [] }, T).map(x => x.slice(1)), [['mem:#3',
    'your job #3 ("unit tests", npm test): this job used 5.1 GB of memory but asked for 2.0 GB. Next time pass --mem 6G, so dibs plans for it and doesn\'t start other jobs into memory this one will take.']]);
  const paused = run(4, { pausedAt: T - MIN, pauses: [{ watcher: 77, disk: true }] });
  assert.match(noticesIn({ leases: [paused], queue: [] }, T)[0][2], /was paused because free disk is low\. It keeps its turn and resumes by itself .*don't run it again/);
  assert.equal(noticesIn({ leases: [paused], queue: [] }, T)[0][1], `paused:#4:${T - MIN}`, 'a second pause later is news again');
  assert.deepEqual(noticesIn({ leases: [run(5, { pausedAt: T, pauses: [{ lease: 9, who: 'api' }] })], queue: [] }, T), [], 'lent to an urgent job: its own notice covers that');
});

test('the scan leaves each notice in the agent inbox once, however often it runs', () => {
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ seq: 20, leases: [run(12, { idleSince: Date.now() - 30 * MIN })], queue: [waiter(13)] }));
  noticeScan();
  noticeScan(Date.now() + 60e3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'inbox.json'), 'utf8')), { 'sess-a': ['agent-7'] });
  const notices = JSON.parse(fs.readFileSync(path.join(HOME, 'messages.json'), 'utf8')).messages.filter(m => m.kind === 'notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].once, 'idle:#12');
});

test('the same command from the same agent in a second call, while the first still runs: refused with where the first is, exit 2', async t => {
  const h = tmp(t);
  const cmd = ['run', 'test', '-m', 'unit', '--', 'sleep', '30'];
  const claude = { CLAUDECODE: '1' };
  const first = bg(t, h, cmd, { agent: 'web-app', env: claude });
  await until(() => JSON.parse(sync(h, ['--json'], { agent: 'x' }).out).held.length === 1);
  // A retry comes from a new tool call: a new shell, so a different parent.
  const again = spawnSync('sh', ['-c', `"${process.execPath}" "${BIN}" "$@"; exit $?`, 'sh', ...cmd], { env: env(h, { agent: 'web-app', env: claude }), encoding: 'utf8' });
  assert.equal(again.status, 2, again.stderr);
  assert.match(again.stderr, /you already have this exact command running as #1 .*Nothing ran here \(exit 2\).*wait for its notice instead of running it again/s);
  assert.equal(JSON.parse(sync(h, ['--json'], { agent: 'x' }).out).waiting.length, 0, 'nothing joined the line');
  const twin = JSON.parse(sync(h, ['history', '--json'], { agent: 'x' }).out).events.find(e => e.kind === 'twin');
  assert.deepEqual([twin.id, twin.who, twin.res, twin.cmd], [1, 'web-app', ['test'], 'sleep 30'], 'the app can say a second copy was stopped');

  const other = track(t, spawn('sh', ['-c', `"${process.execPath}" "${BIN}" "$@" & trap 'kill $!; wait $!' TERM; wait`, 'sh', ...cmd], { env: env(h, { agent: 'api', env: claude }), stdio: 'ignore' }));
  await until(() => JSON.parse(sync(h, ['--json'], { agent: 'x' }).out).held.length === 2);
  assert.equal(other.exitCode, null, "another agent's copy isn't a retry: it runs");
  const purpose = bg(t, h, ['run', 'test', '-m', 'second copy', '--', 'true'], { agent: 'web-app', env: claude });
  assert.equal(await purpose.done, 0, 'a different -m asks for a second copy on purpose');
  first.kill('SIGTERM');
});
