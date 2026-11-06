// The disk floor, from the agents' report of 2026-11-03 (bugs by their letter there):
// low disk is waited out, never refused at the start (A, H); free disk is read again
// at every poll up to the start (C); a job its runs show writes next to nothing, or one
// on a resource that writes little and says so with --disk, starts under minDisk (D, E).
// F, the one-second test held on memory, is in test/lightmem.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board, flat } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict, tinyDisk } from '../src/schedule.mjs';

const T = Date.now();
const M = 1024 ** 2;
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, budget: '11G', cores: 10, ...o, resources: { ...DEFAULT_CONFIG.resources, ...o.resources } });
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['test'], who: `l${n}`, mem: 1 * G, cpu: 1, start: T - 60e3, pid: 1, key: `test|other ${n}`, ...o });
const waiter = o => ({ id: ++n, res: ['test'], who: 'me', mem: 2 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'test|npm test', kind: 'run', ...o });
function judge(s, me, c, m = {}, hist = []) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memTotal: 16 * G, memFree: 67, cores: 10, swapGrowth: 0, diskDrain: 0, ...m });
  try { return verdict(s, me, c, hist, T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}
const ate = (key, ...mb) => mb.map((x, i) => ({ key, dur: 60e3, who: 'x', at: T - (mb.length - i) * 36e5, mem: 100 * M, ate: x * M }));

// Free disk a test can change under a waiting dibs (src/config.mjs DIBS_FAKE_DISK).
function disk(t, bytes) {
  const f = path.join(tmp(t, 'disk'), 'free');
  const set = b => fs.writeFileSync(f, String(b));
  set(bytes);
  return { set, env: { DIBS_FAKE_DISK: f, DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskTotal: 500 * G }) } };
}

// A. Shop build 142 (#17303) waited 10h22m, then its inner `dibs hold sim` saw 6.7 GB
// free against 8 GB and exited 74 at once; the retry (#17727) did the same after 1h23m.
test('A: a hold or a run short of disk waits in line and starts once there is room, with nothing else running', async t => {
  const h = tmp(t), d = disk(t, 1 * G);
  const hold = bg(t, h, ['hold', 'sim', '--wait', '-m', 'ship 142'], { env: d.env });
  const run = bg(t, h, ['run', 'heavy', '--wait', '--', 'echo', 'ran'], { env: d.env });
  await until(() => board(h, { env: d.env }).waiting.length === 2);
  // Long enough for the old refusal to have come back several times over.
  await new Promise(r => setTimeout(r, 3000));
  assert.equal(hold.exitCode, null, hold.err);
  assert.equal(run.exitCode, null, run.err);
  assert.doesNotMatch(hold.err + run.err, /exit 74/);
  assert.match(flat(hold.err), /Waiting for more free disk \(1\.0 GB free, it needs 8\.0 GB\)/);
  d.set(1e12);
  assert.equal(await hold.done, 0, hold.err);
  assert.equal(sync(h, ['release', 'sim'], { env: d.env }).code, 0);
  assert.equal(await run.done, 0, run.err);
  assert.equal(run.out, 'ran\n');
});

test('A: exit 74 only for a run bigger than the whole disk, or at the wait limit outside Claude Code', async t => {
  const h = tmp(t), d = disk(t, 1 * G);
  const never = sync(h, ['run', 'heavy', '--disk', '600G', '--', 'echo', 'ran'], { env: d.env });
  assert.equal(never.code, 74, never.err);
  assert.equal(never.out, '');
  assert.match(flat(never.err), /not enough disk, ever: it needs 600 GB free and the whole disk is 500 GB\. Your command did NOT run \(exit 74\)/);
  const limit = sync(h, ['run', 'heavy', '--max-wait', '2s', '--', 'echo', 'ran'], { env: d.env });
  assert.equal(limit.code, 74, limit.err);
  assert.equal(limit.out, '');
  assert.match(flat(limit.err), /Gives up at .* \(exit 74: your command won't have run\)/);
  assert.match(flat(limit.err), /gave up after \d+s in the queue: not enough free disk: 1\.0 GB free, it needs 10 GB\. Your command did NOT run \(exit 74\)\. .*or add --wait to wait until there's room: dibs run heavy --max-wait 2s -- echo ran/);
});

// C. #17727 got in line at 9 GB free, waited 1h23m while swap grew, and started at 6.8 GB.
test('C: free disk is read again right up to the start: a waiter let in with room waits once the disk falls under its need', async t => {
  const h = tmp(t), d = disk(t, 20 * G);
  const dir = tmp(t, 'gate'), go = path.join(dir, 'go');
  t.after(() => { try { fs.writeFileSync(go, ''); } catch {} });
  const first = bg(t, h, ['run', 'heavy', '--', 'sh', '-c', `while [ ! -f "${go}" ]; do sleep 0.1; done`], { env: d.env });
  await until(() => board(h, { env: d.env }).held.length === 1);
  const next = bg(t, h, ['run', 'heavy', '--wait', '--', 'echo', 'ran'], { env: d.env });
  await until(() => board(h, { env: d.env }).waiting.length === 1);
  d.set(6.8 * G);
  fs.writeFileSync(go, '');
  assert.equal(await first.done, 0, first.err);
  await new Promise(r => setTimeout(r, 3000));
  assert.equal(next.exitCode, null, 'its slot is free, but 6.8 GB is under the 10 GB heavy needs');
  assert.equal(board(h, { env: d.env }).waiting.length, 1);
  d.set(20 * G);
  assert.equal(await next.done, 0, next.err);
  assert.equal(next.out, 'ran\n');
});

test('C: in the scheduler, a waiter let in with room is held by disk the moment free disk falls under its need, whatever held it before', () => {
  const me = waiter({ res: ['heavy'], disk: 10 * G, key: 'heavy|make' });
  const full = lease({ mem: 10.5 * G });
  assert.equal(judge({ leases: [full], queue: [me] }, me, cfg(), { diskFree: 20 * G }).rule, 'memory', 'in at 20 GB, held on memory');
  assert.equal(judge({ leases: [full], queue: [me] }, me, cfg(), { diskFree: 6.8 * G }).rule, 'disk', 'the disk fell: disk holds it now');
  assert.equal(judge({ leases: [], queue: [me] }, me, cfg(), { diskFree: 6.8 * G }).rule, 'disk', 'memory free, still the disk');
  assert.equal(judge({ leases: [], queue: [me] }, me, cfg(), { diskFree: 12 * G }).ok, true);
});

// D. 82 passed --disk 200M on a test suite that writes nothing and still got exit 74 under 5 GB.
test('D: an honest small --disk on a resource that writes little is taken at its word; on a simulator or a build it is not, and runs that ate more overrule it', () => {
  const said = waiter({ disk: 200 * M, diskDeclared: true });
  const v = judge({ leases: [lease()], queue: [said] }, said, cfg(), { diskFree: 4.4 * G });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(judge({ leases: [lease()], queue: [said] }, said, cfg(), { diskFree: 1.1 * G }).rule, 'disk', 'its 200 MB and the 1 GB kept free');
  const sim = waiter({ res: ['sim'], disk: 200 * M, diskDeclared: true, key: 'sim|ui-test.sh' });
  assert.equal(judge({ leases: [lease()], queue: [sim] }, sim, cfg(), { diskFree: 4.4 * G }).rule, 'disk', 'a resource that declares disk keeps the floor');
  const lied = ate('test|npm test', 2000, 2100, 1900);
  assert.equal(judge({ leases: [lease()], queue: [said] }, said, cfg(), { diskFree: 4.4 * G }, lied).rule, 'disk', 'its runs ate 2 GB each');
});

// E. e4's post-deploy gate (known_answers.py, HTTP calls only, dozens of runs) was blocked under
// 5 GB and a prod build went out ungated. 2e's post-merge job uploads a 100 MB archive.
test('E: a command whose runs ate under 100 MB starts under minDisk, on any resource; one that ate more loses that until it is back down', () => {
  const key = 'heavy|python3 known_answers.py';
  const me = waiter({ res: ['heavy'], disk: 10 * G, key });
  const gate = ate(key, ...Array(24).fill(0), 3, 0, 1);
  const s = { leases: [lease()], queue: [me] };
  assert.equal(judge(s, me, cfg(), { diskFree: 4.7 * G }, gate).ok, true);
  assert.equal(judge(s, me, cfg(), { diskFree: 4.7 * G }).rule, 'disk', 'no runs yet: heavy is big by default');
  assert.match(judge(s, me, cfg(), { diskFree: 0.9 * G }, gate).why, /disk: 0\.9G free, you need 1\.0G \(a job that writes next to nothing still leaves 1\.0G free\)/);
  const grew = [...gate, ...ate(key, 400)];
  assert.equal(judge(s, me, cfg(), { diskFree: 4.7 * G }, grew).rule, 'disk', 'its last run ate 400 MB');
  assert.equal(judge(s, me, cfg(), { diskFree: 4.7 * G }, [...grew, ...ate(key, 2)]).ok, true, 'and back down: the middle of its runs is still near 0');
  assert.equal(tinyDisk({ res: ['heavy'], key: 'heavy|new' }, ate('heavy|new', 900, 5), cfg()), false, 'under three runs, the most any ate counts');
  assert.equal(tinyDisk({ res: ['heavy'], key: 'heavy|new' }, ate('heavy|new', 900, 5, 5), cfg()), true, 'from three, the middle');
  assert.equal(tinyDisk({ res: ['heavy'], key: 'heavy|new' }, ate('heavy|new', 5), cfg()), false, 'one small run is too few');
  assert.equal(tinyDisk({ res: ['heavy'], key: 'heavy|new' }, ate('heavy|new', 5, 5), cfg()), true, 'two are enough');
  // A run the watcher cleared caches under reads low, so it doesn't count.
  const masked = ate('heavy|new', 5, 5).map(h => ({ ...h, cleaned: true }));
  assert.equal(tinyDisk({ res: ['heavy'], key: 'heavy|new' }, masked, cfg()), false, 'runs under a cache clear');
  // relayreview, 2026-11-05: a first npm ci or bundling deploy writes gigabytes. With no runs, no resource is small by its kind;
  // only a --disk says so: under 100 MB anywhere, under 1 GB on one that declares no disk need.
  const by = r => tinyDisk({ res: [r], key: `${r}|first` }, [], cfg());
  assert.deepEqual(['deploy', 'test', 'migrations', 'xcode-build', 'sim', 'heavy'].map(by), [false, false, false, false, false, false]);
  const said = (r, d) => tinyDisk({ res: [r], key: `${r}|first`, disk: d, diskDeclared: true }, [], cfg());
  assert.deepEqual([said('heavy', 50 * M), said('heavy', 200 * M), said('test', 200 * M), said('deploy', 900 * M), said('deploy', 2 * G)], [true, false, true, true, false]);
  const deploy = waiter({ res: ['deploy'], mem: 0.5 * G, key: 'deploy|upload.sh' });
  assert.equal(judge({ leases: [lease()], queue: [deploy] }, deploy, cfg(), { diskFree: 4.4 * G }).rule, 'disk', 'a first deploy keeps the floor');
  assert.equal(judge({ leases: [lease()], queue: [deploy] }, deploy, cfg(), { diskFree: 4.4 * G }, ate('deploy|upload.sh', 90, 80)).ok, true, '2e\'s upload, 100 MB a run, 4.4 GB free');
  const ship = ate('deploy|ship.sh', 1030, 4275);
  assert.equal(judge({ leases: [lease()], queue: [deploy] }, deploy, cfg(), { diskFree: 4.4 * G }, ship.map(h => ({ ...h, key: 'deploy|upload.sh' }))).rule, 'disk', 'a deploy whose runs eat gigabytes keeps the floor');
});

// 3b: a Shop ship (#18328, high) waited about a day while idle sessions' swap kept free disk under 9 GB.
test('a job the person waits on (high, urgent, or --by with -m) skips the room kept for swap and may go down to the 3 GB hard floor', () => {
  const ship = waiter({ res: ['deploy'], mem: 2 * G, disk: 8 * G, diskDeclared: true, key: 'deploy|ship.sh', prio: 'high', purpose: 'ship 142' });
  const s = { leases: [lease({ mem: 2 * G })], queue: [ship] };
  const swapping = { diskFree: 9.5 * G, swapUsed: 6 * G, swapGrowth: 1 * G, vmPressure: 0, maxSwap: null };
  const c = cfg({ maxSwap: null });
  assert.equal(judge(s, ship, c, swapping).ok, true, JSON.stringify(judge(s, ship, c, swapping)));
  assert.equal(judge(s, { ...ship, prio: 'normal' }, c, swapping).rule, 'swaproom', 'at normal it keeps the room for swap');
  assert.equal(judge(s, { ...ship, prio: 'normal', by: T + 36e5 }, c, swapping).ok, true, 'a --by deadline with its reason counts as waited on');
  assert.equal(judge(s, { ...ship, prio: 'normal', by: T + 36e5, purpose: '' }, c, swapping).rule, 'swaproom', 'a bare --by does not');
  assert.equal(judge(s, ship, c, { ...swapping, diskFree: 7.5 * G }).rule, 'disk', 'its own 8 GB still has to be free');
  const build = waiter({ res: ['heavy'], disk: 1 * G, diskDeclared: true, key: 'heavy|make', prio: 'high', purpose: 'release' });
  assert.equal(judge({ leases: [lease()], queue: [build] }, build, cfg(), { diskFree: 3.5 * G }).ok, true, 'high: down to 3 GB');
  assert.equal(judge({ leases: [lease()], queue: [build] }, { ...build, prio: 'normal' }, cfg(), { diskFree: 3.5 * G }).rule, 'disk', 'normal: the 5 GB floor');
  assert.equal(judge({ leases: [lease()], queue: [build] }, build, cfg(), { diskFree: 2.5 * G }).rule, 'disk', 'not under the hard floor');
});

// H. 2e's dibs later l188, a post-merge job that uploads a 100 MB archive: "didn't start: dibs run exited 74 before starting it".
test('H: a scheduled job short of disk waits for room and then runs, instead of failing before it starts', async t => {
  const h = tmp(t), dir = tmp(t, 'proj'), d = disk(t, 1 * G);
  const runners = path.join(h, 'later', 'runners');
  bg(t, h, ['later', 'run'], { env: d.env });
  await until(() => { try { return fs.readdirSync(runners).length > 0; } catch { return false; } });
  const r = sync(h, ['later', 'heavy', '--in', '1s', '--', 'echo', 'shipped'], { env: d.env, cwd: dir });
  assert.equal(r.code, 0, r.err);
  const id = r.out.match(/^(l\d+):/)[1];
  const job = () => JSON.parse(sync(h, ['later', 'list', '--json'], { env: d.env }).out).jobs.find(j => j.id === id);
  await until(() => job().state === 'waiting' && board(h, { env: d.env }).waiting.length === 1);
  await new Promise(r => setTimeout(r, 3000));
  assert.equal(job().state, 'waiting', JSON.stringify(job()));
  d.set(1e12);
  await until(() => job().state === 'done');
  assert.equal(job().code, 0);
  assert.match(fs.readFileSync(job().log, 'utf8'), /\nshipped\n/);
});
