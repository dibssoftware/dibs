// dibs pair --machine: a one-time code on the coordinator, and dibs join <code>
// on the new machine, which finds the coordinator and joins in one step. Each
// test runs a real coordinator on loopback and real CLIs in their own DIBS_HOMEs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, port, answers, until, gitProject, SERVE_START, machinesOf, env, BIN } from './helpers.mjs';

// The UDP lookup goes to the coordinator's port, and never to a real tailnet.
const NET = p => ({ env: { DIBS_PAIR_PORT: String(p), DIBS_TAILSCALE: 'none' } });

async function coordinator(t) {
  const h0 = tmp(t, 'coord'), p = await port();
  bg(t, h0, ['serve', '--listen', String(p), '--bind', '127.0.0.1']);
  await until(async () => fs.existsSync(path.join(h0, 'remote.json')) && await answers(p), SERVE_START);
  const code = (...args) => {
    const r = sync(h0, ['pair', '--machine', '--json', ...args]);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  return { h0, p, code };
}

test('a code from dibs pair --machine joins a new machine in one step; it takes jobs, and the code works once', async t => {
  const c = await coordinator(t);
  const made = sync(c.h0, ['pair', '--machine']);
  assert.match(made.out, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\n/);
  assert.match(made.out, /dibs join [0-9A-Z]{4}-[0-9A-Z]{4}\n/);
  const { code } = c.code();
  const hn = tmp(t, 'newbox');
  const j = sync(hn, ['join', code.toLowerCase(), '--at', `127.0.0.1:${c.p}`, '--name', 'newbox']);
  assert.equal(j.code, 0, j.err);
  assert.match(j.out, /joined .* as newbox/);
  const rc = JSON.parse(fs.readFileSync(path.join(hn, 'remote.json'), 'utf8'));
  assert.equal(rc.url, `http://127.0.0.1:${c.p}`);
  assert.match(rc.token, /^dibs_/, 'a token of its own, not the coordinator\'s');

  bg(t, hn, ['worker']);
  await until(() => machinesOf(c.h0).machines.some(m => m.name === 'newbox'));
  const proj = gitProject(t);
  const r = sync(c.h0, ['run', 'test', '--on', 'newbox', '--', 'sh', '-c', 'echo ran on newbox'], { cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ran on newbox/);

  const again = sync(tmp(t, 'other'), ['join', code, '--at', `127.0.0.1:${c.p}`, '--name', 'other']);
  assert.equal(again.code, 1, 'a used code finds no coordinator holding it');
  const ev = fs.readFileSync(path.join(hn, 'events.jsonl'), 'utf8');
  assert.match(ev, /"act":"join"/);
  assert.ok(!ev.includes(code) && !ev.includes(rc.token), 'the history never holds the code or the token');
});

test('dibs join <code> finds the coordinator on the network with no address given', async t => {
  const c = await coordinator(t);
  const { code } = c.code();
  const j = sync(tmp(t, 'found'), ['join', code, '--name', 'found'], NET(c.p));
  assert.equal(j.code, 0, j.err);
  assert.ok(machinesOf(c.h0).invited.some(m => m.name === 'found' && m.paired));
});

test('a machine that answers without holding the code never receives it', async t => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      seen.push(`${req.url} ${b}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'evil', nc: 'x'.repeat(43), proofs: ['made-up'] }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  // Not sync(): the fake answers from this process, which a blocking spawn would hold still.
  const j = await new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, 'join', 'ABCD-EFGH', '--at', `127.0.0.1:${fake.address().port}`], { env: env(tmp(t, 'victim')) });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, err }));
  });
  assert.equal(j.code, 1, j.err);
  assert.match(j.err, /no coordinator holding that code answered/);
  assert.deepEqual(seen.map(x => x.split(' ')[0]), ['/pair/hello']);
  assert.ok(!seen.join('').includes('ABCDEFGH') && !seen.join('').includes('ABCD-EFGH'));
});

test('wrong codes: ten in ten minutes and even the right one waits; a name in use is refused and the code stays good', async t => {
  const c = await coordinator(t);
  const { code } = c.code();
  const hn = tmp(t, 'n1');
  assert.equal(sync(hn, ['join', code, '--at', `127.0.0.1:${c.p}`, '--name', 'taken']).code, 0);
  // An open code can't take a name already in the group; the try doesn't spend it.
  const second = c.code().code;
  const clash = sync(tmp(t, 'n2'), ['join', second, '--at', `127.0.0.1:${c.p}`, '--name', 'taken']);
  assert.equal(clash.code, 2);
  assert.match(clash.err, /already in the group/);
  assert.equal(sync(tmp(t, 'n3'), ['join', second, '--at', `127.0.0.1:${c.p}`, '--name', 'fresh']).code, 0);
  // A code made for a name replaces that machine, as dibs invite does.
  const forIt = c.code('--name', 'taken').code;
  assert.equal(sync(tmp(t, 'n4'), ['join', forIt, '--at', `127.0.0.1:${c.p}`, '--name', 'ignored']).code, 0);
  assert.notEqual(sync(hn, ['machines']).code, 0, 'the replaced machine\'s token stopped working');

  const good = c.code().code;
  const url = `http://127.0.0.1:${c.p}/pair/join`;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: `ZZZZ${String(i).padStart(4, '0')}`, name: 'x' }) });
    assert.equal(r.status, 401);
  }
  const held = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: good, name: 'late' }) });
  assert.equal(held.status, 429);
});

test('dibs pair --list shows machine codes and machines; --revoke <name> kicks one, and only the coordinator sees them', async t => {
  const c = await coordinator(t);
  const { code, id } = c.code();
  const hn = tmp(t, 'mini');
  assert.equal(sync(hn, ['join', code, '--at', `127.0.0.1:${c.p}`, '--name', 'mini']).code, 0);
  c.code('--name', 'later-box');
  const list = sync(c.h0, ['pair', '--list']).out;
  assert.match(list, /machine code for later-box/);
  assert.match(list, /mini +machine, joined with a code/);
  assert.ok(!list.includes(id), 'a spent code is gone from the list');
  // Another machine in the group can't read them: /admin/ is the coordinator's own.
  const rc = JSON.parse(fs.readFileSync(path.join(hn, 'remote.json'), 'utf8'));
  const peek = await fetch(`http://127.0.0.1:${c.p}/admin/pairs`, { headers: { authorization: `Bearer ${rc.token}` } });
  assert.equal(peek.status, 403);

  const r = sync(c.h0, ['pair', '--revoke', 'mini']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /removed mini/);
  assert.notEqual(sync(hn, ['machines']).code, 0);
  assert.match(sync(c.h0, ['pair', '--revoke', 'all']).out, /Voided the open machine code\. Machines in the group stay/);
  assert.doesNotMatch(sync(c.h0, ['pair', '--list']).out, /machine code/);
  assert.match(fs.readFileSync(path.join(c.h0, 'events.jsonl'), 'utf8'), /"act":"pair machine"/);
});

test('the dibs page pairs a machine, lists it and removes it; none of it is reachable through the relay', async t => {
  const c = await coordinator(t);
  const wp = await port();
  bg(t, c.h0, ['web', '--port', String(wp)]);
  await until(() => answers(wp));
  const base = `http://127.0.0.1:${wp}`;
  const login = await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: sync(c.h0, ['pair']).out.split('\n')[0].trim() }) })).json();
  const h = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
  const post = async (route, body) => { const r = await fetch(base + route, { method: 'POST', headers: h, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

  const made = await post('/api/machines/pair', { name: 'pagebox' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.match(made.json.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(made.json.name, 'pagebox');
  assert.equal((await post('/api/machines/pair', { name: '-rf' })).status, 400);
  assert.equal(sync(tmp(t, 'pb'), ['join', made.json.code, '--at', `127.0.0.1:${c.p}`]).code, 0);
  const pairs = await (await fetch(`${base}/api/machines/pairs`, { headers: h })).json();
  assert.deepEqual(pairs.machines.map(m => m.name), ['pagebox']);
  assert.equal((await post('/api/machines/revoke', { name: 'pagebox' })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/machines/pairs`, { headers: h })).json()).machines, []);

  const { remoteAccess } = await import('../src/web.mjs');
  assert.equal(remoteAccess('POST', '/api/machines/pair', true), 'local');
  assert.equal(remoteAccess('POST', '/api/machines/revoke', true), 'local');
  assert.equal(remoteAccess('GET', '/api/machines/pairs', true), 'local');
});
