#!/usr/bin/env node
// Why did agents wait? Replays a dibs home's event log through the scheduler
// (src/schedule.mjs verdict) every 5 seconds of every wait, with the machine
// as the nearest load sample saw it, and adds up the rule that held each one.
// Also asks, for each waiting moment, whether dibs's own running jobs left the
// machine room: measured cores in use, from history.jsonl, against its cores.
//   node bench/waits.mjs ~/.dibs [path/to/other/src]   (the scheduler that ran then, if it differs)
// Read only: the config is copied to a temp folder before it's loaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const home = process.argv[2] || path.join(os.homedir(), '.dibs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-waits-'));
fs.copyFileSync(path.join(home, 'config.json'), path.join(tmp, 'config.json'));
process.env.DIBS_HOME = tmp;
const CORES = os.cpus().length, RAM = os.totalmem();
const fake = m => { process.env.DIBS_FAKE_MACHINE = JSON.stringify({ cores: CORES, memTotal: RAM, diskFree: 1e12, swapUsed: 0, ...m }); };
fake({ load: 0, memFree: 90 });
const src = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src'));
const load = f => import(pathToFileURL(path.join(src, f)).href);
const { verdict } = await load('schedule.mjs');
const { loadConfig } = await load('config.mjs');
const { jobSize } = await load('simpool.mjs');
const { sized } = await load('measure.mjs');
const cfg = loadConfig();
fs.rmSync(tmp, { recursive: true, force: true });

const lines = f => { try { return fs.readFileSync(path.join(home, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const events = [...lines('events.1.jsonl'), ...lines('events.jsonl')].sort((a, b) => a.at - b.at);
const hist = lines('history.jsonl');
const samples = events.filter(e => e.kind === 'sample');
const t1 = events.at(-1).at;
const starts = new Map(events.filter(e => e.kind === 'start').map(e => [e.id, e]));
const ends = new Map(events.filter(e => e.kind === 'end').map(e => [e.id, e]));
// A lease's key isn't in the event log; its history line (same agent, resources and end) has it.
const keyOf = e => hist.find(h => h.who === e.who && Math.abs(h.at - e.at) < 3000 && h.key.split('|')[0] === e.res.join(','));
const size = (res, key, at) => sized(jobSize(cfg, res, {}), hist.filter(h => h.at < at), key, cfg);

const leases = [];
for (const e of ends.values()) {
  const h = keyOf(e), a = e.at - e.ms - (e.paused || 0);
  leases.push({ id: e.id, kind: e.type, res: e.res, who: e.who, prio: e.prio, key: h?.key || '', start: a, b: e.at, ...size(e.res, h?.key || '', a), real: h?.cpu ?? null, pid: 1, expires: e.at });
}
for (const s of starts.values()) if (!ends.has(s.id)) leases.push({ id: s.id, kind: s.type, res: s.res, who: s.who, prio: s.prio, key: '', start: s.at, b: t1, ...size(s.res, '', s.at), real: null, pid: 1, expires: t1 });
// Holds and runs of the same agent: a hold covers that agent's runs on it.
const spid = who => 1000 + [...new Set(events.map(e => e.who))].indexOf(who);
for (const l of leases) { l.spid = spid(l.who); if (l.kind === 'hold') l.pid = l.spid; }

const waits = events.filter(e => e.kind === 'wait').map(w => {
  const end = starts.get(w.id)?.at ?? t1;
  const later = ends.get(w.id), h = later && keyOf(later);
  return { id: w.id, res: w.res, who: w.who, prio: w.prio, kind: w.type, enq: w.at, b: end, key: h?.key || '', ...size(w.res, h?.key || '', w.at), pid: 1, spid: spid(w.who) };
});

const STEP = 5000;
const rules = {}, room = { yes: 0, no: 0 };
let total = 0;
const near = t => samples.reduce((best, s) => (Math.abs(s.at - t) < Math.abs(best.at - t) ? s : best), samples[0]);
for (const w of waits) {
  for (let t = w.enq; t < w.b; t += STEP) {
    const s = near(t);
    fake({ at: t, load: s.load, memFree: s.memFree });
    const state = { leases: leases.filter(l => l.start <= t && l.b > t), queue: waits.filter(q => q.enq <= t && q.b > t) };
    const past = hist.filter(h => h.at < t);
    let v = verdict(state, w, cfg, past, t), rule = v.ok ? 'could start (replay)' : v.rule;
    // Behind someone: name what holds the one in front, a few deep.
    for (let i = 0, x = v; i < 5 && x.rule === 'ahead' && x.ahead; i++) {
      x = verdict(state, x.ahead, cfg, past, t);
      if (x.rule !== 'ahead') { rule = `ahead, front waits on ${x.ok ? 'nothing' : x.rule}`; break; }
    }
    rules[rule] = (rules[rule] || 0) + STEP;
    // Measured cores of dibs's running jobs (60% of their peak, as bench/sim.mjs assumes), plus the waiter's.
    const used = state.leases.reduce((a, l) => a + (l.real != null ? 0.6 * l.real : l.kind === 'hold' ? 0.5 : 1), 0);
    room[used + 0.6 * w.cpu <= CORES && s.memFree >= 25 ? 'yes' : 'no'] += STEP;
    total += STEP;
  }
}
const m = x => `${(x / 6e4).toFixed(0)}m`;
console.log(`${new Date(events[0].at).toISOString()} to ${new Date(t1).toISOString()}: ${waits.length} waits, ${m(total)} waiting in all`);
console.log('rule holding them:');
for (const [k, v] of Object.entries(rules).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${m(v).padStart(5)}  ${Math.round(100 * v / total)}%`);
console.log(`machine had room (dibs jobs' measured cores fit, 25%+ memory free): ${m(room.yes)} of ${m(total)} (${Math.round(100 * room.yes / total)}%)`);
const ls = samples.map(s => s.load).sort((a, b) => a - b), fs_ = samples.map(s => s.memFree).sort((a, b) => a - b);
console.log(`load samples: median ${ls[ls.length >> 1].toFixed(1)}, max ${ls.at(-1).toFixed(1)}; memory free: median ${fs_[fs_.length >> 1]}%, min ${fs_[0]}%`);
// What the memory budget saw against what the jobs held: planned memory of
// running leases, and their measured peaks, averaged over the load samples.
let planned = 0, peak = 0, n = 0;
for (const s of samples) {
  const run = leases.filter(l => l.start <= s.at && l.b > s.at);
  planned += run.reduce((a, l) => a + l.mem, 0);
  peak += run.reduce((a, l) => a + (hist.find(h => h.key === l.key && Math.abs(h.at - l.b) < 3000)?.mem ?? 0), 0);
  n++;
}
console.log(`memory budget: ${(planned / n / 1024 ** 3).toFixed(1)}G handed out on average, against ${(peak / n / 1024 ** 3).toFixed(1)}G measured at the jobs' peaks (holds aren't measured)`);
