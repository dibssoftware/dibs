// How many subagents run at once across every Claude Code session on this
// machine. Fan-outs that start together hit the account's usage limit together
// and die mid-edit; with a limit, the spawn past it comes back to the agent as
// a denied tool call while its other work carries on.
//
// The guard hook feeds it three events (https://code.claude.com/docs/en/hooks):
//   PreToolUse on Agent   a spawn is coming: keep a slot for it, or deny it
//   SubagentStart         the subagent runs: the kept slot becomes its own
//   SubagentStop          it finished: its slot frees
// It keeps its own small file and lock, not state.json's: the hook runs inside
// a tool call and must not wait behind a busy queue.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.mjs';
import { identity, makeAlive } from './proc.mjs';
import { now, sleepSync, fakeFull, lockHeld, unlock } from './util.mjs';

const FILE = path.join(HOME, 'agents.json');
const LOCK = path.join(HOME, 'agents.lock');

// Fan-outs of 5 to 10 at once are what ran into the usage limit together.
// Eight is the owner's pick: one big fan-out runs nearly whole, and a second
// session still gets its one (a session with none running always may).
// A kept slot whose subagent never started (the spawn was refused at a
// permission prompt, or failed) frees after this.
const PENDING_FOR = 2 * 6e4;
// A subagent whose transcript hasn't changed in this long is taken as gone: it
// was interrupted, and Claude Code sent no stop event. Long enough for a
// subagent sitting in one long tool call, like a build.
const QUIET_FOR = 60 * 6e4;
// The hook gives up on the lock after this and lets the spawn through.
const LOCK_WAIT = 1000;
// A lock this old belongs to a hook that died holding it.
const LOCK_STALE = 5000;

// The Agent tool was called Task in older Claude Code.
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

// Off unless the person sets a limit: a cap nobody asked for blocks fan-outs that were fine.
export const agentSlots = cfg => (Number(cfg?.agents?.slots) > 0 ? Number(cfg.agents.slots) : null);

function locked(fn) {
  fs.mkdirSync(HOME, { recursive: true });
  const t0 = now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (!lockHeld(e)) throw e;
      try { if (now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      if (now() - t0 > LOCK_WAIT) throw new Error(`${LOCK} stayed locked for ${LOCK_WAIT} ms`);
      sleepSync(5 + Math.random() * 10);
    }
  }
  try {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')).agents || []; } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    const before = JSON.stringify(list);
    list = reap(list);
    const out = fn(list);
    if (JSON.stringify(list) !== before) {
      fakeFull('state');
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify({ agents: list }, null, 1));
      fs.renameSync(`${FILE}.tmp`, FILE);
    }
    return out;
  } finally {
    unlock(LOCK);
  }
}

// Drop kept slots nobody took, subagents of a session that has exited, and
// ones gone quiet. Changes the list in place.
function reap(list) {
  const t = now();
  const alive = makeAlive(list.map(a => a.spid));
  const quiet = a => {
    try { return t - fs.statSync(a.transcript).mtimeMs > QUIET_FOR; } catch { return false; }
  };
  const kept = list.filter(a => (a.pending ? t - a.since < PENDING_FOR : true) && (!a.spid || alive(a.spid, a.sstart)) && !(a.transcript && quiet(a)));
  list.splice(0, list.length, ...kept);
  return list;
}

// "web-app x3, you x2"
function owners(list, session) {
  const n = new Map();
  for (const a of list) {
    const name = a.session === session ? 'you' : a.who;
    n.set(name, (n.get(name) || 0) + 1);
  }
  return [...n].map(([who, k]) => (k > 1 ? `${who} x${k}` : who)).join(', ');
}

function deny(why) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } };
}

// A session may always run one subagent, so a big fan-out elsewhere can't
// starve it. Past that, spawns wait until the machine is under its limit.
export function agentHook(input, cfg) {
  const slots = agentSlots(cfg);
  if (slots == null || !input?.session_id) return null;
  const session = input.session_id;
  const event = input.hook_event_name;
  if (event === 'SubagentStop') return locked(list => {
    const i = list.findIndex(a => a.id === input.agent_id);
    if (i >= 0) list.splice(i, 1);
    return null;
  });
  const id = identity();
  const me = { session, spid: id.spid, sstart: id.sstart, who: id.agent || path.basename(input.cwd || '') || 'a session' };
  if (event === 'SubagentStart') {
    // Internal agents (prompt suggestions, /btw) have no type; they were never counted.
    if (!input.agent_id || !input.agent_type) return null;
    return locked(list => {
      const kept = list.findIndex(a => a.pending && a.session === session);
      if (kept >= 0) list.splice(kept, 1);
      const at = list.findIndex(a => a.id === input.agent_id);
      if (at >= 0) list.splice(at, 1);
      const transcript = input.transcript_path && `${input.transcript_path.replace(/\.jsonl$/, '')}/subagents/agent-${input.agent_id}.jsonl`;
      list.push({ ...me, id: input.agent_id, type: input.agent_type, since: now(), ...(transcript ? { transcript } : {}) });
      return null;
    });
  }
  if (!SPAWN_TOOLS.has(input.tool_name)) return null;
  return locked(list => {
    const mine = list.filter(a => a.session === session).length;
    if (list.length >= slots && mine > 0)
      return deny(`dibs: ${list.length} subagents are running on this machine and the limit is ${slots} (${owners(list, session)}). `
        + `Nothing was started. ${mine} of them ${mine === 1 ? 'is' : 'are'} yours: wait until one reports back, then spawn this one again, or do this part yourself. `
        + 'Too many at once hit the account\'s usage limit together and die mid-edit. See them all with: dibs');
    const ti = input.tool_input || {};
    list.push({ ...me, id: input.tool_use_id || `spawn-${now()}`, pending: true, type: ti.subagent_type || null,
      desc: String(ti.description || '').slice(0, 60), since: now() });
    return null;
  });
}

// For the board: who runs how many subagents, and the limit.
export function agentsNow(cfg) {
  const slots = agentSlots(cfg);
  if (slots == null) return null;
  let list = [];
  try { list = locked(l => [...l]); } catch {}
  return { slots, running: list.map(a => ({ who: a.who, type: a.type || null, for: now() - a.since, starting: !!a.pending })) };
}
