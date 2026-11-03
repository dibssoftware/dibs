// Notices about an agent's own jobs, left in its inbox (src/talk.mjs) so the
// guard hook hands each over once, beside its next tool call. Most agents have
// nobody watching the board for them: this is how they hear that a job of
// theirs looks stuck while others wait, used far more memory than it asked
// for, or was paused for low disk or memory and shouldn't be run again.
//
// The scan reads state.json without its lock (writes are renames, so it is
// always whole) and runs from processes that are alive anyway: every waiting
// dibs and every running one. Each notice has a name (idle:#12), so however
// many of them scan, an agent hears about each thing once.
import fs from 'node:fs';
import path from 'node:path';
import { paths, HOME } from './config.mjs';
import { peek, history } from './state.mjs';
import { notify } from './talk.mjs';
import { minutes, stuckFor } from './plain.mjs';
import { stuckLeases } from './acquire.mjs';
import { overAskLine } from './measure.mjs';
import { now, callerPid, clock } from './util.mjs';
import { read as readPosts, tasks, QUIET_AFTER, EXPIRE_AFTER } from './progress.mjs';
import { quoted } from './style.mjs';

// Which runs look stuck and which used more memory than they asked for is
// decided where the board decides it (stuckLeases, l.overAsk), so the notice
// and the board never disagree. This file only delivers.
// How often one process looks. The facts change on a scale of minutes.
export const NOTICE_EVERY = 20e3;

let last = 0;
const sent = new Set();

const what = l => `#${l.id} (${l.purpose ? `"${l.purpose}", ` : ''}${(l.cmd || l.res.join(',')).slice(0, 60)})`;

// [lease, once, text] for each notice the state holds, for the lease's agent.
export function noticesIn(s, t = now()) {
  const out = [];
  const waiting = (s.queue || []).filter(q => q.pid);
  const stuck = new Set(stuckLeases({ queue: [], leases: [], ...s }, t));
  for (const l of s.leases || []) {
    const others = waiting.filter(q => q.res.some(r => l.res.includes(r)));
    if (stuck.has(l) && others.length)
      out.push([l, `idle:#${l.id}`, `your job ${what(l)} has used no CPU for ${minutes(stuckFor(l, t))} while ${others.length} other `
        + `${others.length === 1 ? 'job waits' : 'jobs wait'} for ${l.res.join(', ')}. If it's stuck, end it: stop the tool call or background task `
        + `running it, or kill ${l.pid} (its dibs run, which takes the whole job down and frees the turn). If it's still working, leave it.`]);
    if (l.overAsk?.used && l.overAsk.asked && l.overAsk.suggest)
      out.push([l, `mem:#${l.id}`, `your job ${what(l)}: ${overAskLine(l.overAsk)}`]);
    if (l.loadPast)
      out.push([l, `loadpast:#${l.id}`, `your job ${what(l)} waited ${minutes(l.loadWaited || 0)} for the machine's load to fall, so it started anyway at background priority on the efficiency cores. `
        + 'It runs slower there. If a person is waiting on it now, raise it: dibs boost ' + l.id + ' high -m "why".']);
    const watcher = (l.pauses || []).filter(p => p.watcher && !p.gone);
    if (l.pausedAt && watcher.length)
      out.push([l, `paused:#${l.id}:${l.pausedAt}`, `your job ${what(l)} was paused because free ${watcher.some(p => p.disk) ? 'disk' : 'memory'} is low. `
        + "It keeps its turn and resumes by itself when there's room: don't run it again or end it."]);
  }
  return out;
}

// Leave the notices the state holds, at most every NOTICE_EVERY ms from this process.
// Never throws: a notice is a nicety, and its callers are mid-wait or mid-run.
export function noticeScan(t = now()) {
  if (t - last < NOTICE_EVERY) return;
  last = t;
  try {
    const s = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    for (const [l, once, text] of noticesIn(s, t)) {
      if (sent.has(once)) continue;
      sent.add(once);
      notify(l, once, text);
    }
  } catch {}
}

// At most one nudge per task this often. On 2026-11-03, 5 of 35 notices were
// these, and agents were posting progress only to stop them.
export const NAG_EVERY = 2 * 36e5;
// An agent with no job running or waiting, and none run in this long, isn't
// working now: its open task waits quietly for it to come back.
export const AWAY_AFTER = 30 * 6e4;
const NAGS = path.join(HOME, 'nags.json');

// [to, once, text, task] for each task still in progress that needs a word
// from whoever posted it: past its ETA, or with no post for QUIET_AFTER.
// Expired tasks are let go. Only tasks posted from a Claude Code session: the
// hook is how the notice arrives. A subagent's task is nudged to that subagent;
// once it has ended (ended(k)), its lead hears once that it was left open.
// nagged: when each task was last nudged; working(k): whether the agent the
// notice would go to is at work now.
export function progressNoticesIn(posts, t = now(), { nagged = {}, working = () => true, ended = () => false } = {}) {
  const out = [];
  for (const k of tasks(posts, t)) {
    if (k.state !== 'doing' || !k.session) continue;
    const task = `${k.who}:${k.agentId || 'main'}:${k.task || k.project}`;
    const name = k.task ? `"${k.task}"` : `in ${k.project || 'this folder'}`;
    if (k.agentId && ended(k)) {
      // Said once: nothing to do, it expires by itself; the lead only shouldn't be surprised.
      const lead = `${task}:lead`;
      if (nagged[lead] || !working({ ...k, agentId: null }) || !(k.overdue || t - k.last > QUIET_AFTER)) continue;
      out.push([{ sessionId: k.session, who: k.who }, `left:${task}`, `your subagent ${k.label || k.agentId.slice(0, 8)} ended with its progress task ${name} still open `
        + `(last post at ${clock(k.last)}). Nothing to do: it's let go ${minutes(Math.max(k.last, k.eta || 0) + EXPIRE_AFTER - t)} from now. `
        + `If the work goes on, post it under your own task.`, lead]);
      continue;
    }
    if (t - (nagged[task] || 0) < NAG_EVERY || !working(k)) continue;
    const to = { sessionId: k.session, who: k.who, ...(k.agentId && { agentId: k.agentId }) };
    const again = (...more) => quoted(['dibs', 'progress', 'where it stands', ...(k.task ? ['--task', k.task] : []), ...more]);
    if (k.overdue) out.push([to, `late:${task}:${k.eta}`, `your progress task ${name} was due at ${clock(k.eta)} and is still open. `
      + `If it's finished, say so: ${again('--done')}. If not, post where it stands with a new time: ${again('--eta', '30m')}.`, task]);
    else if (t - k.last > QUIET_AFTER) out.push([to, `quiet:${task}:${k.last}`, `your progress task ${name} has had no post for ${minutes(t - k.last)}. `
      + `Post where it stands (${again()}), or close it: --done if it's finished, --blocked if it's stuck.`, task]);
  }
  return out;
}

const DAY = 864e5;
// From the throttle watcher (src/cool.mjs), which is always running: no waiter needed.
export function progressScan(t = now()) {
  try {
    let nagged = {};
    try { nagged = JSON.parse(fs.readFileSync(NAGS, 'utf8')); } catch {}
    const s = peek(), hist = history();
    // At work: a job running or waiting, or one run in the last AWAY_AFTER. A
    // subagent counts only its own jobs (they carry its id) and its own posts.
    const mine = k => x => x.sessionId === k.session && (k.agentId ? x.agentId === k.agentId : true);
    const busy = k => (s.leases || []).some(mine(k)) || (s.queue || []).some(q => q.pid && mine(k)(q));
    const working = k => (k.agentId ? busy(k) || t - k.last < AWAY_AFTER
      : busy(k) || (s.leases || []).some(l => l.who === k.who) || hist.some(r => r.who === k.who && t - r.at < AWAY_AFTER));
    const ended = k => !busy(k) && t - k.last >= AWAY_AFTER;
    const before = JSON.stringify(nagged);
    for (const [to, once, text, task] of progressNoticesIn(readPosts({ since: t - DAY }), t, { nagged, working, ended })) {
      if (sent.has(once)) continue;
      sent.add(once);
      if (notify(to, once, text)) nagged[task] = t;
    }
    // A lead's one word about a subagent's task is kept as long as the task can be: never twice.
    for (const [k, at] of Object.entries(nagged)) if (t - at >= (k.endsWith(':lead') ? DAY : NAG_EVERY)) delete nagged[k];
    if (JSON.stringify(nagged) !== before) fs.writeFileSync(NAGS, JSON.stringify(nagged));
  } catch {}
}

// The same command from the same agent, already waiting or running, started
// by another tool call: almost always a retry after Claude Code moved the
// first call to the background. Running it again would run it twice, so the
// second copy refuses (exit 2) and says where the first one is. A copy from
// the same shell (a script starting several at once) has the same parent and
// isn't a retry; neither is one with a different -m, which is how an agent
// asks for a second copy on purpose. Entries from before 0.0.86 carry no
// parent or folder and never match. Returns { id, text }: the first copy's id and what to say.
export function twinOf(s, o, id, t = now()) {
  const cmd = (o.cmd || []).join(' ');
  const res = [...o.res].sort().join();
  const same = x => x.cmd === cmd && [...x.res].sort().join() === res && (x.purpose || '') === (o.purpose || '')
    && x.cwd === process.cwd() && x.ppid && x.ppid !== callerPid()
    && (id.spid ? x.spid === id.spid && (x.agentId || null) === (o.agentId || null) : !x.spid && x.who === id.who);
  const x = (s.leases || []).find(l => l.kind === 'run' && same(l)) || (s.queue || []).find(q => q.pid && same(q));
  if (!x) return null;
  const running = !!(s.leases || []).includes(x);
  return { id: x.id, text: `you already have this exact command ${running ? `running as #${x.id} (for ${minutes(t - x.start)})` : `waiting in line as #${x.id}`}, `
    + 'from an earlier call. Nothing ran here (exit 2): a second copy would run it twice. That earlier call reports when it ends; '
    + "if it went to the background, wait for its notice instead of running it again. To run a second copy at the same time on purpose, give it a different -m." };
}
