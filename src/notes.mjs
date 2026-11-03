// dibs init: telling the coding agents on this machine that dibs is here.
//
//   dibs.md     the agent instructions, made from skills/dibs/SKILL.md (one source,
//               no second copy to drift), in the folder dibs is installed in.
//               Rewritten on every install and upgrade, so it matches the version.
//   the block   a few marked lines in the agents' own instruction files saying to
//               read dibs.md before builds, tests, simulators or deploys:
//                 ~/.claude/CLAUDE.md          when ~/.claude exists (made if missing)
//                 ~/.codex/AGENTS.md           when ~/.codex exists (made if missing)
//                 CLAUDE.md and AGENTS.md at the root of the git repo dibs runs in,
//                 when that isn't the home folder: only files already there, unless
//                 asked with dibs init --repo
//
// Only what's between the markers is ever written; the rest of a file stays byte for
// byte. Each write goes to a temp file beside the real one, with its mode, then is
// renamed over it: a full disk once emptied a file written in place. A symlinked
// file is written where the link points, so the link stays a link.
// DIBS_NO_AGENT_NOTES=1 turns all of it off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.mjs';
import { VERSION } from './version.mjs';
import { die } from './util.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = '<!-- dibs:start -->', END = '<!-- dibs:end -->';
const BLOCK_RE = /<!-- dibs:start -->[\s\S]*?<!-- dibs:end -->(\r?\n)?/;
// Which version and folder the notes were last written for (src/notes.mjs stale()).
const STAMP = path.join(HOME, 'notes.json');
export const off = () => !!process.env.DIBS_NO_AGENT_NOTES && process.env.DIBS_NO_AGENT_NOTES !== '0';

// The agent instructions: SKILL.md without its front matter and title, under a header
// saying where it came from.
export function dibsMd(root = ROOT) {
  let skill = '';
  try { skill = fs.readFileSync(path.join(root, 'skills', 'dibs', 'SKILL.md'), 'utf8'); } catch {}
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*# dibs\s*\n/, '').trim();
  return [
    '# dibs: instructions for coding agents',
    '',
    `Written by dibs ${VERSION} when it was installed here, and rewritten on every install and upgrade, so edits don't last.`,
    `Docs: https://dibs.cc, and ${path.join(root, 'README.md')}. Every command: \`dibs help all\`.`,
    '',
    body || 'Run builds, tests, simulators and deploys through dibs: `dibs run <resource> -m "why" -- <command>`. `dibs help` lists everything.',
    '',
  ].join('\n');
}

export const block = file => [START, '## dibs',
  `This machine runs dibs, the CLI that coding agents use to share simulators, builds, tests and deploys. Read ${file} before running builds, tests, simulators or deploys. Docs: https://dibs.cc`,
  END].join('\n');

// Write whole and rename into place, keeping the old file's mode.
function writeAtomic(file, text) {
  let real = file, mode = 0o644;
  try { real = fs.realpathSync(file); mode = fs.statSync(real).mode & 0o7777; } catch {}
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = `${real}.dibs-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, real);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

// text with the block in it: replaced where the markers are, else added at the end.
// Line endings follow the file's own.
export function withBlock(text, b) {
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const mine = b.replace(/\n/g, nl);
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, (m, end) => mine + (end || ''));
  if (!text) return mine + nl;
  const gap = text.endsWith(nl + nl) ? '' : text.endsWith(nl) ? nl : nl + nl;
  return text + gap + mine + nl;
}
// text without the block. At the end of the file, the blank line withBlock put in front goes too.
export function withoutBlock(text) {
  const m = text.match(BLOCK_RE);
  if (!m) return text;
  let before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  if (!after) before = before.replace(/(\r?\n)\r?\n$/, '$1');
  return before + after;
}

// The git repo the command runs in, unless it's the home folder itself.
function repoRoot(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    return top && path.resolve(top) !== path.resolve(os.homedir()) ? top : null;
  } catch { return null; }
}

// The instruction files the block goes in. made: may be created when missing.
function targets(cwd, repo) {
  const home = os.homedir(), out = [];
  if (fs.existsSync(path.join(home, '.claude'))) out.push({ file: path.join(home, '.claude', 'CLAUDE.md'), made: true });
  if (fs.existsSync(path.join(home, '.codex'))) out.push({ file: path.join(home, '.codex', 'AGENTS.md'), made: true });
  const top = repoRoot(cwd);
  if (top) {
    const there = ['CLAUDE.md', 'AGENTS.md'].map(n => path.join(top, n)).filter(f => fs.existsSync(f));
    for (const f of there) out.push({ file: f, made: false });
    if (repo && !there.length) out.push({ file: path.join(top, 'CLAUDE.md'), made: true });
  }
  return out;
}

// Where dibs.md goes: the install folder, or ~/.dibs when that can't be written
// (an npm install owned by root, say).
function mdPlace(root) {
  const f = path.join(root, 'dibs.md');
  try { fs.accessSync(root, fs.constants.W_OK); return f; } catch { return path.join(HOME, 'dibs.md'); }
}

// Write dibs.md and the blocks. Returns the files that changed.
export function write({ root = ROOT, cwd = process.cwd(), repo = false } = {}) {
  const changed = [];
  const md = mdPlace(root);
  const text = dibsMd(root);
  let old = null;
  try { old = fs.readFileSync(md, 'utf8'); } catch {}
  if (old !== text) { writeAtomic(md, text); changed.push(md); }
  const b = block(md);
  for (const t of targets(cwd, repo)) {
    let cur = null;
    try { cur = fs.readFileSync(t.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (cur == null && !t.made) continue;
    const next = withBlock(cur || '', b);
    if (next !== cur) { writeAtomic(t.file, next); changed.push(t.file); }
  }
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(STAMP, JSON.stringify({ version: VERSION, root })); } catch {}
  return changed;
}

// Take dibs.md and every block back out. Returns the files that changed.
export function remove({ root = ROOT, cwd = process.cwd() } = {}) {
  const changed = [];
  for (const md of new Set([path.join(root, 'dibs.md'), path.join(HOME, 'dibs.md')])) {
    if (fs.existsSync(md)) { fs.rmSync(md); changed.push(md); }
  }
  for (const t of targets(cwd, false)) {
    let cur;
    try { cur = fs.readFileSync(t.file, 'utf8'); } catch { continue; }
    const next = withoutBlock(cur);
    if (next !== cur) { writeAtomic(t.file, next); changed.push(t.file); }
  }
  try { fs.rmSync(STAMP, { force: true }); } catch {}
  return changed;
}

// Whether the notes are behind this version or this folder: an npm install has no
// install script to write them (the package runs no scripts, by design), so its
// first dibs command after an install or upgrade does.
export function stale(root = ROOT) {
  if (off()) return false;
  try { const s = JSON.parse(fs.readFileSync(STAMP, 'utf8')); return s.version !== VERSION || s.root !== root; } catch { return true; }
}

// dibs init [--repo] [--remove] [--quiet]
export function init(args) {
  const bad = args.find(a => !['--repo', '--remove', '--quiet'].includes(a));
  if (bad) die(`unknown ${bad}. dibs init [--repo] [--remove]`);
  if (off()) return console.log('DIBS_NO_AGENT_NOTES is set, so dibs leaves the agents\' instruction files alone.');
  const quiet = args.includes('--quiet');
  const changed = args.includes('--remove') ? remove() : write({ repo: args.includes('--repo') });
  for (const f of changed) console.log(`${args.includes('--remove') ? 'cleaned' : 'wrote'} ${f}`);
  if (!changed.length && !quiet) console.log('Nothing to change: dibs.md and the notes are up to date.');
}
