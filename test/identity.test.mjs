// Subagents of one Claude Code session share its name, so dibs tells them
// apart by the guard hook's note on each dibs call (which agent asked). Each
// one's board, dibs why and dibs mine are its own, and nothing reads like an
// agent waiting for itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, board, HOOK } from './helpers.mjs';

const S = 'session-1';
const env = { CLAUDE_CODE_SESSION_ID: S };

// What Claude Code does: the hook sees the subagent's Bash call, then dibs runs in its session.
function note(home, agent, type, args) {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: S, cwd: home, permission_mode: 'default',
    tool_input: { command: `dibs ${args.map(a => (/[\s"]/.test(a) ? `'${a}'` : a)).join(' ')}` }, ...(agent ? { agent_id: agent, agent_type: type } : {}) };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, DIBS_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
}
const as = (home, agent, type, args) => { note(home, agent, type, args); return sync(home, args, { agent: 'pm', env }); };
const bgAs = (t, home, agent, type, args) => { note(home, agent, type, args); return bg(t, home, args, { agent: 'pm', env }); };

test("a subagent's board, why and mine are its own; a sibling's job is named, never the session it shares", async t => {
  const home = tmp(t);
  fs.writeFileSync(`${home}/config.json`, JSON.stringify({ resources: { test: { slots: 1 } } }));
  bgAs(t, home, 'agent-a', 'fix-guard', ['run', 'test', '-m', 'guard tests', '--', 'sleep', '30']);
  // Its command started, not just its lease granted: until then mine and the board have no job to show.
  await until(() => board(home).held[0]?.pgid);
  const b = bgAs(t, home, 'agent-b', 'fix-talk', ['run', 'test', '-m', 'talk tests', '--', 'true']);
  await until(() => board(home).waiting.length === 1);

  const j = board(home);
  assert.deepEqual([j.held[0].agentId, j.held[0].label], ['agent-a', 'fix-guard'], 'the lease records which subagent took it');
  assert.deepEqual([j.waiting[0].agentId, j.waiting[0].label], ['agent-b', 'fix-talk'], 'and so does the wait');

  await until(() => /Waiting for/.test(b.err));
  assert.match(b.err, /pm\/fix-guard/, "the waiter's own message names the sibling");
  assert.doesNotMatch(b.err, /as soon as pm finishes|Waiting for pm's/, 'never the session name it shares');

  const why = as(home, 'agent-b', 'fix-talk', ['why']).out;
  assert.match(why, /^You're next in the test queue \("talk tests"\)\. Starts as soon as pm\/fix-guard finishes\.$/m);
  assert.doesNotMatch(why, /SendMessage|dibs yield pm/, 'no hint to ask itself to yield');

  const mineA = as(home, 'agent-a', 'fix-guard', ['mine']).out;
  assert.match(mineA, /^You're running tests \(#\d+, "guard tests"\): sleep 30/m);
  assert.doesNotMatch(mineA, /queue/, "its sibling's wait isn't its own");
  assert.equal(as(home, 'agent-b', 'fix-talk', ['mine', 'test']).code, 0);
  assert.doesNotMatch(as(home, 'agent-b', 'fix-talk', ['mine']).out, /You're running/);

  const detail = as(home, 'agent-b', 'fix-talk', ['--detail']).out;
  assert.match(detail, /sleep 30 {2}#1 {2}<- your session$/m);
  assert.match(detail, /talk tests.* {2}#2 {2}<- you$/m);
  const plain = as(home, 'agent-b', 'fix-talk', []).out;
  assert.equal(plain.split('\n').filter(l => /^You: /.test(l)).length, 1, 'one "You:" line, its own');

  // The main thread of the same session, unstamped by any note, still sees the session's jobs as before.
  assert.match(sync(home, ['mine'], { agent: 'pm', env }).out, /You're running[\s\S]*You're next/);
});

test('a general-purpose sibling goes by its -m reason, else the start of its id, on the board and in why', async t => {
  const home = tmp(t);
  fs.writeFileSync(`${home}/config.json`, JSON.stringify({ resources: { test: { slots: 1 } } }));
  bgAs(t, home, 'a1f00ba4c9d2e7', 'general-purpose', ['run', 'test', '-m', 'lint pass', '--', 'sleep', '30']);
  await until(() => board(home).held.length === 1);
  bgAs(t, home, 'a77e10aa3b6c55', 'general-purpose', ['run', 'test', '--', 'true']);
  await until(() => board(home).waiting.length === 1);
  const why = as(home, 'a77e10aa3b6c55', 'general-purpose', ['why']).out;
  assert.match(why, /Starts as soon as pm\/"lint pass" finishes\./);
  assert.match(as(home, 'a1f00ba4c9d2e7', 'general-purpose', []).out, /Next: pm\/77e10aa3/, 'no -m: the start of its id');
  assert.match(sync(home, ['--detail'], { agent: 'viewer' }).out, /test +pm\/"lint pass" /);
});

// The hook's view of a Bash command exactly as typed, $VARs and all.
function noteRaw(home, agent, type, command) {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: S, cwd: home, permission_mode: 'default', tool_input: { command }, agent_id: agent, agent_type: type };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, DIBS_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
}

test("two subagents' interleaved holds are each stamped with the agent that ran it, or with nobody when it can't be told", t => {
  const home = tmp(t), R = fs.realpathSync(home);
  const stamps = () => Object.fromEntries(board(home).held.map(l => [l.res.join(','), l.agentId ?? null]));
  // Both hooks run before either dibs does, and webreader's note is the newer one.
  noteRaw(home, 'adesignplus-1', 'designplus', 'dibs hold "files:$R/drag.ts" -m "designplus: drag"');
  noteRaw(home, 'awebreader-2', 'webreader', 'dibs hold "files:$R/reader.ts" -m "webreader: reader"');
  assert.equal(sync(home, ['hold', `files:${R}/drag.ts`, '-m', 'designplus: drag'], { agent: 'pm', env }).code, 0);
  assert.equal(sync(home, ['hold', `files:${R}/reader.ts`, '-m', 'webreader: reader'], { agent: 'pm', env }).code, 0);
  assert.equal(stamps()[`files:${R}/drag.ts`], 'adesignplus-1', "designplus's hold is its own");
  assert.equal(stamps()[`files:${R}/reader.ts`], 'awebreader-2', "and webreader's is webreader's");

  // The same words from both: either could be this call, so the lease is the session's, never a guess.
  noteRaw(home, 'adesignplus-1', 'designplus', `dibs hold files:${R}/menu.tsx`);
  noteRaw(home, 'awebreader-2', 'webreader', `dibs hold files:${R}/menu.tsx`);
  assert.equal(sync(home, ['hold', `files:${R}/menu.tsx`], { agent: 'pm', env }).code, 0);
  assert.equal(stamps()[`files:${R}/menu.tsx`], null);
  // A $VAR that splits into several words fits no note: unstamped too.
  noteRaw(home, 'awebreader-2', 'webreader', 'dibs hold $FILES');
  assert.equal(sync(home, ['hold', `files:${R}/x.ts`, `files:${R}/y.ts`], { agent: 'pm', env }).code, 0);
  const xy = board(home).held.find(l => l.res.includes(`files:${R}/x.ts`));
  assert.ok(xy, 'held');
  assert.equal(xy.agentId ?? null, null);
});
