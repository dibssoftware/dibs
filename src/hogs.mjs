// Who is filling the disk. When free disk is under minDisk, or a waiter is
// held for disk, the throttle watcher measures the session folders in Claude
// Code's temp folder (claude-<uid>/<project>/<session>), keeps the biggest in
// hogs.json, and leaves each one's agent a notice once per time the disk goes
// under. On 2026-10-19 one session's scratchpad held 58 git worktrees with a
// node_modules each, 18 GB, the Mac sat under the floor, and every agent
// waiting saw only "free disk". dibs why and the wait name the biggest, so a
// waiting agent knows whom to ask: only that session (or the person) may
// delete there (tmpGuard in src/files.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME, paths } from './config.mjs';
import { claudeTmp, maker } from './files.mjs';
import { gb, bytes, now } from './util.mjs';
import { warnOnce, clean, cleanDue } from './diskwarn.mjs';

const FILE = path.join(HOME, 'hogs.json');
// Folders smaller than this aren't worth a notice: deleting them wouldn't get the disk back over the floor.
const HOG_MIN = () => Number(process.env.DIBS_HOG_MIN) || 2 * 1024 ** 3;
const TOP = 3;   // how many of the biggest hear about it
const REMEASURE = 10 * 6e4;   // while under, how often the sizes are read again: du over 18 GB takes a while
const OVER = 1024 ** 3;   // free disk must come back this far over the floor before the next drop counts as new
const DU_TIMEOUT = 120e3;
// The writer: what grew most between two readings. On 2026-10-20 the Mac kept
// falling under the floor and no session folder was big, so nobody knew what to
// free. Readings are taken from twice the floor down, so the first drop has one to compare with.
const GROW_MIN = 512 * 1024 ** 2;   // less than this in 10 minutes is the usual churn
// Places outside any session that fill a disk. DIBS_HOG_PLACES ({label: path}) stands in for them in tests.
function places() {
  if (process.env.DIBS_HOG_PLACES) return JSON.parse(process.env.DIBS_HOG_PLACES);
  const h = os.homedir(), work = path.join(HOME, 'work');
  return process.platform === 'darwin'
    ? { simulators: path.join(h, 'Library/Developer/CoreSimulator'), 'Xcode build output': path.join(h, 'Library/Developer/Xcode/DerivedData'),
        caches: path.join(h, 'Library/Caches'), "dibs's copies of other machines' jobs": work }
    : { caches: path.join(h, '.cache'), "dibs's copies of other machines' jobs": work };
}
const GB = b => gb(b).replace(/G$/, ' GB');

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
function write(x) {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(x));
  fs.renameSync(tmp, FILE);
}

// Every session folder under the temp roots, by its real path.
function sessionFolders() {
  const out = new Set();
  for (const root of claudeTmp()) {
    let projects = [];
    try { projects = fs.readdirSync(root); } catch { continue; }
    for (const p of projects) {
      try { for (const s of fs.readdirSync(path.join(root, p))) out.add(fs.realpathSync(path.join(root, p, s))); } catch {}
    }
  }
  return [...out];
}

// { path: bytes } for each folder and everything two levels in (its
// scratchpad's folders), from one du over them all. A folder du can't finish
// keeps what it printed.
function sizes(folders) {
  return new Promise(resolve => {
    if (!folders.length) return resolve({});
    execFile('du', ['-k', '-d', '2', ...folders], { timeout: DU_TIMEOUT, maxBuffer: 1 << 22 }, (_, stdout) => {
      const out = {};
      for (const line of String(stdout || '').split('\n')) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (m) out[m[2]] = +m[1] * 1024;
      }
      resolve(out);
    });
  });
}

// What fills a folder, as a few words: git worktrees and node_modules, the usual weight.
function contents(folder) {
  let worktrees = 0, modules = 0;
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (list.some(e => e.name === '.git' && e.isFile())) worktrees++;
    for (const e of list) {
      if (!e.isDirectory() || e.name === '.git') continue;
      if (e.name === 'node_modules') { modules++; continue; }
      if (depth < 4) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(folder, 0);
  if (worktrees > 1) return `${worktrees} git worktrees${modules >= worktrees ? ', node_modules in each' : modules ? `, ${modules} node_modules folders` : ''}`;
  return modules > 1 ? `${modules} node_modules folders` : '';
}

// Who to tell about a session's folder: the session's name from dibs's own
// records, and the agent that made its biggest scratchpad folder (src/files.mjs
// notes it), else the session's main thread.
function ownerOf(folder, session, size) {
  let who = null;
  for (const f of [paths.state, path.join(HOME, 'messages.json')]) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      const x = [...(s.leases || []), ...(s.queue || []), ...(s.threads || [])].find(x => (x.sessionId || x.session) === session && x.who);
      if (x) { who = x.who; break; }
    } catch {}
  }
  const pad = path.join(folder, 'scratchpad') + '/';
  const top = Object.entries(size).filter(([p]) => p.startsWith(pad) && !p.slice(pad.length).includes('/')).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const m = top && maker(session, top[0].slice(pad.length));
  return { who, agentId: m?.agent || 'main', type: m?.type || null };
}

// Whether the disk is short: under the floor, or short for a waiter's own declared need.
function short(cfg, m, s) {
  if (m.diskFree == null) return false;
  const floor = bytes(cfg.minDisk);
  return m.diskFree < floor || (s.queue || []).some(q => q.pid && q.disk && m.diskFree < q.disk);
}

// One pass, from the throttle watcher: measure on a new drop (and every
// REMEASURE while it lasts), and leave the biggest folders' agents a notice
// once per drop. Never throws.
let busy = false;
export async function hogsOnce(cfg, m, t = now()) {
  if (busy) return;
  busy = true;
  try {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch {}
    let was = read();
    const floor = bytes(cfg.minDisk);
    // The clearing first: measuring the folders can take a minute, and the clearing is what frees space.
    const critical = m.diskFree != null && m.diskFree < floor;
    if (m.diskFree != null && m.diskFree < 2 * floor && cleanDue(was, t, critical)) {
      write(was = { ...was, cleaned: await clean(t), cleanedCritical: critical });
    }
    if (!short(cfg, m, s)) {
      if (was?.under && m.diskFree >= floor + OVER) write({ ...was, under: false, endedAt: t });
      else if (m.diskFree != null && m.diskFree < 2 * floor) {
        let x = was || {};
        if (!(t - (was?.readAt || 0) < REMEASURE)) {
          const folders = sessionFolders();
          write(x = { ...x, under: false, ...readings(folders, await sizes([...folders, ...Object.values(places())]), m, was, t) });
        }
        const keep = await warnOnce(cfg, m, x, hintOf(x), t);
        if (Object.keys(keep).length) write({ ...x, ...keep });
      }
      return;
    }
    const drop = was?.under ? was.drop : t;
    // Between measurements the notes still go out on time, from the last measurement.
    if (was?.under && t - was.at < REMEASURE) {
      const keep = await warnOnce(cfg, m, was, hintOf(was), t);
      if (Object.keys(keep).length) write({ ...was, ...keep });
      return;
    }
    const folders = sessionFolders();
    const size = await sizes([...folders, ...Object.values(places())]);
    const big = Object.entries(size).filter(([p, b]) => folders.includes(p) && b >= HOG_MIN()).sort((a, b) => b[1] - a[1]).slice(0, TOP)
      .map(([folder, b]) => ({ folder, session: path.basename(folder), bytes: b, what: contents(path.join(folder, 'scratchpad')) || contents(folder), ...ownerOf(folder, path.basename(folder), size) }));
    const waiting = (s.queue || []).filter(q => q.pid).length;
    const x = { ...(was?.cleaned && { cleaned: was.cleaned, cleanedCritical: was.cleanedCritical }), ...(was?.warned && { warned: was.warned }), under: true, drop, at: t, free: m.diskFree, floor, waiting, folders: big, ...readings(folders, size, m, was, t) };
    write(x);
    const keep = await warnOnce(cfg, m, x, hintOf(x), t);
    if (Object.keys(keep).length) write({ ...x, ...keep });
    const { notify } = await import('./talk.mjs');
    for (const h of big) {
      notify({ sessionId: h.session, agentId: h.agentId, who: h.who }, `diskhog:${drop}:${h.session}`,
        `your session's scratch folder ${h.folder} holds ${GB(h.bytes)}${h.what ? ` (${h.what})` : ''}. This machine is under its disk floor `
        + `(${GB(m.diskFree)} free, the floor is ${GB(floor)}) and ${waiting} ${waiting === 1 ? 'job waits' : 'jobs wait'}. `
        + 'Free what you can: remove merged worktrees (git worktree remove <path>), and symlink node_modules from one install instead of installing in each. '
        + 'Delete only exact paths your session made: other agents of your session may still use the rest.');
    }
  } catch {} finally { busy = false; }
}

// { label: bytes } for each session folder, each of places() and swap, and what grew most
// since the last reading (no older than 3 REMEASURE, so a stale one can't name anything).
function readings(folders, size, m, was, t) {
  const now = {};
  for (const f of folders) if (size[f] != null) now[`session ${path.basename(f)}'s scratch folder`] = size[f];
  for (const [label, p] of Object.entries(places())) if (size[p] != null) now[label] = size[p];
  if (m.swapUsed != null) now.swap = m.swapUsed;
  let writer = null;
  if (was?.readings && t - was.readAt <= 3 * REMEASURE) {
    for (const [label, b] of Object.entries(now)) {
      const by = b - (was.readings[label] ?? b);
      if (by >= GROW_MIN && (!writer || by > writer.by)) writer = { label, by, ms: t - was.readAt };
    }
  }
  return { readings: now, readAt: t, writer };
}

// For a disk wait: what's growing and the biggest folder and whose it is, as words to add, or ''.
export function hogHint(t = now()) {
  const x = read();
  if (!x?.under || t - x.at >= 3 * REMEASURE) return '';
  return hintOf(x);
}
function hintOf(x) {
  const w = x.writer;
  const grew = w ? `. Growing fastest: ${named(w.label, x)}, up ${GB(w.by)} in ${Math.max(1, Math.round(w.ms / 6e4))} min` : '';
  const h = x.folders?.[0];
  if (!h) return grew;
  const name = h.who || `session ${h.session.slice(0, 8)}`;
  return `${grew}. The most is in ${name}'s scratch folder (${GB(h.bytes)}${h.what ? `, ${h.what}` : ''}): ask ${h.who ? `${h.who} (SendMessage)` : 'that session'} to free it, or the person`;
}
// A session's folder by its agent's name when dibs knows it.
function named(label, x) {
  const m = /^session (.+)'s scratch folder$/.exec(label);
  const h = m && x.folders?.find(f => f.session === m[1]);
  return h?.who ? `${h.who}'s scratch folder` : m ? `session ${m[1].slice(0, 8)}'s scratch folder` : label;
}
