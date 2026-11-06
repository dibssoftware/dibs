// dibs alerts: nothing goes wrong quietly. On 2026-11-02 the person learned
// from a screenshot of another agent that every deploy had waited 40 minutes
// behind one TestFlight ship, and that swap had held up every test run for
// half an hour; nothing had told them. Each alert here names its cause and the
// one thing that fixes it, shows once, stays until the cause is gone, and then
// says when it went. The board, the page and the Mac app all show the same
// list; the app turns a new one into a notification, at most one per cause
// every 30 minutes.
//
// Six causes:
//   wait      a job waiting far longer than usual, worst when a person waits on it
//   memory    memory pressure or swap holding new jobs back, with what to close
//   idle      a slot held by a job that has done nothing for a long time
//   ended     jobs that failed, were stopped, or were lost on another machine
//   dibs      dibs itself: a service down or restarting, a crash, the hook failing
//   disk      free disk under the floor
//
// alerts.json keeps the open ones, the resolved ones for a day, and what the
// scan needs between runs: how far into the event log and the hook's log it
// has read, recent waits per resource, and the services' start counts. Every
// process that shows the board scans at most every SCAN_EVERY, and so does the
// throttle watcher, so alerts keep up even when nobody looks.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, machine } from './config.mjs';
import { verdict } from './schedule.mjs';
import { stuckFor, minutes, andList } from './plain.mjs';
import { processes, memoryUse } from './platform.mjs';
import { treeOf } from './measure.mjs';
import { withState, history } from './state.mjs';
import { markIdle } from './acquire.mjs';
import { sessionFiles } from './proc.mjs';
import { EVENTS } from './events.mjs';
import { serviceHealth } from './service.mjs';
import { hogHint } from './hogs.mjs';
import { now, bytes, clock, gb, die } from './util.mjs';
import { dim, red, amber, wrap } from './style.mjs';

export const FILE = path.join(HOME, 'alerts.json');
const LOCK = path.join(HOME, 'alerts.lock');
const GUARD_LOG = path.join(HOME, 'guard.log');
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;

// Reads are cheap but not free (a verdict per waiter, the tail of two logs);
// the app polls every 2 s, so a scan stands for this long.
const SCAN_EVERY = 15e3;
// A wait is long past this, or past WAIT_TIMES its usual wait, whichever is later.
const WAIT_FLOOR = 10 * MIN;
const WAIT_TIMES = 3;
// Waits remembered per resource for "usual": enough for a median that one odd day doesn't move.
const WAITS_KEPT = 40;
// Memory holding jobs back must last this long before it's an alert: a build's peak passes in a minute or two.
const PRESSURE_AFTER = 10 * MIN;
// The machine-wide memory reading costs about half a second of top: once a minute at most, only while it matters.
const TOP_EVERY = MIN;
// A failure, a lost job or a crash stays a day unless it's resolved sooner.
const EVENT_KEEP = DAY;
// A restart or a hook failure counts as over once this long passes without another.
const CALM_AFTER = HOUR;
// launchctl costs a process per service: once a minute.
const SERVICES_EVERY = MIN;
// Resolved alerts the board and the app still show, so the person sees it went away.
export const RESOLVED_SHOWN = 2 * HOUR;
// The first read of the event log starts this far from its end, not at its start: the log runs to 20 MB.
const FIRST_READ = 2 * 1024 ** 2;
// The rules a waiter is held by when the machine's memory, not a turn or dibs's budget, is in the way.
const PRESSURE = new Set(['pressure', 'swap', 'swaproom', 'ram', 'oversize']);
// Bumped when what makes an alert changes, so an upgrade rebuilds the open ones instead of closing them.
const RULES = 2;
// The same command failing this many times in a row, with no pass between, is worth the person's attention.
const REPEATS = 3;
// Exit codes a stopped command dies with: Ctrl-C, SIGKILL, SIGTERM.
const STOPPED = new Set([130, 137, 143]);

// A time as the person reads it: the clock today, with the weekday within a
// week either way, with the date further off. "at 6:40 PM" from yesterday
// read as a time still to come.
export function stamp(at, t = now()) {
  const d = new Date(at);
  if (d.toDateString() === new Date(t).toDateString()) return clock(at);
  const day = Math.abs(t - at) < 6 * DAY ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day} ${clock(at)}`;
}

const what = x => (x.purpose || x.cmd || (x.res || []).join(', ') || 'a job').replace(/\s+/g, ' ').slice(0, 70);
const job = x => `${x.who}'s #${x.id} (${what(x)})`;
const personWaits = q => q.prio === 'urgent' || q.prio === 'high' || typeof q.by === 'number';
const isDeploy = res => (res || []).some(r => r === 'deploy' || r.startsWith('deploy-') || r.startsWith('deploy:'));
// A failure the person cares about: a deploy, or a job they were waiting on.
// Held by the machine's memory: pressure or swap, or a job that fits dibs's budget but not what's really free.
const pressed = v => PRESSURE.has(v.rule) || (v.rule === 'memory' && (v.pressure || v.real));
const matters = x => isDeploy(x.res) || x.prio === 'urgent' || x.prio === 'high' || typeof x.due === 'number';

function load() {
  try { return { seen: {}, open: {}, resolved: [], dismissed: {}, waits: {}, ended: [], svc: {}, restarts: [], hook: [], ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { return { seen: {}, open: {}, resolved: [], dismissed: {}, waits: {}, ended: [], svc: {}, restarts: [], hook: [] }; }
}

function save(st) {
  const tmp = `${FILE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, FILE);
}

// One scan at a time. Whoever finds the lock taken shows what the file already
// says; a lock left by a process that died is broken after 30 s.
function locked(fn) {
  try { fs.mkdirSync(LOCK); } catch (e) {
    if (e.code !== 'EEXIST') return null;
    try { if (now() - fs.statSync(LOCK).mtimeMs < 30e3) return null; fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK); } catch { return null; }
  }
  try { return fn(); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}

// The lines a log gained since the offset last read. A file shorter than the
// offset was rotated: read it from the start.
function tail(file, off, first = FIRST_READ) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return { lines: [], off: 0 }; }
  let from = off == null ? Math.max(0, size - first) : off > size ? 0 : off;
  if (from === size) return { lines: [], off: size };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    // A line still being written stays for next time; a first read starting mid-line drops its first.
    const end = text.lastIndexOf('\n') + 1;
    let lines = text.slice(0, end).split('\n').filter(Boolean);
    if (off == null && from > 0) lines = lines.slice(1);
    return { lines, off: from + Buffer.byteLength(text.slice(0, end)) };
  } finally { fs.closeSync(fd); }
}

// The event log since last time: waits per resource, and failed, stopped and
// lost jobs and crashes, with what closes them.
function readEvents(st, t) {
  const { lines, off } = tail(EVENTS, st.off);
  st.off = off;
  const stops = new Map();
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === 'start' && e.type === 'run' && e.res?.[0]) {
      const w = (st.waits[e.res[0]] ||= []);
      w.push(e.ms || 0);
      if (w.length > WAITS_KEPT) w.splice(0, w.length - WAITS_KEPT);
    } else if (e.kind === 'override' && e.act === 'stop' && e.id != null) stops.set(e.id, e.by || 'someone');
    else if (e.kind === 'end' && e.type === 'run') {
      // A later success of the same command closes its failures.
      if (e.code === 0 && e.key) for (const x of st.ended) if (x.key === e.key && !x.fixedAt) x.fixedAt = e.at;
      const by = stops.get(e.id);
      const x = { at: e.at, id: e.id, who: e.who, res: e.res, cmd: e.cmd, purpose: e.purpose, key: e.key, code: e.code, prio: e.prio, due: e.due };
      if (by || STOPPED.has(e.code)) st.ended.push({ kind: 'stopped', ...x, by: by || null });
      else if (e.code != null && e.code !== 0) st.ended.push({ kind: 'failed', ...x });
    } else if (e.kind === 'lost' || e.kind === 'crash') st.ended.push({ kind: e.kind, at: e.at, who: e.who, cmd: e.cmd, code: e.code, why: e.why, verb: e.verb });
  }
  st.ended = st.ended.filter(x => t - x.at < EVENT_KEEP);
}

// The hook's own failures (src/guard.mjs logError): when, and what.
function readHook(st, t) {
  const { lines, off } = tail(GUARD_LOG, st.hookOff, 64 * 1024);
  st.hookOff = off;
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(.*)$/);
    const at = m && Date.parse(m[1]);
    if (at) st.hook.push({ at, msg: m[2].slice(0, 200) });
  }
  st.hook = st.hook.filter(x => t - x.at < CALM_AFTER);
}

// Services: down, or started again by launchd after exiting with an error.
function readServices(st, t) {
  if (st.svcAt && t - st.svcAt < SERVICES_EVERY) return;
  st.svcAt = t;
  const health = serviceHealth();
  for (const [k, h] of Object.entries(health)) {
    const was = st.svc[k];
    if (was && h.runs > was.runs && h.exit && h.exit !== 0) st.restarts.push({ k, at: t, exit: h.exit, runs: h.runs - was.runs });
    st.svc[k] = { ...h };
  }
  for (const k of Object.keys(st.svc)) if (!health[k]) delete st.svc[k];
  st.restarts = st.restarts.filter(r => t - r.at < CALM_AFTER);
}

// What uses the most memory, machine-wide, grouped the way a person closes
// things: an app with all its helpers, Safari's pages, the simulator, each
// Claude session, and dibs's own jobs by number. Top five.
export function memoryUsers(s, procs, use) {
  const sessions = new Map(sessionFiles().map(x => [x.pid, x]));
  const owner = new Map();
  for (const l of s.leases || []) if (l.kind === 'run') for (const pid of treeOf(l, s, procs)) owner.set(pid, l);
  const groups = new Map();
  for (const p of procs) {
    const bytes = use.get(p.pid);
    if (!bytes) continue;
    const l = owner.get(p.pid);
    const name = l ? `dibs job #${l.id} (${l.who})` : appOf(p, sessions);
    const g = groups.get(name) || { name, bytes: 0, n: 0, dibs: !!l, ...(l && { id: l.id }) };
    g.bytes += bytes; g.n++;
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
}

function appOf(p, sessions) {
  const a = p.args || '';
  if (/\blaunchd_sim\b|\/CoreSimulator\/Devices\/|\.simruntime\//.test(a)) return 'the iOS Simulator';
  if (/com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(a)) return 'Safari and other web pages';
  if (/(^|\/)claude(\s|$)/.test(a)) {
    const x = sessions.get(p.pid);
    return x?.name ? `Claude Code session ${x.name}` : `Claude Code (pid ${p.pid})`;
  }
  const app = a.match(/\/([^/]+)\.app\//);
  if (app) return app[1];
  // A script under an interpreter is the script: "node" alone says nothing about which.
  const [cmd, ...args] = a.split(/\s+/);
  const name = path.basename(cmd || `pid ${p.pid}`);
  const script = INTERPRETERS.test(name) && args.find(x => !x.startsWith('-'));
  return script ? `${name} ${path.basename(script)}` : name;
}

const INTERPRETERS = /^(node|bun|deno|python3?(\.\d+)?|ruby|perl)$/;
const sized = g => `${g.name} (${gb(g.bytes).replace(/G$/, ' GB')}${g.n > 1 && g.name.startsWith('Safari') ? `, ${g.n} pages` : ''})`;

// Every alert the state calls for now: { id, cause, level, title, fix, after?, at? }.
// level: urgent (a person is held up or dibs is broken), warn, or note.
export function detect({ s, cfg, hist, m, t, st, users }) {
  const out = [];
  const waiting = (s.queue || []).filter(q => q.pid);
  const verdicts = new Map(waiting.map(q => [q.id, verdict(s, q, cfg, hist, t)]));

  // A job waiting far longer than its resource usually makes anyone wait.
  for (const q of waiting) {
    const v = verdicts.get(q.id);
    if (v.ok) continue;
    const usual = Math.max(0, ...q.res.map(r => median(st.waits[r] || [])));
    const waited = t - q.enq;
    if (waited < Math.max(WAIT_FLOOR, WAIT_TIMES * usual)) continue;
    out.push({ id: `wait:#${q.id}`, cause: 'wait', level: personWaits(q) ? 'urgent' : 'warn', job: q.id, who: q.who, at: q.enq,
      ...(pressed(v) && !users && { want: 'users' }),
      title: `${job(q)} has waited ${minutes(waited)}${usual >= MIN ? `, where ${q.res[0]} usually takes ${minutes(usual)}` : ''}${personWaits(q) ? `, and it's ${typeof q.by === 'number' ? `due by ${stamp(q.by, t)}` : q.prio}` : ''}`,
      why: v.why, fix: waitFix(s, q, v, t, users) });
  }

  // Memory holding new jobs back.
  const held = waiting.filter(q => pressed(verdicts.get(q.id)));
  if (held.length) {
    const swap = held.some(q => /^swap/.test(verdicts.get(q.id).rule));
    const list = users || [];
    const close = list.filter(g => !g.dibs);
    const ours = list.filter(g => g.dibs);
    out.push({ id: 'memory', cause: 'memory', level: 'urgent', after: PRESSURE_AFTER, at: Math.min(...held.map(q => q.enq)), ...(!users && { want: 'users' }),
      title: `${swap ? 'Swap' : 'Memory pressure'} is holding back ${held.length} job${held.length > 1 ? 's' : ''} (${andList(held.slice(0, 3).map(q => `#${q.id}`))}${held.length > 3 ? ' and more' : ''})`,
      why: verdicts.get(held[0].id).why,
      detail: list.length ? `Using the most memory: ${list.map(sized).join(', ')}.` : '',
      fix: memoryFix(list) });
  }

  // A slot held by a run that has used no CPU for a long while someone waits for it.
  for (const l of s.leases || []) {
    const idle = stuckFor(l, t);
    if (!idle) continue;
    const behind = waiting.filter(q => q.res.some(r => l.res.includes(r)));
    if (!behind.length) continue;
    out.push({ id: `idle:#${l.id}`, cause: 'idle', level: behind.some(personWaits) ? 'urgent' : 'warn', job: l.id, who: l.who, at: l.idleSince,
      title: `${job(l)} has held ${l.res.join(', ')} for ${minutes(t - l.start)} and used no CPU for ${minutes(idle)}, while ${behind.length} job${behind.length > 1 ? 's wait' : ' waits'}`,
      fix: `If it's stuck, stop it: dibs stop ${l.id} --owner ${l.who}. If it's working somewhere dibs can't see, leave it.` });
  }

  // Jobs that failed, were stopped, or were lost, and dibs's own crashes. An
  // agent's test run failing while it works is normal: on 2026-11-03 one
  // session's 53 failed test runs filled the list. What's loud is what the
  // person cares about: a deploy, a job a person waits on (high, urgent or
  // --by), the same command failing REPEATS times in a row, a lost job and a
  // crash. The rest is quiet: in dibs alerts --all only.
  const failed = new Map();
  for (const x of st.ended) {
    if (x.fixedAt) continue;
    if (x.kind === 'failed' && matters(x)) {
      out.push({ id: `failed:#${x.id}`, cause: 'ended', level: 'warn', at: x.at, job: x.id, who: x.who,
        title: `${job(x)} failed at ${stamp(x.at, t)} (exit ${x.code})${x.due ? `, and it was due by ${stamp(x.due, t)}` : x.prio === 'urgent' || x.prio === 'high' ? `, and it was ${x.prio}` : ''}`,
        fix: `${x.who} is the one to fix it; this closes when the same command passes.` });
    } else if (x.kind === 'failed') {
      // Failures of the exact same command, all since its last pass (a pass closes the ones before it).
      const k = `${x.who}|${x.cmd || (x.res || []).join(',')}`;
      const g = failed.get(k) || { ...x, n: 0, first: x.at };
      g.n++; g.at = Math.max(g.at, x.at); g.code = x.code;
      failed.set(k, g);
    } else if (x.kind === 'stopped') {
      // Stopped on purpose (exit 143 or 137, or dibs stop): on record in dibs alerts --all, nowhere louder.
      out.push({ id: `stopped:#${x.id}`, cause: 'ended', level: 'note', at: x.at, job: x.id, who: x.who, quiet: true,
        title: `${job(x)} was stopped${x.by ? ` by ${x.by}` : ''} at ${stamp(x.at, t)}${x.code != null ? ` (exit ${x.code})` : ''}`,
        fix: `If it should finish, ${x.who} runs it again; nothing else waits on it.` });
    } else if (x.kind === 'lost') {
      out.push({ id: `lost:${x.at}`, cause: 'ended', level: 'urgent', at: x.at, who: x.who,
        title: `${x.who}'s job was lost${x.code === 77 ? ' after it started' : ' before it started'} at ${stamp(x.at, t)}: ${x.why || x.cmd}`,
        fix: x.code === 77 ? 'It may have run. Check what it changed before running it again.' : 'It never ran, so it\'s safe to run again.' });
    } else if (x.kind === 'crash') {
      out.push({ id: `crash:${x.at}`, cause: 'dibs', level: 'urgent', at: x.at, who: x.who,
        title: `dibs crashed at ${stamp(x.at, t)} running dibs ${x.verb || ''} for ${x.who}`,
        fix: `It's a bug in dibs. Report it: dibs ask "crash in dibs ${x.verb || ''}"` });
    }
  }
  for (const [k, g] of failed) {
    const loud = g.cmd && g.n >= REPEATS;
    out.push({ id: `failed:${hash(k)}`, cause: 'ended', level: loud ? 'warn' : 'note', at: g.first, last: g.at, who: g.who, ...(!loud && { quiet: true }),
      title: `${g.who}'s ${what(g)} failed${g.n > 1 ? ` ${g.n} times in a row, last` : ''} at ${stamp(g.at, t)} (exit ${g.code})`,
      fix: `${g.who} is the one to fix it; this closes when the same command passes.` });
  }

  // dibs itself.
  for (const [k, h] of Object.entries(st.svc || {}))
    if (!h.running)
      out.push({ id: `service:${k}`, cause: 'dibs', level: 'urgent',
        title: `dibs's ${k} service isn't running${h.exit ? ` (it last exited with code ${h.exit})` : ''}: ${h.what}`,
        fix: `Start it again: dibs service install ${k}. Why it stopped is in ~/.dibs/${k}.log.` });
  for (const k of new Set((st.restarts || []).map(r => r.k))) {
    const rs = st.restarts.filter(r => r.k === k);
    const last = rs[rs.length - 1];
    out.push({ id: `restart:${k}`, cause: 'dibs', level: 'warn', at: rs[0].at,
      title: `dibs's ${k} service crashed (exit ${last.exit}) and launchd started it again${rs.length > 1 ? `, ${rs.length} times in the last hour` : ''}, last at ${stamp(last.at, t)}`,
      fix: `Look in ~/.dibs/${k}.log for why, and report it: dibs ask "the ${k} service keeps exiting with ${last.exit}"` });
  }
  if (st.hook?.length) {
    const last = st.hook[st.hook.length - 1];
    out.push({ id: 'hook', cause: 'dibs', level: 'warn', at: st.hook[0].at,
      title: `The Claude Code hook failed ${st.hook.length} time${st.hook.length > 1 ? 's' : ''} in the last hour, last at ${stamp(last.at, t)}: ${last.msg}`,
      fix: `Those tool calls ran without dibs's checks. Report it: dibs ask "hook: ${last.msg.slice(0, 60)}"` });
  }

  // The hard stop (src/preempt.mjs hardStop): a job paused under 1 GB free, whatever it was.
  for (const l of s.leases.filter(x => x.pauses?.some(p => p.hard)))
    out.push({ id: `hardstop:#${l.id}`, cause: 'disk', level: 'urgent', job: l.id, who: l.who, at: l.pausedAt,
      title: `Free disk fell under 1 GB, so dibs paused ${job(l)}, the job writing the most. It resumes once 2 GB is free`,
      fix: diskFix() });

  // Disk under the floor: nothing new starts.
  const floor = bytes(cfg.minDisk || '0');
  if (floor && m.diskFree != null && m.diskFree < floor)
    out.push({ id: 'disk', cause: 'disk', level: 'urgent',
      title: `Free disk is ${gb(m.diskFree).replace(/G$/, ' GB')}, under the ${gb(floor).replace(/G$/, ' GB')} dibs keeps free, so only jobs that write next to nothing start; the rest wait for room`,
      fix: diskFix() });
  return out;
}

// The one thing that lets a long-waiting job start, by what holds it.
function waitFix(s, q, v, t, users) {
  const boost = `dibs boost ${q.id} urgent -m "why"`;
  if (v.rule === 'slot' || v.rule === 'files' || v.rule === 'together') {
    // With one deploy per project (the per-repo lock), the one in the way is this project's.
    const on = (s.leases || []).filter(x => x.res.includes(v.on));
    const l = on.find(x => q.repo && x.repo === q.repo) || on[0] || v.ahead;
    if (l && stuckFor(l, t)) return `${job(l)} holds ${v.on} and has done nothing for ${minutes(stuckFor(l, t))}: stop it with dibs stop ${l.id} --owner ${l.who}.`;
    if (l) return `${job(l)} has held ${v.on} for ${minutes(t - l.start)}. If ${q.who}'s job can't wait, ${boost} puts it first in line; ${l.who} decides whether to stop theirs.`;
  }
  if (v.rule === 'ahead' && v.ahead) return `${job(v.ahead)} is ahead. If this one matters more: ${boost}.`;
  // What uses the memory, said here: an alert that points at another one that isn't there is no help.
  if (pressed(v)) return memoryFix(users || []);
  if (v.rule === 'memory') {
    const big = (s.leases || []).filter(l => l.mem).sort((a, b) => b.mem - a.mem).slice(0, 3);
    return `dibs's memory budget is handed out to running jobs${big.length ? `, the biggest ${andList(big.map(l => `${job(l)} with ${gb(l.mem).replace(/G$/, ' GB')}`))}` : ''}. It starts as they end; if it can't wait: ${boost}.`;
  }
  if (v.rule === 'disk' || v.rule === 'drain') return diskFix();
  if (v.rule === 'load' || v.rule === 'cpu') return `The machine is busy. If a person waits on this: dibs boost ${q.id} high -m "why".`;
  if (v.rule === 'idle') return `It's idle-priority work, which waits for everything else: dibs boost ${q.id} normal.`;
  if (v.rule === 'reset') return `${v.on} is being reset after the last job; if that takes too long, check its onRelease in ~/.dibs/config.json.`;
  return `${v.why}. If it can't wait: ${boost}.`;
}

// What to close, from the biggest memory users on the machine.
function memoryFix(list) {
  const close = list.filter(g => !g.dibs), ours = list.filter(g => g.dibs);
  if (close.length) return `Close what you can of ${andList(close.slice(0, 3).map(sized))}. dibs won't close apps it didn't start.${ours.length ? ` Or stop a dibs job: dibs stop ${ours[0].id}.` : ''}`;
  if (ours.length) return `dibs's own jobs use it: dibs stop ${ours[0].id} frees the most.`;
  return "Close apps you aren't using; dibs won't close what it didn't start.";
}

function diskFix() {
  return `Free disk: build output, caches and scratch folders${hogHint()}.`;
}

const median = xs => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const hash = k => { let h = 5381; for (const c of String(k)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// Open what's new, keep what's still true, and close the rest with when.
export function merge(st, found, t) {
  const live = new Set();
  for (const c of found) {
    // Since when the problem itself began (the job queued, the first failure), not this scan.
    if (c.after && t - (st.seen[c.id] ??= c.at ?? t) < c.after) continue;
    if (st.dismissed[c.id]) continue;
    live.add(c.id);
    const { after, want, at, ...a } = c;
    st.open[c.id] = { ...a, since: at ?? st.open[c.id]?.since ?? (after ? st.seen[c.id] : t), resolvedAt: null };
  }
  const pending = new Set(found.map(c => c.id));
  for (const id of Object.keys(st.seen)) if (!pending.has(id)) delete st.seen[id];
  for (const [id, a] of Object.entries(st.open)) {
    if (live.has(id)) continue;
    st.resolved.push({ ...a, resolvedAt: t, ...(st.dismissed[id] && { dismissed: true }) });
    delete st.open[id];
  }
  st.resolved = st.resolved.filter(a => t - a.resolvedAt < DAY).slice(-200);
  for (const [id, at] of Object.entries(st.dismissed)) if (t - at > DAY) delete st.dismissed[id];
}

// Read what's new and bring alerts.json up to date, unless another process
// did within SCAN_EVERY. Returns the list to show. Never throws: the board,
// the watcher and the page call it, and none of them may fail over an alert.
export function scan({ s, cfg, hist, m = machine(), t = now(), force = false } = {}) {
  try {
    const was = load();
    if (!force && was.at && t - was.at < SCAN_EVERY) return shown(was, t);
    const st = locked(() => {
      const st = load();
      // Alerts made by older rules aren't resolved, only no longer said that way: start the open list over.
      if (st.rules !== RULES) { st.open = {}; st.seen = {}; st.rules = RULES; }
      readEvents(st, t);
      readHook(st, t);
      readServices(st, t);
      let users = st.top && t - st.top.at < TOP_EVERY ? st.top.list : null;
      let found = detect({ s, cfg, hist, m, t, st, users });
      // The machine-wide reading only once memory is what holds jobs back.
      if (!users && found.some(a => a.want === 'users')) {
        users = memoryUsers(s, processes(), memoryUse());
        st.top = { at: t, list: users };
        found = detect({ s, cfg, hist, m, t, st, users });
      }
      merge(st, found, t);
      st.at = t;
      save(st);
      return st;
    });
    return shown(st || load(), t);
  } catch (e) {
    // The one thing that may not fail quietly is this.
    return [{ id: 'alerts', cause: 'dibs', level: 'urgent', since: t, resolvedAt: null,
      title: `dibs couldn't check for problems: ${String(e?.message || e).split('\n')[0]}`,
      fix: `It's a bug in dibs. Report it: dibs ask "alerts: ${String(e?.message || e).slice(0, 60)}"` }];
  }
}

// Open alerts, worst first, then the ones resolved in the last RESOLVED_SHOWN.
const RANK = { urgent: 0, warn: 1, note: 2 };
export function shown(st, t = now(), all = false) {
  const open = Object.values(st.open || {}).filter(a => all || !a.quiet).sort((a, b) => RANK[a.level] - RANK[b.level] || b.since - a.since);
  const gone = (st.resolved || []).filter(a => all || (!a.quiet && t - a.resolvedAt < RESOLVED_SHOWN)).sort((a, b) => b.resolvedAt - a.resolvedAt);
  return [...open, ...gone];
}

// Close one alert, or all, for a day; a cause that comes back after that opens it again.
export function dismiss(which, t = now()) {
  return locked(() => {
    const st = load();
    const ids = which === 'all' ? Object.keys(st.open) : Object.keys(st.open).filter(id => id === which || id === `#${which}` || id.endsWith(`:#${which}`) || id.endsWith(`:${which}`));
    for (const id of ids) st.dismissed[id] = t;
    merge(st, Object.values(st.open).filter(a => !ids.includes(a.id)), t);
    save(st);
    return ids;
  }) || [];
}

// The plain board is what agents read between steps: a failure, a stop or a
// lost job is on it for this long after it happened, then only in the alerts
// (the page, the app, dibs alerts), which the person reads.
export const BOARD_KEEP = 30 * MIN;
export const onBoard = (a, t = now()) => a.cause !== 'ended' || t - (a.last ?? a.since) < BOARD_KEEP;

// The board's lines for the alerts: each open one with its fix, worst first,
// then the ones resolved lately, with when.
export function alertLines(list, t = now()) {
  const out = [];
  for (const a of list) {
    if (a.resolvedAt) out.push(dim(`Resolved at ${stamp(a.resolvedAt, t)}${a.dismissed ? ' (dismissed)' : ''}: ${a.title}.`));
    else {
      const paint = a.level === 'urgent' ? red : a.level === 'warn' ? amber : x => x;
      out.push(paint(`${a.level === 'note' ? '' : '! '}${a.title} (since ${stamp(a.since, t)}).`), wrap(`  Fix: ${a.fix}`, '  '));
    }
  }
  return out;
}

// dibs alerts [--json] [--all] | dibs alerts dismiss <id|all>
export function alerts(args, cfg) {
  if (args[0] === 'dismiss') {
    const which = args[1] || die('dismiss which? dibs alerts lists them by id, or: dibs alerts dismiss all');
    const ids = dismiss(which.replace(/^#/, ''));
    return console.log(ids.length ? `Dismissed ${andList(ids)} for a day. If the cause is still there after that, it opens again.`
      : `No open alert matches ${which}. dibs alerts lists them.`);
  }
  const t = now();
  const s = withState(s => { markIdle(s); return s; });
  let list = scan({ s, cfg, hist: history(), t, force: true });
  if (args.includes('--all')) list = shown(load(), t, true);
  if (args.includes('--json')) return console.log(JSON.stringify(list, null, 1));
  const quiet = args.includes('--all') ? 0 : Object.values(load().open).filter(a => a.quiet).length;
  const more = quiet ? dim(`${quiet} more not worth your attention (agents' own test runs failing, jobs stopped on purpose): dibs alerts --all`) : '';
  if (!list.length) return console.log(['Nothing is wrong that dibs can see. Open problems and what fixes them show here, and on the board.', more].filter(Boolean).join('\n'));
  console.log(alertLines(list, t).join('\n'));
  if (more) console.log(`\n${more}`);
  const open = list.filter(a => !a.resolvedAt);
  if (open.length) console.log(dim(`\nIds, for dibs alerts dismiss <id>: ${open.map(a => a.id).join(', ')}`));
}
