// dibs guard serve: the resident guard. The Claude Code hook runs on every
// tool call, about 30,000 a day here, and starting Node for each was nearly
// all of its time (100 to 400 ms on a busy Mac, against 3 to 20 ms of the
// hook's own work). bin/dibs-guard.mjs is also a small sh script that sends
// the call down GUARD_SOCK when this is running, and starts Node as before
// when it isn't, or when it doesn't answer.
//
// Each call runs in a worker thread loaded before the call comes, with the
// hook's own environment and parent pid (src/guardw.mjs), and the worker ends
// with it, so a call here is the same as a call in its own Node.
//
// On the socket, an HTTP POST from the client (curl): its parent pid, its
// folder, its environment (env -0), an empty field, the hook's JSON, each
// ending in a NUL. Back: "ok", then the hook's answer on the next line if it
// has one. Anything but "ok" and the client runs the hook itself.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.mjs';
import { singleInstance } from './proc.mjs';
import { log } from './util.mjs';

export const GUARD_SOCK = path.join(HOME, 'guard.sock');
const PIDFILE = path.join(HOME, 'guard.pid');
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guardw.mjs');
// Workers kept loaded and waiting: calls come in bursts when several agents work
// at once, and one takes 20 to 45 ms to load on a busy Mac.
const READY = 2;
// A call that takes longer is answered with nothing (allow), as a failing hook
// is, inside the client's 2 s: the subagent ledger's lock gives up at 1 s. A
// client that gets no answer then starts Node, which must still fit in Claude
// Code's 5 s hook timeout.
const CALL_LIMIT = 1500;
// No hook input comes near this; a client sending more is cut off.
const MAX_FRAME = 8 * 1024 ** 2;

// The fields of a whole frame, or null while more is still to come.
export function frame(buf) {
  const parts = buf.toString('utf8').split('\0');
  const end = parts.indexOf('', 2);   // the empty field after the environment
  // Complete once the JSON after it has its own NUL: parts then ends with ''.
  if (end < 0 || parts.length < end + 3) return null;
  const env = {};
  for (const kv of parts.slice(2, end)) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  return { ppid: Number(parts[0]) || null, cwd: parts[1], env, input: parts[end + 1] };
}

export async function serveGuard() {
  await singleInstance(PIDFILE, 'a resident guard is already running here');
  const ready = [], waiting = [];
  const warm = () => {
    const w = new Worker(WORKER, { execArgv: [] });
    w.once('message', () => { const next = waiting.shift(); next ? next(w) : ready.push(w); });
    w.once('error', e => log(`a guard worker failed to load: ${e.message}`));
  };
  const take = () => new Promise(r => { warm(); const w = ready.shift(); w ? r(w) : waiting.push(r); });
  for (let i = 0; i < READY; i++) warm();

  function call(f) {
    let input;
    try { input = JSON.parse(f.input); } catch { return null; }   // the hook says nothing for input it can't read
    return new Promise(resolve => {
      let w = null, over = false;
      const done = out => { if (over) return; over = true; clearTimeout(timer); w?.terminate(); resolve(out); };
      const timer = setTimeout(() => { log(`a hook call took over ${CALL_LIMIT} ms and was let through: ${input?.hook_event_name} ${input?.tool_name || ''}`); done(null); }, CALL_LIMIT);
      take().then(got => {
        if (over) return got.terminate();
        w = got;
        w.once('message', m => done(m.out ?? null));
        w.once('exit', () => done(null));
        w.postMessage({ input, env: f.env, ppid: f.ppid });
      });
    });
  }

  try { fs.unlinkSync(GUARD_SOCK); } catch {}
  // HTTP over the socket, because curl is the client every Mac and Linux box has
  // that waits for an answer: macOS nc hangs up as soon as its input ends.
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', d => { size += d.length; if (size > MAX_FRAME) req.destroy(); else chunks.push(d); });
    req.on('end', async () => {
      const f = frame(Buffer.concat(chunks));
      const out = f ? await call(f) : null;
      res.end(f ? `ok\n${out ? `${JSON.stringify(out)}\n` : ''}` : 'bad frame\n');
    });
  });
  server.listen(GUARD_SOCK, () => {
    fs.chmodSync(GUARD_SOCK, 0o600);
    log(`answering the Claude Code hook on ${GUARD_SOCK}`);
  });
  const stop = () => { server.close(); try { fs.unlinkSync(GUARD_SOCK); } catch {} try { fs.rmSync(PIDFILE); } catch {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
