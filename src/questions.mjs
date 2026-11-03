// Questions for the person who runs the agents. Their attention is the
// scarcest thing on the machine, so agents queue for it like any resource:
// `dibs question` records one, the person answers when they get to it, and an
// agent that can't go on without the answer waits for it with --wait.
//
// Only one-way doors reach the person. Every question carries the asker's
// recommendation and why (--recommend, -m). Without --one-way "what can't be
// undone", it's a two-way door: dibs answers at once with the recommendation,
// logs the decision, and shows it to the person as done, to overrule with a
// message if they like. The person's standing rule: walk through two-way
// doors, bring them only what can't be undone.
//
// Questions keep their own file and lock, not state.json's: the Mac app polls
// them often, and they never decide who runs next, so there's no reason to
// queue behind every waiter's lock.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, paths, loadConfig } from './config.mjs';
import { identity, isMine, makeAlive, pstart, tag } from './proc.mjs';
import { actor, logChange } from './owner.mjs';
import { KEEP_PLACE } from './state.mjs';
import { PRIORITY_SHIFT, PRIORITIES, priority } from './schedule.mjs';
import { defaultMaxWait } from './acquire.mjs';
import { event } from './events.mjs';
import { takeAgent, talkKey } from './files.mjs';
import { messageAsker } from './talk.mjs';
import { clock, die, dur, ms, now, say, sleep, sleepSync, fakeFull } from './util.mjs';
import { bold, dim, amber, wrap } from './style.mjs';

const FILE = path.join(HOME, 'questions.json');
const LOCK = path.join(HOME, 'questions.lock');
// Writes take milliseconds, so a lock this old belongs to a dibs that died holding it.
const LOCK_STALE = 5000;
const LOCK_WAIT = 15e3;
// A waiting asker looks for its answer this often. A person reads the answer
// back slower than this, and each look is one small file read.
const POLL = 1000;
// Answered, dismissed and expired questions stay this long for the app's
// list, up to KEEP_DONE of them.
const DONE_FOR = 7 * 24 * 36e5;
const KEEP_DONE = 200;
// The plain list shows this many of the most recent closed questions.
const RECENT = 5;

const OPEN = 'open';
const DECIDED = 'decided';

function locked(fn) {
  fs.mkdirSync(HOME, { recursive: true });
  const t0 = now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      if (now() - t0 > LOCK_WAIT) die(`${LOCK} stayed locked for ${LOCK_WAIT / 1000}s; remove it if no dibs is running. Nothing was changed.`, 75);
      sleepSync(5 + Math.random() * 10);
    }
  }
  try {
    const s = load();
    const before = JSON.stringify(s);
    reap(s);
    const out = fn(s);
    if (JSON.stringify(s) !== before) {
      fakeFull('state');
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(s, null, 1));
      fs.renameSync(`${FILE}.tmp`, FILE);
    }
    return out;
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

// Writes are renames, so reading without the lock always sees a whole file.
function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') say(`${FILE} was unreadable (${e.message}); starting with no questions.`);
  }
  s.seq ||= 0; s.questions ||= [];
  return s;
}

// Close questions nobody is left to read the answer of. One asked with --wait
// belongs to its waiting process, and expires when that dies. A wait that gave
// up at its limit keeps the question open KEEP_PLACE for the same command to
// pick back up, as a waiter's place in line does. One asked without --wait
// belongs to the agent session that asked, and lasts until --timeout if it says.
function reap(s, t = now()) {
  const open = s.questions.filter(q => q.state === OPEN);
  const alive = makeAlive(open.flatMap(q => [q.pid, q.spid]).filter(Boolean));
  for (const q of open) {
    if (q.pid && !alive(q.pid, q.pstart)) q.pid = null;
    const gone = q.waits ? !q.pid && !(q.keepUntil && t < q.keepUntil)
      : (q.spid && !alive(q.spid, q.sstart)) || (!q.pid && q.due && t >= q.due);
    if (gone) Object.assign(q, { state: 'expired', answeredAt: t });
  }
  const done = s.questions.filter(q => q.state !== OPEN && t - (q.answeredAt || q.asked) < DONE_FOR).slice(-KEEP_DONE);
  s.questions = s.questions.filter(q => q.state === OPEN || done.includes(q));
}

// "09:00" -> minutes since midnight, or null.
function readTime(hhmm) {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function minutes(hhmm) {
  return readTime(hhmm) ?? die(`hours in config.json are {"start": "09:00", "end": "23:00"}; can't read "${hhmm}". Fix them: dibs hours 09:00-23:00`);
}

// The person's working hours from config, or null when every hour is.
export function hours(cfg) {
  if (!cfg.hours) return null;
  minutes(cfg.hours.start); minutes(cfg.hours.end);
  return { start: cfg.hours.start, end: cfg.hours.end };
}

// Outside working hours, questions below urgent are held for the morning:
// they're kept, just not counted as needing the person now. A window whose end
// comes before its start runs past midnight.
export function offHours(cfg, t = now()) {
  const h = hours(cfg);
  if (!h) return false;
  const d = new Date(t), at = d.getHours() * 60 + d.getMinutes();
  const a = minutes(h.start), b = minutes(h.end);
  return a <= b ? at < a || at >= b : at < a && at >= b;
}
const held = (q, cfg, t) => q.state === OPEN && q.prio !== 'urgent' && offHours(cfg, t);

// The same idea as the queue's rank: arrival time, moved by priority.
const rank = q => q.asked - (PRIORITY_SHIFT[q.prio] || 0);
// Open ones first, the ones for now before the held ones, then the closed ones newest first.
function ordered(list, cfg, t) {
  const open = list.filter(q => q.state === OPEN).sort((a, b) => held(a, cfg, t) - held(b, cfg, t) || rank(a) - rank(b) || a.id - b.id);
  const closed = list.filter(q => q.state !== OPEN).sort((a, b) => (b.answeredAt || 0) - (a.answeredAt || 0));
  return [...open, ...closed];
}

// What the app and `dibs questions --json` see: no pids, and held as a flag.
const shown = (q, cfg, t) => ({
  id: q.id, who: q.who, agent: q.agent, session: q.session, text: q.text, options: q.options, prio: q.prio, purpose: q.purpose,
  asked: q.asked, due: q.due, state: q.state, answer: q.answer, answeredAt: q.answeredAt, answeredBy: q.answeredBy, waiting: !!q.pid, held: held(q, cfg, t),
  recommend: q.recommend ?? null, why: q.purpose || null, oneWay: !!q.oneWay, cantUndo: q.cantUndo ?? null, freeText: !!q.freeText,
});

// What `dibs questions --json` prints. dibs web reads it without the lock, as forYou does.
export function questionsJson(cfg, t = now(), list = ordered(asked(t).map(q => ({ ...q })), cfg, t)) {
  return { questions: list.map(q => shown(q, cfg, t)), hours: hours(cfg), open: list.filter(q => q.state === OPEN).length };
}

// For the board: open questions the person should look at now. Read without
// the lock, so plain `dibs` never waits on it; the reaping here isn't saved.
export function forYou(cfg, t = now()) {
  return asked(t).filter(q => q.state === OPEN && !held(q, cfg, t)).length;
}

// Every question kept, read the same way: for the agents' threads (src/talk.mjs).
export function asked(t = now()) {
  const s = load();
  reap(s, t);
  return s.questions;
}

function parseAsk(args) {
  const o = { words: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], next = () => args[++i] ?? die(`${a} needs a value`);
    if (a === '--options') { o.options = next().split(',').map(x => x.trim()).filter(Boolean); if (o.options.length < 2) die('--options takes two or more choices, e.g. --options yes,no'); }
    else if (a === '-p' || a === '--priority') { o.prio = priority(next()); if (!(o.prio in PRIORITY_SHIFT)) die(`priority is one of ${PRIORITIES.join(', ')} (or 1-5)`); }
    else if (a === '-m' || a === '--msg') o.purpose = next();
    else if (a === '--recommend') o.recommend = next().trim();
    else if (a === '--one-way') o.oneWay = next().trim();
    else if (a === '--timeout') o.timeout = ms(next());
    else if (a === '--wait') o.wait = true;
    else if (a === '--as') o.as = next();
    else if (a.startsWith('-') && a.length > 1) die(`unknown flag ${a}. Every flag: dibs help all`);
    else o.words.push(a);
  }
  o.text = o.words.join(' ').trim();
  return o;
}

// Real words: a short sentence, not "2" or "ok". On 2026-10-18 a question that
// read, in full, "2" reached the person.
const MIN_WORDS = 3;
const realWords = text => text.split(/\s+/).filter(w => /\p{L}{2,}/u.test(w)).length >= MIN_WORDS;
const USE = 'dibs question "Ship build 123 to TestFlight now?" --options yes,no --recommend yes -m "tests pass, notes written" --one-way "a TestFlight build can\'t be pulled from testers" --wait';

// What's wrong with a question as asked, or null. Refused before anything is recorded.
function junk(o) {
  if (!o.text) return `ask what? ${USE}`;
  if (!realWords(o.text)) return `"${o.text}" isn't a question anyone can answer: write it out in a short sentence of at least ${MIN_WORDS} words. Nothing was asked. ${USE}`;
  if (!o.recommend) return `say what you'd do: --recommend <option>, with -m "why". Without --one-way that's what happens, at once. Nothing was asked. ${USE}`;
  if (!o.purpose) return `say why you recommend ${o.recommend}: -m "why". Nothing was asked.`;
  if (o.options) {
    const seen = new Set(o.options.map(x => x.toLowerCase()));
    if (seen.size !== o.options.length) return `--options has the same choice twice (${o.options.join(', ')}). Nothing was asked.`;
    if (!seen.has(o.recommend.toLowerCase())) return `--recommend ${o.recommend} isn't one of the --options (${o.options.join(', ')}). Nothing was asked.`;
  }
  if (o.oneWay != null && !realWords(o.oneWay)) return `--one-way says what can't be undone, in a short sentence ("deleting the branch loses 3 unmerged commits"), not "${o.oneWay}". Nothing was asked.`;
  return null;
}

// dibs question "text" --recommend <option> -m why [--one-way "what can't be undone"] [--options a,b] [-p prio] [--wait] [--timeout 2h]
export async function question(args, cfg) {
  const o = parseAsk(args);
  const bad = junk(o);
  if (bad) die(bad);
  if (o.options) o.recommend = o.options.find(x => x.toLowerCase() === o.recommend.toLowerCase());
  const id = identity(o);
  const limit = o.wait ? o.timeout ?? defaultMaxWait() : o.timeout ?? Infinity;
  const t = now();
  const due = limit === Infinity ? null : t + limit;
  // The same question from the same asker, still open or with an answer it
  // hasn't read, is that one again: asking without --wait and later with it
  // collects the answer, and a wait that gave up picks its question back up.
  const q = locked(s => {
    let q = s.questions.find(x => x.text === o.text && isMine(x, id) && (x.state === OPEN || x.state === DECIDED || (!x.collected && x.state !== 'expired')));
    if (!q) {
      // Which of the session's agents asked, when the guard saw it, so the question lands in that agent's thread.
      const by = process.env.CLAUDE_CODE_SESSION_ID ? takeAgent('question', [], talkKey('question', args)) : null;
      q = { id: ++s.seq, who: id.who, agent: id.agent, label: id.label || by?.agentType || '', session: process.env.CLAUDE_CODE_SESSION_ID || null,
            agentId: by?.agentId || null,
            spid: id.spid, sstart: id.sstart, text: o.text, options: o.options || null, prio: o.prio || 'normal', purpose: o.purpose || '',
            asked: t, due, state: OPEN, answer: null, answeredAt: null, waits: !!o.wait, recommend: o.recommend,
            oneWay: o.oneWay != null, cantUndo: o.oneWay ?? null };
      // A two-way door: nobody is asked. The recommendation is the answer, now.
      if (!q.oneWay) Object.assign(q, { state: DECIDED, answer: o.recommend, answeredAt: t, decidedBy: id.agent || id.who, collected: true });
      s.questions.push(q);
    } else if (q.state === OPEN) {
      if (o.prio) q.prio = o.prio;
      if (o.options) q.options = o.options;
      if (o.purpose) q.purpose = o.purpose;
      // A session's question keeps its own --timeout; a later wait's limit is only the wait's.
      // (It once took the wait's --timeout as its own, so asking, then collecting with --wait
      // --timeout 1m, expired the question the moment that wait gave up.)
      if ((!o.wait && o.timeout != null) || (o.wait && q.waits)) q.due = due;
    }
    if (o.wait && q.state === OPEN) Object.assign(q, { pid: process.pid, pstart: pstart(process.pid), keepUntil: null });
    return { ...q };
  });
  if (q.state === DECIDED) {
    if (q.asked === t) event({ kind: 'override', act: 'decided', question: q.id, who: tag(q), answer: q.answer, why: q.purpose, by: q.decidedBy, byAgent: true });
    say(`decided by ${q.decidedBy}: two-way door, so nobody was asked. Go ahead with ${q.answer}. It's logged, and the person sees it as done; they'll message you if they want it otherwise.`
      + ' Bring a question to the person only when it can\'t be undone: --one-way "what can\'t be undone".');
    console.log(q.answer);
    return;
  }
  if (!o.wait) {
    console.log(q.id);
    if (q.state === OPEN)
      say(`question ${q.id} is queued for the person${heldNote(q, cfg)}. Keep working; to get the answer, run the same command with --wait.`);
    else say(`question ${q.id} was already ${q.state}${q.answer != null ? `: ${q.answer}` : ''}. Run the same command with --wait to read the answer.`);
    return;
  }
  say(`waiting for the person to answer question ${q.id}${heldNote(q, cfg)}. ${waitTerms(o, limit, t)}`);
  for (;;) {
    const cur = load().questions.find(x => x.id === q.id);
    if (cur?.state === 'answered') {
      locked(s => { const x = s.questions.find(x => x.id === q.id); if (x) x.collected = true; });
      // stdout stays the bare answer; who gave it goes beside it.
      if (cur.answeredBy) say(`answered by ${cur.answeredBy}, an agent, not the person.`);
      console.log(cur.answer);
      return;
    }
    if (!cur || cur.state !== OPEN) {
      locked(s => { const x = s.questions.find(x => x.id === q.id); if (x) x.collected = true; });
      die(`question ${q.id} was ${cur ? cur.state : 'removed'} without an answer. Nothing was decided: carry on without it, or ask differently.`, 75);
    }
    if (due && now() >= due) {
      // Let go, but keep the question open long enough for a rerun to find it.
      locked(s => { const x = s.questions.find(x => x.id === q.id && x.pid === process.pid); if (x) Object.assign(x, { pid: null, keepUntil: now() + KEEP_PLACE }); });
      die(`no answer to question ${q.id} by ${clock(due)} (exit 75: nothing was decided). ${q.waits ? 'It stays open 2 minutes' : 'It stays open for the person'}: run the same command again to keep waiting.`, 75);
    }
    await sleep(POLL);
  }
}

const heldNote = (q, cfg) => (held(q, cfg, now()) ? ` (it's outside the person's hours, ${cfg.hours.start} to ${cfg.hours.end}, so it waits for ${cfg.hours.start} unless it's urgent)` : '');

function waitTerms(o, limit, t) {
  if (limit === Infinity)
    return o.timeout == null
      ? "No time limit. If this tool call reaches its timeout, Claude Code moves it to the background and tells you when the answer comes. Don't ask again meanwhile."
      : 'No time limit.';
  return `This wait gives up at ${clock(t + limit)} with exit 75.`;
}

// dibs questions [--json] | dibs questions dismiss <id>
export function questions(args, cfg) {
  if (args[0] === 'dismiss') return dismiss(args.slice(1));
  const json = args.includes('--json');
  const bad = args.find(a => a !== '--json');
  if (bad) die(`unknown ${bad.startsWith('-') ? 'flag' : 'word'} ${bad}. Try: dibs questions [--json], dibs questions dismiss <id>`);
  const t = now();
  const list = ordered(locked(s => s.questions.map(q => ({ ...q }))), cfg, t);
  if (json) return console.log(JSON.stringify(questionsJson(cfg, t, list), null, 1));
  const open = list.filter(q => q.state === OPEN);
  const later = open.filter(q => held(q, cfg, t)).length;
  const out = [bold(open.length ? `${open.length} open question${open.length > 1 ? 's' : ''}${later ? ` (${later} held until ${cfg.hours.start})` : ''}, most urgent first.` : 'No open questions.')];
  for (const q of open) {
    const flags = [q.prio !== 'normal' ? q.prio : '', q.pid ? 'an agent is waiting on it' : '', held(q, cfg, t) ? 'for tomorrow' : ''].filter(Boolean).join(', ');
    out.push('', `  #${q.id}  ${tag(q)} asked ${dur(t - q.asked)} ago${flags ? amber(`  [${flags}]`) : ''}`);
    out.push(wrap(`      ${q.text}${q.options ? `  (${q.options.join(' / ')})` : ''}`, '      '));
    if (q.recommend) out.push(wrap(`      They recommend ${q.recommend}${q.purpose ? `: ${q.purpose}` : ''}`, '      '));
    else if (q.purpose) out.push(dim(wrap(`      ${q.purpose}`, '      ')));
    if (q.cantUndo) out.push(amber(wrap(`      Can't be undone: ${q.cantUndo}`, '      ')));
  }
  if (open.length) {
    const q = open[0];
    out.push('', `Answer: dibs answer ${q.id} ${q.recommend || (q.options ? q.options[0] : '"..."')} (or your own words)    Dismiss: dibs questions dismiss ${q.id}`);
  }
  const closed = list.filter(q => q.state !== OPEN).slice(0, RECENT);
  if (closed.length) out.push('', 'Recently closed');
  for (const q of closed)
    out.push(dim(`  #${q.id}  ${q.state}${q.answer != null ? ` "${q.answer}"` : ''} ${dur(t - q.answeredAt)} ago, ${tag(q)}: ${q.text}`));
  console.log(out.join('\n'));
}

// Close an open question as the person: answer or dismiss it. change returns
// a reason the answer won't do, if it won't. Refusals die after the lock is
// let go: process.exit skips the finally that would let it go.
function close(idArg, verb, change) {
  const n = Number(idArg);
  if (!idArg || !Number.isInteger(n)) die(`which question? dibs ${verb} <id> (the ids: dibs questions)`);
  const who = actor();
  const r = locked(s => {
    const q = s.questions.find(x => x.id === n);
    if (!q) return { no: [`no question ${n}. See them: dibs questions`, 1] };
    if (q.state !== OPEN) return { no: [`question ${n} is already ${q.state}${q.answer != null ? ` ("${q.answer}")` : ''}`, 1] };
    const no = change(q);
    if (no) return { no: [no, 2] };
    q.answeredAt = now();
    if (who.agent && q.state === 'answered') q.answeredBy = who.name;
    return { q: { ...q } };
  });
  if (r.no) die(...r.no);
  // The history shows these decisions next to the other overrides, with who made them.
  event({ kind: 'override', act: verb.split(' ').pop(), question: n, who: tag(r.q), answer: r.q.answer, by: who.name, byAgent: who.agent });
  return r.q;
}

// dibs answer <id> <text>: one of its options, or any words. Words that pick
// no option are the answer too, and reach the asker as a message as well, so
// the person can reply in words instead of picking.
export function answer(args) {
  const [idArg, ...rest] = args;
  const text = rest.join(' ').trim();
  if (!text) die('answer with what? dibs answer <id> <text>');
  const q = close(idArg, 'answer', q => {
    const a = q.options?.find(x => x.toLowerCase() === text.toLowerCase());
    Object.assign(q, { state: 'answered', answer: a ?? text, ...(a == null && { freeText: true }) });
  });
  if (q.freeText) messageAsker(q, q.answer);
  console.log(`answered question ${q.id} for ${tag(q)}: ${q.answer}${q.pid ? '' : q.freeText ? '. It reaches them as a message too, with their next tool call.' : ". They aren't waiting on it now; they'll get it when they ask again."}`);
}

function dismiss(args) {
  const q = close(args[0], 'questions dismiss', q => { q.state = 'dismissed'; });
  console.log(`dismissed question ${q.id} from ${tag(q)}`);
}

// dibs hours [09:00-23:00 | off] [--json]: show or set the person's working hours.
export function hoursCmd(args, cfg) {
  const json = args.includes('--json');
  const word = args.find(a => a !== '--json');
  if (args.some(a => a.startsWith('-') && a !== '--json')) die('dibs hours takes 09:00-23:00, off, or --json');
  if (word) {
    let set = null;
    if (word !== 'off') {
      const [start, end, extra] = word.split('-');
      if (extra != null || readTime(start) == null || readTime(end) == null || readTime(start) === readTime(end))
        die(`can't read hours "${word}". Use: dibs hours 09:00-23:00 (an end before the start runs past midnight), or dibs hours off`);
      set = { start: start.padStart(5, '0'), end: end.padStart(5, '0') };
    }
    const c = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
    c.hours = set;
    const tmp = `${paths.config}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
    fs.renameSync(tmp, paths.config);
    logChange('hours', { hours: set, from: cfg.hours || null });
    cfg = loadConfig();
  }
  const h = hours(cfg);
  if (json) return console.log(JSON.stringify(h));
  console.log(h ? `hours ${h.start} to ${h.end}: outside them, questions below urgent wait for ${h.start}. Clear: dibs hours off`
    : 'no hours set: questions reach you any time. Set: dibs hours 09:00-23:00');
}
