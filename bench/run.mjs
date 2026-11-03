#!/usr/bin/env node
// The real-process benchmark: simulated agents run synthetic jobs (bench/job.mjs)
// through this checkout's dibs, or with no dibs at all, and it measures how
// long the work took and what it did to the machine.
//
//   ~/bin/dibs run heavy -p low -m "dibs benchmark" -- node bench/run.mjs --reps 2
//   node bench/run.mjs --scenarios none,owner --agents 4 --steps 5 --seed 1
//
// Run it through dibs at -p low on a shared Mac. That puts it on the
// efficiency cores (taskpolicy -b), four on this Mac, so the box it measures
// is "four slow cores and about 2 GB": the scenarios' settings are scaled to
// that (SCALE), and dibs is told so through DIBS_FAKE_MACHINE with a fixed
// reading (a moderately busy machine), which keeps other agents' work out of
// its decisions. The jobs themselves really run and really contend. The real
// machine's load, swap and free memory are sampled every 2s and reported, so
// noise from other agents is visible.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'dibs.mjs');
const JOB = path.join(HERE, 'job.mjs');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

// The box: 4 efficiency cores and 2 GB stand in for 10 cores and 16 GB.
const BOX = { cores: 4, memTotal: 2 * 1024 ** 3 };
const CPU = BOX.cores / 10, MEM = 1 / 8;
const g = x => `${Math.round(x * MEM * 1024)}M`;
// Static readings dibs sees: 30% memory free (under the default roomy rule's
// 35%, so the budgets apply unless a setting lowers it) and 1.5 cores busy
// outside the benchmark.
const READING = { ...BOX, memFree: 30, load: 1.5, busy: 1.5, diskFree: 1e12, swapUsed: 0 };
// Resource costs, scaled like the box, for the resources the jobs use.
const RES = { test: { slots: 3, mem: g(2), cpu: 3 * CPU }, build: { slots: 2, mem: g(4), cpu: 4 * CPU }, heavy: { slots: 1, mem: g(4), cpu: 4 * CPU }, sim: { slots: 1, mem: g(3), cpu: 1 * CPU }, deploy: { slots: 1, mem: g(0.5), cpu: 1 * CPU } };
const scaled = (o = {}) => ({ cores: 6 * CPU, budget: g(8), ...o, resources: { ...RES, ...(o.resources || {}) } });
export const BENCH = {
  none: null,
  defaults: scaled(),
  owner: scaled({ cores: 10 * CPU, budget: g(11), pace: 'normal' }),
  quiet: { pace: 'quiet', resources: RES },
  max: { pace: 'max', resources: RES },
  proposed: scaled({ cores: 15 * CPU, budget: g(12) }),
};

// Shapes in box units: real threads, work in core-seconds of one efficiency
// core, memory in MB. The test asks for more cores than it keeps busy, as real
// suites do.
const SHAPES = [
  { res: 'test', threads: 2, work: 8, mb: 150, w: 40 },
  { res: 'build', threads: 3, work: 12, mb: 350, w: 25 },
  { res: 'heavy', threads: 2, work: 6, mb: 300, w: 10 },
  { res: 'sim', hold: 10, mb: 0, w: 15 },
  { res: 'deploy', threads: 1, work: 1, mb: 40, w: 10 },
];
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function plan(seed, agents, steps) {
  const r = rng(seed);
  return Array.from({ length: agents }, (_, a) => Array.from({ length: steps }, () => {
    let x = r() * 100;
    const s = SHAPES.find(s => (x -= s.w) < 0) || SHAPES[0];
    return { ...s, gap: Math.round(1000 + 3000 * r()), high: a === 0 && r() < 0.4 };
  }));
}

// Spins per second of one thread at this process's priority, timed on the job
// itself, so a unit of work is about a second in every scenario of a run.
function calibrate() {
  const probe = 5e8;
  const out = spawnSync(process.execPath, [JOB, '1', '1', '0'], { env: { ...process.env, BENCH_UNIT: String(probe) } });
  return Math.round(probe / (JSON.parse(String(out.stdout)).cpuMs / 1000));
}

// The real machine: load, CPU in use, swap and free memory.
function reading() {
  const swap = String(spawnSync('sysctl', ['-n', 'vm.swapusage']).stdout).match(/used = ([\d.]+)M/);
  const free = String(spawnSync('memory_pressure', ['-Q']).stdout).match(/(\d+)%/);
  return { load: os.loadavg()[0], swap: swap ? Number(swap[1]) / 1024 : null, memFree: free ? Number(free[1]) : null };
}

async function scenario(name, seed, agents, steps, unit) {
  const cfg = BENCH[name];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-bench-'));
  if (cfg) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const env = { ...process.env, DIBS_HOME: home, DIBS_NO_SESSION: '1', DIBS_FAKE_MACHINE: JSON.stringify(READING), DIBS_SAMPLE_MS: '2000', BENCH_UNIT: String(unit) };
  for (const k of ['DIBS_LEASE', 'DIBS_AS', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID']) delete env[k];
  const samples = [];
  const before = reading();
  const sampler = setInterval(() => samples.push(reading()), 2000);
  const t0 = Date.now();
  const jobs = [];
  const runOne = (a, j) => new Promise(done => {
    const cmd = j.hold ? ['/bin/sleep', String(j.hold)] : [process.execPath, JOB, String(j.threads), String(j.work), String(j.mb)];
    // Agents ask for the resource's cost (its config), as most real calls do.
    const argv = cfg ? [BIN, 'run', j.res, '--wait', '-m', 'bench', ...(j.high ? ['-p', 'high'] : []), '--', ...cmd] : null;
    const rec = { agent: a, res: j.res, high: j.high, arrive: Date.now() - t0 };
    const child = spawn(argv ? process.execPath : cmd[0], argv || cmd.slice(1), { env: { ...env, DIBS_AGENT: `agent${a}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', () => {});
    child.on('exit', code => {
      rec.end = Date.now() - t0;
      rec.code = code;
      const line = out.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(x => x?.started);
      rec.start = line ? line.started - t0 : j.hold ? rec.end - j.hold * 1000 : rec.arrive;
      rec.cpuMs = line?.cpuMs || 0;
      jobs.push(rec);
      done();
    });
  });
  await Promise.all(plan(seed, agents, steps).map(async (list, a) => {
    for (const j of list) { await new Promise(r => setTimeout(r, j.gap)); await runOne(a + 1, j); }
  }));
  clearInterval(sampler);
  const after = reading();
  const makespan = Math.max(...jobs.map(j => j.end));
  fs.rmSync(home, { recursive: true, force: true });
  const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1] ?? 0;
  const ok = samples.filter(s => s.swap != null);
  return {
    name, seed, makespan,
    p50: pct(jobs.map(j => j.end - j.arrive), 0.5), p90: pct(jobs.map(j => j.end - j.arrive), 0.9),
    wait90: pct(jobs.map(j => j.start - j.arrive), 0.9), highWait90: pct(jobs.filter(j => j.high).map(j => j.start - j.arrive), 0.9),
    util: jobs.reduce((x, j) => x + j.cpuMs, 0) / (makespan * BOX.cores),
    failed: jobs.filter(j => j.code !== 0).length,
    swapGrew: ok.length ? Math.max(...ok.map(s => s.swap)) - before.swap : null,
    minFree: ok.length ? Math.min(...ok.map(s => s.memFree)) : null,
    loadBefore: before.load, loadAfter: after.load, loadMax: Math.max(...samples.map(s => s.load)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = (arg('scenarios') || Object.keys(BENCH).join(',')).split(',');
  const reps = Number(arg('reps', 2)), agents = Number(arg('agents', 4)), steps = Number(arg('steps', 5)), seed = Number(arg('seed', 1));
  const unit = calibrate();
  const out = arg('out');
  console.error(`unit ${unit} spins/s, ${agents} agents x ${steps} jobs, ${reps} reps`);
  const results = [];
  // Interleave the scenarios, so slow drift on the machine (other agents) hits each about equally.
  for (let r = 0; r < reps; r++) for (const n of names) {
    const x = await scenario(n, seed + r, agents, steps, unit);
    results.push(x);
    console.error(`${n} rep ${r + 1}: makespan ${(x.makespan / 1000).toFixed(1)}s p90 ${(x.p90 / 1000).toFixed(1)}s failed ${x.failed} swap +${x.swapGrew?.toFixed(2)}G load ${x.loadBefore.toFixed(1)}->${x.loadAfter.toFixed(1)}`);
  }
  if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), unit, agents, steps, reps, results }, null, 1) + '\n');
  const avg = (rs, k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
  const s = x => `${(x / 1000).toFixed(1)}s`;
  const base = avg(results.filter(r => r.name === names[0]), 'makespan');
  console.log(['scenario', 'makespan', 'vs', 'p50 job', 'p90 job', 'p90 wait', 'high p90 wait', 'cpu used', 'failed', 'swap grew', 'min free', 'load before/after'].join(' | '));
  for (const n of names) {
    const rs = results.filter(r => r.name === n);
    const m = avg(rs, 'makespan');
    console.log([n, s(m), `${m >= base ? '+' : ''}${Math.round(100 * (m / base - 1))}%`, s(avg(rs, 'p50')), s(avg(rs, 'p90')), s(avg(rs, 'wait90')), s(avg(rs, 'highWait90')),
      `${Math.round(100 * avg(rs, 'util'))}%`, avg(rs, 'failed'), `${avg(rs, 'swapGrew').toFixed(2)}G`, `${Math.min(...rs.map(r => r.minFree))}%`,
      `${avg(rs, 'loadBefore').toFixed(1)}/${avg(rs, 'loadAfter').toFixed(1)}`].join(' | '));
  }
}
