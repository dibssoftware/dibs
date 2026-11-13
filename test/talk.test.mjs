// Talking with agents: the person's messages reach an agent through the guard
// hook (on its next tool call, or as it stops), agents leave notes with dibs
// say, and dibs threads shows one thread per agent. Hooks run as Claude Code
// runs them, against throwaway DIBS_HOMEs and settings files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, env, sync, board, HOOK } from './helpers.mjs';
import { install, installed } from '../src/guard.mjs';

const owner = { env: { DIBS_OWNER: '1' } };

// A DIBS_HOME plus a Claude Code sessions folder, so names resolve to sessions.
function setup(t, sessions = []) {
  const home = tmp(t, 'talk');
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir);
  for (const x of sessions) fs.writeFileSync(path.join(dir, `${x.pid}.json`), JSON.stringify(x));
  return { home, opts: (o = {}) => ({ ...o, env: { DIBS_SESSIONS: dir, ...o.env } }) };
}

function dibs(w, agent, args, o = {}) {
  const r = sync(w.home, args, w.opts({ agent, ...o }));
  return r;
}
const tell = (w, to, text) => dibs(w, 'person', ['tell', to, text], owner);
const threads = w => JSON.parse(dibs(w, 'viewer', ['threads', '--json']).out).threads;

function hook(w, input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: env(w.home, w.opts()), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const bash = (session, command, extra = {}) => ({ session_id: session, cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  permission_mode: 'default', tool_input: { command }, ...extra });
// A main agent stopping with its dibs listen running in the background, so the hook's re-arm line
// (test/listen.test.mjs) stays out of these tests of handing messages over.
const stopping = (session, extra = {}) => ({ session_id: session, cwd: '/work/app', hook_event_name: 'Stop', stop_hook_active: false,
  background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'dibs listen', command: 'dibs listen' }], ...extra });

// A pid that was alive a moment ago and isn't now.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim() * 1;
}

test("dibs tell reaches the agent once, on its next tool call, as context beside the call it doesn't change", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  const r = tell(w, 'web-app', 'use the staging database');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued for web-app: it gets it with its next tool call/);
  assert.equal(hook(w, bash('sess-other', 'ls')), null, "another session doesn't get it");

  const out = hook(w, bash('sess-a', 'ls')).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.match(out.additionalContext, /^dibs: a message for you, sent with `dibs tell`\..*\nMessage from the person: use the staging database\nTo answer them, run: dibs say/);
  assert.equal(out.permissionDecision, undefined, 'the call goes through the normal permission flow');
  assert.equal(out.updatedInput, undefined);
  assert.equal(hook(w, bash('sess-a', 'ls')), null, 'handed over once');
  assert.ok(!fs.existsSync(path.join(w.home, 'inbox.json')), 'with nothing queued, the hook has no file to read');

  const [th] = threads(w);
  assert.deepEqual(th.messages.map(m => [m.from, m.kind, m.state]), [['person', 'message', 'delivered'], ['agent', 'delivered', null]]);
});

// 2026-11-02: "dibs tell alex-a4" answered "queued for alex-8e, but its session has ended"
// while a4 was running: its session had been 8e on an earlier run, under a pid long gone.
test('dibs tell reaches a session by its name now, after it was renamed and resumed under a new pid', t => {
  const w = setup(t, [{ pid: deadPid(), sessionId: 'sess-x', name: 'alex-8e' }]);
  assert.match(tell(w, 'alex-8e', 'first').out, /its session has ended/);
  const dir = path.join(w.home, 'sessions');
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-x', name: 'alex-a4' }));
  const r = tell(w, 'alex-a4', 'second');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^queued for alex-a4: it gets it with its next tool call/);
  const out = hook(w, bash('sess-x', 'ls')).hookSpecificOutput.additionalContext;
  assert.match(out, /first[\s\S]*second/, 'both reach the session, the one queued under its old name too');
});

test("the guard's own refusal comes first: the message waits for the next call, and joins a rewrite's context", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  assert.equal(tell(w, 'web-app', 'stop after this build').code, 0);
  const denied = hook(w, bash('sess-a', 'npm test')).hookSpecificOutput;
  assert.equal(denied.permissionDecision, 'deny');
  assert.doesNotMatch(JSON.stringify(denied), /stop after this build/);

  fs.writeFileSync(path.join(w.home, 'config.json'), JSON.stringify({ guard: { rewrite: 'always' } }));
  const rewritten = hook(w, bash('sess-a', 'npm test')).hookSpecificOutput;
  assert.equal(rewritten.permissionDecision, 'allow');
  assert.match(rewritten.updatedInput.command, /dibs.* run test/);
  assert.match(rewritten.additionalContext, /dibs guard ran this through dibs[\s\S]*\n\ndibs: a message for you, sent with `dibs tell`[^\n]*\nMessage from the person: stop after this build/);
});

test('an agent about to stop is kept going to read the message, once, and never on a stop hook continuation', t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  assert.equal(hook(w, stopping('sess-a')), null, 'nothing queued: it stops');
  assert.equal(tell(w, 'web-app', 'one more thing: bump the build number').code, 0);
  assert.equal(hook(w, stopping('sess-a', { stop_hook_active: true })), null, 'already kept going by a stop hook: not again');

  const out = hook(w, stopping('sess-a'));
  assert.equal(out.decision, undefined, "not a block: Claude Code shows a block's reason as a hook error");
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(out.hookSpecificOutput.additionalContext, /\nMessage from the person: one more thing: bump the build number\n/);
  assert.equal(hook(w, stopping('sess-a', { stop_hook_active: true })), null, 'the next stop goes through: no loop');
  assert.equal(hook(w, stopping('sess-a')), null);
  const m = threads(w)[0].messages;
  assert.equal(m[0].state, 'delivered');
  assert.equal(m[1].text, 'got it as it was finishing, and kept going');
});

test("a subagent's thread is its own: a message to it skips the main agent and reaches it, or stops it from stopping", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  const sub = { agent_id: 'agent-7f3e9c', agent_type: 'Explore' };
  // The guard sees which agent runs dibs say; dibs say claims that note.
  assert.equal(hook(w, bash('sess-a', 'dibs say "found the bug in auth.ts"', sub)), null);
  const said = dibs(w, 'web-app', ['say', 'found the bug in auth.ts'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } });
  assert.equal(said.code, 0, said.err);
  assert.equal(dibs(w, 'web-app', ['say', 'starting the fix'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } }).code, 0);

  const list = threads(w);
  assert.deepEqual(list.map(th => [th.to, th.agentId, th.label]).sort(), [['web-app', 'main', ''], ['web-app/Explore', 'agent-7f3e9c', 'Explore']]);
  assert.deepEqual(list.find(th => th.agentId !== 'main').messages.map(m => m.text), ['found the bug in auth.ts']);

  assert.equal(tell(w, 'web-app/Explore', 'check the tests too').code, 0);
  assert.equal(hook(w, bash('sess-a', 'ls')), null, 'the main agent of the session does not get it');
  assert.match(hook(w, bash('sess-a', 'ls', sub)).hookSpecificOutput.additionalContext, /check the tests too/);

  assert.equal(tell(w, 'web-app/Explore', 'and the docs').code, 0);
  const out = hook(w, { session_id: 'sess-a', hook_event_name: 'SubagentStop', stop_hook_active: false, ...sub });
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStop');
  assert.match(out.hookSpecificOutput.additionalContext, /and the docs/);
  assert.equal(hook(w, { session_id: 'sess-a', hook_event_name: 'SubagentStop', stop_hook_active: true, ...sub }), null);
  assert.equal(threads(w).find(th => th.agentId !== 'main').alive, false, 'a finished subagent shows as not running');
});

test("a message to an agent whose session has ended stays queued, shown as not delivered", t => {
  const w = setup(t, [{ pid: deadPid(), sessionId: 'sess-old', name: 'old-app' }]);
  const r = tell(w, 'old-app', 'are you still there?');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /its session has ended\. It stays queued/);
  const [th] = threads(w);
  assert.deepEqual([th.to, th.alive, th.messages[0].state], ['old-app', false, 'queued']);
  assert.match(dibs(w, 'viewer', ['threads']).out.replace(/\s+/g, ' '), /old-app not running, last heard just now \(your message is not delivered yet\)/);
  assert.equal(hook(w, bash('sess-old', 'ls')).hookSpecificOutput.additionalContext.split('\n')[1], 'Message from the person: are you still there?',
    'a session that comes back still gets it');

  const nobody = tell(w, 'never-was', 'hello');
  assert.equal(nobody.code, 1);
  assert.match(nobody.err, /no agent called never-was\. Threads: old-app/);
});

test('dibs say leaves a note in the agent thread, and the board counts it with the questions', t => {
  const w = setup(t);
  assert.equal(dibs(w, 'web-app', ['question', 'Ship build 123 now?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'tests pass', '--one-way', 'it can not be taken back once done']).code, 0);
  const r = dibs(w, 'web-app', ['say', 'blocked on the App Store review']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Sent to the person\. They see it in dibs threads\./);
  assert.match(dibs(w, 'viewer', []).out, /^1 question and 1 note are waiting for you: dibs threads$/m);
  assert.match(dibs(w, 'viewer', ['--detail']).out.split('\n')[0], /^1 question and 1 note for you: dibs threads$/);
  assert.equal(board(w.home, w.opts()).notes, 1);

  const [th] = threads(w);
  assert.equal(th.agent, 'web-app');
  assert.deepEqual(th.messages.map(m => [m.kind, m.text]), [['question', 'Ship build 123 now?'], ['note', 'blocked on the App Store review']]);
  assert.equal(th.unread, 2);

  const read = dibs(w, 'person', ['threads', 'read', 'web-app'], owner);
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /them: asked \(#1, open\): Ship build 123 now\?  \(yes \/ no\)  they recommend yes: tests pass\. Can't be undone: it can not be taken back once done\n.*them: FYI: blocked on the App Store review/);
  assert.match(read.out, /Answer a question: dibs answer <id> <text>/);
  assert.equal(threads(w)[0].unread, 0);
  assert.match(dibs(w, 'viewer', []).out, /^1 question is waiting for your answer: dibs questions$/m);
  assert.match(dibs(w, 'viewer', ['--detail']).out.split('\n')[0], /^1 question for you: dibs questions$/);
});

test('dibs threads --json: one thread per agent, newest first, with its questions, answers, notes and messages', t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-b', name: 'api' }]);
  assert.equal(dibs(w, 'web-app', ['say', 'starting']).code, 0);
  assert.equal(dibs(w, 'web-app', ['question', 'Rename the app now?', '--recommend', 'no', '-m', 'name is fine', '--one-way', 'it can not be taken back once done']).code, 0);
  assert.equal(dibs(w, 'person', ['answer', '1', 'no'], owner).code, 0);
  assert.equal(tell(w, 'api', 'rebase on main first').code, 0);
  const list = threads(w);
  assert.deepEqual(list.map(th => th.to), ['api', 'web-app']);
  for (const th of list) {
    assert.deepEqual(Object.keys(th).sort(), ['agent', 'agentId', 'alive', 'label', 'last', 'messages', 'reach', 'session', 'to', 'unread', 'working']);
    for (const m of th.messages) for (const k of ['id', 'at', 'from', 'kind', 'text', 'options', 'questionId', 'state']) assert.ok(k in m, `${k} in ${JSON.stringify(m)}`);
  }
  const [api, web] = list;
  assert.deepEqual([api.agent, api.session, api.alive, api.working], ['api', 'sess-b', true, 'idle']);
  assert.deepEqual(api.messages.map(m => [m.from, m.kind, m.state]), [['person', 'message', 'queued']]);
  assert.deepEqual(web.messages.map(m => [m.from, m.kind, m.text, m.questionId, m.state]),
    [['agent', 'note', 'starting', null, null], ['agent', 'question', 'Rename the app now?', 1, 'answered'], ['person', 'answer', 'no', 1, null],
      ['person', 'message', '(answering your question #1) no', null, 'queued']]);
  // --json names the resource, for the Mac app; the terminal says it like the board does.
  assert.equal(dibs(w, 'web-app', ['hold', 'sim', '--for', '5m', '-m', 'snapshots']).code, 0);
  assert.equal(threads(w).find(th => th.to === 'web-app').working, 'using sim for "snapshots"');
  assert.match(dibs(w, 'viewer', ['threads']).out, /web-app +using the simulator for "snapshots", last heard/);
});

test('install adds the Stop hook, and upgrades a 0.0.70 install that lacks it, once', t => {
  const file = path.join(tmp(t), 'settings.json');
  const cmd = '/opt/dibs/bin/dibs-guard.mjs';
  const g = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  const other = { hooks: [{ type: 'command', command: 'say done' }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [g('Bash|Edit|Write|MultiEdit|NotebookEdit'), g('Agent|Task')],
    SubagentStart: [g()], SubagentStop: [g()], Stop: [other] } }, null, 2));
  assert.equal(installed(file).command, cmd);
  assert.match(install(file, cmd), /updated/);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.hooks.Stop, [other, g()]);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.match(install(file, cmd), /already installed/);
});

// dibs leaving a notice the way a producer does (a run, the throttle watcher), from its own process.
const TALK = new URL('../src/talk.mjs', import.meta.url).href;
function leave(w, to, once, text) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { notify } from ${JSON.stringify(TALK)}; console.log(notify(${JSON.stringify(to)}, ${JSON.stringify(once)}, ${JSON.stringify(text)}))`],
  { env: env(w.home, w.opts()), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === 'true';
}

test("a notice from dibs reaches the agent whose job it's about, once, on its next tool call, and never stops it from stopping", t => {
  const w = setup(t);
  const job = { sessionId: 'sess-a', agentId: 'agent-7', who: 'web-app' };
  assert.equal(leave(w, job, 'idle:#12', 'your job #12 has been idle 20 min.'), true);
  assert.equal(leave(w, job, 'idle:#12', 'your job #12 has been idle 25 min.'), false, 'one notice per event, however often the producer asks');
  assert.equal(hook(w, bash('sess-a', 'ls')), null, "the session's main agent doesn't get its subagent's notice");
  assert.equal(hook(w, stopping('sess-a', { hook_event_name: 'SubagentStop', agent_id: 'agent-7' })), null, 'a notice never keeps an agent going');

  const out = hook(w, bash('sess-a', 'ls', { agent_id: 'agent-7', agent_type: 'tester' })).hookSpecificOutput;
  assert.equal(out.permissionDecision, undefined, 'the call itself is unchanged');
  assert.match(out.additionalContext, /^dibs \(the queue for shared machine resources this session uses\) has a notice about your jobs\..*\n- your job #12 has been idle 20 min\.$/);
  assert.doesNotMatch(out.additionalContext, /Message from the person|dibs say/, "it isn't dressed up as the person's");
  assert.equal(hook(w, bash('sess-a', 'ls', { agent_id: 'agent-7' })), null, 'handed over once');
  assert.ok(!fs.existsSync(path.join(w.home, 'inbox.json')), 'nothing queued: no file for the hook to read');
  assert.equal(leave(w, job, 'idle:#12', 'again'), false, 'and not left again after it was handed over');
});

test("dibs's notices to an agent go only to its hook, never into the person's threads", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  assert.equal(tell(w, 'web-app', 'hi').code, 0);
  leave(w, { sessionId: 'sess-a', who: 'web-app' }, 'mem:#3', 'your job #3 used 5.0 GB.');
  assert.ok(!threads(w)[0].messages.some(m => m.kind === 'notice' || /5\.0 GB/.test(m.text)));
  assert.doesNotMatch(dibs(w, 'viewer', ['threads', 'read', 'web-app']).out, /5\.0 GB/);
  assert.match(hook(w, bash('sess-a', 'ls')).hookSpecificOutput.additionalContext, /- your job #3 used 5\.0 GB\./);
});

test("a person's message and a notice arrive together, each introduced for what it is", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  assert.equal(tell(w, 'web-app', 'wrap up soon').code, 0);
  leave(w, { sessionId: 'sess-a', who: 'web-app' }, 'dup:#4', 'you already have this exact command queued as #4.');
  const text = hook(w, bash('sess-a', 'ls')).hookSpecificOutput.additionalContext;
  assert.match(text, /^dibs: a message for you, sent with `dibs tell`[^\n]*\nMessage from the person: wrap up soon\nTo answer them, run: dibs say "\.\.\."\n\ndibs \(the queue[^\n]*\n- you already have this exact command queued as #4\.$/);
});

test('outside Claude Code, a notice comes with the next dibs command, on stderr, once', t => {
  const w = setup(t);
  leave(w, { who: 'codex-a' }, 'mem:#3', 'your last run of npm test used 5.1 GB but asked for 2 GB: next time pass --mem 6G.');
  assert.doesNotMatch(dibs(w, 'codex-b', ['why']).err, /npm test/, "another agent doesn't get it");
  const r = dibs(w, 'codex-a', ['why']);
  assert.equal(r.code, 0);
  assert.match(r.err, /^dibs has a notice about your jobs:\n- your last run of npm test used 5\.1 GB but asked for 2 GB: next time pass --mem 6G\.$/m);
  assert.doesNotMatch(r.out, /npm test/, 'stdout stays what scripts read');
  assert.doesNotMatch(dibs(w, 'codex-a', ['why']).err, /npm test/, 'once');
});

// 2026-11-03: an idle Shop session held two of the owner's messages for hours, while
// dibs tell had said "it gets it with its next tool call".
test('dibs tell says when the agent is idle and not listening, so nothing will hand the message over yet', t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-idle', name: 'quiet-one', status: 'idle' }]);
  const r = tell(w, 'quiet-one', 'are you there?');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued for quiet-one, but quiet-one is idle and not listening: it won't see this until it next works/);
  const busy = setup(t, [{ pid: process.pid, sessionId: 'sess-busy', name: 'busy-one', status: 'busy' }]);
  assert.match(tell(busy, 'busy-one', 'hi').out, /queued for busy-one: it gets it with its next tool call/);
});

// 2026-11-03: "dibs tell alex-2e" said "isn't a Claude Code session" while session
// 8176ff00 by that name ran; earlier, tells went to sessions long dead (a4 to 8e).
test('dibs tell goes to the running session with that name, not an old thread or a dead session', t => {
  const dead = deadPid();
  const w = setup(t, [{ pid: dead, sessionId: 'sess-dead', name: 'web-app' }, { pid: process.pid, sessionId: 'sess-live', name: 'web-app', status: 'busy' }]);
  // An old thread under that name with no session (a terminal once ran dibs say as web-app).
  assert.equal(dibs(w, 'web-app', ['say', 'from a terminal']).code, 0);
  const r = tell(w, 'web-app', 'use staging');
  assert.match(r.out, /queued for web-app: it gets it with its next tool call/);
  assert.equal(hook(w, bash('sess-dead', 'ls')), null, 'not to the dead session');
  assert.match(hook(w, bash('sess-live', 'ls')).hookSpecificOutput.additionalContext, /Message from the person: use staging/);
});

// 2026-11-10: Claude Code left ~/.claude/sessions/43095.json with a stray } after the object, and
// the session dropped out of everything that reads those files.
test('a session file with junk after its record still names its session', t => {
  const w = setup(t);
  fs.writeFileSync(path.join(w.home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }) + '\n}');
  const r = tell(w, 'web-app', 'use the staging database');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued for web-app/);
  assert.match(hook(w, bash('sess-a', 'ls')).hookSpecificOutput.additionalContext, /Message from the person: use the staging database/);
});

const json = w => JSON.parse(dibs(w, 'viewer', ['threads', '--json']).out);

// 2026-11-11: the page and the app said "A message reaches its agent with its next tool call"
// for every agent, idle ones too, and once one had it, only a separate line said so.
test('a message to an agent says how it would reach it now, and once handed over, when and how', t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app', status: 'busy' }]);
  assert.equal(tell(w, 'web-app', 'use staging').code, 0);
  let [th] = threads(w);
  assert.equal(th.reach, 'working');
  const sent = th.messages.find(m => m.kind === 'message');
  assert.equal(sent.state, 'queued');
  assert.equal(sent.deliveredAt, undefined);
  const before = Date.now();
  hook(w, bash('sess-a', 'ls'));
  [th] = threads(w);
  const got = th.messages.find(m => m.kind === 'message');
  assert.equal(got.state, 'delivered');
  assert.equal(got.via, 'tool');
  assert.ok(got.deliveredAt >= before && got.deliveredAt <= Date.now());

  const idle = setup(t, [{ pid: process.pid, sessionId: 'sess-i', name: 'quiet-one', status: 'idle' }]);
  assert.equal(tell(idle, 'quiet-one', 'hi').code, 0);
  assert.equal(threads(idle)[0].reach, 'idle');
  const gone = setup(t, [{ pid: deadPid(), sessionId: 'sess-d', name: 'old-one' }]);
  assert.equal(tell(gone, 'old-one', 'hi').code, 0);
  assert.equal(threads(gone)[0].reach, 'ended');
});

// 2026-11-11: a steward agent's messages to "Poker pro hand history databases" showed on the
// page in the person's own bubbles, and its thread list said "You: Steward follow-up".
test("an agent's message to another is in the between stream, from and to, and never reads as the person's", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app', status: 'busy' }]);
  const r = dibs(w, 'steward', ['tell', 'web-app', 'the pod is stopped'], { env: { AI_AGENT: '1' } });
  assert.equal(r.code, 0, r.err);
  let j = json(w);
  assert.deepEqual(j.between.map(m => [m.from, m.to, m.text, m.state]), [['steward', 'web-app', 'the pod is stopped', 'queued']]);
  assert.equal(j.threads[0].unread, 0);
  hook(w, bash('sess-a', 'ls'));
  j = json(w);
  assert.equal(j.between[0].state, 'delivered');
  assert.equal(j.between[0].via, 'tool');
  assert.match(dibs(w, 'viewer', ['threads']).out, /steward: the pod is stopped/);
  assert.doesNotMatch(dibs(w, 'viewer', ['threads']).out, /You: the pod/);
  assert.match(dibs(w, 'viewer', ['threads', 'read', 'web-app']).out, /steward, another agent,: the pod is stopped/);
});

// 2026-11-11: 46 of one thread's 46 unread were "l446 (post-merge QUICK ...) finished: exit 0",
// notes dibs later wrote in the agent's name, and the Messages count read 170.
test("dibs's own notes and notices are in the from-dibs stream, never unread conversation", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }]);
  // Written before notes carried a flag: known by their wording.
  assert.equal(dibs(w, 'web-app', ['say', 'l3 (ios snapshot suite) finished: exit 0. Log: ~/.dibs/later/l3.log']).code, 0);
  assert.equal(dibs(w, 'web-app', ['say', 'the build is green']).code, 0);
  leave(w, { sessionId: 'sess-a', who: 'web-app' }, 'mem:#3', 'your job #3 used 5.0 GB.');
  const j = json(w);
  const th = j.threads.find(x => x.agent === 'web-app');
  assert.deepEqual(th.messages.map(m => m.text), ['the build is green']);
  assert.equal(th.unread, 1);
  assert.deepEqual(j.fromDibs.map(m => [m.kind, m.text]), [['note', 'l3 (ios snapshot suite) finished: exit 0. Log: ~/.dibs/later/l3.log'], ['notice', 'your job #3 used 5.0 GB.']]);
  assert.equal(j.fromDibs[1].to, 'web-app');
  assert.equal(board(w.home, w.opts()).notes, 1);
});

// 2026-11-11: an opencode agent's message was signed "alex#92133", and "dibs say --to
// alex#92133" answered "no agent called alex#92133". The hook also said "To answer
// them, run: dibs say", which sent the reply to the person instead of the agent that wrote.
test("an agent's message, from outside Claude Code too, is signed with a name a reply reaches, and says how to reply to it", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app', status: 'busy' }]);
  const opencode = { env: { OPENCODE: '1' } };
  assert.equal(dibs(w, 'repo#4242', ['tell', 'web-app', 'is the pod up?'], opencode).code, 0);
  assert.equal(dibs(w, 'Poker hands', ['tell', 'web-app', 'hand 12 is ready'], opencode).code, 0);
  const text = hook(w, bash('sess-a', 'ls')).hookSpecificOutput.additionalContext;
  assert.match(text, /\nMessage from repo#4242 \(another agent, not the person\): is the pod up\?\n/);
  assert.match(text, /\nTo answer repo#4242, run: dibs say --to repo#4242 "\.\.\."(\n|$)/);
  assert.match(text, /\nTo answer Poker hands, run: dibs say --to 'Poker hands' "\.\.\."(\n|$)/);
  assert.doesNotMatch(text, /run: dibs say "/, 'plain dibs say would go to the person');

  const r = dibs(w, 'web-app', ['say', '--to', 'repo#4242', 'yes, since 3:10'], { env: { AI_AGENT: '1' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Sent as a message to repo#4242 \(dibs tell repo#4242\): it isn't a Claude Code session, so it gets it with its next dibs command\.$/m);
  assert.equal(dibs(w, 'web-app', ['tell', 'Poker hands', 'thanks'], { env: { AI_AGENT: '1' } }).code, 0);

  // No Claude session, no hook: the reply comes with the agent's next dibs command, once.
  const got = dibs(w, 'repo#4242', ['why'], opencode);
  assert.match(got.err, /Message from web-app \(another agent, not the person\): yes, since 3:10\nTo answer web-app, run: dibs say --to web-app "\.\.\."/);
  assert.doesNotMatch(got.err, /Claude Code settings/, "it didn't come through the Claude Code hook");
  assert.doesNotMatch(dibs(w, 'repo#4242', ['why'], opencode).err, /since 3:10/, 'once');
  assert.match(dibs(w, 'Poker hands', ['why'], opencode).err, /Message from web-app \(another agent, not the person\): thanks/);
  const j = json(w);
  assert.deepEqual(j.between.map(m => [m.from, m.to, m.state]),
    [['repo#4242', 'web-app', 'delivered'], ['Poker hands', 'web-app', 'delivered'], ['web-app', 'repo#4242', 'delivered'], ['web-app', 'Poker hands', 'delivered']]);
  assert.equal(j.threads.find(x => x.to === 'repo#4242').reach, 'command');
  assert.ok(!j.between.some(m => m.fromGone), 'every sender is a name a reply reaches');
});

// 2026-11-11: a session the person knows as "Poker app iOS issue" signed its message
// "alex" (its folder), and nothing answered to that name.
test("an agent whose process dibs can't place signs with its Claude Code session's name, and a reply reaches it", t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app', status: 'busy' }, { pid: process.ppid, sessionId: 'sess-b', name: 'Poker app', status: 'busy' }]);
  const r = dibs(w, '', ['tell', 'web-app', 'ack'], { env: { AI_AGENT: '1', CLAUDE_CODE_SESSION_ID: 'sess-b' } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(json(w).between.map(m => [m.from, m.to]), [['Poker app', 'web-app']]);
  assert.match(hook(w, bash('sess-a', 'ls')).hookSpecificOutput.additionalContext, /To answer Poker app, run: dibs say --to 'Poker app' "\.\.\."/);
  assert.equal(dibs(w, 'web-app', ['say', '--to', 'Poker app', 'got it'], { env: { AI_AGENT: '1' } }).code, 0);
  assert.match(hook(w, bash('sess-b', 'ls')).hookSpecificOutput.additionalContext, /Message from web-app \(another agent, not the person\): got it/);
});

// 2026-11-11: alex-d7 answered other agents with plain dibs say ("alex-d7 to Atlas
// team-lead: ..."), as the hook told it to; the person saw three unread notes meant for an agent.
test('a note an agent signs to another agent is in the between stream, not unread, and plain dibs say after an agent message says how to answer it', t => {
  const w = setup(t, [{ pid: process.pid, sessionId: 'sess-a', name: 'web-app', status: 'busy' }]);
  assert.equal(dibs(w, 'lead', ['tell', 'web-app', 'free some disk'], { env: { AI_AGENT: '1' } }).code, 0);
  hook(w, bash('sess-a', 'ls'));
  const r = dibs(w, 'web-app', ['say', 'web-app to lead: freed 2 GB'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /The last message you got was from lead, another agent\. To answer it: dibs say --to lead "\.\.\."/);
  assert.equal(dibs(w, 'web-app', ['say', 'the build is green'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } }).code, 0);
  const j = json(w);
  const th = j.threads.find(x => x.to === 'web-app');
  assert.deepEqual(th.messages.filter(m => m.kind === 'note').map(m => m.text), ['the build is green']);
  assert.equal(th.unread, 1);
  assert.deepEqual(j.between.map(m => [m.from, m.to, m.text]), [['lead', 'web-app', 'free some disk'], ['web-app', 'lead', 'web-app to lead: freed 2 GB']]);
  assert.equal(board(w.home, w.opts()).notes, 1);
});
