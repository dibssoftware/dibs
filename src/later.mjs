// dibs later: a run scheduled for a time, or for when something else ends.
// `dibs later` records the command and returns at once. When it's due, a
// runner starts it as an ordinary `dibs run --wait`, so it waits its turn,
// gets its lease and is reaped like any other run.
//
// The runner is the dibs worker service: it already runs under launchd (or
// systemd) at Interactive priority, restarts after a crash or reboot, and runs
// its loop even before the machine joins a coordinator. When no runner is up,
// scheduling starts one that leaves once nothing is left to run.
//
// Jobs keep their own file and lock, not state.json's: the runner looks every
// second, and nothing here decides who runs next.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, paths } from './config.mjs';
import { identity, isMine, makeAlive, pstart, tag, sessionFiles } from './proc.mjs';
import { AGENT_ENV } from './owner.mjs';
import { which, OS } from './platform.mjs';
import { readEvents } from './events.mjs';
import { short, takeAgent, talkKey } from './files.mjs';
import { noteAs } from './talk.mjs';
import { named, about, minutes } from './plain.mjs';
import { bold, dim, columns } from './style.mjs';
import { clock, deadline, die, dur, log, ms, now, say, sleep, sleepSync, fakeFull, LEAN, lockHeld, unlock } from './util.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dibs.mjs');
export const DIR = path.join(HOME, 'later');
const FILE = path.join(DIR, 'jobs.json');
const LOCK = path.join(DIR, 'jobs.lock');
const RUNNERS = path.join(DIR, 'runners');
const logOf = id => path.join(DIR, `${id}.log`);
const exitOf = id => path.join(DIR, `${id}.exit`);

// Further out than a week, the machine, the project and the reason have likely
// all moved on; a plan that old should be made again, not kept.
const MAX_AHEAD = 7 * 864e5;
// How often a runner looks. Due times are to the second, and a look is one small file read.
const TICK = 1000;
// Started this long after its time, a job says it ran late (the machine was asleep, or no runner was up).
const LATE = 60e3;
// Writes take milliseconds, so a lock this old belongs to a dibs that died holding it.
const LOCK_STALE = 5000;
const LOCK_WAIT = 15e3;
// Finished jobs and their logs stay a week for dibs later list, up to KEEP_DONE of them.
const KEEP_FOR = 7 * 864e5;
const KEEP_DONE = 200;
// What a scheduled command gets from the scheduler's environment. TMPDIR, USER
// and SHELL too, since Xcode and many scripts break without them. Anything
// else (a token, say) only with --env, by name.
const ENV_KEEP = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'SHELL', 'TMPDIR']
  // Windows itself: without SystemRoot and the rest, PowerShell, cmd.exe and
  // os.tmpdir() break or crawl. Without PSModuleAnalysisCachePath, where a
  // machine set one, every PowerShell dibs starts rebuilds its module cache, and
  // on a GitHub runner the scheduled run never got past its first (2026-11-03).
  .concat(OS === 'windows' ? ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PSModulePath', 'PSModuleAnalysisCachePath'] : []);
// dibs's own settings reach the run from the runner (DIBS_HOME above all);
// these say who is calling, and the run sets its own.
const DIBS_WHO = new Set(['DIBS_AGENT', 'DIBS_AS', 'DIBS_REMOTE_JOB', 'DIBS_LEASE', 'DIBS_OWNER', 'DIBS_LATER_JOB']);
// Never from --env: dibs's own settings come from the runner, and who is
// calling is decided when the job is scheduled, not by the job.
const notEnv = k => k.startsWith('DIBS_') || k.startsWith('CLAUDE_CODE_') || AGENT_ENV.includes(k);

const ACTIVE = new Set(['scheduled', 'started']);

function locked(fn) {
  fs.mkdirSync(DIR, { recursive: true });
  const t0 = now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (!lockHeld(e)) throw e;
      try { if (now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE) fs.rmSync(LOCK, { recursive: true, force: true }); } catch {}
      if (now() - t0 > LOCK_WAIT) throw Object.assign(new Error(`${LOCK} stayed locked for ${LOCK_WAIT / 1000}s; remove it if no dibs is running. Nothing was changed.`), { exit: 75 });
      sleepSync(5 + Math.random() * 10);
    }
  }
  try {
    const s = load();
    const before = JSON.stringify(s);
    reap(s);
    const out = fn(s);
    if (JSON.stringify(s) !== before) {
      // --env values may be tokens: only this user reads the file.
      fakeFull('state');
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 });
      fs.renameSync(`${FILE}.tmp`, FILE);
    }
    return out;
  } finally {
    unlock(LOCK);
  }
}

function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') say(`${FILE} was unreadable (${e.message}); starting with no scheduled jobs.`);
  }
  s.seq ||= 0; s.jobs ||= [];
  return s;
}

// The board and the runner read leases without state.json's lock: writes are
// renames, so a read sees a whole file. A holder that died counts as gone
// whether or not anyone has reaped it yet.
function liveIds(t) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch {}
  const leases = st.leases || [], queue = st.queue || [];
  const alive = makeAlive([...leases, ...queue].map(x => x.pid).filter(Boolean));
  const ids = new Map();
  for (const l of leases)
    if (l.kind === 'hold' ? t < l.expires && (!l.pid || alive(l.pid, l.pstart)) : alive(l.pid, l.pstart)) ids.set(l.id, { lease: l });
  for (const q of queue) if (q.pid ? alive(q.pid, q.pstart) : q.keepUntil > t) ids.set(q.id, { waiting: q });
  return { ids, leases };
}

// Whether every lease in ids ended well: a run with exit 0, or a hold.
// A waiter that left without ever getting its lease didn't.
function endedOk(ids) {
  const ends = new Map(readEvents().filter(e => e.kind === 'end' && ids.includes(e.id)).map(e => [e.id, e]));
  const bad = ids.find(id => { const e = ends.get(id); return !e || !(e.code === 0 || (e.code == null && e.type === 'hold')); });
  if (bad == null) return null;
  const e = ends.get(bad);
  return !e ? `#${bad} never ran` : e.code == null ? `#${bad} ended without an exit code` : `#${bad} exited ${e.code}`;
}

// Settle what has changed since the last look: runs that ended, triggers
// that can no longer fire, finished jobs old enough to forget.
function reap(s, t = now()) {
  const started = s.jobs.filter(j => j.state === 'started');
  const alive = makeAlive(started.flatMap(j => [j.pid, j.runner?.pid]).filter(Boolean));
  for (const j of started) {
    let ex = null;
    try { ex = JSON.parse(fs.readFileSync(exitOf(j.id), 'utf8').trim().split('\n').pop()); } catch {}
    if (ex) end(j, ex.started === false ? 'failed' : 'done', { code: ex.code, why: ex.started === false ? `dibs run exited ${ex.code} before starting it` : null }, t);
    else if (j.pid && !alive(j.pid, j.pstart)) end(j, 'lost', { why: 'its dibs run ended without an exit code (killed, or the machine restarted)' }, t);
    // Never started again: if the runner died between spawning and recording
    // the pid, the command may be running, and a second copy is worse than none.
    else if (!j.pid && !alive(j.runner?.pid, j.runner?.pstart)) end(j, 'lost', { why: 'the runner stopped while starting it' }, t);
  }
  for (const j of s.jobs.filter(j => j.state === 'scheduled' && j.after && t - j.created > MAX_AHEAD))
    end(j, 'skipped', { why: `waited ${dur(MAX_AHEAD)} for ${trigger(j)}` }, t);
  const done = s.jobs.filter(j => !ACTIVE.has(j.state)).sort((a, b) => b.ended - a.ended);
  const drop = new Set(done.filter((j, i) => i >= KEEP_DONE || t - j.ended > KEEP_FOR).map(j => j.id));
  if (!drop.size) return;
  for (const id of drop) for (const f of [logOf(id), exitOf(id)]) fs.rmSync(f, { force: true });
  s.jobs = s.jobs.filter(j => !drop.has(j.id));
}

function end(j, state, facts, t = now()) {
  Object.assign(j, { state, ended: t }, facts);
  const line = state === 'done' ? `exit ${j.code}` : `${state}${j.why ? `: ${j.why}` : ''}`;
  try { fs.appendFileSync(logOf(j.id), `dibs later ${j.id}: ${line} at ${new Date(t).toISOString()}${j.fired ? `, ${dur(t - j.fired)} after it started` : ''}\n`, { mode: 0o600 }); } catch {}
  told(j);
}

// The scheduling agent hears how its job ended, in its own thread, as if it
// had run dibs say: "l3 (ios snapshot suite) finished: exit 0. Log:
// ~/.dibs/later/l3.log". Not a cancel: whoever cancelled it knows. Runs once
// per job, under the jobs lock; a busy messages lock costs the note, not the job.
const HOMEDIR = os.homedir();
const shownPath = p => (p.startsWith(HOMEDIR + path.sep) ? `~${p.slice(HOMEDIR.length)}` : p);
function told(j) {
  if (j.state === 'cancelled') return;
  const how = j.state === 'done' ? `finished: exit ${j.code}` : j.state === 'skipped' ? `was skipped: ${j.why}`
    : j.state === 'failed' ? `didn't start: ${j.why}` : `was lost: ${j.why}`;
  try {
    noteAs({ who: j.who, session: j.session, agentId: j.agentId, label: j.label, spid: j.spid, sstart: j.sstart },
      `${j.id} (${j.purpose || j.cmd.join(' ').slice(0, 40)}) ${how}. Log: ${shownPath(logOf(j.id))}`);
  } catch (e) { log(`dibs later: couldn't tell ${j.agent || j.who} how ${j.id} ended: ${e.message}`); }
}

// Whether a scheduled job is due: true, false, or { skip: why }.
function due(j, t, live) {
  if (j.at != null) return t >= j.at;
  const a = j.after;
  if (a.later) {
    const dep = live.jobs.find(x => x.id === a.later);
    if (!dep) return { skip: `${a.later} is gone from the list` };
    if (ACTIVE.has(dep.state)) return false;
    if (dep.state === 'cancelled' || dep.state === 'skipped') return { skip: `${a.later} was ${dep.state}` };
    if (j.ok && !(dep.state === 'done' && dep.code === 0)) return { skip: `${a.later} ${dep.state === 'done' ? `exited ${dep.code}` : dep.state === 'failed' ? 'failed to start' : 'was lost'}` };
    return true;
  }
  live.leases ??= liveIds(t);
  if (a.ids.some(id => live.leases.ids.has(id))) return false;
  const bad = j.ok && endedOk(a.ids);
  return bad ? { skip: bad } : true;
}

// One look: claim what's due, then start it outside the lock. Any number of
// runners can look at once; a job is claimed by exactly one of them.
export function tick(t = now()) {
  if (!fs.existsSync(FILE)) return 0;
  const me = { pid: process.pid, pstart: pstart(process.pid) };
  const claimed = locked(s => {
    const live = { jobs: s.jobs };
    const out = [];
    for (const j of s.jobs.filter(j => j.state === 'scheduled')) {
      const d = due(j, t, live);
      if (d?.skip) { end(j, 'skipped', { why: d.skip }, t); continue; }
      if (!d) continue;
      Object.assign(j, { state: 'started', fired: t, runner: me });
      if (j.at != null && t - j.at > LATE) j.late = t - j.at;
      out.push({ ...j });
    }
    return out;
  });
  for (const j of claimed) start(j);
  return claimed.length;
}

function start(j) {
  const fail = why => locked(s => { const x = s.jobs.find(x => x.id === j.id); if (x?.state === 'started' && !x.pid) end(x, 'failed', { why }); });
  if (!fs.existsSync(j.cwd)) return fail(`its folder ${j.cwd} is gone`);
  let fd;
  try {
    // Each job's log is new here. On Windows an append handle has no plain write
    // access, and Git Bash's programs (echo, printf) fail to write through it.
    fd = fs.openSync(logOf(j.id), OS === 'windows' ? 'w' : 'a', 0o600);
    fs.writeSync(fd, `dibs later ${j.id}: ${j.cmd.join(' ')} in ${j.cwd}, ${trigger(j)}, started ${new Date(j.fired).toISOString()}`
      + `${j.late ? `; ran late by ${dur(j.late)} (the machine was asleep or no runner was up)` : ''}\n`);
  } catch (e) { return fail(`couldn't write its log: ${e.message}`); }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('DIBS_') && !DIBS_WHO.has(k)) env[k] = v;
  for (const [k, v] of Object.entries(j.env || {})) if (!notEnv(k)) env[k] = v;
  Object.assign(env, { DIBS_AGENT: j.agent || j.who, DIBS_NO_SESSION: '1', DIBS_LATER_JOB: j.id });
  let child;
  try {
    // Detached, with output straight into the log: the run outlives this
    // runner (a service restart, say), and the exit file still records how it ended.
    // Through bin/dibs.mjs's sh lines, so the run waits thin like any other (Node on Windows).
    const argv = OS === 'windows' ? [process.execPath, ...LEAN, BIN] : ['/bin/sh', BIN];
    child = spawn(argv[0], [...argv.slice(1), ...runArgs(j)], { cwd: j.cwd, env, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
  } catch (e) { fs.closeSync(fd); return fail(`couldn't start dibs run: ${e.message}`); }
  fs.closeSync(fd);
  child.on('error', e => fail(`couldn't start dibs run: ${e.message}`));
  child.unref();
  if (child.pid) locked(s => { const x = s.jobs.find(x => x.id === j.id); if (x) Object.assign(x, { pid: child.pid, pstart: pstart(child.pid) }); });
}

// The dibs run a job becomes: the scheduler's flags, waiting as long as it takes.
export function runArgs(j) {
  const args = ['run', j.res.join(','), '--wait', '--as', j.label ? `${j.label}, later ${j.id}` : `later ${j.id}`, '--notify', exitOf(j.id)];
  if (j.purpose) args.push('-m', j.purpose);
  if (j.prio) args.push('-p', j.prio);
  if (j.est) args.push('--est', `${Math.round(j.est / 1000)}s`);
  if (j.mem) args.push('--mem', String(j.mem));
  if (j.cpu != null) args.push('--cpu', String(j.cpu));
  if (j.disk) args.push('--disk', String(j.disk));
  for (const p of j.ports || []) args.push('--port', p);
  if (j.anywhere) args.push('--anywhere');
  if (j.on) args.push('--on', j.on);
  for (const b of j.bring || []) args.push('--bring', b);
  return [...args, '--', ...j.cmd];
}

// The runners up right now, each a file named by its pid holding its start time.
function runners() {
  let names = [];
  try { names = fs.readdirSync(RUNNERS); } catch { return []; }
  const pids = names.map(Number).filter(Boolean);
  const alive = makeAlive(pids);
  return pids.filter(pid => {
    let st = null;
    try { st = fs.readFileSync(path.join(RUNNERS, String(pid)), 'utf8') || null; } catch {}
    if (alive(pid, st)) return true;
    fs.rmSync(path.join(RUNNERS, String(pid)), { force: true });
    return false;
  });
}

// The runner loop, in the worker service or on its own (dibs later run).
// idleExit: leave once nothing is scheduled or running, or the folder is gone.
export async function runLater({ idleExit = false } = {}) {
  const mine = path.join(RUNNERS, String(process.pid));
  fs.mkdirSync(RUNNERS, { recursive: true });
  fs.writeFileSync(mine, pstart(process.pid) || '');
  const quit = () => { fs.rmSync(mine, { force: true }); process.exit(0); };
  if (idleExit) for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, quit);
  for (;;) {
    try { tick(); } catch (e) { log(`dibs later: ${e.message}`); }
    if (idleExit && (!fs.existsSync(DIR) || !load().jobs.some(j => ACTIVE.has(j.state)))) quit();
    await sleep(TICK);
  }
}

function trigger(j) {
  if (j.at != null) {
    const far = new Date(j.at).toDateString() !== new Date(j.created).toDateString();
    return `at ${clock(j.at)}${far ? ` ${new Date(j.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}`;
  }
  const a = j.after;
  const what = a.later || `${a.who}'s ${a.res.map(r => short(r)).join(',')}${a.ids.length === 1 ? ` (#${a.ids[0]})` : ''}`;
  return `after ${what}${j.ok ? ' succeeds' : ''}`;
}

// What a job is doing now, for list and the board. A started job is running
// once its dibs run holds the lease, and waiting in the queue until then.
function phase(j, leases) {
  if (j.state !== 'started') return j.state;
  // Sent to another machine, it holds no lease here.
  return j.pid && (j.anywhere || j.on || leases.some(l => l.pid === j.pid)) ? 'running' : 'waiting';
}

function view(j, leases, t) {
  const p = phase(j, leases);
  return { id: j.id, state: p, res: j.res, who: j.who, agent: j.agent, label: j.label, purpose: j.purpose, cmd: j.cmd.join(' '), cwd: j.cwd,
    when: trigger(j), at: j.at ?? null, after: j.after ?? null, ok: !!j.ok, created: j.created, fired: j.fired ?? null, late: j.late ?? null,
    ended: j.ended ?? null, code: j.code ?? null, why: j.why ?? null, log: logOf(j.id), in: j.at != null && p === 'scheduled' ? j.at - t : null };
}

function snapshot(t = now()) {
  if (!fs.existsSync(FILE)) return [];
  const jobs = locked(s => s.jobs);
  const leases = jobs.some(j => j.state === 'started') ? liveIds(t).leases : [];
  return jobs.map(j => view(j, leases, t));
}

const where = v => (v.state === 'scheduled' ? `${v.when}${v.in != null ? ` (in ${dur(v.in)})` : ''}`
  : v.state === 'waiting' ? `${v.when}, waiting in the queue since ${clock(v.fired)}`
  : v.state === 'running' ? `${v.when}, running`
  : `${v.when}, ${v.state === 'done' ? `exit ${v.code}` : v.state}${v.why ? ` (${v.why})` : ''} at ${clock(v.ended)}`)
  + (v.late ? `, ran late by ${dur(v.late)}` : '');
const line = v => `  ${v.id.padEnd(4)} ${v.res.map(r => short(r)).join(',').padEnd(11)} ${tag(v).padEnd(20)} ${v.purpose ? `"${v.purpose}" ` : ''}${where(v)}  ${v.cmd.slice(0, 40)}`;

// The same in the plain board's words: "l3: web-app's "ios snapshot suite"
// for the simulator", then when: "at 02:00 (in about 5 hr)".
const ENDED = { done: 'finished', failed: "didn't start", lost: 'was lost', skipped: 'was skipped', cancelled: 'was cancelled' };
export function laterPlain(v, cfg) {
  const what = `${v.id}: ${tag(v)}'s ${v.purpose ? `"${v.purpose}"` : v.cmd.slice(0, 40)} for ${v.res.map(r => named(cfg, r).the).join(' and ')}`;
  const when = v.state === 'scheduled' ? `${v.when}${v.in != null ? ` (in ${about(v.in)})` : ''}`
    : v.state === 'waiting' ? `${v.when}, waiting in ${named(cfg, v.res[0]).queue} since ${clock(v.fired)}`
    : v.state === 'running' ? `${v.when}, running now`
    : `${v.when}, ${ENDED[v.state]}${v.state === 'done' ? ` with exit ${v.code}` : ''}${v.why ? ` (${v.why})` : ''} at ${clock(v.ended)}`;
  return { what, when: `${when}${v.late ? `, ran late by ${minutes(v.late)}` : ''}.` };
}

// The board's LATER section: what is scheduled, waiting or running.
export function laterBoard(t = now()) {
  return snapshot(t).filter(v => ['scheduled', 'waiting', 'running'].includes(v.state))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.created - b.created);
}
export const laterLines = jobs => (jobs.length ? ['', 'LATER', ...jobs.map(line)] : []);

// dibs later <res> [--at 2:00 | --in 3h | --after <what> | --after-ok <what>] [--env NAME] [flags] -- <cmd>
// dibs later list [--json] | cancel <id> | run
export async function later(argv, cfg, parse) {
  try {
    const [sub, ...rest] = argv;
    if (sub === 'list' || sub === 'ls') return list(parse(rest), cfg);
    if (sub === 'cancel') return cancel(rest);
    if (sub === 'run') return runLater({ idleExit: rest.includes('--idle-exit') });
    return schedule(argv, parse);
  } catch (e) {
    if (e.exit) die(e.message, e.exit);
    throw e;
  }
}

function schedule(argv, parse) {
  const dd = argv.indexOf('--');
  const own = {}, pass = [];
  for (let i = 0; i < (dd < 0 ? argv.length : dd); i++) {
    const a = argv[i], next = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === '--at') own.at = next();
    else if (a === '--in') own.in = next();
    else if (a === '--after') own.after = next();
    else if (a === '--after-ok') { own.after = next(); own.ok = true; }
    else if (a === '--env') (own.env ||= []).push(next());
    else pass.push(a);
  }
  const o = parse(dd < 0 ? pass : [...pass, ...argv.slice(dd)]);
  if (!o.cmd?.length) die('nothing to run. Use: dibs later <resource> --at 02:00 -- <command>');
  if (!o.res.length) die('name a resource, e.g. dibs later test --in 3h -- npm test');
  if ([own.at, own.in, own.after].filter(x => x != null).length !== 1) die('say when, once: --at 02:00, --in 3h, --after <#id|agent|later id> or --after-ok <...>');
  for (const [f, bad] of [['--by', o.by], ['--max-wait', o.maxWait], ['--notify', o.notify], ['--for', o.for]])
    if (bad != null) die(`${f} doesn't go with dibs later. A scheduled run waits as long as it takes; dibs later list shows how it ended`);
  const t = now();
  const job = { res: o.res, cmd: o.cmd, cwd: process.cwd(), created: t, state: 'scheduled', ok: !!own.ok };
  if (own.in != null) {
    const m = String(own.in).match(/^([\d.]+)\s*d$/);
    job.at = t + (m ? parseFloat(m[1]) * 864e5 : ms(own.in));
  } else if (own.at != null) job.at = /\d{4}-\d{2}-\d{2}/.test(own.at) ? Date.parse(own.at) : deadline(own.at, t);
  if (job.at != null) {
    if (Number.isNaN(job.at)) die(`can't read the time "${own.at}" (try 02:00, 9pm or 2026-10-20T02:00)`);
    if (job.at < t - LATE) die(`${new Date(job.at).toLocaleString()} has passed. Nothing was scheduled`);
    if (job.at - t > MAX_AHEAD) die(`that's ${dur(job.at - t)} away; dibs later plans at most ${dur(MAX_AHEAD)} ahead. Nothing was scheduled`);
  }
  if (own.after != null) job.after = target(own.after);
  job.env = {};
  for (const k of ENV_KEEP) if (process.env[k] != null) job.env[k] = process.env[k];
  for (const e of own.env || []) {
    const [k, ...v] = e.split('=');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) die(`--env takes NAME or NAME=value, not ${e}`);
    if (notEnv(k)) die(`--env ${k}: dibs sets its own variables and who is calling for a scheduled run. Nothing was scheduled`);
    if (v.length) job.env[k] = v.join('=');
    else if (process.env[k] != null) job.env[k] = process.env[k];
    else die(`--env ${k}: it isn't set here. Set it, or pass ${k}=value`);
  }
  if (!o.anywhere && !o.on && !which(o.cmd[0], job.env)) die(`couldn't find ${o.cmd[0]} on the PATH it would run with. Nothing was scheduled`, 127);
  const id = identity(o);
  // Which agent of which session asked, so how it ends lands in that agent's thread (told).
  const session = process.env.CLAUDE_CODE_SESSION_ID || sessionFiles().find(f => f.pid === id.spid)?.sessionId;
  const by = session ? takeAgent('later', [], talkKey('later', dd < 0 ? argv : argv.slice(0, dd))) : null;
  Object.assign(job, { session, agentId: by?.agentId, who: id.who, agent: id.agent, label: id.label || by?.agentType, spid: id.spid, sstart: id.sstart, purpose: o.purpose || '', prio: o.prio, est: o.est, mem: o.mem,
    cpu: o.cpu, disk: o.disk, ports: o.ports, anywhere: o.anywhere, on: o.on, bring: o.bring });
  for (const k of Object.keys(job)) if (job[k] === undefined || (Array.isArray(job[k]) && !job[k].length && k !== 'cmd' && k !== 'res')) delete job[k];
  const saved = locked(s => {
    if (job.after?.later && !s.jobs.some(j => j.id === job.after.later)) return null;
    job.id = `l${++s.seq}`;
    s.jobs.push(job);
    return { ...job };
  });
  if (!saved) die(`there's no ${job.after.later} in dibs later list. Nothing was scheduled`, 1);
  console.log(`${saved.id}: ${saved.cmd.join(' ').slice(0, 60)} ${trigger(saved)}${saved.at != null ? ` (in ${about(saved.at - t)})` : ''}.`
    + ` Its output goes to ${shownPath(logOf(saved.id))}, and when it ends the person gets a note in your thread saying how. See it: dibs later list. Drop it: dibs later cancel ${saved.id}`);
  ensureRunner();
}

// --after <what>: l3 (a scheduled job), 42 or #42 (a lease or waiter on the
// board), or an agent's name, optionally :resource, meaning everything that
// agent holds or waits for right now.
function target(x) {
  if (/^l\d+$/.test(x)) return { later: x };
  const { ids } = liveIds(now());
  const n = x.match(/^#?(\d+)$/);
  if (n) {
    const hit = ids.get(Number(n[1]));
    if (!hit) die(`nothing on the board is #${n[1]} now (dibs shows the ids). Nothing was scheduled`, 1);
    const l = hit.lease || hit.waiting;
    return { ids: [l.id], who: l.agent || l.who, res: l.res };
  }
  const [who, res] = x.split(':');
  const mine = [...ids.values()].map(h => h.lease || h.waiting).filter(l => (l.agent === who || l.who === who) && (!res || l.res.includes(res)));
  if (!mine.length) die(`${who} ${res ? `holds and waits for no ${res}` : 'holds nothing and waits for nothing'} right now, so there's nothing to come after. Nothing was scheduled`, 1);
  return { ids: mine.map(l => l.id), who, res: [...new Set(mine.flatMap(l => l.res))] };
}

// The worker service is the runner that survives a reboot. Without one, start
// a runner that stays until nothing is left, and say how to make it permanent.
function ensureRunner() {
  if (runners().length) return;
  fs.mkdirSync(DIR, { recursive: true });
  const out = fs.openSync(path.join(DIR, 'runner.log'), 'a');
  const p = spawn(process.execPath, [...LEAN, BIN, 'later', 'run', '--idle-exit'], { env: process.env, stdio: ['ignore', out, out], detached: true, windowsHide: true });
  fs.closeSync(out);
  p.unref();
  say(`started a runner for scheduled jobs (pid ${p.pid}); it stops when none are left. It won't survive a restart:`
    + ' for that, the person runs dibs service install worker (it runs scheduled jobs even without other machines)');
}

// What `dibs later list --json` prints, for dibs web too.
export function laterJson(t = now(), all = snapshot(t)) {
  return { jobs: all, runners: runners() };
}

function list(o, cfg) {
  const t = now();
  const all = snapshot(t);
  if (o.json) return console.log(JSON.stringify(laterJson(t, all), null, 1));
  if (!all.length) return console.log('Nothing scheduled. To schedule a run: dibs later <resource> --at 02:00 -- <command>');
  const rank = { running: 0, waiting: 1, scheduled: 2 };
  const order = [...all].sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || (a.state === 'scheduled' ? (a.at ?? Infinity) - (b.at ?? Infinity) : (b.ended ?? 0) - (a.ended ?? 0)));
  const count = st => all.filter(v => st.includes(v.state)).length;
  const head = [[count(['scheduled']), 'scheduled'], [count(['waiting', 'running']), 'started'], [all.length - count(['scheduled', 'waiting', 'running']), 'ended in the last week']]
    .filter(([n]) => n).map(([n, w]) => `${n} ${w}`).join(', ');
  const out = [bold(`${head[0].toUpperCase()}${head.slice(1)}.`), ''];
  out.push(...columns(order.map(v => { const p = laterPlain(v, cfg); return [v.id, p.what.slice(v.id.length + 2), p.when, v.state !== 'scheduled' ? dim(`Output: ${shownPath(v.log)}`) : '']; })));
  if (!runners().length && all.some(v => v.state === 'scheduled')) out.push('', 'No runner is up, so these start when one does. The person can keep one up: dibs service install worker');
  out.push('', dim('Drop one: dibs later cancel <id>. Everything as JSON: dibs later list --json'));
  console.log(out.join('\n'));
}

function cancel(args) {
  const id = args.find(a => !a.startsWith('-'));
  if (!id) die('which? dibs later cancel <id> (dibs later list shows them)');
  const me = identity();
  const r = locked(s => {
    const j = s.jobs.find(x => x.id === id);
    if (!j) return { err: `there's no ${id} in dibs later list`, code: 1 };
    if (!ACTIVE.has(j.state)) return { err: `${id} already ${j.state === 'done' ? `ended (exit ${j.code})` : `ended (${j.state})`}`, code: 1 };
    const was = j.state;
    // dibs run passes SIGTERM to the job's process tree and gives back its lease.
    if (j.pid && makeAlive([j.pid])(j.pid, j.pstart)) process.kill(j.pid, 'SIGTERM');
    end(j, 'cancelled', { why: `by ${me.agent || me.who}` });
    return { was };
  });
  if (r.err) die(r.err, r.code);
  console.log(r.was === 'scheduled' ? `cancelled ${id}; it won't run` : `cancelled ${id} and stopped its run`);
}
