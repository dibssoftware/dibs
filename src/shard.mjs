// Splitting a big test suite across machines: N runs of the same command, each
// with its runner's own shard flag, the first here and the rest wherever they'd
// start soonest (--anywhere), their output prefixed and their exit codes merged.
// --shards N asks for it. dibs does it on its own for a vitest or node --test
// suite that usually takes over AUTO_OVER, with an on-demand machine to send to:
// those runners take no ports, so two shards on one machine can't collide. A
// Playwright suite only with --shards: its webServer may want a fixed port.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNALS, signalExit, say } from './util.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dibs.mjs');
export const AUTO_OVER = 5 * 6e4;
export const AUTO_SHARDS = 2;   // here and boat-1: a third would mean making a VM for it

// The command with its runner's shard flag for shard i of n, or null when the
// runner isn't one dibs knows how to split, or it's already split. which says
// whose flag: playwright, vitest or node.
export function sharder(cmd) {
  if (cmd.some(a => /^--(test-)?shard(=|$)/.test(a))) return null;
  const base = a => path.basename(a);
  const pw = cmd.findIndex((a, i) => base(a) === 'playwright' && cmd[i + 1] === 'test');
  if (pw >= 0) return { which: 'playwright', at: (i, n) => [...cmd.slice(0, pw + 2), `--shard=${i}/${n}`, ...cmd.slice(pw + 2)] };
  const vt = cmd.findIndex(a => base(a) === 'vitest');
  if (vt >= 0) {
    const after = cmd[vt + 1] === 'run' ? vt + 2 : vt + 1;
    return { which: 'vitest', at: (i, n) => [...cmd.slice(0, after), `--shard=${i}/${n}`, ...cmd.slice(after)] };
  }
  const nt = base(cmd[0]) === 'node' ? cmd.indexOf('--test') : -1;
  if (nt > 0) return { which: 'node', at: (i, n) => [...cmd.slice(0, nt + 1), `--test-shard=${i}/${n}`, ...cmd.slice(nt + 1)] };
  return null;
}

// Each shard is its own dibs run, so it waits its own turn and its own machine's
// rules apply. Exit: the first shard's non-zero code, else 0.
// to: the on-demand machine to wake for the rest, or null for --anywhere (which never
// wakes a sleeping one, so the pieces would all land here).
export function runShards(o, n, split, to = null) {
  say(`splitting this ${split.which} run into ${n} shards: the first here, the rest ${to ? `on ${to}` : "wherever they'd start soonest"}.`);
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const args = ['run', o.res.join(','), '--no-shard', '-m', `${o.purpose || 'shard'} (shard ${i}/${n})`, ...(i > 1 ? (to ? ['--on', to] : ['--anywhere']) : []),
      ...(o.maxWait === Infinity ? ['--wait'] : []), '--', ...split.at(i, n)];
    const p = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DIBS_SHARD: `${i}/${n}` } });
    for (const [from, to] of [[p.stdout, process.stdout], [p.stderr, process.stderr]]) {
      let rest = '';
      from.on('data', d => { const lines = (rest + d).split('\n'); rest = lines.pop(); for (const l of lines) to.write(`[${i}/${n}] ${l}\n`); });
      from.on('end', () => { if (rest) to.write(`[${i}/${n}] ${rest}\n`); });
    }
    kids.push(new Promise(r => p.on('exit', (code, sig) => r(code ?? signalExit(sig)))));
    for (const sig of SIGNALS) process.on(sig, () => p.kill(sig));
  }
  return Promise.all(kids).then(codes => {
    const bad = codes.find(c => c !== 0) ?? 0;
    say(`all ${n} shards done: ${codes.map((c, i) => `${i + 1}/${n} exit ${c}`).join(', ')}.`);
    process.exit(bad);
  });
}
