// A disk too full for dibs to save its state: a waiter keeps waiting, a run
// still hands back its command's code, everything else exits 74 with one line,
// and the guard still answers. DIBS_FAKE_ENOSPC names a file; while it exists,
// the state writes it lists (all of them, if it lists none) fail as ENOSPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOOK, tmp, sync, bg, until, board, wait, flat, alive, gitProject, shPid, posixOnly } from './helpers.mjs';

const fake = h => path.join(h, 'full');
const full = (h, steps = '') => fs.writeFileSync(fake(h), steps);
const room = h => fs.rmSync(fake(h), { force: true });
const stack = /\n\s+at /;

// Holds res until the test says so: `release()` ends the holder's command.
async function holder(t, h, res = 't', agent = 'a') {
  const gate = path.join(h, `gate-${agent}`);
  const p = bg(t, h, [res, '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done`], { agent, env: { DIBS_FAKE_ENOSPC: fake(h) } });
  await until(() => board(h).held.some(l => l.pid === p.pid));
  p.release = () => fs.writeFileSync(gate, '');
  return p;
}

test('a full disk while waiting: the job keeps waiting and starts when space returns', async t => {
  const h = tmp(t);
  const a = await holder(t, h);
  const w = bg(t, h, ['t', '--', 'echo', 'ran'], { agent: 'b', env: { DIBS_FAKE_ENOSPC: fake(h), CLAUDE_CODE_CHILD_SESSION: '1' } });
  await until(() => board(h).waiting.length === 1);
  full(h);
  // From the line start: the what's-new notice for this version quotes the same words.
  await until(() => /^dibs: the disk is too full/m.test(w.err));
  assert.match(flat(w.err), /the disk is too full for dibs to save your place in line.*Waiting for space and trying again\. No time limit\./);
  // Two more retries' worth, to see it stays in line rather than giving up.
  await wait(3000);
  assert.equal(w.exitCode, null, w.err);
  assert.doesNotMatch(w.err, stack);
  assert.equal(board(h).waiting[0].pid, w.pid, 'it keeps its place');
  room(h);
  a.release();
  assert.equal(await w.done, 0, w.err);
  assert.equal(w.out, 'ran\n');
  assert.match(w.err, /there's disk space again; back in line/);
});

test('a full disk while a run with --port waits: it keeps waiting, then gets its ports and runs', async t => {
  const h = tmp(t);
  // Both browser-test slots taken, so the run waits.
  const a = await holder(t, h, 'playwright', 'a');
  await holder(t, h, 'playwright', 'c');
  const w = bg(t, h, ['playwright', '--port', 'WEB', '--port', 'API', '--', 'sh', '-c', 'echo "$WEB $API"'],
    { agent: 'b', env: { DIBS_FAKE_ENOSPC: fake(h), CLAUDE_CODE_CHILD_SESSION: '1' } });
  await until(() => board(h).waiting.length === 1);
  full(h);
  await until(() => /^dibs: the disk is too full/m.test(w.err));
  // Past a retry or two, to see it stays in line.
  await wait(2000);
  assert.equal(w.exitCode, null, w.err);
  room(h);
  a.release();
  assert.equal(await w.done, 0, w.err);
  assert.match(w.out, /^\d+ \d+\n$/);
  assert.doesNotMatch(w.err, stack);
});

test('a full disk outside Claude Code: the wait ends at the limit with exit 74, and the command never runs', t => {
  const h = tmp(t), ran = path.join(h, 'ran');
  full(h);
  const r = sync(h, ['t', '--', 'touch', ran], { env: { DIBS_FAKE_ENOSPC: fake(h), DIBS_MAX_WAIT: '1s' } });
  assert.equal(r.code, 74, r.err);
  assert.ok(!fs.existsSync(ran));
  assert.match(flat(r.err), /Gives up at .* if the disk is still full \(exit 74/);
  assert.match(flat(r.err), /the disk is still too full for dibs to save its state.*Your command did NOT run \(exit 74\)\. Free some disk space, then run it again: dibs t -- touch/);
  assert.doesNotMatch(r.err, stack);
});

test('a full disk for commands that do not wait: one line saying what to do, exit 74, no stack trace', t => {
  const h = tmp(t);
  full(h);
  for (const args of [[], ['release'], ['say', 'done: tests pass'], ['hold', 'sim', '--for', '5m']]) {
    const r = sync(h, args, { env: { DIBS_FAKE_ENOSPC: fake(h), DIBS_MAX_WAIT: '0s' } });
    assert.equal(r.code, 74, `${args.join(' ')}: ${r.err}`);
    assert.match(flat(r.err), /the disk is (still too )?full.*Free some disk space, then run (it|the same command) again/, args.join(' '));
    assert.doesNotMatch(r.err, stack, args.join(' '));
  }
});

test("a lock whose pid couldn't be written is given back at once, so the next command doesn't wait on it", async t => {
  const h = tmp(t);
  full(h, 'lock');
  assert.equal(sync(h, ['--json'], { env: { DIBS_FAKE_ENOSPC: fake(h) } }).code, 74);
  assert.ok(!fs.existsSync(path.join(h, 'lock')), 'no lock left behind');
  room(h);
  // A lock left with no pid in it is only taken over after 3 s. Timed against the same command
  // on a home that never had a lock, started at the same moment: under load one CLI start alone
  // has taken 4.5 s (2026-11-02), but both pay that, and only a wait on the lock is the difference.
  const timed = home => { const t0 = Date.now(); const p = bg(t, home, ['--json'], { agent: 'viewer' }); return p.done.then(code => ({ code, ms: Date.now() - t0, err: p.err })); };
  const [after, control] = await Promise.all([timed(h), timed(tmp(t))]);
  assert.equal(after.code, 0, after.err);
  assert.ok(after.ms - control.ms < 2000, `took ${after.ms} ms, ${control.ms} ms for the same command with no lock ever`);
});

test("a full disk when a run ends: its command's exit code still comes back, its leftovers are killed, and the lease is gone on the next look", { skip: posixOnly("leftovers are found by process group; on Windows one whose parent already exited is out of taskkill /T's reach (a Job Object would hold it, and Node can't make one)") }, async t => {
  const h = tmp(t), gate = path.join(h, 'gate'), pidfile = path.join(h, 'sleeper');
  const p = bg(t, h, ['t', '--', 'sh', '-c', `sleep 300 & echo ${shPid('$!')} > '${pidfile}'; while [ ! -e '${gate}' ]; do sleep 0.05; done; exit 3`],
    { env: { DIBS_FAKE_ENOSPC: fake(h) } });
  await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8').trim() && board(h).held.length === 1);
  const sleeper = Number(fs.readFileSync(pidfile, 'utf8'));
  full(h);
  fs.writeFileSync(gate, '');
  assert.equal(await p.done, 3, p.err);
  assert.match(flat(p.err), /the disk is full, so dibs couldn't record that this job ended\. The next dibs command cleans it up/);
  assert.doesNotMatch(p.err, stack);
  await until(() => !alive(sleeper));
  room(h);
  assert.equal(board(h).held.length, 0);
});

test('a full disk mid-run: measurements are skipped and the job runs to its end', async t => {
  const h = tmp(t), gate = path.join(h, 'gate');
  const p = bg(t, h, ['t', '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done`],
    { env: { DIBS_FAKE_ENOSPC: fake(h), DIBS_SAMPLE_MS: '100' } });
  // Started, not just granted: the run records its process group before the command
  // starts, and a disk full before that write is the other test's case (exit 74).
  await until(() => board(h).held[0]?.pgid);
  full(h, 'state');
  // The run measures on a 3s tick: long enough for at least one tick to hit the full disk.
  await wait(4000);
  assert.equal(p.exitCode, null, p.err);
  room(h);
  fs.writeFileSync(gate, '');
  assert.equal(await p.done, 0, p.err);
  assert.doesNotMatch(p.err, stack);
});

test("a full disk never costs the guard its file-lease check: another agent's edit is still turned away", t => {
  const h = tmp(t), proj = gitProject(t, { 'src/a.js': '' });
  assert.equal(sync(h, ['hold', 'files:src/**', '-m', 'auth'], { agent: 'bob', cwd: proj }).code, 0);
  full(h);
  // A Bash call that takes a file lease makes the hook write a note first; that write fails here.
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: proj, session_id: 'session-1', permission_mode: 'default',
    tool_input: { command: 'dibs hold files:docs/** -m x && echo x > src/a.js' } };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, DIBS_HOME: h, DIBS_AGENT: 'alice', DIBS_FAKE_ENOSPC: fake(h) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
