// dibs progress list: the open tasks of the caller's session, or every session's
// with --all, each with its owner, state, ETA and last post.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmp, sync } from './helpers.mjs';

test('dibs progress list shows the open tasks of your session, --all every session\'s, --json the same as data', t => {
  const home = tmp(t, 'plist');
  const as = (agent, session, args) => sync(home, ['progress', ...args], { agent, env: { CLAUDE_CODE_SESSION_ID: session } });
  assert.equal(as('lead', 's1', ['parser split in two', '--task', 'parser', '--eta', '40m']).code, 0);
  assert.equal(as('lead', 's1', ['waiting on the person for prod', '--task', 'migrate', '--blocked']).code, 0);
  assert.equal(as('lead', 's1', ['shipped', '--task', 'old', '--done']).code, 0);
  assert.equal(as('crawler', 's2', ['crawl at 4,210 pages', '--task', 'crawl', '--eta', '2h']).code, 0);

  const mine = as('lead', 's1', ['list']);
  assert.equal(mine.code, 0, mine.err);
  assert.match(mine.out, /parser +lead +doing, expected by .*, last post \d+s ago\n +parser split in two/);
  assert.match(mine.out, /migrate +lead +blocked, no ETA/);
  assert.doesNotMatch(mine.out, /old|crawl/, 'closed tasks and other sessions are left out');
  assert.match(as('lead', 's1', ['list', '--all']).out, /crawl +crawler +doing/);
  const j = JSON.parse(as('lead', 's1', ['list', '--json']).out);
  assert.deepEqual(j.map(k => [k.task, k.who, k.state]).sort(), [['migrate', 'lead', 'blocked'], ['parser', 'lead', 'doing']]);
  assert.ok(j.find(k => k.task === 'parser').eta > Date.now());
  assert.match(as('nobody', 's3', ['list']).out, /Your session has no open tasks/);
  assert.equal(as('lead', 's1', ['--all']).code, 2, '--all goes with list');
});
