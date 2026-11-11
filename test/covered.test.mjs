// A session's hold covers its own runs, one at a time per resource: slots stay a hard limit
// however many of the session's subagents submit at once under it.
// 2026-11-10 23:44: a session holding playwright (slots: 2) had four of its subagents' runs start
// in the same second, all covered by the one hold and charged no memory; the Mac froze.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BIN, tmp, env, track } from './helpers.mjs';

// A process named claude, so dibs takes it for an agent session and its children for that
// session's subagents (src/proc.mjs walks up to it): node itself, under that name.
function fakeSession(t, home, script) {
  const dir = tmp(t, 'agent');
  const claude = path.join(dir, 'claude');
  fs.symlinkSync(process.execPath, claude);
  const e = env(home, { agent: 'atlas' });
  delete e.DIBS_NO_SESSION;
  const p = spawn(claude, ['--input-type=module', '-e', script], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  return track(t, p);
}

// The most runs going at once, from their start and end lines in order.
function most(log) {
  let n = 0, top = 0;
  for (const l of fs.readFileSync(log, 'utf8').split('\n')) { if (l === 'start') top = Math.max(top, ++n); if (l === 'end') n--; }
  return top;
}

test('five runs from one session submitted at once under its own hold: never more running than the slots', { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 110e3 }, async t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ resources: { pw: { slots: 2, mem: '100M', cpu: 1 } } }));
  const log = path.join(home, 'runs.log');
  const job = `echo start >> ${log}; sleep 2; echo end >> ${log}`;
  const script = `
import { spawn, spawnSync } from 'node:child_process';
const dibs = args => spawn(process.execPath, [${JSON.stringify(BIN)}, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
const hold = spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'hold', 'pw', '--for', '5m', '-m', 'suite'], { encoding: 'utf8' });
if (hold.status !== 0) { console.error('hold: ' + hold.stderr); process.exit(9); }
const runs = Array.from({ length: 5 }, () => dibs(['run', 'pw', '--', 'sh', '-c', ${JSON.stringify(job)}]));
const codes = await Promise.all(runs.map(p => new Promise(r => { let err = ''; p.stderr.on('data', d => (err += d)); p.on('exit', c => r([c, err])); })));
spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'release', 'pw']);
console.log(JSON.stringify(codes));`;
  const p = fakeSession(t, home, script);
  assert.equal(await p.done, 0, p.err);
  const codes = JSON.parse(p.out);
  for (const [c, err] of codes) assert.equal(c, 0, err);
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(l => l === 'end').length, 5, 'all five ran');
  assert.ok(most(log) <= 2, `${most(log)} runs at once on 2 slots`);
});
