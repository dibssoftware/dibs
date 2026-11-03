#!/usr/bin/env node
// Replay a workload through dibs's real scheduler (src/schedule.mjs verdict)
// against a model of a 10-core 16 GB Mac, once per scenario, and report how
// long the work took. Deterministic and quick, so settings can be compared on
// the same work without touching the machine.
//
//   node bench/sim.mjs                                  synthetic: 6 agents, 3 seeds
//   node bench/sim.mjs --workload bench/workloads/tonight.json
//   node bench/sim.mjs --src ../other-checkout/src      the same, with another scheduler
//   node bench/sim.mjs --scenarios none,owner --json
//
// The model (what it can't know, it assumes, and says so here):
// - CPU is shared: with more runnable cores than the machine has, every job
//   slows by the same factor. Background work outside dibs uses BG_CPU cores.
// - A job's average CPU is AVG_CPU of the peak dibs measured, and it holds
//   AVG_MEM of its peak memory for its whole run.
// - Memory past SWAP_AT of RAM swaps. Swapping slows every job, by more the
//   more is swapped; past SWAP_MAX of swap the largest job is killed, as the
//   OS would when it runs out.
// - A run that takes more than TIMEOUT times its own length fails (a test
//   timeout firing). A failed run is run again, at most RETRIES times.
// - Agents wait for their own work: a job that was submitted after the same
//   agent's earlier job ended arrives that same gap after it ends here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = 1024 ** 3;
const CORES = 10, RAM = 16 * G;
const AVG_CPU = 0.6, AVG_MEM = 0.8;
const SWAP_AT = 0.9;          // macOS starts compressing and swapping hard near this share of RAM
const SWAP_MAX = (Number(process.env.SIM_SWAP_MAX) || 8) * G;   // about the swap this Mac had in use at its worst tonight (6.7G)
const SWAP_SLOW = Number(process.env.SIM_SWAP_SLOW ?? 3);   // swapping a quarter of RAM's worth slows everything to 1/(1 + 3/4)
const TIMEOUT = 3;
const RETRIES = 2, RETRY_GAP = 10e3;   // an agent reruns a failed job twice, 10s after it failed
const DT = 2000;              // dibs waiters poll every 1.5s
const LOAD_TAU = 60e3;        // the 1-minute load average's time constant

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(`--${k}`);

process.env.DIBS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-sim-'));
const fake = m => { process.env.DIBS_FAKE_MACHINE = JSON.stringify({ cores: CORES, memTotal: RAM, diskFree: 1e12, swapUsed: 0, ...m }); };
fake({ load: 0, memFree: 90, at: 0 });
const src = path.resolve(arg('src', path.join(HERE, '..', 'src')));
const load = f => import(pathToFileURL(path.join(src, f)).href);
const { verdict, byRank, holdingOf } = await load('schedule.mjs');
const { loadConfig, paths } = await load('config.mjs');
const { jobSize } = await load('simpool.mjs');
const { sized } = await load('measure.mjs');
process.on('exit', () => fs.rmSync(process.env.DIBS_HOME, { recursive: true, force: true }));

// A small seeded generator, so a seed always makes the same workload.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Job shapes from tonight's measured runs (bench/workloads/tonight.json):
// work in seconds, peak cores and peak memory.
const SHAPES = {
  test: { res: ['test'], work: 60, cpu: 4, mem: 1.4 * G, weight: 40 },
  build: { res: ['xcode-build'], work: 90, cpu: 7, mem: 3 * G, weight: 22 },
  clean: { res: ['xcode-build'], work: 240, cpu: 9, mem: 7 * G, weight: 3 },
  heavy: { res: ['heavy'], work: 45, cpu: 4, mem: 2 * G, weight: 10 },
  browser: { res: ['playwright'], work: 60, cpu: 3, mem: 1.8 * G, weight: 10 },
  sim: { res: ['sim'], work: 240, cpu: 1, mem: 2 * G, weight: 10, kind: 'hold' },
  deploy: { res: ['deploy'], work: 40, cpu: 0.3, mem: 0.3 * G, weight: 5 },
};

// K agents, each doing STEPS things in a row with a think gap between them.
// Now and then an agent starts a second job alongside the first (a test in the
// background while it builds), and one agent's work is high priority.
export function synthetic(seed, agents = 6, steps = 10) {
  const r = rng(seed);
  const pick = () => { let x = r() * 100; for (const [k, s] of Object.entries(SHAPES)) if ((x -= s.weight) < 0) return k; return 'test'; };
  const jobs = [];
  for (let a = 1; a <= agents; a++) {
    let prev = null;
    for (let i = 0; i < steps; i++) {
      const shape = SHAPES[pick()];
      const j = {
        id: jobs.length + 1, who: `agent${a}`, res: shape.res, kind: shape.kind || 'run', prio: a === 1 && r() < 0.5 ? 'high' : 'normal',
        key: `${shape.res[0]}|${Object.keys(SHAPES).find(k => SHAPES[k] === shape)}${a}`,
        dur: Math.round(shape.work * (0.7 + 0.6 * r()) * 1000), peakMem: shape.mem, peakCpu: shape.cpu,
        dep: prev, gap: Math.round((15 + 60 * r()) * 1000), arrive: prev ? null : Math.round(r() * 30e3),
      };
      jobs.push(j);
      // One step in five, the next job starts alongside this one rather than after it.
      if (r() >= 0.2) prev = j.id;
    }
  }
  return { jobs, bgCpu: 2, bgMem: 6 * G };
}

// A recorded workload: each job waits for the same agent's latest job that had
// ended before it arrived for real, then for the same gap.
export function fromTrace(w) {
  const jobs = w.jobs.map(j => ({ ...j }));
  for (const j of jobs) {
    const before = jobs.filter(p => p.who === j.who && p !== j && p.realStart + p.dur <= j.arrive);
    const dep = before.sort((a, b) => a.realStart + a.dur - (b.realStart + b.dur)).at(-1);
    if (dep && !j.before) Object.assign(j, { dep: dep.id, gap: j.arrive - (dep.realStart + dep.dur), arrive: null });
  }
  // Work outside dibs. Memory: what the machine showed in use beyond what dibs's
  // jobs were measured holding. CPU: 2 cores, not the load average, which
  // swapping inflated tonight (at 00:32 the processes were using 1.0 to 1.3
  // cores while the load average read 8.8 to 10.1).
  const med = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const bgCpu = 2;
  const bgMem = Math.max(4 * G, RAM * (1 - med(w.samples.map(s => s.memFree)) / 100) - 2 * G);
  return { jobs, bgCpu, bgMem };
}

const use = j => ({
  cpu: j.kind === 'hold' ? (j.res.some(r => r.startsWith('files:')) ? 0 : 0.5) : Math.max(0.1, (j.peakCpu ?? 1) * AVG_CPU),
  mem: j.kind === 'hold' ? (j.res.some(r => r.startsWith('sim')) ? 1.5 * G : 0) : (j.peakMem ?? 0.3 * G) * AVG_MEM,
});
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1] : 0);

// One run of one workload under one scenario. Times are milliseconds from 0.
export function simulate(work, sc) {
  const T0 = 1.8e12;   // an epoch in the near future, so history timestamps look ordinary
  let cfg = null;
  if (sc.config) {
    fs.writeFileSync(paths.config, JSON.stringify(sc.config));
    cfg = loadConfig();
    if (sc.slots) for (const r of Object.values(cfg.resources)) r.slots *= sc.slots;
  }
  const jobs = work.jobs.map(j => ({ ...j, ...use(j), spid: 1000 + Number(j.who.replace(/\D/g, '')) }));
  const byId = new Map(jobs.map(j => [j.id, j]));
  // Each command's history as agents had it: its typical length and its measured peak.
  const hist = [];
  for (const j of jobs) if (j.kind === 'run' && !hist.some(h => h.key === j.key)) for (let i = 0; i < 3; i++) hist.push({ key: j.key, dur: j.dur, who: 'past', at: T0 - 864e5, ...(j.peakMem ? { mem: j.peakMem, cpu: j.peakCpu } : {}) });
  const s = { leases: [], queue: [] };
  const run = new Map();   // id -> { j, start, done }
  let t = Math.min(...jobs.filter(j => j.arrive != null).map(j => j.arrive));
  const first = t;
  let loadAvg = work.bgCpu, peakSwap = 0, minFree = 100, busy = 0, kills = 0, timeouts = 0;
  const arrived = new Set();
  for (const j of jobs.filter(j => j.before)) start(j, t);

  function start(j, at) {
    const size = cfg ? (sc.declared ? jobSize(cfg, j.res, {}) : sized(jobSize(cfg, j.res, {}), hist, j.key, cfg)) : { mem: 0, cpu: 0 };
    const l = { id: j.id, kind: j.kind, res: j.res, who: j.who, prio: j.prio, key: j.key, start: T0 + at, mem: size.mem, cpu: size.cpu, pid: j.kind === 'hold' ? j.spid : 1e6 + j.id, spid: j.spid, expires: T0 + at + j.dur };
    s.leases.push(l);
    s.queue = s.queue.filter(q => q.id !== j.id);
    run.set(j.id, { j, l, start: at, progress: 0 });
    j.started = at;
    j.firstStart ??= at;
  }
  function finish(j, at, ok = true) {
    run.delete(j.id);
    s.leases = s.leases.filter(l => l.id !== j.id);
    // A failed run is run again by its agent, up to RETRIES times: a killed test costs its rerun.
    if (!ok && (j.attempts || 0) < RETRIES) {
      j.attempts = (j.attempts || 0) + 1;
      j.retryAt = at + RETRY_GAP;
      arrived.delete(j.id);
      return;
    }
    j.end = at;
    j.failed = !ok;
    if (ok && j.kind === 'run') hist.push({ key: j.key, dur: j.dur, who: j.who, at: T0 + at, ...(j.peakMem ? { mem: j.peakMem, cpu: j.peakCpu } : {}) });
    if (hist.length > 400) hist.splice(0, hist.length - 400);
  }

  const LIMIT = 6 * 36e5;
  while (jobs.some(j => j.end == null) && t - first < LIMIT) {
    // Arrivals.
    for (const j of jobs) {
      if (arrived.has(j.id) || j.before) continue;
      const at = j.retryAt ?? (j.dep == null ? j.arrive : byId.get(j.dep).end != null ? byId.get(j.dep).end + Math.max(0, j.gap) : null);
      if (at == null || at > t) continue;
      arrived.add(j.id);
      j.arrived ??= at;
      if (!cfg) { start(j, t); continue; }
      const size = sc.declared ? jobSize(cfg, j.res, {}) : sized(jobSize(cfg, j.res, {}), hist, j.key, cfg);
      s.queue.push({ id: j.id, res: j.res, who: j.who, prio: j.prio, key: j.key, enq: T0 + at, mem: size.mem, cpu: size.cpu, disk: 0, pid: 1e6 + j.id, spid: j.spid, kind: j.kind });
    }
    // The machine.
    const live = [...run.values()];
    const demand = work.bgCpu + live.reduce((a, x) => a + x.j.cpu, 0);
    const memUsed = work.bgMem + live.reduce((a, x) => a + x.j.mem, 0);
    const swap = Math.max(0, memUsed - SWAP_AT * RAM);
    peakSwap = Math.max(peakSwap, swap);
    const memFree = Math.max(0, Math.round(100 * (RAM - memUsed) / RAM));
    minFree = Math.min(minFree, memFree);
    loadAvg += (demand - loadAvg) * (1 - Math.exp(-DT / LOAD_TAU));
    busy += Math.min(demand, CORES) * DT;
    // dibs measures each running lease every 10s.
    for (const x of run.values()) if (t - x.start >= 10e3) x.l.use = { mem: x.j.mem, cpu: Math.round(x.j.cpu * 10) / 10 };
    // Who starts: each waiter asks dibs, best rank first, and a start counts for the next one.
    if (cfg && s.queue.length) {
      fake({ at: T0 + t, load: loadAvg, busy: demand, memFree, swapUsed: swap });
      const hidden = l => (sc.measured && run.get(l.id) ? { ...l, mem: run.get(l.id).j.mem } : l);
      for (const q of [...s.queue].sort(byRank(hist, T0 + t))) {
        q.holding = holdingOf(s, q, cfg, T0 + t);
        const view = sc.measured ? { ...s, leases: s.leases.map(hidden) } : s;
        const v = verdict(view, q, cfg, hist, T0 + t);
        if (!v.ok) { const j = byId.get(q.id); j.why ??= {}; j.why[v.rule] = (j.why[v.rule] || 0) + DT; continue; }
        start(byId.get(q.id), t);
        if (v.covered?.length) s.leases.at(-1).covered = v.covered;
      }
    }
    // Work done this tick.
    const speed = Math.min(1, CORES / demand) / (1 + SWAP_SLOW * swap / RAM);
    for (const x of [...run.values()]) {
      if (x.j.kind === 'hold') { if (t + DT - x.start >= x.j.dur) finish(x.j, t + DT); continue; }
      x.progress += DT * speed;
      if (x.progress >= x.j.dur) finish(x.j, t + DT);
      else if (t + DT - x.start > TIMEOUT * Math.max(x.j.dur, 30e3)) { timeouts++; finish(x.j, t + DT, false); }
    }
    if (swap > SWAP_MAX) {
      const big = [...run.values()].filter(x => x.j.kind === 'run').sort((a, b) => b.j.mem - a.j.mem)[0];
      if (big) { kills++; finish(big.j, t + DT, false); }
    }
    t += DT;
  }
  const done = jobs.filter(j => !j.before && j.end != null);
  const lat = done.map(j => j.end - j.arrived);
  const wait = done.map(j => j.firstStart - j.arrived);
  const urgent = done.filter(j => j.prio === 'high' || j.prio === 'urgent').map(j => j.firstStart - j.arrived);
  const why = {};
  for (const j of jobs) for (const [k, v] of Object.entries(j.why || {})) why[k] = (why[k] || 0) + v;
  const makespan = Math.max(...jobs.map(j => j.end ?? t)) - first;
  return {
    makespan, p50: pct(lat, 0.5), p90: pct(lat, 0.9), wait50: pct(wait, 0.5), wait90: pct(wait, 0.9), waitTotal: wait.reduce((a, b) => a + b, 0),
    highWait90: pct(urgent, 0.9), peakSwap, minFree, util: busy / (makespan * CORES), kills, timeouts, unfinished: jobs.filter(j => j.end == null).length, why, jobs,
  };
}

const fmt = x => (x >= 36e5 ? `${(x / 36e5).toFixed(1)}h` : x >= 6e4 ? `${(x / 6e4).toFixed(1)}m` : `${Math.round(x / 1000)}s`);
const avg = (rs, k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const names = (arg('scenarios') || Object.keys(SCENARIOS).join(',')).split(',');
  const file = arg('workload');
  const seeds = file ? [0] : Array.from({ length: Number(arg('seeds', 3)) }, (_, i) => i + 1);
  const agents = Number(arg('agents', 6));
  const out = {};
  for (const n of names) {
    const sc = SCENARIOS[n];
    if (!sc) { console.error(`no scenario ${n}. Scenarios: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2); }
    out[n] = seeds.map(seed => simulate(file ? fromTrace(JSON.parse(fs.readFileSync(file, 'utf8'))) : synthetic(seed, agents), sc));
  }
  if (flag('json')) { console.log(JSON.stringify(out, (k, v) => (k === 'jobs' ? undefined : v), 1)); process.exit(0); }
  const base = avg(out[names[0]], 'makespan');
  console.log(`${file ? path.basename(file) : `synthetic, ${agents} agents, seeds ${seeds.join(',')}`}; makespan change is against ${names[0]}`);
  console.log(['scenario', 'makespan', 'vs', 'p50 job', 'p90 job', 'p90 wait', 'high p90 wait', 'peak swap', 'min free', 'cpu used', 'failed', 'top blocker'].join(' | '));
  for (const n of names) {
    const rs = out[n];
    const why = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.why)) why[k] = (why[k] || 0) + v;
    const top = Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${fmt(v / rs.length)}`).join(', ');
    const m = avg(rs, 'makespan');
    console.log([n, fmt(m), `${m >= base ? '+' : ''}${Math.round(100 * (m / base - 1))}%`, fmt(avg(rs, 'p50')), fmt(avg(rs, 'p90')), fmt(avg(rs, 'wait90')), fmt(avg(rs, 'highWait90')),
      `${(avg(rs, 'peakSwap') / G).toFixed(1)}G`, `${Math.round(avg(rs, 'minFree'))}%`, `${Math.round(100 * avg(rs, 'util'))}%`, Math.round(10 * (avg(rs, 'kills') + avg(rs, 'timeouts') + avg(rs, 'unfinished'))) / 10, top || '-'].join(' | '));
  }
}
