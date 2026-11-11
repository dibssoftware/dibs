// Where dibs keeps its files, what each resource costs, and how loaded the machine is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pressure, dibsMem } from './platform.mjs';
import { isFiles, FILES_COST } from './files.mjs';
import { die, ms, now, bytes } from './util.mjs';

export const HOME = process.env.DIBS_HOME || path.join(os.homedir(), '.dibs');
export const paths = {
  state: path.join(HOME, 'state.json'),
  lock: path.join(HOME, 'lock'),
  history: path.join(HOME, 'history.jsonl'),
  historyOlder: path.join(HOME, 'history.1.jsonl'),   // the one before, kept by rotate() in src/events.mjs
  config: path.join(HOME, 'config.json'),
  seen: path.join(HOME, 'seen.json'),
  ctl: path.join(HOME, 'ctl'),   // the broker's control FIFO (src/broker.mjs)
};

// A pool resource's settings when its config leaves them out. perSim: memory
// one booted simulator costs. erase: when a device is wiped before the next
// lease: other-agent (the last user was someone else), always, never.
export const POOL_DEFAULTS = { deviceType: null, runtime: null, perSim: '2G', erase: 'other-agent' };

export const DEFAULT_CONFIG = {
  budget: '8G',          // memory dibs hands out at once across running jobs
  cores: 6,              // CPU cores running jobs may use at once: what each was last measured using, or asked for until then. Lower means a quieter fan and slower queues
  minFreeMem: 15,        // jobs of 2G+ wait while the OS reports less than this % of memory free
  minDisk: '5G',         // nothing starts below this much free disk
  starveAfter: '3m',     // after this long at the head of the line, nobody jumps it
  quickUnder: '15s',     // a command that runs under this goes in the quick lane: it starts at once (src/schedule.mjs quickPass)
  roomyMemFree: 35,      // with at least this % of memory free...
  roomyLoad: 0.6,        // ...and load under this share of the cores, the memory and CPU budgets don't apply
  coolLoad: 8,           // `dibs throttle` acts when the 1-minute load average is above this
  maxLoad: null,         // normal, low and idle work waits while the 1-minute load is above this. null: no ceiling
  // Past this much swap, work below urgent waits while swap is still growing (src/config.mjs swapGrowth)
  // and anything else is running. A Mac keeps a gigabyte or two of swap in normal use and leaves it
  // allocated long after a crunch, so the total alone says nothing; past 4G and growing, it's paging hard
  // enough that the person feels it, and on macOS swap grows on the startup disk. null: no limit.
  maxSwap: '4G',
  // While the machine swaps (past maxSwap, or growing), work below urgent also keeps this much free disk
  // on top of minDisk, for swap to grow into. macOS adds swap files on the startup disk as it pages and
  // keeps them; on 2026-10-15 swap took free disk from 15 GB to 0.4 GB in ten minutes. null: off.
  swapRoom: '3G',
  pace: null,            // quiet, normal or max: sets cores, budget, maxLoad, coolLoad and the roomy rule for this machine (dibs pace)
  overlap: null,         // off, fit or squeeze: whether a job may start on top of a full resource when the machine has room (src/overlap.mjs). null: the pace decides
  squeezeUnder: '60s',   // with overlap squeeze, jobs that usually take less than this may squeeze in whatever the load
  maintainer: null,      // agent name `dibs ask` points people to for a faster answer
  hours: null,           // the person's working hours, {"start": "09:00", "end": "23:00"}: outside them, questions below urgent wait. null: any time
  agents: false,         // no limit; { slots: 8 } caps subagents running at once across every Claude Code session here (dibs guard install)
  // thin: dibs run and dibs hold wait as a 1.5 MB shell, and one broker process decides for every
  // waiter (src/thin.sh, src/broker.mjs). fat: each waits in a Node process of its own, as before
  // 0.0.95 ("node" means the same). DIBS_THIN=0 in a caller's environment makes its waits fat.
  // Read by bin/dibs.mjs's first lines, with grep.
  waits: 'thin',
  quotas: {},            // rate-limit buckets for dibs run quota:<name>, e.g. "asc": { "per": "1h", "limit": 300 }
  enforce: false,        // Linux: run each job in a systemd scope that throttles it past its memory and cores (never kills). Skipped where systemd-run --user doesn't work
  resources: {
    // pausable: low and idle runs on it may be paused for urgent work or memory
    // pressure. Not a deploy (half-done, with remote timeouts running) or the
    // simulator (the app in it isn't in the job's process tree).
    // exclusive: never two at once, however much room the machine has (overlap).
    // The one booted simulator has one screen; two deploys of one project race each other.
    // rerun: a job here can be stopped and run again from the start without harm,
    // so a run paused for low disk whose memory is going to swap can be stopped
    // and put back at the front of its line (src/preempt.mjs diskRequeue). Not a
    // deploy or anything else that changes the world half way.
    sim:           { slots: 1, mem: '3G', cpu: 1, disk: '8G', os: 'macos', pausable: false, exclusive: true },
    // Each lease gets its own simulator from a pool (src/simpool.mjs). mem counts the
    // simulator and the job driving it; free memory decides how many boot at once.
    'sim-own':     { slots: Math.max(1, Math.min(4, Math.floor(hardware().mem / 4 / 1024 ** 3))), mem: '3G', cpu: 2, disk: '6G', os: 'macos',
                     pool: { ...POOL_DEFAULTS }, pausable: false },
    // An incremental build grows DerivedData by 1-2.5G and an archive by about
    // 0.5G. 10G here once held every build back on a Mac with 9-11G free.
    'xcode-build': { slots: 2, mem: '4G', cpu: 4, disk: '4G', os: 'macos', pausable: false, rerun: true },
    playwright:    { slots: 2, mem: '3G', cpu: 2, disk: '3G', pausable: true, rerun: true },
    test:          { slots: 3, mem: '2G', cpu: 3, pausable: true, rerun: true },
    // One deploy at a time per project, up to across at once (exclusiveBy: src/schedule.mjs roomFor):
    // two projects' deploys don't touch each other, and a 6-second web deploy waited behind another
    // project's TestFlight upload (2026-11-03). slots is per project, so a config's slots: 1 reads so too. A quick deploy of
    // another project may go past across (quickAlongside).
    deploy:        { slots: 1, mem: '0.5G', cpu: 1, pausable: false, exclusive: true, exclusiveBy: 'repo', across: 3, quickAlongside: 'other-repo' },
    heavy:         { slots: 1, mem: '4G', cpu: 4, disk: '10G', pausable: true, rerun: true },
  },
  // A name dibs doesn't know is often someone's lock ("one migration at a time"), so it never overlaps.
  unknown: { slots: 1, mem: '1G', cpu: 1, pausable: false, exclusive: true },
};

// The user's file only needs the keys they change. Resources merge one level deep,
// so overriding sim's slots keeps sim's memory cost.
export function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(paths.config)) writeDefault();
  let c;
  try { c = JSON.parse(fs.readFileSync(paths.config, 'utf8')); } catch { die(`${paths.config} isn't valid JSON`); }
  const merged = { ...DEFAULT_CONFIG, ...c, resources: { ...DEFAULT_CONFIG.resources } };
  for (const [k, v] of Object.entries(c.resources || {})) merged.resources[k] = { ...(DEFAULT_CONFIG.resources[k] || {}), ...v };
  if (c.pace != null && !PACES[c.pace]) die(`pace in ${paths.config} is one of ${Object.keys(PACES).join(', ')}, or null`);
  if (merged.maxLoad != null && !(merged.maxLoad > 0)) die(`maxLoad in ${paths.config} is a load average above 0, or null for no ceiling`);
  if (c.overlap != null && !OVERLAP_MODES.includes(c.overlap)) die(`overlap in ${paths.config} is one of ${OVERLAP_MODES.join(', ')}, or null to let the pace decide`);
  ms(merged.squeezeUnder);
  // Read here so a bad value names its key, instead of every dibs run failing on "can't read size".
  if (!isSize(merged.budget)) die(`budget in ${paths.config} is a size like 8G (the memory dibs hands out at once), not ${JSON.stringify(merged.budget)}`);
  // null means no floor, as it does for maxSwap and swapRoom. The watcher still pauses jobs under its own 3G line.
  if (merged.minDisk == null) merged.minDisk = '0';
  if (!isSize(merged.minDisk)) die(`minDisk in ${paths.config} is a size like 5G, or null for no floor, not ${JSON.stringify(merged.minDisk)}`);
  if (!['thin', 'fat', 'node'].includes(merged.waits)) die(`waits in ${paths.config} is "thin" or "fat", not ${JSON.stringify(merged.waits)}`);
  if (merged.maxSwap != null) bytes(merged.maxSwap);
  if (merged.swapRoom != null) bytes(merged.swapRoom);
  for (const [k, v] of Object.entries(merged.resources)) {
    if (v.onRelease != null && typeof v.onRelease !== 'string') die(`resources.${k}.onRelease in ${paths.config} is a shell command, as a string`);
    if (v.onReleaseTimeout != null) ms(v.onReleaseTimeout);
    if (v.exclusiveBy != null && v.exclusiveBy !== 'repo') die(`resources.${k}.exclusiveBy in ${paths.config} is "repo" (one at a time per project), or null`);
    if (v.across != null && !(Number.isInteger(v.across) && v.across > 0)) die(`resources.${k}.across in ${paths.config} is how many projects may use it at once, a whole number above 0`);
    if (v.quickAlongside != null && v.quickAlongside !== 'other-repo') die(`resources.${k}.quickAlongside in ${paths.config} is "other-repo" (a quick job of another repo starts beside this one's jobs), or null`);
  }
  if (merged.quickUnder != null && !(ms(merged.quickUnder) >= 0)) die(`quickUnder in ${paths.config} is a duration like 15s, or null for no quick lane`);
  merged.profiles = checkProfiles(c.profiles, merged.resources);
  if (c.pace) Object.assign(merged, paced(c).knobs);
  // The person's own word wins; else the pace's; else one job per slot.
  merged.overlap = c.overlap ?? PACE_OVERLAP[c.pace] ?? 'off';
  return merged;
}

// Named profiles: a resource with the ports, memory and cores a project's
// suite always needs, defined once instead of in a wrapper script:
//   "profiles": { "playwright:atlas": { "res": "playwright", "ports": ["WEB", "API"], "mem": "3G", "cpu": 2 } }
// then dibs run playwright:atlas -- npm run e2e. Checked here, so a typo
// fails every call with the key named instead of queueing for a resource
// nobody else uses.
const PROFILE_KEYS = new Set(['res', 'ports', 'mem', 'cpu', 'disk', 'est']);
// The shapes util's bytes() and ms() read, tested first so a bad value can name its key.
const isSize = v => (typeof v === 'number' && v >= 0) || /^([\d.]+)\s*([KMGT]?)B?$/i.test(String(v ?? '').trim());
const isDur = v => (typeof v === 'number' && v >= 0) || /^([\d.]+)\s*(ms|s|m|h)?$/.test(String(v ?? '').trim());
function checkProfiles(profiles, resources) {
  if (profiles == null) return {};
  const where = `in ${paths.config}`;
  if (typeof profiles !== 'object' || Array.isArray(profiles)) die(`profiles ${where} is an object of names, like { "playwright:web": { "res": "playwright", "ports": ["WEB"] } }`);
  const out = {};
  for (const [name, p] of Object.entries(profiles)) {
    const key = `profiles["${name}"] ${where}`;
    if (!/^[\w.-]+(:[\w.-]+)?$/.test(name) || /^(files|quota):/.test(name)) die(`${key}: a profile name is letters, digits, dots and dashes, with at most one colon, like playwright:web. It can't start with files: or quota:`);
    if (resources[name]) die(`${key}: ${name} is already a resource. Give the profile its own name, like ${name}:web`);
    if (!p || typeof p !== 'object') die(`${key} is an object, like { "res": "playwright", "ports": ["WEB"] }`);
    const extra = Object.keys(p).filter(k => !PROFILE_KEYS.has(k));
    if (extra.length) die(`${key}: unknown ${extra.join(', ')}. A profile sets ${[...PROFILE_KEYS].join(', ')}`);
    const res = typeof p.res === 'string' ? p.res.split(',').filter(Boolean) : p.res;
    if (!Array.isArray(res) || !res.length || !res.every(r => typeof r === 'string' && r && !profiles[r])) die(`${key}: res names the resources it takes, like "playwright" or ["playwright", "test"] (not another profile)`);
    const ports = p.ports ?? [];
    if (!Array.isArray(ports) || !ports.every(x => typeof x === 'string' && /^[A-Za-z_]\w*$/.test(x))) die(`${key}: ports is a list of variable names, like ["WEB", "API"]`);
    const sized = k => { if (p[k] == null) return undefined; if (!isSize(p[k])) die(`${key}: ${k} is a size like 3G, not ${JSON.stringify(p[k])}`); return bytes(p[k]); };
    if (p.cpu != null && !(typeof p.cpu === 'number' && p.cpu >= 0)) die(`${key}: cpu is a number of cores, like 2`);
    if (p.est != null && !isDur(p.est)) die(`${key}: est is a time like 5m, not ${JSON.stringify(p.est)}`);
    out[name] = { res, ports, mem: sized('mem'), cpu: p.cpu, disk: sized('disk'), est: p.est != null ? ms(p.est) : undefined };
  }
  return out;
}

// A request naming a profile gets its resources, its ports, and its sizes
// wherever the command line didn't give one.
export function profiled(o, cfg) {
  const ps = cfg.profiles || {};
  if (!o.res.some(r => ps[r])) return o;
  const out = { ...o, res: [], ports: [...(o.ports || [])] };
  for (const r of o.res) {
    const p = ps[r];
    if (!p) { out.res.push(r); continue; }
    out.res.push(...p.res);
    for (const x of p.ports) if (!out.ports.includes(x)) out.ports.push(x);
    for (const k of ['mem', 'cpu', 'disk', 'est']) if (o[k] == null && p[k] != null) out[k] = Math.max(out[k] ?? 0, p[k]);
  }
  out.res = [...new Set(out.res)];
  return out;
}

// One word for how hard dibs drives the machine, so nobody tunes six numbers.
// Each preset is a share of this machine's cores and memory:
//   cores     CPU cores running jobs may use at once, as measured
//   budget    memory handed out at once
//   maxLoad   load ceiling for normal, low and idle work
//   coolLoad  load where dibs throttle moves outside work to background priority
//   roomyLoad the budgets are skipped below this share of the cores (0: never),
//             with roomyMemFree % of memory free
// quiet keeps the load at half the cores, where the fan stays slow and the
// person at the Mac doesn't feel a thing, and never skips the budgets. normal
// is the stock numbers (on a 10-core 16 GB Mac) plus a ceiling at one runnable
// job per core, past which the person starts to feel it. max hands out three
// quarters of memory and stops at 1.5 jobs per core: past that, jobs only
// slow each other down. Its CPU budget is that same 1.5 per core, since the
// budget counts the cores jobs are measured using, and it never skips the
// memory budget: in docs/benchmarks.md, skipping it when the machine looked
// roomy made max no faster and was the only setting that swapped.
export const PACES = {
  quiet:  { cores: 0.4, budget: 0.4,  maxLoad: 0.5, coolLoad: 0.5, roomyLoad: 0,   roomyMemFree: 35 },
  normal: { cores: 0.6, budget: 0.5,  maxLoad: 1,   coolLoad: 0.8, roomyLoad: 0.6, roomyMemFree: 35 },
  max:    { cores: 1.5, budget: 0.75, maxLoad: 1.5, coolLoad: 1.2, roomyLoad: 0,   roomyMemFree: 25 },
};

// Whether jobs may run on top of a full resource (src/overlap.mjs), by pace.
// quiet promises the person never feels dibs, so it keeps one job per slot.
// normal lets one on top when it fits. max also takes the load hit of quick
// jobs squeezing in.
export const OVERLAP_MODES = ['off', 'fit', 'squeeze'];
export const PACE_OVERLAP = { quiet: 'off', normal: 'fit', max: 'squeeze' };

// Cores and total memory, from DIBS_FAKE_MACHINE when it says.
export function hardware() {
  const f = process.env.DIBS_FAKE_MACHINE && JSON.parse(process.env.DIBS_FAKE_MACHINE);
  return { cores: f?.cores ?? (f ? 8 : os.cpus().length), mem: f?.memTotal ?? os.totalmem() };
}

const half = x => Math.round(x * 2) / 2;
export function paceKnobs(pace, hw = hardware()) {
  const p = PACES[pace];
  return {
    cores: Math.max(1, Math.round(hw.cores * p.cores)), budget: `${half(hw.mem * p.budget / 1024 ** 3)}G`,
    maxLoad: half(hw.cores * p.maxLoad), coolLoad: half(hw.cores * p.coolLoad), roomyLoad: p.roomyLoad, roomyMemFree: p.roomyMemFree,
  };
}

// What a pace sets, and which of its knobs the user's file pins instead. Every
// config.json dibs wrote holds the stock values, so a knob still at its stock
// value counts as unset: only one someone changed wins over the pace.
export function paced(c, hw = hardware()) {
  const knobs = paceKnobs(c.pace, hw);
  const pinned = Object.keys(knobs).filter(k => c[k] != null && c[k] !== DEFAULT_CONFIG[k]);
  for (const k of pinned) delete knobs[k];
  return { knobs, pinned };
}

// dibs pace: set or clear the pace in the user's file, leaving the rest as written.
export function writePace(pace) {
  loadConfig();
  const c = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  c.pace = pace;
  const tmp = `${paths.config}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
  fs.renameSync(tmp, paths.config);
}

// Two first calls can race here. Written aside and linked into place, so a
// reader never sees half a file and a config that appeared meanwhile is kept.
function writeDefault() {
  const tmp = `${paths.config}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  try { fs.linkSync(tmp, paths.config); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
}

// A quota (src/quota.mjs) is limited by its bucket, not by slots, and costs no
// memory or cores. Its slots only need to never run out; finite, so the
// forecast can list them.
const QUOTA_RES = { slots: 1000, mem: 0, cpu: 0, disk: 0, pausable: false };
export const resCfg = (cfg, r) => (r.startsWith('quota:') ? QUOTA_RES : isFiles(r) ? { ...FILES_COST } : { ...cfg.unknown, ...(cfg.resources[r] || {}) });

// How much swap grew and free disk fell lately. macOS leaves swap allocated
// long after the memory crunch that filled it, so what counts is swap growing
// now; and swap files grow on the startup disk, so free disk falling fast is
// the same crunch seen from the disk's side. Readings go in a small file so
// every dibs process sees the same history: one every SWAP_SAMPLE_EVERY is
// plenty to see five minutes of change and keeps writes rare, though waiters
// read the machine every few seconds.
const SWAP_FILE = path.join(HOME, 'swap.json');
export const SWAP_WINDOW = 5 * 6e4;
const SWAP_SAMPLE_EVERY = 30e3;
// The last stretch of the window, which says whether swap is still growing
// and free disk still falling now (measured from the newest reading before it). The 5-minute totals keep an old low swap
// reading (or high disk one) for five minutes after things stop moving, so
// on their own they'd hold work back, and pause jobs, long after the crunch.
// Readings are 30s apart, so this sees two or three of them.
export const RECENT = 90e3;
// Over the last SWAP_WINDOW: bytes swap grew (from its lowest reading to now),
// bytes free disk fell (from its highest reading to now) and over how long
// (drainMs, for the rate). swapRecent and drainRecent: the same over the last
// RECENT. A missing or unreadable file means neither.
export function trends(used, disk, t = now()) {
  const has = v => Number.isFinite(v);
  if (!has(used) && !has(disk)) return { swapGrowth: 0, diskDrain: 0, drainMs: 0, swapRecent: 0, drainRecent: 0 };
  let xs = [];
  try { xs = JSON.parse(fs.readFileSync(SWAP_FILE, 'utf8')).filter(x => has(x?.at) && t - x.at <= SWAP_WINDOW && (has(x.used) || has(x.disk))); } catch {}
  const grew = ys => { const u = ys.map(x => x.used).filter(has); return has(used) && u.length ? Math.max(0, used - Math.min(...u)) : 0; };
  const fell = ys => { const d = ys.map(x => x.disk).filter(has); return has(disk) && d.length ? Math.max(0, Math.max(...d) - disk) : 0; };
  const withDisk = xs.filter(x => has(x.disk));
  const top = has(disk) && withDisk.length ? withDisk.reduce((a, x) => (x.disk >= a.disk ? x : a)) : null;
  // The newest reading from before that stretch counts too, as its starting point: readings come
  // only while some dibs runs, so a gap of minutes mustn't read as nothing moving.
  const before = xs.filter(x => t - x.at > RECENT).sort((a, b) => b.at - a.at)[0];
  const lately = [...xs.filter(x => t - x.at <= RECENT), ...(before ? [before] : [])];
  const out = {
    swapGrowth: grew(xs),
    diskDrain: top ? Math.max(0, top.disk - disk) : 0,
    drainMs: top ? t - top.at : 0,
    swapRecent: grew(lately),
    drainRecent: fell(lately),
  };
  if (!xs.length || t - Math.max(...xs.map(x => x.at)) >= SWAP_SAMPLE_EVERY) {
    // Two processes may both write; the loser's reading is lost, which costs nothing.
    const tmp = `${SWAP_FILE}.${process.pid}`;
    const x = { at: t, ...(has(used) && { used }), ...(has(disk) && { disk }) };
    try { fs.writeFileSync(tmp, JSON.stringify([...xs, x])); fs.renameSync(tmp, SWAP_FILE); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }
  return out;
}
export const swapGrowth = (used, t = now()) => trends(used, null, t).swapGrowth;

// Free disk and how fast it falls, swap and how fast it grows, memory
// pressure, OS-reported free memory and load. Cached for 3s because waiters
// poll and each reading costs process spawns. The cache is shared through
// MACHINE_FILE: on 2026-11-11 a dozen waiters each took their own reading,
// three spawns of 100 ms to 1.8 s apiece on a Mac at load 30, most of them
// while holding the state lock. DIBS_FAKE_MACHINE may give
// swapGrowth, diskDrain, drainMs, swapRecent and drainRecent; otherwise they
// come from the readings file, with the fake swapUsed and diskFree.
let cache = null;
const MACHINE_FILE = path.join(HOME, 'machine.json');
const MACHINE_FRESH = 3000;
const fresh = m => Number.isFinite(m?.at) && now() - m.at < MACHINE_FRESH && m.at <= now();
function lastReading() {
  try { return JSON.parse(fs.readFileSync(MACHINE_FILE, 'utf8')); } catch { return null; }
}
function shareReading(m) {
  const tmp = `${MACHINE_FILE}.${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, MACHINE_FILE); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
export function machine() {
  if (process.env.DIBS_FAKE_MACHINE) {
    const m = { at: now(), load: 0, cores: 8, dibsMem: 0, ...JSON.parse(process.env.DIBS_FAKE_MACHINE) };
    // DIBS_FAKE_DISK names a file holding the free disk in bytes, read at each call, so a test can free disk under a waiter.
    if (process.env.DIBS_FAKE_DISK) m.diskFree = Number(fs.readFileSync(process.env.DIBS_FAKE_DISK, 'utf8'));
    // A fake that gives the 5-minute totals but not the recent ones is still moving.
    if (m.swapGrowth != null && m.diskDrain != null) return { drainMs: SWAP_WINDOW, swapRecent: m.swapGrowth, drainRecent: m.diskDrain, ...m };
    const t = trends(m.swapUsed, m.diskFree, m.at);
    return { ...m, swapGrowth: m.swapGrowth ?? t.swapGrowth, diskDrain: m.diskDrain ?? t.diskDrain, drainMs: m.drainMs ?? t.drainMs,
             swapRecent: m.swapRecent ?? (m.swapGrowth != null ? m.swapGrowth : t.swapRecent), drainRecent: m.drainRecent ?? (m.diskDrain != null ? m.diskDrain : t.drainRecent) };
  }
  if (fresh(cache)) return cache;
  // dibsMem, the full process table, only when swap is in question (schedule.mjs swapNotOurs).
  let m = lastReading();
  if (!fresh(m)) shareReading(m = { at: now(), ...pressure(HOME, m) });
  return (cache = { ...m, ...trends(m.swapUsed, m.diskFree, m.at) });
}
