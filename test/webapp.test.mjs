// dibs web's page does what the Mac app does: every change runs the CLI as
// the person and lands in the history under their name. And dibs stats, on
// the command line, on the page and as an MCP tool. Each test runs the real
// CLI and a real server on a free loopback port against its own DIBS_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, port, answers, until, AGENT, posixOnly } from './helpers.mjs';
import { inProcess, die } from '../src/util.mjs';

const code = home => sync(home, ['pair']).out.split('\n')[0].trim();

// The server runs as an agent would (CLAUDECODE set): the page must still act as the person.
async function server(t, env = {}) {
  const home = tmp(t, 'webapp');
  const p = await port();
  bg(t, home, ['web', '--port', String(p)], { env: { ...AGENT.env, ...env } });
  await until(() => answers(p));
  const base = `http://127.0.0.1:${p}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code(home) }) });
  assert.equal(r.status, 200);
  const auth = { Authorization: `Bearer ${(await r.json()).token}` };
  const get = async (where, h = auth) => { const x = await fetch(base + where, { headers: h }); return { status: x.status, json: await x.json() }; };
  const post = async (where, body = {}, h = auth) => {
    const x = await fetch(base + where, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
    return { status: x.status, json: await x.json() };
  };
  return { home, p, base, get, post };
}

const events = home => { try { return fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
const overrides = (home, act) => events(home).filter(e => e.kind === 'override' && e.act === act);
const boardJson = home => JSON.parse(sync(home, ['--json']).out);

test('every page action needs the page\'s session: no token, a wrong one and an MCP token are all refused', async t => {
  const w = await server(t);
  const actions = ['/api/jobs/1/boost', '/api/jobs/1/pause', '/api/jobs/1/resume', '/api/jobs/1/stop', '/api/cap', '/api/questions/1/answer', '/api/questions/1/dismiss',
    '/api/tell', '/api/read', '/api/later/l1/cancel', '/api/pace', '/api/hours', '/api/hook', '/api/pair', '/api/pair/revoke', '/api/pair/remote'];
  for (const a of actions) {
    assert.equal((await w.post(a, { prio: 'urgent' }, {})).status, 401, a);
    assert.equal((await w.post(a, { prio: 'urgent' }, { Authorization: 'Bearer nope' })).status, 401, a);
  }
  for (const r of ['/api/stats', '/api/questions', '/api/threads', '/api/later', '/api/history', '/api/settings', '/api/paired', '/api/machines']) assert.equal((await w.get(r, {})).status, 401, r);
  // A token from the MCP sign-in reads tools; it never opens the page's actions.
  const redirect = 'http://localhost:5555/cb';
  const reg = await (await fetch(`${w.base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json();
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = await (await fetch(`${w.base}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', code: code(w.home) }) })).json();
  const g = new URL(a.redirect).searchParams.get('code');
  const tok = await (await fetch(`${w.base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: g, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) })).json();
  assert.equal((await w.post('/api/pace', { pace: 'quiet' }, { Authorization: `Bearer ${tok.access_token}` })).status, 401);
  assert.equal(JSON.parse(sync(w.home, ['pace', '--json']).out).pace, null, 'nothing changed');
});

test('boost, pause, resume and stop from the page change the job as the CLI would, and the history says the person did it', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, async t => {
  const w = await server(t);
  bg(t, w.home, ['run', 'test', '-p', 'low', '-m', 'parity fixtures', '--', 'sleep', '60'], { agent: 'a1' });
  let job;
  await until(async () => (job = (await w.get('/api/board')).json.jobs.find(j => j.purpose === 'parity fixtures' && j.state === 'running')));

  const b = await w.post(`/api/jobs/${job.id}/boost`, { prio: 'urgent', reason: 'the person is waiting on it' });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(boardJson(w.home).held.find(l => l.id === job.id).prio, 'urgent');

  assert.equal((await w.post(`/api/jobs/${job.id}/pause`)).status, 200);
  await until(() => boardJson(w.home).held.find(l => l.id === job.id)?.plain?.paused);
  assert.equal((await w.post(`/api/jobs/${job.id}/resume`)).status, 200);
  await until(() => !boardJson(w.home).held.find(l => l.id === job.id)?.plain?.paused);

  // "Take it out of the line" on a job that started meanwhile leaves it running.
  const stale = await w.post(`/api/jobs/${job.id}/stop`, { expect: 'waiting' });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /started while you decided/);
  assert.ok(boardJson(w.home).held.some(l => l.id === job.id));
  assert.equal((await w.post(`/api/jobs/${job.id}/stop`, { expect: 'running' })).status, 200);
  await until(() => !boardJson(w.home).held.some(l => l.id === job.id));

  for (const act of ['boost', 'pause', 'resume', 'stop']) {
    const e = overrides(w.home, act).find(x => x.id === job.id);
    assert.ok(e, `${act} logged`);
    assert.equal(e.by, 'the person', act);
    assert.equal(e.byAgent, false, act);
  }
  assert.equal(overrides(w.home, 'boost')[0].reason, 'the person is waiting on it');
  assert.equal((await w.post('/api/jobs/999999/stop')).status, 404, 'nothing matched: the CLI\'s exit 1');
});

test('questions and messages from the page: answer, dismiss, tell and read, each the person\'s', async t => {
  const w = await server(t);
  sync(w.home, ['say', 'migrations are done'], { agent: 'a1' });
  const ask = q => sync(w.home, ['question', q, '--options', 'yes,no', '--recommend', 'yes', '--one-way', 'a store build can not be pulled back once players have it', '-m', 'yes: I submit it tonight. no: it waits'], { agent: 'a1' });
  assert.equal(ask('Ship build 140 to the App Store now?').code, 0);
  assert.equal(ask('Delete the old staging bucket now?').code, 0);
  const qs = (await w.get('/api/questions')).json;
  assert.equal(qs.open, 2);
  assert.ok(qs.questions.every(q => !('session' in q)), 'session ids stay on this machine');
  const [first, second] = qs.questions;

  assert.equal((await w.post(`/api/questions/${first.id}/answer`, { text: 'yes' })).status, 200);
  assert.equal((await w.post(`/api/questions/${second.id}/dismiss`)).status, 200);
  const after = JSON.parse(sync(w.home, ['questions', '--json']).out).questions;
  assert.equal(after.find(q => q.id === first.id).answer, 'yes');
  assert.equal(after.find(q => q.id === second.id).state, 'dismissed');
  assert.equal((await w.post(`/api/questions/${first.id}/answer`, { text: 'no' })).status, 404, 'already answered');
  assert.equal(overrides(w.home, 'answer')[0].by, 'the person');

  // A message that starts with a dash is still a message, not a flag.
  const told = await w.post('/api/tell', { to: 'a1', text: '-use the staging database' });
  assert.equal(told.status, 200, JSON.stringify(told.json));
  const th = (await w.get('/api/threads')).json.threads.find(x => x.to === 'a1');
  const mine = th.messages.find(m => m.from === 'person' && m.kind === 'message');
  assert.equal(mine.text, '-use the staging database');
  assert.equal(mine.by, undefined, 'from the person, not an agent');
  assert.equal(overrides(w.home, 'tell')[0].by, 'the person');
  assert.ok(th.unread > 0);
  assert.equal((await w.post('/api/read', { to: 'a1' })).status, 200);
  assert.equal((await w.get('/api/threads')).json.threads.find(x => x.to === 'a1').unread, 0);
  assert.equal((await w.post('/api/tell', { to: 'nobody-here', text: 'hi' })).status, 404);
});

test('cap, pace, hours, the hook and a scheduled run from the page', async t => {
  const settings = path.join(tmp(t, 'claude'), 'settings.json');
  const w = await server(t, { DIBS_CLAUDE_SETTINGS: settings });
  sync(w.home, ['progress', 'started on the parser', '--task', 'parser'], { agent: 'a1' });

  assert.equal((await w.post('/api/cap', { agent: 'a1', prio: 'low' })).status, 200);
  assert.equal(overrides(w.home, 'cap')[0].by, 'the person');
  assert.equal((await w.post('/api/cap', { agent: 'never-seen', prio: 'low' })).status, 404, 'only agents dibs has seen');

  assert.equal((await w.post('/api/pace', { pace: 'quiet' })).status, 200);
  assert.equal(JSON.parse(sync(w.home, ['pace', '--json']).out).pace, 'quiet');
  assert.equal((await w.post('/api/hours', { hours: '09:00-21:00' })).status, 200);
  assert.deepEqual(JSON.parse(sync(w.home, ['hours', '--json']).out), { start: '09:00', end: '21:00' });
  const s = (await w.get('/api/settings')).json;
  assert.equal(s.pace.pace, 'quiet');
  assert.equal(s.hook.installed, false);
  assert.equal((await w.post('/api/hook')).status, 200);
  assert.equal(JSON.parse(sync(w.home, ['guard', 'status', '--json'], { env: { DIBS_CLAUDE_SETTINGS: settings } }).out).installed, true);

  const made = sync(w.home, ['later', 'test', '--in', '3h', '-m', 'nightly suite', '--env', 'API_TOKEN=hunter2', '--', 'sleep', '1'], { agent: 'a1' });
  assert.equal(made.code, 0, made.err);
  const id = made.out.match(/^(l\d+)/)[1];
  const jobs = (await w.get('/api/later')).json;
  assert.equal(jobs[0].purpose, 'nightly suite');
  assert.ok(!JSON.stringify(jobs).includes('hunter2'), 'a scheduled run\'s environment stays on this machine');
  assert.equal((await w.post(`/api/later/${id}/cancel`)).status, 200);
  assert.equal(JSON.parse(sync(w.home, ['later', 'list', '--json']).out).jobs.find(j => j.id === id).state, 'cancelled');
});

test('the page pairs another browser as the Mac app does: a new code signs in once, the list shows it, and Sign out ends it', async t => {
  const w = await server(t);
  const made = await w.post('/api/pair');
  assert.equal(made.status, 200);
  assert.match(made.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const login = await fetch(`${w.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: made.json.code }) });
  assert.equal(login.status, 200, 'the code from the page signs a browser in');
  const other = { Authorization: `Bearer ${(await login.json()).token}` };
  const again = await fetch(`${w.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: made.json.code }) });
  assert.notEqual(again.status, 200, 'each code works once');
  const list = (await w.get('/api/paired')).json;
  assert.equal(list.length, 2, 'this browser and the new one');
  assert.ok(list.every(c => /^[0-9a-f]{8}$/.test(c.id) && c.what === 'web page'));
  assert.equal((await w.get('/api/board', other)).status, 200);
  // Sign out each one the list shows, from whichever browser is still signed in.
  let from;
  for (const c of list) {
    let r = await w.post('/api/pair/revoke', { id: c.id }, from);
    if (r.status === 401) r = await w.post('/api/pair/revoke', { id: c.id }, (from = other));
    assert.equal(r.status, 200);
  }
  assert.equal((await w.get('/api/board', other)).status, 401, 'signed out');
  assert.equal((await w.get('/api/board')).status, 401, 'this one too');
});

test('the page refuses what the CLI would misread: bad ids, priorities, names, spans and oversized text', async t => {
  const w = await server(t);
  const cases = [
    ['/api/jobs/abc/boost', { prio: 'urgent' }], ['/api/jobs/1/boost', { prio: 'max' }], ['/api/jobs/1/boost', { prio: 'urgent', reason: 'x'.repeat(301) }],
    ['/api/cap', { agent: '--all', prio: 'low' }], ['/api/tell', { to: 'a1', text: 'x'.repeat(4001) }], ['/api/tell', { to: 'a1', text: '   ' }],
    ['/api/questions/1;rm/answer', { text: 'yes' }], ['/api/later/12/cancel', {}], ['/api/pace', { pace: 'ludicrous' }], ['/api/hours', { hours: 'always' }],
    ['/api/pair/revoke', { id: '--remote' }], ['/api/pair/revoke', {}],
  ];
  for (const [where, body] of cases) assert.equal((await w.post(where, body)).status, 400, `${where} ${JSON.stringify(body).slice(0, 60)}`);
  assert.equal((await w.get('/api/stats?since=2y')).status, 400);
  assert.equal((await w.get('/api/stats?agent=-x')).status, 400);
});

// A made-up week: a1 ran three tests (one failed, one waited longer than it ran)
// and finished a task 10 minutes past its ETA; a2 ran one deploy.
function week(home, t = Date.now()) {
  const m = 6e4;
  const ev = [
    { at: t - 60 * m, kind: 'start', id: 1, res: ['test'], who: 'a1', type: 'run', ms: 4 * m, held: { memory: 4 * m } },
    { at: t - 58 * m, kind: 'end', id: 1, res: ['test'], who: 'a1', type: 'run', code: 1, ms: 2 * m },
    { at: t - 50 * m, kind: 'start', id: 2, res: ['test'], who: 'a1', type: 'run', ms: 0 },
    { at: t - 40 * m, kind: 'end', id: 2, res: ['test'], who: 'a1', type: 'run', code: 0, ms: 10 * m },
    { at: t - 30 * m, kind: 'start', id: 3, res: ['test', 'files:/x/a.js'], who: 'a1', type: 'run', ms: 2000 },
    { at: t - 25 * m, kind: 'end', id: 3, res: ['test', 'files:/x/a.js'], who: 'a1', type: 'run', code: 143, ms: 5 * m },
    { at: t - 20 * m, kind: 'start', id: 4, res: ['deploy'], who: 'a2', type: 'run', ms: 0 },
    { at: t - 10 * m, kind: 'end', id: 4, res: ['deploy'], who: 'a2', type: 'run', code: 0, ms: 10 * m },
    { at: t - 5 * m, kind: 'sample', load: 3.5, memFree: 40, diskFree: 50e9 },
  ];
  fs.writeFileSync(path.join(home, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'history.jsonl'), [{ key: 'test|npm test / unit', dur: 10 * m, who: 'a1', at: t - 40 * m, mem: 2e9 }, { key: 'test|npm test', dur: 2 * m, who: 'a1', at: t - 58 * m }]
    .map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'progress.jsonl'), [
    { at: t - 70 * m, who: 'a1', task: 'parser', state: 'doing', eta: t - 30 * m, text: 'on it' },
    { at: t - 20 * m, who: 'a1', task: 'parser', state: 'done', text: 'parser done' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
}

test('dibs stats --agent and --json: an agent\'s jobs, waits, failures, commands and ETAs; plain dibs stats is unchanged', t => {
  const home = tmp(t, 'stats');
  week(home);
  const s = JSON.parse(sync(home, ['stats', '--agent', 'a1', '--json']).out);
  assert.equal(s.agent, 'a1');
  assert.equal(s.totals.jobs, 3);
  assert.equal(s.totals.runs, 3);
  assert.equal(s.totals.failed, 1, 'exit 1 failed; exit 143 was a stop');
  assert.equal(s.totals.stopped, 1);
  assert.equal(s.totals.waitedLonger, 1);
  assert.equal(s.totals.waited, 2, 'a start under a second after asking is no wait');
  assert.deepEqual(s.totals.heldBy.map(h => [h.rule, h.ms]), [['memory', 4 * 6e4]]);
  assert.deepEqual(s.totals.eta, { finished: 1, onTime: 0, medianLate: 10 * 6e4 });
  const a = s.agents[0];
  assert.equal(a.who, 'a1');
  assert.deepEqual(a.codes, { 0: 1, 1: 1, 143: 1 });
  assert.equal(a.commands[0].name, 'npm test');
  assert.equal(a.commands[0].n, 2);
  assert.equal(a.peakMem, 2e9);
  assert.deepEqual(s.resources.map(r => r.res).sort(), ['files', 'test'], 'file leases are one line');
  assert.ok(s.today && s.week, 'the old --json fields are still there');

  assert.equal(JSON.parse(sync(home, ['stats', '--me', '--json'], { agent: 'a2' }).out).totals.jobs, 1);
  const everyone = sync(home, ['stats', '--since', '1d']).out;
  assert.match(everyone, /4 jobs: ran 27m00s/);
  assert.match(everyone, /a1 +3/);
  assert.match(sync(home, ['stats', '--agent', 'a1']).out, /Top commands[\s\S]*2x .*npm test/);
  const plain = sync(home, ['stats']).out;
  assert.match(plain, /^Today/);
  assert.match(plain, /waited longer than they ran/);
  assert.notEqual(sync(home, ['stats', '--me', '--agent', 'a1']).code, 0);
});

test('the page\'s stats and history, and the MCP stats tool, read the same numbers; MCP has no tool that changes anything', async t => {
  const w = await server(t);
  week(w.home);
  const s = (await w.get('/api/stats?since=1d&agent=a1')).json;
  assert.equal(s.totals.jobs, 3);
  assert.equal(s.grid.length >= 1, true);
  const h = (await w.get('/api/history?since=1d')).json;
  assert.ok(h.lines.length);
  assert.ok(h.resources.test);

  const redirect = 'http://localhost:5555/cb';
  const reg = await (await fetch(`${w.base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirect] }) })).json();
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = await (await fetch(`${w.base}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', code: code(w.home) }) })).json();
  const g = new URL(a.redirect).searchParams.get('code');
  const tok = await (await fetch(`${w.base}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: g, client_id: reg.client_id, redirect_uri: redirect, code_verifier: verifier }) })).json();
  const rpc = async body => (await fetch(`${w.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify(body) })).json();
  const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map(x => x.name).sort();
  assert.deepEqual(tools, ['agent', 'agents', 'board', 'history', 'machines', 'messages', 'progress', 'questions', 'resource', 'stats']);
  const r = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stats', arguments: { agent: 'a1', since: '1d' } } })).result;
  assert.match(r.content[0].text, /^a1, /);
  assert.match(r.content[0].text, /1 failed/);
  assert.equal(r.structuredContent.result.totals.jobs, 3);
  const badSpan = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stats', arguments: { since: 'forever' } } });
  assert.equal(badSpan.error.code, -32602);
});

test('the page reads what the CLI reads, in its own process: the board, questions, threads, later runs and settings match the CLI\'s JSON', async t => {
  const w = await server(t);
  bg(t, w.home, ['run', 'test', '-m', 'same everywhere', '--', 'sleep', '60'], { agent: 'a1' });
  await until(async () => (await w.get('/api/board')).json.jobs.some(j => j.purpose === 'same everywhere'));
  sync(w.home, ['say', 'a note for the person'], { agent: 'a1' });
  // The page caches a read for a moment; past it, the next read is fresh.
  await until(async () => (await w.get('/api/board')).json.notes === 1);
  const cli = args => JSON.parse(sync(w.home, args).out);
  assert.deepEqual((await w.get('/api/questions')).json.questions, cli(['questions', '--json']).questions);
  await until(async () => (await w.get('/api/threads')).json.threads.length === cli(['threads', '--json']).threads.length);
  assert.deepEqual((await w.get('/api/later')).json, cli(['later', 'list', '--json']).jobs);
  const s = (await w.get('/api/settings')).json;
  assert.deepEqual(s.pace, cli(['pace', '--json']));
  assert.equal(s.hook.installed, cli(['guard', 'status', '--json']).installed);
});

test('the board can leave the posts apart for the Progress view: ?posts=0 carries none, /api/posts has them, and the agents are the same', async t => {
  const w = await server(t);
  sync(w.home, ['progress', 'apart from the board', '--task', 'split'], { agent: 'a1' });
  await until(async () => (await w.get('/api/board')).json.posts.length === 1);
  const whole = (await w.get('/api/board')).json, apart = (await w.get('/api/board?posts=0')).json;
  assert.deepEqual([apart.posts, apart.postsApart, whole.postsApart], [[], true, undefined]);
  assert.deepEqual(apart.agents, whole.agents, 'each agent still has its tasks and last post');
  assert.deepEqual((await w.get('/api/posts')).json, whole.posts);
  assert.equal((await w.get('/api/posts', {})).status, 401, 'signed in only');
  const { remoteAccess } = await import('../src/web.mjs');
  assert.equal(remoteAccess('GET', '/api/posts', false), null, 'a look-only paired browser may read them');
});

// 2026-11-02: once, /api/threads answered 502, which reads as a proxy failing and names nothing to do.
test('a read the page can\'t do answers 500 with what went wrong, a busy lock 503 with a time to retry, and the next read after the fix works', async t => {
  const w = await server(t);
  const cfg = path.join(w.home, 'config.json');
  const good = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(cfg, '{ not json');
  const r = await w.get('/api/threads');
  assert.equal(r.status, 500);
  assert.match(r.json.error, /config\.json isn't valid JSON/);
  fs.writeFileSync(cfg, good);
  assert.equal((await w.get('/api/threads')).status, 200);
  // Exit 75 (a lock busy: nothing wrong, try again) is the one a reader should retry.
  const busy = (() => { try { inProcess(() => die('state lock stuck', 75)); } catch (e) { return e; } })();
  assert.deepEqual([busy.status, busy.retryAfter, busy.exitCode], [503, 2, 75]);
});

test('Machines on the page: this Mac\'s limits, its simulator pool and services, and no group when it works alone', async t => {
  const agents = tmp(t, 'launch-agents');
  const w = await server(t, { DIBS_LAUNCH_AGENTS: agents });
  const m = (await w.get('/api/machines')).json;
  assert.equal(m.group, null);
  assert.match(m.limits, /memory/);
  assert.deepEqual(m.services.map(x => x.name), ['serve', 'worker', 'throttle', 'web', 'relay', 'guard']);
  assert.ok(m.services.every(x => x.state === 'not installed'), JSON.stringify(m.services));
  assert.ok(m.pool.room['sim-own'], 'the private simulator pool');
});

test('the page pairs a phone through the relay: a link, its QR code and a code to type, and the device lands on the list', async t => {
  const w = await server(t);
  const r = await w.post('/api/pair/remote', { act: false });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.link, /^https:\/\//);
  assert.match(r.json.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(r.json.qr.length >= 21 && r.json.qr.every(row => row.length === r.json.qr.length), 'a square QR grid');
  assert.equal(overrides(w.home, 'pair remote').length, 1);
});
