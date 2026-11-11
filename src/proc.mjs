// Process facts: is a holder still alive, and which agent session is calling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { starts, parent, AGENTS } from './platform.mjs';
import { sleep, callerPid } from './util.mjs';

const SESSIONS = process.env.DIBS_SESSIONS || path.join(os.homedir(), '.claude', 'sessions');

export const pstart = pid => starts([pid])?.get(pid) || null;

// One process-table call for a batch of pids, then cheap lookups. If the
// table can't be read, everyone counts as alive: wrongly reaping a running
// job kills it, while wrongly keeping a dead one costs a few seconds.
// Start times read here in the last STARTS_FOR stay good while the pid still
// answers kill(0): every state read reaps, and one ps per read cost a dibs run
// 30 to 50 ms each time on a busy Mac. A pid can only be reused after its
// process is gone, which kill(0) sees.
const STARTS_FOR = 10e3;
const known = new Map();   // pid -> { start, at }
const answers = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function makeAlive(pids) {
  const t = Date.now();
  const need = pids.filter(p => p && !(known.has(p) && t - known.get(p).at < STARTS_FOR && answers(p)));
  const st = need.length ? starts(need) : new Map();
  if (!st) return pid => !!pid;
  for (const p of need) if (st.has(p)) known.set(p, { start: st.get(p), at: t }); else known.delete(p);
  const startOf = pid => (st.has(pid) ? st.get(pid) : known.get(pid)?.start);
  return (pid, started) => !!pid && startOf(pid) != null && (!started || startOf(pid) === started);
}

// The agent session that owns this call (Claude Code, Codex, Cursor...), found
// by walking up the process tree. Holds outlive a single tool call, so they
// hang off this process. For Claude Code, its name is the one SendMessage uses.
let cached;
function session() {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.env.DIBS_NO_SESSION) return cached;   // tests act as several agents from one session
  let pid = callerPid();
  for (let i = 0; i < 25 && pid > 1; i++) {
    const p = parent(pid);
    if (!p) break;
    if (AGENTS.test(p.name)) {
      let name = null;
      try { name = sessionFile(path.join(SESSIONS, `${pid}.json`)).name || null; } catch {}
      cached = { pid, name, app: p.name.toLowerCase(), start: pstart(pid) };
      break;
    }
    pid = p.ppid;
  }
  return cached;
}

export function identity(o = {}) {
  const se = session();
  const label = o.as || process.env.DIBS_AS || '';
  const agent = process.env.DIBS_AGENT || se?.name || null;
  // Outside an agent session, the folder names you, so hold and release from the same place match.
  const who = agent || (se ? `${label || path.basename(process.cwd())}#${se.pid}` : label || path.basename(process.cwd()));
  return { who, agent, label, spid: se?.pid || null, sstart: se?.start || null };
}

// One session's record. Claude Code has left one with a stray } after the object (2026-11-10,
// 43095.json), and a strict parse dropped that session from the board and its messages: the
// object it starts with is the record.
export function sessionFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (e) {
    const end = objectEnd(text);
    if (end < 0) throw e;
    return JSON.parse(text.slice(0, end));
  }
}

// Where the JSON object a text starts with ends, counting braces outside strings; -1 if it doesn't.
function objectEnd(text) {
  let depth = 0, str = false;
  for (let i = text.indexOf('{'); i >= 0 && i < text.length; i++) {
    const c = text[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// Claude Code's own record of each session it runs: { pid, sessionId, name, status, updated }.
// The person addresses an agent by the name; hooks know it by sessionId. status is Claude
// Code's word for what it's doing ("busy", "idle", "shell"), or null from an older one.
export function sessionFiles() {
  let names = [];
  try { names = fs.readdirSync(SESSIONS).filter(n => /^\d+\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const x = sessionFile(path.join(SESSIONS, n));
      if (x.pid && x.sessionId) out.push({ pid: x.pid, sessionId: x.sessionId, name: x.name || null, status: typeof x.status === 'string' ? x.status : null, updated: x.statusUpdatedAt || x.updatedAt || 0 });
    } catch {}
  }
  return out;
}

export const tag = x => (x.label && x.label !== x.who ? `${x.who} (${x.label})` : x.who);

// A queue entry or lease belongs to the caller if it came from the same agent
// session; outside one, the same name.
export const isMine = (x, id) =>
  id.spid ? x.spid === id.spid || (x.kind === 'hold' && x.pid === id.spid) : x.who === id.who;

// Long-running services (worker, throttle watcher) run one at a time. If
// another is alive, wait for it to go away instead of exiting: under a service
// manager, exiting would only get this one restarted, over and over.
export async function singleInstance(pidfile, what) {
  let other = 0;
  try { other = Number(fs.readFileSync(pidfile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (other && other !== process.pid && makeAlive([other])(other)) {
    console.log(`${what} (pid ${other})`);
    while (makeAlive([other])(other)) await sleep(30e3);
  }
  fs.mkdirSync(path.dirname(pidfile), { recursive: true });
  fs.writeFileSync(pidfile, String(process.pid));
}
