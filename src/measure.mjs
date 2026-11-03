const GB = b => gb(b).replace(/G$/, ' GB');
// What jobs really use. A job's memory (--mem, or its resource's default) is
// a guess, and macOS can't cap a process tree without root, so instead of a
// cage this keeps the numbers honest: each running lease's tree is measured,
// its peak goes into history with its run time, and the next run of the same
// command is planned at what it really took.
//
// Memory is physical footprint (src/platform.mjs footprints), CPU is the
// process table's % of a core, both summed over every process group the lease
// spans plus, for a pool simulator, the simulator's own launchd_sim tree,
// which runs outside the job's. Reading footprints costs a top call, so
// it's taken at most once per SAMPLE_EVERY across the machine: whichever
// `dibs run` claims the slot measures every lease at once.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, paths, hardware, machine } from './config.mjs';
import { processes, footprints, OS } from './platform.mjs';
import { withStateIfRoom } from './state.mjs';
import { gb, now, bytes, runsOf, say, KEY_SPLIT } from './util.mjs';
import { event } from './events.mjs';

// top costs about 0.3s of CPU per call, so 10s keeps it near 3% of one core
// while anything runs, and nothing while nothing does. A build's peak lasts
// longer than that; a spike shorter than it can be missed.
export const SAMPLE_EVERY = Number(process.env.DIBS_SAMPLE_MS) || 10e3;
// The learned size is the most any of the last few measured runs used: one
// light run doesn't undo a heavy one, and a command that got lighter is
// believed after this many runs.
const LEARN_RUNS = 5;

// One process per slot wins the right to measure. The file name is the slot,
// and creating it fails for everyone else.
function claim(t) {
  const slot = Math.floor(t / SAMPLE_EVERY);
  try { fs.writeFileSync(path.join(HOME, `sample-${slot}`), '', { flag: 'wx' }); } catch { return false; }
  try { for (const f of fs.readdirSync(HOME)) if (/^sample-\d+$/.test(f) && f !== `sample-${slot}`) fs.rmSync(path.join(HOME, f), { force: true }); } catch {}
  return true;
}

// Every pid that belongs to a lease: its process groups, less those of runs
// nested in it, and the launchd_sim tree of any pool simulator it's using (its
// own, or its session's hold's).
export function treeOf(l, s, procs) {
  const groups = new Set([l.pgid, ...(l.groups || [])].filter(Boolean));
  // A dibs run nested in this one (a ship calling dibs run xcode-build) shows
  // up among its groups, but it's measured as its own lease: counting it here
  // too would plan and flag the outer job at the inner one's size.
  for (const x of s.leases || [])
    if (x.id !== l.id && x.kind === 'run' && x.pgid && x.pgid !== l.pgid && groups.has(x.pgid))
      for (const g of [x.pgid, ...(x.groups || [])]) groups.delete(g);
  const pids = new Set(procs.filter(p => groups.has(p.pgid)).map(p => p.pid));
  const holds = new Set(s.leases.filter(h => h.kind === 'hold' && h.pid && h.pid === l.spid).map(h => h.id));
  // A hold's simulator counts in one of the runs under it, the first: two test
  // runs on one held simulator each counting it charged it twice.
  const first = d => !(s.leases || []).some(x => x.kind === 'run' && x.id < l.id && x.spid === l.spid && x.covered?.includes(d.res));
  const udids = (s.pool || []).filter(d => d.udid && (d.lease === l.id || (holds.has(d.lease) && l.covered?.includes(d.res) && first(d)))).map(d => d.udid);
  if (!udids.length) return pids;
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const stack = procs.filter(p => /\blaunchd_sim\b/.test(p.args) && udids.some(u => p.args.includes(`/${u}/`))).map(p => p.pid);
  while (stack.length) {
    const pid = stack.pop();
    if (pids.has(pid)) continue;
    pids.add(pid);
    stack.push(...(kids.get(pid) || []));
  }
  return pids;
}

// Memory in bytes and CPU in cores for a set of pids. A process top didn't
// list (it started since) counts at its RSS.
export function usage(pids, procs, foot) {
  let mem = 0, cpu = 0;
  for (const p of procs) {
    if (!pids.has(p.pid)) continue;
    mem += foot?.get(p.pid) ?? p.rss ?? 0;
    cpu += p.cpu / 100;
  }
  return { mem, cpu: Math.round(cpu * 10) / 10 };
}

// Jobs can't use more memory than the machine has in use. Footprints count
// memory processes share (a browser's GPU and IPC buffers) once per process:
// on 2026-10-20 Playwright runs read 11 to 13 GB while the 16 GB Mac had more
// than half its memory free, and every later browser run was planned at the
// whole budget. When the jobs' sum is more than what's in use, each is scaled
// down by the same share.
export function fit(got, m = machine()) {
  if (m.memFree == null) return;
  const inUse = (m.memTotal || hardware().mem) * (1 - m.memFree / 100);
  const total = [...got.values()].reduce((a, u) => a + u.mem, 0);
  if (!(total > inUse)) return;
  for (const u of got.values()) u.mem = Math.round(u.mem * inUse / total);
}

// What each run ate of free disk: every fall between two measurements, less
// what swap grew by (that's memory, not anyone's files: the swap files' size where
// the OS says it, since macOS adds a gigabyte file before it's used), shared among the runs
// measured then, by the disk their resources declare (DISK_WEIGHT at least).
// Crediting each run with the whole fall, as 0.0.153 did, gave a deploy 3 GB
// for a simulator's writes and held it on the disk. A rise frees nobody's share.
const DISK_WEIGHT = 0.25 * 1024 ** 3;
function shareDisk(s, got, m, t) {
  const last = s.diskSample;
  s.diskSample = { free: m.diskFree ?? null, swap: m.swapUsed ?? null, ...(m.swapFiles != null && { files: m.swapFiles }), at: t };
  const runs = s.leases.filter(l => got.has(l.id) && !l.pausedAt);
  for (const l of runs) l.ate ??= 0;
  if (!last || last.free == null || m.diskFree == null || t - last.at > 3 * SAMPLE_EVERY) return;
  const swapGrew = Math.max(0, last.swap != null && m.swapUsed != null ? m.swapUsed - last.swap : 0,
    last.files != null && m.swapFiles != null ? m.swapFiles - last.files : 0);
  const fell = Math.max(0, last.free - m.diskFree - swapGrew);
  if (!fell || !runs.length) return;
  const w = l => Math.max(l.disk || 0, DISK_WEIGHT);
  const all = runs.reduce((a, l) => a + w(l), 0);
  for (const l of runs) l.ate += fell * w(l) / all;
}

// Measure every run lease on the machine, if this process won the slot.
// Called from each `dibs run` on its group-tracking tick. True if it measured.
export function sample(t = now()) {
  if (OS === 'windows' || !claim(t)) return false;
  // A plain read: the state file is replaced whole, never written in place.
  let s;
  try { s = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch { return false; }
  const runs = (s.leases || []).filter(l => l.kind === 'run' && l.pgid);
  if (!runs.length) return false;
  const procs = processes();
  const trees = new Map(runs.map(l => [l.id, treeOf(l, s, procs)]));
  const foot = footprints([...new Set([...trees.values()].flatMap(x => [...x]))]);
  const got = new Map([...trees].map(([id, pids]) => [id, usage(pids, procs, foot)]));
  const mm = machine();
  // Made-up footprints come with a made-up machine that doesn't match them.
  if (!process.env.DIBS_FAKE_FOOTPRINT) fit(got);
  // On a full disk this measurement is dropped; the next slot takes another.
  const tell = withStateIfRoom(s => {
    const out = [];
    shareDisk(s, got, mm, t);
    for (const l of s.leases) {
      const u = got.get(l.id);
      if (!u) continue;
      l.use = { ...u, at: t };
      // When its memory last rose past what it had reached: a job let in by the
      // stall breaker counts as settled once this is a while ago (schedule.mjs).
      if (!(u.mem <= (l.peak?.mem ?? -1) * 1.05)) l.peakAt = t;
      l.peak = { mem: Math.max(l.peak?.mem || 0, u.mem), cpu: Math.max(l.peak?.cpu || 0, u.cpu), fit: true,
        ...(l.ate != null && { ate: l.ate }) };
      const x = overAsk(l);
      if (!x) continue;
      if (!l.overAsk) {
        event({ kind: 'overask', id: l.id, res: l.res, who: l.who, agent: l.agent, sessionId: l.sessionId, key: l.key, ...x });
        if (l.notify && l.pid) out.push(l.pid);
      }
      l.overAsk = { ...x, at: l.overAsk?.at ?? t };
    }
    return out;
  }) || [];
  // The run's own dibs says it on its stderr (src/preempt.mjs noticeHandler), once the state has it.
  for (const pid of tell) try { process.kill(pid, 'SIGUSR2'); } catch {}
  return true;
}

// A job that used far more memory than it asked for: what it used, what it
// asked, what dibs planned and the --mem to pass next time, or null. Over
// OVER_ASK times its plan and by OVER_ASK_MIN or more: footprints wobble, and
// half a gigabyte over on a small job isn't worth an agent's attention. A job
// dibs already plans at the whole budget (usual) has nothing better to ask for.
const OVER_ASK = 1.5;
const OVER_ASK_MIN = 1024 ** 3;
export function overAsk(l) {
  const used = Math.max(l?.peak?.mem || 0, l?.use?.mem || 0);
  if (!l || l.usual != null || !(l.mem > 0) || used < l.mem * OVER_ASK || used - l.mem < OVER_ASK_MIN) return null;
  return { used, asked: l.asked ?? l.mem, planned: l.mem, suggest: `${Math.ceil(used / 1024 ** 3)}G` };
}
// Running leases that used far more than they asked, with overAsk on each: for the hook's notice to the holder.
export const overAsks = s => s.leases.filter(l => l.overAsk);
export const overAskLine = x => `this job used ${GB(x.used)} of memory but asked for ${GB(x.asked)}${x.planned > x.asked ? ` (dibs planned ${GB(x.planned)})` : ''}.`
  + ` Next time pass --mem ${x.suggest}, so dibs plans for it and doesn't start other jobs into memory this one will take.`;
// Said once per run, on its stderr: while it runs (the sampler's SIGUSR2) or when it ends.
let told = false;
export function tellOverAsk(l) {
  const x = l && (l.overAsk || overAsk(l));
  if (told || !x) return;
  told = true;
  say(overAskLine(x));
}

// The most the last LEARN_RUNS measured runs of a command used, never more
// than the machine has, or null when none was measured.
// A command never measured borrows from its family: the same resources,
// program and next word (util.mjs KEY_SPLIT), so npx playwright test a.spec.ts
// learns from b.spec.ts. On 2026-10-15 each Playwright spec ran under its own
// key, used 5.5 GB of the 3 GB asked, and none ever learned it. The next word
// matters for wrappers: npm run build and npm run lint, or wrangler d1 and
// wrangler deploy, are different programs, and a family of just the wrapper
// lent one's size to the others.
function family(key) {
  const [head, more = ''] = String(key).split(KEY_SPLIT);
  const next = more.split(' ')[0];
  return next ? `${head}${KEY_SPLIT}${next}` : head;
}
// Only runs measured with fit() count: earlier ones counted shared memory in
// every process, and planned browser runs at three times what they used.
export function learned(hist, key, cores = hardware().cores) {
  let runs = runsOf(hist, key).filter(h => h.mem > 0 && h.fit);
  if (!runs.length) runs = hist.filter(h => h.mem > 0 && h.fit && family(h.key) === family(key));
  runs = runs.slice(-LEARN_RUNS);
  if (!runs.length) return null;
  // The middle run, not the biggest: one run that read 15 GB (a browser's shared
  // memory counted in every process) planned every later Playwright run at the
  // whole budget on 2026-10-20, and twenty jobs waited on a Mac with 8.6 GB free.
  // A run that outgrows its plan books what it uses anyway (memOf).
  const mems = runs.map(h => h.mem).sort((a, b) => a - b);
  const mem = mems[Math.floor(mems.length / 2)];
  return { mem: Math.min(mem, hardware().mem), cpu: Math.min(Math.max(...runs.map(h => h.cpu || 0)), cores) };
}

// A job's size as dibs plans it: what it asked for, raised to what its
// command has really used. asked and askedCpu keep the declared numbers. A
// command that has used more than the whole memory budget is planned at the
// budget, with usual saying what it used: it waits for the budget to empty,
// not for a machine with no leases at all.
export function sized(size, hist, key, cfg) {
  const got = learned(hist, key, cfg.cores);
  if (!got) return size;
  const out = { ...size };
  const budget = bytes(cfg.budget);
  if (got.mem > size.mem) Object.assign(out, got.mem > budget && size.mem <= budget ? { mem: budget, asked: size.mem, usual: got.mem } : { mem: got.mem, asked: size.mem });
  // Like memory: a learned number past the CPU budget is planned at the budget, so the job can still start alone.
  if (Math.ceil(got.cpu) > size.cpu) Object.assign(out, { cpu: size.cpu <= cfg.cores ? Math.min(Math.ceil(got.cpu), cfg.cores) : Math.ceil(got.cpu), askedCpu: size.cpu });
  return out;
}

// "uses ~6.1G (asked 4.0G) and 5 cores (asked 3)", or for a job planned at
// the budget "usually uses ~14.1G and 8 cores (asked 4); planned at the 11.0G
// budget", or '' when it fits what it asked.
export const cappedLine = x => (x.usual != null ? `usually uses ~${gb(x.usual)}; planned at the ${gb(x.mem)} budget` : '');
// The same, in a sentence: "xcodebuild used up to 6.0 GB of memory in recent
// runs (it asks for 4.0 GB), so dibs plans for that." A job bigger than all
// the memory dibs shares out is planned at all of it, and waits for it to be free.
export function grewPlain(x, key) {
  const what = key.replace(KEY_SPLIT, ' ');
  const cores = x.askedCpu != null ? `${x.cpu} cores (it asks for ${x.askedCpu})` : '';
  if (x.usual != null)
    return `${what} usually uses up to ${GB(x.usual)} of memory${cores ? ` and ${cores}` : ''}, more than the ${GB(x.mem)} dibs shares out at once,`
      + ` so dibs plans it at all ${GB(x.mem)}: it starts when no other job is using that memory.`;
  const parts = [x.asked != null ? `${GB(x.mem)} of memory (it asks for ${GB(x.asked)})` : '', cores].filter(Boolean);
  return parts.length ? `${what} used up to ${parts.join(' and ')} in recent runs, so dibs plans for that.` : '';
}

export function grewLine(x) {
  const cores = x.askedCpu != null ? `${x.cpu} cores (asked ${x.askedCpu})` : '';
  if (x.usual != null) return `usually uses ~${gb(x.usual)}${cores ? ` and ${cores}` : ''}; planned at the ${gb(x.mem)} budget`;
  const parts = [x.asked != null ? `~${gb(x.mem)} (asked ${gb(x.asked)})` : '', cores].filter(Boolean);
  return parts.length ? `uses ${parts.join(' and ')}` : '';
}
