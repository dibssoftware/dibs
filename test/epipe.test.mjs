// A caller that stops reading dibs's output mid-run (a `| head`, a tool call that gave up)
// is no crash: the job goes on and dibs exits with the job's own code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmp, env, BIN, posixOnly, wait } from './helpers.mjs';

test("a run whose output readers go away while it waits still runs, and exits with its command's code, not a crash", { skip: posixOnly('needs sh') }, async t => {
  const h = tmp(t);
  const e = { ...env(h), DIBS_THIN: '0' };
  // Something ahead holds t, so the second run waits and says so, then says it started.
  const first = spawn(process.execPath, [BIN, 'run', 't', '-m', 'ahead', '--', 'sleep', '2'], { env: e, stdio: 'ignore' });
  await wait(700);
  const p = spawn(process.execPath, [BIN, 'run', 't', '-m', 'epipe', '--', 'sh', '-c', 'exit 3'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise(r => { p.stderr.once('data', r); setTimeout(r, 1500); });
  p.stdout.destroy(); p.stderr.destroy();
  const code = await new Promise(r => p.on('exit', c => r(c)));
  await new Promise(r => (first.exitCode != null ? r() : first.on('exit', r)));
  assert.equal(code, 3);
});
