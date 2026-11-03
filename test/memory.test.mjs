// Memory waits: what a job waiting for memory is told, how the memory jobs
// take is counted, small short jobs past a full budget, jobs that used far
// more than they asked, and runs that sit idle while others wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, HOME, tmp, sync, bg, until, board, flat, windowsGap } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict, memUsed, cpuUsed } from '../src/schedule.mjs';
import { plainBoard, STUCK_AFTER } from '../src/plain.mjs';
import { boardOf, boardLines, limitsLine } from '../src/board.mjs';
import { markIdle, stuckLeases } from '../src/acquire.mjs';
import { treeOf, overAsk } from '../src/measure.mjs';

const T = Date.now();
const MIN = 6e4;
// The budget always applies (roomyMemFree over 100), 8G of it, on a 16 GB machine.
const cfg = { ...DEFAULT_CONFIG, budget: '8G', roomyMemFree: 101, resources: { ...DEFAULT_CONFIG.resources } };
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['test'], who: `l${n}`, mem: 2 * G, cpu: 1, start: T - 2 * MIN, pid: 1, key: 'k', ...o });
const waiter = o => ({ id: ++n, res: ['test'], who: 'me', mem: 2 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'test|npm test', kind: 'run', ...o });
// Plenty of real memory, no pressure, swap still.
const CALM = { memTotal: 16 * G, memFree: 60, swapGrowth: 0, diskDrain: 0, swapUsed: 0 };
function onMachine(m, fn) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...CALM, ...m });
  try { return fn(); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}
const judge = (s, me, hist = [], m = {}, c = cfg) => onMachine(m, () => verdict(s, me, c, hist, T));
// A short test run that history knows: 1 second.
const quick = [{ key: 'test|npm test', dur: 1000, who: 'x', at: T - MIN }];

test('a run inside its own hold is counted once: the hold reserved its memory', () => {
  const hold = { id: ++n, kind: 'hold', res: ['sim'], who: 'h', pid: 50, mem: 3 * G, cpu: 1, start: T - MIN, expires: T + 20 * MIN };
  const inside = lease({ res: ['sim'], spid: 50, covered: ['sim'], mem: 3 * G, use: { mem: 2.5 * G, cpu: 1 } });
  const other = lease({ mem: 2 * G });
  const s = { leases: [hold, inside, other], queue: [] };
  assert.equal(memUsed(s), 5 * G, 'the hold at 3G and the other job at 2G, not 8G');
  // 5G out of 8G: a 3G job fits. Counted twice, it waited for memory.
  assert.equal(judge(s, waiter({ mem: 3 * G }), []).ok, true);
  // Using more than the hold reserved, the runs inside count at what they use.
  inside.use.mem = 4 * G;
  assert.equal(memUsed(s), 6 * G);
});

test('a hold\'s simulator counts in the first run under it, not in every one', () => {
  const s = { leases: [{ id: 1, kind: 'hold', res: ['sim-own'], pid: 50 }, { id: 2, kind: 'run', res: ['sim-own'], spid: 50, covered: ['sim-own'], pgid: 100 },
    { id: 3, kind: 'run', res: ['sim-own'], spid: 50, covered: ['sim-own'], pgid: 200 }], pool: [{ udid: 'U1', lease: 1, res: 'sim-own' }] };
  const procs = [{ pid: 100, pgid: 100, ppid: 1, args: 'a' }, { pid: 200, pgid: 200, ppid: 1, args: 'b' },
    { pid: 300, pgid: 300, ppid: 1, args: '/x/launchd_sim /Devices/U1/data' }, { pid: 301, pgid: 300, ppid: 300, args: 'SpringBoard' }];
  assert.deepEqual([...treeOf(s.leases[1], s, procs)].sort(), [100, 300, 301]);
  assert.deepEqual([...treeOf(s.leases[2], s, procs)], [200], 'the second run: its own processes only');
});

test('a memory wait says what it needs, what is left, what is really free, and who holds the most', () => {
  const big = lease({ who: 'alex-b8', agent: 'alex-b8', purpose: 'vitest', mem: 2 * G, use: { mem: 5.7 * G, cpu: 0 }, idleSince: T - 40 * MIN });
  const mid = lease({ who: 'alex-d3', agent: 'alex-d3', mem: 4 * G });
  const me = waiter({ mem: 3 * G });
  const s = { leases: [big, mid], queue: [me] };
  const p = onMachine({ memFree: 30 }, () => plainBoard(s, cfg, [], T));
  const w = p.waiting.get(me.id);
  assert.equal(w.startsText, 'unknown');
  assert.match(w.waitingFor, /^room in memory: it needs 3\.0 GB; 9\.7 GB of the 8\.0 GB dibs shares out is taken, none left, and the machine has 4\.8 GB free or reclaimable\./);
  assert.match(w.waitingFor, new RegExp(`Taking the most: alex-b8 #${big.id} \\("vitest"\\): using 5\\.7 GB, asked 2\\.0 GB, idle for 40 min; alex-d3 #${mid.id}: not measured yet, asked 4\\.0 GB$`));
  assert.equal(w.advice, 'Keep waiting: raising the priority is not the fix');
});

test('a paused job takes no cores from the CPU budget', () => {
  const s = { leases: [lease({ cpu: 4, pausedAt: T - MIN, pauses: [{ watcher: 1 }] }), lease({ cpu: 2 })], queue: [] };
  assert.equal(cpuUsed(s), 2);
});

test('a run is idle when every process group it spans is, and stuck after 20 minutes while someone waits', () => {
  const l = lease({ pgid: 10, groups: [11] });
  const s = { leases: [l], queue: [] };
  markIdle(s, [{ pgid: 10, cpu: 0 }, { pgid: 11, cpu: 80 }]);
  assert.equal(l.idleSince, undefined, 'a worker in its own group is busy: not idle');
  markIdle(s, [{ pgid: 10, cpu: 0 }, { pgid: 11, cpu: 0 }]);
  assert.ok(l.idleSince);
  l.idleSince = T - 40 * MIN;
  assert.deepEqual(stuckLeases(s, T), [], 'nobody waiting: not a problem');
  s.queue.push(waiter());
  assert.deepEqual(stuckLeases(s, T).map(x => x.id), [l.id]);
  assert.equal(STUCK_AFTER, 20 * MIN);
  const p = onMachine({}, () => plainBoard(s, cfg, [], T));
  assert.match(p.held.get(l.id).stuck, new RegExp(`^idle for 40 min, may be stuck \\(#${l.id}\\)$`));
  const b = onMachine({}, () => boardOf(s, cfg, [], T));
  assert.match(boardLines(b, T).join('\n'), /\[idle 40m(00s)?, may be stuck\]/);
  l.idleSince = T - 10 * MIN;
  assert.deepEqual(stuckLeases(s, T), [], '10 minutes quiet is a job waiting on something');
});

test('the board has one line of limits and headroom: memory, disk against its floor, swap', () => {
  const s = { leases: [lease({ mem: 6 * G })], queue: [] };
  const line = limitsLine(s, cfg, { ...MACHINE, ...CALM, memFree: 50, diskFree: 40 * G, swapUsed: 6.2 * G, swapGrowth: 1.1 * G, swapRecent: 1 * G });
  assert.equal(line, 'memory 6.0 GB of 8.0 GB taken (2.0 GB left), 8.0 GB free or reclaimable on the machine; disk 40 GB free (floor 5.0 GB); swap 6.2 GB, growing (1.1 GB in 5 min), over maxSwap 4.0 GB');
});

test('the Limits line shows the same free memory the real-memory wait uses', () => {
  // 2026-10-23: the board's wait read "3.5 GB free or reclaimable" under a Limits line saying 7.0 GB free.
  const s = { leases: [], queue: [] };
  const line = limitsLine(s, cfg, { ...MACHINE, ...CALM, memFree: 50, memAvail: 3.5 * G, diskFree: 40 * G, swapUsed: 1 * G });
  assert.match(line, /, 3\.5 GB free or reclaimable on the machine;/);
});

test('a job that used far more memory than it asked: what to pass next time', () => {
  assert.deepEqual(overAsk(lease({ mem: 3 * G, peak: { mem: 5.7 * G } })), { used: 5.7 * G, asked: 3 * G, planned: 3 * G, suggest: '6G' });
  assert.equal(overAsk(lease({ mem: 3 * G, peak: { mem: 4 * G } })), null, 'under 1.5x');
  assert.equal(overAsk(lease({ mem: 0.5 * G, peak: { mem: 1.2 * G } })), null, 'over 1.5x but under a gigabyte more');
  assert.equal(overAsk(lease({ mem: 11 * G, usual: 14 * G, peak: { mem: 20 * G } })), null, 'already planned at the whole budget');
  assert.equal(overAsk(lease({ mem: 4 * G, asked: 2 * G, peak: { mem: 7 * G } })).asked, 2 * G, 'asked keeps what it asked, before dibs raised it');
});

test('the real CLI: a run that uses far more than it asked hears it, and the event log has it', { skip: windowsGap("dibs doesn't measure what jobs use there (src/measure.mjs sample)") }, async t => {
  const h = tmp(t), cwd = tmp(t, 'job');
  const foot = path.join(h, 'footprint.json');
  fs.writeFileSync(foot, '{}');
  const opts = { env: { DIBS_FAKE_FOOTPRINT: foot, DIBS_SAMPLE_MS: '300' } };
  const job = bg(t, h, ['run', 'test', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { ...opts, agent: 'a', cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 5.7 * G }));
  await until(() => /this job used 5\.7 GB of memory but asked for 2\.0 GB\. Next time pass --mem 6G/.test(flat(job.err)));
  assert.equal(board(h, opts).held[0].overAsk.suggest, '6G');
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await job.done, 0);
  assert.equal(flat(job.err).match(/this job used/g).length, 1, 'said once');
  const events = fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const e = events.find(x => x.kind === 'overask');
  assert.equal(e.who, 'a');
  assert.equal(e.used, 5.7 * G);
  assert.equal(e.suggest, '6G');
});

test('free slots on a machine with its memory handed out: who and the board say nothing new starts', async t => {
  const h = tmp(t), cwd = tmp(t, 'job');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ budget: '4G', cores: 10, roomyMemFree: 101 }));
  const first = bg(t, h, ['run', 'heavy', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { agent: 'a', cwd });
  await until(() => board(h).held.length === 1);
  assert.match(flat(sync(h, ['who', 'test']).out), /free \(3 of 3 free\), but nothing new starts until memory frees up \(4\.0 GB of the 4\.0 GB dibs shares out is taken/);
  assert.match(flat(sync(h, []).out), /Free +Simulator, .*, but nothing new starts until memory frees up/);
  assert.match(flat(sync(h, []).out), /Limits +memory 4\.0 GB of 4\.0 GB taken \(none left\)/);
  const b = board(h);
  assert.match(b.limits, /^memory 4\.0 GB of 4\.0 GB taken \(none left\)/);
  assert.match(b.hold, /^memory frees up/);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await first.done, 0);
});
