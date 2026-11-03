// A job paused for low disk whose memory goes to swap, filling the disk it
// waits for: the watcher stops it, and its own dibs run puts it back at the
// front of its line and runs it again (src/preempt.mjs diskRequeue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BIN, G, MACHINE, tmp, env, bg, track, until } from './helpers.mjs';
import { withState } from '../src/state.mjs';
import { diskRequeue, overBooked } from '../src/preempt.mjs';
import { verdict } from '../src/schedule.mjs';
import { loadConfig } from '../src/config.mjs';

const state = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')); } catch { return { leases: [], queue: [] }; } };
const events = home => { try { return fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
// Free disk under minDisk and swap growing on it, as the watcher sees it.
const FILLING = JSON.stringify({ ...MACHINE, diskFree: 1 * G, swapUsed: 6 * G, swapGrowth: 2 * G, diskDrain: 1 * G, drainMs: 6e4 });

test('a job paused for low disk while swap grows is stopped and run again from the front of its line, in the same call', async t => {
  const home = tmp(t), dir = tmp(t, 'job');
  // Something else running, so pausing the job never leaves nothing running.
  bg(t, home, ['run', 'deploy', '--', 'sleep', '120'], { agent: 'other' });
  await until(() => state(home).leases.some(l => l.res.includes('deploy') && l.pgid));
  // The job: says when it starts, and finishes once the test lets it.
  const job = track(t, spawn(BIN, ['run', 'test', '-m', 'suite', '--', 'sh', '-c', 'echo start; while [ ! -f gate ]; do sleep 0.1; done; echo done'],
    { env: env(home, { agent: 'me' }), cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }));
  job.out = ''; job.err = '';
  job.stdout.on('data', d => (job.out += d));
  job.stderr.on('data', d => (job.err += d));
  await until(() => job.out.includes('start'));
  const first = state(home).leases.find(l => l.res.includes('test')).id;
  const watcher = bg(t, home, ['throttle', '--watch'], { env: { DIBS_FAKE_MACHINE: FILLING } });
  // One pass pauses it; the next, with swap still growing, stops it, and it starts over.
  await until(() => job.out.split('start').length === 3, 60e3);
  watcher.kill('SIGTERM');
  fs.writeFileSync(path.join(dir, 'gate'), '');
  assert.equal(await job.done, 0, job.err);
  assert.match(job.out, /done/);
  assert.match(job.err.replace(/\n +/g, ' '), /back at the front of the line .* Nothing for you to do: this call carries on/);
  assert.doesNotMatch(job.err, /stopped by the owner/);
  assert.ok(events(home).some(e => e.kind === 'requeue' && e.id === first && e.why === 'disk'));
  const inbox = fs.readFileSync(path.join(home, 'messages.json'), 'utf8');
  assert.match(inbox, new RegExp(`requeue:#${first}`));
  assert.match(fs.readFileSync(path.join(home, 'cool.log'), 'utf8'), /swap is still growing: stopped me test/);
});

test('only paused-for-disk jobs that can run again are stopped, the biggest first, never one a person paused or one nearly done', () => {
  const cfg = loadConfig();
  const t = Date.now();
  const lease = (id, extra) => ({ id, kind: 'run', res: ['test'], pgid: 999999, pid: 999998, start: t - 6e4, pausedAt: t - 1e4, requeuable: true,
    pauses: [{ watcher: 1, disk: true }], mem: 2 * G, who: 'a', cmd: 'x', key: 'test|x', ...extra });
  withState(s => {
    s.leases = [
      lease(1, { use: { mem: 1 * G } }),
      lease(2, { use: { mem: 5 * G } }),
      lease(3, { use: { mem: 9 * G }, res: ['deploy'] }),                              // not safe to run again
      lease(4, { use: { mem: 8 * G }, pauses: [{ watcher: 1, disk: true }, { owner: true }] }),   // the person's pause too
      lease(5, { use: { mem: 7 * G }, requeuable: false }),                              // its dibs run can't requeue
      lease(6, { use: { mem: 6 * G }, pauses: [{ watcher: 1 }] }),                       // paused for memory, not disk
      lease(7, { use: { mem: 6.5 * G }, est: 61e3 }),                                    // a second from done
    ];
    const got = diskRequeue(s, cfg, t, []);
    assert.equal(got.id, 2);
    assert.ok(s.leases.find(l => l.id === 2).requeue);
    assert.equal(diskRequeue(s, cfg, t, []).id, 1, 'one a pass, then the next');
    assert.equal(diskRequeue(s, cfg, t, []), null);
    s.leases = [];
  });
});

// A job's dibs run, its output kept.
function job(t, home, args, opts) {
  const p = track(t, spawn(BIN, args, { env: env(home, opts), cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  return p;
}
const GATED = ['sh', '-c', 'echo start; while [ ! -f gate ]; do sleep 0.1; done; echo done'];

test('a job running far past its booking while swap fills the disk is stopped, and runs again booked at what it used, even as the only job', async t => {
  const home = tmp(t), dir = tmp(t, 'job');
  // What the job's processes really use, as measuring reads it.
  const foot = path.join(home, 'footprint.json');
  fs.writeFileSync(foot, '{}');
  const p = job(t, home, ['run', 'test', '--mem', '1G', '-m', 'suite', '--', ...GATED], { agent: 'me', cwd: dir, env: { DIBS_FAKE_FOOTPRINT: foot, DIBS_SAMPLE_MS: '200' } });
  await until(() => p.out.includes('start'));
  const l = state(home).leases.find(x => x.res.includes('test'));
  fs.writeFileSync(foot, JSON.stringify({ [l.pgid]: 12 * G }));
  await until(() => state(home).leases.find(x => x.id === l.id)?.use?.mem >= 12 * G);
  const watcher = bg(t, home, ['throttle', '--watch'], { env: { DIBS_FAKE_MACHINE: FILLING } });
  await until(() => p.out.split('start').length === 3, 60e3);
  watcher.kill('SIGTERM');
  fs.writeFileSync(path.join(dir, 'gate'), '');
  assert.equal(await p.done, 0, p.err);
  const said = p.err.replace(/\n +/g, ' ');
  assert.match(said, /using far more memory than it booked .* booked at 8\.0G, and runs again from the start once that much memory is really free/);
  const e = events(home).find(x => x.kind === 'requeue' && x.id === l.id);
  assert.deepEqual([e?.why, e?.mem, e?.booked], ['over', 12 * G, 1 * G]);
  assert.match(fs.readFileSync(path.join(home, 'messages.json'), 'utf8'), /far more than the 1\.0G it booked/);
  // What it really used is learned, so the next run is planned at it from the start.
  const hist = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.ok(hist.some(h => h.key.startsWith('test|sh') && h.mem === 12 * G));
});

test('a command that used more than it asks for is booked at what it used, and its agent hears why once', t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'history.jsonl'), JSON.stringify({ key: 'test|true', dur: 1000, who: 'me', at: Date.now(), fit: true, mem: 6 * G, cpu: 6 }) + '\n');
  const opts = { agent: 'me', env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } };
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath, [BIN, 'run', 'test', '--mem', '3G', '--cpu', '3', '--', 'true'], { env: env(home, opts), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /used up to 6\.0 GB of memory \(it asks for 3\.0 GB\) and 6 cores \(it asks for 3\)/);
  }
  const msgs = JSON.parse(fs.readFileSync(path.join(home, 'messages.json'), 'utf8')).messages.filter(m => m.kind === 'notice');
  assert.equal(msgs.length, 1, 'said once, not every run');
  assert.match(msgs[0].text, /booked it at that, not at what you asked for\. To have your own number match, pass --mem 6G --cpu 6/);
  assert.equal(msgs[0].session, 'sess-1');
});

test('far past its booking means 4 GB over and twice it, or over the whole budget; a job stopped for it once is not stopped again', () => {
  const cfg = loadConfig();   // budget 8G
  const at = (mem, used) => ({ mem, use: { mem: used } });
  assert.equal(overBooked(at(2 * G, 5 * G), cfg), false, 'under 4 GB over');
  assert.equal(overBooked(at(5 * G, 9.5 * G), cfg), true, 'over the budget');
  assert.equal(overBooked(at(1 * G, 6 * G), cfg), true);
  assert.equal(overBooked(at(6 * G, 7.9 * G), cfg), false);
  const t = Date.now();
  const run = (id, extra) => ({ id, kind: 'run', res: ['test'], pgid: 999999, pid: 999998, start: t - 6e4, requeuable: true, mem: 1 * G, who: 'a', cmd: 'x', key: 'test|x', ...extra });
  withState(s => {
    s.leases = [run(1, { use: { mem: 7 * G } }), run(2, { use: { mem: 9 * G }, requeues: 1 }), run(3, { use: { mem: 1.5 * G } })];
    assert.equal(diskRequeue(s, cfg, t, []).id, 1);
    assert.equal(diskRequeue(s, cfg, t, []), null, 'the one stopped before, and the one within its booking, stay');
    s.leases = [];
  });
});

test('a job requeued for going far past its booking waits for that much memory to be really free and swap to hold still', () => {
  const cfg = loadConfig();
  const me = { id: 1, res: ['test'], mem: 8 * G, cpu: 1, enq: Date.now(), who: 'me', kind: 'run', requeued: 'over', pid: 1 };
  const s = { leases: [], queue: [me] };
  const at = m => verdict(s, me, cfg, [], Date.now());
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memFree: 30, memTotal: 16 * G });
  let v = at();
  assert.equal(v.ok, false);
  assert.equal(v.rule, 'oversize');
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memFree: 90, memTotal: 16 * G });
  assert.equal(at().ok, true);
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memFree: 90, memTotal: 16 * G, swapGrowth: 2 * G, diskDrain: 0, drainMs: 6e4 });
  assert.equal(at().rule, 'oversize', 'swap still growing');
  process.env.DIBS_FAKE_MACHINE = JSON.stringify(MACHINE);
});
