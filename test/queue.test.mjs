// The real binary, with real processes: who goes next, how long they wait,
// and that a lease ends with its command however the command ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp, sync as dibs, bg as spawnDibs, until, board, alive, wait, BIN, MACHINE, flat, posixOnly, shPid } from './helpers.mjs';

const sync = (h, agent, args) => dibs(h, args, { agent });
const bg = (t, h, agent, args) => spawnDibs(t, h, args, { agent });
const lines = file => fs.readFileSync(file, 'utf8');

// Holds t until the test says so: `release()` ends the holder's command.
async function holder(t, h) {
  const gate = path.join(h, 'gate');
  const p = bg(t, h, 'a', ['t', '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done`]);
  await until(() => board(h).held.length === 1);
  p.release = () => fs.writeFileSync(gate, '');
  return p;
}

test('waiters go in arrival order', async t => {
  const h = tmp(t);
  const order = path.join(h, 'order');
  const a = await holder(t, h);
  const b = bg(t, h, 'b', ['t', '--', 'sh', '-c', `echo b >> '${order}'`]);
  await until(() => board(h).waiting.length === 1);
  const c = bg(t, h, 'c', ['t', '--', 'sh', '-c', `echo c >> '${order}'`]);
  await until(() => board(h).waiting.length === 2);
  a.release();
  await Promise.all([a.done, b.done, c.done]);
  assert.equal(lines(order), 'b\nc\n');
});

test("a waiter's board row says what it's waiting on", async t => {
  const h = tmp(t);
  // 8.8G free for every call here, the board's included.
  const opts = agent => ({ agent, env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree: 8.8 * 1024 ** 3 }) } });
  // Long enough to outlast every call below on a slow runner; it's killed at the end.
  const a = spawnDibs(t, h, ['t', '--', 'sleep', '120'], opts('a'));
  await until(() => board(h).held.length === 1);
  spawnDibs(t, h, ['t', '--', 'true'], opts('b'));
  spawnDibs(t, h, ['u', '--disk', '10G', '--', 'true'], opts('c'));
  await until(() => board(h).waiting.length === 2);
  const out = dibs(h, ['--detail'], opts('d')).out;
  assert.match(out, /t +b .*\[blocked by slot: t\]/);
  assert.match(out, /u +c .*\[blocked by disk: 8\.8G free, needs 10G\]/);
  // dibs --json rows carry the same reason, without the "blocked by".
  const rows = JSON.parse(dibs(h, ['--json'], opts('d')).out).waiting;
  assert.deepEqual(rows.map(q => [q.who, q.blocked]).sort(), [['b', 'slot: t'], ['c', 'disk: 8.8G free, needs 10G']]);
  a.kill('SIGTERM');
  await a.done;
});

test('high priority passes a normal waiter', async t => {
  const h = tmp(t);
  const order = path.join(h, 'order');
  const a = await holder(t, h);
  const b = bg(t, h, 'b', ['t', '--', 'sh', '-c', `echo b >> '${order}'`]);
  await until(() => board(h).waiting.length === 1);
  const c = bg(t, h, 'c', ['t', '-p', 'high', '-m', 'release blocker', '--', 'sh', '-c', `echo c >> '${order}'`]);
  await until(() => board(h).waiting.length === 2);
  assert.deepEqual(board(h).waiting.map(w => w.who), ['c', 'b']);
  a.release();
  await Promise.all([a.done, b.done, c.done]);
  assert.equal(lines(order), 'c\nb\n');
});

test('a run that holds deploy goes ahead of waiters that hold nothing for the rest it needs', async t => {
  const h = tmp(t);
  const order = path.join(h, 'order');
  const a = await holder(t, h);
  const b = bg(t, h, 'b', ['t', '--', 'sh', '-c', `echo b >> '${order}'`]);
  await until(() => board(h).waiting.length === 1);
  const ship = bg(t, h, 'ship', ['run', 'deploy', '-m', 'ship build 122', '--', process.execPath, BIN, 'run', 't', '--', 'sh', '-c', `echo ship >> '${order}'`]);
  await until(() => board(h).waiting[0]?.holding);
  const w = board(h).waiting;
  assert.deepEqual(w.map(x => [x.who, x.holding?.res, x.purpose]), [['ship', ['deploy'], 'ship build 122'], ['b', undefined, '']]);
  assert.match(sync(h, 'viewer', ['--detail']).out, /\[holds deploy, goes first, blocked by slot: t\]\s+"ship build 122"/);
  assert.match(sync(h, 'ship', ['why', '--detail']).out, /holds deploy, so it goes first/);
  assert.match(sync(h, 'ship', ['why']).out, /Moved ahead because it already has a deploy going and needs this to finish\./);
  a.release();
  assert.deepEqual(await Promise.all([a.done, b.done, ship.done]), [0, 0, 0]);
  assert.equal(lines(order), 'ship\nb\n');
  assert.match(ship.err, /you already have deploys, so you go ahead of anyone who has nothing yet \(urgent work still goes first\)/);
});

test('a run nested in one that has part of what it needs waits only for the rest', t => {
  const h = tmp(t);
  const r = sync(h, 'a', ['run', 'deploy', '--max-wait', '5s', '--', process.execPath, BIN, 'run', 'deploy,t', '--max-wait', '5s', '--', 'echo', 'nested']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'nested\n');
});

test("DIBS_LEASE set by hand doesn't borrow someone else's lease to skip the line", async t => {
  const h = tmp(t);
  await holder(t, h);
  const id = JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).leases[0].id;
  const r = dibs(h, ['run', 't', '--no-wait', '--', 'echo', 'jumped'], { agent: 'b', env: { DIBS_LEASE: String(id) } });
  assert.equal(r.code, 75, r.err);
  assert.equal(r.out, '');
});

test('yield lets another agent go first', async t => {
  const h = tmp(t);
  const order = path.join(h, 'order');
  const a = await holder(t, h);
  const b = bg(t, h, 'b', ['t', '--', 'sh', '-c', `echo b >> '${order}'`]);
  await until(() => board(h).waiting.length === 1);
  const c = bg(t, h, 'c', ['t', '--', 'sh', '-c', `echo c >> '${order}'`]);
  await until(() => board(h).waiting.length === 2);
  assert.match(sync(h, 'b', ['yield', 'c']).out, /c now goes before you/);
  assert.deepEqual(board(h).waiting.map(w => w.who), ['c', 'b']);
  a.release();
  await Promise.all([a.done, b.done, c.done]);
  assert.equal(lines(order), 'c\nb\n');
});

test("yield to someone who isn't waiting changes nothing", async t => {
  const h = tmp(t);
  await holder(t, h);
  bg(t, h, 'b', ['t', '--', 'true']);
  await until(() => board(h).waiting.length === 1);
  assert.match(sync(h, 'b', ['yield', 'nobody']).out, /isn't waiting/);
  assert.deepEqual(board(h).waiting.map(w => w.who), ['b']);
});

test('yield hands over a hold', async t => {
  const h = tmp(t);
  assert.equal(sync(h, 'a', ['hold', 't', '--for', '5m']).code, 0);
  const b = bg(t, h, 'b', ['t', '--', 'true']);
  await until(() => board(h).waiting.length === 1);
  assert.match(sync(h, 'a', ['yield', 'b']).out, /Gave back your hold on t\./);
  assert.equal(await b.done, 0);
});

test('a killed wrapper frees its slot and its children die', async t => {
  const h = tmp(t);
  const marker = path.join(h, 'child.pid');
  const w = bg(t, h, 'a', ['t', '--', 'sh', '-c', `echo ${shPid('$$')} > '${marker}'; sleep 60`]);
  await until(() => fs.existsSync(marker) && lines(marker).trim());
  const child = Number(lines(marker));
  w.kill('SIGKILL');
  await w.done;
  assert.equal(board(h).held.length, 0);
  await until(() => !alive(child));
});

test('a command launched behind the gate never starts if dibs dies before recording it', async t => {
  const h = tmp(t);
  const ran = path.join(h, 'ran');
  // A caller that launches and then dies without calling go(), the way a dibs
  // killed between launch and recording the process group would.
  const caller = `import('${new URL('../src/platform.mjs', import.meta.url).href}').then(p => {
    p.launch(['touch', ${JSON.stringify(ran)}], { env: process.env, gate: true }); process.exit(0); })`;
  const r = spawnSync(process.execPath, ['-e', caller], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  await wait(500);
  assert.equal(fs.existsSync(ran), false);
});

test('children that start their own process group are stopped with the lease', { skip: posixOnly('process groups are POSIX; Windows has no setsid') }, async t => {
  const h = tmp(t);
  const marker = path.join(h, 'gc.pid'), gate = path.join(h, 'gate');
  // The parent stays until dibs has noticed the split-off group, then exits and leaves it running.
  const js = `const c = require('child_process').spawn('sleep', ['47'], { detached: true, stdio: 'ignore' });
    require('fs').writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref();
    setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) process.exit(0); }, 50);`;
  const w = bg(t, h, 'a', ['t', '--', process.execPath, '-e', js]);
  await until(() => fs.existsSync(marker));
  const pid = Number(lines(marker));
  await until(() => board(h).held[0]?.groups?.includes(pid));
  fs.writeFileSync(gate, '');
  assert.equal(await w.done, 0);
  await until(() => !alive(pid), 5000);
});

test('SIGTERM reaches the command', { skip: posixOnly("Windows can't deliver SIGTERM: kill() there ends the process outright") }, async t => {
  const h = tmp(t);
  const w = bg(t, h, 'a', ['t', '--', 'sh', '-c', 'trap "echo got-term; exit 0" TERM; echo ready; sleep 30 & wait']);
  await until(() => w.out.includes('ready'));
  w.kill('SIGTERM');
  assert.equal(await w.done, 0);
  assert.match(w.out, /got-term/);
  assert.equal(board(h).held.length, 0);
});

test('--no-wait fails at once with 75 and leaves no place behind', async t => {
  const h = tmp(t);
  await holder(t, h);
  const r = sync(h, 'b', ['t', '--no-wait', '--', 'echo', 'ran']);
  assert.equal(r.code, 75);
  assert.equal(r.out, '');
  assert.equal(board(h).waiting.length, 0);
});

test('a wait that times out exits 75 and says the command did not run', async t => {
  const h = tmp(t);
  await holder(t, h);
  const r = sync(h, 'b', ['run', 't', '--max-wait', '1s', '--', 'echo', 'ran']);
  assert.equal(r.code, 75);
  assert.equal(r.out, '');
  // Exactly what an agent needs: that nothing ran, why that's fine, and the command that keeps its place.
  assert.match(r.err, /dibs: gave up after \d+s in the queue\. Your command did NOT run \(exit 75, not a failure\)\.\n/);
  assert.match(r.err, /\n {6}You're next in the t queue, as soon as a finishes\.\n {6}Your place is kept until .*\. To keep it, run the same command again before then:\n {8}dibs run t --max-wait 1s -- echo ran\n/);
  assert.match(r.err, /Or wait as long as it takes: add --wait/);
});

test('a timed-out wait keeps its place, and rerunning reclaims it', async t => {
  const h = tmp(t);
  const a = await holder(t, h);
  assert.equal(sync(h, 'b', ['t', '--max-wait', '1s', '--', 'echo', 'b']).code, 75);
  const kept = board(h).waiting;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pid, null);
  const c = bg(t, h, 'c', ['t', '--', 'true']);
  await until(() => board(h).waiting.length === 2);
  const b = bg(t, h, 'b', ['t', '--', 'echo', 'b']);
  await until(() => board(h).waiting.every(w => w.pid));
  assert.deepEqual(board(h).waiting.map(w => w.who), ['b', 'c']);
  a.release();
  assert.deepEqual(await Promise.all([a.done, b.done, c.done]), [0, 0, 0]);
});

test('memory budget makes a big job wait while a small one runs', async t => {
  const h = tmp(t);
  // Over 100 means the machine never counts as roomy, so the budget always applies.
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ roomyMemFree: 101 }));
  const big1 = bg(t, h, 'a', ['x1', '--mem', '5G', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  const big2 = bg(t, h, 'b', ['x2', '--mem', '5G', '--', 'echo', 'big2']);
  await until(() => /Waiting for room in memory: it needs 5\.0 GB; 5\.0 GB of the 8\.0 GB dibs shares out is taken, 3\.0 GB left/.test(flat(big2.err)));
  assert.equal(sync(h, 'c', ['x3', '--mem', '1G', '--', 'true']).code, 0);
  assert.equal(big2.out, '');
  big1.kill('SIGTERM');
  assert.equal(await big2.done, 0);
  assert.equal(big2.out, 'big2\n');
});

test('many agents hammering the state file never lose a lease', async t => {
  const h = tmp(t);
  const runs = Array.from({ length: 12 }, (_, i) => bg(t, h, `p${i}`, [`r${i % 3}`, '--', 'true']));
  assert.deepEqual(await Promise.all(runs.map(r => r.done)), Array(12).fill(0), runs.map(r => r.err).join(''));
  const b = board(h);
  assert.equal(b.held.length + b.waiting.length, 0);
});

test('the same command twice from one agent gets two leases, and each ends alone', async t => {
  const h = tmp(t);
  const run = gate => spawnDibs(t, h, ['test', '--', 'sh', '-c', 'while [ ! -e "$GATE" ]; do sleep 0.05; done'],
    { agent: 'a', env: { GATE: path.join(h, gate) } });
  const one = run('one'), two = run('two');
  await until(() => board(h).held.length === 2);
  fs.writeFileSync(path.join(h, 'one'), '');
  assert.equal(await one.done, 0);
  assert.deepEqual(board(h).held.map(l => l.pid), [two.pid]);
  fs.writeFileSync(path.join(h, 'two'), '');
  assert.equal(await two.done, 0);
});
