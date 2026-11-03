// The disk and swap watch after the crunch: it stops holding work back and
// pausing jobs once swap and disk stop moving, and a restart of the watcher
// doesn't undo its pauses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, HOME, tmp, sync, bg, until, board, flat } from './helpers.mjs';
import { DEFAULT_CONFIG, trends } from '../src/config.mjs';
import { diskSqueeze, swapping } from '../src/schedule.mjs';
import { diskStep, diskCritical, diskPause, pressurePause, settle, adoptPauses, flush, WATCHER_GRACE } from '../src/preempt.mjs';
import { plainBoard } from '../src/plain.mjs';

const WIN = process.platform === 'win32';
const T = Date.now();
const MIN = 6e4;
const cfg = { ...DEFAULT_CONFIG, resources: { ...DEFAULT_CONFIG.resources } };

test('swap and disk that stopped moving stop counting within two minutes, not five', () => {
  const file = path.join(HOME, 'swap.json');
  try {
    // Swap went 4G to 6.5G and free disk 12G to 4.5G in the minute before t, then both held still.
    fs.writeFileSync(file, JSON.stringify([{ at: T - 60e3, used: 4 * G, disk: 12 * G }, { at: T, used: 6.5 * G, disk: 4.5 * G }]));
    const now = trends(6.5 * G, 4.5 * G, T + 10e3);
    assert.ok(now.swapRecent > 2 * G && now.drainRecent > 7 * G, 'just after: still moving');
    const m = s => ({ diskFree: 4.5 * G, swapUsed: 6.5 * G, ...trends(6.5 * G, 4.5 * G, T + s * 1000) });
    assert.equal(diskCritical(m(10), cfg), true);
    // Readings every 30s, all the same, as the watcher writes them.
    for (let s = 30; s <= 150; s += 30) trends(6.5 * G, 4.5 * G, T + s * 1000);
    const later = m(150);
    assert.ok(later.swapGrowth > 2 * G, 'the 5-minute total still remembers the crunch');
    assert.equal(later.swapRecent, 0);
    assert.equal(diskCritical(later, cfg), false, 'nothing moving now: nothing more to pause');
    assert.equal(swapping(cfg, later), null, 'and new work is not held back for swap');
  } finally { fs.rmSync(file, { force: true }); }
});

test('free disk falling holds new work back only when it would run short soon', () => {
  const m = o => ({ diskFree: 200 * G, swapUsed: 0, swapGrowth: 0, diskDrain: 4 * G, drainMs: 5 * MIN, ...o });
  assert.equal(diskSqueeze(cfg, 5 * G, m()), null, 'two builds writing 4 GB with 200 GB free hold nobody up');
  assert.equal(diskSqueeze(cfg, 5 * G, m({ diskFree: 12 * G })).rule, 'drain', '12 GB at 0.8 GB a minute is under 8 GB within 10 minutes');
  assert.equal(diskSqueeze(cfg, 5 * G, m({ diskFree: 12 * G, drainRecent: 0 })), null, 'and stopped falling: nothing to wait for');
});

test('a disk pause notice says what the disk is doing: falling, or swap growing on it', () => {
  const l = (swap, n) => ({ id: n, kind: 'run', res: ['test'], who: 'a', mem: G, cpu: 1, start: T - MIN, pgid: 1, pausedAt: T, pauses: [{ watcher: 1, disk: true, swap }] });
  const s = { leases: [l(false, 1), l(true, 2)], queue: [] };
  const p = plainBoard(s, cfg, [], T);
  assert.equal(p.held.get(1).paused, 'Paused because free disk is low and still falling');
  assert.equal(p.held.get(2).paused, 'Paused because free disk is low and swap is still growing on it');
  // diskPause notes which it was.
  const run = { id: 3, kind: 'run', res: ['test'], pgid: 999999, pgstart: 'never', prio: 'normal', start: T };
  const other = { id: 4, kind: 'run', res: ['deploy'], pgid: 999999, pgstart: 'never', prio: 'normal', start: T };
  diskPause({ leases: [run, other], queue: [] }, cfg, T, { swapGrowth: 0, diskDrain: 5 * G });
  flush(false);
  assert.equal(run.pauses[0].swap, false);
});

test('the watcher never pauses the last running job: with everything stopped, nothing can finish and free anything', () => {
  // Names a process that isn't its own (pgstart doesn't match), so nothing is ever signalled.
  const run = o => ({ kind: 'run', res: ['test'], pgid: 999999, pgstart: 'never', mem: G, cpu: 1, prio: 'normal', ...o });
  const hold = { id: 9, kind: 'hold', res: ['playwright'], pid: 1, mem: G, cpu: 1, start: T - 9 * MIN };
  const m = { swapGrowth: 1.5 * G, diskDrain: 0 };
  const s = { leases: [run({ id: 1, start: T - 3 * MIN }), run({ id: 2, start: T - 2 * MIN }), run({ id: 3, start: T - MIN }), hold], queue: [] };
  assert.deepEqual([1, 2, 3].map(() => diskPause(s, cfg, T, m)?.id), [3, 2, undefined], 'newest first, and the oldest keeps going');
  const low = { leases: [run({ id: 1, prio: 'low' }), run({ id: 2, prio: 'low' }), hold], queue: [] };
  assert.deepEqual([1, 2].map(() => pressurePause(low, cfg)?.id), [1, undefined], 'the same under memory pressure');
  flush(false);
});

test('jobs paused for the disk resume against the same line they paused at, and after 3 still minutes anyway', () => {
  const small = { ...cfg, minDisk: '1G' };
  const still = { diskFree: 2.8 * G, swapGrowth: 0, diskDrain: 0 };
  const track = { diskOk: 0, diskStill: 0 };
  // minDisk 1G pauses under 3G; at 2.8G it mustn't resume a minute later and pause again.
  for (let i = 0; i < 6; i++) assert.equal(diskStep(track, still, small), null, `pass ${i}`);
  // Nothing moving for 3 minutes: paused jobs keep their memory and their swap, so waiting frees nothing. One resumes.
  let last = null;
  for (let i = 6; i < 18; i++) last = diskStep(track, still, small);
  assert.equal(last, 'resume');
  assert.equal(diskStep({ diskOk: 5, diskStill: 5 }, { diskFree: 3.5 * G, swapGrowth: 0, diskDrain: 0 }, small), 'resume', 'over the line and steady a minute');
});

test('a disk pause outlives a stopped watcher for a minute, and the next watcher takes it over', () => {
  const run = { id: 1, kind: 'run', res: ['test'], pgid: 999999, pgstart: 'never', start: T - MIN, pausedAt: T - MIN,
    pauses: [{ watcher: 999998, wstart: 'never', disk: true, at: T - MIN }, { watcher: 999998, wstart: 'never', at: T - MIN }] };
  // Another job keeps running, so the never-all-paused rule doesn't resume this one first.
  const other = { id: 2, kind: 'run', res: ['test'], pgid: 999999, pgstart: 'never', start: T - MIN };
  const s = { leases: [run, other], queue: [] };
  settle(s, T);
  flush(false);
  assert.deepEqual(run.pauses.map(p => !!p.disk), [true], 'the memory pause goes with its watcher; the disk one waits');
  assert.ok(run.pausedAt, 'still paused');
  assert.equal(adoptPauses(s, process.pid, 'me'), 1);
  assert.equal(run.pauses[0].watcher, process.pid);
  // Nobody came back for it: after the grace it goes, and the job resumes.
  run.pauses[0] = { watcher: 999998, wstart: 'never', disk: true };
  settle(s, T);
  settle(s, T + WATCHER_GRACE + 1);
  flush(false);
  assert.equal(run.pauses, undefined);
  assert.equal(run.pausedAt, undefined);
});

test('an urgent job a rate limit stops never pauses anyone while it waits', { skip: WIN }, async t => {
  const h = tmp(t), cwd = tmp(t, 'job');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ quotas: { asc: { per: '1h', limit: 1 } },
    resources: { p: { slots: 1, mem: '0.1G', cpu: 1, pausable: true } } }));
  // The bucket's one token goes first.
  assert.equal(sync(h, ['run', 'quota:asc', '--', 'true']).code, 0);
  // The low job notes every SIGCONT it gets: a pause and resume each poll would leave a trail.
  const low = bg(t, h, ['run', 'p', '-p', 'low', '--', 'sh', '-c', "trap 'echo c >> conts' CONT; while [ ! -f stop ]; do sleep 0.1; done"], { agent: 'lo', cwd });
  await until(() => board(h).held.some(l => l.pgid));
  const boss = bg(t, h, ['run', 'p,quota:asc', '-p', 'urgent', '-m', 'release', '--', 'true'], { agent: 'boss' });
  await until(() => board(h).waiting.length === 1 && /queued/.test(boss.err));
  // Several of its polls (1.5s apart), each of which used to stop and continue the low job.
  await until(() => (boss.err.match(/still queued|queued/g) || []).length >= 1);
  await new Promise(r => setTimeout(r, 5000));   // no event marks a pause that didn't happen; this is several polls' worth
  assert.equal(fs.existsSync(path.join(cwd, 'conts')), false, 'never stopped and continued');
  assert.match(flat(boss.err), /App Store Connect budget|quota/);
  boss.kill('SIGTERM');
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await low.done, 0);
});

// 2026-10-20: jobs sat paused on "free disk" and their agents heard only when the tool call returned.
test("a job paused for the disk tells its agent through the hook at once, with what to free", async t => {
  const { diskOnce } = await import('../src/cool.mjs');
  const { withState } = await import('../src/state.mjs');
  const { pstart } = await import('../src/proc.mjs');
  // This process holds them, so the state's reaping keeps them; their process group is nobody's, so nothing is signalled.
  const run = o => ({ kind: 'run', res: ['test'], pid: process.pid, pstart: pstart(process.pid), pgid: 999999, pgstart: 'never', mem: G, cpu: 1, prio: 'normal', who: 'builder', cmd: 'npm test', ...o });
  withState(s => { s.leases = [run({ id: 1, start: T - 3 * MIN }), run({ id: 2, start: T - MIN, sessionId: 'sess-x', purpose: 'suite' })]; s.queue = []; });
  t.after(() => { withState(s => { s.leases = []; }); flush(false); fs.rmSync(path.join(HOME, 'messages.json'), { force: true }); });
  const m = { ...MACHINE, diskFree: 0.5 * G, diskDrain: 4 * G, drainRecent: 4 * G, swapGrowth: 0 };
  const r = diskOnce({ ...cfg, minDisk: '1G' }, { diskOk: 0, diskStill: 0 }, m);
  assert.equal(r?.act, 'pause', JSON.stringify(r));
  const n = JSON.parse(fs.readFileSync(path.join(HOME, 'messages.json'), 'utf8')).messages.filter(x => String(x.once).startsWith('diskpause:'));
  assert.equal(n.length, 1);
  assert.equal(n[0].session, 'sess-x');
  assert.match(n[0].text, /^your job #2 \("suite", npm test\) is paused: free disk is low \(0\.5 GB\) and still falling.*Free what you can of your own/);
});
