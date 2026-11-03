// Before the disk runs out: under twice the floor, dibs clears caches that
// rebuild themselves, and tells the sessions with something of their own to
// free (a big scratch folder, or running jobs that wrote a lot) how much is
// free and what to do. Each hears once per band: under twice the floor, then
// under the floor. On 2026-10-20 the Mac hit 210 MB free: writes failed, Bash
// died for every session, and jobs sat silently on "free disk". On 2026-11-03
// the warnings had gone to every session, 13 of them as the disk fell from 8.2
// to 4.7 GB, mostly to agents with nothing to free; the person sees the whole
// machine in dibs alerts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME, paths } from './config.mjs';
import { freeDisk, OS } from './platform.mjs';
import { event } from './events.mjs';
import { gb, bytes, now } from './util.mjs';
import { makeAlive } from './proc.mjs';

const GB = b => gb(b).replace(/G$/, ' GB');
const SAY_FREED = 0.1 * 1024 ** 3;   // less than shows as 0.0 GB: not worth a line
const LOG = path.join(HOME, 'cool.log');
// Running jobs that wrote this much (src/measure.mjs, a run's share of the disk's fall) have something to free.
const ATE_MIN = 1024 ** 3;
// The bands a session hears about once each, worst last.
const BANDS = ['low', 'critical'];
// Clearing caches again sooner than this frees little: they refill slowly.
const CLEAN_EVERY = 30 * 6e4;
const STEP_TIMEOUT = 2 * 6e4;
const DAY = 24 * 36e5;

// The caches dibs may clear on its own: each rebuilds itself when next needed.
// Never Claude Code's temp folders, a person's own folders, or a booted simulator
// (simctl's "unavailable" ones have no runtime, so nothing can boot them).
// DIBS_CLEAN ({label: argv}) and DIBS_DERIVED stand in for them in tests.
function steps() {
  // A test's own DIBS_HOME never clears the real caches.
  if (!process.env.DIBS_CLEAN && HOME !== path.join(os.homedir(), '.dibs')) return [];
  if (process.env.DIBS_CLEAN) {
    // {label: argv}, or {label: {argv, dir}} to measure a folder.
    return [...Object.entries(JSON.parse(process.env.DIBS_CLEAN)).map(([label, x]) => (Array.isArray(x) ? { label, argv: x } : { label, ...x })),
      ...(process.env.DIBS_DERIVED ? [{ label: 'Xcode build output unused for a day', derived: process.env.DIBS_DERIVED }] : [])];
  }
  const h = os.homedir();
  const out = [{ label: 'npm cache', argv: ['npm', 'cache', 'clean', '--force'], dir: path.join(h, '.npm/_cacache') }];
  if (OS === 'macos') {
    out.push({ label: 'Homebrew cache', argv: ['brew', 'cleanup', '-s'], dir: path.join(h, 'Library/Caches/Homebrew') },
      { label: 'unavailable simulators', argv: ['xcrun', 'simctl', 'delete', 'unavailable'], dir: path.join(h, 'Library/Developer/CoreSimulator/Devices') },
      { label: 'Xcode build output unused for a day', derived: path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData') });
  }
  return out;
}
const run = argv => new Promise(resolve => execFile(argv[0], argv.slice(1), { timeout: STEP_TIMEOUT }, () => resolve()));
// A folder's size in bytes, or null. What a step freed is its folders' shrink,
// not free disk before and after: on 2026-10-22 swap gave back 3 GB while
// Homebrew's cleanup ran, and the note said the cleanup freed it.
const size = dirs => new Promise(resolve => execFile('du', ['-sk', ...dirs], { timeout: STEP_TIMEOUT }, (e, out) => {
  const kb = String(out || '').split('\n').map(l => parseInt(l, 10)).filter(n => n >= 0);
  resolve(kb.length ? kb.reduce((a, n) => a + n, 0) * 1024 : null);
}));
// A DerivedData folder no build has touched in a day: Xcode makes it again on the next build.
// Returns what it removed, in bytes.
async function staleDerived(dir, t) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  const stale = list.filter(e => e.isDirectory()).map(e => path.join(dir, e.name)).filter(p => { try { return t - fs.statSync(p).mtimeMs > DAY; } catch { return false; } });
  if (!stale.length) return 0;
  const was = await size(stale);
  for (const p of stale) try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  return was || 0;
}

// One clearing: each step in turn, what it freed by free disk before and after, logged under dibs's name.
export async function clean(t = now(), where = HOME) {
  const done = [];
  for (const st of steps()) {
    if (st.derived) { done.push({ label: st.label, freed: await staleDerived(st.derived, t) }); continue; }
    // A step without a folder to measure (DIBS_CLEAN in tests) falls back to free disk.
    const measure = () => (st.dir ? size([st.dir]) : freeDisk(where));
    const before = await measure();
    await run(st.argv);
    const after = await measure();
    const by = before != null && after != null ? (st.dir ? before - after : after - before) : 0;
    done.push({ label: st.label, freed: Math.max(0, by) });
  }
  const freed = done.reduce((a, d) => a + d.freed, 0);
  try {
    fs.appendFileSync(LOG, `${new Date(t).toISOString()} disk low: dibs cleared ${done.map(d => d.label).join(', ')}, freeing ${GB(freed)}\n`);
    event({ kind: 'clean', freed, steps: done });
  } catch {}
  return { at: t, freed, steps: done };
}
export const cleanDue = (was, t, critical) => !(t - (was?.cleaned?.at || 0) < (critical && !was?.cleanedCritical ? 0 : CLEAN_EVERY));

// The sessions to tell: those with something of their own to free, a scratch
// folder hogs.mjs found over its line (was.folders) or running jobs that ate
// ATE_MIN of disk. Their jobs, for the note.
function sessions(s, was) {
  const out = new Map();
  const add = (session, who, agentId) => { if (session && !out.has(session)) out.set(session, { session, who, agentId: agentId || null, running: [], waiting: [], growing: false }); return out.get(session); };
  // Growing: its folder grew since the last reading (hogs.mjs), or its jobs are writing.
  for (const h of was?.folders || []) add(h.session, h.who, h.agentId).growing ||= !!was.grew?.includes(`session ${h.session}'s scratch folder`);
  for (const l of s.leases || []) if (l.kind === 'run' && l.sessionId && (l.ate || 0) >= ATE_MIN) add(l.sessionId, l.who, l.agentId).growing = true;
  for (const l of s.leases || []) if (l.kind === 'run' && out.has(l.sessionId)) out.get(l.sessionId).running.push(l);
  for (const q of s.queue || []) if (q.pid && out.has(q.sessionId)) out.get(q.sessionId).waiting.push(q);
  return [...out.values()];
}
const job = x => `#${x.id}${x.purpose ? ` ("${x.purpose}")` : ''}`;

// The note itself. hint: what's growing and the biggest folder (hogs.mjs hogHint), cleaned: clean()'s result.
export function noteText(x, m, floor, hint, cleaned) {
  const critical = m.diskFree < floor;
  const lines = [critical
    ? `free disk is critically low: ${GB(m.diskFree)} left (dibs starts nothing new under ${GB(floor)}). Writes, builds and even Bash will start failing. Save your work now: commit or copy anything in progress.`
    : `free disk is getting low: ${GB(m.diskFree)} left (dibs starts nothing new under ${GB(floor)})`];
  if (hint) lines.push(hint.replace(/^\. /, ''));
  if (cleaned?.freed >= SAY_FREED) lines.push(`dibs cleared caches that rebuild themselves and freed ${GB(cleaned.freed)} (${cleaned.steps.filter(d => d.freed >= SAY_FREED).map(d => `${d.label} ${GB(d.freed)}`).join(', ')})`);
  if (critical && x.running.length) lines.push(`Your running dibs ${x.running.length === 1 ? 'job' : 'jobs'} ${x.running.map(job).join(', ')} may fail writing: save what it has done if you can`);
  // Over the floor a waiter is held by something else, not the disk.
  if (critical && x.waiting.length) lines.push(`Your waiting ${x.waiting.length === 1 ? 'job' : 'jobs'} ${x.waiting.map(job).join(', ')} won't start until there's room`);
  // Files holding still were there before the disk got low: telling their session to free them each time taught agents to skip the note (e4, 2026-11-03).
  if (x.growing) lines.push('Free what you can of your own: build output, scratch folders and merged worktrees your session made (only exact paths you made; others of your session may still use the rest)');
  return lines.join('. ') + '.';
}

// Whether the throttle watcher (src/cool.mjs) is down: its pidfile names no live process.
export function watcherDown() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(HOME, 'cool.pid'), 'utf8')); } catch {}
  return !(pid && makeAlive([pid])(pid));
}

// One pass, from hogs.mjs under twice the floor: clear caches when due, then tell
// each session with something to free, once per band. Returns what to keep in hogs.json.
export async function warnOnce(cfg, m, was, hint, t = now()) {
  const floor = bytes(cfg.minDisk);
  if (m.diskFree == null || m.diskFree >= 2 * floor) return {};
  const critical = m.diskFree < floor;
  const keep = {};
  let cleaned = was?.cleaned && t - was.cleaned.at < CLEAN_EVERY ? was.cleaned : null;
  if (cleanDue(was, t, critical)) { cleaned = await clean(t); Object.assign(keep, { cleaned, cleanedCritical: critical }); }
  let s = {};
  try { s = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch {}
  const { notify } = await import('./talk.mjs');
  const level = critical ? 'critical' : 'low';
  // The worst band each session has heard about; hogs.mjs clears it once there's room again.
  const warned = { ...(was?.warned || {}) };
  for (const x of sessions(s, was)) {
    if (BANDS.indexOf(warned[x.session]?.level) >= BANDS.indexOf(level)) continue;
    if (notify({ sessionId: x.session, who: x.who, agentId: x.agentId }, `disk:${level}:${t}`, noteText(x, m, floor, hint, cleaned))) warned[x.session] = { at: t, level, free: m.diskFree };
  }
  // Kept only when it changed: on a nearly full disk, every write counts.
  return JSON.stringify(warned) === JSON.stringify(was?.warned || {}) ? keep : { ...keep, warned };
}
