// Thin waiters (src/thin.sh) and the broker that waits for them (src/broker.mjs):
// a wait is a shell blocked on a FIFO, and one Node process decides for all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { BIN, tmp, env, sync, track, until, alive, flat, board, PERSON } from './helpers.mjs';
import { dibsMem, processes } from '../src/platform.mjs';

const THIN = path.join(path.dirname(BIN), '..', 'src', 'thin.sh');
const state = home => JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
const entry = (home, pid) => state(home).queue.find(q => q.pid === pid);
// What a process was started as. Not ps's comm: on Linux that's a thread name,
// and Node calls its main thread MainThread.
const comm = pid => spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
const asShell = pid => /\bthin\.sh\b/.test(comm(pid));
const asNode = pid => /^\S*\bnode\s/.test(comm(pid));
const events = home => { try { return fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

// A thin waiter as bin/dibs.mjs starts one, under sh (bash on macOS) or dash.
function thin(t, home, args, opts = {}) {
  const p = spawn(opts.sh || '/bin/sh', [THIN, BIN, ...args], { env: env(home, opts), cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  return track(t, p);
}
// Something to wait behind: a hold on deploy (one slot) by another agent.
function block(home) {
  const r = sync(home, ['hold', 'deploy', '--for', '10m', '-m', 'blocking'], { agent: 'other' });
  assert.equal(r.code, 0, r.err);
}
const unblock = home => assert.equal(sync(home, ['release', 'deploy'], { agent: 'other' }).code, 0);
// Waiting through the broker, not in Node of its own: its entry handed over,
// a broker on record, and the shell told it's queued.
const waitingThin = (home, p) => { const q = entry(home, p.pid); return q?.wake?.pid === p.pid && !!state(home).broker && asShell(p.pid) && p.err.includes('queued for'); };
// Until p waits thin. A Node start or two under load can take seconds; on a
// timeout, say what the waiter printed and what the state shows.
async function inLine(home, p) {
  try { await until(() => waitingThin(home, p), 60e3); } catch (e) {
    let st = null; try { st = state(home); } catch {}
    throw new Error(`${e.message}\nwaiter: exit ${p.exitCode} ${comm(p.pid)}\n${p.err}\nbroker: ${JSON.stringify(st?.broker)}\nentry: ${JSON.stringify(st?.queue.find(q => q.pid === p.pid))}`);
  }
}
// Its _enqueue done: no Node left under the shell. Until then the Node that started the
// broker may still be waiting for it to open its FIFO, and a broker stopped or killed
// meanwhile is one it saw die at start, so it marks the broker broken for a minute.
const settled = p => until(() => spawnSync('pgrep', ['-P', String(p.pid)]).status === 1, 60e3);
// Every test starts a broker; it's stopped with the test.
function stopBroker(t, home) {
  t.after(() => { try { process.kill(state(home).broker?.pid, 'SIGKILL'); } catch {} });
}

for (const sh of ['/bin/sh', '/bin/dash']) {
  test(`${sh}: a thin waiter waits as a shell, then becomes the run with the same pid`, async t => {
    const home = tmp(t);
    stopBroker(t, home);
    block(home);
    const p = thin(t, home, ['run', 'deploy', '-m', 'thin', '--', 'sh', '-c', 'echo ran; sleep 3'], { sh });
    await inLine(home, p);
    assert.ok(alive(state(home).broker.pid));
    unblock(home);
    // The lease names the shell's pid, which is now Node running the command.
    await until(() => state(home).leases.some(l => l.kind === 'run' && l.pid === p.pid));
    await until(() => asNode(p.pid));
    await until(() => p.out.includes('ran'));
    // Still on record after more than a tick: the exec kept the start time the lease names.
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(state(home).leases.some(l => l.pid === p.pid));
    assert.equal(await p.done, 0, p.err);
  });

  test(`${sh}: Ctrl-C or kill of a thin waiter leaves the line at once`, async t => {
    const home = tmp(t);
    stopBroker(t, home);
    block(home);
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      const p = thin(t, home, ['run', 'deploy', '--', 'true'], { sh });
      await inLine(home, p);
      // Blocked in its read, as a waiter is nearly all the time: nothing of its own running.
      await until(() => !spawnSync('pgrep', ['-P', String(p.pid)]).stdout.toString().trim());
      const id = entry(home, p.pid).id;
      p.kill(sig);
      assert.equal(await p.done, code);
      board(home);   // a state read, which drops a place nobody can claim
      const left = state(home).queue.find(q => q.id === id);
      assert.ok(!left, `${sig}: place given up, but its entry is still in line: ${JSON.stringify(left)}\n`
        + `events: ${JSON.stringify(events(home).filter(e => e.id === id || e.shell === p.pid))}\nwaiter said: ${p.err}`);
      // Under load a waiter may have moved to Node just before the signal (its thin event says so); then the place goes as gone.
      const fell = events(home).some(e => e.kind === 'thin' && e.shell === p.pid);
      assert.ok(events(home).some(e => e.kind === 'left' && e.id === id && (e.why === sig || (fell && e.why === 'gone'))),
        `${sig}: no left event for #${id}: ${JSON.stringify(events(home).filter(e => e.id === id || e.shell === p.pid))}`);
      assert.ok(!fs.existsSync(path.join(home, 'w', String(p.pid))), 'its FIFO is gone');
    }
  });
}

test('kill -9 of a waiter, thin or in Node: its place leaves the line at the next state read', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'true'], { agent: 'thin' });
  await inLine(home, p);
  const fat = spawn(process.execPath, [BIN, 'run', 'deploy', '--', 'true'], { env: env(home, { agent: 'fat' }), stdio: 'ignore' });
  track(t, fat);
  await until(() => entry(home, fat.pid));
  const ids = [entry(home, p.pid).id, entry(home, fat.pid).id];
  p.kill('SIGKILL');
  fat.kill('SIGKILL');
  await p.done;
  await fat.done;
  board(home);
  for (const id of ids) assert.ok(!state(home).queue.some(q => q.id === id), `#${id} is still in line`);
  for (const id of ids) assert.ok(events(home).some(e => e.kind === 'left' && e.id === id && e.why === 'gone'));
});

test('a thin waiter and an in-process one take turns in arrival order', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const fat = spawn(process.execPath, [BIN, 'run', 'deploy', '--', 'sleep', '1'], { env: env(home, { agent: 'fat' }), stdio: 'ignore' });
  track(t, fat);
  await until(() => entry(home, fat.pid));
  const p = thin(t, home, ['run', 'deploy', '--', 'true'], { agent: 'thin' });
  await inLine(home, p);
  unblock(home);
  assert.equal(await fat.done, 0);
  assert.equal(await p.done, 0, p.err);
  const starts = events(home).filter(e => e.kind === 'start' && e.res.includes('deploy') && e.who !== 'other').map(e => e.who);
  assert.deepEqual(starts, ['fat', 'thin']);
});

test('a thin waiter past --max-wait exits 75 and keeps its place', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--max-wait', '2s', '--', 'true']);
  await inLine(home, p);
  const id = entry(home, p.pid).id;
  assert.equal(await p.done, 75);
  assert.match(flat(p.err), /gave up after .* Your command did NOT run \(exit 75/);
  assert.match(p.err, /dibs run deploy --max-wait 2s -- true/);
  const q = state(home).queue.find(x => x.id === id);
  assert.ok(q && q.pid === null && q.keepUntil, 'place kept');
});

test('--no-wait through the thin path never reaches the broker', async t => {
  const home = tmp(t);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--no-wait', '--', 'true']);
  assert.equal(await p.done, 75);
  assert.match(flat(p.err), /--no-wait doesn't wait/);
  assert.equal(state(home).broker, undefined);
});

test('a thin waiter whose disk runs out with nothing left to free it exits 74', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const low = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ diskFree: 1024 ** 3, swapUsed: 0, memFree: 90, load: 0 }) } };
  const p = thin(t, home, ['run', 'deploy', '--disk', '2G', '--', 'true'], low);
  await inLine(home, p);
  unblock(home);
  assert.equal(await p.done, 74);
  assert.match(flat(p.err), /not enough free disk.*did NOT run \(exit 74\)/);
});

test('the owner stopping a thin waiter ends it with 143', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'true']);
  await inLine(home, p);
  const r = sync(home, ['stop', String(entry(home, p.pid).id)], PERSON);
  assert.equal(r.code, 0, r.err);
  assert.equal(await p.done, 143);
  assert.match(flat(p.err), /stopped by the owner/);
});

test('inside Claude Code, the run a thin waiter becomes is not taken for its own twin', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'echo', 'ran'], { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' } });
  await inLine(home, p);
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
});

test('a thin hold with nothing in its way reserves at once', async t => {
  const home = tmp(t);
  const p = thin(t, home, ['hold', 'deploy', '-m', 'mine'], { agent: 'me' });
  assert.equal(await p.done, 0, p.err);
  assert.match(flat(p.out), /Reserved for you until/);
  assert.ok(state(home).leases.some(l => l.kind === 'hold' && l.who === 'me'));
});

test('a thin hold waits, then reserves and returns', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['hold', 'deploy', '-m', 'mine'], { agent: 'me' });
  await inLine(home, p);
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(flat(p.out), /Reserved for you until/);
  assert.ok(state(home).leases.some(l => l.kind === 'hold' && l.who === 'me' && l.res.includes('deploy')));
});

test('a broker killed with waiters in line: one waiter starts another, and every place holds', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  // Every node a waiter's shell starts, logged, to count restarts.
  const shim = tmp(t, 'shim');
  const log = path.join(shim, 'log');
  fs.writeFileSync(path.join(shim, 'node'), `#!/bin/sh\necho "$*" >>"${log}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const opts = { env: { PATH: `${shim}:${process.env.PATH}` } };
  block(home);
  const ps = [];
  for (let i = 0; i < 6; i++) ps.push(thin(t, home, ['run', 'deploy', '--', 'true'], { ...opts, agent: `w${i}` }));
  await until(() => ps.every(p => waitingThin(home, p)));
  // Wait until the broker has every FIFO open, so each shell sees it die.
  await new Promise(r => setTimeout(r, 2000));
  const old = state(home).broker.pid;
  process.kill(old, 'SIGKILL');
  await until(() => { const b = state(home).broker; return b && b.pid !== old && alive(b.pid); });
  const rewaits = fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes('_rewait')).length;
  assert.equal(rewaits, 1, 'one Node start for the restart, not one per waiter');
  assert.equal(events(home).filter(e => e.kind === 'thin' && e.why === 'broker gone, starting another').length, 1, 'one event for the restart');
  unblock(home);
  for (const p of ps) assert.equal(await p.done, 0, p.err);
});

// #17303 on 2026-11-01 waited 10h22m behind four broker restarts, and its start event
// named 64 minutes of it: each new broker began the count again.
test('every second a thin waiter waited is named in its start event, across a broker restart and a stretch nobody decided for it', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'true']);
  await inLine(home, p);
  await settled(p);
  await new Promise(r => setTimeout(r, 2000));
  const old = state(home).broker.pid;
  process.kill(old, 'SIGKILL');
  await until(() => { const b = state(home).broker; return b && b.pid !== old && alive(b.pid); });
  await until(() => entry(home, p.pid)?.heldRule === 'slot');
  // As if it joined 16 minutes ago and nobody had looked for the last 8, under the state lock
  // (ten without a look and the place leaves the line, src/state.mjs GHOST_AFTER).
  const lock = path.join(home, 'lock');
  await until(() => { try { fs.mkdirSync(lock); return true; } catch { return false; } });
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const s = state(home), q = s.queue.find(x => x.pid === p.pid), back = 16 * 6e4;
  for (const k of ['enq', 'heldAt']) q[k] -= back;
  q.polledAt = Date.now() - back / 2;
  fs.writeFileSync(path.join(home, 'state.json.t'), JSON.stringify(s));
  fs.renameSync(path.join(home, 'state.json.t'), path.join(home, 'state.json'));
  fs.rmSync(lock, { recursive: true });
  await until(() => entry(home, p.pid)?.held?.unpolled > 0);
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  const start = events(home).find(e => e.kind === 'start' && e.res.includes('deploy') && e.who !== 'other');
  const named = Object.values(start.held).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(named - start.ms) < 50, `held ${JSON.stringify(start.held)} adds to ${named}, waited ${start.ms}`);
  assert.ok(start.held.slot > back / 2, `the slot held it through the restart: ${JSON.stringify(start.held)}`);
  assert.ok(Math.abs(start.held.unpolled - back / 2) < 5e3, `nobody looked for 8 minutes: ${JSON.stringify(start.held)}`);
});

test('with the broker unable to start, a thin waiter waits in Node within seconds', async t => {
  const home = tmp(t);
  block(home);
  // A folder where the control FIFO goes: every broker dies at start.
  fs.mkdirSync(path.join(home, 'ctl'));
  fs.writeFileSync(path.join(home, 'ctl', 'x'), '');
  const t0 = Date.now();
  const p = thin(t, home, ['run', 'deploy', '--', 'echo', 'ran']);
  // Waiting in Node now: the same place, its own pid no longer a shell's FIFO.
  // (Its first look is Node too, as the shell itself, before it tries the broker: the fallback is after that.)
  const inNode = () => { const q = state(home).queue.find(x => x.pid === p.pid); return q && !q.wake && asNode(p.pid); };
  const gaveUp = () => events(home).some(e => e.kind === 'thin' && /no broker could be started: waiting in Node/.test(e.why));
  await until(() => gaveUp() && inNode(), 30e3);
  assert.ok(Date.now() - t0 < 20e3, `fell back after ${Date.now() - t0} ms`);
  assert.equal(state(home).queue.filter(q => q.who === 'tester').length, 1, 'one place, picked up again');
  assert.ok(events(home).some(e => e.kind === 'thin' && e.why === "the broker didn't start"));
  assert.ok(events(home).some(e => e.kind === 'thin' && /no broker could be started: waiting in Node/.test(e.why) && e.who === 'tester'));
  // The next waiter doesn't try again: it goes to Node at once.
  const t1 = Date.now();
  const q2 = thin(t, home, ['run', 'deploy', '--', 'true'], { agent: 'second' });
  await until(() => { const q = entry(home, q2.pid); return q && !q.wake && asNode(q2.pid); }, 30e3);
  assert.ok(Date.now() - t1 < 10e3, `second fell back after ${Date.now() - t1} ms`);
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
  assert.equal(await q2.done, 0, q2.err);
});

test('a broker that dies and cannot be restarted: its waiters move to Node within seconds', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'echo', 'ran']);
  await inLine(home, p);
  await new Promise(r => setTimeout(r, 2000));   // a tick or so, so the broker has the FIFO open
  // From now on every broker dies at start.
  fs.rmSync(path.join(home, 'ctl'));
  fs.mkdirSync(path.join(home, 'ctl'));
  fs.writeFileSync(path.join(home, 'ctl', 'x'), '');
  const t0 = Date.now();
  process.kill(state(home).broker.pid, 'SIGKILL');
  await until(() => { const q = state(home).queue.find(x => x.pid === p.pid); return q && !q.wake && asNode(p.pid); }, 30e3);
  assert.ok(Date.now() - t0 < 20e3, `fell back after ${Date.now() - t0} ms`);
  assert.ok(events(home).some(e => e.kind === 'thin' && /waiting in Node$/.test(e.why) && e.shell === p.pid), 'the fallback is on record');
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
});

test('a stuck broker is replaced by the throttle watcher, and its waiters go on', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'echo', 'ran']);
  await inLine(home, p);
  await settled(p);
  // Stuck: alive, holding the FIFO, and not beating for over 30 s.
  const old = state(home).broker.pid;
  process.kill(old, 'SIGSTOP');
  t.after(() => { try { process.kill(old, 'SIGKILL'); } catch {} });
  const file = path.join(home, 'state.json');
  const s = state(home);
  s.broker.beat = Date.now() - 60e3;
  fs.writeFileSync(file, JSON.stringify(s));
  const watcher = spawn(process.execPath, [BIN, 'throttle', '--watch'], { env: env(home), stdio: 'ignore' });
  track(t, watcher);
  // Within a pass or two: stopped while holding the state lock, it holds others up until the lock is taken over.
  await until(() => { const b = state(home).broker; return b && b.pid !== old && alive(b.pid); }, 60e3).catch(e => {
    const read = f => (fs.existsSync(path.join(home, f)) ? fs.readFileSync(path.join(home, f), 'utf8').slice(-2000) : '(none)');
    throw new Error(`${e.message}\nbroker: ${JSON.stringify(state(home).broker)} old ${old} alive ${alive(old)}\ncool.log: ${read('cool.log')}\nbroker.log: ${read('broker.log')}\nbroker.broken: ${read('broker.broken')}`
      + `\nlock: ${fs.existsSync(path.join(home, 'lock'))}\nthin events: ${JSON.stringify(events(home).filter(x => x.kind === 'thin'))}`);
  });
  assert.ok(!alive(old), 'the stuck one is gone');
  // The watcher logs it once the new broker is up, a moment after.
  const cool = path.join(home, 'cool.log');
  await until(() => fs.existsSync(cool) && fs.readFileSync(cool, 'utf8').includes(`broker ${old} stuck`)).catch(e => {
    throw new Error(`${e.message}\nwatcher alive ${alive(watcher.pid)}\ncool.log: ${fs.existsSync(cool) ? fs.readFileSync(cool, 'utf8').slice(-1500) : '(none)'}`
      + `\nthin events: ${JSON.stringify(events(home).filter(x => x.kind === 'thin'))}\nbroker: ${JSON.stringify(state(home).broker)}`);
  });
  assert.ok(events(home).some(e => e.kind === 'thin' && e.why === 'stuck broker replaced' && e.pid === old));
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
});

// 2026-11-01, load 70: the waiter that started the broker gave up on it after 10 s and marked it
// broken. For a minute every waiter then waited in Node, and the throttle watcher left a stuck broker be.
test('a broker slow to start isn\'t taken for broken: the next waiter waits through it', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  // Given 1 ms to open its FIFO, every broker is slow.
  const first = thin(t, home, ['run', 'deploy', '--', 'true'], { env: { DIBS_BROKER_START_WAIT: '1' } });
  // Its first look is Node too, as the shell itself: wait for the word on the broker, not for Node.
  await until(() => events(home).some(e => e.kind === 'thin' && /start/.test(e.why)), 60e3);
  assert.ok(events(home).some(e => e.kind === 'thin' && /slow to start/.test(e.why)), JSON.stringify(events(home).filter(e => e.kind === 'thin')));
  assert.ok(!fs.existsSync(path.join(home, 'broker.broken')), 'not marked broken');
  const second = thin(t, home, ['run', 'deploy', '--', 'true'], { agent: 'second' });
  await inLine(home, second);
  unblock(home);
  assert.equal(await first.done, 0, first.err);
  assert.equal(await second.done, 0, second.err);
});

test('a stuck broker is replaced within a minute of one that couldn\'t start', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'echo', 'ran']);
  await inLine(home, p);
  await settled(p);
  const old = state(home).broker.pid;
  process.kill(old, 'SIGSTOP');
  t.after(() => { try { process.kill(old, 'SIGKILL'); } catch {} });
  const file = path.join(home, 'state.json');
  const s = state(home);
  s.broker.beat = Date.now() - 60e3;
  fs.writeFileSync(file, JSON.stringify(s));
  fs.writeFileSync(path.join(home, 'broker.broken'), 'a start that failed a moment ago\n');
  const watcher = spawn(process.execPath, [BIN, 'throttle', '--watch'], { env: env(home), stdio: 'ignore' });
  track(t, watcher);
  await until(() => !alive(old), 30e3);
  // Its shell sees it gone, finds no broker can be started, and waits in Node.
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
});

// Under load the broker spends longer inside the state lock, so it's more often stopped there.
// The watcher's start used to take the lock first and wait out the 30 s takeover from a live
// holder before it ever looked at the broker (failed at load 25, 2026-11-02).
test('a broker stuck while holding the state lock is replaced in seconds, not after the lock\'s 30 s takeover', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'echo', 'ran']);
  await inLine(home, p);
  await settled(p);
  const old = state(home).broker.pid;
  process.kill(old, 'SIGSTOP');
  t.after(() => { try { process.kill(old, 'SIGKILL'); } catch {} });
  const file = path.join(home, 'state.json');
  const s = state(home);
  s.broker.beat = Date.now() - 60e3;
  fs.writeFileSync(file, JSON.stringify(s));
  // Stopped mid-change: the state lock is its, and it's alive.
  fs.mkdirSync(path.join(home, 'lock'));
  fs.writeFileSync(path.join(home, 'lock', 'pid'), String(old));
  const t0 = Date.now();
  const watcher = spawn(process.execPath, [BIN, 'throttle', '--watch'], { env: env(home), stdio: 'ignore' });
  track(t, watcher);
  await until(() => !alive(old), 20e3);
  assert.ok(Date.now() - t0 < 15e3, `replaced after ${Date.now() - t0} ms`);
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
});

test('the broker exits once nobody waits', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const opts = { env: { DIBS_BROKER_IDLE: '1000' } };
  const p = thin(t, home, ['run', 'deploy', '--', 'true'], opts);
  await inLine(home, p);
  const b = state(home).broker.pid;
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  await until(() => !alive(b) && !state(home).broker, 15e3);
  assert.ok(!fs.existsSync(path.join(home, 'broker.pid')));
});

test('run --lease refuses a lease that is not this process\'s', async t => {
  const home = tmp(t);
  const r = sync(home, ['run', '--lease', '999', 'deploy', '--', 'true']);
  assert.equal(r.code, 75);
  assert.match(flat(r.err), /did NOT run/);
});

test('waiters in other states don\'t wake a broker: nothing is started for an in-process wait', async t => {
  const home = tmp(t);
  block(home);
  const fat = spawn(process.execPath, [BIN, 'run', 'deploy', '--', 'true'], { env: env(home), stdio: 'ignore' });
  track(t, fat);
  await until(() => entry(home, fat.pid));
  await new Promise(r => setTimeout(r, 1500));   // a poll or so: long enough for a broker to have been started, if anything would
  assert.equal(state(home).broker, undefined);
  assert.ok(!fs.existsSync(path.join(home, 'broker.pid')));
  unblock(home);
  assert.equal(await fat.done, 0);
});

test('nothing is left behind: execFileSync of the thin shell with a bad flag exits 2 and removes its FIFO', t => {
  const home = tmp(t);
  let code = 0;
  try { execFileSync('/bin/sh', [THIN, BIN, 'run', 'deploy', '--bogus', '--', 'true'], { env: env(home), stdio: 'ignore' }); } catch (e) { code = e.status; }
  assert.equal(code, 2);
  const w = path.join(home, 'w');
  assert.deepEqual(fs.existsSync(w) ? fs.readdirSync(w) : [], []);
});

// bin/dibs.mjs as agents run it: an executable, often through a link.
function dibs(t, home, args, opts = {}) {
  const p = spawn(opts.bin || BIN, args, { env: env(home, opts), stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  return track(t, p);
}
const thinOn = home => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ waits: 'thin' }));

test('with "waits": "thin", dibs run waits as a shell, through a link too', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  thinOn(home);
  block(home);
  const link = path.join(tmp(t, 'bin'), 'dibs');
  fs.symlinkSync(BIN, link);
  const p = dibs(t, home, ['run', 'deploy', '--', 'echo', 'ran'], { bin: link });
  await inLine(home, p);
  unblock(home);
  assert.equal(await p.done, 0, p.err);
  assert.match(p.out, /ran/);
});

test('waits are thin by default; "fat", "node", DIBS_THIN=0 and node bin/dibs.mjs wait in Node', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const node = p => { const q = entry(home, p.pid); return q && !q.wake && asNode(p.pid); };
  const byDefault = dibs(t, home, ['run', 'deploy', '--', 'true'], { agent: 'a' });
  await inLine(home, byDefault);
  const off = dibs(t, home, ['run', 'deploy', '--', 'true'], { agent: 'b', env: { DIBS_THIN: '0' } });
  await until(() => node(off));
  const direct = spawn(process.execPath, [BIN, 'run', 'deploy', '--', 'true'], { env: env(home, { agent: 'c' }), stdio: 'ignore' });
  track(t, direct);
  await until(() => node(direct));
  const ps = [byDefault, off, direct];
  for (const word of ['fat', 'node']) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ waits: word }));
    const p = dibs(t, home, ['run', 'deploy', '--', 'true'], { agent: word });
    await until(() => node(p));
    ps.push(p);
  }
  unblock(home);
  for (const p of ps) assert.equal(await p.done, 0);
});

test('through the thin entry, exit codes are the ones agents know', async t => {
  const home = tmp(t);
  thinOn(home);
  assert.equal((await dibs(t, home, ['run', 'deploy', '--bogus', '--', 'true']).done), 2);
  assert.equal((await dibs(t, home, ['run', 'deploy', '--', 'no-such-program-here']).done), 127);
  assert.equal((await dibs(t, home, ['run', 'deploy', '--', 'sh', '-c', 'exit 3']).done), 3);
  block(home);
  assert.equal((await dibs(t, home, ['run', 'deploy', '--no-wait', '--', 'true']).done), 75);
  const v = spawnSync(BIN, ['--version'], { env: env(home), encoding: 'utf8' });
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test('a bad "waits" in config.json is named', t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ waits: 'fast' }));
  const r = sync(home, ['status']);
  assert.equal(r.code, 2);
  assert.match(r.err, /waits in .* is "thin" or "fat"/);
});

test("thin waiters and the broker count as dibs's own memory", async t => {
  const M = 2 ** 20;
  assert.equal(dibsMem([
    { args: '/bin/sh /Users/x/dibs/bin/../src/thin.sh /Users/x/dibs/bin/dibs.mjs run test -- npm test', rss: 2 * M },
    { args: '/opt/homebrew/bin/node --max-semi-space-size=1 --lite-mode /Users/x/dibs/bin/dibs.mjs _broker', rss: 50 * M },
    { args: '/bin/sh ./scripts/thin.sh.bak', rss: 7 * M },
    { args: 'sh -c npm test', rss: 9 * M },
  ]), 52 * M);
  // And live: a waiting shell is in the count as the process table shows it.
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'true']);
  await inLine(home, p);
  const mine = processes().filter(x => x.pid === p.pid || x.pid === state(home).broker.pid);
  assert.equal(mine.length, 2);
  assert.equal(dibsMem(mine), mine.reduce((a, x) => a + x.rss, 0));
  assert.ok(dibsMem(mine) > 0);
});

test('waiters joining while a broker runs all get in line: its first words never come before their answer', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const first = thin(t, home, ['run', 'deploy', '--', 'true'], { agent: 'w0' });
  await inLine(home, first);
  // Each of these kicks a running broker, which writes to the new FIFO at once.
  const ps = [];
  for (let i = 1; i <= 8; i++) ps.push(thin(t, home, ['run', 'deploy', '--', 'true'], { agent: `w${i}` }));
  for (const p of ps) await inLine(home, p);
  unblock(home);
  for (const p of [first, ...ps]) assert.equal(await p.done, 0, p.err);
});

test('a bad answer from getting in line ends the wait with 70 and leaves a thin event', async t => {
  const home = tmp(t);
  // A node that answers nonsense down the FIFO in place of _enqueue, then exits 0.
  // Only the shell's own call, once it waits (its FIFO made): the first look is the shell itself as Node.
  const shim = tmp(t, 'shim');
  fs.writeFileSync(path.join(shim, 'node'), `#!/bin/sh\n[ "$3" = _enqueue ] && [ -p "$6" ] && { echo nonsense >"$6"; exit 0; }\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  block(home);
  const p = thin(t, home, ['run', 'deploy', '--', 'true'], { env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(await p.done, 70);
  assert.ok(events(home).some(e => e.kind === 'thin' && e.why === 'no answer from getting in line' && e.shell === p.pid));
});

test('a thin waiter killed while it moves to Node leaves no place behind', async t => {
  const home = tmp(t);
  block(home);
  // Every broker dies at start, so the waiter moves to Node...
  fs.mkdirSync(path.join(home, 'ctl'));
  fs.writeFileSync(path.join(home, 'ctl', 'x'), '');
  // ...and its Node is slow to start, which holds it in the window where its place is kept for it.
  const shim = tmp(t, 'shim');
  fs.writeFileSync(path.join(shim, 'node'), `#!/bin/sh\n[ "$3" = run ] && exec sleep 30\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const p = thin(t, home, ['run', 'deploy', '--', 'true'], { env: { PATH: `${shim}:${process.env.PATH}` } });
  // Its place, kept with nobody waiting on it while its Node starts.
  await until(() => state(home).queue.some(q => q.who === 'tester' && q.pid === null) && /^\S*sleep\b/.test(comm(p.pid)));
  const id = state(home).queue.find(q => q.who === 'tester').id;
  p.kill('SIGTERM');
  await p.done;
  board(home);
  const left = state(home).queue.find(q => q.id === id);
  assert.ok(!left, `a kept place outlived its waiter: ${JSON.stringify(left)}`);
  assert.ok(events(home).some(e => e.kind === 'left' && e.id === id && e.why === 'gone'));
});

test('--notify from a thin wait: one line however the wait ends', async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  const file = path.join(tmp(t, 'notify'), 'n.jsonl');
  const lines = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  // Timed out in line: written by the broker.
  const late = thin(t, home, ['run', 'deploy', '--max-wait', '2s', '--notify', file, '--', 'true'], { agent: 'late' });
  assert.equal(await late.done, 75);
  // Interrupted in line: written by _leave.
  const cut = thin(t, home, ['run', 'deploy', '--notify', file, '--', 'true'], { agent: 'cut' });
  await inLine(home, cut);
  cut.kill('SIGTERM');
  assert.equal(await cut.done, 143);
  // Its turn: written by the run it became.
  const ran = thin(t, home, ['run', 'deploy', '--notify', file, '--', 'true'], { agent: 'ran' });
  await inLine(home, ran);
  unblock(home);
  assert.equal(await ran.done, 0);
  const got = lines();
  assert.deepEqual(got.map(l => [l.code, l.started, l.pid]), [[75, false, late.pid], [143, false, cut.pid], [0, true, ran.pid]]);
  assert.ok(got.every(l => l.cmd === 'true' && l.res.includes('deploy')));
});

test("a job sent from another machine stops waiting when the worker that started it is gone", async t => {
  const home = tmp(t);
  stopBroker(t, home);
  block(home);
  // A stand-in for the worker: the waiter's parent, with DIBS_REMOTE_JOB set as the worker sets it.
  const marker = path.join(tmp(t, 'w'), 'pid');
  const worker = spawn('/bin/sh', ['-c', `/bin/sh "$0" "$1" run deploy -- true & echo $! > "${marker}"; wait`, THIN, BIN],
    { env: env(home, { env: { DIBS_REMOTE_JOB: '7' } }), stdio: 'ignore' });
  track(t, worker);
  await until(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim());
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  await until(() => entry(home, pid)?.wake);
  const id = entry(home, pid).id;
  // The broker a remote job's waiter started serves everyone: it doesn't end with that waiter's
  // short-lived starter. It did on 0.0.113, 2 s in (bin/dibs.mjs followParent), and the waiter fell back to Node.
  await until(() => state(home).broker);
  const broker = state(home).broker.pid;
  await new Promise(r => setTimeout(r, 3000));   // past followParent's 2 s check: there's no event to wait for
  assert.ok(alive(broker), 'the broker is still up');
  worker.kill('SIGKILL');
  await until(() => !state(home).queue.some(q => q.id === id), 30e3).catch(e => {
    const q = state(home).queue.find(x => x.id === id);
    throw new Error(`${e.message}\nentry: ${JSON.stringify({ pid: q?.pid, follow: q?.wake?.follow })}\nshell: ${spawnSync('ps', ['-o', 'pid=,ppid=,lstart=,args=', '-p', String(pid)], { encoding: 'utf8' }).stdout}`
      + `\nworker: ${spawnSync('ps', ['-o', 'pid=,stat=,lstart=', '-p', String(worker.pid)], { encoding: 'utf8' }).stdout}\nbroker: ${JSON.stringify(state(home).broker)}`
      + `\nbroker.log: ${fs.existsSync(path.join(home, 'broker.log')) ? fs.readFileSync(path.join(home, 'broker.log'), 'utf8').slice(-3000) : '(none)'}\nthin events: ${JSON.stringify(events(home).filter(e => e.kind === 'thin' || e.id === id))}`);
  });
  await until(() => !alive(pid));
  assert.ok(events(home).some(e => e.kind === 'left' && e.id === id && e.why === 'worker gone'));
});

// 2026-10-20: waiters started before 0.0.134 kept judging memory by the old rules for hours after every fix went out.
test('a waiter in Node carries on as the new dibs after a release, in the same place', { skip: process.platform === 'win32' }, async t => {
  const copy = tmp(t, 'dibs-copy');
  for (const d of ['bin', 'src', 'test']) fs.cpSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', d), path.join(copy, d), { recursive: true });
  const bin = path.join(copy, 'bin', 'dibs.mjs');
  const h = tmp(t), cwd = tmp(t, 'job');
  const run = (agent, args, extra = {}) => {
    const p = track(t, spawn(process.execPath, [bin, ...args], { env: { ...env(h, { agent }), ...extra }, cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    p.err = ''; p.stderr.on('data', d => (p.err += d));
    return p;
  };
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources: { one: { slots: 1 } } }));
  const first = run('a', ['run', 'one', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done']);
  await until(() => board(h).held.length === 1 || first.exitCode != null).catch(() => {});
  assert.equal(first.exitCode, null, first.err);
  await until(() => board(h).held.length === 1);
  const second = run('b', ['run', 'one', '--', 'true'], { DIBS_THIN: '0' });
  await until(() => board(h).waiting.length === 1);
  const id = board(h).waiting[0].id ?? JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).queue[0].id;
  const v = path.join(copy, 'src', 'version.mjs');
  fs.writeFileSync(v, fs.readFileSync(v, 'utf8').replace(/'(\d+\.\d+\.)(\d+)'/, (m, a, b) => `'${a}${Number(b) + 1}'`));
  await until(() => /dibs was updated while this waited, so it carries on as the new dibs, in the same place/.test(second.err));
  await until(() => JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).queue.some(q => q.id === id && q.pid));
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await first.done, 0);
  assert.equal(await second.done, 0, second.err);
});
