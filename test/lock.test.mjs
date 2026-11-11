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
import { BIN, tmp, env, track, until, bg, alive } from './helpers.mjs';

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

test('a holder stopped mid-change: the others go on within seconds, and once resumed its change is made again on top of theirs, not written over them', { timeout: 110e3 }, async t => {
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

test('a live holder that is slow is waited for, however old its lock, and never taken over or called stuck', { timeout: 60e3 }, async t => {
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
  assert.doesNotMatch(w.err, /stuck/);
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
