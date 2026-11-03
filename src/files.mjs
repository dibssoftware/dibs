// File leases: `dibs hold files:src/auth/**` keeps other agents' edits off
// those paths, and the guard hook turns their Edit, Write and obvious Bash
// writes away while the lease lasts. A lease is a resource named
// files:<absolute path or glob>, queued and reaped like any other hold. The
// hook half of this file runs on every tool call: it imports nothing from dibs
// but util.mjs, reads state.json without the lock (it's written by rename) and
// spawns nothing unless another session's lease covers the path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dur, clock, fakeFull, callerPid } from './util.mjs';

export const FILES = 'files:';
export const isFiles = r => typeof r === 'string' && r.startsWith(FILES);
// What a file lease costs: one holder at a time per path, and nothing from the
// memory, CPU or disk budgets, since holding a path runs nothing.
export const FILES_COST = { slots: 1, mem: 0, cpu: 0, disk: 0, pausable: false };

// * and ? stay inside one folder, ** crosses folders. [ is literal: Next.js
// routes are named [id].
const GLOB = /[*?]/;

export function gitRoot(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// Whether lease l was taken from another worktree of the repo whose worktree
// w a git write rewrites. git stash or reset --hard in wt-a never touches
// wt-b's copy of a file, which is all wt-b's lease covers; mapping every
// worktree onto one name made the whole repo look leased to anyone stashing
// in Atlas's 70 worktrees. A lease with no cwd (an older dibs) still counts.
function sibling(l, w) {
  if (!w || typeof l.cwd !== 'string') return false;
  const theirs = worktreeOf(real(path.resolve(l.cwd)));
  return !!theirs && theirs[1] === w[1] && theirs[0] !== w[0];
}

// ----- other sessions' temp folders -----
// Claude Code keeps each session's scratch files in <tmp>/claude-<uid>/<project
// folder>/<session id>/. The person's rule: an agent deletes or overwrites
// only in its own session's folder there (subagents share their parent's
// session id). A cleanup deleted another agent's live folder twice on
// 2026-10-16. Reads are fine anywhere.

// Every spelling of the temp root: as written, and with symlinks resolved.
let tmpRoots = null;
export function claudeTmp() {
  if (tmpRoots) return tmpRoots;
  const uid = process.getuid?.();
  if (uid == null) return (tmpRoots = []);
  // DIBS_CLAUDE_TMP: tests put the temp folder somewhere of their own.
  const bases = process.env.DIBS_CLAUDE_TMP ? [process.env.DIBS_CLAUDE_TMP]
    : ['/tmp', '/private/tmp', os.tmpdir(), process.env.TMPDIR, process.env.CLAUDE_CODE_TMPDIR].filter(Boolean);
  const roots = new Set();
  for (const b of bases) {
    const r = path.join(path.resolve(b), `claude-${uid}`);
    roots.add(r);
    roots.add(real(r));
  }
  return (tmpRoots = [...roots]);
}

// For path p, written to: null when it's outside the temp root or in session's
// own folder, else the folder that isn't the caller's (the root, a project
// folder, another session's, or a glob that could be any of them).
function othersTmp(p, session) {
  for (const root of claudeTmp()) {
    if (!overlap(p, root)) continue;
    const rel = p.startsWith(root + '/') ? p.slice(root.length + 1).split('/') : [];
    if (rel.length >= 2 && rel[1] === session) return null;
    return rel.length >= 2 && !GLOB.test(rel[1]) ? path.join(root, rel[0], rel[1]) : root + (rel.length ? '/' + rel.slice(0, 2).join('/') : '');
  }
  return null;
}

// A $VAR path counts only when its literal start names another session: /private/tmp/claude-503/proj/<id>/$X.
function guessedOthers(prefix, session) {
  for (const root of claudeTmp()) {
    if (!prefix.startsWith(root + '/')) continue;
    const whole = prefix.slice(root.length + 1).split('/').slice(0, -1);
    if (whole.length >= 2 && whole[1] !== session && !GLOB.test(whole[1])) return path.join(root, whole[0], whole[1]);
  }
  return null;
}

// Inside a session's own folder its subagents share the scratchpad, so a
// recursive delete there could still take a sibling's work. dibs remembers
// which agent first wrote into each folder at the top of the scratchpad
// (scratch/<session>/<folder> in DIBS_HOME, made with wx so the first one
// wins without a lock), and a recursive delete of one is that agent's alone.
const UNTRACKED_MAX = 20;   // files: an older folder this small is cheap to lose, one bigger may be someone's work
const makersDir = session => path.join(dibsHome(), 'scratch', session);
const agentOf = input => input.agent_id || 'main';

// [session folder, the path's parts under it] when p is in one of the temp root's session folders.
function inSession(p) {
  for (const root of claudeTmp()) {
    if (!p.startsWith(root + '/')) continue;
    const rel = p.slice(root.length + 1).split('/');
    if (rel.length >= 2) return [path.join(root, rel[0], rel[1]), rel.slice(2)];
  }
  return null;
}

export function maker(session, name) {
  try { return JSON.parse(fs.readFileSync(path.join(makersDir(session), encodeURIComponent(name)), 'utf8')); } catch { return null; }
}

// Whether the folder at dir holds more than max files, stopping as soon as it does.
function bigger(dir, max) {
  const stack = [dir];
  let n = 0;
  while (stack.length) {
    let list;
    try { list = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      if (e.isDirectory()) stack.push(path.join(e.parentPath ?? e.path, e.name));
      else if (++n > max) return true;
    }
  }
  return false;
}

const agentName = m => (m.agent === 'main' ? 'the main thread' : m.type ? `${m.type} (${m.agent})` : m.agent);

// Why a recursive delete of p, in the caller's own session folder, would take
// what isn't the caller's to take, or null when it's fine.
function ownDelete(p, t, input) {
  const at = inSession(p);
  if (!at) return null;
  const [folder, rest] = at, pad = path.join(folder, 'scratchpad');
  const whole = what => `${p} is ${what}, which every agent of your session keeps its scratch files in, so ${t.why} can't delete all of it.\n`
    + 'Delete the folders in it that you made instead. If it really must all go, have the person delete it.';
  if (!rest.length) return whole("your session's temp folder");
  if (!overlap(path.join(folder, rest[0]), pad)) return null;
  if (rest.length === 1) return whole("your session's scratchpad");
  let names = [rest[1]];
  if (GLOB.test(rest[1])) {
    try { names = fs.readdirSync(pad).filter(n => overlap(path.join(pad, rest[1]), path.join(pad, n))); } catch { names = []; }
  }
  for (const n of names) {
    const m = maker(input.session_id, n), dir = path.join(pad, n);
    if (m && m.agent !== agentOf(input))
      return `${dir} in your session's scratchpad was made by ${agentName(m)}, another agent of your session, so ${t.why} can't delete it.\n`
        + `Ask ${m.agent === 'main' ? 'the main thread' : m.type || m.agent} whether it's done with it, or have the person delete it. Deleting single files in it is fine.`;
    if (!m && !namedBy(input.session_id, n, agentOf(input)) && bigger(names.length > 1 || rest.length === 2 ? dir : p, UNTRACKED_MAX))
      return `${dir} in your session's scratchpad holds more than ${UNTRACKED_MAX} files, and dibs can't tell which agent of your session made it (it's older than dibs's record), so ${t.why} can't delete it all.\n`
        + 'Ask the agents of your session whose it is, or have the person delete it. Deleting single files in it is fine.';
  }
  return null;
}

// Note the agent behind each write into a scratchpad folder nobody has written into yet.
// A program can make a scratchpad folder dibs doesn't see it write
// (xcodebuild -derivedDataPath scratchpad/dd made fix-app's 0.5 GB of derived
// data on 2026-10-18), so a folder that doesn't exist yet and is named
// anywhere in a command counts as made by whoever ran it. And an agent whose
// command named a folder dibs has no record of may delete it, whatever its size.
function noteMakers(input, split, written) {
  const made = new Set(), named = new Set(), gone = new Set();
  const top = p => {
    const at = inSession(real(p));
    return at && at[1][0] === 'scratchpad' && at[1].length >= 2 && !GLOB.test(at[1][1]) && path.basename(at[0]) === input.session_id
      ? [at[1][1], path.join(at[0], 'scratchpad', at[1][1])] : null;
  };
  for (const t of written) {
    if (t.guess != null) continue;
    const f = top(t.path);
    // A folder deleted whole (this call got past the guard) takes its record with it, for whoever makes the next one.
    if (f && t.recursive && real(t.path) === f[1]) gone.add(f[0]);
    if (f && !t.recursive && !['rm', 'rmdir', 'unlink', 'shred', 'find'].includes(t.why)) made.add(f[0]);
  }
  for (const p of namedPaths(input, split)) {
    const f = top(p);
    if (!f) continue;
    named.add(f[0]);
    if (!fs.existsSync(f[1])) made.add(f[0]);
  }
  for (const n of gone) { made.delete(n); named.delete(n); }
  if (!made.size && !named.size && !gone.size) return;
  // Best effort: a full disk or a race costs only a record, never the call.
  try {
    const dir = makersDir(input.session_id);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of gone) {
      const k = encodeURIComponent(n);
      for (const f of fs.readdirSync(dir)) if (f === k || f.startsWith(`${k}@`)) fs.rmSync(path.join(dir, f), { force: true });
    }
    let fresh = false;
    for (const n of made) {
      try { fs.writeFileSync(path.join(dir, encodeURIComponent(n)), JSON.stringify({ agent: agentOf(input), type: input.agent_type || null, at: Date.now() }), { flag: 'wx' }); fresh = true; }
      catch {}
    }
    // name@agent: encodeURIComponent turns any @ into %40, so these never meet a folder's own record.
    for (const n of named) fs.writeFileSync(path.join(dir, `${encodeURIComponent(n)}@${encodeURIComponent(agentOf(input))}`), '');
    if (fresh) pruneMakers();
  } catch {}
}
const namedBy = (session, name, agent) => fs.existsSync(path.join(makersDir(session), `${encodeURIComponent(name)}@${encodeURIComponent(agent)}`));

// Every word of a Bash command that could be a path in this session's folder,
// absolute: arguments anywhere (after dibs run's --, too), and --out=<path> values.
function namedPaths(input, split) {
  const cmd = input.tool_name === 'Bash' && input.tool_input?.command;
  if (typeof cmd !== 'string' || !(cmd.includes(input.session_id) || String(input.cwd).includes(input.session_id))) return [];
  return namedIn(cmd, typeof input.cwd === 'string' ? input.cwd : process.cwd(), input.session_id, split, 0);
}
// A script handed to a shell with -c is read the same way, from the folder the shell starts in:
// dibs run xcode-build -- sh -c '... -derivedDataPath <scratchpad>/dd-test' made 177 MB on
// 2026-10-20 that nobody could delete, since the path was one quoted word.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const NESTED = 3;   // sh -c "bash -c '...'" is as deep as anyone goes
function namedIn(cmd, cwd, session, split, depth) {
  const segs = split(cmd);
  if (!segs) return [];
  const out = [];
  for (const { name, args, dir } of commands(segs, cwd)) {
    if (!name) continue;
    args.forEach((w, k) => {
      // A script's own $VARS are its business: it's split again, with its own assignments.
      const shell = args[k - 1]?.text === '-c' && (k > 1 ? SHELLS.has(path.basename(args[k - 2].text)) : SHELLS.has(name));
      if (shell && depth < NESTED && dir) { out.push(...namedIn(w.text, dir, session, split, depth + 1)); return; }
      if (w.opaque) return;
      const v = w.text.startsWith('-') ? w.text.split('=').slice(1).join('=') : w.text;
      const p = v && expand(v);
      if (!p || (!path.isAbsolute(p) && !dir)) return;
      const abs = path.resolve(dir || '/', p);
      if (abs.includes(session)) out.push(abs);
    });
  }
  return out;
}

// Records of sessions whose temp folder is gone.
function pruneMakers() {
  const top = path.join(dibsHome(), 'scratch'), live = new Set();
  for (const root of claudeTmp()) {
    let projects = [];
    try { projects = fs.readdirSync(root); } catch {}
    for (const p of projects) { try { for (const s of fs.readdirSync(path.join(root, p))) live.add(s); } catch {} }
  }
  if (!live.size) return;   // the temp folder couldn't be read: keep everything
  for (const s of fs.readdirSync(top)) if (!live.has(s)) fs.rmSync(path.join(top, s), { recursive: true, force: true });
}

// mkdir's folders, which bashWrites leaves out: making a folder isn't a write to a leased file.
function mkdirs(input, split) {
  const segs = input.tool_name === 'Bash' && typeof input.tool_input?.command === 'string' && /\bmkdir\b/.test(input.tool_input.command) && split(input.tool_input.command);
  if (!segs) return [];
  const out = [];
  for (const { name, args, dir } of commands(segs, typeof input.cwd === 'string' ? input.cwd : process.cwd()))
    if (name === 'mkdir') for (const w of operands(args, new Set(['-m', '--mode']))) { const f = from(dir, w); if (f) out.push({ path: f.text, why: 'mkdir' }); }
  return out;
}

// The hook's answer for one tool call: a deny when it would delete or write in
// a temp folder that isn't this session's, or recursively delete what another
// agent of the session made in its own, else null.
export function tmpGuard(input, split) {
  if (!EDITS.has(input?.tool_name) && input?.tool_name !== 'Bash') return null;
  const session = input.session_id;
  if (typeof session !== 'string' || !session || !claudeTmp().length) return null;
  const written = targets(input, split, true);
  for (const t of written) {
    // interop's sweep of the shared scratchpad was find $S ... -exec rm -rf {} +, on 2026-10-16.
    if (t.bare) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
      `dibs: ${t.why} would delete everything in a folder named only by a variable dibs can't see the value of, so it's turned away: it might be another agent's or another session's folder.\n`
      + 'Write the path out, or set the variable earlier in the same command (S=/path/to/dir; rm -rf "$S"), so dibs can check it. A path with a literal end, like "$S/build", is fine.' } };
    const other = t.guess != null ? guessedOthers(t.guess, session) : othersTmp(real(t.path), session);
    const own = !other && t.recursive && t.guess == null ? ownDelete(real(t.path), t, input) : null;
    if (own) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `dibs: ${own}` } };
    if (!other) continue;
    const root = claudeTmp().find(r => other === r || other.startsWith(r + '/'));
    const shown = t.guess != null ? other : real(t.path);
    const whose = path.relative(root, other).split('/').length === 2 && !GLOB.test(other) ? "another Claude Code session's scratch folder"
      : "Claude Code's temp folder, which holds every session's scratch folders";
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `dibs: ${shown} ${shown === root ? `is ${whose}` : shown.startsWith(root + '/') ? `is in ${whose}` : `holds ${root}, every Claude Code session's temp folder`}, so ${t.why} can't delete or write there. `
        + `The person's rule: never delete or overwrite anything under ${root} except in your own session's folder (${session}). `
        + 'Another agent may be using those files right now. Ask the person, or that session, instead. Reading them is fine.',
    } };
  }
  noteMakers(input, split, [...written, ...mkdirs(input, split)]);
  return null;
}

// The path with symlinks resolved up to its first wildcard, so /tmp/x and
// /private/tmp/x are the same lease. The native call also returns the name as
// it is on disk: on macOS SRC/A.ts opens src/a.ts, and the JS one keeps the
// case you typed. Parts that don't exist yet stay as written.
function real(abs) {
  const segs = abs.split('/');
  let k = segs.findIndex(s => GLOB.test(s));
  if (k < 0) k = segs.length;
  for (let i = k; i > 1; i--) {
    try { return [fs.realpathSync.native(segs.slice(0, i).join('/')), ...segs.slice(i)].join('/'); } catch {}
  }
  return abs;
}

// macOS and Windows disks ignore letter case (and macOS Unicode normalization),
// so names that don't exist yet compare that way too. A case-sensitive volume
// there can only cause a refusal too many, never a write let through.
const FOLD = ['darwin', 'win32'].includes(process.platform);
const folded = s => (FOLD ? s.normalize('NFC').toLowerCase() : s);

// Every git worktree of a repo keys a file the same way: by its path in the
// main worktree (the one whose .git is a folder), so agents editing one file
// from two worktrees collide. Found by reading .git files, never by running
// git, since the hook does this on every tool call. Anything unexpected keeps
// the path as it is.
const trees = new Map();   // folder -> [the worktree it's in, that repo's main worktree], or null outside git

// The project a folder belongs to, for a resource that's one at a time per project
// (exclusiveBy: "repo", deploys): its repo's origin URL, the same in every clone and
// worktree of it; else that repo's main worktree; else the folder itself.
export function projectKey(dir) {
  const abs = path.resolve(dir);
  const wt = worktreeOf(real(abs));
  if (!wt) return abs;
  try {
    const url = fs.readFileSync(path.join(wt[1], '.git', 'config'), 'utf8').match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1];
    if (url) return url;
  } catch {}
  return wt[1];
}

function worktreeOf(dir) {
  if (trees.has(dir)) return trees.get(dir);
  let st = null, found = null;
  try { st = fs.statSync(path.join(dir, '.git')); } catch {}
  if (st?.isDirectory()) found = [dir, dir];
  else if (st?.isFile()) found = [dir, mainOf(dir) || dir];
  else if (path.dirname(dir) !== dir) found = worktreeOf(path.dirname(dir));
  trees.set(dir, found);
  return found;
}

// The main worktree of a linked worktree at dir, or null when its .git file
// isn't one: a submodule's points into .git/modules and has no commondir.
function mainOf(dir) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(dir, m[1]);
    let common;
    try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); }
    catch {
      if (path.basename(path.dirname(gitdir)) !== 'worktrees') return null;
      common = path.dirname(path.dirname(gitdir));
    }
    if (path.basename(common) === '.git') return fs.realpathSync(path.dirname(common));
    // A submodule's own worktrees: its checkout is core.worktree. A bare repo has none, so the repo itself stands in.
    let config = '';
    try { config = fs.readFileSync(path.join(common, 'config'), 'utf8'); } catch {}
    const w = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config);
    return fs.realpathSync(w ? path.resolve(common, w[1]) : common);
  } catch { return null; }
}

// An absolute path or glob with symlinks resolved (real), moved from the
// worktree it's in to the same place in the main one.
function canon(p) {
  if (!path.isAbsolute(p)) return p;
  try {
    const segs = p.split('/');
    let k = segs.findIndex(s => GLOB.test(s));
    if (k < 0) k = segs.length;
    const w = worktreeOf(segs.slice(0, k).join('/') || '/');
    return !w || w[0] === w[1] ? p : w[1] + p.slice(w[0].length);
  } catch { return p; }
}

// A stored file lease under the key this version gives it: an older dibs may
// have taken it under a worktree's own path.
export const fileKey = r => (isFiles(r) ? FILES + canon(r.slice(FILES.length)) : r);

// ' in another copy of this repo (wt-trust)' when lease l was taken from a
// different worktree of the repo cwd is in, else ''.
export function elsewhere(l, cwd = process.cwd()) {
  try {
    if (typeof l?.cwd !== 'string') return '';
    const mine = worktreeOf(real(path.resolve(cwd))), theirs = worktreeOf(real(l.cwd));
    if (!mine || !theirs || mine[1] !== theirs[1] || mine[0] === theirs[0]) return '';
    return ` in another copy of this repo (${path.basename(theirs[0])})`;
  } catch { return ''; }
}

const expand = p => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);

// files:<path or glob> as stored: absolute, relative paths taken from the git
// root (or the folder, outside git), and in the main worktree (canon). Null
// for an empty one.
// A list of resources as typed, split at its commas, with each file lease's
// braces expanded the way a shell would: 'files:src/{a.ts,b/c.ts},test' is
// files:src/a.ts, files:src/b/c.ts and test. dibs's globs don't know braces,
// and a comma inside them split one lease into two on 2026-10-15, the second
// a resource named after a file that waited on the machine like a job.
const BRACES = 64;   // more names than this from one lease is a typo, not a list
export function resList(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of text) {
    if (c === '{') depth++;
    else if (c === '}' && depth) depth--;
    if (c === ',' && !depth) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.filter(Boolean).flatMap(r => (isFiles(r) ? braces(r) : [r]));
}
function braces(r) {
  const open = r.indexOf('{');
  let depth = 0, close = -1;
  for (let i = open; open >= 0 && i < r.length; i++) {
    if (r[i] === '{') depth++;
    else if (r[i] === '}' && !--depth) { close = i; break; }
  }
  if (close < 0) return [r];
  const parts = [];
  let cur = '';
  depth = 0;
  for (const c of r.slice(open + 1, close)) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (c === ',' && !depth) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  if (parts.length < 2) return [r];
  return parts.flatMap(p => braces(r.slice(0, open) + p + r.slice(close + 1))).slice(0, BRACES);
}

export function fileRes(r, cwd = process.cwd()) {
  if (!isFiles(r)) return r;
  const p = r.slice(FILES.length).trim();
  if (!p) return null;
  return FILES + canon(real(path.resolve(gitRoot(cwd) || cwd, expand(p))));
}

// How a lease reads to a person: relative to the git root you're in, else from ~.
export function short(r, cwd = process.cwd()) {
  if (!isFiles(r)) return r;
  const p = r.slice(FILES.length);
  const root = gitRoot(cwd) && real(gitRoot(cwd));
  for (const r of root ? [canon(root), root] : []) if (p.startsWith(r + '/')) return FILES + p.slice(r.length + 1);
  const home = os.homedir();
  return FILES + (p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p);
}

function segRe(s) {
  return new RegExp(`^${s.replace(/\*+/g, '*').split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
}

// Could one path name match both segments? Two wildcards are compared only by
// what's fixed at each end; anything subtler counts as a yes.
function segment(x, y) {
  const gx = GLOB.test(x), gy = GLOB.test(y);
  if (!gx && !gy) return x === y;
  if (!gx) return segRe(y).test(x);
  if (!gy) return segRe(x).test(y);
  const head = s => s.slice(0, s.search(GLOB));
  const tail = s => s.slice(Math.max(s.lastIndexOf('*'), s.lastIndexOf('?')) + 1);
  const [hx, hy, tx, ty] = [head(x), head(y), tail(x), tail(y)];
  return (hx.startsWith(hy) || hy.startsWith(hx)) && (tx.endsWith(ty) || ty.endsWith(tx));
}

// One running out before the other means a folder and something inside it.
function walk(a, i, b, j) {
  if (i === a.length || j === b.length) return true;
  if (a[i] === '**') return walk(a, i + 1, b, j) || walk(a, i, b, j + 1);
  if (b[j] === '**') return walk(a, i, b, j + 1) || walk(a, i + 1, b, j);
  return segment(a[i], b[j]) && walk(a, i + 1, b, j + 1);
}

// Do two paths or globs (with or without files:) share any file? The same
// file, a folder and anything under it, or globs some name could match both.
// Unsure counts as yes. Both are keyed by the main worktree first (canon), so
// a lease an older dibs stored under a worktree's own path still counts.
export function overlap(a, b) {
  const segs = p => folded(canon(p.replace(FILES, ''))).split('/').filter(Boolean);
  return walk(segs(a), 0, segs(b), 0);
}

// Two resource names that can't both be held by different sessions at once.
export const clash = (a, b) => a === b || (isFiles(a) && isFiles(b) && overlap(a, b));

// ----- the hook -----

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const dibsHome = () => process.env.DIBS_HOME || path.join(os.homedir(), '.dibs');
const statePath = () => path.join(dibsHome(), 'state.json');

// A pid still running. EPERM means it runs as someone else, which still counts.
const running = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Live file leases, read without the lock: state.json is replaced by rename,
// so a read sees a whole file. A dead holder or a hold past its time no longer
// counts, though only the next dibs call takes it off the books.
function leases(t = Date.now()) {
  let s;
  try { s = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return (s.leases || []).filter(l => Array.isArray(l.res) && l.res.some(isFiles)
    && (l.kind !== 'hold' || t < l.expires) && (!l.pid || running(l.pid)));
}

// The pids above this hook, from one process-table read. Claude Code runs the
// hook, so its session is among them.
let above = null;
function ancestors() {
  if (above) return above;
  const up = new Map();
  for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    up.set(pid, ppid);
  }
  above = new Set();
  for (let p = callerPid(); p > 1 && !above.has(p); p = up.get(p)) above.add(p);
  return above;
}

// A lease is the caller's when it was taken by the same agent (when stamped)
// of the session running this hook. Without a session (a terminal, a test),
// the same DIBS_AGENT name. A lease the main thread took covers its own
// subagents (coversAgent).
function mine(l, input) {
  if (!coversAgent(l, { agentId: input.agent_id || 'main' })) return false;
  if (l.sessionId && typeof input.session_id === 'string') return l.sessionId === input.session_id;
  const session = l.spid || (l.kind === 'hold' ? l.pid : null);
  if (session) return ancestors().has(session);
  return !!process.env.DIBS_AGENT && [l.who, l.agent].includes(process.env.DIBS_AGENT);
}

// Words before the program that don't change what it writes, each with its
// flags that take a value.
const PREFIXES = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t', '-T'], command: [], nohup: [], time: ['-o'], exec: ['-a'], builtin: [],
  nice: ['-n'], env: ['-u', '--unset', '-C', '--chdir', '-S'], caffeinate: ['-t', '-w'], npx: ['-p', '--package'], bunx: ['-p', '--package'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], gtimeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-J', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '-R', '-S'],
};
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN = new Set(['exec', 'dlx', 'x']);

// The words that aren't flags. Everything after -- counts, and a flag that
// takes a value takes the next word with it.
function operands(args, valued = new Set()) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === '--') { out.push(...args.slice(k + 1)); break; }
    if (t.startsWith('-') && t.length > 1) { if (valued.has(t)) k++; continue; }
    out.push(args[k]);
  }
  return out;
}

// sed -i (GNU) and sed -i '' (macOS): every word after the script is a file it rewrites.
function sedFiles(args) {
  let inPlace = false, script = false;
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === '-i' || t === '-I') {
      inPlace = true;
      const n = args[k + 1]?.text;
      if (n === '' || n?.startsWith('.')) k++;   // macOS takes the backup suffix as its own word
    }
    else if (t.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(t)) inPlace = true;
    else if (t === '-e' || t === '-f') { script = true; k++; }
    else if (t.startsWith('--expression') || t.startsWith('--file')) script = true;
    else if (t.startsWith('-') && t.length > 1) continue;
    else if (!script) script = true;
    else files.push(args[k]);
  }
  return inPlace ? files : [];
}

// perl -pi -e '...' files.
function perlFiles(args) {
  if (!args.some(w => /^-[a-zA-Z]*i/.test(w.text))) return [];
  let code = false;
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (/^-[a-zA-Z]*[eE]$/.test(t)) { code = true; k++; }
    else if (!t.startsWith('-')) files.push(args[k]);
  }
  return code ? files : files.slice(1);
}

// A word as an absolute path from folder dir, or null when that can't be known.
function from(dir, w) {
  const p = !w.opaque && expand(w.text);
  return p && (dir || path.isAbsolute(p)) ? { ...w, text: path.resolve(dir || '/', p) } : null;
}
const isDir = (dir, w) => { try { return fs.statSync(from(dir, w).text).isDirectory(); } catch { return false; } };
const exists = (dir, w) => { try { return !!fs.statSync(from(dir, w).text); } catch { return false; } };

// Where cp, mv, ln, install and rsync write. Into a folder, each source lands
// under its own name: cp a.ts src/ writes src/a.ts and nothing else there. A
// recursive copy of a folder's contents (cp -R lib/ src) can overwrite
// anything in it, so that counts as the whole folder. mv also takes its
// sources away, which writes them too.
function copies(name, args, dir) {
  const t = args.findIndex(w => w.text === '-t' || w.text === '--target-directory');
  const o = operands(args, new Set(['-S', '--suffix', '-t', '--target-directory']));
  const to = t >= 0 ? args[t + 1] : o.length >= 2 ? o.at(-1) : null;
  if (!to) return [];
  // rsync --delete removes whatever else is in the folder it copies into.
  if (name === 'rsync' && args.some(w => w.text.startsWith('--delete'))) return [{ ...to, recursive: true }];
  const srcs = t >= 0 ? o : o.slice(0, -1);
  const gone = name === 'mv' ? srcs : [];
  const folder = t >= 0 || (!args.some(w => w.text === '-T') && (to.text.endsWith('/') || isDir(dir, to)));
  if (!folder || to.opaque) return [...gone, to];
  const recursive = name === 'rsync' || args.some(w => /^-[a-zA-Z]*[rRa]/.test(w.text) || w.text === '--recursive' || w.text === '--archive');
  const whole = srcs.some(s => s.opaque || (recursive && s.text.endsWith('/')));
  return [...gone, ...(whole ? [to] : srcs.map(s => ({ ...to, text: path.join(to.text, path.basename(s.text)) })))];
}

// git -C <dir> runs in that folder. rm, mv, restore and checkout write the
// paths they name: after --, or ones that exist (git checkout . reverts them
// all; git checkout main is a branch). stash, reset --hard, apply, clean,
// checkout -f, switch --discard-changes and an --autostash pull, rebase or
// merge rewrite files nobody named, so they count as writing the whole repo.
// Those, and checkout, restore and clean of named paths, only touch the copy
// in the worktree they run in (tree), never a sibling worktree's.
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
function gitWrites(args, dir, input) {
  let k = 0, at = dir;
  for (; args[k]?.text.startsWith('-'); k += GIT_VALUED.has(args[k].text) ? 2 : 1)
    if (args[k].text === '-C') at = args[k + 1] ? from(at, args[k + 1])?.text ?? null : null;
  const sub = args[k]?.text, rest = args.slice(k + 1), has = (...f) => rest.some(w => f.includes(w.text));
  const root = () => (at ? [{ text: gitRoot(at) || at, opaque: false, tree: true }] : []);
  let out = [];
  if (sub === 'rm' || sub === 'mv') return operands(rest).map(w => from(at, w)).filter(Boolean);
  if (sub === 'restore') {
    // --staged alone changes the index, not a file.
    if (has('-S', '--staged') && !has('-W', '--worktree', '-SW', '-WS')) return [];
    out = operands(rest, new Set(['-s', '--source']));
  }
  else if (sub === 'checkout') {
    const dd = rest.findIndex(w => w.text === '--');
    out = dd >= 0 ? rest.slice(dd + 1) : operands(rest, new Set(['-b', '-B', '--orphan'])).filter(w => exists(at, w));
    if (!out.length && has('-f', '--force')) return root();
  }
  else if (sub === 'switch') return has('-f', '--force', '--discard-changes') ? root() : [];
  else if (['pull', 'rebase', 'merge'].includes(sub)) return has('--autostash') ? root() : [];
  else if (sub === 'stash') return ['list', 'show', 'drop', 'clear', 'create', 'store'].includes(rest[0]?.text) ? [] : root();
  else if (sub === 'reset') return has('--hard', '--merge', '--keep') ? root() : [];
  else if (sub === 'apply' || sub === 'am') return has('--check', '--stat', '--numstat', '--summary', '--cached', '--show-current-patch') ? [] : patched(rest, at, input);
  else if (sub === 'clean') {
    if (has('-n', '--dry-run')) return [];
    out = operands(rest, new Set(['-e', '--exclude']));
    if (!out.length) return root();
  }
  return out.map(w => from(at, w)).filter(Boolean).map(w => ({ ...w, tree: true }));
}

// The files a git apply or git am writes, read from the patches it's given:
// new content, so each counts as an edit to that file, with the
// cross-worktree check edits get. A patch dibs can't read (stdin, a pipe, a
// $VAR, a missing or huge file, a quoted name) or an am picking up where it
// stopped counts as writing the whole repo, every worktree's leases included.
const PATCH_VALUED = new Set(['-p', '-C', '--exclude', '--include', '--directory', '--whitespace', '--build-fake-ancestor', '--patch-format', '--resolvemsg']);
const PATCH_MAX = 4 << 20;   // bytes: the hook stays fast, and a patch this big is a release, not an edit
function patched(rest, at, input) {
  const whole = at ? [{ text: gitRoot(at) || at, opaque: false }] : [];
  const named = operands(rest, PATCH_VALUED);
  const files = named.length ? named : input ? [{ text: input, opaque: false }] : [];
  if (!files.length || rest.some(w => /^--(continue|skip|abort|quit|resolved|retry)$|^-r$/.test(w.text))) return whole;
  let strip = 1, dir = '';
  rest.forEach((w, k) => {
    const v = w.text === '-p' ? rest[k + 1]?.text : /^-p(\d+)$/.exec(w.text)?.[1];
    if (v != null && /^\d+$/.test(v)) strip = +v;
    if (w.text === '--directory') dir = rest[k + 1]?.text ?? '';
    else if (w.text.startsWith('--directory=')) dir = w.text.slice(12);
  });
  const base = path.join(gitRoot(at || '/') || at || '/', dir);
  const out = [];
  for (const f of files) {
    const names = f.text !== '-' && readNames(from(at, f)?.text, strip);
    if (!names) return whole;
    out.push(...names.map(n => ({ text: path.join(base, n), opaque: false })));
  }
  return out;
}

// The paths in the patch file at abs, -p strip removed, or null when it can't be read.
function readNames(abs, strip) {
  try { return abs && fs.statSync(abs).size <= PATCH_MAX ? patchNames(fs.readFileSync(abs, 'utf8'), strip) : null; } catch { return null; }
}

// patch writes the file it's given (patch x.c fix.diff), its -o output, or
// the files its patch names, from -i or < file, relative to -d. Without -p
// GNU and BSD patch disagree on what's left of a name, and a patch read from a
// pipe can't be seen, so those count as writing the whole folder.
const PATCHER_VALUED = new Set(['-d', '--directory', '-i', '--input', '-o', '--output', '-p', '--strip', '-D', '--ifdef', '-F', '--fuzz',
  '-r', '--reject-file', '-B', '--prefix', '-Y', '--basename-prefix', '-z', '--suffix', '-V', '--version-control', '-g', '--get', '--quoting-style']);
function patchWrites(args, dir, input) {
  if (args.some(w => ['--dry-run', '-C', '--check'].includes(w.text))) return [];
  const value = (short, long) => {
    for (let k = 0; k < args.length; k++) {
      const t = args[k].text;
      if (t === short || t === long) return args[k + 1] ?? null;
      if (t.startsWith(`${long}=`)) return { ...args[k], text: t.slice(long.length + 1) };
      if (t.length > 2 && t.startsWith(short)) return { ...args[k], text: t.slice(2) };
    }
    return null;
  };
  const d = value('-d', '--directory'), out = value('-o', '--output'), ops = operands(args, PATCHER_VALUED);
  if (out) return out.text === '-' ? [] : [out];
  if (ops.length) return [ops[0]];
  const at = d ? from(dir, d)?.text ?? null : dir;
  const whole = d ? [d] : [{ text: '.', opaque: false }];
  const p = value('-p', '--strip'), i = value('-i', '--input');
  if (!at || !p || p.opaque || !/^\d+$/.test(p.text) || i?.opaque) return whole;
  const names = readNames(i ? from(at, i)?.text : input, +p.text);   // patch moves to -d before it reads -i
  return names ? names.map(n => ({ text: path.join(at, n), opaque: false })) : whole;
}

// The paths a unified or git diff touches, relative to where it applies, or
// null when one can't be read safely. --- and +++ count only as a pair right
// before a hunk, so a removed line starting with -- doesn't name a file.
function patchNames(text, strip) {
  const lines = text.split('\n'), out = new Set();
  const cut = p => {
    if (p === '/dev/null') return true;
    if (p.startsWith('"')) return false;
    const segs = p.split('/');
    if (segs.length <= strip) return false;
    out.add(segs.slice(strip).join('/'));
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    const m = /^(rename|copy) (from|to) (.+)$/.exec(l);
    if (m) { if (m[3].startsWith('"')) return null; out.add(m[3]); continue; }
    const g = /^diff --git (\S+) (\S+)$/.exec(l);
    if (g) { if (!cut(g[1]) || !cut(g[2])) return null; continue; }
    if (l.startsWith('diff --git ')) return null;   // a name with a space or quotes
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && lines[i + 2]?.startsWith('@@')) {
      // A tab ends the name in plain diffs (a timestamp follows).
      for (const side of [l.slice(4), lines[i + 1].slice(4)]) if (!cut(side.replace(/\r$/, '').split('\t')[0])) return null;
      i += 2;
    }
  }
  return out.size ? [...out] : null;
}

// Formatters and fixers that rewrite the files they're given in place: when
// one of `when` is there (none: always), unless one of `unless` is. sub: their
// subcommands, which aren't files. all: given no files, they do the whole folder.
const FORMATTERS = {
  prettier: { when: ['--write', '-w'] },
  eslint: { when: ['--fix'], all: true },
  gofmt: { when: ['-w'] },
  goimports: { when: ['-w'] },
  'clang-format': { when: ['-i'] },
  'swift-format': { when: ['-i', '--in-place'], sub: ['format', 'lint'] },
  swiftformat: { unless: ['--lint', '--dryrun'] },
  rustfmt: { unless: ['--check'] },
  black: { unless: ['--check', '--diff'], all: true },
  ruff: { when: ['format', '--fix'], unless: ['--check', '--diff'], sub: ['format', 'check'], all: true },
  biome: { when: ['--write', '--apply', '--fix'], sub: ['format', 'check', 'lint'], all: true },
};
const FORMAT_VALUED = new Set(['-c', '--config', '--config-path', '--ignore-path', '--plugin', '--log-level', '--parser', '--ext', '--rule',
  '-f', '--format', '-o', '--output-file', '--max-warnings', '--cache-location', '--swiftversion', '--rules', '--disable', '--enable',
  '--exclude', '--indent', '--line-length', '--target-version', '--edition']);
function formatted(f, args) {
  const has = list => args.some(w => list.includes(w.text));
  if ((f.when && !has(f.when)) || (f.unless && has(f.unless))) return [];
  const o = operands(args, FORMAT_VALUED);
  if (f.sub?.includes(o[0]?.text)) o.shift();
  return o.length || !f.all ? o : [{ text: '.', opaque: false }];
}

// find -delete, or find -exec rm (and the like), removes what it finds under
// its starting points: the words before its first test, or the folder it runs in.
const FIND_REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate', 'mv']);
function findDeletes(args) {
  const removes = args.some((w, k) => w.text === '-delete' || (/^-(exec|execdir|ok|okdir)$/.test(w.text) && FIND_REMOVERS.has(path.basename(args[k + 1]?.text || ''))));
  return removes ? findRoots(args).map(w => ({ ...w, recursive: true })) : [];
}
function findRoots(args) {
  const k = args.findIndex(w => /^[-(!]/.test(w.text));
  const from = args.slice(0, k < 0 ? args.length : k);
  return from.length ? from : [{ text: '.', opaque: false }];
}

// $NAME and ${NAME} in a word, from assignments earlier in the same command
// (S=/x; find $S, export S=/x) or the hook's own environment, so a path in a
// variable is checked like one typed out. Anything else ($(...), ${X:-y}, $1,
// a name set nowhere) leaves the word unknown.
function resolved(w, vars) {
  if (!w.opaque || /\$\(|`/.test(w.text)) return w;
  let unknown = false;
  const text = w.text.replace(/\$\{(\w+)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => {
    const v = vars[a || b] ?? process.env[a || b];
    if (v == null) unknown = true;
    return v ?? m;
  });
  return unknown || text.includes('$') ? w : { ...w, text, opaque: false };
}
const assign = (w, vars) => { const k = w.text.indexOf('='); vars[w.text.slice(0, k)] = w.text.slice(k + 1); };

// The words a command writes to, for the commands that obviously write, from
// folder dir. Most are as typed; ones worked out here are absolute.
function writtenBy(name, args, dir, input) {
  const ops = (valued = []) => operands(args, new Set(valued));
  if (FORMATTERS[name]) return formatted(FORMATTERS[name], args);
  switch (name) {
    // A recursive delete takes a whole folder: rm -r, rmdir -p.
    case 'rm': case 'rmdir': {
      const deep = args.some(w => (name === 'rm' ? /^-[a-zA-Z]*[rR]/.test(w.text) || w.text === '--recursive' : /^-[a-zA-Z]*p/.test(w.text) || w.text === '--parents'));
      return deep ? ops().map(w => ({ ...w, recursive: true })) : ops();
    }
    case 'unlink': case 'shred': case 'touch': case 'tee': return ops();
    case 'truncate': return ops(['-s', '--size', '-r', '--reference']);
    case 'cp': case 'mv': case 'ln': case 'install': case 'rsync': return copies(name, args, dir);
    case 'sed': case 'gsed': return sedFiles(args);
    case 'perl': return perlFiles(args);
    case 'find': return findDeletes(args);
    case 'dd': return args.filter(w => w.text.startsWith('of=')).map(w => ({ ...w, text: w.text.slice(3) }));
    case 'git': return gitWrites(args, dir, input);
    case 'patch': return patchWrites(args, dir, input);
    default: return [];
  }
}

// Is this redirect target written to? Read the operator just before it:
// > >> &> >| <> write, < and <<< read, and >&2 is a file descriptor.
function redirOp(src, w) {
  let k = w.start - 1;
  while (src[k] === ' ' || src[k] === '\t') k--;
  let op = '';
  while (k >= 0 && '<>&|'.includes(src[k])) op = src[k--] + op;
  return op;
}
function redirWrites(src, w) {
  const op = redirOp(src, w);
  return op.includes('>') && !(op.endsWith('&') && /^(\d+|-)$/.test(w.text));
}

// Each simple command of a split shell line: its program, its arguments, all
// its words, and the folder it runs in, following cd, pushd and popd. A cd in
// a ( ) subshell ends with it. After a cd we can't follow, the folder is null
// and only absolute paths are known. A command run by xargs also gets the
// words of the command piped into it, which is where its files come from.
function* commands(segs, cwd) {
  let dir = cwd, last = null, depth = 0, prev = null;   // last: where cd - goes
  const outer = [], pushed = [], vars = {};
  for (const seg of segs) {
    const d = seg.depth ?? 0;
    while (depth < d) outer[depth++] = [dir, last];
    while (depth > d) [dir, last] = outer[--depth];
    const words = seg.filter(w => !w.redir).map(w => resolved(w, vars));
    let i = 0, xargs = null;
    for (let t; (t = words[i]) && !t.opaque;) {
      const b = path.basename(t.text);
      if (ASSIGN.test(t.text)) assign(t, vars);
      if (KEYWORDS.has(t.text) || ASSIGN.test(t.text)) { i++; continue; }
      // npx prettier, pnpm exec eslint, yarn prettier: the tool they run.
      const next = words[i + 1]?.text;
      if (PM.has(b) && (RUN.has(next) || FORMATTERS[next])) { i += RUN.has(next) ? 2 : 1; continue; }
      if (!PREFIXES[b]) break;
      const at = i++;
      while (words[i]?.text.startsWith('-')) i += PREFIXES[b].includes(words[i].text) ? 2 : 1;
      if (b === 'timeout' || b === 'gtimeout') i++;   // the duration
      if (b === 'xargs') xargs = words.slice(at + 1, i);
    }
    const [prog, ...own] = words.slice(i);
    const name = prog && !prog.opaque ? path.basename(prog.text) : null;
    if (name === 'export' || name === 'declare' || name === 'readonly') for (const w of own) if (ASSIGN.test(w.text) && !w.opaque) assign(w, vars);
    // xargs -I puts its input where it likes, so the files can't be placed.
    // What find prints is everything under its starting points, so find | xargs rm deletes them all.
    const fed = xargs && seg.pipe && prev && !xargs.some(w => /^-[IJ]/.test(w.text)) ? prev : null;
    const piped = !fed ? [] : path.basename(fed[0]?.text || '') === 'find' ? findRoots(fed.slice(1)).map(w => ({ ...w, recursive: true })) : operands(fed.slice(1));
    const args = [...own, ...piped];
    if (name === 'cd' || name === 'pushd') {
      const to = args.find(w => w.text === '-' || !w.text.startsWith('-'));
      const p = to && !to.opaque && expand(to.text);
      const was = dir;
      if (name === 'pushd') pushed.push(dir);
      if (!to) dir = name === 'cd' ? os.homedir() : null;
      else if (p === '-' && name === 'cd') dir = last;
      else if (!p || p === '-' || /^[+-]\d+$/.test(p)) dir = null;   // pushd +1 goes where we didn't follow
      else dir = path.isAbsolute(p) ? p : dir && path.resolve(dir, p);
      last = was;
    }
    else if (name === 'popd') dir = pushed.length ? pushed.pop() : null;
    yield { seg, name, args, dir };
    prev = words;
  }
}

// Paths a Bash command writes: redirect targets, and the files of rm, mv, cp,
// tee, touch, sed -i and the like, from the folder it runs in (following cd).
// Words built from $VARS or $(...) can't be known and are skipped.
// guesses: also each $VAR word's text up to its first $ or `, as { guess },
// and whether the word is only a variable or $(...) ($S, "$S"/*, "$(pwd)"): bare.
const BARE = /^(\$(\{\w+\}|\w+)|\$\([^)]*\)|`[^`]*`)(\/\*?)?$/;
export function bashWrites(cmd, split, cwd, guesses = false) {
  const segs = typeof cmd === 'string' && split(cmd);
  if (!segs) return [];
  const out = [];
  for (const { seg, name, args, dir } of commands(segs, cwd)) {
    const add = (w, why) => {
      if (w.opaque && guesses) out.push({ guess: expand(w.text.split(/[$`]/)[0]), why, ...(w.recursive && { recursive: true, bare: BARE.test(w.text) }) });
      if (w.opaque) return;
      const p = expand(w.text);
      if (!p || p.startsWith('/dev/') || (!path.isAbsolute(p) && !dir)) return;
      out.push({ path: path.resolve(dir || '/', p), why, ...(w.tree && { tree: true }), ...(w.recursive && { recursive: true }) });
    };
    for (const w of seg) if (w.redir && redirWrites(cmd, w)) add(w, 'a > redirect');
    // A file fed in with <, which git apply and patch read their patch from.
    const fed = seg.find(w => w.redir && redirOp(cmd, w) === '<');
    const input = fed && !fed.opaque ? from(dir, fed)?.text ?? null : null;
    if (name && name !== 'cd') for (const w of writtenBy(name, args, dir, input)) add(w, name);
  }
  return out;
}

// ----- which agent of a session took a lease -----
// Claude Code tells a hook which subagent or teammate made a tool call
// (agent_id), but gives the Bash command itself nothing to tell them apart. So
// when the hook sees `dibs hold|run|release` with files: in a Bash call, it
// leaves a note saying which agent asked, and that dibs claims the note and
// stamps its lease. The main thread is the agent "main". A lease without a
// stamp (no guard, or dibs run from a script) belongs to its whole session.

// A note waits this long for its command: a permission prompt can sit a while.
const NOTE_LIFE = 10 * 6e4;
const notesDir = () => path.join(dibsHome(), 'agents');
const noteKey = (verb, res) => `${verb}|${res.filter(isFiles).sort().join(',')}`;
const LEASE_VERBS = new Set(['hold', 'run', 'release']);
// Looks at the board and the queue, noted too, so they can tell the calling
// subagent's own jobs from its siblings' (dibs why, dibs mine, plain dibs).
const READ_VERBS = new Set(['status', 'why', 'mine', 'who', 'when', 'yield']);
// Acting on a job, noted so dibs can tell whether it's the caller's own (src/override.mjs).
const ACT_VERBS = new Set(['boost', 'pause', 'resume', 'stop']);
const ALIASES = { done: 'release', renew: 'hold', ls: 'status', board: 'status' };
// dibs say and dibs question go in the asking agent's own thread (src/talk.mjs),
// and dibs later tells that thread how the job ended (src/later.mjs). Their
// note is keyed by the words, so subagents saying "done" at once each get
// their own. A word the hook can't read ($VAR) matches any one word.
// Every other call is keyed the same way, by all its words, so two subagents
// running `dibs run sim -- ...` at once each claim their own note.
const TALK_VERBS = new Set(['say', 'question', 'later']);
export const talkKey = (verb, words) => `${verb}|${words.join('\0')}`;
// A word the hook can't read ("files:$R/a.ts", $(...)) stands for any one word.
const WILD = '\u0001';
const wordsKey = (verb, words) => talkKey(verb, words.map(w => (w.opaque ? WILD : w.text)));
const keyWords = k => { const i = k.indexOf('|'); return [k.slice(0, i), ...k.slice(i + 1).split('\0')]; };
function fits(noted, key) {
  if (noted === key || !noted.includes(WILD)) return noted === key;
  const a = keyWords(noted), b = keyWords(key);
  return a.length === b.length && a.every((w, i) => w === b[i] || (i > 0 && w === WILD));
}

// The key dibs claims its note by: its own arguments after the verb, as the hook saw them.
export function callKey(verb, argv = process.argv.slice(2)) {
  const first = ALIASES[argv[0]] || argv[0];
  return talkKey(verb, first === verb ? argv.slice(1) : argv);
}

// The dibs calls in a Bash command, by verb, with the file leases they name
// as dibs itself will name them, and the key their note goes under.
export function dibsCalls(cmd, split, cwd) {
  const segs = typeof cmd === 'string' && /\bdibs/.test(cmd) && split(cmd);
  if (!segs) return [];
  const out = [];
  for (const { name, args, dir } of commands(segs, cwd)) {
    if (!/^dibs(\.mjs)?$/.test(name || '') || !dir) continue;
    const dd = args.findIndex(w => w.text === '--');
    const own = dd < 0 ? args : args.slice(0, dd);
    const res = own.filter(w => !w.opaque).flatMap(w => resList(w.text)).filter(isFiles).map(r => fileRes(r, dir)).filter(Boolean);
    let verb = ALIASES[own[0]?.text] || own[0]?.text;
    if (TALK_VERBS.has(verb)) {
      out.push({ verb, res: [], key: wordsKey(verb, own.slice(1)) });
      continue;
    }
    // No verb: with a command after -- it's a run (dibs sim -- cmd); with only flags, the board.
    const typed = LEASE_VERBS.has(verb) || READ_VERBS.has(verb) || ACT_VERBS.has(verb);
    if (!typed) { if (dd >= 0) verb = 'run'; else if (!verb || verb.startsWith('-')) verb = 'status'; else continue; }
    out.push({ verb, res, key: wordsKey(verb, typed ? args.slice(1) : args) });
  }
  return out;
}

function noteAgent(input, split) {
  if (input.tool_name !== 'Bash' || typeof input.session_id !== 'string') return;
  const calls = dibsCalls(input.tool_input?.command, split, typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!calls.length) return;
  // Only a nicety (naming the subagent): a full disk must not cost the lease check after it.
  try {
    fs.mkdirSync(notesDir(), { recursive: true });
    for (const c of calls) {
      const note = { at: Date.now(), session: input.session_id, agent: input.agent_id || 'main', type: input.agent_type || null, key: c.key ?? noteKey(c.verb, c.res) };
      fakeFull('notes');
      fs.writeFileSync(path.join(notesDir(), `${note.at}-${process.pid}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(note));
    }
  } catch {}
}

// The agent the guard saw ask for this, or null: the newest note from this
// session whose words are this call's, claimed by rename so two dibs can't
// both take it. Old notes go. key overrides the lease key (dibs say and
// question pass talkKey's). When notes from two agents of the session both
// fit (the same words, or words the hook couldn't read), nobody can tell
// which one this is, so it's none: a lease without a stamp is the whole
// session's, and a stamp from the wrong subagent turned its sibling away from
// its own lease on 2026-10-16.
export function takeAgent(verb, res, key = noteKey(verb, res)) {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  let names;
  try { names = fs.readdirSync(notesDir()).filter(n => n.endsWith('.json')).sort().reverse(); } catch { return null; }
  const found = [];
  for (const n of names) {
    const f = path.join(notesDir(), n);
    let x;
    try { x = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (Date.now() - x.at > NOTE_LIFE) { fs.rmSync(f, { force: true }); continue; }
    if (session && x.session === session && typeof x.key === 'string' && fits(x.key, key)) found.push({ f, x });
  }
  if (new Set(found.map(n => n.x.agent)).size !== 1) return null;
  const got = found.find(n => n.x.key === key) || found[0];
  try { fs.renameSync(got.f, `${got.f}.taken`); } catch { return null; }
  fs.rmSync(`${got.f}.taken`, { force: true });
  return { agentId: got.x.agent, agentType: got.x.type };
}

// Two leases or requests from one session belong to the same agent, unless
// both are stamped with different ones.
export const sameAgent = (a, b) => !a.agentId || !b.agentId || a.agentId === b.agentId;
// Whether a lease lets this agent of its session through. The usual pattern is
// a lead taking the lease and handing the edit to a subagent, who would
// otherwise be turned away with nobody free to release it. So a lease the main
// thread took counts for its subagents, the way an unstamped one counts for the
// whole session. A subagent's lease still keeps its siblings and the main
// thread out, and only the agent that took a lease can release it (sameAgent).
export const coversAgent = (held, asking) => sameAgent(held, asking) || held.agentId === 'main';

// A list of resources as one shell word an agent can paste: a glob in it is
// quoted, or zsh expands files:src/** itself and fails with "no matches found".
export const shellRes = rs => {
  const s = [].concat(rs).join(',');
  return /[*?[\]{}~ ]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
};

// The paths a tool call would write, absolute.
function targets(input, split, guesses = false) {
  const ti = input.tool_input || {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  if (input.tool_name === 'Bash') return bashWrites(ti.command, split, cwd, guesses);
  const p = ti.file_path ?? ti.notebook_path;
  return typeof p === 'string' && p ? [{ path: path.resolve(cwd, expand(p)), why: input.tool_name }] : [];
}

// The hook's answer for one tool call: a deny naming the holder when it would
// write under another session's file lease, else null. split is the guard's
// shell reader, passed in so this file needn't load the guard's rules.
export function fileGuard(input, split) {
  if (!EDITS.has(input?.tool_name) && input?.tool_name !== 'Bash') return null;
  noteAgent(input, split);
  const live = leases();
  if (!live.length) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const t = Date.now();
  for (const target of targets(input, split)) {
    if (target.guess != null) continue;
    const p = canon(real(target.path));
    const tree = target.tree ? worktreeOf(real(target.path)) : null;
    for (const l of live) {
      const r = l.res.find(x => isFiles(x) && overlap(x, p));
      if (!r || mine(l, input) || sibling(l, tree)) continue;
      const name = l.agent || l.who;
      const holder = l.agentId && l.agentId !== 'main' ? `${name}'s subagent ${l.agentId}` : name;
      const until = l.kind === 'hold' ? `until ${clock(l.expires)}` : 'while its command runs';
      const ask = !(l.sessionId && l.sessionId === input.session_id) ? `Or SendMessage ${name} and ask.`
        : input.agent_id ? 'Another agent of your own session holds it: wait, or ask whoever is coordinating you.'
          : `Your own subagent ${l.agentId} holds it: wait for it to finish, or have it run dibs release.`;
      return { hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `dibs: ${short(FILES + p, cwd).slice(FILES.length)} is leased to ${holder}${elsewhere(l, cwd)}${l.label && l.label !== name ? ` (${l.label})` : ''}`
          + `${l.purpose ? ` for "${l.purpose}"` : ''} (${short(r, cwd)}, held ${dur(t - l.start)}, ${until}), so ${target.why} can't write to it now.\n`
          + `See when it frees up: dibs when ${shellRes(short(r, cwd))}\n`
          + `Wait for it and take it yourself: dibs hold ${shellRes(short(r, cwd))} -m "why". ${ask} Reading it is fine.`,
      } };
    }
  }
  return null;
}
