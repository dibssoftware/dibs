// Parsing and formatting shared by every module. No state, no side effects
// beyond printing and exiting in die().
import fs from 'node:fs';
import os from 'node:os';

export const now = () => Date.now();
// The process that called dibs. A thin waiter's _enqueue (src/broker.mjs) runs
// under the waiting shell, so it's told the shell's parent instead. Node 22
// ignores a redefined process.ppid, so it's kept here.
let parentPid = null;
export const setCaller = pid => { parentPid = pid; };
export const callerPid = () => parentPid ?? process.ppid;
// Subagent types that name no one: Claude Code's built-in kinds. A named
// agent-team teammate's type is its name ("fix-guard").
const GENERIC_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
// What to call one subagent of a session, beside the session's name: its own
// name, else the -m reason its job gave, else the start of its id. Empty for
// a lease no subagent was seen taking.
export const agentLabel = x => (!x.agentId || x.agentId === 'main' ? ''
  : x.label && x.label !== x.who && !GENERIC_AGENTS.has(x.label) ? x.label
  : x.purpose ? `"${x.purpose}"` : x.agentId.replace(/^a(gent-?)?/, '').slice(0, 8));
// A lease or wait's holder: session/subagent when a subagent took it, else the
// usual "who (label)".
export const holder = (x, tag) => (agentLabel(x) ? `${x.who}/${agentLabel(x)}` : tag(x));

// Whether the caller runs inside Claude Code, the only place SendMessage means anything.
export const inClaudeCode = () => !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function say(msg) { process.stderr.write(`dibs: ${msg}\n`); }
// Exit 1 (nothing matched) and 75 (not your turn yet) aren't errors, so only the rest are red.
// Red as in src/style.mjs, kept here so the guard hook loads nothing more.
const CALM = new Set([0, 1, 75]);
// dibs web reads the CLI's own functions in its long-lived process, where a
// die() would take the page down: inside inProcess() it throws instead. Exit 75
// (a lock busy, try again) answers 503 with a time to retry; anything else is
// dibs's own trouble on this machine, 500. It used to be 502, which reads as a
// proxy failing and named nothing to do (2026-11-02).
const RETRY_AFTER = 2;
let throwing = 0;
export function inProcess(fn) {
  throwing++;
  try { return fn(); } finally { throwing--; }
}
// The same for a read that awaits: only where nothing else runs in the process
// meanwhile (src/reads.mjs answers one request at a time).
export async function inProcessAsync(fn) {
  throwing++;
  try { return await fn(); } finally { throwing--; }
}
// What die() last said and the code it exited with, for bin/dibs.mjs's record
// of a lost job or a crash: a command that exits 76 on its own is neither.
export let lastDie = '', lastDieCode = null;
export function die(msg, code = 2) {
  lastDie = String(msg);
  lastDieCode = code;
  if (throwing) throw Object.assign(new Error(msg), { status: code === 75 ? 503 : 500, exitCode: code, ...(code === 75 && { retryAfter: RETRY_AFTER }) });
  const red = !CALM.has(code) && !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || (process.stderr.isTTY && process.env.TERM !== 'dumb'));
  process.stderr.write(`${red ? '\x1b[31mdibs:\x1b[39m' : 'dibs:'} ${msg}\n`);
  process.exit(code);
}
// One --notify line (src/commands.mjs notifyOnExit). Best effort: the wait or run it reports on has ended either way.
export function notifyLine(file, line) {
  try { fs.appendFileSync(file, JSON.stringify(line) + '\n'); } catch {}
}
// Said wherever dibs tells an agent to free disk: the person's rule, which the guard enforces (tmpGuard in src/files.mjs).
export const OFF_LIMITS = "Never delete in another session's /private/tmp/claude-* folder to make room: they're off limits.";
// A full disk: out of space, or past this user's disk quota.
export const noSpace = e => e?.code === 'ENOSPC' || e?.code === 'EDQUOT';
export const fullDisk = e => `the disk is full (${e.code}${e.path ? ` writing ${e.path}` : ''}), so dibs couldn't save its change and nothing changed.`
  + ` Free some disk space, then run the same command again (exit 74). ${OFF_LIMITS}`;

// Tests stand in for a full disk with DIBS_FAKE_ENOSPC, a file: while it
// exists, a write at a step it names (any step, if it names none) fails the
// way ENOSPC does. Steps: lock (a lock's pid file), state (any state file), notes (the guard's notes).
export function fakeFull(step) {
  const f = process.env.DIBS_FAKE_ENOSPC;
  if (!f) return;
  let steps;
  try { steps = fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean); } catch { return; }
  if (!steps.length || steps.includes(step)) throw Object.assign(new Error(`ENOSPC: no space left on device (DIBS_FAKE_ENOSPC, ${step})`), { code: 'ENOSPC' });
}

// A timestamped line for the logs of long-running services (serve, worker).
export const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

// What ends a dibs process from outside: Ctrl-C, kill, a closed terminal.
// V8 settings for a dibs that waits or supervises: dozens of them sit idle for
// hours. A 1 MB young generation (default 16 MB, grown to 3 of them by a poll's
// garbage) took a waiter from 74 MB of memory to 41 MB on 2026-10-15. Not
// --lite-mode or --jitless: they turn off WebAssembly, and Node's fetch needs
// it, so nothing could reach the coordinator. bin/dibs.mjs's exec line and N in
// src/thin.sh pass the same; keep them in step.
export const LEAN = ['--max-semi-space-size=1'];
export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// The exit code a shell gives a process ended by sig.
export const signalExit = sig => 128 + (os.constants.signals[sig] || 0);

export function bytes(s) {
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) die(`can't read size "${s}" (try 4G or 500M)`);
  return parseFloat(m[1]) * { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
}

export function ms(s) {
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([\d.]+)\s*(ms|s|m|h)?$/);
  if (!m) die(`can't read duration "${s}" (try 90s, 8m, 1h)`);
  return parseFloat(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6 }[m[2] || 'm'];
}

// A deadline is a clock time (23:30, 9pm, 9:15am) or a duration from now (20m).
// A clock time already past today means tomorrow. Without am/pm, 5:00 means
// whichever of 5:00 and 17:00 comes next, since the board shows 12-hour times.
export function deadline(s, from = now()) {
  const t = String(s).trim().toLowerCase();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m && (m[2] || m[3])) {
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (min > 59 || h > 23 || (m[3] && (h < 1 || h > 12))) die(`can't read time "${s}"`);
    if (m[3]) h = h % 12 + (m[3] === 'pm' ? 12 : 0);
    const next = hour => {
      const d = new Date(from); d.setHours(hour, min, 0, 0);
      if (d.getTime() < from - 6e4) d.setDate(d.getDate() + 1);
      return d.getTime();
    };
    return !m[3] && h >= 1 && h <= 12 ? Math.min(next(h % 12), next(h % 12 + 12)) : next(h);
  }
  return from + ms(t);
}

export const gb = b => (b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0) + 'G';
// Any size, in the unit that reads best: 840K, 12M, 1.4G.
export const size = b => (b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))}K` : b < 1024 ** 3 ? `${Math.round(b / 1024 ** 2)}M` : gb(b));

export function dur(t) {
  t = Math.max(0, Math.round(t / 1000));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`;
  return `${Math.floor(t / 3600)}h${String(Math.floor(t / 60) % 60).padStart(2, '0')}m`;
}

// A command's inline secrets (API_KEY=..., --token ...) stay on this machine: dibs web and its stats show commands masked.
const SECRETISH = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*=)\S+|(--?(?:token|password|secret|api-key|key)[= ])\S+/gi;
export const masked = s => (typeof s === 'string' ? s.replace(SECRETISH, (m, a, b) => `${a || b}***`) : s);

export const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// A time later today reads as a clock; another day gets its date too, so a retry weeks off doesn't look like tonight.
export const when = (t, from = now()) => new Date(t).toDateString() === new Date(from).toDateString() ? `at ${clock(t)}` : `on ${new Date(t).toLocaleDateString('en-CA')} at ${clock(t)}`;

// A history key's command part is the program and its first word, then
// KEY_SPLIT and the words keys gained after 0.0.74 (src/acquire.mjs commandKey). Lines
// written before then are under the part before KEY_SPLIT: they count for a
// command until it has history under its full key.
export const KEY_SPLIT = ' / ';
export function runsOf(hist, key) {
  const by = indexed(hist).byKey;
  const mine = by.get(key) || [];
  const cut = key ? key.indexOf(KEY_SPLIT) : -1;
  if (mine.length || cut < 0) return mine;
  return by.get(key.slice(0, cut)) || [];
}

// History grouped by key and by agent, built once per history array. A waiter
// ranks the whole line every poll, and scanning a thousand lines for each
// waiter in each comparison cost 100 ms of CPU per poll with 40 waiting, and
// enough garbage to grow every waiter's heap past 150 MB. Rebuilt if the array grows.
const INDEX = new WeakMap();
export function indexed(hist) {
  let x = INDEX.get(hist);
  if (x?.n === hist.length) return x;
  x = { n: hist.length, byKey: new Map(), byWho: new Map() };
  for (const h of hist) {
    if (!x.byKey.has(h.key)) x.byKey.set(h.key, []);
    x.byKey.get(h.key).push(h);
    if (!x.byWho.has(h.who)) x.byWho.set(h.who, []);
    x.byWho.get(h.who).push({ at: h.at, dur: h.dur, res: String(h.key).split('|')[0].split(',') });
  }
  INDEX.set(hist, x);
  return x;
}

// A waiter's dibs stamps polledAt on its place at most this often (src/acquire.mjs decide).
export const POLLED_EVERY = 60e3;
// Longer than this without a stamp, nobody is deciding for the place: it holds nobody back
// (src/schedule.mjs), and the board says so.
export const UNPOLLED = 3 * POLLED_EVERY;
// Longer than this, it leaves the line (src/state.mjs reap). On 2026-11-04 a place its own
// process had stopped deciding for sat at the head of heavy for 21 h.
export const GHOST_AFTER = 10 * POLLED_EVERY;
// A place without a stamp (made before dibs stamped them) isn't judged.
export const unpolled = (q, t, after = UNPOLLED) => !!q.pid && q.polledAt != null && t - q.polledAt > after;
