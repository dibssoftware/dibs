// dibs progress tasks that went stale: past their ETA (overdue), quiet for hours
// (expired, no longer in progress), and their agents told while they're still open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, env, until, track, BIN } from './helpers.mjs';
import { tasks, EXPIRE_AFTER, QUIET_AFTER } from '../src/progress.mjs';
import { progressNoticesIn } from '../src/notices.mjs';

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
  assert.deepEqual(ns.map(([to, once]) => [to.sessionId, once.split(':')[0], once.split(':')[2]]), [['sess-a', 'late', 'late'], ['sess-a', 'quiet', 'quiet']]);
  const [[, , late], [, , quiet]] = ns;
  assert.match(late, /your progress task "late" was due at .* and is still open\. If it's finished, say so: dibs progress 'where it stands' --task late --done/);
  assert.match(quiet, /your progress task "quiet" has had no post for 50 min\. Post where it stands \(dibs progress 'where it stands' --task quiet\), or close it/);
});

test('the throttle watcher leaves the notice for a quiet task, once, for the session that posted it', async t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'progress.jsonl'), `${JSON.stringify(post('review', Date.now() - QUIET_AFTER - 5 * MIN))}\n`);
  const watcher = spawn(process.execPath, [BIN, 'throttle', '--watch'], { env: env(home), stdio: 'ignore' });
  track(t, watcher);
  const notices = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'messages.json'), 'utf8')).messages.filter(m => m.kind === 'notice'); } catch { return []; } };
  await until(() => notices().length > 0);
  const [n] = notices();
  assert.equal(n.session, 'sess-a');
  assert.match(n.text, /your progress task "review" has had no post for/);
});
