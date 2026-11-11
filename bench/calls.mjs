#!/usr/bin/env node
// How long a dibs call takes end to end on an idle resource: `dibs run test --
// true` and the board, in a temp DIBS_HOME so nothing waits on the live queue,
// with the real machine readings. Light: one call at a time.
//
//   node bench/calls.mjs [--bin path/to/bin/dibs.mjs] [--n 10]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BIN = path.resolve(arg('bin', path.join(HERE, '..', 'bin', 'dibs.mjs')));
const N = Number(arg('n', 10));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-callbench-'));
const env = { ...process.env, DIBS_HOME: home, DIBS_NO_REMOTE: '1' };

function time(args) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`dibs ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return Number(process.hrtime.bigint() - t) / 1e6;
}
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const runs = { 'node -e 0': [], 'run test -- true': [], 'board': [] };
console.log(`dibs ${BIN}\nload ${os.loadavg().map(x => x.toFixed(1)).join(' ')}`);
for (let i = 0; i < N; i++) {
  const t = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '0']);
  runs['node -e 0'].push(Number(process.hrtime.bigint() - t) / 1e6);
  runs['run test -- true'].push(time(['run', 'test', '-m', 'bench', '--', 'true']));
  runs.board.push(time([]));
}
for (const [k, xs] of Object.entries(runs)) console.log(`${k.padEnd(18)} p50 ${pct(xs, 0.5).toFixed(0).padStart(6)} ms   p95 ${pct(xs, 0.95).toFixed(0).padStart(6)} ms`);
fs.rmSync(home, { recursive: true, force: true });
