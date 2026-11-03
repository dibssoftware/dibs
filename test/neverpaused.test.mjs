// dibs never leaves every job paused: only the person's own dibs pause may.
// Stopped jobs keep their memory, so with none running nothing finishes and
// every waiter waits on paused memory for good (2026-10-15, two Playwright
// runs paused for the disk after the deploy that ran beside them ended).
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict } from '../src/schedule.mjs';
import { settle, diskPause, pressurePause, preempt, ownerPause, flush } from '../src/preempt.mjs';

const WIN = process.platform === 'win32';
const T = Date.now();
const MIN = 6e4;
const cfg = { ...DEFAULT_CONFIG, budget: '11G', cores: 10, resources: { ...DEFAULT_CONFIG.resources,
  w: { slots: 3, mem: '1G', cpu: 1, pausable: true }, n: { slots: 2, mem: '1G', cpu: 1, pausable: true }, d: { slots: 1, mem: '1G', cpu: 1, pausable: false } } };
// Names a process that isn't its own, so nothing is ever signalled: a group number past
// every system's highest pid (Linux's is 4194304), which dibs rules out without asking ps.
// One ps asks, a pause in each of thousands of steps, took this file past its limit on a Linux VM.
const run = o => ({ kind: 'run', res: ['w'], who: `r${o.id}`, pgid: 99999999, pgstart: 'never', mem: G, cpu: 1, prio: 'normal', key: `w|job${o.id}`, start: T, ...o });
const DISK = { swapGrowth: 1.5 * G, diskDrain: 0 };

// A run counts as going when neither it nor a run it's nested in is paused.
function going(s) {
  const stopped = new Set(s.leases.filter(l => l.pausedAt).map(l => l.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const l of s.leases) if (l.outer != null && stopped.has(l.outer) && !stopped.has(l.id)) { stopped.add(l.id); grew = true; }
  }
  return s.leases.filter(l => l.kind === 'run' && !stopped.has(l.id));
}
const ownerStopped = l => !!l.pauses?.some(p => p.owner);

test('a run ending while the others are paused: the one closest to done resumes at once', { skip: WIN }, () => {
  // The Mac at 20:51:58: one Playwright run paused, one running, and a deploy (never paused) beside them.
  const deploy = run({ id: 4580, res: ['d'], start: T - 46 * MIN });
  const a = run({ id: 4702, est: 10 * MIN, start: T - 6 * MIN });
  const b = run({ id: 4706, est: 10 * MIN, start: T - 4 * MIN });
  const s = { leases: [deploy, a, b], queue: [] };
  assert.equal(diskPause(s, cfg, T, DISK)?.id, 4706);
  assert.equal(diskPause(s, cfg, T, DISK)?.id, 4702);
  assert.equal(diskPause(s, cfg, T, DISK), null, 'the deploy never pauses');
  // The deploy ends. Every state change ends in settle.
  s.leases = s.leases.filter(l => l !== deploy);
  settle(s, T);
  assert.deepEqual(going(s).map(l => l.id), [4702], 'resumed: 4 min left beats 6');
  assert.equal(diskPause(s, cfg, T, DISK), null, 'and the watcher leaves the last one alone');
  flush(false);
});

test('a job about to finish is never paused: finishing frees more than pausing', { skip: WIN }, () => {
  const hist = [{ key: 'w|job2', dur: 10 * MIN }];
  const s = { leases: [run({ id: 1, start: T - 2 * MIN }), run({ id: 2, start: T - 9.5 * MIN }), run({ id: 3, est: 60e3, start: T - 30e3 })], queue: [] };
  // Newest first would be 3, then 2; both are under 2 minutes from done.
  assert.equal(diskPause(s, cfg, T, DISK, hist)?.id, 1);
  assert.equal(diskPause(s, cfg, T, DISK, hist), null);
  const low = { leases: [run({ id: 1, prio: 'low', est: 60e3, start: T - 30e3 }), run({ id: 2, prio: 'low', start: T }), run({ id: 3, prio: 'low', start: T })], queue: [] };
  assert.notEqual(pressurePause(low, cfg, T, [])?.id, 1);
  assert.notEqual(pressurePause(low, cfg, T, [])?.id, 1);
  flush(false);
});

test('memory booked by paused jobs still counts: nothing starts past the budget, small or urgent', () => {
  const was = process.env.DIBS_FAKE_MACHINE;
  const judge = (s, me, m = {}) => {
    process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memTotal: 16 * G, memFree: 30, swapGrowth: 0, diskDrain: 0, ...m });
    try { return verdict(s, me, cfg, [], T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
  };
  // Paused by the person, so nothing resumes them: 12 GB of an 11 GB budget booked, none of it running.
  // A stopped job keeps its memory; never-all-paused resumes one rather than starting more on top (0.0.125).
  const paused = id => run({ id, mem: 6 * G, pausedAt: T - MIN, pauses: [{ owner: true, at: T - MIN }] });
  const s = { leases: [paused(1), paused(2)], queue: [] };
  const deploy = { id: 9, res: ['d'], who: 'b8', mem: 0.5 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'd|ship', kind: 'run', prio: 'urgent', purpose: 'hotfix' };
  assert.equal(judge(s, deploy).rule, 'memory');
  assert.equal(judge(s, { ...deploy, prio: 'normal', est: 60e3 }).rule, 'memory');
  assert.equal(judge({ leases: [paused(1)], queue: [] }, deploy).ok, true, 'with room in the budget it starts');
});

// A small seeded generator, so a failure names a seed that reproduces it.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}

test('random runs, ends, disk and memory readings, urgent arrivals and owner pauses: something is always running', { skip: WIN }, () => {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memTotal: 64 * G, memFree: 60, swapGrowth: 0, diskDrain: 0, diskFree: 500 * G });
  try {
    // SEED=n replays the one seed a failure names.
    for (let seed = Number(process.env.SEED) || 1; seed <= (Number(process.env.SEED) || 300); seed++) {
      const r = rng(seed);
      const pick = xs => xs[Math.floor(r() * xs.length)];
      const s = { leases: [], queue: [] };
      const hist = [];
      let t = T, id = 0;
      for (let step = 0; step < 60; step++) {
        t += Math.floor(r() * 90e3);
        const runs = s.leases.filter(l => l.kind === 'run');
        const op = pick(['start', 'start', 'start', 'nested', 'end', 'end', 'disk', 'disk', 'memory', 'urgent', 'owner', 'unowner']);
        let what = op;
        if (op === 'start' || (op === 'nested' && !runs.length)) {
          const res = pick(['w', 'w', 'n', 'd']);
          if (s.leases.filter(l => l.res.includes(res)).length < cfg.resources[res].slots)
            s.leases.push(run({ id: ++id, res: [res], prio: pick(['idle', 'low', 'normal', 'normal', 'high']), start: t, ...(r() < 0.5 && { est: Math.floor(r() * 20 * MIN) }) }));
        } else if (op === 'nested') {
          s.leases.push(run({ id: ++id, res: ['n'], outer: pick(runs).id, prio: pick(['low', 'normal']), start: t }));
        } else if (op === 'end' && runs.length) {
          const l = pick(runs);
          what = `end #${l.id}`;
          hist.push({ key: l.key, dur: t - l.start });
          s.leases = s.leases.filter(x => x !== l && x.outer !== l.id);
        } else if (op === 'disk') {
          for (let i = 0; i < 1 + Math.floor(r() * 3); i++) diskPause(s, cfg, t, DISK, hist);
        } else if (op === 'memory') {
          pressurePause(s, cfg, t, hist);
        } else if (op === 'urgent') {
          const me = { id: ++id, res: ['w'], who: 'u', mem: G, cpu: 1, disk: 0, pid: process.pid, enq: t, key: 'w|urgent', kind: 'run', prio: 'urgent', purpose: 'x' };
          s.queue.push(me);
          const v = preempt(s, me, cfg, hist, t);
          s.queue = s.queue.filter(q => q !== me);
          if (v?.ok) s.leases.push(run({ ...me, start: t }));
        } else if (op === 'owner' && runs.length) {
          ownerPause(pick(runs), true, t);
        } else if (op === 'unowner') {
          const l = runs.find(ownerStopped);
          if (l) ownerPause(l, false, t);
        }
        settle(s, t, () => hist);
        flush(false);
        // Whenever a run exists that the person didn't pause (itself or a run it's nested in), one is going.
        const byOwner = new Set(s.leases.filter(ownerStopped).map(l => l.id));
        for (let grew = true; grew;) {
          grew = false;
          for (const l of s.leases) if (l.outer != null && byOwner.has(l.outer) && !byOwner.has(l.id)) { byOwner.add(l.id); grew = true; }
        }
        if (s.leases.some(l => l.kind === 'run' && !byOwner.has(l.id))) assert.ok(going(s).length > 0,
          `seed ${seed} step ${step} after ${what}: every job is paused (${s.leases.map(l => `#${l.id}${l.pausedAt ? ' paused' : ''}${l.outer ? ` in #${l.outer}` : ''}`).join(', ')})`);
      }
    }
  } finally { process.env.DIBS_FAKE_MACHINE = was; }
});
