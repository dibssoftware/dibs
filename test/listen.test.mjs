// dibs listen: an agent whose turn is over waits for a message instead of
// missing it until its next tool call. Run as Claude Code runs it (with
// CLAUDE_CODE_SESSION_ID set), against throwaway DIBS_HOMEs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, env, sync, bg, until, board, HOOK } from './helpers.mjs';

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
  assert.match(p.out, /^dibs: a message for you, sent with `dibs tell`\..*\nMessage from the person: the staging database is back\nTo answer them, run: dibs say/);
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
  assert.match(p.out, /To keep listening, start dibs listen again with run_in_background\.$/m);
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

test('a session whose listener ended is kept going once at its stop to start it again; one listening, or never listening, is not', async t => {
  const w = setup(t);
  const stop = { session_id: 'sess-a', cwd: '/work/app', hook_event_name: 'Stop', stop_hook_active: false };
  assert.equal(w.hook(stop), null, 'never listened: no reminder at a stop');
  const p = w.listen(['--for', '1s']);
  assert.equal(await p.done, 3);
  const out = w.hook(stop);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /re-arm: your dibs listen has ended\. Start it again with run_in_background/);
  assert.equal(w.hook({ ...stop, stop_hook_active: true }), null, 'not on the continuation it caused');
  assert.equal(w.hook(stop), null, 'once per listener, never a nag');
  const again = w.listen();
  await until(() => listening(w));
  assert.equal(w.hook(stop), null, 'listening again: nothing to say');
  again.kill('SIGTERM');
  await again.done;
  assert.ok(!listening(w), 'a killed listener leaves the board');
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
  assert.match(p.out, /^dibs was updated to 99\.0\.0\. What changed for you:/);
  assert.match(p.out, /To keep listening, start dibs listen again with run_in_background\.$/m);
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
  assert.equal(p.out.split('\n')[0], `dibs 99.9.9 is out (you have ${VERSION}). The person upgrades with: curl -fsSL https://dibs.cc/install.sh | sh`);
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
