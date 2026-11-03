// dibs's MCP tools beyond reading the board: the new read tools for any client, and the
// tools that act, for a client signed in with a code from dibs pair --allow-actions. Each test
// runs a real dibs web on a free loopback port against its own DIBS_HOME, signs a client in
// the way Claude Code does (register, code, PKCE, token) and calls tools over /mcp.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, port, answers, until, posixOnly } from './helpers.mjs';

async function server(t) {
  const home = tmp(t, 'mcptools');
  const p = await port();
  bg(t, home, ['web', '--port', String(p)]);
  await until(() => answers(p));
  const base = `http://127.0.0.1:${p}`;
  const json = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { home, base, json };
}

// A signed-in client. act: the code came from dibs pair --allow-actions.
async function connect(w, { act = false, cmd = false, name = 'test client' } = {}) {
  const redirect = 'http://localhost:5555/callback';
  const reg = await (await w.json('/oauth/register', { client_name: name, redirect_uris: [redirect] })).json();
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = sync(w.home, ['pair', ...(cmd ? ['--allow-commands'] : act ? ['--allow-actions'] : [])]).out.split('\n')[0].trim();
  const a = await w.json('/oauth/authorize', { client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', code });
  assert.equal(a.status, 200, await a.clone().text());
  const g = new URL((await a.json()).redirect).searchParams.get('code');
  const tok = await fetch(`${w.base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: g, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  const t = await tok.json();
  let id = 0;
  const rpc = async (method, params = {}) => (await (await fetch(`${w.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json());
  const call = async (tool, args = {}) => (await rpc('tools/call', { name: tool, arguments: args })).result;
  return { ...t, client: reg.client_id, rpc, call };
}

const READS = ['agent', 'agents', 'board', 'history', 'machines', 'messages', 'progress', 'questions', 'resource', 'stats'];
const WRITES = ['answer_question', 'boost_job', 'hold', 'pause_job', 'post_progress', 'release', 'resume_job', 'say_to_person', 'stop_job', 'tell_agent'];
const names = async c => (await c.rpc('tools/list')).result.tools.map(x => x.name).sort();

test('a client signed in with a plain dibs pair code reads, and every tool that acts is refused', async t => {
  const w = await server(t);
  const c = await connect(w);
  assert.deepEqual(await names(c), READS);
  const r = await c.call('stop_job', { id: '1' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /can only read.*dibs pair --allow-actions/);
  assert.match((await c.rpc('initialize', { protocolVersion: '2025-06-18' })).result.instructions, /paired read-only/);
  assert.match(sync(w.home, ['pair', '--list']).out, /MCP: test client, look only/);
});

test('a code from dibs pair --allow-actions gives the tools that act, the grant survives a refresh, and --list says so', async t => {
  const w = await server(t);
  const c = await connect(w, { act: true });
  assert.deepEqual(await names(c), [...READS, ...WRITES].sort());
  assert.match((await c.rpc('initialize', { protocolVersion: '2025-06-18' })).result.instructions, /acts as the agent mcp-test-client-[0-9a-f]{4}, never as the person/);
  assert.match(sync(w.home, ['pair', '--list']).out, /MCP: test client, can act/);
  const r = await fetch(`${w.base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token }) });
  const fresh = await r.json();
  const list = await (await fetch(`${w.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fresh.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
  assert.ok(list.result.tools.some(x => x.name === 'stop_job'), 'still can act after a refresh');
});

test('the client acts as an agent named after it: progress, a note to the person and a message to an agent are its own, never the person\'s', async t => {
  const w = await server(t);
  const c = await connect(w, { act: true, name: 'Claude (other account)' });
  const me = (await c.call('post_progress', { text: 'looked over the deploy queue', task: 'review', eta: '30m' })).structuredContent.result.as;
  assert.match(me, /^mcp-claude-other-account-[0-9a-f]{4}$/);
  const posts = JSON.parse(sync(w.home, ['progress', '--json']).out);
  assert.deepEqual(posts.map(p => [p.who, p.task, p.text]), [[me, 'review', 'looked over the deploy queue']]);
  const said = await c.call('say_to_person', { text: 'the deploy queue looks stuck' });
  assert.equal(said.isError, undefined, said.content[0].text);
  sync(w.home, ['say', 'starting on the rebase'], { agent: 'worker', env: { AI_AGENT: '1' } });
  const told = await c.call('tell_agent', { agent: 'worker', text: 'please rebase onto main' });
  assert.equal(told.isError, undefined, told.content[0].text);
  const threads = JSON.parse(sync(w.home, ['threads', '--json']).out).threads;
  const mine = threads.find(x => x.agent === me);
  assert.ok(mine.messages.some(m => m.from === 'agent' && m.text === 'the deploy queue looks stuck'), 'the note sits in its own thread, from an agent');
  // The message reaches the agent as another agent's, not the person's.
  const toWorker = threads.find(x => x.agent === 'worker').messages.find(m => m.text === 'please rebase onto main');
  assert.ok(toWorker, JSON.stringify(threads));
  assert.notEqual(toWorker.by, 'the person');
  assert.equal(toWorker.by, me);
});

test('answer_question answers an agent\'s question as the client, and questions lists what\'s open', async t => {
  const w = await server(t);
  const c = await connect(w, { act: true });
  sync(w.home, ['question', 'Ship build 123 to TestFlight now?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'tests pass', '--one-way', 'a build can\'t be pulled'], { agent: 'asker', env: { AI_AGENT: '1' } });
  const open = await c.call('questions');
  assert.match(open.content[0].text, /#1 from asker \(normal\).*Ship build 123.*Options: yes, no\. Recommended: yes/);
  assert.equal((await c.call('answer_question', { id: '1', text: 'no' })).isError, undefined);
  const q = JSON.parse(sync(w.home, ['questions', '--json']).out).questions.find(x => x.id === 1);
  assert.equal(q.answer, 'no');
  assert.equal((await c.call('questions')).content[0].text, 'No open questions.');
});

test('hold and release take and give back a resource under the client\'s name; resource shows who has it', async t => {
  const w = await server(t);
  const c = await connect(w, { act: true });
  const h = await c.call('hold', { res: 'deploy', for: '10m', reason: 'freeze during the review' });
  assert.equal(h.isError, undefined, h.content[0].text);
  const me = h.structuredContent.result.as;
  const board = JSON.parse(sync(w.home, ['--json']).out);
  assert.ok(board.held.some(l => l.res.includes('deploy') && (l.agent || l.who) === me), JSON.stringify(board.held));
  assert.match((await c.call('resource', { res: 'deploy' })).content[0].text, new RegExp(me));
  assert.equal((await c.call('release', { res: 'deploy' })).isError, undefined);
  assert.ok(!JSON.parse(sync(w.home, ['--json']).out).held.some(l => l.res.includes('deploy')));
  assert.equal((await c.call('hold', { res: 'rm -rf /', reason: 'x' })).isError, true, 'only resource names');
});

test('acting on another session\'s job needs owner, and the job\'s agent is told the client stopped it', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const w = await server(t);
  const c = await connect(w, { act: true });
  const run = bg(t, w.home, ['run', 'test', '-m', 'the agent\'s own job', '--', 'sleep', '60'], { agent: 'worker', env: { AI_AGENT: '1' } });
  let id = null;
  await until(() => { try { id = JSON.parse(sync(w.home, ['--json']).out).held.find(l => l.purpose === 'the agent\'s own job')?.id; } catch {} return id; });
  const no = await c.call('pause_job', { id: String(id), reason: 'reviewing' });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /--owner/);
  for (const [tool, args] of [['boost_job', { prio: 'low' }], ['pause_job', {}], ['resume_job', {}]]) {
    const r = await c.call(tool, { id: String(id), owner: 'worker', reason: 'reviewing', ...args });
    assert.equal(r.isError, undefined, `${tool}: ${r.content[0].text}`);
  }
  const s = await c.call('stop_job', { id: String(id), owner: 'worker', reason: 'superseded' });
  assert.equal(s.isError, undefined, s.content[0].text);
  await run.done;
  assert.match(run.err, /stopped by mcp-test-client-[0-9a-f]{4} on purpose \(dibs stop\): "superseded"/);
  const hist = sync(w.home, ['history', '--json', '--since', '1d']);
  assert.equal(hist.code, 0);
});

test('the new read tools answer for any client: history, resource, machines, messages', async t => {
  const w = await server(t);
  const c = await connect(w);
  sync(w.home, ['say', 'all green on main'], { agent: 'a1', env: { AI_AGENT: '1' } });
  assert.ok((await c.call('history', { since: '1d' })).content[0].text.length > 0);
  assert.match((await c.call('resource', { res: 'test' })).content[0].text, /A new job would start now/);
  assert.match((await c.call('machines')).content[0].text, /isn't in a group|machine/);
  assert.match((await c.call('messages', { agent: 'a1' })).content[0].text, /== a1[\s\S]*all green on main/);
  assert.equal((await c.call('resource', { res: '; rm -rf /' })).isError, true);
});

test('queue_run: only for a code from dibs pair --allow-commands, it queues a command in its folder as the client; --list says so', async t => {
  const w = await server(t);
  const actor = await connect(w, { act: true, name: 'acts only' });
  assert.ok(!(await names(actor)).includes('queue_run'), 'an --allow-actions client is not offered it');
  const no = await actor.call('queue_run', { res: 'test', command: ['true'], cwd: w.home, in: '30m', reason: 'x' });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /can't run commands.*dibs pair --allow-commands/);
  const c = await connect(w, { cmd: true, name: 'runner' });
  assert.deepEqual(await names(c), [...READS, ...WRITES, 'queue_run'].sort());
  assert.match(sync(w.home, ['pair', '--list']).out, /MCP: runner, can run commands/);
  const folder = tmp(t, 'queued');
  for (const bad of [{ cwd: 'relative/dir' }, { command: 'rm -rf /' }, { command: [] }, { in: 'soon' }, { at: undefined, in: undefined }]) {
    const r = await c.call('queue_run', { res: 'test', command: ['echo', 'hi'], cwd: folder, in: '30m', reason: 'nightly check', ...bad });
    assert.equal(r.isError, true, JSON.stringify(bad));
  }
  const q = await c.call('queue_run', { res: 'test', command: ['echo', 'hi'], cwd: folder, in: '30m', reason: 'nightly check' });
  assert.equal(q.isError, undefined, q.content[0].text);
  const jobs = JSON.parse(sync(w.home, ['later', 'list', '--json']).out).jobs;
  const job = jobs.find(j => j.purpose === 'nightly check');
  assert.ok(job, JSON.stringify(jobs));
  assert.match(job.who || job.agent, /^mcp-runner-[0-9a-f]{4}$/);
  assert.equal(job.cwd, fs.realpathSync(folder));
  // Nothing left waiting after the test.
  assert.equal(sync(w.home, ['later', 'cancel', job.id]).code, 0);
});
