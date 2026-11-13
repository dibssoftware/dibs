// Measuring what jobs really use, with a fake footprint reader so nothing
// depends on this Mac's memory: the CLI end to end, and the pure pieces
// (whose processes count, learned sizes, who pauses first) without processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { G, tmp, sync, bg, until, board, flat, posixOnly } from './helpers.mjs';
import { treeOf, usage, learned, sized, sample, SAMPLE_EVERY } from '../src/measure.mjs';
import { pressurePause, flush } from '../src/preempt.mjs';
import { scoped } from '../src/platform.mjs';
import { hardware } from '../src/config.mjs';
import { pstart } from '../src/proc.mjs';
import { withState } from '../src/state.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { commandKey, markIdle } from '../src/acquire.mjs';
import { typical } from '../src/schedule.mjs';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

// A home whose resource t asks for 0.1G, and a fake footprint file the test fills in.
function setup(t) {
  const h = tmp(t, 'measure');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources: { t: { slots: 1, mem: '0.1G', cpu: 1, pausable: true } } }));
  const foot = path.join(h, 'footprint.json');
  fs.writeFileSync(foot, '{}');
  // Sampling every 300ms instead of 10s, so a test sees a measurement within a tracker tick or two.
  return { h, foot, opts: { env: { DIBS_FAKE_FOOTPRINT: foot, DIBS_SAMPLE_MS: '300' } } };
}
const JOB = ['sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'];

test('a job using more than it asked for is flagged on the board, and its next run is planned at what it used', async t => {
  const { h, foot, opts } = setup(t);
  const cwd = tmp(t, 'job');
  const job = bg(t, h, ['run', 't', '--', ...JOB], { ...opts, cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 6 * G }));
  await until(() => board(h, opts).held[0].use?.mem === 6 * G);
  assert.match(sync(h, ['--detail'], opts).out, /t +tester .*\[over: using 6\.0G of 0\.1G\]/);

  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await job.done, 0);
  const last = fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.equal(last.mem, 6 * G);
  // How far into the run it reached that, so a later run past it is known to be done growing (schedule.mjs pastPeak).
  assert.ok(last.peakIn > 0 && last.peakIn <= last.dur, JSON.stringify(last));

  const when = sync(h, ['when', 't', '--', ...JOB], opts);
  assert.match(flat(when.out), /used up to 6\.0 GB of memory \(it asks for 0\.1 GB\) in recent runs, so dibs plans for that/);
  assert.equal(JSON.parse(sync(h, ['when', 't', '--json', '--', ...JOB], opts).out).mem, 6 * G);

  fs.rmSync(path.join(cwd, 'stop'));
  const again = bg(t, h, ['run', 't', '--', ...JOB], { ...opts, cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  const l = board(h, opts).held[0];
  assert.equal(l.mem, 6 * G);
  assert.equal(l.asked, 0.1 * G);
  assert.match(sync(h, ['--detail'], opts).out, /\[uses ~6\.0G \(asked 0\.1G\)\]/);
  assert.match(sync(h, ['--detail'], opts).out, /handed out: memory 6\.0G/);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await again.done, 0);
  // dibs learns it silently: the run itself says nothing about it (it came on every merge, 2026-11-03), the history has it.
  assert.doesNotMatch(flat(again.err), /used up to|pass --mem/);
  assert.ok(fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').includes('"kind":"sized"'));
});

test('a run that fails, or whose dibs is killed, still teaches its size: the next run is planned at it, over an explicit --mem', async t => {
  const { h, foot, opts } = setup(t);
  const cwd = tmp(t, 'job');
  const FAIL = ['sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done; exit 3'];
  const job = bg(t, h, ['run', 't', '--', ...FAIL], { ...opts, cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 6 * G }));
  await until(() => board(h, opts).held[0].use?.mem === 6 * G);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await job.done, 3);
  const planned = () => JSON.parse(sync(h, ['when', 't', '--json', '--mem', '1G', '--', ...FAIL], opts).out).mem;
  assert.equal(planned(), 6 * G, 'learned from a failed run, and it wins over a smaller --mem');
  const hist = () => fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(hist().at(-1).failed, true);
  assert.equal(typical(hist(), hist().at(-1).key), null, "a failed run's time isn't a run time");

  // dibs itself killed: the next state read reaps the lease and keeps what it measured.
  fs.rmSync(path.join(cwd, 'stop'));
  const KILLED = ['sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done; exit 0'];
  bg(t, h, ['run', 't', '--', ...KILLED], { ...opts, cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 7 * G }));
  await until(() => board(h, opts).held[0].use?.mem === 7 * G);
  process.kill(board(h, opts).held[0].pid, 'SIGKILL');
  await until(() => !board(h, opts).held.length);
  assert.equal(hist().at(-1).mem, 7 * G);
  assert.equal(JSON.parse(sync(h, ['when', 't', '--json', '--', ...KILLED], opts).out).mem, 7 * G);
});

test('a command never measured is planned at what its family used: the same resources and program', () => {
  // 2026-10-15: every Playwright spec ran under its own key, used 5.5 GB of the 3 GB asked, and none ever learned it.
  const hist = [{ key: 'playwright|npx playwright / test verify.spec.ts', dur: 35e3, fit: true, mem: 5.5 * G, cpu: 2, failed: true },
    { key: 'test|npx playwright / test other.spec.ts', dur: 35e3, fit: true, mem: 9 * G, cpu: 2 }];
  assert.equal(learned(hist, 'playwright|npx playwright / test save-pdf.spec.ts').mem, 5.5 * G);
  assert.equal(learned(hist, 'playwright|npx vitest / run'), null, 'another program learns nothing from it');
  // A wrapper isn't a family: npm run build and npm run lint, or wrangler d1 and wrangler deploy, are different programs.
  const npm = [{ key: 'test|npm run / build', dur: 60e3, fit: true, mem: 5 * G, cpu: 4 }, { key: 'deploy|npx wrangler / d1 migrations', dur: 9e3, fit: true, mem: 4 * G, cpu: 1 }];
  assert.equal(learned(npm, 'test|npm run / lint'), null);
  assert.equal(learned(npm, 'deploy|npx wrangler / deploy 6189fd0'), null);
  assert.equal(learned(npm, 'test|npm run / build --watch=false').mem, 5 * G, 'the same script with other words after it');
  assert.equal(learned([...hist, { key: 'playwright|npx playwright / test save-pdf.spec.ts', dur: 9e3, fit: true, mem: 2 * G, cpu: 1 }],
    'playwright|npx playwright / test save-pdf.spec.ts').mem, 2 * G, 'its own runs, once it has some');
});

test('a command that has used more than the whole budget is planned at the budget, and the board says so', async t => {
  const { h, foot, opts } = setup(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ budget: '11G', roomyMemFree: 101, resources: { t: { slots: 2, mem: '0.1G', cpu: 1 } } }));
  fs.writeFileSync(path.join(h, 'history.jsonl'), JSON.stringify({ key: `t|${commandKey(JOB)}`, dur: 60e3, who: 'past', at: Date.now() - 6e4, fit: true, mem: 14 * G, cpu: 8 }) + '\n');
  const cwd = tmp(t, 'job');
  assert.match(sync(h, ['when', 't', '--', ...JOB], opts).out.replace(/\s+/g, ' '),
    /usually uses up to 14 GB of memory and 6 cores \(it asks for 1\), more than the 11 GB dibs shares out at once, so dibs plans it at all 11 GB: it starts when no other job is using that memory\./);
  const job = bg(t, h, ['run', 't', '--', ...JOB], { ...opts, cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  assert.equal(board(h, opts).held[0].mem, 11 * G);
  // Using what it usually uses isn't over: it was planned below that on purpose.
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 14 * G }));
  await until(() => board(h, opts).held[0].use?.mem === 14 * G);
  assert.match(sync(h, ['--detail'], opts).out, /\[usually uses ~14G and 6 cores \(asked 1\); planned at the 11G budget\]/);
  // A second run of it waits for the budget to empty, and says why it's planned that way.
  const next = bg(t, h, ['run', 't', '--', ...JOB], { ...opts, cwd });
  await until(() => /blocked by memory.*usually uses ~14G; planned at the 11G budget/.test(sync(h, ['--detail'], opts).out.split('QUEUE')[1] || ''));
  // The plain board says the same in words.
  assert.match(sync(h, [], opts).out.replace(/\s+/g, ' '), /is waiting for all the memory dibs shares out to be free \(it usually uses 14 GB, more than the 11 GB there is\): it needs 11 GB; 14 GB of the 11 GB dibs shares out is taken, none left/);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await job.done, 0);
  assert.equal(await next.done, 0);
});

test('a planned size is capped at the budget only when what it learned is over the budget', () => {
  const h = mems => mems.map(mem => ({ key: 'k', dur: 1000, fit: true, mem, cpu: 1 }));
  const cfg = { ...DEFAULT_CONFIG, cores: 6, budget: '11G' };
  assert.deepEqual(sized({ mem: 4 * G, cpu: 3, disk: 0 }, h([14 * G]), 'k', cfg), { mem: 11 * G, cpu: 3, disk: 0, asked: 4 * G, usual: 14 * G });
  assert.deepEqual(sized({ mem: 4 * G, cpu: 3, disk: 0 }, h([9 * G]), 'k', cfg), { mem: 9 * G, cpu: 3, disk: 0, asked: 4 * G });
  assert.deepEqual(sized({ mem: 12 * G, cpu: 3, disk: 0 }, h([14 * G]), 'k', cfg), { mem: 14 * G, cpu: 3, disk: 0, asked: 12 * G }, 'asking for more than the budget is the asker\'s call');
});

test('a job within what it asked for is not flagged', async t => {
  const { h, foot, opts } = setup(t);
  const cwd = tmp(t, 'job');
  const job = bg(t, h, ['run', 't', '--', ...JOB], { ...opts, cwd });
  await until(() => board(h, opts).held[0]?.pgid);
  fs.writeFileSync(foot, JSON.stringify({ [board(h, opts).held[0].pgid]: 0.05 * G }));
  await until(() => board(h, opts).held[0].use?.mem === 0.05 * G);
  assert.doesNotMatch(sync(h, ['--detail'], opts).out, /over:|uses ~/);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await job.done, 0);
});

test('one process measures every lease once per interval, however many runs are ticking', t => {
  process.env.DIBS_FAKE_FOOTPRINT = path.join(tmp(t, 'foot'), 'none.json');
  const lease = { id: 1, kind: 'run', res: ['t'], mem: G, cpu: 1, pid: process.pid, pstart: pstart(process.pid), pgid: process.pid, start: Date.now() };
  withState(s => { s.leases.push(lease); });
  try {
    const T = Math.ceil(Date.now() / SAMPLE_EVERY) * SAMPLE_EVERY;
    assert.equal(sample(T), true);
    assert.equal(sample(T + 1), false, 'the same interval: someone already measured');
    assert.equal(sample(T + SAMPLE_EVERY), true);
    assert.ok(withState(s => s.leases[0].use), 'the lease got a measurement');
  } finally { withState(s => { s.leases = []; }); delete process.env.DIBS_FAKE_FOOTPRINT; }
});

// A process table: the job's group 100, a stray group, and two simulators.
const UDID = 'AAAA-1111', OTHER = 'BBBB-2222';
const PROCS = [
  { pid: 100, ppid: 1, pgid: 100, cpu: 50, rss: 1 * G, args: 'sh -c test' },
  { pid: 101, ppid: 100, pgid: 100, cpu: 100, rss: 2 * G, args: 'node test' },
  { pid: 200, ppid: 101, pgid: 200, cpu: 10, rss: 1 * G, args: 'chrome' },
  { pid: 300, ppid: 1, pgid: 300, cpu: 5, rss: 1 * G, args: `launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist` },
  { pid: 301, ppid: 300, pgid: 301, cpu: 20, rss: 3 * G, args: 'MyApp' },
  { pid: 400, ppid: 1, pgid: 400, cpu: 99, rss: 5 * G, args: `launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/${OTHER}/data/var/run/launchd_bootstrap.plist` },
  { pid: 500, ppid: 1, pgid: 500, cpu: 99, rss: 9 * G, args: 'someone else' },
];

test("each run learns its share of the disk's fall, by the disk it declares, with swap's growth left out", t => {
  process.env.DIBS_FAKE_FOOTPRINT = path.join(tmp(t, 'foot'), 'none.json');
  const was = process.env.DIBS_FAKE_MACHINE;
  const base = { kind: 'run', mem: G, cpu: 1, pid: process.pid, pstart: pstart(process.pid), pgid: process.pid, start: Date.now() };
  withState(s => { delete s.diskSample; s.leases.push({ ...base, id: 1, res: ['sim-own'], disk: 6 * G }, { ...base, id: 2, res: ['deploy'] }); });
  try {
    // Slots far from the ones the test above claimed: when the clock crossed
    // into the next slot between the two, its claim on T + SAMPLE_EVERY was
    // this test's T, and sample() said someone had already measured.
    const T = (Math.ceil(Date.now() / SAMPLE_EVERY) + 1000) * SAMPLE_EVERY;
    // 9 GB free, then 6.5 with swap 0.5 GB bigger in use and a 1 GB swap file added, then back up to 8.
    // 2026-10-26: counting only swap in use credited a paused loader with 18 GB of swap files.
    for (const [i, [free, swap, files]] of [[9, 1, 2], [6.5, 1.5, 3], [8, 1.5, 3]].entries()) {
      process.env.DIBS_FAKE_MACHINE = JSON.stringify({ diskFree: free * G, swapUsed: swap * G, swapFiles: files * G });
      assert.equal(sample(T + i * SAMPLE_EVERY), true);
    }
    const [sim, deploy] = withState(s => s.leases.map(l => l.peak.ate));
    // 1.5 GB fell that wasn't swap files; weights 6 GB and 0.25 GB.
    assert.ok(Math.abs(sim - 1.5 * G * 6 / 6.25) < 1e6, `simulator ${sim}`);
    assert.ok(Math.abs(deploy - 1.5 * G * 0.25 / 6.25) < 1e6, `deploy ${deploy}`);
  } finally {
    withState(s => { s.leases = []; delete s.diskSample; }); delete process.env.DIBS_FAKE_FOOTPRINT;
    if (was == null) delete process.env.DIBS_FAKE_MACHINE; else process.env.DIBS_FAKE_MACHINE = was;
  }
});

test("a lease's tree is its process groups, plus its own simulator's processes, which run outside it", () => {
  const l = { id: 7, pgid: 100, groups: [200] };
  const pool = [{ name: 'dibs-pool-1', udid: UDID, res: 'sim-own', lease: 7 }, { name: 'dibs-pool-2', udid: OTHER, res: 'sim-own', lease: 8 }];
  assert.deepEqual([...treeOf(l, { leases: [], pool }, PROCS)].sort(), [100, 101, 200, 300, 301]);
  assert.deepEqual([...treeOf(l, { leases: [], pool: [] }, PROCS)].sort(), [100, 101, 200]);
  // A run under its session's hold uses the hold's simulator.
  const run = { id: 9, pgid: 100, spid: 42, covered: ['sim-own'] };
  const hold = { id: 3, kind: 'hold', pid: 42, res: ['sim-own'] };
  const held = [{ name: 'dibs-pool-1', udid: UDID, res: 'sim-own', lease: 3 }];
  assert.ok(treeOf(run, { leases: [hold], pool: held }, PROCS).has(301));
  assert.ok(!treeOf({ ...run, covered: undefined }, { leases: [hold], pool: held }, PROCS).has(301));
});

test("a job holding the shared simulator counts that simulator's processes, but not a pool simulator's", () => {
  // The TestFlight ship of 2026-11-02: its work ran in the booted simulator, so it measured 0.1 GB and no CPU.
  const ship = { id: 7, kind: 'run', pgid: 100, res: ['sim', 'deploy'] };
  const pool = [{ name: 'dibs-pool-2', udid: OTHER, res: 'sim-own', lease: 8 }];
  const tree = treeOf(ship, { leases: [ship], pool }, PROCS);
  assert.ok(tree.has(300) && tree.has(301), 'the booted simulator and the app in it');
  assert.ok(!tree.has(400), "a pool simulator is its own job's");
  assert.ok(!treeOf({ ...ship, res: ['deploy'] }, { leases: [], pool }, PROCS).has(301), 'a job without sim gets none');
  // Under a session's hold of sim, the first run that covers it.
  const run = { id: 9, kind: 'run', pgid: 100, spid: 42, covered: ['sim'] };
  assert.ok(treeOf(run, { leases: [{ id: 3, kind: 'hold', pid: 42, res: ['sim'] }, run], pool }, PROCS).has(301));
});

test("a run whose work is in the simulator isn't idle while the simulator works", () => {
  const ship = { id: 7, kind: 'run', pgid: 100, res: ['sim'], start: 0 };
  const quiet = PROCS.map(p => (p.pgid === 100 ? { ...p, cpu: 0 } : p));
  const s = { leases: [ship], queue: [], pool: [] };
  markIdle(s, quiet);
  assert.equal(ship.idleSince, undefined, 'the simulator used CPU');
  markIdle(s, quiet.map(p => ({ ...p, cpu: 0 })));
  assert.ok(ship.idleSince, 'nothing anywhere used CPU');
});

test("a dibs run nested in another is measured once, as itself, not again in the run around it", () => {
  // Group 200 is the inner run's job, started from inside the outer one's tree.
  const outer = { id: 7, kind: 'run', pgid: 100, groups: [200] };
  const inner = { id: 8, kind: 'run', pgid: 200, outer: 7 };
  const s = { leases: [outer, inner], pool: [] };
  assert.deepEqual([...treeOf(outer, s, PROCS)].sort(), [100, 101]);
  assert.deepEqual([...treeOf(inner, s, PROCS)].sort(), [200]);
});

test('usage sums footprint over the tree, and RSS for a process the footprint reading missed', () => {
  const pids = new Set([100, 101, 200]);
  assert.deepEqual(usage(pids, PROCS, new Map([[100, 0.5 * G], [101, 1.5 * G]])), { mem: 3 * G, cpu: 1.6 });
  assert.deepEqual(usage(pids, PROCS, null), { mem: 4 * G, cpu: 1.6 }, 'no footprints: RSS');
});

test('the learned size comes from the last five measured runs, never more than the machine', () => {
  const h = mems => mems.map(mem => ({ key: 'k', dur: 1000, fit: true, mem, cpu: 1 }));
  assert.equal(learned(h([9 * G, G, G, G, G, G]), 'k').mem, G, 'a heavy run six back is forgotten');
  assert.equal(learned(h([9 * G, 9 * G, 9 * G, G, G]), 'k').mem, 9 * G);
  assert.equal(learned(h([1e15]), 'k').mem, hardware().mem, 'the machine is 16 GB in tests (helpers.mjs MACHINE), whatever the host');
  assert.equal(learned([{ key: 'k', dur: 1000 }], 'k'), null, 'runs from before measuring teach nothing');
  assert.equal(learned([{ key: 'k', dur: 1000, fit: true, mem: 9 * G, cpu: 40 }], 'k', 6).cpu, 6, 'cores capped at what dibs hands out');
  const cfg = { ...DEFAULT_CONFIG, cores: 6 };
  assert.deepEqual(sized({ mem: 2 * G, cpu: 3, disk: 0 }, h([5 * G]), 'k', cfg), { mem: 5 * G, cpu: 3, disk: 0, asked: 2 * G });
  assert.deepEqual(sized({ mem: 8 * G, cpu: 3, disk: 0 }, h([5 * G]), 'k', cfg), { mem: 8 * G, cpu: 3, disk: 0 }, 'asking for more is kept');
});

// A lease that names a process that isn't its own (pgstart doesn't match), so nothing is ever signalled.
const fakeRun = o => ({ kind: 'run', pgid: 999999, pgstart: 'never', res: ['test'], mem: G, cpu: 1, start: 0, ...o });

test('under memory pressure the job furthest over what it asked for is paused first', { skip: posixOnly("pausing needs SIGSTOP, which Windows doesn't have") }, () => {
  const s = { leases: [
    fakeRun({ id: 1, prio: 'idle', mem: 4 * G, use: { mem: 4 * G } }),
    fakeRun({ id: 2, prio: 'low', mem: 1 * G, use: { mem: 3 * G } }),
    fakeRun({ id: 3, prio: 'low', mem: 1 * G, use: { mem: 5 * G } }),
    fakeRun({ id: 4, prio: 'normal' }),   // keeps running: the watcher never pauses the last job
  ], queue: [] };
  assert.equal(pressurePause(s, DEFAULT_CONFIG).id, 3);
  assert.equal(pressurePause(s, DEFAULT_CONFIG).id, 2);
  assert.equal(pressurePause(s, DEFAULT_CONFIG).id, 1, 'then the usual order');
  flush(false);
});

test('Linux with enforce: the job runs in a systemd scope throttled at its memory and cores; elsewhere it runs as is', () => {
  const argv = ['npm', 'test'];
  assert.deepEqual(scoped(argv, { mem: 4 * G, cpu: 3 }, { os: 'linux', works: () => true }),
    ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryHigh=${4 * G}`, '-p', 'CPUQuota=300%', '--', 'npm', 'test']);
  assert.deepEqual(scoped(argv, { mem: G, cpu: 1 }, { os: 'linux', works: () => false }), argv, 'no systemd user session');
  assert.deepEqual(scoped(argv, { mem: G, cpu: 1 }, { os: 'macos', works: () => true }), argv);
});

test('with enforce on, a job still runs where scopes are unavailable', { skip: process.platform === 'linux' && 'a Linux machine may have systemd scopes; this is the case of none' }, async t => {
  const h = tmp(t, 'enforce');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ enforce: true }));
  const r = sync(h, ['run', 'test', '--', 'sh', '-c', 'echo ran']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'ran');
});

test('dibs setup scratch prints the admin commands and creates nothing', { skip: !MAC && 'the scratch volume is APFS, macOS only' }, t => {
  const vol = path.join(tmp(t, 'scratch'), 'DibsScratch');
  const r = sync(tmp(t), ['setup', 'scratch', '--size', '30G'], { env: { DIBS_SCRATCH: vol } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sudo diskutil apfs addVolume disk\d+ APFS DibsScratch -quota 30g/);
  assert.match(r.out, /-derivedDataPath .*DerivedData/);
  assert.ok(!fs.existsSync(vol));
});

test('dibs setup scratch --check: missing or a plain folder exits 1; a volume says how full it is', t => {
  const dir = tmp(t, 'scratch');
  const h = tmp(t);
  const missing = sync(h, ['setup', 'scratch', '--check'], { env: { DIBS_SCRATCH: path.join(dir, 'nope') } });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no scratch volume at .*nope. Set one up: dibs setup scratch/);
  const plain = sync(h, ['setup', 'scratch', '--check'], { env: { DIBS_SCRATCH: dir } });
  assert.equal(plain.code, 1);
  assert.match(plain.out, /is a plain folder, not its own volume/);
  if (!MAC) return;
  const vol = sync(h, ['setup', 'scratch', '--check'], { env: { DIBS_SCRATCH: '/System/Volumes/Preboot' } });
  assert.equal(vol.code, 0, vol.err);
  assert.match(vol.out, /scratch volume \/System\/Volumes\/Preboot: [\d.]+G used of [\d.]+G, [\d.]+G free/);
});

// 2026-10-20: Playwright runs read 11 to 13 GB while the 16 GB Mac had more than half its memory free,
// and every later browser run was planned at the whole budget.
test("jobs can't measure more than the machine has in use, and only runs measured that way plan memory", async () => {
  const { fit } = await import('../src/measure.mjs');
  const got = new Map([[1, { mem: 11 * G, cpu: 1 }], [2, { mem: 3 * G, cpu: 1 }]]);
  fit(got, { memFree: 54, memTotal: 16 * G });
  const inUse = 16 * G * 0.46;
  assert.ok(Math.abs(got.get(1).mem + got.get(2).mem - inUse) < 2, 'scaled to what was in use');
  assert.equal(got.get(1).mem, Math.round(11 * G * inUse / (14 * G)));
  const under = new Map([[1, { mem: 2 * G, cpu: 1 }]]);
  fit(under, { memFree: 54, memTotal: 16 * G });
  assert.equal(under.get(1).mem, 2 * G, 'under what is in use: as measured');
  const key = 'playwright|npx playwright test';
  const old = [12.6, 12.3, 12.4].map((m, i) => ({ key, dur: 1000, at: i, mem: m * G, cpu: 2 }));
  assert.equal(learned(old, key), null, 'measured before fit: no memory to plan from');
  assert.equal(learned([...old, { key, dur: 1000, at: 9, mem: 3 * G, cpu: 2, fit: true }], key).mem, 3 * G);
});

test('the learned size is the middle of the last five measured runs, not the biggest', () => {
  const runs = [6.3, 7.3, 15, 11.7, 7.3].map((m, i) => ({ key: 'playwright|npx playwright test', dur: 1000, at: i, fit: true, mem: m * G, cpu: 2 }));
  assert.equal(learned(runs, 'playwright|npx playwright test').mem, 7.3 * G);
});
