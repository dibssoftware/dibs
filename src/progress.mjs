// dibs progress: agents narrating their work as they go, as often as they
// commit. Each post is one line in progress.jsonl: who, which task, what just
// happened, and when the task should be done. The person reads it on the web
// page (src/web.mjs) and through its MCP tools; agents read each other's with
// plain `dibs progress`.
//
// Appends only, one write per post, so no lock: a line under the size cap goes
// down whole even with several agents posting at once. Past MAX_FILE the file is
// renamed to progress.1.jsonl (replacing the one before) and a new one starts. A
// rename loses nothing: a post being written lands in whichever file it opened.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.mjs';
import { identity, sessionFiles } from './proc.mjs';
import { die, now, deadline, dur, clock } from './util.mjs';
import { bold, dim } from './style.mjs';

export const FILE = path.join(HOME, 'progress.jsonl');
const OLDER = path.join(HOME, 'progress.1.jsonl');
// A post is a paragraph or two. Verbose is the point; a pasted log is not.
const MAX_TEXT = 2000;
const MAX_TASK = 80;
// About 10,000 posts a file, two files kept. Plenty of scrollback, and reading stays fast.
const MAX_FILE = 4 * 1024 ** 2;
// The plain list shows this many unless asked for more.
const RECENT = 30;
const STATES = ['doing', 'done', 'blocked'];
// A task still in progress past its ETA reads overdue. With no post for this long past
// both its last post and its ETA, it's taken for dropped (an agent that shipped and never
// said --done, a session that ended) and reads expired, not in progress. The page, the
// app (app/Dibs/Models/Progress.swift) and the notices use the same numbers.
export const EXPIRE_AFTER = 3 * 36e5;
// An open task whose agent hasn't posted this long: the agent hears about it once (src/notices.mjs).
export const QUIET_AFTER = 45 * 6e4;

function parse(args) {
  const o = { words: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => args[++i] ?? die(`${a} needs a value`);
    if (a === '--task' || a === '-t') o.task = val();
    else if (a === '--eta') o.eta = val();
    else if (a === '--done') o.state = 'done';
    else if (a === '--blocked') o.state = 'blocked';
    else if (a === '--as') o.as = val();
    else if (a === '--agent') o.agent = val();
    else if (a === '-n') o.n = Number(val());
    else if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else if (a.startsWith('-') && a.length > 1) die(`unknown flag ${a}. Try: dibs progress "ran the auth tests: 41 pass, 2 fail on token expiry" --task auth --eta 20m`);
    else o.words.push(a);
  }
  o.text = o.words.join(' ').trim();
  return o;
}

// The branch the agent is on, read straight from .git so posting costs no git process.
function branch(dir) {
  for (let d = dir, i = 0; i < 20; i++, d = path.dirname(d)) {
    const g = path.join(d, '.git');
    try {
      let head;
      if (fs.statSync(g).isFile()) {
        const real = fs.readFileSync(g, 'utf8').match(/gitdir: (.+)/)?.[1]?.trim();
        head = fs.readFileSync(path.join(path.resolve(d, real), 'HEAD'), 'utf8');
      } else head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8');
      return { root: d, branch: head.match(/ref: refs\/heads\/(.+)/)?.[1]?.trim() || head.trim().slice(0, 8) };
    } catch {}
    if (d === path.dirname(d)) break;
  }
  return { root: null, branch: null };
}

export async function post(args) {
  const o = parse(args);
  // dibs progress list: the open tasks. One word "list" is the command, never a post (2026-11-03: crews kept typing it).
  if (o.words.length === 1 && o.words[0] === 'list' && !o.task && !o.state && !o.eta) return openTasks(o);
  if (o.all) die('--all goes with dibs progress list');
  if (!o.text) return list(o);
  if (o.text.length > MAX_TEXT) die(`that's ${o.text.length} characters; keep a post under ${MAX_TEXT} and post again as you go. Nothing was posted.`);
  if (o.task && o.task.length > MAX_TASK) die(`--task is a short name (under ${MAX_TASK} characters), not a description. Nothing was posted.`);
  // Line breaks belong in the text; anywhere else they could make a post pass for someone else's line.
  if (o.task && /[\u0000-\u001f\u007f]/.test(o.task)) die('--task is one line, without control characters. Nothing was posted.');
  o.text = o.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  let eta = null;
  if (o.eta) {
    eta = deadline(o.eta);
    if (!(eta > now())) die(`--eta takes how long (20m, 2h) or a clock time (17:30), not ${o.eta}. Nothing was posted.`);
  }
  const id = identity(o);
  const session = process.env.CLAUDE_CODE_SESSION_ID || sessionFiles().find(f => f.pid === id.spid)?.sessionId || null;
  const where = branch(process.cwd());
  // Which subagent of the session posts, as the hook saw it ask (src/files.mjs):
  // its task is its own, and so is the nudge when it goes quiet. On 2026-11-03 a
  // lead got overdue notices for its teammates' tasks.
  const by = session ? (await import('./files.mjs')).takeAgent('progress', [], (await import('./files.mjs')).talkKey('progress', args)) : null;
  const p = {
    at: now(), who: id.who, ...((id.label || by?.agentType) && { label: id.label || by.agentType }), ...(session && { session }),
    ...(by?.agentId && by.agentId !== 'main' && { agentId: by.agentId }),
    project: path.basename(where.root || process.cwd()), ...(where.branch && { branch: where.branch }),
    ...(o.task && { task: o.task }), state: o.state || 'doing', ...(eta && { eta }), text: o.text,
  };
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(FILE, `${JSON.stringify(p)}\n`);
  rotate();
  // "done by" read as done to agents; and a closing post needs no nudge to keep posting.
  if (p.state !== 'doing') return console.log(`Posted${o.task ? ` to ${o.task}` : ''}, marked ${p.state}.`);
  console.log(`Posted${o.task ? ` to ${o.task}` : ''}${eta ? `, expected by ${clock(eta)}` : ''}. Keep posting as you go: dibs progress "..."`);
}

function rotate() {
  try { if (fs.statSync(FILE).size > MAX_FILE) fs.renameSync(FILE, OLDER); } catch {}
}

// Posts, oldest first. A torn or hand-edited line is skipped, not fatal.
export function read({ since = 0, agent = null, limit = Infinity } = {}) {
  let raw = '';
  for (const f of [OLDER, FILE]) { try { raw += fs.readFileSync(f, 'utf8'); } catch {} }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let p;
    try { p = JSON.parse(line); } catch { continue; }
    if (typeof p.at !== 'number' || typeof p.text !== 'string' || typeof p.who !== 'string') continue;
    if (p.at <= since || (agent && p.who !== agent)) continue;
    if (!STATES.includes(p.state)) p.state = 'doing';
    out.push(p);
  }
  return Number.isFinite(limit) ? out.slice(-limit) : out;
}

// Each agent's tasks, from its posts: the latest word on each, when it started,
// and when it should end. A post without --task belongs to the agent's
// untitled task in that project. One still doing past its ETA is overdue; one
// quiet past EXPIRE_AFTER is expired.
export function tasks(posts, at = now()) {
  const by = new Map();
  for (const p of posts) {
    // A subagent's task is its own, apart from its lead's of the same name.
    const key = `${p.who}\0${p.agentId || ''}\0${p.task || ''}\0${p.task ? '' : p.project || ''}`;
    let t = by.get(key);
    if (!t) by.set(key, t = { who: p.who, label: p.label || null, ...(p.agentId && { agentId: p.agentId }), task: p.task || null, project: p.project || null, branch: p.branch || null, started: p.at, posts: 0 });
    Object.assign(t, { last: p.at, state: p.state, text: p.text, branch: p.branch || t.branch, project: p.project || t.project, session: p.session || t.session || null });
    if (p.eta) t.eta = p.eta;
    if (p.state === 'doing' && t.state === 'doing' && t.doneAt) delete t.doneAt;
    if (p.state === 'done') t.doneAt = p.at;
    t.posts++;
  }
  for (const k of by.values()) {
    if (k.state !== 'doing') continue;
    const quiet = Math.max(k.last, k.eta || 0);
    if (at - quiet > EXPIRE_AFTER) Object.assign(k, { state: 'expired', expiredAt: quiet + EXPIRE_AFTER });
    else if (k.eta && k.eta < at) k.overdue = true;
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

// The open tasks of the caller's session (every agent in it), or every session's with
// --all: who owns each, its state, its ETA and its last post.
function openTasks(o) {
  const id = identity(o);
  const session = process.env.CLAUDE_CODE_SESSION_ID || sessionFiles().find(f => f.pid === id.spid)?.sessionId || null;
  const mine = p => o.all || (session ? p.session === session : p.who === id.who);
  const t = now();
  const open = tasks(read().filter(mine), t).filter(k => k.state === 'doing' || k.state === 'blocked');
  if (o.json) return console.log(JSON.stringify(open, null, 1));
  if (!open.length) return console.log(o.all ? 'No open tasks on this machine.' : 'Your session has no open tasks. Every session\'s: dibs progress list --all');
  for (const k of open) {
    const owner = `${k.who}${k.label ? `/${k.label}` : ''}`;
    const due = k.eta ? (k.overdue ? `overdue since ${clock(k.eta)}` : `expected by ${clock(k.eta)}`) : 'no ETA';
    console.log(`${bold(k.task || `(untitled, in ${k.project || 'a folder'})`)}  ${owner}  ${k.state}, ${due}, last post ${dur(t - k.last)} ago`);
    console.log(`  ${k.text.replace(/\s*\n\s*/g, ' ').slice(0, 300)}`);
  }
  console.log(dim(`Close one: dibs progress "what's done" --task <name> --done${o.all ? '' : '. Every session\'s: dibs progress list --all'}`));
}

function list(o) {
  const posts = read({ agent: o.agent, limit: o.n > 0 ? o.n : RECENT });
  if (o.json) return console.log(JSON.stringify(posts, null, 1));
  if (!posts.length) return console.log('No progress posted yet. Post as you work: dibs progress "what just happened" --task <name> --eta 20m');
  const t = now();
  for (const p of posts) {
    const tag = [p.task, p.state !== 'doing' && p.state].filter(Boolean).join(', ');
    console.log(`${dim(`${dur(t - p.at)} ago`)}  ${bold(p.who)}${tag ? ` [${tag}]` : ''}${p.eta && p.state === 'doing' ? dim(` expected by ${clock(p.eta)}`) : ''}`);
    console.log(`  ${p.text}`);
  }
}
