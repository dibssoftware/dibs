// What may leave a machine, and what a machine may see or change: nested
// project rules, the secret filter, a failed coordinator start, a limited
// machine's view, a worker's report, and the exit code when a job may have run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, port, group, machinesOf, PERSON } from './helpers.mjs';
import { tarCreate, tarExtract } from '../src/remote.mjs';
import { makeServer } from '../src/serve.mjs';

// A worker that stops answering: it's alive, it just never checks in again.
const freeze = (t, p) => { p.kill('SIGSTOP'); t.after(() => p.kill('SIGCONT')); };

test('a .dibs.json inside the project holds when its machine goes quiet: the job is not moved to another one', async t => {
  const g = await group(t, { timing: { workerLost: 4000 }, files: { 'a.txt': 'hi\n', 'sub/.dibs.json': JSON.stringify({ stayOn: ['alpha'] }) } });
  // Gone before the job reaches it: killed, so no check-in of its is left open to hand the job to.
  g.wa.kill('SIGKILL');
  await g.wa.done;
  const p = bg(t, g.hc, ['run', 'test', '--anywhere', '--', 'sh', '-c', 'echo ran on $DIBS_HOME'], { cwd: g.proj });
  assert.equal(await p.done, 76, p.out + p.err);
  assert.match(p.err, /goes to alpha/);
  assert.match(p.err, /alpha stopped reporting before the job started, and no other machine can take it/);
  assert.doesNotMatch(p.out, /ran on/);
});

test('a machine lost while running a job: the sender gets 77 (it may have run), not 76', async t => {
  const g = await group(t, { timing: { workerLost: 4000 } });
  const p = bg(t, g.hc, ['run', 'test', '--on', 'alpha', '--', 'sh', '-c', 'echo started; sleep 60'], { cwd: g.proj });
  await until(() => p.out.includes('started'));
  freeze(t, g.wa);
  assert.equal(await p.done, 77, p.err);
  assert.match(p.err, /alpha stopped reporting while running the job/);
  g.wa.kill('SIGCONT');   // back, it hears the job ended and stops it
});

test('a machine joined elsewhere keeps its join when dibs serve is refused, and a port in use changes nothing', async t => {
  const h = tmp(t);
  const joined = JSON.stringify({ url: 'http://100.64.1.2:7420', token: 'their-token', name: 'w' });
  fs.writeFileSync(path.join(h, 'remote.json'), joined);
  const at = await port();
  const r = sync(h, ['serve', '--listen', String(at), '--bind', '127.0.0.1']);
  assert.equal(r.code, 2);
  assert.match(r.err, /joined to the coordinator at http:\/\/100\.64\.1\.2:7420.*dibs serve --force/);
  assert.equal(fs.readFileSync(path.join(h, 'remote.json'), 'utf8'), joined);

  const h2 = tmp(t);
  fs.mkdirSync(path.join(h2, 'jobs', 'x'), { recursive: true });
  const taken = net.createServer().listen(at, '127.0.0.1');
  t.after(() => taken.close());
  await new Promise(r => taken.once('listening', r));
  const r2 = sync(h2, ['serve', '--listen', String(at), '--bind', '127.0.0.1']);
  assert.equal(r2.code, 2);
  assert.match(r2.err, /can't listen on 127\.0\.0\.1/);
  assert.ok(!fs.existsSync(path.join(h2, 'remote.json')), 'no remote.json pointing at whoever holds the port');
  assert.ok(fs.existsSync(path.join(h2, 'jobs', 'x')), 'jobs are cleared only once it listens');
});

test("a limited machine doesn't see other machines' file lease paths or project copies; the coordinator does", async t => {
  const g = await group(t, { invite: true });
  assert.equal(sync(g.h0, ['limit', 'gamma', '--only', 'test'], PERSON).code, 0);
  const held = sync(g.hb, ['hold', 'files:/work/secret-plan/**', '--for', '5m', '-m', 'planning']);
  assert.equal(held.code, 0, held.err);
  await until(() => JSON.stringify(machinesOf(g.h0)).includes('secret-plan'));
  // gamma's view of beta can trail the coordinator's by a beat.
  let seen;
  await until(() => (seen = machinesOf(g.hc)).machines.find(m => m.name === 'beta')?.busy['files:']?.used === 1);
  assert.doesNotMatch(JSON.stringify(seen), /secret-plan/);
  const beta = seen.machines.find(m => m.name === 'beta');
  assert.equal(beta.busy['files:'].used, 1);
  assert.equal(beta.copies, undefined);
  assert.doesNotMatch(sync(g.hc, ['machines']).out, /secret-plan/);
});

test('dibs limit --sends: a machine may only send what it is allowed; --anywhere then runs at home', async t => {
  const g = await group(t, { invite: true });
  const set = sync(g.h0, ['limit', 'gamma', '--sends', 'none'], PERSON);
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /gamma now takes any job from other machines, and may send no jobs to other machines/);
  assert.match(sync(g.h0, ['machines']).out, /sends nothing/);
  const on = sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'echo', 'there'], { cwd: g.proj });
  assert.equal(on.code, 2);
  assert.match(on.err, /gamma may not send jobs to other machines/);
  const any = sync(g.hc, ['run', 'test', '--anywhere', '--', 'echo', 'here'], { cwd: g.proj });
  assert.equal(any.code, 0, any.err);
  assert.match(any.err, /running here: gamma may not send jobs/);
  assert.match(sync(g.h0, ['limit', 'gamma', '--any'], PERSON).out, /takes any job again/);
  assert.equal(sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'echo', 'there'], { cwd: g.proj }).code, 0);
});

test('outside git, credentials and hidden folders stay home; build config goes along', async t => {
  const g = await group(t);
  const dir = tmp(t, 'loose');
  const files = {
    'a.txt': 'a', '.eslintrc': '{}', '.github/workflows/ci.yml': 'on: push', '.config/gh/hosts.yml': 'oauth_token: x', '.docker/config.json': '{}',
    'client_secret_1.apps.json': '{}', 'prod-service-account.json': '{}', 'terraform.tfstate': '{}', '.dibs/remote.json': '{}', '.foo/bar.txt': 'x',
    '.kube/config': 'x', 'sub/.netrc': 'x', '.credentials.json': '{}', 'id.p12': 'x',
  };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  const r = sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'find', '.', '-type', 'f'], { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const got = r.out.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, '')).sort();
  assert.deepEqual(got, ['.eslintrc', '.github/workflows/ci.yml', 'a.txt']);
});

test('dibs refuses to send a home folder to another machine', async t => {
  const g = await group(t);
  const home = tmp(t, 'home');
  fs.writeFileSync(path.join(home, 'notes.txt'), 'x');
  const on = sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'true'], { cwd: home, env: { HOME: home } });
  assert.equal(on.code, 2);
  assert.match(on.err, /is your home folder or above it/);
  const any = sync(g.hc, ['run', 'test', '--anywhere', '--', 'echo', 'here'], { cwd: home, env: { HOME: home } });
  assert.equal(any.code, 0, any.err);
  assert.equal(any.out, 'here\n');
});

test('a working copy over the limit is a size error with status 413, not a crash', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'big'), crypto.randomBytes(64 * 1024));
  assert.throws(() => tarCreate(dir, ['big'], 1000), e => e.status === 413 && /over the 1K limit/.test(e.message));
});

test('files brought back: only the named paths are unpacked', t => {
  const src = tmp(t), dest = tmp(t);
  fs.mkdirSync(path.join(src, 'out'));
  fs.writeFileSync(path.join(src, 'out', 'r.txt'), 'r');
  fs.writeFileSync(path.join(src, 'evil.txt'), 'e');
  fs.writeFileSync(path.join(src, 'outside.txt'), 'o');
  const buf = tarCreate(src, ['out/r.txt', 'evil.txt', 'outside.txt']);
  tarExtract(dest, buf, ['out']);
  assert.ok(fs.existsSync(path.join(dest, 'out', 'r.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'outside.txt')));
});

test("a worker's check-in can't overwrite the coordinator's own fields", async t => {
  const s = makeServer({ token: 'admin-token', registry: path.join(tmp(t), 'machines.json') });
  const srv = s.server().listen(0, '127.0.0.1');
  const stop = new AbortController();
  t.after(() => { stop.abort(); s.stop(); srv.close(); });
  await new Promise(r => srv.once('listening', r));
  const beat = fetch(`http://127.0.0.1:${srv.address().port}/worker/beat`, { method: 'POST', signal: stop.signal,
    headers: { authorization: 'Bearer admin-token' }, body: JSON.stringify({ name: 'x', wake: [1], pending: [9], load: 'high', running: 'abc', os: 'macos' }) }).catch(() => {});
  await until(() => s.workers.get('x'));
  const w = s.workers.get('x');
  assert.ok((w.wake || []).every(f => typeof f === 'function'), 'wake holds only the coordinator\'s own waiters');
  assert.deepEqual(w.pending, []);
  assert.equal(w.load, 0);
  assert.deepEqual(w.running, []);
  stop.abort();
  await beat;
});
