// The state lock under real contention: many dibs processes changing state.json at once, a
// holder killed with -9 mid-change, a holder stopped mid-change, and a live holder that's just
// slow. No change is lost, nothing crashes, and nobody is told the lock is stuck.
// Between 2026-11-04 and 11-11, two writers holding the lock at once crashed dibs 7 times (exit 70:
// ENOENT renaming the one shared state.json.tmp, ENOTEMPTY releasing a lock someone else had made).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BIN, tmp, env, track, until, bg, alive, posixOnly } from './helpers.mjs';

const STATE = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'state.mjs')).href;

// A dibs process making n changes, each adding one to its own count and the total.
// hang: the first change stops inside the lock, as a writer cut off mid-change would.
function writer(t, home, name, n, hang = false) {
  const js = `import { withState } from ${JSON.stringify(STATE)};
for (let i = 0; i < ${n}; i++) withState(s => {
  s.hammer = (s.hammer || 0) + 1;
  s.by = { ...s.by, [${JSON.stringify(name)}]: (s.by?.[${JSON.stringify(name)}] || 0) + 1 };
  if (${hang} && i === 0) { process.stdout.write('in\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600e3); }
});`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', js], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  return track(t, p);
}
const state = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')); } catch { return {}; } };
const leftovers = home => fs.readdirSync(home).filter(n => /^lock\.|\.tmp$/.test(n));

test('5 writers making 50 changes each, and a holder killed with -9 mid-change: every change lands, nothing crashes', { timeout: 110e3 }, async t => {
  const home = tmp(t);
  const victim = writer(t, home, 'victim', 1, true);
  await until(() => victim.out.includes('in'));
  const ws = Array.from({ length: 5 }, (_, i) => writer(t, home, `w${i}`, 50));
  // Everyone is now queued on the lock the victim holds, mid-change.
  process.kill(victim.pid, 'SIGKILL');
  const codes = await Promise.all(ws.map(w => w.done));
  for (const [i, w] of ws.entries()) {
    assert.equal(codes[i], 0, `w${i} exited ${codes[i]}: ${w.err}`);
    assert.equal(w.err, '', `w${i} said something`);
  }
  const s = state(home);
  assert.equal(s.hammer, 250, `changes landed: ${s.hammer} of 250`);
  for (let i = 0; i < 5; i++) assert.equal(s.by[`w${i}`], 50, `w${i}'s changes`);
  assert.equal(s.by.victim, undefined, 'the killed change was never written');
  assert.ok(!fs.existsSync(path.join(home, 'lock')), 'the lock was given back');
  assert.deepEqual(leftovers(home), [], 'nothing left beside it');
});

test('a holder stopped mid-change: the others go on within seconds, and once resumed its change is made again on top of theirs, not written over them', { timeout: 110e3, skip: posixOnly('Windows has no SIGSTOP') }, async t => {
  const home = tmp(t);
  // Stops itself inside its first change, then carries on when continued.
  const js = `import { withState } from ${JSON.stringify(STATE)};
let first = true;
withState(s => {
  s.hammer = (s.hammer || 0) + 1;
  s.by = { ...s.by, late: (s.by?.late || 0) + 1 };
  if (first) { first = false; process.stdout.write('in\\n'); process.kill(process.pid, 'SIGSTOP'); }
});`;
  const late = track(t, spawn(process.execPath, ['--input-type=module', '-e', js], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] }));
  late.out = ''; late.err = '';
  late.stdout.on('data', d => (late.out += d));
  late.stderr.on('data', d => (late.err += d));
  t.after(() => { try { process.kill(late.pid, 'SIGCONT'); } catch {} });
  await until(() => late.out.includes('in'));
  const t0 = Date.now();
  const ws = Array.from({ length: 3 }, (_, i) => writer(t, home, `w${i}`, 50));
  const codes = await Promise.all(ws.map(w => w.done));
  // Taken from a stopped owner after a ps check, not after the 30 s a lock used to be trusted for.
  assert.ok(Date.now() - t0 < 20e3, `the others took ${Date.now() - t0} ms behind a stopped holder`);
  for (const [i, w] of ws.entries()) assert.equal(codes[i], 0, `w${i}: ${w.err}`);
  assert.equal(state(home).hammer, 150);
  process.kill(late.pid, 'SIGCONT');
  assert.equal(await late.done, 0, late.err);
  assert.equal(late.err, '');
  const s = state(home);
  assert.equal(s.hammer, 151, 'its change landed once, on top of everyone else\'s');
  assert.equal(s.by.late, 1);
  assert.deepEqual(leftovers(home), []);
});

test('a live holder that is slow is waited for, however old its lock, and never taken over', { timeout: 60e3 }, async t => {
  const home = tmp(t);
  // A live process holding the lock the way an older dibs makes it, and holding it a minute already.
  const lock = path.join(home, 'lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const old = new Date(Date.now() - 60e3);
  fs.utimesSync(lock, old, old);
  const w = bg(t, home, ['t', '--', 'echo', 'ran'], { agent: 'b' });
  // Long enough for a ps check or two on the holder (src/lock.mjs ASK_AFTER is 2 s).
  await new Promise(r => setTimeout(r, 6000));
  assert.equal(w.exitCode, null, `it went ahead of a live holder: ${w.out}${w.err}`);
  assert.ok(fs.existsSync(path.join(lock, 'pid')), 'the live holder still has its lock');
  fs.rmSync(lock, { recursive: true });
  assert.equal(await w.done, 0, w.err);
  assert.equal(w.out, 'ran\n');
  assert.doesNotMatch(w.err, /state lock stuck|did not run/);
  assert.ok(alive(process.pid));
});

test('a crash is recorded with its error, its stack and the command', t => {
  const home = tmp(t);
  // A state file that's a folder: dibs can neither read it nor save a copy of it, a bug to hit on purpose.
  fs.mkdirSync(path.join(home, 'state.json'));
  const r = spawnSync(process.execPath, [BIN, 'why'], { env: env(home), encoding: 'utf8', timeout: 60e3 });
  assert.equal(r.status, 70, r.stderr);
  const crash = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(e => e.kind === 'crash');
  assert.ok(crash, 'a crash event');
  assert.equal(typeof crash.at, 'number');
  assert.match(crash.error, /^Error: E[A-Z]+: /);
  assert.match(crash.where, /^src\/state\.mjs:\d+$/);
  assert.match(crash.stack, /^at .*\n.*src\/state\.mjs:\d+/);
  assert.equal(crash.cmd, 'why');
});

// A live holder is waited for, but one that's hung would stop all of dibs without a word.
test('a holder that keeps the lock past a minute: waiters keep waiting, one alert names it, and the board says who dibs is stuck behind', { timeout: 110e3 }, async t => {
  const home = tmp(t);
  const hung = track(t, spawn('sleep', ['300'], { stdio: 'ignore' }));
  // Its lock, taken 61 s ago by a process that's alive and doing nothing.
  const lock = path.join(home, 'lock'), owner = path.join(lock, `owner.${hung.pid}.0.test`);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(hung.pid));
  fs.writeFileSync(owner, '');
  const then = new Date(Date.now() - 61e3);
  fs.utimesSync(owner, then, then);
  const a = bg(t, home, ['t', '--', 'echo', 'ran'], { agent: 'a' });
  const b = bg(t, home, ['t2', '--', 'echo', 'ran'], { agent: 'b' });
  const stuckEvents = () => (fs.existsSync(path.join(home, 'events.jsonl')) ? fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []).filter(e => e.kind === 'lockstuck');
  await until(() => stuckEvents().length > 0 && /dibs is stuck behind pid/.test(a.err + b.err));
  await new Promise(r => setTimeout(r, 1000));   // both waiters have looked again by now
  assert.equal(stuckEvents().length, 1, 'one record, not one per waiter');
  const e = stuckEvents()[0];
  assert.equal(e.pid, hung.pid);
  assert.match(e.cmd, /sleep 300/);
  assert.ok(e.held >= 60e3);
  assert.equal(a.exitCode, null, 'still waiting');
  assert.equal(b.exitCode, null, 'still waiting');
  // The board doesn't wait on the lock: it says who everyone is stuck behind, and what to do.
  const t0 = Date.now();
  const board = spawnSync(process.execPath, [BIN], { env: env(home, { agent: 'viewer' }), encoding: 'utf8', timeout: 60e3 });
  assert.ok(Date.now() - t0 < 20e3, `the board took ${Date.now() - t0} ms`);
  assert.match(board.stdout.replace(/\n +/g, ' '), new RegExp(`dibs is stuck behind pid ${hung.pid} \\(sleep 300\\).*kill ${hung.pid}`));
  // It lets go: everyone goes on, and the alert closes.
  hung.kill('SIGKILL');
  assert.equal(await a.done, 0, a.err);
  assert.equal(await b.done, 0, b.err);
  // Alerts are looked at again every 15 s at most; then it's shown resolved.
  await until(() => /Resolved at .*: dibs is stuck behind pid/.test(spawnSync(process.execPath, [BIN], { env: env(home, { agent: 'viewer' }), encoding: 'utf8', timeout: 60e3 }).stdout), 40e3);
});

// 2026-11-10 23:13: the worker and throttle services exited 75 and launchd restarted them, and
// nothing said where they had given up.
test('a long-running dibs that gives up (exit 75) records where, with its command', { timeout: 60e3 }, async t => {
  const home = tmp(t);
  // The message lock held by a live process that never lets go: dibs listen gives up on it.
  const hung = track(t, spawn('sleep', ['300'], { stdio: 'ignore' }));
  const lock = path.join(home, 'messages.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(hung.pid));
  fs.writeFileSync(path.join(lock, `owner.${hung.pid}.0.test`), '');
  const l = bg(t, home, ['listen', '--for', '1m'], { agent: 'a' });
  assert.equal(await l.done, 75, l.err);
  const e = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x)).find(x => x.kind === 'gaveup');
  assert.ok(e, 'a gaveup event');
  assert.equal(e.verb, 'listen');
  assert.match(e.cmd, /^listen --for 1m/);
  assert.match(e.why, /messages\.lock/);
  assert.match(e.where, /^src\/talk\.mjs:\d+/);
});

// dibs with fs patched by a preload, to make a race happen on cue.
function patched(t, home, patch, args) {
  const pre = path.join(home, 'patch.mjs');
  fs.writeFileSync(pre, `import fs from 'node:fs';\nimport path from 'node:path';\nimport { spawn } from 'node:child_process';\nconst LOCK = ${JSON.stringify(path.join(home, 'lock'))};\n${patch}\n`);
  const p = spawn(process.execPath, ['--import', pathToFileURL(pre).href, BIN, ...args], { env: env(home, { agent: 'a' }), stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  return track(t, p);
}

test("an older dibs's lock taken over by an older waiter just before this one claims it: the live waiter keeps it", { timeout: 60e3 }, async t => {
  const home = tmp(t);
  // An older dibs's lock whose writer died.
  const lock = path.join(home, 'lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '999999');
  const log = path.join(home, 'took.json');
  // Just before this dibs claims it, an older waiter takes it over its own way (a new folder) and
  // writes its own pid: a process alive for 4 s.
  const p = patched(t, home, `
const rename = fs.renameSync;
let done = false;
fs.renameSync = (a, b) => {
  if (!done && a === path.join(LOCK, 'pid') && String(b).startsWith(path.join(LOCK, 'owner.'))) {
    done = true;
    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.mkdirSync(LOCK);
    const old = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' });
    old.unref();
    fs.writeFileSync(path.join(LOCK, 'pid'), String(old.pid));
    fs.writeFileSync(${JSON.stringify(log)}, String(Date.now()));
  }
  return rename(a, b);
};`, ['t', '--', 'echo', 'ran']);
  assert.equal(await p.done, 0, p.err);
  assert.equal(p.out, 'ran\n');
  const waited = Date.now() - Number(fs.readFileSync(log, 'utf8'));
  assert.ok(waited >= 3500, `it went ahead ${waited} ms after the older waiter took the lock, while that waiter lived`);
});

test("an older dibs's lock in the moment between its mkdir and its pid: never replaced under its writer", { timeout: 60e3 }, async t => {
  const home = tmp(t);
  const lock = path.join(home, 'lock');
  fs.mkdirSync(lock);   // made a moment ago, its pid not written yet
  const w = bg(t, home, ['t', '--', 'echo', 'ran'], { agent: 'b' });
  await new Promise(r => setTimeout(r, 1500));   // under the 3 s an older writer gets to write its pid
  assert.equal(w.exitCode, null, `it went ahead: ${w.out}${w.err}`);
  assert.deepEqual(fs.readdirSync(lock), [], 'the older writer\'s folder is still its own');
  // Its writer writes its pid, and holds the lock 3 s more.
  const old = track(t, spawn('sleep', ['3'], { stdio: 'ignore' }));
  fs.writeFileSync(path.join(lock, 'pid'), String(old.pid));
  const t0 = Date.now();
  assert.equal(await w.done, 0, w.err);
  assert.ok(Date.now() - t0 >= 2500, `it went ahead of the live older writer after ${Date.now() - t0} ms`);
});

test('a live owner whose recorded start is later than ps says it started is the same process, not a reused pid', { timeout: 60e3 }, async t => {
  const home = tmp(t);
  // Node's own start, which the owner name records, comes seconds after the exec ps reports when
  // the machine is short on memory: here, 20 s after.
  const live = track(t, spawn('sleep', ['5'], { stdio: 'ignore' }));
  const lock = path.join(home, 'lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(live.pid));
  fs.writeFileSync(path.join(lock, `owner.${live.pid}.${Date.now() + 20e3}.test`), '');
  const t0 = Date.now();
  const w = bg(t, home, ['t', '--', 'echo', 'ran'], { agent: 'b' });
  assert.equal(await w.done, 0, w.err);
  assert.ok(Date.now() - t0 >= 4000, `it took the lock from a live owner after ${Date.now() - t0} ms`);
});

test('a plain file where the lock goes: dibs gives up with 75 naming it, instead of spinning', { timeout: 60e3 }, t => {
  const home = tmp(t);
  const lock = path.join(home, 'lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 10e3);
  fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  // SIGKILL at the limit: a dibs spinning on the lock holds SIGTERM, and the old one spun for an hour here.
  const r = spawnSync(process.execPath, [BIN, 't', '--', 'echo', 'ran'], { env: env(home, { agent: 'a' }), encoding: 'utf8', timeout: 50e3, killSignal: 'SIGKILL' });
  assert.equal(r.status, 75, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr.replace(/\n +/g, ' '), new RegExp(`${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is in the way.*rm -rf`));
  assert.ok(Date.now() - t0 < 30e3, `took ${Date.now() - t0} ms`);
});
