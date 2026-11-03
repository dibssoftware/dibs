// onRelease: a command that puts a resource back after a lease on it ends,
// however it ends, so the next user finds it the way the config says (the
// shared simulator back at the default text size, say).
//
// The end is seen inside withState by whichever dibs call writes the state
// without the lease: dibs run as its command exits, dibs release, or any call
// that reaps a crashed holder or an expired hold. That call queues one entry
// per resource in s.resets, and once the lock is free it starts a supervisor
// (this file, run as a script) that runs the command with a timeout, logs any
// failure, and removes the entry. Queued under the lock, so each lease end
// queues exactly once; run outside it, so a slow command blocks nobody's state.
//
// While an entry is there, the next lease on that resource waits. Otherwise the
// reset races the next user, who'd screenshot a simulator still changing text
// size under them. The wait is bounded: the command is killed at its timeout,
// and an entry whose supervisor died or never started is dropped by the next
// state read.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, HOME } from './config.mjs';
import { withState } from './state.mjs';
import { pstart } from './proc.mjs';
import { stopTree, OS } from './platform.mjs';
import { coveredNow } from './schedule.mjs';
import { ms, dur, now, LEAN } from './util.mjs';

export const RESET_TIMEOUT = 30e3;   // when the resource's onReleaseTimeout doesn't say
// A supervisor checks in within a second, even on a loaded machine. One that
// hasn't by this time never will, and its entry stops holding the resource.
const START_GRACE = 15e3;
const LOG = path.join(HOME, 'onrelease.log');
const KEEP_OUTPUT = 2000;   // characters of a failed command's output kept in the log
const SELF = fileURLToPath(import.meta.url);

let starting = [];

// The user's file only: onRelease has no default. Read raw, since this runs
// under the lock, where dying on a bad file would leave the lock behind.
function settings() {
  try { return JSON.parse(fs.readFileSync(paths.config, 'utf8')).resources || {}; } catch { return {}; }
}

// A run under its own session's hold isn't the end of that session's turn,
// and neither is a hold whose covered run is still going: the last of the two
// to end resets the resource.
function stillTheirs(s, l, r) {
  if (l.kind === 'hold') return s.leases.some(x => x.kind === 'run' && x.covered?.includes(r) && x.spid && x.spid === l.pid);
  return coveredNow(s, l, r);
}

// Called by withState with the leases this change removed.
export function queueResets(s, gone) {
  if (!gone.length) return;
  const conf = settings();
  for (const l of gone) for (const r of l.res) {
    const c = conf[r];
    if (typeof c?.onRelease !== 'string' || stillTheirs(s, l, r)) continue;
    const timeout = /^[\d.]+\s*(ms|s|m|h)?$/.test(String(c.onReleaseTimeout ?? '')) ? ms(c.onReleaseTimeout) : RESET_TIMEOUT;
    const x = { id: ++s.seq, res: r, cmd: c.onRelease, timeout, lease: l.id, who: l.who, agent: l.agent, at: now() };
    (s.resets ||= []).push(x);
    starting.push(x.id);
  }
}

// After the lock is released: start a supervisor for each reset this change
// queued. A change that wasn't written starts nothing.
export function startResets(written) {
  const ids = starting.splice(0);
  if (!written) return;
  for (const id of ids) {
    const p = spawn(process.execPath, [...LEAN, SELF, String(id)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, DIBS_HOME: HOME } });
    p.on('error', () => {});   // its entry is dropped once START_GRACE passes
    p.unref();
  }
}

// On every state read: drop entries nothing is working on any more. A
// command whose supervisor is gone is killed with the entry, so the next user
// never gets the resource while it's still being reset under them.
export function reapResets(s, alive) {
  if (!s.resets?.length) return;
  const t = now();
  s.resets = s.resets.filter(x => {
    if (x.pid ? alive(x.pid, x.pstart) && t < x.started + x.timeout + START_GRACE : t - x.at < START_GRACE) return true;
    if (x.cpid && alive(x.cpid, x.cpstart)) stopTree(x.cpid, 'SIGKILL');
    note(x, x.pid ? 'its supervisor died before the command finished' : "its supervisor didn't start, so the command never ran");
    return false;
  });
}

function note(x, what, output = '') {
  const tail = output.trim() ? `\n  ${output.trim().split('\n').join('\n  ')}` : '';
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${x.res} after ${x.agent || x.who}: ${what}: ${x.cmd}${tail}\n`); } catch {}
}

// The supervisor: claim the entry, run the command, log a failure, let the resource go.
async function supervise(id) {
  const started = pstart(process.pid);
  const x = withState(s => {
    const x = (s.resets || []).find(r => r.id === id && !r.pid);
    if (x) Object.assign(x, { pid: process.pid, pstart: started, started: now() });
    return x && { ...x };
  });
  if (!x) return;
  const child = spawn(x.cmd, { shell: true, detached: OS !== 'windows', cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, DIBS_RESOURCE: x.res, DIBS_RELEASED_BY: x.agent || x.who } });
  // The command's group, so a reap that finds this supervisor dead can stop it too.
  if (child.pid) withState(s => { const r = (s.resets || []).find(r => r.id === id); if (r) Object.assign(r, { cpid: child.pid, cpstart: pstart(child.pid) }); });
  let output = '';
  const keep = d => { output = (output + d).slice(-KEEP_OUTPUT); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let killed = false;
  const timer = setTimeout(() => { killed = true; stopTree(child.pid, 'SIGKILL'); }, x.timeout);
  const code = await new Promise(r => {
    child.on('error', e => { keep(e.message); r(127); });
    child.on('exit', (c, sig) => r(c ?? sig));
  });
  clearTimeout(timer);
  if (killed) note(x, `killed after ${dur(x.timeout)} (onReleaseTimeout)`, output);
  else if (code !== 0) note(x, `exited ${code}`, output);
  withState(s => { s.resets = (s.resets || []).filter(r => r.id !== id); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) supervise(Number(process.argv[2]));
