// dibs progress tasks that went stale: past their ETA (overdue), quiet for hours
// (expired, no longer in progress), and their agents told while they're still open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { spawnSync } from 'node:child_process';
import { tmp, env, until, track, sync, BIN, HOOK } from './helpers.mjs';
import { tasks, EXPIRE_AFTER, QUIET_AFTER } from '../src/progress.mjs';
import { progressNoticesIn, NAG_EVERY } from '../src/notices.mjs';

const MIN = 6e4, H = 36e5, T = Date.UTC(2026, 10, 2, 18);
const post = (task, at, more = {}) => ({ at, who: 'a1', session: 'sess-a', project: 'app', task, state: 'doing', text: `on ${task}`, ...more });

// 2026-11-02: one task kept saying "due midnight" after its PR shipped; another read
// "in progress" with no post for hours.
test('a task past its ETA is overdue; one quiet for hours past its last post and its ETA is expired, not in progress', () => {
  const ks = tasks([
    post('late', T - 2 * H, { eta: T - H }),
    post('shipped', T - 6 * H, { eta: T - EXPIRE_AFTER - MIN }),
    post('quiet', T - EXPIRE_AFTER - MIN),
    post('fresh', T - 2 * H),
    post('closed', T - 9 * H, { state: 'done' }),
  ], T);
  const by = Object.fromEntries(ks.map(k => [k.task, k]));
  assert.deepEqual([by.late.state, by.late.overdue], ['doing', true]);
  assert.equal(by.shipped.state, 'expired');
  assert.equal(by.shipped.expiredAt, by.shipped.eta + EXPIRE_AFTER);
  assert.equal(by.quiet.state, 'expired');
  assert.deepEqual([by.fresh.state, by.fresh.overdue], ['doing', undefined]);
  assert.equal(by.closed.state, 'done');
});

test('an open task past its ETA or quiet for a while gets its agent one notice saying what to post; expired and closed ones none', () => {
  const ns = progressNoticesIn([
    post('late', T - 10 * MIN, { eta: T - 5 * MIN }),
    post('quiet', T - QUIET_AFTER - 5 * MIN),
    post('busy', T - 5 * MIN),
    post('gone', T - EXPIRE_AFTER - H),
    post('closed', T - 2 * H, { state: 'done' }),
    post('nosession', T - 2 * H, { session: undefined }),
  ], T);
  assert.deepEqual(ns.map(([to, once]) => [to.sessionId, once.split(':')[0], once.split(':')[3]]), [['sess-a', 'late', 'late'], ['sess-a', 'quiet', 'quiet']]);
  const [[, , late], [, , quiet]] = ns;
  assert.match(late, /your progress task "late" was due at .* and is still open\. If it's finished, say so: dibs progress 'where it stands' --task late --done/);
  assert.match(quiet, /your progress task "quiet" has had no post for 50 min\. Post where it stands \(dibs progress 'where it stands' --task quiet\), or close it/);
});

test('a task is nudged at most once every 2 hours, and not at all while its agent has stopped working', () => {
  const quiet = [post('quiet', T - QUIET_AFTER - 5 * MIN)];
  assert.equal(progressNoticesIn(quiet, T, { nagged: { [`${quiet[0].who}:main:quiet`]: T - NAG_EVERY + MIN } }).length, 0, 'nudged 1 hr 59 min ago');
  assert.equal(progressNoticesIn(quiet, T, { nagged: { [`${quiet[0].who}:main:quiet`]: T - NAG_EVERY } }).length, 1, 'two hours on, once more');
  assert.equal(progressNoticesIn(quiet, T, { working: () => false }).length, 0, 'no job running and none for 30 minutes: it waits for its agent quietly');
});

test('the throttle watcher leaves the notice for a quiet task, once, for the session that posted it', async t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'progress.jsonl'), `${JSON.stringify(post('review', Date.now() - QUIET_AFTER - 5 * MIN))}\n`);
  // Its agent ran a job a few minutes ago: it's at work, so its quiet task is worth a word.
  fs.writeFileSync(path.join(home, 'history.jsonl'), `${JSON.stringify({ key: 'test|npm test', dur: 1000, who: post('review', 0).who, at: Date.now() - 5 * MIN })}\n`);
  const watcher = spawn(process.execPath, [BIN, 'throttle', '--watch'], { env: env(home), stdio: 'ignore' });
  track(t, watcher);
  const notices = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'messages.json'), 'utf8')).messages.filter(m => m.kind === 'notice'); } catch { return []; } };
  await until(() => notices().length > 0);
  const [n] = notices();
  assert.equal(n.session, 'sess-a');
  assert.match(n.text, /your progress task "review" has had no post for/);
  await until(() => fs.existsSync(path.join(home, 'nags.json')));
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'nags.json'), 'utf8'))).length, 'the nudge is remembered, so a watcher restart can\'t repeat it');
});

test("a subagent's post is its own task: the hook names who posted, and its nudge goes to it, not to its lead", t => {
  const home = tmp(t);
  const sub = { session_id: 'sess-a', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default',
    tool_input: { command: 'dibs progress "fixing the flake" --task ask-actions-flake --eta 20m' }, agent_id: 'agent-7f3e9c', agent_type: 'flake-fixer' };
  const h = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(sub), env: env(home), encoding: 'utf8' });
  assert.equal(h.status, 0, h.stderr);
  const r = sync(home, ['progress', 'fixing the flake', '--task', 'ask-actions-flake', '--eta', '20m'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } });
  assert.equal(r.code, 0, r.err);
  const [p] = fs.readFileSync(path.join(home, 'progress.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual([p.agentId, p.label, p.session], ['agent-7f3e9c', 'flake-fixer', 'sess-a']);

  // The lead posts a task of the same name: two tasks, each nudged to its own poster.
  const T = p.at + 2 * H;
  const lead = { ...p, agentId: undefined, label: undefined, at: p.at, eta: undefined };
  const ns = progressNoticesIn([p, lead], T);
  assert.deepEqual(ns.map(([to]) => to.agentId || 'main').sort(), ['agent-7f3e9c', 'main']);
});

test("a subagent that ended with its task open: its lead hears once, and nothing is nudged to the gone subagent", () => {
  const p = post('ask-actions-flake', T - QUIET_AFTER - 5 * MIN, { agentId: 'agent-7f3e9c', label: 'flake-fixer' });
  const nagged = {};
  const [[to, , text, task]] = progressNoticesIn([p], T, { nagged, ended: () => true });
  assert.equal(to.agentId, undefined, 'to the session lead');
  assert.match(text, /^your subagent flake-fixer ended with its progress task "ask-actions-flake" still open .*Nothing to do: it's let go/);
  nagged[task] = T;
  assert.deepEqual(progressNoticesIn([p], T + 3 * H, { nagged, ended: () => true }), [], 'once, ever');
});
