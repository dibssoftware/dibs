// On-demand machines: cloud VMs that sleep until a job needs them, then wake,
// take it, and stop again once idle, because every second one runs is billed.
// Configured on the coordinator (config.json), by a row in a registry of who
// owns which VM, never by id (ids change):
//   "machines": { "ondemand": [{ "name": "boat-1", "provider": "boat", "registry": "~/boat/VMS.md", "match": "dibs", "owner": "alex-3b" }] }
// The registry is a markdown table (VM | Owner | Shared with | Use | Notes).
// dibs takes the one row whose Use mentions match (and whose Owner is owner,
// when given), checks that VM exists, and keeps that row's Notes current.
// The coordinator lists each as a machine that is asleep. A job sent --on it,
// or --anywhere when its wait here would outlast waking the VM, wakes it:
// boat resume, a reverse forward so the VM's 127.0.0.1:<port> reaches this
// coordinator with no Tailscale, dibs and a pinned Node installed there when
// missing or out of date, a fresh invite token, then a worker. After idleStop
// (30s unless set, 3m at most) with nothing running or sent to it, it's
// stopped. boat's own auto-stop
// (one hour) stays as the backstop, and is pushed back only while a job runs.
//
// With "create": { "max": "large" } it also has a temporary sibling, <name>-temp,
// for jobs bigger than it (more --mem or --cpu): a VM made for them in the
// smallest size that fits (boat new --type), listed in the registry while it
// lives, and deleted, row and all, once its queue is empty or anything fails.
// One left behind by a crash is deleted when the coordinator starts.
//
// Only boat is supported. The boat CLI is `boat` on PATH, or DIBS_BOAT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.mjs';
import { event } from './events.mjs';
import { ms, now, log } from './util.mjs';
import { VERSION } from './version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The VM's side. Everything on it may vanish: dibs keeps nothing there it can't put back.
const VM_HOME = '/home/user';
const APP = `${VM_HOME}/dibs-app`;
const NODE_DIR = `${VM_HOME}/.dibs-node`;
// Node for the VM, pinned with its checksum from nodejs.org/dist/v22.23.4/SHASUMS256.txt.
// 22.23.4 fixes the Brotli hole CVE-2026-111497 (see nodecheck.mjs). A VM on another
// version reinstalls at its next wake.
export const NODE = { version: 'v22.23.4', file: 'node-v22.23.4-linux-x64.tar.xz', sha256: '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce' };
// A guess at waking until one has been measured; the measured one replaces it.
const RESUME_GUESS = 45e3;
// Sending a working copy up, a rough figure for the wake decision.
const UPLOAD_GUESS = 20e3;
// What one job ahead in a line is worth in wait, for --anywhere's wake decision:
// placement counts jobs ahead (60 points each), not minutes.
const JOB_AHEAD = 3 * 6e4;
// The worker has this long after the VM is up to check in, or the wake failed.
const FIRST_BEAT = 3 * 6e4;
// While a job runs, the VM's own auto-stop is kept at least this far off.
const EXTEND_TO = 3600, EXTEND_EVERY = 30 * 6e4;
const TICK = 5e3;
// While asleep, which VM it is and whether boat still has it is looked up this often, for the board and placement.
const RECHECK = 5 * 6e4;
const STATES_UP = new Set(['running', 'idle', 'up', 'ready', 'starting', 'resuming', 'pending']);

// The on-demand machines config.json names, checked. Throws with what's wrong.
export function ondemandOf(cfg) {
  const list = cfg?.machines?.ondemand;
  if (list == null) return [];
  const like = '[{ "name": "boat-1", "provider": "boat", "registry": "~/boat/VMS.md", "match": "dibs" }]';
  if (!Array.isArray(list)) throw new Error(`machines.ondemand in config.json is a list, like ${like}`);
  return list.map((m, i) => {
    const at = `machines.ondemand[${i}] in config.json`;
    if (!m || typeof m !== 'object') throw new Error(`${at} is an object, like ${like}`);
    if (!/^[\w.-]+$/.test(m.name || '')) throw new Error(`${at}: name is letters, digits, dots, dashes and underscores`);
    if (m.provider !== 'boat') throw new Error(`${at}: provider is "boat", the only one dibs knows`);
    if (m.id != null) throw new Error(`${at}: no id. VM ids change, so dibs finds the VM in its registry: "registry": "~/boat/VMS.md", "match": "dibs"`);
    if (typeof m.registry !== 'string' || !m.registry) throw new Error(`${at}: registry is the file that says who owns which VM, like "~/boat/VMS.md"`);
    if (typeof m.match !== 'string' || !m.match.trim()) throw new Error(`${at}: match is a word in the Use column of this VM's row, like "dibs"`);
    if (m.create != null && !SIZES[m.create?.max]) throw new Error(`${at}: create is { "max": "small" }, "default" or "large": the biggest VM dibs may make for a job bigger than this one`);
    return { name: m.name, provider: m.provider, registry: m.registry.replace(/^~(?=\/)/, os.homedir()), match: m.match.trim(), owner: m.owner || null,
      idleStop: idleStopOf(m.idleStop, at), cores: m.cores ?? 4, memTotal: m.mem ? Number(m.mem) : 8 * 1024 ** 3, create: m.create ? { max: m.create.max } : null };
  });
}

// How long it may sit idle before it's stopped. Every idle second is billed:
// 30s by default (enough for a script's next job to follow its last), 3m at most.
const IDLE_DEFAULT = 30e3, IDLE_MAX = 3 * 6e4;
// boat's sizes, smallest first (boat new --help). xlarge needs a plan this account isn't on.
const SIZES = { small: { cores: 2, mem: 4 * 1024 ** 3 }, default: { cores: 4, mem: 8 * 1024 ** 3 }, large: { cores: 8, mem: 16 * 1024 ** 3 } };
// The smallest size up to max that takes every job given, or null.
export function sizeFor(need, max) {
  const names = Object.keys(SIZES);
  return names.slice(0, names.indexOf(max) + 1).find(n => need.every(j => (j.mem || 0) <= SIZES[n].mem && (j.cpu || 0) <= SIZES[n].cores)) ?? null;
}
// What a temporary VM's registry row says in Use, so dibs finds its own leftovers and nobody else's.
const tempUse = name => `dibs temporary VM (${name}) for a job too big for its dedicated one`;
function idleStopOf(v, at) {
  const t = v == null ? IDLE_DEFAULT : ms(v);
  if (t > IDLE_MAX) throw new Error(`${at}: idleStop is at most 3m, since every idle second is billed`);
  return t;
}

// The registry's table: its rows by column name, whatever order the columns
// are in or columns get added ("Kind" was, 2026-10-18). [{ i, cells, get(name) }]
function rows(text) {
  const lines = text.split('\n');
  const cellsOf = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const h = lines.findIndex(l => /^\s*\|/.test(l) && cellsOf(l).some(c => /^vm$/i.test(c)));
  if (h < 0) return [];
  const names = cellsOf(lines[h]).map(c => c.toLowerCase());
  const out = [];
  for (let i = h + 1; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = cellsOf(lines[i]);
    const get = name => cells[names.indexOf(name)] ?? '';
    if (/^bx_\w+$/.test(get('vm'))) out.push({ i, cells, names, get });
  }
  return out;
}
// The VM this machine is: { id } or { problem }, in words. Never a guess: no
// row, or more than one, is a problem, and so is a VM boat doesn't have.
export async function findVm(c) {
  let text;
  try { text = fs.readFileSync(c.registry, 'utf8'); } catch (e) { return { problem: `can't read ${c.registry} (${e.code || e.message})` }; }
  const want = c.match.toLowerCase();
  // Not the temporary VMs dibs lists beside it: their Use says "dibs" too, and on 2026-10-20
  // boat-1-temp's row made boat-1 unfindable, so jobs sent to boat-1 ran on the Mac.
  const hits = rows(text).filter(r => r.get('use').toLowerCase().includes(want) && (!c.owner || r.get('owner') === c.owner) && r.get('kind').toLowerCase() !== 'temporary');
  if (!hits.length) return { problem: `no row in ${c.registry} has "${c.match}" in its Use${c.owner ? ` with owner ${c.owner}` : ''}` };
  if (hits.length > 1) return { problem: `${hits.length} rows in ${c.registry} have "${c.match}" in their Use (${hits.map(r => r.get('vm')).join(', ')}), so dibs won't guess` };
  const id = hits[0].get('vm');
  const r = await boat(['list', '--all', '--json'], { timeout: 60e3 });
  if (r.code) return { problem: `boat list failed: ${r.err}` };
  const vm = (json(r.out)?.sandboxes || []).find(x => x.id === id);
  if (!vm) return { problem: `${c.registry} names ${id}, which boat doesn't have` };
  return { id, state: vm.state };
}
// Its row's Notes, kept current: only that row's last cell, the rest of the
// file as it was. Written whole and renamed into place, so a reader never sees half.
export function noteVm(c, id, text) {
  try {
    const all = fs.readFileSync(c.registry, 'utf8');
    const lines = all.split('\n');
    const row = rows(all).find(r => r.get('vm') === id);
    const at = row?.names.indexOf('notes');
    if (!row || at < 0) return false;
    const cells = [...row.cells];
    while (cells.length <= at) cells.push('');
    cells[at] = text.replace(/\|/g, '/').replace(/\s+/g, ' ');
    lines[row.i] = `| ${cells.join(' | ')} |`;
    const tmp = `${c.registry}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, c.registry);
    return true;
  } catch { return false; }
}
// A row added for a temporary VM, or taken out when it's deleted. Same atomic write.
function rewrite(registry, change) {
  try {
    const all = fs.readFileSync(registry, 'utf8');
    const lines = change(all.split('\n'), rows(all));
    if (!lines) return false;
    const tmp = `${registry}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, registry);
    return true;
  } catch { return false; }
}
export function addRow(registry, cells) {
  return rewrite(registry, (lines, rs) => {
    if (!rs.length) return null;
    const at = rs[rs.length - 1].i + 1;
    const row = rs[0].names.map(n => String(cells[n] ?? '').replace(/\|/g, '/'));
    lines.splice(at, 0, `| ${row.join(' | ')} |`);
    return lines;
  });
}
export const dropRow = (registry, id) => rewrite(registry, (lines, rs) => {
  const r = rs.find(x => x.get('vm') === id);
  if (!r) return null;
  lines.splice(r.i, 1);
  return lines;
});
// Temporary VMs this sibling made and a crash left listed: [id].
export const leftovers = (c, text) => rows(text).filter(r => r.get('kind').toLowerCase() === 'temporary' && r.get('use') === tempUse(c.name)).map(r => r.get('vm'));
const hhmm = (t = now()) => new Date(t).toTimeString().slice(0, 5);

// One boat call. The id always goes in, so it never acts on "the current" sandbox.
// An exec answers off a terminal in one JSON object ({ stdout, stderr, exitCode }):
// out and err are the command's own. Read raw, the wake's version check never
// matched, and every wake installed Node and dibs again (found 2026-10-19).
export function boat(args, { timeout = 60e3 } = {}) {
  return new Promise(resolve => {
    // --no-update first: after `--` it would go to the command run on the VM.
    execFile(process.env.DIBS_BOAT || 'boat', ['--no-update', ...args], { timeout, maxBuffer: 16 * 1024 ** 2, encoding: 'utf8' }, (e, out, err) => {
      const r = { code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: out || '', err: (err || e?.message || '').trim() };
      const j = args[0] === 'exec' && !args.includes('--detach') ? json(r.out) : null;
      if (j && typeof j.stdout === 'string') Object.assign(r, { out: j.stdout, err: (j.stderr || r.err).trim(), code: j.exitCode ?? r.code });
      resolve(r);
    });
  });
}
const json = s => { try { return JSON.parse(s); } catch { return null; } };

// boat's start quota (boat limits --json), read at most once a LIMITS_FOR. With
// no starts left every wake gets a 429, so dibs doesn't try: on 2026-10-19 the
// account's 200 daily starts ran out, and every job sent to boat-1 came back
// lost (76) instead of running on the Mac. Null when a start is possible, or
// when the quota can't be read (a wake that fails is handled anyway).
const LIMITS_FOR = 6e4;
let limits = { at: 0, why: null };
export async function startsBlocked() {
  if (now() - limits.at < LIMITS_FOR) return limits.why;
  const r = await boat(['limits', '--json'], { timeout: 20e3 });
  const j = r.code ? null : json(r.out);
  const day = j?.starts?.day, hour = j?.starts?.hour;
  const until = Date.parse(j?.subscriptionCurrentPeriodEnd);
  const why = !j ? null
    : [j.blockedReason, j.startBlockedReason].includes('usage_depleted')
      ? `boat's compute for this billing period is used up${until ? ` (it comes back ${new Date(until).toISOString().slice(0, 10)})` : ''}`
    : (j.canStart ?? j.starts?.canStart) === false ? "boat says no VM can start now"
    : day?.remaining === 0 ? `boat's daily starts are used up (${day.used}/${day.limit})`
    : hour?.remaining === 0 ? `boat's hourly starts are used up (${hour.used}/${hour.limit})` : null;
  limits = { at: now(), why };
  return why;
}
// How long a VM that couldn't wake is left alone: until boat's quota could have
// come back, or a few minutes for anything else.
const QUOTA_BACKOFF = 60 * 6e4, WAKE_BACKOFF = 5 * 6e4;
const QUOTA = /\b429\b|quota|rate.?limit|too many|used up|no VM can start/i;
export const cantWake = (vm, t = now()) => (vm?.cantWake && t < vm.cantWake.until ? vm.cantWake : null);

// The shell lines run on the VM. Paths are the VM's own.
const CHECK = `printf 'node=%s\\ndibs=%s\\n' "$(cat ${NODE_DIR}/.pinned 2>/dev/null)" "$(sed -n "s/.*VERSION = '\\\\(.*\\\\)'.*/\\\\1/p" ${APP}/src/version.mjs 2>/dev/null)"`;
const INSTALL_NODE = `set -e; t=$(mktemp -d); cd "$t"; curl -fsSLO https://nodejs.org/dist/${NODE.version}/${NODE.file}; `
  + `echo "${NODE.sha256}  ${NODE.file}" | sha256sum -c -; rm -rf ${NODE_DIR}; mkdir -p ${NODE_DIR}; `
  + `tar -xJf ${NODE.file} -C ${NODE_DIR} --strip-components=1; echo ${NODE.version} > ${NODE_DIR}/.pinned; cd /; rm -rf "$t"`;
// A worker from before the VM was stopped comes back with boat's snapshot, on
// the old dibs and the old token. On 2026-10-20 one took a job while the VM
// woke, was turned away when its token was replaced, and killed the job (77);
// the new worker sat waiting for it to leave. So the one in worker.pid goes
// first, if it really is a dibs worker, and the new one starts once it's gone.
// It's stopped in a call of its own, finished before the new worker starts, so it can't
// check in after dibs starts waiting for the new one.
const OLD_WORKER = 5e3;   // a worker ends its jobs and leaves in well under this
const KILL_OLD = `p=$(cat ${VM_HOME}/.dibs/worker.pid 2>/dev/null); `
  + `if [ -n "$p" ] && ps -ww -o args= -p "$p" 2>/dev/null | grep -q 'dibs.mjs worker'; then kill "$p"; i=0; `
  + `while kill -0 "$p" 2>/dev/null && [ $i -lt ${OLD_WORKER / 100} ]; do sleep 0.1; i=$((i+1)); done; kill -9 "$p" 2>/dev/null; fi; true`;
const WORKER = `mkdir -p ${VM_HOME}/.dibs; PATH=${NODE_DIR}/bin:$PATH; export PATH; cd ${VM_HOME}; `
  + `exec node ${APP}/bin/dibs.mjs worker --ephemeral >> ${VM_HOME}/.dibs/worker.log 2>&1`;

// The coordinator's side: one per configured machine. srv is makeServer's
// own (workers, jobs, trust); port is where this coordinator listens on loopback.
// clock: what idle time is measured against, so a test can move it on.
export function ondemand(list, srv, { port, tick = TICK, log: say = log, clock = now } = {}) {
  const { workers, jobs, trust } = srv;
  const vms = new Map();
  const add = c => {
    const vm = { ...c, id: null, problem: null, state: 'asleep', resumeMs: null, upSince: null, idleSince: null, extended: 0, forward: null, checked: 0 };
    vms.set(c.name, vm);
    workers.set(c.name, { name: c.name, ondemand: vm, os: 'linux', cores: c.cores, memTotal: c.memTotal, memFree: 100, load: 0, diskFree: null,
      busy: {}, running: [], pending: [], assigned: 0, seen: 0, lost: false, only: trust.only(c.name), version: VERSION });
    return vm;
  };
  for (const c of list) {
    const vm = add(c);
    if (!c.create) continue;
    // Listed at the biggest size it may make; the VM it makes is the smallest that fits.
    const max = SIZES[c.create.max];
    vm.bigger = add({ ...c, name: `${c.name}-temp`, temp: true, of: c.name, cores: max.cores, memTotal: max.mem, over: { cores: c.cores, mem: c.memTotal } }).name;
  }
  const mark = (vm, state) => {
    vm.state = state;
    const w = workers.get(vm.name);
    if (!w) return;
    w.ondemand = vm;
    // Up: its worker's check-in, held open waiting for work (src/serve.mjs), answers now with the jobs it may take.
    if (state === 'running') for (const f of (w.wake || []).slice()) f();
  };
  // Which VM it is, looked up again each time it matters (a wake, a start, now and then while asleep).
  // A temporary one is whatever dibs made, if anything.
  const refresh = async vm => {
    if (vm.temp) { vm.checked = now(); return { id: vm.id }; }
    const f = await findVm(vm);
    if (f.problem && f.problem !== vm.problem) say(`${vm.name}: ${f.problem}`);
    Object.assign(vm, { id: f.id ?? null, problem: f.problem ?? null, checked: now() });
    return f;
  };
  const busyOn = vm => {
    const w = workers.get(vm.name);
    return !!(w?.pending.length || w?.running?.length || [...jobs.values()].some(j => j.machine === vm.name && j.state !== 'done'));
  };

  // The reverse forward lives as long as the VM is up, started again if it drops.
  const forward = vm => {
    if (vm.forward || !['waking', 'running'].includes(vm.state)) return;
    const p = spawn(process.env.DIBS_BOAT || 'boat', ['--no-update', 'forward', vm.id, '--reverse', '--local', String(port)], { stdio: 'ignore' });
    vm.forward = p;
    p.on('exit', () => { vm.forward = null; if (['waking', 'running'].includes(vm.state)) setTimeout(() => forward(vm), 2000).unref(); });
    p.on('error', () => {});
  };
  const unforward = vm => { const p = vm.forward; vm.forward = null; try { p?.kill('SIGTERM'); } catch {} };

  // Jobs waiting for a VM that can't take them go back to the machine that sent
  // them, when it takes jobs. Lost (76) only when there's nowhere to go.
  const sendBack = (vm, why) => {
    for (const j of jobs.values()) {
      if (j.machine !== vm.name || j.state === 'done' || j.state === 'running') continue;
      if (workers.has(j.from) && !srv.fits(workers.get(j.from), j)) srv.move(j, j.from, `${vm.name} ${why}, so it runs on ${j.from}`);
      else srv.finish(j, srv.LOST, `${vm.name} ${why}`);
    }
    const w = workers.get(vm.name);
    if (w) Object.assign(w, { pending: [], assigned: 0 });
  };
  // Marked can't-wake until a retry time: placement skips it, a job sent --on it runs on its sender with the reason, and dibs machines says so.
  const block = (vm, why) => {
    vm.cantWake = { why, until: now() + (QUOTA.test(why) ? QUOTA_BACKOFF : WAKE_BACKOFF) };
    say(`${vm.name}: can't wake (${why}); not trying again until ${new Date(vm.cantWake.until).toISOString()}`);
    sendBack(vm, `can't wake (${why})`);
  };
  const fail = (vm, why) => {
    say(`${vm.name}: ${why}`);
    block(vm, why);
    stop(vm, `waking failed: ${why}`);
  };

  // A temporary VM in the smallest size that takes every job waiting for it,
  // listed in the registry before anything else happens to it.
  const make = async vm => {
    const w = workers.get(vm.name);
    const waiting = (w?.pending || []).map(id => jobs.get(id)).filter(j => j && j.state !== 'done');
    if (!waiting.length) return null;
    // Cores only as --cpu asked: a resource's own guess never makes a bigger VM.
    const type = sizeFor(waiting.map(j => ({ mem: j.mem, cpu: j.askedCpu ?? 0 })), vm.create.max);
    if (!type) {
      const max = SIZES[vm.create.max];
      for (const id of w.pending.splice(0)) { const j = jobs.get(id); if (j && j.state !== 'done') srv.finish(j, srv.LOST, `${vm.name}: the job needs more than the biggest VM dibs may make (${vm.create.max}: ${max.cores} cores, ${max.mem / 1024 ** 3} GB)`); }
      w.assigned = 0;
      return null;
    }
    say(`${vm.name}: making a ${type} VM for a job too big for ${vm.of}`);
    const t0 = now();
    const r = await boat(['new', '--type', type, '--json'], { timeout: 10 * 6e4 });
    const id = r.code ? null : r.out.match(/\bbx_[a-z0-9]+\b/)?.[0];
    if (!id) return { problem: `boat new failed: ${r.err || r.out.trim() || 'no sandbox id in its answer'}` };
    vm.id = id;
    vm.resumeMs = now() - t0;
    addRow(vm.registry, { vm: id, kind: 'temporary', owner: vm.owner || 'dibs', use: tempUse(vm.name),
      notes: `Created ${hhmm()} by dibs (${type}); dibs deletes it, and this row, when its jobs end` });
    Object.assign(w, { cores: SIZES[type].cores, memTotal: SIZES[type].mem });
    vm.cantWake = null;
    event({ kind: 'ondemand', act: 'create', name: vm.name, id, type, ms: vm.resumeMs });
    return { id };
  };

  // Wake it: resume (or make a temporary one), forward, install what's missing, a new token, the worker.
  const wake = async vm => {
    if (vm.state !== 'asleep') return;
    // No starts left on boat's account: don't try, and keep the jobs on the machines that sent them.
    const none = await startsBlocked();
    if (none) { block(vm, none); return; }
    mark(vm, 'waking');
    if (vm.temp) {
      const m = await make(vm);
      if (!m) { mark(vm, 'asleep'); return; }
      vm.upSince = now();
      if (m.problem) return fail(vm, m.problem);
      return setup(vm);
    }
    // Its VM can't be found: say so, and run the jobs where they came from when that machine takes jobs.
    const f = await refresh(vm);
    if (f.problem) {
      const w = workers.get(vm.name);
      for (const id of w?.pending.splice(0) || []) {
        const j = jobs.get(id);
        if (!j || j.state === 'done') continue;
        if (w) w.assigned = Math.max(0, w.assigned - 1);
        if (workers.has(j.from) && !srv.fits(workers.get(j.from), j)) srv.move(j, j.from, `${vm.name} can't be used (${f.problem}), so it runs on ${j.from}`);
        else srv.finish(j, srv.LOST, `${vm.name} can't be used: ${f.problem}`);
      }
      mark(vm, 'asleep');
      return;
    }
    const t0 = now();
    say(`${vm.name}: waking ${vm.id} for a job`);
    let r = await boat(['resume', vm.id, '--json'], { timeout: 5 * 6e4 });
    if (r.code) return fail(vm, `boat resume failed: ${r.err}`);
    vm.resumeMs = now() - t0;
    vm.upSince = now();
    vm.cantWake = null;
    event({ kind: 'ondemand', act: 'resume', name: vm.name, id: vm.id, ms: vm.resumeMs });
    noteVm(vm, vm.id, `Running dibs jobs (on-demand ${vm.name}) since ${hhmm()}. dibs stops it once its queue is empty`);
    return setup(vm);
  };
  const setup = async vm => {
    forward(vm);
    let r = await boat(['exec', '--timeout', '120', vm.id, '--', 'sh', '-c', CHECK], { timeout: 3 * 6e4 });
    if (r.code) return fail(vm, `couldn't look inside it: ${r.err}`);
    const got = Object.fromEntries(r.out.split('\n').map(l => l.trim().split('=')).filter(x => x.length === 2));
    const pinned = got.node, have = got.dibs;
    if (pinned !== NODE.version) {
      say(`${vm.name}: installing Node ${NODE.version}`);
      r = await boat(['exec', '--timeout', '600', vm.id, '--', 'sh', '-c', INSTALL_NODE], { timeout: 11 * 6e4 });
      if (r.code) return fail(vm, `installing Node failed: ${r.err}`);
    }
    if (have !== VERSION) {
      say(`${vm.name}: installing dibs ${VERSION}${have ? ` (it had ${have})` : ''}`);
      r = await boat(['push', vm.id, ROOT, '--to', APP], { timeout: 10 * 6e4 });
      if (r.code) return fail(vm, `copying dibs there failed: ${r.err}`);
    }
    // Its own token every wake, never the coordinator's: a file, so the token is in no command line or history.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-od-'));
    const file = path.join(tmp, 'remote.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}`, token: trust.invite(vm.name), name: vm.name }), { mode: 0o600 });
      r = await boat(['exec', '--timeout', '60', vm.id, '--', 'sh', '-c', `mkdir -p ${VM_HOME}/.dibs && chmod 700 ${VM_HOME}/.dibs`]);
      if (!r.code) r = await boat(['scp', file, `${vm.id}:${VM_HOME}/.dibs/remote.json`], { timeout: 2 * 6e4 });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    if (r.code) return fail(vm, `couldn't give it its token: ${r.err}`);
    vm.adopted = false;
    r = await boat(['exec', '--timeout', '30', vm.id, '--', 'sh', '-c', KILL_OLD], { timeout: 6e4 });
    if (r.code) return fail(vm, `couldn't stop the worker it had before: ${r.err}`);
    r = await boat(['exec', '--detach', vm.id, '--', 'sh', '-c', WORKER], { timeout: 2 * 6e4 });
    if (r.code) return fail(vm, `couldn't start its worker: ${r.err}`);
    vm.waitingSince = now();
  };

  const stop = async (vm, why) => {
    if (vm.state === 'stopping' || vm.state === 'asleep' && !vm.upSince) return;
    mark(vm, 'stopping');
    unforward(vm);
    let r;
    if (vm.temp) r = vm.id ? await remove(vm, vm.id, why) : { code: 0 };
    else {
      say(`${vm.name}: stopping ${vm.id} (${why})`);
      r = vm.id ? await boat(['stop', vm.id, '--json'], { timeout: 5 * 6e4 }) : { code: 1, err: 'no VM found for it' };
      if (r.code) say(`${vm.name}: boat stop failed (${r.err}). Its own auto-stop still ends it within the hour.`);
      else noteVm(vm, vm.id, `Stopped ${hhmm()} by dibs (${why})`);
    }
    event({ kind: 'ondemand', act: vm.temp ? 'delete' : 'stop', name: vm.name, id: vm.id, why, billed: vm.upSince ? Math.round((now() - vm.upSince) / 1000) : null, ok: !r.code });
    const w = workers.get(vm.name);
    if (w) Object.assign(w, { running: [], busy: {}, seen: 0, lost: false }, vm.temp ? { cores: vm.cores, memTotal: vm.memTotal } : {});
    Object.assign(vm, { upSince: null, idleSince: null, waitingSince: null, extended: 0 }, vm.temp ? { id: null } : {});
    mark(vm, 'asleep');
  };
  // A temporary VM deleted for good, and its row with it. One dibs can't delete
  // keeps its row, which says so, so the checker and the person still see it.
  const remove = async (vm, id, why) => {
    say(`${vm.name}: deleting ${id} (${why})`);
    const r = await boat(['delete', id, '--yes', '--json'], { timeout: 5 * 6e4 });
    const gone = !r.code || /not.?found|no such|doesn.t exist/i.test(r.err);
    if (gone) dropRow(vm.registry, id);
    else {
      say(`${vm.name}: boat delete ${id} failed (${r.err}). Delete it by hand: boat delete ${id} --yes`);
      noteVm(vm, id, `dibs couldn't delete it ${hhmm()} (${r.err}). Delete it: boat delete ${id} --yes`);
    }
    return gone ? { code: 0 } : r;
  };

  // Up once the worker dibs just started checks in: the current version, unless it was
  // taken back running jobs (takeBack), whatever version it is.
  const up = (vm, w) => {
    if (vm.state !== 'waking' || !vm.waitingSince || !w || w.seen < vm.waitingSince || !(vm.adopted || w.version === VERSION)) return false;
    mark(vm, 'running');
    vm.idleSince = null;
    say(`${vm.name}: up and taking jobs (woke in ${Math.round((now() - vm.upSince + vm.resumeMs) / 1000)}s)`);
    return true;
  };
  if (srv.hooks) srv.hooks.up = w => { const vm = vms.get(w.name); if (vm) up(vm, w); };
  const pass = async () => {
    for (const vm of vms.values()) {
      const w = workers.get(vm.name);
      if (vm.state === 'asleep' && w?.pending.length) { wake(vm); continue; }
      // Asleep with no job for it: whether it could wake at all, so the board says so before
      // anyone counts on it. On 2026-10-22 boat's compute ran out for the month, and boat-1
      // read "asleep: a job sent there wakes it" while every job meant for it waited on the Mac.
      if (vm.state === 'asleep' && !cantWake(vm) && now() - (vm.limitsAt || 0) > LIMITS_FOR) {
        vm.limitsAt = now();
        startsBlocked().then(why => { if (why && vm.state === 'asleep' && !cantWake(vm)) block(vm, why); }).catch(() => {});
      }
      if (vm.state === 'asleep' && now() - vm.checked > RECHECK) { vm.checked = now(); refresh(vm); continue; }
      if (vm.state === 'waking' && vm.waitingSince) {
        if (up(vm, w)) continue;
        if (now() - vm.waitingSince > FIRST_BEAT) fail(vm, 'its worker never checked in');
        continue;
      }
      if (vm.state !== 'running') continue;
      if (w?.lost) { stop(vm, 'its worker stopped reporting'); continue; }
      // A worker on an older dibs gets no new jobs (src/serve.mjs), so once its own are done
      // the VM stops, and the jobs waiting for it wake it again with this version.
      if (w && w.version !== VERSION && !w.running?.length && ![...jobs.values()].some(j => j.machine === vm.name && j.state === 'running')) {
        stop(vm, `its worker runs dibs ${w.version}, not ${VERSION}`);
        continue;
      }
      if (busyOn(vm)) {
        vm.idleSince = null;
        if (now() - vm.extended > EXTEND_EVERY) { vm.extended = now(); boat(['extend', vm.id, '--ttl', String(EXTEND_TO)]); }
        continue;
      }
      vm.idleSince ??= clock();
      if (clock() - vm.idleSince >= vm.idleStop) stop(vm, 'its queue is empty');
    }
  };
  const timer = tick ? setInterval(() => { pass().catch(e => say(`on-demand machines: ${e.stack}`)); }, tick) : null;
  timer?.unref();

  // A VM found up with dibs's worker running jobs on it was left that way by a
  // coordinator that restarted: take it back as waking, with its forward, and
  // its worker checks in and hands its jobs over (src/serve.mjs adopt).
  const takeBack = (vm, id, why) => {
    Object.assign(vm, { id, upSince: now(), idleSince: null, waitingSince: now(), adopted: true });
    mark(vm, 'waking');
    forward(vm);
    say(`${vm.name}: ${id} ${why}; picking its jobs up again`);
  };
  // On start, one of ours found up: busy with dibs's jobs, it's taken back; busy
  // with other work (boat ps), it's left running and said so; idle, stopped.
  const reconcile = async () => {
    for (const vm of vms.values()) {
      // Temporary ones a crash left behind: listed by dibs, so deleted by dibs, unless one still runs a job.
      if (vm.temp) {
        let text = '';
        try { text = fs.readFileSync(vm.registry, 'utf8'); } catch {}
        for (const id of leftovers(vm, text)) {
          const b = vm.id ? { busy: false } : await vmBusy(id);
          if (b.busy && b.ours) takeBack(vm, id, 'was left running a job');
          else await remove(vm, id, 'left from before the coordinator started');
        }
        continue;
      }
      const f = await refresh(vm);
      if (!f.id || !STATES_UP.has(f.state)) continue;
      const b = await vmBusy(f.id);
      if (b.busy && b.ours) takeBack(vm, f.id, 'was left running a job');
      else if (b.busy) say(`${vm.name}: ${f.id} is running and busy with work outside dibs (${b.why}), so it's left running`);
      else { vm.upSince = now(); await stop(vm, 'found running when the coordinator started, with nothing running on it'); }
    }
  };

  return {
    vms, wake, stop, reconcile, pass,
    // A VM still running jobs stays up through a coordinator restart; the next one takes it back.
    close: async () => {
      if (timer) clearInterval(timer);
      for (const vm of vms.values()) {
        unforward(vm);
        if (vm.upSince && busyOn(vm)) say(`${vm.name}: leaving ${vm.id} running: it has jobs, which the next coordinator picks up again`);
        else if (vm.upSince) await stop(vm, 'the coordinator is stopping');
      }
    },
  };
}

// What runs on a VM, from boat ps: ours is dibs's own worker; busy is one of its
// jobs, or other work using CPU. Boat's own services and a desktop never count.
const BASELINE = /ascii-|ariana-fswatch|cua-driver|sunshine|ibus-|Xorg|lightdm|systemd|dbus|\/sbin\/init|socat|dockerd|containerd|sshd|pipewire|wireplumber|xfce|xfwm|xfdesktop|Xvfb|polkit|snapd|cron|rsyslog/;
// Summed CPU % of other processes above which it's busy, as ~/boat/checker.mjs counts it.
const BUSY_CPU = 5;
export async function vmBusy(id) {
  const r = await boat(['ps', id, '--json'], { timeout: 60e3 });
  const ps = json(r.out)?.processes;
  // Can't tell: busy, so nothing is stopped under a job on a guess.
  if (r.code || !Array.isArray(ps)) return { busy: true, ours: false, why: `boat ps failed: ${r.err || 'no answer'}` };
  const cmds = ps.map(p => ({ c: String(p.command || ''), cpu: Number(p.cpuPercent) || 0 }));
  const ours = cmds.some(p => /dibs\.mjs worker/.test(p.c));
  const job = cmds.find(p => /dibs\.mjs run |src\/thin\.sh/.test(p.c));
  if (job) return { busy: true, ours, why: job.c.slice(0, 60) };
  const cpu = cmds.filter(p => !BASELINE.test(p.c) && !/dibs\.mjs worker/.test(p.c)).reduce((a, p) => a + p.cpu, 0);
  return { busy: cpu >= BUSY_CPU, ours, why: `cpu ${cpu.toFixed(1)}%` };
}

// Whether a job sent --anywhere should wake a sleeping VM: only when its wait
// on the best awake machine would outlast waking the VM and sending it the copy.
export function worthWaking(vm, waitPoints) {
  const wakeMs = (vm.resumeMs ?? RESUME_GUESS) + UPLOAD_GUESS;
  return waitPoints / 60 * JOB_AHEAD >= wakeMs;
}
export const wakePoints = vm => 60 * ((vm.resumeMs ?? RESUME_GUESS) + UPLOAD_GUESS) / JOB_AHEAD;
