// A token per machine, dibs kick, machine limits and project rules. Machines
// are simulated on this one (helpers.mjs group()), each with its own DIBS_HOME.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, group, shared, alive, gitProject, inviteAndJoin, machinesOf, PERSON } from './helpers.mjs';
import { place, makeServer, bare } from '../src/serve.mjs';
import { makeTrust, readRules, rulesAbove } from '../src/trust.mjs';

const PROJECT = { 'a.txt': 'hi\n', 'sub/s.txt': 's\n' };
const sleeper = marker => ['sh', '-c', `echo $$ > ${marker}; echo started; sleep 60`];

async function api(g, token, method, route, body) {
  const r = await fetch(`http://127.0.0.1:${g.port}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const req = (token, addr) => ({ headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: addr } });

test('the admin token works only over loopback', t => {
  const trust = makeTrust({ token: 'admin-secret', file: path.join(tmp(t), 'machines.json') });
  assert.deepEqual(trust.who(req('admin-secret', '127.0.0.1')), { admin: true });
  assert.deepEqual(trust.who(req('admin-secret', '::ffff:127.0.0.1')), { admin: true });
  assert.match(trust.who(req('admin-secret', '100.101.102.103')).error, /only works on the coordinator's machine.*dibs invite/);
});

test('a machine token names its machine, and only its hash is stored', t => {
  const file = path.join(tmp(t), 'machines.json');
  const trust = makeTrust({ token: 'admin-secret', file });
  const tok = trust.invite('mini');
  assert.equal(trust.who(req(tok, '100.101.102.103')).name, 'mini');
  assert.equal(trust.who(req('nope', '127.0.0.1')).error, 'bad token');
  assert.equal(trust.who({ headers: {}, socket: {} }).error, 'no token');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(tok), 'only the hash is stored');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a new invite replaces the old token, and a kicked token says why it stopped working', t => {
  const trust = makeTrust({ token: 'admin-secret', file: path.join(tmp(t), 'machines.json') });
  const first = trust.invite('mini');
  const second = trust.invite('mini');
  assert.equal(trust.who(req(first, '1.2.3.4')).error, 'bad token');
  trust.revoke('mini', 'mini was removed with dibs kick');
  assert.equal(trust.who(req(second, '1.2.3.4')).error, 'mini was removed with dibs kick');
});

test('limits survive a coordinator restart, and a broken registry is refused, not reset', t => {
  const file = path.join(tmp(t), 'machines.json');
  const trust = makeTrust({ token: 'admin-secret', file });
  trust.invite('mini');
  trust.limit('mini', ['test']);
  assert.deepEqual(makeTrust({ token: 'admin-secret', file }).only('mini'), ['test']);
  fs.writeFileSync(file, '{oops');
  assert.throws(() => makeTrust({ token: 'x', file }), /can't be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{oops');
});

test('--on a machine that was invited but never joined says so, not that there is no such machine', async t => {
  const s = makeServer({ token: 'admin-token', registry: path.join(tmp(t), 'machines.json') });
  const srv = s.server().listen(0, '127.0.0.1');
  t.after(() => { s.stop(); srv.close(); });
  await new Promise(r => srv.once('listening', r));
  s.trust.invite('mini');
  const place = on => fetch(`http://127.0.0.1:${srv.address().port}/place`, { method: 'POST', headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ res: ['test'], on, from: 'here' }) }).then(r => r.json());
  assert.match((await place('mini')).error, /mini was invited but hasn't joined yet: run the join line dibs invite printed on mini/);
  assert.match((await place('nope')).error, /no machine named nope/);
});

test('placement skips machines a limit or a project rule rules out', () => {
  const t = Date.now();
  const w = (name, extra) => [name, { name, os: 'macos', cores: 10, load: 0, memFree: 80, memTotal: 16e9, seen: t, busy: {}, ...extra }];
  const workers = new Map([w('idle', { only: ['deploy'] }), w('busy', { load: 9 }), w('home', { load: 9 })]);
  assert.equal(place(workers, { res: ['test'], from: 'x' }, t).machine, 'busy');
  assert.equal(place(workers, { res: ['deploy'], from: 'x' }, t).machine, 'idle');
  assert.match(place(workers, { res: ['test'], on: 'idle', from: 'x' }, t).error, /idle only takes deploy jobs/);
  assert.equal(place(workers, { res: ['test'], on: 'idle', from: 'idle' }, t).machine, 'idle', "the sender's own machine is never limited");
  const rule = { stayOn: ['home'], rule: 'r/.dibs.json keeps this project on home' };
  assert.equal(place(workers, { res: ['test'], from: 'x', ...rule }, t).machine, 'home');
  assert.match(place(workers, { res: ['test'], on: 'busy', from: 'x', ...rule }, t).error, /keeps this project on home, so not busy/);
  assert.equal(place(workers, { res: ['test'], from: 'x', stayOn: [] }, t).machine, 'x', 'nowhere allowed: it stays with the sender');
});

test('every .dibs.json above the folder applies: only machines all of them allow', t => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'app', 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, '.dibs.json'), JSON.stringify({ stayOn: ['mini', 'studio'] }));
  fs.writeFileSync(path.join(root, 'app', '.dibs.json'), JSON.stringify({ stayOn: ['mini', 'cloud-box'] }));
  const r = readRules(rulesAbove(path.join(root, 'app', 'web')));
  assert.deepEqual(r.stayOn, ['mini']);
  assert.match(r.text, /app\/\.dibs\.json and .*\.dibs\.json keep this project on mini/);
  assert.equal(readRules([]).stayOn, null, 'no rule: anywhere');
});

test('a broken .dibs.json keeps the code on the machine it lives on', t => {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, '.dibs.json'), '{"stayOn": "mini"}');
  const r = readRules(rulesAbove(root));
  assert.deepEqual(r.stayOn, []);
  assert.match(r.text, /can't be read, so dibs keeps this project on the machine it lives on/);
});

describe('a group where each machine joined with its own token', () => {
  const s = shared();
  let g;
  before(async () => { g = await group(s, { invite: true, files: PROJECT }); });

  test('a machine invited but not joined shows as such; a bad name is refused', () => {
    assert.match(sync(g.h0, ['invite', 'delta'], PERSON).out, /dibs service install worker/);
    assert.match(sync(g.h0, ['machines']).out, /delta\s+invited \d+s ago, hasn't joined yet/);
    const bad = sync(g.h0, ['invite', 'bad name!'], PERSON);
    assert.equal(bad.code, 2);
    assert.doesNotMatch(sync(g.h0, ['machines']).out, /bad name/);
  });

  test("a machine's token can't speak for another machine", async () => {
    const beat = await api(g, g.tok.alpha, 'POST', '/worker/beat', { name: 'beta', os: 'macos', cores: 1, load: 0, running: [] });
    assert.equal(beat.status, 403);
    assert.match(beat.json.error, /token is for alpha, so it can't take jobs as beta/);
    assert.equal((await api(g, g.tok.alpha, 'POST', '/jobs', { res: ['test'], cmd: ['true'], machine: 'beta', from: 'gamma' })).status, 403);
  });

  test("a job's output belongs to its sender and its bundle to the machine running it", async t => {
    const p = bg(t, g.hc, ['run', 'test', '--on', 'alpha', '-m', 'owned', '--', 'sh', '-c', 'echo started; sleep 30'], { cwd: g.proj });
    await until(() => p.out.includes('started'));
    const id = machinesOf(g.h0).jobs.find(j => j.purpose === 'owned').id;
    assert.equal((await api(g, g.tok.beta, 'GET', `/jobs/${id}/out`)).status, 403);
    assert.equal((await api(g, g.tok.beta, 'GET', `/jobs/${id}/bundle`)).status, 403);
    assert.equal((await api(g, g.tok.gamma, 'POST', `/jobs/${id}/done`, { code: 0 })).status, 403);
    assert.equal((await api(g, g.tok.beta, 'POST', `/jobs/${id}/cancel`)).status, 403);
    assert.equal((await api(g, g.tok.gamma, 'GET', `/jobs/${id}/out`)).status, 200, 'the sender can read it');
    p.kill('SIGINT');
    assert.equal(await p.done, 130);
  });

  test('only the coordinator can invite, kick or limit, from the CLI or by hand', async () => {
    for (const args of [['invite', 'evil'], ['kick', 'beta'], ['limit', 'beta', '--any']]) {
      const r = sync(g.hc, args, PERSON);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.err, /only the coordinator's own machine can do that/);
    }
    assert.equal((await api(g, g.tok.alpha, 'POST', '/admin/kick', { name: 'beta' })).status, 403);
    assert.deepEqual(machinesOf(g.h0).machines.map(m => m.name).sort(), ['alpha', 'beta']);
  });

  test('kicking a machine that is not in the group is refused', () => {
    const r = sync(g.h0, ['kick', 'nobody'], PERSON);
    assert.equal(r.code, 2);
  });

  test('--on a limited machine is refused before anything is uploaded', t => {
    t.after(() => sync(g.h0, ['limit', 'beta', '--any'], PERSON));
    assert.match(sync(g.h0, ['limit', 'beta', '--only', 'deploy,heavy'], PERSON).out, /beta now only takes deploy, heavy jobs/);
    const before = machinesOf(g.h0).jobs.length;
    const r = sync(g.hc, ['run', 'test', '--on', 'beta', '--', 'echo', 'no'], { cwd: g.proj });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /beta only takes deploy, heavy jobs \(dibs limit on the coordinator\)/);
    assert.equal(r.out, '');
    assert.equal(machinesOf(g.h0).jobs.length, before, 'nothing was sent');
    assert.match(sync(g.h0, ['machines']).out, /beta .*only takes deploy,heavy/);
  });

  test('the coordinator refuses a job for a limited machine even when the sender skips placement', async t => {
    t.after(() => sync(g.h0, ['limit', 'beta', '--any'], PERSON));
    sync(g.h0, ['limit', 'beta', '--only', 'deploy'], PERSON);
    const direct = await api(g, g.tok.gamma, 'POST', '/jobs', { res: ['test'], cmd: ['true'], machine: 'beta', from: 'gamma' });
    assert.equal(direct.status, 409);
  });

  test("a limited machine sees other machines' work without its commands or reasons", async t => {
    t.after(() => sync(g.h0, ['limit', 'beta', '--any'], PERSON));
    sync(g.h0, ['limit', 'beta', '--only', 'deploy'], PERSON);
    const p = bg(t, g.hc, ['run', 'test', '--on', 'alpha', '-m', 'secret reason', '--', 'sh', '-c', 'echo started; sleep 30 # secret-cmd'], { cwd: g.proj });
    await until(() => p.out.includes('started'));
    const alpha = b => b.json.machines.find(m => m.name === 'alpha').board;
    await until(async () => alpha(await api(g, g.tok.gamma, 'GET', '/board')).held.length === 1);
    for (const route of ['/board', '/machines']) {
      const seen = JSON.stringify((await api(g, g.tok.beta, 'GET', route)).json);
      assert.doesNotMatch(seen, /secret/, `${route} as limited beta`);
      for (const tok of [g.tok.gamma, g.token]) assert.match(JSON.stringify((await api(g, tok, 'GET', route)).json), /secret reason/, `${route} unlimited`);
    }
    const b = await api(g, g.tok.beta, 'GET', '/board');
    const row = alpha(b).held[0];
    assert.deepEqual([row.res, row.purpose, row.cmd], [['test'], '', ''], 'resource and who stay, what and why go');
    assert.ok(row.who && row.for >= 0);
    assert.deepEqual(b.json.jobs.filter(j => j.machine === 'alpha').map(j => [j.res, j.from, j.cmd, j.purpose]), [[['test'], 'gamma', [], '']]);
    p.kill('SIGINT');
    await p.done;
  });

  test("a limited machine sees a file lease as files:, not the path it covers", () => {
    const held = { res: ['files:src/auth/**', 'test'], who: 'w', cmd: 'x', purpose: 'p' };
    assert.deepEqual(bare(held).res, ['files:', 'test']);
    assert.deepEqual(bare({ res: ['deploy'], holds: ['files:/a/b', 'deploy'], purpose: 'p' }).holds, ['files:', 'deploy']);
  });

  test('a limited machine still takes the jobs it allows, and --any lifts the limit', t => {
    t.after(() => sync(g.h0, ['limit', 'beta', '--any'], PERSON));
    sync(g.h0, ['limit', 'beta', '--only', 'deploy'], PERSON);
    const ok = sync(g.hc, ['run', 'deploy', '--on', 'beta', '--', 'echo', 'yes'], { cwd: g.proj });
    assert.equal(ok.out, 'yes\n', ok.err);
    assert.match(sync(g.h0, ['limit', 'beta', '--any'], PERSON).out, /beta takes any job again/);
    assert.equal(sync(g.hc, ['run', 'test', '--on', 'beta', '--', 'echo', 'yes'], { cwd: g.proj }).out, 'yes\n');
  });

  test('--anywhere with every machine limited away runs here', t => {
    t.after(() => { sync(g.h0, ['limit', 'alpha', '--any'], PERSON); sync(g.h0, ['limit', 'beta', '--any'], PERSON); });
    sync(g.h0, ['limit', 'alpha', '--only', 'deploy'], PERSON);
    sync(g.h0, ['limit', 'beta', '--only', 'deploy'], PERSON);
    const here = sync(g.hc, ['run', 'test', '--anywhere', '--', 'echo', 'local'], { cwd: g.proj });
    assert.equal(here.out, 'local\n');
    assert.match(here.err, /running here/);
  });

  test('a project rule refuses --on a machine it rules out, naming the rule, before upload', t => {
    const rule = path.join(g.proj, '.dibs.json');
    fs.writeFileSync(rule, JSON.stringify({ stayOn: ['beta'] }));
    t.after(() => fs.rmSync(rule));
    const before = machinesOf(g.h0).jobs.length;
    const r = sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'echo', 'no'], { cwd: path.join(g.proj, 'sub') });
    assert.equal(r.code, 2);
    assert.match(r.err, /\.dibs\.json keeps this project on beta, so it can't go to alpha/);
    assert.equal(machinesOf(g.h0).jobs.length, before, 'nothing was sent');
  });

  test('--anywhere goes only where the project rule allows, even to a busier machine', t => {
    const rule = path.join(g.proj, '.dibs.json');
    fs.writeFileSync(rule, JSON.stringify({ stayOn: ['beta'] }));
    t.after(() => fs.rmSync(rule));
    const any = sync(g.hc, ['run', 'test', '--anywhere', '--', 'echo', 'ok'], { cwd: g.proj });
    assert.equal(any.out, 'ok\n', any.err);
    assert.match(any.err, /goes to beta/);
  });

  test('a rule inside the shipped tree counts too, even below the folder the job starts in', t => {
    const rule = path.join(g.proj, 'sub', '.dibs.json');
    fs.writeFileSync(rule, JSON.stringify({ stayOn: [] }));
    t.after(() => fs.rmSync(rule));
    const inner = sync(g.hc, ['run', 'test', '--on', 'beta', '--', 'echo', 'no'], { cwd: g.proj });
    assert.equal(inner.code, 2);
    assert.match(inner.err, /sub\/\.dibs\.json keeps this project on the machine it lives on, so it can't go to beta/);
    const home = sync(g.hc, ['run', 'test', '--anywhere', '--', 'echo', 'home'], { cwd: g.proj });
    assert.equal(home.out, 'home\n');
    assert.match(home.err, /running here/);
  });
});

describe('dibs kick, mid-job', () => {
  const s = shared();
  let g, toBeta, fromBeta, pids, kick;
  before(async () => {
    g = await group(s, { invite: true, files: PROJECT });
    const m1 = path.join(tmp(s), 'pid1'), m2 = path.join(tmp(s), 'pid2');
    toBeta = bg(s, g.hc, ['run', 'test', '--on', 'beta', '--', ...sleeper(m1)], { cwd: g.proj });
    fromBeta = bg(s, g.hb, ['run', 'test', '--on', 'alpha', '--', ...sleeper(m2)], { cwd: g.proj });
    await until(() => toBeta.out.includes('started') && fromBeta.out.includes('started'));
    pids = [m1, m2].map(f => Number(fs.readFileSync(f, 'utf8')));
    kick = sync(g.h0, ['kick', 'beta'], PERSON);
  });

  test('the coordinator says what the kick stopped', () => {
    assert.equal(kick.code, 0, kick.err);
    assert.match(kick.out, /removed beta: its token no longer works\. 1 job running there reported lost to the sender, 1 job it sent stopped/);
  });

  test('a job running on the kicked machine: its sender gets 77 (it may have run) and the job stops', async () => {
    assert.equal(await toBeta.done, 77, toBeta.err);
    assert.match(toBeta.err, /beta was removed from the group \(dibs kick\)/);
    await until(() => !alive(pids[0]));
  });

  test('a job the kicked machine sent, already running: it gets 77 and the job stops', async () => {
    assert.equal(await fromBeta.done, 77, fromBeta.err);
    await until(() => !alive(pids[1]));
  });

  test('the kicked machine leaves dibs machines and is listed as removed', () => {
    assert.deepEqual(machinesOf(g.h0).machines.map(x => x.name), ['alpha']);
    assert.match(sync(g.h0, ['machines']).out, /removed in the last day: beta/);
  });

  test('its token gets 401 with the reason', async () => {
    const r = await api(g, g.tok.beta, 'POST', '/worker/beat', { name: 'beta', running: [] });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /beta was removed from the group with dibs kick/);
  });

  test('its worker logs one line and keeps running, then picks up a new token once rejoined', async () => {
    await until(() => g.wb.out.includes('turned this machine away'));
    inviteAndJoin(g, g.hb, 'beta');
    // The same process picks up the new token, so it never exited, and it said nothing more while turned away.
    await until(() => /changed; taking jobs as beta/.test(g.wb.out));
    assert.equal(g.wb.exitCode, null, 'the kicked worker is still running');
    assert.equal(g.wb.out.match(/turned this machine away/g).length, 1);
    await until(() => machinesOf(g.h0).machines.some(x => x.name === 'beta'));
    const again = sync(g.hc, ['run', 'test', '--on', 'beta', '--', 'echo', 'back'], { cwd: g.proj });
    assert.equal(again.out, 'back\n', again.err);
  });
});

test('the sender keeps the code even when the coordinator places it somewhere the rule forbids', async t => {
  const hits = [];
  const fake = http.createServer((rq, resp) => {
    hits.push(`${rq.method} ${rq.url}`);
    rq.resume();
    rq.on('end', () => {
      const body = rq.url === '/hello' ? { version: 'x', machines: ['beta'] } : { machine: 'beta', why: 'it said so' };
      resp.writeHead(200, { 'content-type': 'application/json' }); resp.end(JSON.stringify(body));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  const h = tmp(t);
  const proj = gitProject(t, { '.dibs.json': JSON.stringify({ stayOn: ['alpha'] }) });
  // The fake coordinator lives in this process, so these can't block it with spawnSync.
  const j = bg(t, h, ['join', `127.0.0.1:${fake.address().port}`, 'tok', '--name', 'gamma'], PERSON);
  assert.equal(await j.done, 0, j.err);
  const any = bg(t, h, ['run', 'test', '--anywhere', '--', 'echo', 'local'], { cwd: proj });
  assert.equal(await any.done, 0, any.err);
  assert.equal(any.out, 'local\n');
  assert.match(any.err, /keeps this project on alpha, so it can't go to beta; running here/);
  const on = bg(t, h, ['run', 'test', '--on', 'alpha', '--', 'echo', 'no'], { cwd: proj });
  assert.equal(await on.done, 2);
  assert.deepEqual(hits.filter(x => !/^(GET \/hello|POST \/place)$/.test(x)), [], 'no job was created and nothing was uploaded');
});

test('a machine kicked while its job request is still arriving creates no job', async t => {
  const s = makeServer({ token: 'admin-token', registry: path.join(tmp(t), 'machines.json') });
  const srv = s.server().listen(0, '127.0.0.1');
  t.after(() => { s.stop(); srv.close(); });
  await new Promise(r => srv.once('listening', r));
  const at = srv.address().port;
  const tok = s.trust.invite('beta');
  const body = JSON.stringify({ res: ['test'], cmd: ['true'], machine: 'beta', from: 'beta' });
  let sent;
  const answer = new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: at, method: 'POST', path: '/jobs',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, resp => {
      let txt = ''; resp.on('data', d => (txt += d)); resp.on('end', () => resolve({ status: resp.statusCode, json: JSON.parse(txt) }));
    });
    rq.on('error', reject);
    sent = rq;
  });
  // The first bytes reach the server, which has authenticated beta, before the kick.
  const arrived = new Promise(r => srv.once('request', r));
  sent.write(body.slice(0, 10));
  await arrived;
  const k = await fetch(`http://127.0.0.1:${at}/admin/kick`, { method: 'POST', headers: { authorization: 'Bearer admin-token' }, body: JSON.stringify({ name: 'beta' }) });
  assert.equal(k.status, 200);
  sent.end(body.slice(10));
  const r = await answer;
  assert.equal(r.status, 401);
  assert.match(r.json.error, /beta was removed/);
  assert.equal(s.jobs.size, 0);
});
