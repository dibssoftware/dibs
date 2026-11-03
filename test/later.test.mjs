// dibs later: runs scheduled for a time or for when something else ends,
// started by a runner (the worker service, or one started on demand) through
// the normal queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { spawnSync } from 'node:child_process';
import { tmp, sync, bg, until, board, alive, wait, env, HOOK } from './helpers.mjs';

const later = (h, agent, args, opts) => sync(h, ['later', ...args], { agent, ...opts });
const list = h => JSON.parse(sync(h, ['later', 'list', '--json']).out);
const job = (h, id) => list(h).jobs.find(j => j.id === id);
const schedule = (h, agent, args, opts) => {
  const r = later(h, agent, args, opts);
  assert.equal(r.code, 0, r.err);
  return r.out.match(/^(l\d+):/)[1];
};
const runnerPids = h => { try { return fs.readdirSync(path.join(h, 'later', 'runners')).map(Number); } catch { return []; } };

// A runner of our own, up before anything is scheduled, so scheduling doesn't start one.
async function runner(t, h) {
  const before = new Set(runnerPids(h));
  const p = bg(t, h, ['later', 'run']);
  await until(() => runnerPids(h).some(pid => !before.has(pid)));
  return p;
}

// A command that runs until the test lets it finish, or its folder is
// deleted at teardown, so a failed test leaves nothing running.
function gate(t, dir) {
  const go = path.join(dir, 'go');
  t.after(() => { try { fs.writeFileSync(go, ''); } catch {} });
  return { cmd: ['sh', '-c', `echo started > "${dir}/started"; while [ ! -f "${go}" ] && [ -d "${dir}" ]; do sleep 0.1; done; echo finished`], open: () => fs.writeFileSync(go, ''), started: () => fs.existsSync(`${dir}/started`) };
}

test('schedule, list and cancel: the board shows what is coming, and anyone may cancel it, and it says who did', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const a = schedule(h, 'ios-agent', ['sim', '--in', '3h', '-m', 'ios snapshot suite', '--', 'echo', 'snap'], { cwd: dir });
  const b = schedule(h, 'web-app', ['test', '--in', '20m', '--', 'echo', 'smoke'], { cwd: dir });
  const v = job(h, a);
  assert.deepEqual([v.state, v.res, v.who, v.purpose, v.cmd, v.cwd], ['scheduled', ['sim'], 'ios-agent', 'ios snapshot suite', 'echo snap', fs.realpathSync(dir)]);
  assert.ok(v.in > 2.9 * 36e5 && v.in <= 3 * 36e5, `due in ${v.in}`);
  assert.deepEqual(board(h).later.map(j => j.id), [b, a], 'soonest first');
  assert.match(sync(h, ['--detail']).out, /\nLATER\n  l2 +test +web-app +at .*\(in (19|20)m\d\ds\) +echo smoke\n  l1 +sim +ios-agent +"ios snapshot suite" at /);
  // The plain board says the same in sentences, soonest first.
  // Run within 20 minutes of midnight, l2 is tomorrow and the board names the day.
  assert.match(sync(h, []).out, /\nLater +l2: web-app's echo smoke for test runs\n +at [\d:]+(?: [AP]M)?(?: \w{3}, \w{3} \d+)? \(in about (19|20) min\)\.\n +l1: ios-agent's "ios snapshot suite" for the simulator\n +at /);

  const mine = later(h, 'ios-agent', ['cancel', a]);
  assert.equal(mine.code, 0, mine.err);
  assert.match(mine.out, /cancelled l1; it won't run/);
  assert.equal(job(h, a).state, 'cancelled');
  assert.equal(later(h, 'ios-agent', ['cancel', a]).code, 1, 'already ended');
  assert.equal(later(h, 'ios-agent', ['cancel', 'l99']).code, 1);
  assert.equal(later(h, 'web-app', ['cancel', b], { env: { CLAUDECODE: '1' } }).code, 0, "another agent may cancel it");
  assert.deepEqual(board(h).later, []);
});

test('--in fires on time and the run waits its turn in the normal queue, output in its log', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const g = gate(t, dir);
  // The same project: deploys are one at a time per project (exclusiveBy repo).
  const blocker = bg(t, h, ['run', 'deploy', '--', ...g.cmd], { agent: 'web-app', cwd: dir });
  await until(() => g.started());
  const id = schedule(h, 'ios-agent', ['deploy', '--in', '1s', '-m', 'ship it', '--', 'sh', '-c', 'echo to-out; echo to-err >&2'], { cwd: dir });
  // waiting means its dibs run has started, which can be just before it's in line.
  await until(() => job(h, id).state === 'waiting' && board(h).waiting.some(q => q.who === 'ios-agent'));
  const w = board(h).waiting.find(q => q.who === 'ios-agent');
  assert.deepEqual([w.label, w.purpose, w.res], [`later ${id}`, 'ship it', ['deploy']]);
  g.open();
  assert.equal(await blocker.done, 0);
  await until(() => job(h, id).state === 'done');
  assert.equal(job(h, id).code, 0);
  assert.equal(job(h, id).late, null);
  const log = fs.readFileSync(job(h, id).log, 'utf8');
  assert.match(log, /^dibs later l1: sh -c echo to-out; echo to-err >&2 in .*, at .*, started /);
  assert.match(log, /\nto-out\n/);
  assert.match(log, /\nto-err\n/);
  assert.match(log, /\ndibs later l1: exit 0 at /);
});

test('--after an agent fires when its lease ends; --after-ok on a lease that failed is skipped', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const g = gate(t, dir);
  const deploy = bg(t, h, ['run', 'deploy', '--', ...g.cmd], { agent: 'web-app' });
  await until(() => g.started());
  const lease = board(h).held.find(l => l.who === 'web-app');
  const byName = schedule(h, 'qa', ['test', '--after', 'web-app', '-m', 'smoke tests', '--', 'sh', '-c', 'echo smoke > smoke'], { cwd: dir });
  const byId = schedule(h, 'qa', ['test', '--after', `#${lease.id}`, '--', 'touch', 'by-id'], { cwd: dir });
  assert.match(sync(h, ['--detail']).out, new RegExp(`l1 +test +qa +"smoke tests" after web-app's deploy \\(#${lease.id}\\)`));
  assert.match(sync(h, []).out, new RegExp(`l1: qa's "smoke tests" for test runs\n +after web-app's deploy \\(#${lease.id}\\)\\.`));
  // Nothing to wait on for "didn't fire early": give the runner two looks first.
  await wait(2500);
  assert.equal(job(h, byName).state, 'scheduled');
  assert.ok(!fs.existsSync(path.join(dir, 'smoke')));
  g.open();
  assert.equal(await deploy.done, 0);
  await until(() => job(h, byName).state === 'done' && job(h, byId).state === 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'smoke'), 'utf8'), 'smoke\n');
  assert.ok(fs.existsSync(path.join(dir, 'by-id')));

  const g2 = gate(t, tmp(t, 'second'));
  const failing = bg(t, h, ['run', 'deploy', '--', 'sh', '-c', `${g2.cmd[2]}; exit 4`], { agent: 'web-app' });
  await until(() => g2.started());
  const skip = schedule(h, 'qa', ['test', '--after-ok', 'web-app:deploy', '--', 'touch', 'nope'], { cwd: dir });
  g2.open();
  assert.equal(await failing.done, 4);
  await until(() => job(h, skip).state === 'skipped');
  assert.match(job(h, skip).why, /^#\d+ exited 4$/);
  assert.ok(!fs.existsSync(path.join(dir, 'nope')));
});

test("how a scheduled job ended reaches the person as a note in its agent's thread, a subagent's in its own", async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const threads = () => JSON.parse(sync(h, ['threads', '--json']).out).threads;
  const ok = schedule(h, 'ios-agent', ['test', '--in', '1s', '-m', 'ios snapshot suite', '--', 'true'], { cwd: dir });
  const bad = schedule(h, 'ios-agent', ['test', '--after-ok', ok, '--', 'false'], { cwd: dir });
  const skipped = schedule(h, 'ios-agent', ['test', '--after-ok', bad, '--', 'true'], { cwd: dir });
  await until(() => job(h, skipped).state === 'skipped');
  const notes = threads().find(th => th.to === 'ios-agent').messages.map(m => [m.kind, m.text]);
  assert.deepEqual(notes, [
    ['note', `${ok} (ios snapshot suite) finished: exit 0. Log: ${path.join(h, 'later', `${ok}.log`)}`],
    ['note', `${bad} (false) finished: exit 1. Log: ${path.join(h, 'later', `${bad}.log`)}`],
    ['note', `${skipped} (true) was skipped: ${bad} exited 1. Log: ${path.join(h, 'later', `${skipped}.log`)}`]]);
  assert.match(sync(h, []).out, /^3 notes are waiting for you: dibs threads$/m);

  // A subagent schedules one: the guard notes which agent ran dibs later, and the note lands in that agent's thread.
  const sub = { session_id: 'sess-a', agent_id: 'agent-7f3e9c', agent_type: 'Explore' };
  const words = ['test', '--in', '1s', '--', 'true'];
  const hooked = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: env(h),
    input: JSON.stringify({ ...sub, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command: `dibs later ${words.join(' ')}` } }) });
  assert.equal(hooked.status, 0, hooked.stderr);
  const mine = schedule(h, 'web-app', words, { cwd: dir, env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } });
  await until(() => job(h, mine).state === 'done');
  const th = threads().find(x => x.agentId === 'agent-7f3e9c');
  assert.equal(th?.to, 'web-app/Explore');
  assert.match(th.messages.at(-1).text, new RegExp(`^${mine} \\(true\\) finished: exit 0\\.`));
});

test('--after-ok an earlier later job runs only if it succeeded; --after runs either way', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const first = schedule(h, 'a', ['test', '--in', '1s', '--', 'sh', '-c', 'exit 3'], { cwd: dir });
  const ok = schedule(h, 'a', ['test', '--after-ok', first, '--', 'touch', 'ok'], { cwd: dir });
  const any = schedule(h, 'a', ['test', '--after', first, '--', 'touch', 'any'], { cwd: dir });
  const chained = schedule(h, 'a', ['test', '--after', ok, '--', 'touch', 'chained'], { cwd: dir });
  await until(() => job(h, any).state === 'done' && job(h, chained).state === 'skipped');
  assert.deepEqual([job(h, first).state, job(h, first).code], ['done', 3]);
  assert.deepEqual([job(h, ok).state, job(h, ok).why], ['skipped', `${first} exited 3`]);
  assert.equal(job(h, chained).why, `${ok} was skipped`);
  assert.ok(fs.existsSync(path.join(dir, 'any')));
  assert.ok(!fs.existsSync(path.join(dir, 'ok')) && !fs.existsSync(path.join(dir, 'chained')));
});

test('two runners racing start each job exactly once', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  await runner(t, h);
  assert.equal(runnerPids(h).length, 2);
  const ids = [1, 2, 3, 4].map(() => schedule(h, 'a', ['test', '--in', '1s', '--', 'sh', '-c', 'echo $DIBS_LATER_JOB >> runs'], { cwd: dir }));
  await until(() => ids.every(id => job(h, id).state === 'done'));
  assert.deepEqual(fs.readFileSync(path.join(dir, 'runs'), 'utf8').trim().split('\n').sort(), ids);
});

test('a runner restart: the running job finishes and is recorded, and a job due while no runner was up runs late and says so', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  const first = await runner(t, h);
  const g = gate(t, dir);
  const running = schedule(h, 'a', ['test', '--in', '1s', '--', ...g.cmd], { cwd: dir });
  const asleep = schedule(h, 'a', ['test', '--in', '3h', '--', 'echo', 'nightly'], { cwd: dir });
  await until(() => g.started());
  first.kill('SIGKILL');
  await first.done;
  // As if the machine slept through the job's time: it was due two hours ago.
  const file = path.join(h, 'later', 'jobs.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.jobs.find(j => j.id === asleep).at = Date.now() - 2 * 36e5;
  fs.writeFileSync(file, JSON.stringify(s));
  await runner(t, h);
  await until(() => job(h, asleep).state === 'done');
  assert.ok(job(h, asleep).late >= 2 * 36e5);
  assert.match(fs.readFileSync(job(h, asleep).log, 'utf8'), /ran late by 2h00m/);
  assert.match(sync(h, ['later', 'list']).out.replace(/\s+/g, ' '), /l2 .* finished with exit 0 at [\d:]+(?: [AP]M)?, ran late by 2 hr\./);
  assert.equal(job(h, running).state, 'running', 'the run outlived its runner');
  g.open();
  await until(() => job(h, running).state === 'done');
  assert.equal(job(h, running).code, 0);
  assert.match(fs.readFileSync(job(h, running).log, 'utf8'), /\nfinished\n/);
});

test('a job whose folder is gone fails clearly; a run that dies without an exit code is lost, not rerun', async t => {
  const h = tmp(t), gone = tmp(t, 'gone');
  await runner(t, h);
  const id = schedule(h, 'a', ['test', '--in', '1s', '--', 'echo', 'hi'], { cwd: gone });
  fs.rmSync(gone, { recursive: true });
  await until(() => job(h, id).state === 'failed');
  assert.match(job(h, id).why, /^its folder .*dibs-gone-\S+ is gone$/);

  const dir = tmp(t, 'proj');
  const g = gate(t, dir);
  const killed = schedule(h, 'a', ['test', '--in', '1s', '--', ...g.cmd], { cwd: dir });
  await until(() => job(h, killed).state === 'running');
  const pid = JSON.parse(fs.readFileSync(path.join(h, 'later', 'jobs.json'), 'utf8')).jobs.find(j => j.id === killed).pid;
  process.kill(pid, 'SIGKILL');
  await until(() => job(h, killed).state === 'lost');
  assert.match(job(h, killed).why, /without an exit code/);
});

test('cancel stops a running job and gives back its lease', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const g = gate(t, dir);
  const id = schedule(h, 'a', ['deploy', '--in', '1s', '--', ...g.cmd], { cwd: dir });
  await until(() => job(h, id).state === 'running');
  const r = later(h, 'a', ['cancel', id]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /stopped its run/);
  await until(() => !board(h).held.length);
  assert.equal(job(h, id).state, 'cancelled');
});

test('refused: more than 7 days out, a time already past, no time or two, an unknown target, a missing command', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const no = (args, code, re) => { const r = later(h, 'a', args, { cwd: dir }); assert.equal(r.code, code, `${args.join(' ')}: ${r.err}`); assert.match(r.err, re); };
  no(['test', '--in', '8d', '--', 'echo'], 2, /at most 168h00m ahead/);
  no(['test', '--at', new Date(Date.now() + 9 * 864e5).toISOString(), '--', 'echo'], 2, /at most 168h00m ahead/);
  no(['test', '--at', '2020-01-01T02:00', '--', 'echo'], 2, /has passed/);
  no(['test', '--', 'echo'], 2, /say when, once/);
  no(['test', '--in', '1h', '--after', 'l1', '--', 'echo'], 2, /say when, once/);
  no(['test', '--after', 'nobody-here', '--', 'echo'], 1, /nobody-here holds nothing/);
  no(['test', '--after', 'l7', '--', 'echo'], 1, /no l7 in dibs later list/);
  no(['test', '--after', '#999', '--', 'echo'], 1, /nothing on the board is #999/);
  no(['test', '--in', '1h', '--by', '2h', '--', 'echo'], 2, /--by doesn't go with dibs later/);
  no(['test', '--in', '1h', '--', 'no-such-command-here'], 127, /couldn't find no-such-command-here/);
  no(['test', '--in', '1h', '--env', 'NOT_SET_ANYWHERE_X', '--', 'echo'], 2, /isn't set here/);
  assert.equal(list(h).jobs.length, 0);
  assert.equal(schedule(h, 'a', ['test', '--in', '6d', '--', 'echo'], { cwd: dir }), 'l1', 'six days is fine');
});

test('the run gets PATH and HOME, and other variables only with --env', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  await runner(t, h);
  const env = { SECRET_TOKEN: 'abc', PASSED: 'yes' };
  const id = schedule(h, 'a', ['test', '--in', '1s', '--env', 'PASSED', '--env', 'SET=here', '--', 'sh', '-c', 'echo "[$SECRET_TOKEN][$PASSED][$SET][${HOME:+home}]" > env'], { cwd: dir, env });
  await until(() => job(h, id).state === 'done');
  assert.equal(fs.readFileSync(path.join(dir, 'env'), 'utf8'), '[][yes][here][home]\n');
  assert.equal(fs.statSync(path.join(h, 'later', 'jobs.json')).mode & 0o077, 0, 'only this user reads --env values');
});

test('the worker service runs scheduled jobs on a machine that never joined a coordinator', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  const w = bg(t, h, ['worker']);
  await until(() => runnerPids(h).includes(w.pid));
  const id = schedule(h, 'a', ['test', '--in', '1s', '--', 'touch', 'done'], { cwd: dir });
  await until(() => job(h, id).state === 'done');
  assert.ok(fs.existsSync(path.join(dir, 'done')));
  assert.match(w.out, /not connected to a coordinator yet/);
});

test('with no runner up, scheduling starts one that leaves once nothing is left', async t => {
  const h = tmp(t), dir = tmp(t, 'proj');
  const r = later(h, 'a', ['test', '--in', '1s', '--', 'touch', 'done'], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const pid = Number(r.err.match(/started a runner for scheduled jobs \(pid (\d+)\)/)?.[1]);
  assert.ok(pid, r.err);
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.match(r.err, /dibs service install worker/);
  await until(() => job(h, 'l1').state === 'done');
  assert.ok(fs.existsSync(path.join(dir, 'done')));
  await until(() => !alive(pid));
});
