// How long dibs waits in line, what it says when it stops, and --notify.
// DIBS_MAX_WAIT shortens the default limit (8m) to a second, so a wait that
// outlasts it takes seconds, not minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, sync as dibs, bg as spawnDibs, until, board, wait, flat } from './helpers.mjs';
import { runArgs } from '../src/worker.mjs';

const LIMIT = { DIBS_MAX_WAIT: '1s' };
const CLAUDE = { ...LIMIT, CLAUDE_CODE_CHILD_SESSION: '1' };
const sync = (h, agent, args, env = LIMIT) => dibs(h, args, { agent, env });
const bg = (t, h, agent, args, env = LIMIT) => spawnDibs(t, h, args, { agent, env });
const notes = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

// Holds t until the test says so: `release()` ends the holder's command.
async function holder(t, h) {
  const gate = path.join(h, 'gate');
  const p = bg(t, h, 'a', ['t', '--', 'sh', '-c', `while [ ! -e ${gate} ]; do sleep 0.05; done`]);
  await until(() => board(h).held.length === 1);
  p.release = () => fs.writeFileSync(gate, '');
  return p;
}

// A waiter still in line well past the 1s limit, then let in: it runs and exits 0.
async function outlasts(t, h, args, env) {
  const a = await holder(t, h);
  const w = bg(t, h, 'b', ['t', ...args, '--', 'echo', 'ran'], env);
  await until(() => board(h).waiting.length === 1);
  // Nothing to wait for here but time itself: the limit has to pass.
  await wait(2500);
  assert.equal(w.exitCode, null, w.err);
  assert.equal(board(h).waiting[0].pid, w.pid);
  a.release();
  assert.equal(await w.done, 0, w.err);
  assert.equal(w.out, 'ran\n');
  return w;
}

test('inside a Claude Code tool call, a wait has no limit: it outlasts the default and then runs', async t => {
  const h = tmp(t);
  const w = await outlasts(t, h, [], CLAUDE);
  assert.match(flat(w.err), /No time limit\. If this tool call times out, Claude Code moves it to the background.*don't run it again/s);
});

test('--wait has no limit anywhere', async t => {
  const h = tmp(t);
  const w = await outlasts(t, h, ['--wait']);
  assert.match(flat(w.err), /No time limit \(--wait\)/);
});

test('with background tasks off, a Claude Code tool call gets the limit back', async t => {
  const h = tmp(t);
  await holder(t, h);
  for (const off of [{ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, { CLAUDE_CODE_SIMPLE: 'true' }]) {
    const r = sync(h, 'b', ['t', '--', 'echo', 'ran'], { ...CLAUDE, ...off });
    assert.equal(r.code, 75, JSON.stringify(off));
    assert.equal(r.out, '');
  }
});

test('outside Claude Code the default limit ends the wait with 75, says it is not a failure, and keeps the place', async t => {
  const h = tmp(t);
  const a = await holder(t, h);
  const r = sync(h, 'b', ['t', '--', 'echo', 'ran']);
  assert.equal(r.code, 75);
  assert.equal(r.out, '');
  assert.match(flat(r.err), /Gives up at .* if it's still waiting \(exit 75: your command won't have run\)/);
  assert.match(r.err, /Your command did NOT run \(exit 75, not a failure\).*Your place is kept until .*run the same command again before then:\n {8}dibs t -- echo ran\n/s);
  // The wait loop speaks once, then only when something changes: no wall of repeated status.
  assert.equal(r.err.match(/^dibs: queued for /gm).length, 1);
  const [kept] = board(h).waiting;
  assert.equal(kept.pid, null);
  // Someone arrives after b gave up; b's rerun, with --wait this time, goes back in front of them.
  const c = bg(t, h, 'c', ['t', '--wait', '--', 'true']);
  await until(() => board(h).waiting.length === 2);
  const b = bg(t, h, 'b', ['t', '--wait', '--', 'echo', 'ran']);
  await until(() => board(h).waiting.every(w => w.pid));
  const [first] = board(h).waiting;
  assert.deepEqual([first.who, first.id, first.enq], ['b', kept.id, kept.enq]);
  a.release();
  assert.deepEqual(await Promise.all([b.done, c.done]), [0, 0]);
  assert.equal(b.out, 'ran\n');
});

test('--notify writes one line when the command ends, with its exit code', t => {
  const h = tmp(t);
  const file = path.join(h, 'done.jsonl');
  const r = sync(h, 'b', ['t', '--notify', file, '--', 'sh', '-c', 'exit 3']);
  assert.equal(r.code, 3);
  const [n] = notes(file);
  assert.equal(notes(file).length, 1);
  assert.equal(n.code, 3);
  assert.equal(n.started, true);
  assert.deepEqual(n.res, ['t']);
  assert.equal(n.cmd, 'sh -c exit 3');
});

test('--notify writes a line for a command that never started too', async t => {
  const h = tmp(t);
  const file = path.join(h, 'done.jsonl');
  await holder(t, h);
  assert.equal(sync(h, 'b', ['t', '--notify', file, '--', 'true']).code, 75);
  assert.equal(sync(h, 'b', ['t', '--no-wait', '--notify', file, '--', 'true']).code, 75);
  assert.deepEqual(notes(file).map(n => [n.code, n.started]), [[75, false], [75, false]]);
});

test('--notify refuses a folder it cannot write to, and holds', t => {
  const h = tmp(t);
  const r = sync(h, 'b', ['t', '--notify', path.join(h, 'missing', 'x'), '--', 'true']);
  assert.equal(r.code, 2);
  assert.match(r.err, /can't write in/);
  assert.equal(sync(h, 'b', ['hold', 't', '--notify', path.join(h, 'x')]).code, 2);
});

test('a job sent to another machine waits without a limit when its sender would', () => {
  const job = { res: ['test'], cmd: ['true'] };
  assert.ok(runArgs({ ...job, wait: true }).includes('--wait'));
  assert.ok(!runArgs({ ...job, wait: true }).includes('--max-wait'));
  const limited = runArgs({ ...job, maxWait: 60e3 });
  assert.equal(limited[limited.indexOf('--max-wait') + 1], '60s');
});
