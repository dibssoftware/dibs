// Placement that prefers a machine already holding the project, and one board
// for every machine. Machines are simulated on this one (helpers.mjs group()).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, port, group, gitProject, machinesOf, BIN, env, G, answers, SERVE_START } from './helpers.mjs';
import { place } from '../src/serve.mjs';
import { copyKey, shortHost } from '../src/remote.mjs';
import { copies } from '../src/worker.mjs';
import { elsewhereLines, elsewherePlain } from '../src/board.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

// The board minus the line about CPU hogs outside dibs, which follows the real machine.
// The board minus the processes outside dibs, which follow the real machine.
const steady = out => out.replace(/^(busy outside dibs|Outside dibs).*\n( {10,}.*\n)*/gim, '');

const T = Date.now();
const KEY = copyKey('x', 'abcdef012345');
const NEED = { res: ['test'], from: 'x', root: 'abcdef012345' };
const w = (name, extra) => [name, { name, os: 'macos', cores: 10, load: 0, memFree: 80, memTotal: 16e9, seen: T, busy: {}, ...extra }];
// cold: idle, no copy. warm: a little busier, with one free copy of the project.
const coldAndWarm = () => new Map([w('cold', { load: 0 }), w('warm', { load: 3, copies: { [KEY]: { used: T, free: 1 } } })]);

test('a machine with a free copy of the project wins over a slightly less busy one, and says why', () => {
  const p = place(coldAndWarm(), NEED, T);
  assert.equal(p.machine, 'warm');
  assert.match(p.why, /already has a copy of this project/);
});

test('another project, or none, gets no head start from a copy', () => {
  assert.equal(place(coldAndWarm(), { ...NEED, root: '000000000000' }, T).machine, 'cold');
  assert.equal(place(coldAndWarm(), { res: ['test'], from: 'x' }, T).machine, 'cold');
});

test("a copy in use, or one a job on its way will take, doesn't count", () => {
  const busy = coldAndWarm();
  busy.get('warm').copies[KEY].free = 0;
  assert.equal(place(busy, NEED, T).machine, 'cold');
  assert.equal(place(coldAndWarm(), { ...NEED, claimed: { warm: 1 } }, T).machine, 'cold');
  const two = coldAndWarm();
  two.get('warm').copies[KEY].free = 2;
  assert.equal(place(two, { ...NEED, claimed: { warm: 1 } }, T).machine, 'warm', 'two free copies, one claimed: one left');
});

test('a machine that would start the job sooner, or is far less busy, beats a copy', () => {
  const line = coldAndWarm();
  line.get('warm').busy = { test: { used: 3, slots: 3, waiting: 1 } };
  assert.equal(place(line, NEED, T).machine, 'cold');
  const hot = coldAndWarm();
  hot.get('warm').load = 18;
  assert.equal(place(hot, NEED, T).machine, 'cold');
});

test("the sender's own machine beats a copy elsewhere when they're equally busy", () => {
  const home = new Map([w('x', { load: 1 }), w('warm', { load: 1, copies: { [KEY]: { used: T, free: 1 } } })]);
  assert.equal(place(home, NEED, T).machine, 'x');
});

test('a worker reports its copies by project, counting the ones not in use', t => {
  const work = path.join(tmp(t), 'work');
  const mk = (name, files = true) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    if (files) fs.writeFileSync(`${d}.files`, '[]');
    return d;
  };
  const inUse = mk('gamma-0123456789ab');
  mk('gamma-0123456789ab-2');
  mk('my-mac-2-111111111111');
  mk('half-222222222222', false);   // never finished unpacking
  mk('stray');
  const c = copies(new Set([inUse]), work);
  assert.deepEqual(Object.keys(c).sort(), ['gamma-0123456789ab', 'my-mac-2-111111111111']);
  assert.equal(c['gamma-0123456789ab'].free, 1);
  assert.equal(c['my-mac-2-111111111111'].free, 1);
  assert.deepEqual(copies(new Set(), path.join(work, 'nope')), {});
});

test('a project sent to a busy machine goes back there while its copy is free', async t => {
  const g = await group(t);
  const first = sync(g.hc, ['run', 'test', '--anywhere', '--', 'true'], { cwd: g.proj });
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /goes to alpha, the least busy/, 'cold everywhere: the idle machine');
  assert.equal(sync(g.hc, ['run', 'test', '--on', 'beta', '--', 'true'], { cwd: g.proj }).code, 0);
  await until(() => machinesOf(g.hc).machines.every(x => Object.values(x.copies || {}).some(c => c.free === 1)));
  assert.match(sync(g.hc, ['run', 'test', '--anywhere', '--', 'true'], { cwd: g.proj }).err, /goes to alpha, it already has a copy/,
    'warm on both: the idle one');
  const other = gitProject(t, { 'b.txt': 'b\n' });
  assert.doesNotMatch(sync(g.hc, ['machines'], { cwd: other }).out, /has this project/);
  assert.match(sync(g.hc, ['machines'], { cwd: g.proj }).out, /beta .*has this project/);

  // While alpha's copy is in use, the next job for the project goes to beta's free copy.
  const long = bg(t, g.hc, ['run', 'test', '--on', 'alpha', '--', 'sh', '-c', 'echo started; sleep 30'], { cwd: g.proj });
  await until(() => long.out.includes('started'));
  await until(() => machinesOf(g.hc).machines.find(x => x.name === 'alpha').running.length === 1);
  assert.match(sync(g.hc, ['run', 'test', '--anywhere', '--', 'true'], { cwd: g.proj }).err, /goes to beta, it already has a copy/);
});

test('every machine on the board: --detail has leases, lines, reasons and jobs in flight, plain dibs has a sentence per line', async t => {
  const g = await group(t);
  bg(t, g.ha, ['run', 'deploy', '-m', 'ship the docs', '--', 'sleep', '20'], { agent: 'alpha-agent' });
  await until(() => JSON.parse(sync(g.ha, ['--json']).out).held.length === 1);
  bg(t, g.ha, ['run', 'deploy', '-p', 'high', '-m', 'hotfix', '--', 'true'], { agent: 'alpha-two' });
  const job = bg(t, g.hc, ['run', 'test', '--on', 'beta', '-m', 'suite', '--', 'sh', '-c', 'echo started; sleep 20'], { cwd: g.proj });
  await until(() => job.out.includes('started'));

  let out = '';
  await until(() => {
    out = sync(g.hc, ['--detail']).out;
    // The coordinator's copy of beta's board lags its last check-in by a few seconds.
    return /alpha-two/.test(out) && /test +tester@gamma .*sh -c/.test(out);
  });
  const lines = out.split('\n');
  assert.match(lines[0], /^gamma \(this one\)  handed out: /, 'this machine first, by name');
  const at = re => lines.findIndex(l => re.test(l));
  assert.ok(at(/^alpha  handed out: .*machine: 90% memory free/) > 0);
  assert.ok(at(/^beta  handed out: .*load 7\.0/) > 0);
  assert.match(out, /deploy +alpha-agent +\d+s .*"ship the docs"  sleep 20/);
  assert.match(out, /1 deploy +alpha-two +waited .*\[high, blocked by slot: deploy\]  "hotfix"/);
  assert.match(out, /test +tester@gamma .*"suite"  sh -c .*<- you/, 'a job sent from here is marked as yours');
  assert.ok(at(/^SENT BETWEEN MACHINES$/) > at(/^beta /));
  assert.match(out, /test +tester +gamma -> beta +running .*"suite"/);
  assert.match(lines.at(-2), /^you are tester\./);
  assert.equal(lines.at(-3), '');
  const plain = sync(g.hc, []).out;
  assert.match(plain, /^On alpha:\n {2}Deploys: alpha-agent is deploying, time left unknown\. Next: alpha-two\.$/m);
  assert.match(plain, /^1 job moving between machines\. More: dibs --detail$/m);
  assert.ok(!lines.some(l => /^(alpha|beta) .*as of/.test(l)), 'fresh boards say nothing about age');

  const j = JSON.parse(sync(g.hc, ['--json']).out);
  assert.deepEqual(j.elsewhere.machines.map(m => m.name).sort(), ['alpha', 'beta']);
  // Nothing beyond what the board shows travels: no pids, sessions or environment.
  const a = j.elsewhere.machines.find(m => m.name === 'alpha').board.held[0];
  for (const k of ['pid', 'pgid', 'spid', 'env', 'start', 'key']) assert.ok(!(k in a), k);
  assert.ok(machinesOf(g.hc).machines.every(m => !('board' in m)), 'dibs machines keeps its output small: no boards');
});

test('with the coordinator down, the board is this machine alone plus one line saying so', async t => {
  const h = tmp(t);
  // The same board with no coordinator, timed: what starting dibs costs on this machine right now.
  const a0 = Date.now();
  const alone = steady(sync(h, []).out);
  const base = Date.now() - a0;
  assert.doesNotMatch(alone, /other machines/);
  fs.writeFileSync(path.join(h, 'remote.json'), JSON.stringify({ url: `http://127.0.0.1:${await port()}`, token: 'x', name: 'solo' }));
  const down = steady(sync(h, []).out);
  const extra = down.split('\n').filter(l => !alone.split('\n').includes(l));
  assert.equal(extra.length, 1, down);
  assert.match(extra[0], /^Other machines: can't reach the coordinator at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)\.$/);
  // The line comes with a blank one before it, setting it apart.
  assert.equal(down.replace(`\n${extra[0]}\n`, ''), alone);
});

test('dibs --json names this machine as the group knows it: the joined name, else the short hostname', async t => {
  const h = tmp(t);
  const me = () => JSON.parse(sync(h, ['--json']).out).me;
  assert.deepEqual(me(), { name: shortHost() });
  fs.writeFileSync(path.join(h, 'remote.json'), JSON.stringify({ url: `http://127.0.0.1:${await port()}`, token: 'x', name: 'solo' }));
  assert.deepEqual(me(), { name: 'solo' });
});

test('a coordinator that never answers costs the board 1.5s, no more', async t => {
  const h = tmp(t);
  // The same board with no coordinator, timed: what starting dibs costs on this machine right now.
  const a0 = Date.now();
  const alone = steady(sync(h, []).out);
  const base = Date.now() - a0;
  const sockets = [];
  const hang = net.createServer(s => sockets.push(s));
  await new Promise(r => hang.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of sockets) s.destroy(); hang.close(); });
  fs.writeFileSync(path.join(h, 'remote.json'), JSON.stringify({ url: `http://127.0.0.1:${hang.address().port}`, token: 'x', name: 'solo' }));
  // Spawned, not spawnSync: the hanging server lives in this process and has to keep accepting.
  const t0 = Date.now();
  const r = await new Promise(res => {
    const c = spawn(process.execPath, [BIN], { env: env(h), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', d => (out += d));
    c.on('exit', code => res({ code, out }));
  });
  const took = Date.now() - t0;
  assert.equal(r.code, 0);
  // 1.5s on top of the board without a coordinator, with room for a busy machine (a loaded run once took 3.1s in all).
  assert.ok(took >= 1400 && took < base + 1500 + 1500, `took ${took}ms, ${base}ms without a coordinator`);
  assert.match(r.out, /Other machines: can't reach the coordinator .*\(no answer in 1\.5s\)/);
  assert.equal(steady(r.out).replace(/\nother machines.*\n/i, ''), alone);
});

test('other machines: old boards say how old, lost and older machines get one line', () => {
  const me = { agent: 'tester', who: 'tester' };
  const rc = { url: 'http://c', name: 'gamma' };
  const board = { memUsed: 0, memBudget: 8 * 1024 ** 3, cpuUsed: 1, cores: 6, free: ['test(2)'],
    held: [{ res: ['test'], who: 'w', for: 60e3, left: 120e3, purpose: 'p', cmd: 'npm test' }], waiting: [] };
  const m = { os: 'macos', cores: 8, load: 1, memFree: 50, diskFree: 1e11, version: '0.0.51', lost: false };
  const out = elsewhereLines({ now: Date.now(), jobs: [], machines: [
    { ...m, name: 'gamma', age: 0, board },
    { ...m, name: 'old', age: 45e3, board },
    { ...m, name: 'gone', age: 300e3, lost: true, board },
    { ...m, name: 'prev', age: 0, version: '0.0.50', board: null },
  ] }, rc, me).join('\n');
  assert.doesNotMatch(out, /^gamma/m, 'this machine is shown from its own state, not twice');
  assert.match(out, /^old  handed out: .*\(as of 45s ago\)$/m);
  assert.match(out, /test +w +1m45s  ~1m15s left  "p"  npm test/, 'durations read as of now');
  assert.match(out, /^gone  not reporting, last heard 5m00s ago$/m);
  assert.match(out, /^prev  runs dibs 0\.0\.50, which doesn't send its board$/m);
  assert.deepEqual(elsewhereLines({ error: 'ECONNREFUSED' }, rc, me), ["other machines: can't reach the coordinator at http://c (ECONNREFUSED)"]);
});

test('other machines in plain dibs: a sentence per busy line, built here so a limited view hides what its rows hide', () => {
  const rc = { url: 'http://c', name: 'gamma' };
  const m = { os: 'macos', cores: 8, load: 1, memFree: 50, diskFree: 1e11, version: '0.8.0', lost: false };
  const board = { held: [{ res: ['test'], who: 'w', for: 60e3, left: 300e3, purpose: '', cmd: '' }, { res: ['files:'], who: 'x', for: 1, left: null, purpose: '' }],
    waiting: [{ res: ['test'], who: 'v', purpose: '' }, { res: ['test'], who: 'u', kept: true }] };
  const out = elsewherePlain({ now: Date.now(), jobs: [], machines: [
    { ...m, name: 'old', age: 60e3, board },
    { ...m, name: 'idle', age: 0, board: { held: [], waiting: [] } },
    { ...m, name: 'gone', age: 300e3, lost: true, board },
  ] }, rc, DEFAULT_CONFIG).join('\n');
  assert.equal(out, ["gone hasn't reported in 5 min.", 'idle has nothing running.',
    'On old:', '  Test runs: w is running tests, about 4 min left. Next: v.', '  Files: x has reserved them, time left unknown.'].join('\n'));
});

test("plain dibs says an on-demand VM that can't wake can't, with why and when it checks again", () => {
  // 2026-10-23: dibs machines said "can't wake" while the board said "asleep: a job sent there wakes it".
  const rc = { url: 'http://c', name: 'gamma' };
  const until = Date.now() + 30 * 864e5;
  const why = "boat's compute for this billing period is used up (it comes back 2026-11-18)";
  const out = elsewherePlain({ now: Date.now(), jobs: [], machines: [
    { name: 'boat-1', os: 'linux', cores: 4, ondemand: { state: 'asleep', provider: 'boat', cantWake: { why, until } } },
  ] }, rc, DEFAULT_CONFIG).join('\n');
  assert.doesNotMatch(out, /wakes it/);
  assert.ok(out.startsWith(`boat-1 is an on-demand VM that can't wake: ${why}. Jobs stay here; dibs checks again on ${new Date(until).toLocaleDateString('en-CA')} at `), out);
});

test("a new coordinator saves remote.json before it says it's listening", async t => {
  // 2026-10-16: a test that read remote.json on seeing "listening" found no file; serve logged the line first.
  // The gap was a few milliseconds, so the old order failed this only sometimes; the new order can't.
  const h = tmp(t);
  const at = await port();
  const serve = bg(t, h, ['serve', '--listen', String(at), '--bind', '127.0.0.1']);
  await until(() => serve.out.includes('listening'), SERVE_START);
  assert.ok(fs.existsSync(path.join(h, 'remote.json')), serve.out);
});

test('a worker whose disk reading failed shows disk unknown in dibs machines', async t => {
  const h = tmp(t);
  const at = await port();
  const serve = bg(t, h, ['serve', '--listen', String(at), '--bind', '127.0.0.1']);
  await until(async () => fs.existsSync(path.join(h, 'remote.json')) && await answers(at), SERVE_START);
  const { token } = JSON.parse(fs.readFileSync(path.join(h, 'remote.json'), 'utf8'));
  const beat = await fetch(`http://127.0.0.1:${at}/worker/beat`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'blind', os: 'linux', cores: 4, memTotal: 8 * G, memFree: 50, load: 0.5, diskFree: null, version: 'x', busy: {}, running: [] }),
  });
  assert.equal(beat.status, 200);
  const r = sync(h, ['machines']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split('\n').find(l => l.trim().startsWith('blind')), /disk unknown/);
});

// 2026-10-20: two test runs showed no reason at all on the board and didn't start, with free slots and memory.
test("a waiter that could start but whose dibs hasn't looked in a while says so on the board", async () => {
  const { boardOf } = await import('../src/board.mjs');
  const { DEFAULT_CONFIG } = await import('../src/config.mjs');
  const t = Date.now();
  const q = { id: 1, res: ['test'], kind: 'run', who: 'me', pid: process.pid, enq: t - 10 * 6e4, mem: 0, cpu: 1, disk: 0, key: 'k', polledAt: t - 5 * 6e4 };
  const b = boardOf({ leases: [], queue: [q] }, { ...DEFAULT_CONFIG }, [], t);
  assert.match(b.waiting[0].blocked, /^ready, but its dibs hasn't looked in 5m/);
  const fresh = boardOf({ leases: [], queue: [{ ...q, polledAt: t }] }, { ...DEFAULT_CONFIG }, [], t);
  assert.equal(fresh.waiting[0].blocked, null);
});
