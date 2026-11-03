// Talking with the agents. Each agent has a thread: its questions (from
// src/questions.mjs) and answers, notes it leaves the person (dibs say), and
// messages the person sends it (dibs tell). A message reaches the agent
// through the guard hook (https://code.claude.com/docs/en/hooks):
//   PreToolUse             added to the call as additionalContext, the call itself unchanged
//   Stop, SubagentStop     the documented "block" decision with the message as the reason,
//                          so the agent keeps going and reads it instead of ending its turn
// Each message is handed over once, marked under the lock, so a block can't repeat.
//
// dibs itself also leaves agents notices this way (notify): a job of theirs
// that sits idle, used more memory than it asked for, was paused, or was
// started twice. Each is handed over once, beside the call, never on a stop.
//
// Messages keep their own file and lock (messages.json), like questions: the
// hook must never queue behind the state lock. inbox.json lists only who has
// something waiting, rewritten with every change and gone when nothing is, so
// the hook's check on every tool call is one read of a tiny or missing file.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, paths, loadConfig } from './config.mjs';
import { identity, makeAlive, pstart, sessionFiles } from './proc.mjs';
import { actor, logChange } from './owner.mjs';
import { takeAgent, talkKey } from './files.mjs';
import { asked, forYou } from './questions.mjs';
import { named, minutes, lower } from './plain.mjs';
import { bold, dim, columns } from './style.mjs';
import { die, now, say as note, sleepSync, fakeFull } from './util.mjs';

const FILE = path.join(HOME, 'messages.json');
const LOCK = path.join(HOME, 'messages.lock');
export const INBOX = path.join(HOME, 'inbox.json');
// Writes take milliseconds, so a lock this old belongs to a dibs that died holding it.
const LOCK_STALE = 5000;
const LOCK_WAIT = 15e3;
// The hook gives up on the lock sooner and hands the message over on a later call.
const HOOK_LOCK_WAIT = 1000;
// A week of talk is plenty to scroll back through, and keeps the file small.
const KEEP_FOR = 7 * 24 * 36e5;
const PER_THREAD = 200;
// A message is a few sentences. This stops one paste from filling the file.
const MAX_TEXT = 4000;
// The plain list shows this many recent lines of a thread.
const RECENT = 20;
// A notice is about a job running now. One that hasn't reached its agent in
// an hour is stale advice, and it would keep inbox.json around for nothing.
const NOTICE_LIFE = 36e5;

const STOPS = new Set(['Stop', 'SubagentStop']);
const MAIN = 'main';

function locked(fn, wait = LOCK_WAIT) {
  fs.mkdirSync(HOME, { recursive: true });
  const t0 = now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      if (now() - t0 > wait) {
        if (wait === HOOK_LOCK_WAIT) throw new Error(`${LOCK} stayed locked for ${wait} ms`);
        die(`${LOCK} stayed locked for ${wait / 1000}s; remove it if no dibs is running. Nothing was changed.`, 75);
      }
      sleepSync(5 + Math.random() * 10);
    }
  }
  try {
    const s = load();
    const before = JSON.stringify(s);
    reap(s);
    const out = fn(s);
    if (JSON.stringify(s) !== before) save(s);
    return out;
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

// Writes are renames, so reading without the lock always sees a whole file.
function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') note(`${FILE} was unreadable (${e.message}); starting with no messages.`);
  }
  s.seq ||= 0; s.threads ||= []; s.messages ||= [];
  return s;
}

function save(s) {
  fakeFull('state');
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(s, null, 1));
  fs.renameSync(`${FILE}.tmp`, FILE);
  const box = {};
  for (const m of s.messages) {
    if (m.state !== 'queued' || !(m.session || m.to)) continue;
    // A caller outside Claude Code has no hook: its next dibs command looks under "@who".
    const k = m.session || `@${m.to}`;
    box[k] ||= [];
    if (!box[k].includes(m.agentId)) box[k].push(m.agentId);
  }
  if (!Object.keys(box).length) return fs.rmSync(INBOX, { force: true });
  fs.writeFileSync(`${INBOX}.tmp`, JSON.stringify(box));
  fs.renameSync(`${INBOX}.tmp`, INBOX);
}

// A week's messages, the last PER_THREAD of each thread, and threads with
// anything left in them or any activity in the week.
function reap(s, t = now()) {
  for (const m of s.messages) if (m.kind === 'notice' && m.state === 'queued' && t - m.at > NOTICE_LIFE) m.state = 'expired';
  const recent = s.messages.filter(m => t - m.at < KEEP_FOR);
  const count = new Map();
  const kept = [];
  for (const m of recent.reverse()) {
    const n = (count.get(m.key) || 0) + 1;
    count.set(m.key, n);
    if (n <= PER_THREAD) kept.push(m);
  }
  s.messages = kept.reverse();
  s.threads = s.threads.filter(th => count.has(th.key) || t - th.last < KEEP_FOR);
}

const keyOf = (session, who, agentId) => `${session || who}|${agentId || MAIN}`;

// What the person types to reach a thread: the session name for its main
// agent, name/label for a subagent (name/label#id when two share a label).
function names(threads) {
  const out = new Map();
  for (const th of threads) {
    if (th.agentId === MAIN) { out.set(th.key, th.who); continue; }
    const base = `${th.who}/${th.label || th.agentId.slice(0, 8)}`;
    const twins = threads.filter(x => x.agentId !== MAIN && x.who === th.who && (x.label || x.agentId.slice(0, 8)) === (th.label || th.agentId.slice(0, 8)));
    out.set(th.key, twins.length > 1 ? `${base}#${th.agentId.slice(0, 6)}` : base);
  }
  return out;
}

// Is anyone left to read the thread: its session's process is running and,
// for a subagent, it hasn't finished. Unknown (no process to check) counts as alive.
// A session's live process comes first: a resumed session runs under a new pid,
// and the thread's own pid is the one it had when the thread began.
function liveness(threads) {
  const files = sessionFiles();
  const up = makeAlive([...files.map(f => f.pid), ...threads.map(th => th.spid)].filter(Boolean));
  const live = new Set(files.filter(f => up(f.pid)).map(f => f.sessionId));
  const known = new Set(files.map(f => f.sessionId));
  // A main session's thread marked ended is alive again once its session runs again; a finished subagent stays finished.
  return th => (th.agentId === MAIN && live.has(th.session))
    || (!th.ended && (live.has(th.session) || (th.spid ? up(th.spid, th.sstart) : !known.has(th.session))));
}

// The caller's own thread, made if it's new. o.as labels a subagent's thread.
function mine(s, verb, words, o) {
  const id = identity(o);
  const session = process.env.CLAUDE_CODE_SESSION_ID || sessionFiles().find(f => f.pid === id.spid)?.sessionId || null;
  const by = session ? takeAgent(verb, [], talkKey(verb, words)) : null;
  const agentId = by?.agentId || MAIN;
  const key = keyOf(session, id.who, agentId);
  let th = s.threads.find(x => x.key === key);
  if (!th) s.threads.push(th = { key, who: id.who, session, agentId, label: '', spid: id.spid, sstart: id.sstart, readAt: 0, last: now() });
  const label = id.label || by?.agentType || '';
  if (label) th.label = label;
  Object.assign(th, { who: id.who, spid: id.spid || th.spid, sstart: id.sstart || th.sstart, ended: null });
  return th;
}

function parse(args) {
  const o = { words: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--as') o.as = args[++i] ?? die('--as needs a value');
    else if (a === '--to') { o.to = args[++i] ?? die('--to needs a value: dibs say --to person "..."'); if (o.to !== 'person') die(`dibs say goes to the person: --to person, not --to ${o.to}. To reach an agent: dibs tell <agent> "..."`); }
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-') && a.length > 1) die(`unknown flag ${a}. Try: dibs help`);
    else o.words.push(a);
  }
  o.text = o.words.join(' ').trim();
  if (o.text.length > MAX_TEXT) die(`that's ${o.text.length} characters; keep it under ${MAX_TEXT}, or point to a file with the details. Nothing was sent.`);
  return o;
}

// dibs say "text" [--as label] [--to person]: a note to the person in the
// agent's own thread. The person reads notes as FYI; --to person marks a
// reply to something they said (the desk's answers, a reply to a message).
export function say(args) {
  const o = parse(args);
  if (!o.text) die('say what? dibs say "migration done, tests pass"');
  const r = locked(s => {
    const th = mine(s, 'say', args, o);
    const t = now();
    s.messages.push({ id: ++s.seq, key: th.key, at: t, from: 'agent', kind: 'note', text: o.text, ...(o.to && { reply: true }) });
    th.last = t;
    // Without the guard hook nothing else hands messages over: this is the agent reading its thread.
    const waiting = s.messages.filter(m => m.key === th.key && m.state === 'queued' && m.kind !== 'notice');
    for (const m of waiting) handOver(s, m, 'say', t);
    return waiting.map(m => ({ ...m }));
  });
  console.log(`Sent to the person. They see it in dibs threads.${r.map(m => `\nMessage from ${sender(m)}: ${m.text}`).join('')}`);
}

// A note in an agent's thread on its behalf, as if it had run dibs say: how
// a job it scheduled with dibs later ended. by: { who, session, agentId,
// label, spid, sstart }, as the agent was when it scheduled it. Throws rather
// than exit when the lock stays taken, since its caller may be a service.
export function noteAs(by, text) {
  locked(s => {
    const key = keyOf(by.session, by.who, by.agentId);
    let th = s.threads.find(x => x.key === key);
    if (!th) s.threads.push(th = { key, who: by.who, session: by.session || null, agentId: by.agentId || MAIN, label: by.label || '',
      spid: by.spid || null, sstart: by.sstart || null, readAt: 0, last: now() });
    const t = now();
    s.messages.push({ id: ++s.seq, key, at: t, from: 'agent', kind: 'note', text: text.slice(0, MAX_TEXT) });
    th.last = t;
  }, HOOK_LOCK_WAIT);
}

// The thread the person means by name: a live one, else a running session
// by that name (a new thread), else the newest one that has ended.
function target(s, name) {
  const named = names(s.threads);
  const alive = liveness(s.threads);
  const found = s.threads.filter(th => named.get(th.key) === name).sort((a, b) => b.last - a.last);
  const live = found.find(alive);
  if (live) return live;
  const files = sessionFiles().filter(f => f.name === name);
  const running = files.filter(f => makeAlive([f.pid])(f.pid));
  const f = running[0] || (!found.length && files[0]);
  if (f) {
    const key = keyOf(f.sessionId, name, MAIN);
    let th = s.threads.find(x => x.key === key);
    if (!th) s.threads.push(th = { key, who: name, session: f.sessionId, agentId: MAIN, label: '', spid: f.pid, sstart: pstart(f.pid), readAt: 0, last: now() });
    // The session's thread under the name and process it has now: a session renamed or
    // resumed keeps its thread, which still named the old ones (2026-11-02: "dibs tell
    // alex-a4" answered "queued for alex-8e, but its session has ended").
    else if (running.includes(f)) Object.assign(th, { who: name, spid: f.pid, sstart: pstart(f.pid), ended: null });
    return th;
  }
  if (found.length) return found[0];
  return null;
}

const nobody = (s, name) => {
  const known = [...new Set(names(s.threads).values())];
  const running = sessionFiles().filter(f => f.name && makeAlive([f.pid])(f.pid)).map(f => f.name);
  return `no agent called ${name}. ${known.length ? `Threads: ${known.join(', ')}. ` : ''}${running.length ? `Running sessions: ${[...new Set(running)].join(', ')}. ` : ''}See them: dibs threads`;
};

// dibs tell <agent> "text": the person, or another agent, queues a message for an agent.
// An agent's message says which agent sent it, never that the person did.
export function tell(args) {
  let [name, ...rest] = args;
  // "desk" is whichever agent config.json names to answer the person (the app's chat).
  if (name === 'desk') name = loadConfig().desk || die('no desk agent is set. Name one in ~/.dibs/config.json: "desk": "<agent name>" (names: dibs threads)');
  const o = parse(rest);
  if (!name || !o.text) die('tell whom what? dibs tell <agent> "use the staging database" (names: dibs threads)');
  const who = actor();
  const r = locked(s => {
    const th = target(s, name);
    if (!th) return { no: nobody(s, name) };
    const t = now();
    s.messages.push({ id: ++s.seq, key: th.key, at: t, from: 'person', kind: 'message', text: o.text, state: 'queued',
      session: th.session, agentId: th.agentId, ...(who.agent && { by: who.name }) });
    th.last = t;
    return { th: { ...th }, alive: liveness([th])(th) };
  });
  if (r.no) die(r.no, 1);
  const to = names([r.th]).get(r.th.key);
  logChange('tell', { to });
  if (!r.th.session) console.log(`queued for ${to}, which isn't a Claude Code session: the hook can't hand it over. It gets it the next time it runs dibs say.`);
  else if (!r.alive) console.log(`queued for ${to}, but ${r.th.agentId === MAIN ? 'its session has ended' : 'that subagent has finished'}. It stays queued, shown as not delivered, in case it comes back.`);
  else console.log(`queued for ${to}: it gets it with its next tool call, or as it finishes its turn.`);
}

// Mark one queued message handed over, with a line in the thread saying how.
const VIA = { tool: 'got it with its next tool call', stop: 'got it as it was finishing, and kept going', say: 'got it when it ran dibs say',
  command: 'got it with its next dibs command' };
function handOver(s, m, via, t) {
  Object.assign(m, { state: 'delivered', deliveredAt: t, via });
  if (m.kind === 'notice') return;
  s.messages.push({ id: ++s.seq, key: m.key, at: t, from: 'agent', kind: 'delivered', text: VIA[via], about: m.id });
}

// dibs leaving an agent a notice about one of its jobs, handed over on its next
// tool call by the hook (or, outside Claude Code, its next dibs command). to is
// the lease or queue entry the notice is about: { sessionId, agentId, who }.
// once names the event ("idle:#12"): a notice already left under that name
// isn't left again, so a producer can call this on every pass. Best effort:
// a busy lock or a full disk only means the agent doesn't hear about it.
export function notify(to, once, text) {
  const session = to.sessionId || to.session || null;
  if (!session && !to.who) return false;
  const agentId = to.agentId || MAIN;
  try {
    return locked(s => {
      const same = m => m.kind === 'notice' && m.once === once && m.session === session && m.agentId === agentId && (session || m.to === to.who);
      if (s.messages.some(same)) return false;
      s.messages.push({ id: ++s.seq, key: keyOf(session, to.who, agentId), at: now(), from: 'dibs', kind: 'notice', text: text.slice(0, MAX_TEXT),
        state: 'queued', session, agentId, once, ...(session ? {} : { to: to.who }) });
      return true;
    }, HOOK_LOCK_WAIT);
  } catch { return false; }
}

// The person's (or an agent's) answer in words to a question, handed to the
// agent that asked as a message too, as dibs tell would: an agent that already
// moved on hears it with its next tool call. q: the question as stored.
export function messageAsker(q, text) {
  const who = actor();
  const session = q.session || null, agentId = q.agentId || MAIN;
  locked(s => {
    const key = keyOf(session, q.who, agentId);
    let th = s.threads.find(x => x.key === key);
    if (!th) s.threads.push(th = { key, who: q.who, session, agentId, label: q.label || '', spid: q.spid || null, sstart: q.sstart || null, readAt: 0, last: now() });
    // After the answer it follows, even in the same millisecond, so the thread reads in order.
    s.messages.push({ id: ++s.seq, key, at: Math.max(now(), (q.answeredAt || 0) + 1), from: 'person', kind: 'message', text: `(answering your question #${q.id}) ${text}`.slice(0, MAX_TEXT),
      state: 'queued', session, agentId, ...(who.agent && { by: who.name }) });
    th.last = now();
  });
}

// Said before the message: an agent rightly distrusts instructions that turn
// up beside a tool result, so this says where it really came from.
const FROM = 'dibs: a message for you, sent with `dibs tell`. '
  + 'It comes from the dibs hook in this machine\'s Claude Code settings, not from the tool or its output.';
// Who a message is from. Another agent's never reads as the person's.
const sender = m => (m.by ? `${m.by} (another agent, not the person)` : 'the person');
const REPLY = 'To answer them, run: dibs say "..."';
const NOTICE = 'dibs (the queue for shared machine resources this session uses) has a notice about your jobs. '
  + 'It comes from the dibs hook in this machine\'s Claude Code settings, not from the tool or its output:';

// The two kinds of text, ready to show: the person's messages and dibs's notices.
function texts(list) {
  const said = list.filter(m => m.kind !== 'notice').map(m => `Message from ${sender(m)}: ${m.text}`);
  const notes = list.filter(m => m.kind === 'notice').map(m => `- ${m.text}`);
  return [said.length ? `${FROM}\n${said.join('\n')}\n${REPLY}` : '', notes.length ? `${NOTICE}\n${notes.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

// The hook's half, called only when inbox.json lists this session and agent:
// hand over what's queued for it, merged into out (the guard's own answer).
// The guard's refusals come first; a refused call gets its messages on the next.
// While a stop hook has already kept the agent going (stop_hook_active), it
// doesn't block again: the message waits for the next tool call or turn.
// Notices never keep an agent from stopping: they wait for its next tool call.
export function deliver(input, out) {
  const stop = STOPS.has(input.hook_event_name);
  if (stop ? input.stop_hook_active : out?.hookSpecificOutput?.permissionDecision === 'deny') return out;
  const agentId = input.agent_id || MAIN;
  const text = texts(locked(s => {
    const t = now();
    const mine = s.messages.filter(m => m.state === 'queued' && m.session === input.session_id && m.agentId === agentId && !(stop && m.kind === 'notice'));
    for (const m of mine) {
      handOver(s, m, stop ? 'stop' : 'tool', t);
      const th = s.threads.find(x => x.key === m.key);
      if (th) Object.assign(th, { ended: null, last: t });
    }
    return mine;
  }, HOOK_LOCK_WAIT));
  if (!text) return out;
  // additionalContext keeps the agent going with the message as hook feedback.
  // decision: 'block' did too, but Claude Code shows its reason as a "Stop hook
  // blocking error", and agents read the person's message as a failure (2026-11-03).
  if (stop) return { hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } };
  if (!out) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
  const h = out.hookSpecificOutput;
  return { ...out, hookSpecificOutput: { ...h, additionalContext: [h.additionalContext, text].filter(Boolean).join('\n\n') } };
}

// For a caller with no hook (a terminal, Codex, a script): notices left for
// it, handed over by its next dibs command. Cheap when there are none: one
// read of inbox.json, which is absent when nothing is queued for anyone.
export function noticesFor(who) {
  try { if (!JSON.parse(fs.readFileSync(INBOX, 'utf8'))[`@${who}`]) return ''; } catch { return ''; }
  try {
    return texts(locked(s => {
      const mine = s.messages.filter(m => m.state === 'queued' && m.kind === 'notice' && !m.session && m.to === who);
      for (const m of mine) handOver(s, m, 'command', now());
      return mine;
    }, HOOK_LOCK_WAIT)).replace(/^dibs \(.*\n/, 'dibs has a notice about your jobs:\n');
  } catch { return ''; }
}

// A subagent that finished: its thread shows it can't be reached until it runs again.
export function finished(input) {
  if (!input.agent_id || !fs.existsSync(FILE)) return;
  const key = keyOf(input.session_id, null, input.agent_id);
  if (!load().threads.some(th => th.key === key && !th.ended)) return;
  locked(s => { const th = s.threads.find(x => x.key === key); if (th) th.ended = now(); }, HOOK_LOCK_WAIT);
}

// What each thread's agent is doing now, from the state file read without its
// lock: the lease it holds or the request it waits on, or null when idle.
function doing(th, st) {
  const ours = x => x.who === th.who && (th.agentId === MAIN ? !x.agentId || x.agentId === MAIN : x.agentId === th.agentId);
  const l = (st.leases || []).find(ours);
  if (l) return { using: true, res: l.res, purpose: l.purpose };
  const q = (st.queue || []).find(ours);
  return q ? { using: false, res: q.res, purpose: q.purpose } : null;
}
const why = d => (d.purpose ? ` for "${d.purpose}"` : '');
// For --json, by resource id, which the Mac app reads: "using sim for "snapshots"", "waiting for xcode-build".
const workingId = d => (d ? `${d.using ? 'using' : 'waiting for'} ${d.res.join(', ')}${why(d)}` : 'idle');
// For the terminal, in the board's words: "using the simulator for "snapshots"", "deploying", "waiting in the Xcode build queue".
const workingPlain = (d, cfg) => (!d ? 'idle' : d.using ? `${d.res.map(r => lower(named(cfg, r).doing)).join(' and ')}${why(d)}`
  : `waiting in ${d.res.map(r => named(cfg, r).queue).join(' and ')}${why(d)}`);

// Every thread as the app and dibs threads --json see it, newest activity first.
function view(s, t = now()) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch {}
  const threads = [...s.threads];
  const byKey = new Map(threads.map(th => [th.key, th]));
  // dibs's notices (bookings, stuck jobs, --mem advice) are for the agent's hook only, never the person's threads.
  const lines = new Map(threads.map(th => [th.key, s.messages.filter(m => m.key === th.key && m.kind !== 'notice').map(m => ({
    id: `m${m.id}`, at: m.at, from: m.from, kind: m.kind, text: m.text, options: null, questionId: null,
    state: m.kind === 'message' ? m.state : null, ...(m.about ? { about: `m${m.about}` } : {}),
    ...(m.kind === 'note' && (m.reply ? { reply: true } : { fyi: true })), ...(m.by ? { by: m.by } : {}) }))]));
  // Questions join their asker's thread, made here if it has said nothing yet.
  for (const q of asked(t)) {
    const key = keyOf(q.session, q.who, q.agentId);
    if (!byKey.has(key)) {
      const th = { key, who: q.who, session: q.session, agentId: q.agentId || MAIN, label: q.agentId ? q.label || '' : '', spid: q.spid, sstart: q.sstart, readAt: 0, last: q.asked };
      byKey.set(key, th); threads.push(th); lines.set(key, []);
    }
    const th = byKey.get(key);
    th.last = Math.max(th.last, q.answeredAt || q.asked);
    const about = { recommend: q.recommend ?? null, why: q.purpose || null, oneWay: !!q.oneWay, cantUndo: q.cantUndo ?? null };
    // A two-way door the agent walked through itself: shown as done, not asked.
    if (q.state === 'decided') { lines.get(key).push({ id: `q${q.id}`, at: q.asked, from: 'agent', kind: 'decided', text: q.text, options: q.options, questionId: q.id, state: q.state, answer: q.answer, ...about }); continue; }
    lines.get(key).push({ id: `q${q.id}`, at: q.asked, from: 'agent', kind: 'question', text: q.text, options: q.options, questionId: q.id, state: q.state, ...about });
    if (q.state === 'answered') lines.get(key).push({ id: `q${q.id}a`, at: q.answeredAt, from: 'person', kind: 'answer', text: q.answer, options: null, questionId: q.id, state: null,
      ...(q.freeText && { freeText: true }), ...(q.answeredBy && { by: q.answeredBy }) });
  }
  const named = names(threads);
  const alive = liveness(threads);
  const desk = deskName();
  return threads.map(th => {
    const messages = lines.get(th.key).sort((a, b) => a.at - b.at);
    return { agent: th.who, label: th.label || '', session: th.session, agentId: th.agentId, to: named.get(th.key), alive: alive(th),
      ...(desk && named.get(th.key) === desk && { desk: true }),
      working: workingId(doing(th, st)), doing: doing(th, st), unread: messages.filter(m => m.from === 'agent' && m.kind !== 'delivered' && m.at > (th.readAt || 0)).length,
      last: th.last, messages };
  }).sort((a, b) => b.last - a.last);
}

// What `dibs threads --json` prints. dibs web reads it without the lock; the reaping isn't saved.
export function threadsJson(t = now(), list = null) {
  if (!list) {
    const s = load();
    reap(s);
    list = view(s, t);
  }
  return { threads: list.map(({ doing, ...th }) => th), desk: deskName(), needsYou: forYou(loadConfig(), t) };
}

// For the board: notes the person hasn't read. Read without the lock; the reaping isn't saved.
export function notesForYou() {
  if (!fs.existsSync(FILE)) return 0;
  const s = load();
  reap(s);
  const readAt = new Map(s.threads.map(th => [th.key, th.readAt || 0]));
  return s.messages.filter(m => m.kind === 'note' && m.at > (readAt.get(m.key) ?? 0)).length;
}

// The agent config.json names to answer the person ("desk"), or null.
function deskName() { try { return loadConfig().desk || null; } catch { return null; } }

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (t, at) => (t - at < 6e4 ? 'just now' : `${minutes(t - at)} ago`);

// dibs threads [--json] | dibs threads read <agent>
export function threads(args) {
  if (args[0] === 'read') return read(args.slice(1));
  const json = args.includes('--json');
  const bad = args.find(a => a !== '--json');
  if (bad) die(`unknown ${bad.startsWith('-') ? 'flag' : 'word'} ${bad}. Try: dibs threads [--json], dibs threads read <agent>`);
  const t = now();
  const list = view(locked(s => s), t);
  if (json) return console.log(JSON.stringify(threadsJson(t, list), null, 1));
  const cfg = loadConfig();
  const unread = list.reduce((n, th) => n + th.unread, 0);
  if (!list.length) return console.log('No threads yet. Agents start one with dibs say or dibs question.');
  const out = [bold(`${plural(list.length, 'thread')}${unread ? `, ${unread} unread` : ', nothing unread'}.`), ''];
  out.push(...columns(list.map(th => {
    const lastLine = th.messages.filter(m => m.kind !== 'delivered').at(-1);
    const flags = [th.unread ? `${th.unread} unread` : '', th.messages.some(m => m.state === 'queued') ? 'your message is not delivered yet' : ''].filter(Boolean).join(', ');
    return [th.to, `${th.alive ? workingPlain(th.doing, cfg) : 'not running'}, last heard ${ago(t, th.last)}${flags ? ` (${flags})` : ''}.`,
      lastLine ? dim(`${lastLine.from === 'person' ? 'You' : lastLine.from === 'dibs' ? 'dibs' : 'They'}: ${lastLine.text}`) : ''];
  })));
  out.push('', dim('Read one: dibs threads read <agent>. Write to one: dibs tell <agent> "..."'));
  console.log(out.join('\n'));
}

// dibs threads read <agent>: the conversation, and its agent's messages marked seen.
function read(args) {
  const name = args[0];
  if (!name || args.length > 1) die('which thread? dibs threads read <agent> (names: dibs threads)');
  const t = now();
  const r = locked(s => {
    const list = view(s, t).filter(th => th.to === name);
    if (!list.length) return { no: nobody(s, name) };
    const keys = new Set(list.map(th => keyOf(th.session, th.agent, th.agentId)));
    for (const th of s.threads) if (keys.has(th.key)) th.readAt = t;
    // A thread that holds only questions so far gets a record, so it remembers being read.
    for (const th of list) {
      const key = keyOf(th.session, th.agent, th.agentId);
      if (!s.threads.some(x => x.key === key))
        s.threads.push({ key, who: th.agent, session: th.session, agentId: th.agentId, label: th.label, readAt: t, last: th.last });
    }
    return { list };
  });
  if (r.no) die(r.no, 1);
  const out = [];
  for (const th of r.list) {
    out.push(bold(`${th.to}: ${th.alive ? workingPlain(th.doing, loadConfig()) : 'not running (your messages wait for it)'}.`));
    for (const m of th.messages.slice(-RECENT)) {
      const who = m.from === 'person' ? 'you' : m.from === 'dibs' ? 'dibs told them' : 'them';
      const what = m.kind === 'question' ? `asked (#${m.questionId}, ${m.state}): ${m.text}${m.options ? `  (${m.options.join(' / ')})` : ''}`
          + `${m.recommend ? `  they recommend ${m.recommend}${m.why ? `: ${m.why}` : ''}` : ''}${m.cantUndo ? `. Can't be undone: ${m.cantUndo}` : ''}`
        : m.kind === 'decided' ? `decided it themselves, a two-way door (#${m.questionId}): ${m.text} -> ${m.answer}${m.why ? ` (${m.why})` : ''}. To change it, tell them`
        : m.kind === 'note' && m.fyi ? `FYI: ${m.text}`
        : m.kind === 'answer' ? `answered #${m.questionId}: ${m.text}`
        : m.kind === 'delivered' ? `(${m.text})`
        : `${m.text}${m.state === 'queued' ? '  (not delivered yet)' : ''}`;
      out.push(`  ${ago(t, m.at)}, ${who}: ${what}`);
    }
  }
  out.push(dim(`Write to ${name}: dibs tell ${name} "..."${r.list.some(th => th.messages.some(m => m.kind === 'question' && m.state === 'open')) ? '. Answer a question: dibs answer <id> <text>' : ''}`));
  console.log(out.join('\n'));
}
