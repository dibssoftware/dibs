#!/usr/bin/env node
// How long the guard hook takes per tool call, the way Claude Code runs it: a
// fresh node process per event, JSON on stdin. Light enough to run on a busy
// Mac (one hook at a time, nothing in parallel).
//
//   node bench/hook.mjs [--bin path/to/dibs-guard.mjs] [--n 40] [--live]
//
// It copies the files the hook reads (config, state, inbox, messages,
// listeners) from ~/.dibs into a temp DIBS_HOME, so the sizes are real and the
// live state is never written. --live reads ~/.dibs itself (read-only events
// only: Bash and Edit). Prints p50/p95 per event, and plain `node -e 0` for scale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BIN = path.resolve(arg('bin', path.join(HERE, '..', 'bin', 'dibs-guard.mjs')));
const N = Number(arg('n', 40));
const LIVE = process.argv.includes('--live');
const SRC = path.join(os.homedir(), '.dibs');
const COPY = ['config.json', 'state.json', 'inbox.json', 'messages.json', 'listeners.json', 'listen-reminded.json'];

const home = LIVE ? SRC : fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-hookbench-'));
if (!LIVE) for (const f of COPY) try { fs.copyFileSync(path.join(SRC, f), path.join(home, f)); } catch {}

const session = 'bench-0000-0000-0000-000000000000';
const base = { session_id: session, cwd: process.cwd(), permission_mode: 'bypassPermissions', transcript_path: '/dev/null' };
const EVENTS = {
  'Bash (plain)': { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la src' } },
  'Bash (heavy)': { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } },
  'Edit': { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(process.cwd(), 'x.txt'), old_string: 'a', new_string: 'b' } },
  ...(LIVE ? {} : {
    'Stop': { ...base, hook_event_name: 'Stop', stop_hook_active: false },
    'SubagentStop': { ...base, hook_event_name: 'SubagentStop', agent_id: 'bench-agent' },
  }),
};

const env = { ...process.env, DIBS_HOME: home };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT']) delete env[k];

function time(argv, input) {
  const t = process.hrtime.bigint();
  const r = spawnSync(argv[0], argv.slice(1), { input, env, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${argv.join(' ')} exited ${r.status}: ${r.stderr}`);
  return ms;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const row = (name, xs) => console.log(`${name.padEnd(16)} p50 ${pct(xs, 0.5).toFixed(1).padStart(6)} ms   p95 ${pct(xs, 0.95).toFixed(1).padStart(6)} ms   (n=${xs.length})`);

console.log(`hook ${BIN}\nload ${os.loadavg().map(x => x.toFixed(1)).join(' ')}`);
// Interleave the events so a busy moment on the machine hits all of them alike.
const runs = { 'node -e 0': [] };
for (const k of Object.keys(EVENTS)) runs[k] = [];
for (let i = 0; i < N; i++) {
  runs['node -e 0'].push(time([process.execPath, '-e', '0'], ''));
  for (const [k, input] of Object.entries(EVENTS)) runs[k].push(time([process.execPath, BIN], JSON.stringify(input)));
}
for (const [k, xs] of Object.entries(runs)) row(k, xs);
if (!LIVE) fs.rmSync(home, { recursive: true, force: true });
