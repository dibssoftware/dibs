// dibs listen: an agent whose turn is over waits for a message instead of
// missing it until its next tool call. Run as Claude Code runs it (with
// CLAUDE_CODE_SESSION_ID set), against throwaway DIBS_HOMEs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, env, sync, bg, until, board, alive, HOOK, BIN } from './helpers.mjs';

const owner = { env: { DIBS_OWNER: '1' } };

function setup(t) {
  const home = tmp(t, 'listen');
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sess-a', name: 'web-app' }));
  const opts = (o = {}) => ({ ...o, env: { DIBS_SESSIONS: dir, ...o.env } });
  const listen = (args = []) => bg(t, home, ['listen', ...args], opts({ agent: 'web-app', env: { CLAUDE_CODE_SESSION_ID: 'sess-a' } }));
  const tell = text => sync(home, ['tell', 'web-app', text], opts({ agent: 'person', ...owner }));
  const threads = () => JSON.parse(sync(home, ['threads', '--json'], opts({ agent: 'viewer' })).out).threads;
  const hook = input => {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: env(home, opts()), encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  return { home, listen, tell, threads, hook, opts };
}
const bash = command => ({ session_id: 'sess-a', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: 'default', tool_input: { command } });
const listening = w => w.threads().some(th => th.to === 'web-app' && th.working === 'listening');

test('dibs listen waits for a message, prints it as the hook would, marks it delivered and exits 0', async t => {
  const w = setup(t);
  const p = w.listen();
  await until(() => listening(w));
  assert.match(board(w.home, w.opts()).listening.join(), /web-app/, 'the board says who is listening');
  const r = w.tell('the staging database is back');
  assert.match(r.out, /it's listening \(dibs listen\), so it gets it within seconds/);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /^First start dibs listen again with run_in_background, so the next message wakes you too\.\n\ndibs: a message for you, sent with `dibs tell`\..*\nMessage from the person: the staging database is back\nTo answer them, run: dibs say/);
  const th = w.threads().find(x => x.to === 'web-app');
  assert.deepEqual(th.messages.filter(m => m.kind !== 'note').map(m => [m.from, m.kind, m.state, m.text]).slice(-2),
    [['person', 'message', 'delivered', 'the staging database is back'], ['agent', 'delivered', null, 'got it while listening']]);
  assert.notEqual(th.working, 'listening', 'nobody listening once it has its message');
  assert.equal(w.hook(bash('ls')), null, 'the hook has nothing left to hand over');
});

test('a message already queued is handed over at once, and --json says what came', async t => {
  const w = setup(t);
  w.tell('first');
  w.tell('second');
  const p = w.listen(['--json']);
  assert.equal(await p.done, 0, p.err);
  assert.deepEqual(JSON.parse(p.out).messages.map(m => [m.from, m.text]), [['person', 'first'], ['person', 'second']]);
});

test('nothing in time: exit 3 with one line, and no listener left behind', async t => {
  const w = setup(t);
  const p = w.listen(['--for', '1s']);
  assert.equal(await p.done, 3, p.err);
  assert.equal(p.out.trim(), 'no messages in 1s; run it again to keep listening');
  assert.ok(!listening(w));
  assert.deepEqual(board(w.home, w.opts()).listening, []);
});

// The owner, 2026-11-05: "why does dibs listen stop after an hour". It has no limit now.
test('a listener with no --for keeps waiting, poll after poll, until something comes', async t => {
  const w = setup(t);
  const p = bg(t, w.home, ['listen'], w.opts({ agent: 'web-app', env: { CLAUDE_CODE_SESSION_ID: 'sess-a', DIBS_LISTEN_POLL: '50' } }));
  await until(() => listening(w));
  // Sixty looks at its queue and its session: no deadline among them ends it.
  await new Promise(r => setTimeout(r, 3000));
  assert.equal(p.exitCode, null, `still listening: ${p.out}${p.err}`);
  assert.ok(listening(w));
  w.tell('still there?');
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /still there\?/);
});

test('a listener whose session is gone leaves quietly: exit 0, no output, and off the list', async t => {
  const w = setup(t);
  // Outside a Claude Code session its owner is whatever started it: here a shell, killed outright.
  const sh = spawn('sh', ['-c', `"${process.execPath}" "${BIN}" listen & wait`], { env: env(w.home, w.opts({ agent: 'web-app', env: { CLAUDE_CODE_SESSION_ID: 'sess-a', DIBS_LISTEN_POLL: '100' } })), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  sh.stdout.on('data', d => (out += d));
  sh.stderr.on('data', d => (out += d));
  await until(() => listening(w));
  const file = path.join(w.home, 'listeners.json');
  const pid = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))[0].pid;
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  sh.kill('SIGKILL');
  await until(() => !alive(pid), 15e3);
  assert.equal(out, '', 'nothing printed: there is nobody to wake');
  assert.ok(!fs.existsSync(file) || !Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).some(x => x.pid === pid), 'its entry is gone');
  assert.ok(!listening(w));
});

test('a second listener replaces the first, which exits 0 saying so; the message goes to the second only', async t => {
  const w = setup(t);
  const first = w.listen();
  await until(() => listening(w));
  const second = w.listen();
  assert.equal(await first.done, 0, first.err);
  assert.match(first.out, /Another dibs listen for this agent took over/);
  w.tell('for the newer one');
  assert.equal(await second.done, 0, second.err);
  assert.match(second.out, /Message from the person: for the newer one/);
  assert.doesNotMatch(first.out, /for the newer one/);
});

test('the hook and a listener racing for the same messages hand each one over exactly once', async t => {
  const w = setup(t);
  for (let round = 0; round < 5; round++) {
    const p = w.listen(['--for', '20s']);
    await until(() => listening(w));
    w.tell(`race ${round}`);
    // The agent makes a tool call at the same moment the listener wakes.
    const hooked = w.hook(bash('ls'))?.hookSpecificOutput?.additionalContext || '';
    const code = await p.done;
    const got = [hooked, code === 0 ? p.out : ''].filter(s => s.includes(`race ${round}`));
    assert.equal(got.length, 1, `round ${round}: handed over ${got.length} times (listener exit ${code})`);
    if (code !== 0) assert.equal(code, 3, p.err);
  }
  const th = w.threads().find(x => x.to === 'web-app');
  const delivered = th.messages.filter(m => m.kind === 'delivered');
  assert.equal(delivered.length, 5, 'one delivered line per message');
});

test('a notice about the agent\'s jobs wakes a listener too', async t => {
  const w = setup(t);
  const p = w.listen();
  await until(() => listening(w));
  // dibs leaves the notice from its own process (src/notices.mjs), under the test's DIBS_HOME.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { notify } = await import(${JSON.stringify(path.resolve('src/talk.mjs'))}); notify({ sessionId: 'sess-a', who: 'web-app' }, 'idle:#1', 'your build has sat idle for 10 minutes');`],
  { env: env(w.home, w.opts()), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /notice about your jobs[\s\S]*your build has sat idle for 10 minutes/);
});

// The owner's ask: many messages, none lost, none twice, across the listener and the hook.
test('three messages in a burst arrive once each, between the listener, the next tool call and the next listener', async t => {
  const w = setup(t);
  const p = w.listen();
  await until(() => listening(w));
  for (const n of [1, 2, 3]) w.tell(`burst ${n}`);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /^First start dibs listen again with run_in_background, so the next message wakes you too\.\n\n/, 'the first thing it says is to listen again');
  // The agent works: its next tool call brings whatever came after the listener's batch.
  const hooked = w.hook(bash('ls'))?.hookSpecificOutput?.additionalContext || '';
  const next = w.listen(['--for', '1s']);
  const code = await next.done;
  const seen = [p.out, hooked, code === 0 ? next.out : ''].join('\n');
  for (const n of [1, 2, 3]) assert.equal(seen.split(`burst ${n}`).length - 1, 1, `burst ${n} once:\n${seen}`);
  const th = w.threads().find(x => x.to === 'web-app');
  assert.equal(th.messages.filter(m => m.kind === 'message' && m.state === 'delivered').length, 3);
  assert.equal(th.messages.filter(m => m.kind === 'delivered').length, 3);
});

// The owner (2026-11-11): re-arming should be automatic. The hook keeps a main agent going at its
// stop until a dibs listen runs, from Claude Code's list of the session's background tasks.
const stop = (o = {}) => ({ session_id: 'sess-a', transcript_path: '/t.jsonl', cwd: '/work/app', hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], ...o });
const rearmed = out => out?.hookSpecificOutput?.hookEventName === 'Stop' && /no dibs listen is running for you[\s\S]*run_in_background: dibs listen$/.test(out.hookSpecificOutput.additionalContext);
const shell = command => ({ id: 'b1', type: 'shell', status: 'running', description: command, command });

test('a main agent ending its turn with no listener is kept going once to start one, without a blocking error', t => {
  const w = setup(t);
  const out = w.hook(stop());
  assert.ok(rearmed(out), JSON.stringify(out));
  assert.equal(out.decision, undefined, 'feedback, not a "Stop hook blocking error"');
  assert.equal(w.hook(stop({ stop_hook_active: true })), null, 'not on the continuation it caused: no loop inside a turn');
});

test('a listener already running as a background task: nothing to say, however dibs was named', t => {
  const w = setup(t);
  for (const c of ['dibs listen', '~/bin/dibs listen --json', 'node /x/bin/dibs.mjs listen', 'cd /w && dibs listen'])
    assert.equal(w.hook(stop({ background_tasks: [shell('npm run dev'), shell(c)] })), null, c);
  assert.ok(rearmed(w.hook(stop({ background_tasks: [shell('npm run dev'), shell('echo dibs listened')] }))), 'other background work is not a listener');
});

test('a subagent, a teammate, Codex, the SDK and a session without background tasks are never kept going', t => {
  const w = setup(t);
  assert.equal(w.hook(stop({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: '/a.jsonl' })), null, 'a subagent that ends');
  assert.equal(w.hook(stop({ agent_id: 'teammate-1' })), null, 'anything with an agent id');
  assert.equal(w.hook(stop({ turn_id: 't1', background_tasks: undefined })), null, 'Codex: nothing in the background can wake it');
  const quiet = e => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(stop()), env: env(w.home, w.opts({ env: e })), encoding: 'utf8', timeout: 15000 }).stdout.trim();
  assert.equal(quiet({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), '', 'claude -p: its background tasks die with the run');
  assert.equal(quiet({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }), '', 'no background tasks to start it in');
  assert.ok(!fs.existsSync(path.join(w.home, 'rearm.json')), 'none of them counted toward the limit');
});

test('no loop across turns: at most 3 stops in a row with no listener, and a listener starting counts from zero', async t => {
  const w = setup(t);
  for (const n of [1, 2, 3]) assert.ok(rearmed(w.hook(stop())), `stop ${n}`);
  assert.equal(w.hook(stop()), null, 'a listen that never starts is not asked for a fourth time');
  const p = w.listen(['--for', '1s']);
  assert.equal(await p.done, 3);
  assert.ok(rearmed(w.hook(stop())), 'it listened since: kept going again');
});

test('Claude Code without the background task list: listeners.json says whether one is up', async t => {
  const w = setup(t);
  const old = stop({ background_tasks: undefined });
  const p = w.listen();
  await until(() => listening(w));
  assert.equal(w.hook(old), null, 'listening: nothing to say');
  w.tell('done yet?');
  assert.equal(await p.done, 0, p.err);
  assert.ok(rearmed(w.hook(old)), 'its listener handed a message over and ended');
});

test('a message handed over at a stop comes with the line to start listening, since that stop is the turn\'s one chance', t => {
  const w = setup(t);
  w.tell('the staging database is back');
  const out = w.hook(stop());
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /Message from the person: the staging database is back[\s\S]*\n\ndibs: no dibs listen is running for you/);
  assert.equal(w.hook(stop({ stop_hook_active: true })), null);
});

test('a new session is told to start dibs listen at once; a subagent is not', t => {
  const w = setup(t);
  const start = w.hook({ session_id: 'sess-a', cwd: '/work/app', hook_event_name: 'SessionStart', source: 'startup' });
  assert.match(start.hookSpecificOutput.additionalContext, /Start `dibs listen` with run_in_background now, and again each time it exits/);
  const sub = w.hook({ session_id: 'sess-a', cwd: '/work/app', hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'general-purpose' });
  assert.doesNotMatch(sub.hookSpecificOutput.additionalContext, /dibs listen/);
});

const { VERSION } = await import('../src/version.mjs');

test('dibs updated under a listener wakes it once with what changed, and the what\'s-new line stays quiet after', async t => {
  const w = setup(t);
  const file = path.join(w.home, 'version.mjs');
  fs.writeFileSync(file, `export const VERSION = '${VERSION}';\n`);
  const run = args => bg(t, w.home, ['listen', ...args], w.opts({ agent: 'web-app', env: { CLAUDE_CODE_SESSION_ID: 'sess-a', DIBS_VERSION_FILE: file } }));
  // This agent ran this version before: the what's-new line compares against it.
  sync(w.home, ['mine'], w.opts({ agent: 'web-app' }));
  const p = run([]);
  await until(() => listening(w));
  fs.writeFileSync(file, "export const VERSION = '99.0.0';\n");
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /^First start dibs listen again with run_in_background[^\n]*\n\ndibs was updated to 99\.0\.0\. What changed for you:/);
  const again = run(['--for', '1s']);
  assert.equal(await again.done, 3, 'told once: the next listener only listens');
  const seen = JSON.parse(fs.readFileSync(path.join(w.home, 'seen.json'), 'utf8'));
  assert.equal(seen['web-app'], '99.0.0', 'marked seen where the what\'s-new line looks');
});

// A stand-in for dibs.cc/mac/latest.json that counts how often it's asked.
async function feed(t, version) {
  const http = await import('node:http');
  const f = { hits: 0 };
  const srv = http.createServer((req, res) => { f.hits++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  f.url = `http://127.0.0.1:${srv.address().port}/latest.json`;
  return f;
}

test('a newer release on dibs.cc is told to each listener once, and the machine asks dibs.cc at most every six hours', async t => {
  const w = setup(t);
  const f = await feed(t, '99.9.9');
  const run = args => bg(t, w.home, ['listen', ...args], w.opts({ agent: 'web-app', env: { CLAUDE_CODE_SESSION_ID: 'sess-a', DIBS_UPDATE_URL: f.url } }));
  const p = run(['--for', '20s']);
  assert.equal(await p.done, 0, p.err);
  assert.equal(p.out.split('\n')[2], `dibs 99.9.9 is out (you have ${VERSION}). The person upgrades with: curl -fsSL https://dibs.cc/install.sh | sh`);
  assert.match(p.out, /Don't upgrade it yourself/);
  const again = run(['--for', '1s']);
  assert.equal(await again.done, 3, 'once per listener and version');
  assert.equal(f.hits, 1, 'one ask for the machine, not one per listener');
});

test('config updateCheck: false asks dibs.cc nothing', async t => {
  const w = setup(t);
  fs.writeFileSync(path.join(w.home, 'config.json'), JSON.stringify({ updateCheck: false }));
  const f = await feed(t, '99.9.9');
  const p = bg(t, w.home, ['listen', '--for', '1s'], w.opts({ agent: 'web-app', env: { CLAUDE_CODE_SESSION_ID: 'sess-a', DIBS_UPDATE_URL: f.url } }));
  assert.equal(await p.done, 3);
  assert.equal(f.hits, 0);
});
