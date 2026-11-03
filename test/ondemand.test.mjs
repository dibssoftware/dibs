// On-demand machines (src/ondemand.mjs): a cloud VM that sleeps until a job
// needs it, against a fake boat CLI (test/fake-boat.mjs) whose "VM" runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmp, bg, sync, until, port, answers, gitProject, inviteAndJoin, machinesOf, track, SERVE_START } from './helpers.mjs';
import { place } from '../src/serve.mjs';
import { ondemandOf, ondemand, sizeFor, findVm, NODE } from '../src/ondemand.mjs';
import { VERSION } from '../src/version.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-boat.mjs');
const ID = 'bx_test1234';
// Every boat call so far (none at all is no file).
const calls = dir => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l).args) : []);
const vmState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).vms[ID]?.state;
const events = home => { try { return fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

// A coordinator with one on-demand VM, a sender (gamma) and a fake boat. vm: the
// fake VM's starting state. The VM already has the pinned Node, as one would after its first wake.
// Another session's VM, running, that dibs must never touch.
const OTHER = 'bx_other999';
// The registry as ~/boat/VMS.md has it since 2026-10-18: a Kind column, and columns
// read by name, so their order here differs from the rows' [vm, owner, shared, use, notes].
const REGISTRY = rows => `# Boat VMs\n\nWho owns which VM.\n\n| VM | Kind | Owner | Shared with | Use | Notes |\n|---|---|---|---|---|---|\n`
  + `${rows.map(([vm, owner, shared, use, notes, kind = 'dedicated']) => `| ${vm} | ${kind} | ${owner} | ${shared} | ${use} | ${notes} |`).join('\n')}\n\nMore text after the table.\n`;
const ROWS = [[OTHER, 'alex-b8', '', 'Atlas browser runs', 'Running'], [ID, 'alex-3b', '', 'dibs tests; dibs on-demand machine', 'Stopped']];
async function setup(t, { vm = 'stopped', idleStop = '2s', rows = ROWS, vms, create, env } = {}) {
  const boatDir = tmp(t, 'boat');
  fs.writeFileSync(path.join(boatDir, 'state.json'), JSON.stringify({ vms: vms || { [ID]: { state: vm, pids: [] }, [OTHER]: { state: 'running', pids: [] } } }));
  const nodeDir = path.join(boatDir, `vm-${ID}`, '.dibs-node');
  fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeDir, 'bin', 'node'));
  fs.writeFileSync(path.join(nodeDir, '.pinned'), `${NODE.version}\n`);
  const wrapper = path.join(boatDir, 'boat');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const g = { h0: tmp(t, 'coord'), hc: tmp(t, 'gamma'), port: await port(), boatDir };
  g.registry = path.join(boatDir, 'VMS.md');
  fs.writeFileSync(g.registry, REGISTRY(rows));
  fs.writeFileSync(path.join(g.h0, 'config.json'), JSON.stringify({ machines: { ondemand: [{ name: 'boat-1', provider: 'boat', registry: g.registry, match: 'dibs', owner: 'alex-3b', idleStop, create }] } }));
  // The VMs (this process's children, under the fake) are cleaned up whatever happens.
  t.after(() => { try { for (const v of Object.values(JSON.parse(fs.readFileSync(path.join(boatDir, 'state.json'), 'utf8')).vms)) for (const pid of v.pids) process.kill(-pid, 'SIGKILL'); } catch {} });
  g.serveEnv = { DIBS_BOAT: wrapper, FAKE_BOAT_DIR: boatDir, FAKE_BOAT_NODE: nodeDir, ...env };
  g.serve = bg(t, g.h0, ['serve', '--listen', String(g.port), '--bind', '127.0.0.1'], { env: g.serveEnv });
  await until(async () => fs.existsSync(path.join(g.h0, 'remote.json')) && await answers(g.port), SERVE_START);
  inviteAndJoin(g, g.hc, 'gamma');
  g.proj = gitProject(t);
  return g;
}

test('a job sent --on a sleeping VM wakes it, runs there, and the VM stops once idle', async t => {
  const g = await setup(t);
  assert.deepEqual(machinesOf(g.hc).machines.map(m => [m.name, m.ondemand?.state, m.lost]), [['boat-1', 'asleep', false]]);
  const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--', 'sh', '-c', 'echo "on $HOME"'], { cwd: g.proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`on ${g.boatDir}/vm-${ID}`), 'it ran on the VM');
  const c = calls(g.boatDir);
  assert.ok(c.some(a => a[0] === 'resume' && a[1] === ID));
  assert.ok(c.some(a => a[0] === 'forward' && a.includes('--reverse') && a.includes(String(g.port))));
  assert.ok(c.some(a => a[0] === 'push' && a[1] === ID), 'dibs installed, since the VM had none');
  assert.ok(c.some(a => a[0] === 'scp' && a[2] === `${ID}:/home/user/.dibs/remote.json`), 'its token as a file, never in a command line');
  assert.ok(!c.some(a => a.join(' ').includes(JSON.parse(fs.readFileSync(path.join(g.h0, 'remote.json'), 'utf8')).token)), "the coordinator's token goes nowhere");
  // Its token is its own invite, and the copy of the job is gone with the job.
  assert.ok(JSON.parse(fs.readFileSync(path.join(g.h0, 'machines.json'), 'utf8')).machines['boat-1']);
  // The copy stays on the VM for the project's next job (its node_modules and build output with it).
  assert.equal(fs.readdirSync(path.join(g.boatDir, `vm-${ID}`, '.dibs', 'work')).filter(n => !n.endsWith('.files')).length, 1);
  await until(() => vmState(g.boatDir) === 'stopped', 30e3);
  await until(() => machinesOf(g.hc).machines[0].ondemand.state === 'asleep');
  const ev = events(g.h0).filter(e => e.kind === 'ondemand');
  assert.deepEqual(ev.map(e => e.act), ['resume', 'stop']);
  assert.ok(ev[0].ms >= 0 && ev[1].billed >= 0 && /queue is empty/.test(ev[1].why));
  // Its own row's Notes say so; every other line of the registry is as it was.
  const reg = fs.readFileSync(g.registry, 'utf8');
  assert.match(reg, new RegExp(`\\| ${ID} \\| dedicated \\| alex-3b \\|  \\| dibs tests; dibs on-demand machine \\| Stopped \\d\\d:\\d\\d by dibs \\(its queue is empty\\) \\|`));
  assert.deepEqual(reg.split('\n').filter(l => !l.includes(ID)), REGISTRY(ROWS).split('\n').filter(l => !l.includes(ID)));
  // The other session's VM was never touched.
  assert.ok(!calls(g.boatDir).some(a => a.includes(OTHER)));
  // A second wake: dibs is already there at this version, so nothing is copied again.
  const r2 = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--', 'true'], { cwd: g.proj });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(calls(g.boatDir).filter(a => a[0] === 'push').length, 1);
  assert.ok(!calls(g.boatDir).some(a => a.join(' ').includes('sha256sum')), 'nor is Node: the VM has the pinned one');
  await until(() => vmState(g.boatDir) === 'stopped', 30e3);
});

test('a coordinator restart mid-job leaves the VM running; the next one takes it back and the sender gets the exit code', async t => {
  const g = await setup(t);
  const p = bg(t, g.hc, ['run', 'test', '--on', 'boat-1', '--', 'sh', '-c', 'echo before; sleep 8; echo after; exit 4'], { cwd: g.proj });
  await until(() => p.out.includes('before'), 60e3);
  g.serve.kill('SIGTERM');
  await g.serve.done;
  assert.match(g.serve.out, /leaving bx_test1234 running: it has jobs/);
  assert.equal(vmState(g.boatDir), 'running');
  g.serve = bg(t, g.h0, ['serve', '--listen', String(g.port), '--bind', '127.0.0.1'], { env: g.serveEnv });
  assert.equal(await p.done, 4, p.err);
  assert.equal(p.out, 'before\nafter\n');
  assert.match(g.serve.out, /was left running a job; picking its jobs up again/);
  // Then stopped as usual once its queue is empty.
  await until(() => vmState(g.boatDir) === 'stopped', 30e3);
});

test('a VM found running work outside dibs when the coordinator starts is left running', async t => {
  const g = await setup(t, { vms: { [ID]: { state: 'running', pids: [], ps: [{ command: 'node --test test/a.test.mjs', cpuPercent: 80 }] }, [OTHER]: { state: 'running', pids: [] } } });
  await until(() => g.serve.out.includes('busy with work outside dibs'));
  assert.equal(vmState(g.boatDir), 'running');
  assert.ok(!calls(g.boatDir).some(a => a[0] === 'stop'));
});

test('a VM of ours found running when the coordinator starts is stopped', async t => {
  const g = await setup(t, { vm: 'running' });
  // The event is written once boat stop has answered, a moment after the VM reads stopped.
  await until(() => events(g.h0).some(e => e.kind === 'ondemand' && e.act === 'stop' && /coordinator started/.test(e.why)));
  assert.equal(vmState(g.boatDir), 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(g.boatDir, 'state.json'), 'utf8')).vms[OTHER].state, 'running', "another session's VM is left alone");
});

test('--anywhere wakes a sleeping VM only when the wait on every awake machine is longer than waking it', () => {
  const vm = { state: 'asleep', resumeMs: 30e3, provider: 'boat' };
  const at = waiting => new Map([
    ['mac', { name: 'mac', os: 'macos', cores: 8, load: 0, memFree: 50, seen: Date.now(), busy: { test: { used: 3, slots: 3, waiting } } }],
    ['boat-1', { name: 'boat-1', os: 'linux', cores: 4, load: 0, memFree: 100, seen: 0, busy: {}, ondemand: vm }],
  ]);
  const need = { res: ['test'], from: 'mac' };
  assert.equal(place(at(0), need).machine, 'mac', 'nothing to wait for here');
  assert.equal(place(at(4), need).machine, 'boat-1', 'four ahead here takes longer than a 30s wake');
  assert.equal(place(new Map([['boat-1', at(0).get('boat-1')]]), need).machine, 'mac', "nothing awake to compare with: it isn't woken");
  assert.equal(place(at(0), { ...need, on: 'boat-1' }).machine, 'boat-1', '--on always wakes it');
  vm.problem = 'no row in VMS.md has "dibs" in its Use';
  const p = place(at(9), { ...need, on: 'boat-1' });
  assert.deepEqual([p.machine, /can't be used: no row .* so it runs here/.test(p.why)], ['mac', true], 'a VM it can\'t find: said plainly, and the job runs here');
  assert.equal(place(at(9), need).machine, 'mac');
});

test('a bad on-demand entry in config.json is named, and an id is refused: dibs finds the VM in its registry', () => {
  const ok = { name: 'boat-1', provider: 'boat', registry: '~/boat/VMS.md', match: 'dibs' };
  assert.throws(() => ondemandOf({ machines: { ondemand: [{ ...ok, provider: 'aws' }] } }), /provider is "boat"/);
  assert.throws(() => ondemandOf({ machines: { ondemand: [{ ...ok, name: 'x y' }] } }), /name is letters/);
  assert.throws(() => ondemandOf({ machines: { ondemand: [{ ...ok, id: 'bx_1' }] } }), /no id\. VM ids change/);
  assert.throws(() => ondemandOf({ machines: { ondemand: [{ ...ok, match: '' }] } }), /match is a word/);
  const [c] = ondemandOf({ machines: { ondemand: [ok] } });
  assert.equal(c.idleStop, 30e3, 'every idle second is billed: 30s unless set');
  assert.throws(() => ondemandOf({ machines: { ondemand: [{ ...ok, idleStop: '10m' }] } }), /idleStop is at most 3m/);
  assert.ok(c.registry.endsWith('/boat/VMS.md') && !c.registry.startsWith('~'));
  assert.ok(VERSION);
});

for (const [what, rows, vms, says] of [
  ['no row for it', [ROWS[0]], null, /no row in .* has "dibs" in its Use/],
  ['two rows for it', [...ROWS, ['bx_third1', 'alex-3b', '', 'dibs spare', '']], null, /2 rows in .* have "dibs" in their Use/],
  ['a row naming a VM boat lacks', ROWS, { [OTHER]: { state: 'running', pids: [] } }, /names bx_test1234, which boat doesn't have/],
])
  test(`a VM it can't find (${what}): it says so, wakes nothing, and the job runs here`, async t => {
    const g = await setup(t, { rows, vms });
    // The coordinator's first look at the registry runs boat list; on a loaded machine that took over 30s.
    await until(() => machinesOf(g.hc).machines[0]?.ondemand?.problem, 90e3);
    assert.match(machinesOf(g.hc).machines[0].ondemand.problem, says);
    const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--', 'sh', '-c', 'echo "on $HOME"'], { cwd: g.proj });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err.replace(/\n +/g, ' '), /boat-1 can't be used: .* so it runs here/);
    assert.ok(!calls(g.boatDir).some(a => ['resume', 'stop', 'exec'].includes(a[0])), 'no VM woken or stopped');
  });

test('a running VM is stopped once its queue has been empty for idleStop, by the clock, not a second sooner', async t => {
  // The manager on its own, with a fake coordinator and a clock the test moves.
  const boatDir = tmp(t, 'boat');
  fs.writeFileSync(path.join(boatDir, 'state.json'), JSON.stringify({ vms: { [ID]: { state: 'running', pids: [] } } }));
  const wrapper = path.join(boatDir, 'boat');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const registry = path.join(boatDir, 'VMS.md');
  fs.writeFileSync(registry, REGISTRY(ROWS));
  Object.assign(process.env, { DIBS_BOAT: wrapper, FAKE_BOAT_DIR: boatDir });
  t.after(() => { delete process.env.DIBS_BOAT; delete process.env.FAKE_BOAT_DIR; });
  const workers = new Map(), jobs = new Map();
  const srv = { workers, jobs, trust: { only: () => null, invite: () => 'token' }, finish: () => {}, LOST: 76, fits: () => null, move: () => {} };
  let at = 1e6;
  const [c] = ondemandOf({ machines: { ondemand: [{ name: 'boat-1', provider: 'boat', registry, match: 'dibs' }] } });
  const od = ondemand([c], srv, { port: 1, tick: 0, clock: () => at, log: () => {} });
  const vm = od.vms.get('boat-1');
  Object.assign(vm, { state: 'running', id: ID, upSince: Date.now() });
  const w = workers.get('boat-1');
  Object.assign(w, { seen: Date.now(), running: ['job-1'] });
  await od.pass();
  assert.equal(vm.state, 'running', 'a job runs there');
  w.running = [];
  await od.pass();            // its queue goes empty now
  at += 29e3;
  await od.pass();
  assert.equal(vm.state, 'running', '29s idle: still up');
  at += 1e3;
  await od.pass();
  await until(() => vm.state === 'asleep');
  assert.equal(vmState(boatDir), 'stopped');
});

const boatVms = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).vms;
const TEMP_USE = 'dibs temporary VM (boat-1-temp) for a job too big for its dedicated one';

test('a job too big for the VM gets a VM made in the smallest size that fits, listed while it runs, then deleted with its row', async t => {
  const g = await setup(t, { create: { max: 'large' } });
  assert.deepEqual(machinesOf(g.hc).machines.map(m => [m.name, m.ondemand?.state]), [['boat-1', 'asleep'], ['boat-1-temp', 'asleep']]);
  // While the job runs, the registry lists its VM as temporary, ours.
  const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--mem', '12G', '--', 'sh', '-c', `echo "on $HOME"; grep temporary ${g.registry}`], { cwd: g.proj });
  assert.equal(r.code, 0, r.err);
  const made = calls(g.boatDir).find(a => a[0] === 'new');
  assert.deepEqual(made, ['new', '--type', 'large'], '12G is more than default has: large');
  assert.match(r.err.replace(/\n +/g, ' '), /makes a VM big enough for it/);
  const id = r.out.match(/vm-(bx_t\w+)/)?.[1];
  assert.ok(id, `it ran on the new VM: ${r.out}`);
  assert.match(r.out, new RegExp(`\\| ${id} \\| temporary \\| alex-3b \\|  \\| ${TEMP_USE.replace(/[()]/g, '\\$&')} \\| Created`));
  assert.ok(!calls(g.boatDir).some(a => a[0] === 'resume'), 'the dedicated VM stays asleep');
  // Once its queue is empty: deleted, and the registry is as it was.
  await until(() => !boatVms(g.boatDir)[id], 30e3);
  assert.ok(calls(g.boatDir).some(a => a[0] === 'delete' && a[1] === id && a.includes('--yes')));
  await until(() => fs.readFileSync(g.registry, 'utf8') === REGISTRY(ROWS));
  assert.ok(!calls(g.boatDir).some(a => a.includes('--no-auto-stop')));
  assert.ok(!calls(g.boatDir).some(a => a.includes(OTHER)));
  assert.deepEqual(events(g.h0).filter(e => e.kind === 'ondemand').map(e => e.act), ['create', 'delete']);
  // A job the dedicated VM takes never makes one.
  const r2 = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--mem', '2G', '--', 'true'], { cwd: g.proj });
  assert.equal(r2.code, 0, r2.err);
  assert.equal(calls(g.boatDir).filter(a => a[0] === 'new').length, 1);
});

test('a VM that fails to be made: the job is lost before it started (76) and nothing is left', async t => {
  const g = await setup(t, { create: { max: 'large' }, env: { FAKE_BOAT_NEW_FAIL: '1' } });
  const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--mem', '12G', '--', 'true'], { cwd: g.proj });
  assert.equal(r.code, 76, r.err);
  assert.match(r.err.replace(/\n +/g, ' '), /boat new failed: no_ready_machine/);
  assert.equal(fs.readFileSync(g.registry, 'utf8'), REGISTRY(ROWS));
});

test('a job bigger than the biggest VM dibs may make is refused plainly', async t => {
  const g = await setup(t, { create: { max: 'default' } });
  const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--mem', '12G', '--', 'true'], { cwd: g.proj });
  assert.notEqual(r.code, 0);
  assert.match(r.err.replace(/\n +/g, ' '), /less memory than the job needs/);
  assert.ok(!calls(g.boatDir).some(a => a[0] === 'new'));
});

test('temporary VMs a crash left listed are deleted when the coordinator starts; nobody else\'s are', async t => {
  const LEFT = 'bx_tleft001';
  const g = await setup(t, { create: { max: 'large' }, vms: { [ID]: { state: 'stopped', pids: [] }, [OTHER]: { state: 'running', pids: [] }, [LEFT]: { state: 'running', pids: [] } },
    rows: [...ROWS, [LEFT, 'alex-3b', '', TEMP_USE, 'Created 10:00 by dibs', 'temporary'], ['bx_tnotours', 'alex-b8', '', 'a temporary VM of b8', '', 'temporary']] });
  await until(() => !boatVms(g.boatDir)[LEFT]);
  await until(() => !fs.readFileSync(g.registry, 'utf8').includes(LEFT));
  assert.ok(fs.readFileSync(g.registry, 'utf8').includes('bx_tnotours'));
  assert.ok(!calls(g.boatDir).some(a => a.includes('bx_tnotours') || a.includes(OTHER)));
});

test('a temporary VM is the smallest boat size that takes the job, never more than max', () => {
  const G = 1024 ** 3;
  assert.equal(sizeFor([{ mem: 3 * G }], 'large'), 'small');
  assert.equal(sizeFor([{ mem: 3 * G, cpu: 3 }], 'large'), 'default');
  assert.equal(sizeFor([{ mem: 12 * G }], 'large'), 'large');
  assert.equal(sizeFor([{ mem: 12 * G }], 'default'), null);
  assert.equal(sizeFor([{ mem: 1 * G }, { cpu: 6 }], 'large'), 'large', 'every waiting job fits');
  assert.throws(() => ondemandOf({ machines: { ondemand: [{ name: 'b', provider: 'boat', registry: 'r', match: 'dibs', create: { max: 'xlarge' } }] } }), /create is \{ "max": "small" \}/);
});

test('--on the VM with more --mem or --cpu than it has goes to a VM made for it; a resource guess of cores never does', () => {
  const G = 1024 ** 3;
  const temp = { state: 'asleep', provider: 'boat', temp: true, of: 'boat-1', create: { max: 'large' }, over: { cores: 4, mem: 8 * G } };
  const ws = new Map([
    ['boat-1', { name: 'boat-1', os: 'linux', cores: 4, memTotal: 8 * G, load: 0, memFree: 100, seen: 0, busy: {}, ondemand: { state: 'asleep', provider: 'boat', bigger: 'boat-1-temp' } }],
    ['boat-1-temp', { name: 'boat-1-temp', os: 'linux', cores: 8, memTotal: 16 * G, load: 0, memFree: 100, seen: 0, busy: {}, ondemand: temp }],
  ]);
  const need = { res: ['test'], on: 'boat-1', from: 'mac', cpu: 6 };
  assert.equal(place(ws, need).machine, 'boat-1', 'cpu 6 here is the resource\'s guess, not --cpu');
  assert.match(place(ws, { ...need, askedCpu: 6 }).why, /fewer cores than the job asked for, so dibs makes a VM/);
  assert.equal(place(ws, { ...need, askedCpu: 6 }).machine, 'boat-1-temp');
  assert.equal(place(ws, { ...need, mem: 12 * G }).machine, 'boat-1-temp');
  assert.equal(place(ws, { ...need, askedCpu: 12 }).machine, 'boat-1', 'more cores than any VM dibs may make: cores are a budget, not a wall, so it runs where sent');
});

// 2026-10-19: the boat account's 200 daily starts ran out, every wake got a 429, and every job sent to boat-1 came back lost (76).
test("with boat's starts used up, dibs doesn't try to wake: the job runs where it was sent from, and the VM shows can't wake", async t => {
  const used = JSON.stringify({ canStart: false, starts: { day: { used: 200, limit: 200, remaining: 0 }, hour: { used: 0, limit: 60, remaining: 60 } } });
  const g = await setup(t, { env: { FAKE_BOAT_LIMITS: used } });
  const w = bg(t, g.hc, ['worker']);
  await until(() => machinesOf(g.hc).machines.some(m => m.name === 'gamma' && !m.lost));
  const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--', 'sh', '-c', 'echo "on $HOME"'], { cwd: g.proj });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /vm-/, 'it ran on gamma, not a VM');
  assert.match(r.err.replace(/\n +/g, ' '), /can't wake \(boat says no VM can start now\), so it runs on gamma/);
  assert.ok(!calls(g.boatDir).some(a => a[0] === 'resume'), 'no wake was tried');
  // Marked, with the reason and a retry time: dibs machines says so, and --on is refused with it.
  const row = machinesOf(g.hc).machines.find(m => m.name === 'boat-1');
  assert.match(row.ondemand.cantWake.why, /no VM can start/);
  assert.ok(row.ondemand.cantWake.until > Date.now() + 50 * 60e3, 'about an hour');
  // The retry is an hour out, so within an hour of midnight it falls tomorrow and names the date.
  assert.match(sync(g.hc, ['machines']).out, /boat-1 .*can't wake .*can't wake: boat says no VM can start now, checks again (on \d{4}-\d\d-\d\d )?at \d\d?:\d\d/);
  const again = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--', 'true'], { cwd: g.proj });
  assert.notEqual(again.code, 0);
  assert.match(again.err, /boat-1 can't wake: boat says no VM can start now, retry \d\d:\d\d/);
  w.kill('SIGTERM');
  await w.done;
});

// 2026-10-22: boat's compute ran out for the month; boat-1 read "asleep: a job sent there wakes it" while every job meant for it waited.
test("with boat's compute used up for the month, an asleep VM shows can't wake before any job is sent, with the date it comes back", async t => {
  const out = JSON.stringify({ canStart: false, blockedReason: 'usage_depleted', subscriptionCurrentPeriodEnd: '2026-11-18T19:47:26.000Z',
    starts: { day: { used: 33, limit: 200, remaining: 167 }, hour: { used: 2, limit: 60, remaining: 58 } } });
  const g = await setup(t, { env: { FAKE_BOAT_LIMITS: out } });
  await until(() => machinesOf(g.hc).machines.find(m => m.name === 'boat-1')?.ondemand?.cantWake);
  const row = machinesOf(g.hc).machines.find(m => m.name === 'boat-1');
  assert.match(row.ondemand.cantWake.why, /boat's compute for this billing period is used up \(it comes back 2026-11-18\)/);
  assert.match(sync(g.hc, ['machines']).out.replace(/\n +/g, ' '), /can't wake: boat's compute for this billing period is used up/);
  assert.ok(!calls(g.boatDir).some(a => a[0] === 'resume'), 'no wake was tried');
});

test('a wake boat refuses (429) puts the job back on the machine that sent it instead of losing it', async t => {
  const g = await setup(t, { env: { FAKE_BOAT_RESUME_FAIL: 'HTTP 429 Too Many Requests: daily start limit reached' } });
  const w = bg(t, g.hc, ['worker']);
  await until(() => machinesOf(g.hc).machines.some(m => m.name === 'gamma' && !m.lost));
  const r = sync(g.hc, ['run', 'test', '--on', 'boat-1', '--', 'sh', '-c', 'echo "on $HOME"'], { cwd: g.proj });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /vm-/);
  assert.match(r.err.replace(/\n +/g, ' '), /can't wake \(boat resume failed: HTTP 429 .*\), so it runs on gamma/);
  const no = machinesOf(g.hc).machines.find(m => m.name === 'boat-1').ondemand.cantWake;
  assert.ok(no && no.until > Date.now() + 50 * 60e3, 'a 429 backs off about an hour');
  w.kill('SIGTERM');
  await w.done;
});

// 2026-10-20: boat's snapshot brought boat-1's worker back on the old dibs as the VM woke. It took
// the job, was turned away when dibs gave the VM a new token, and the job ended 77; the new worker
// waited for the old one to leave. Here a stand-in for that worker (named dibs.mjs worker, in the
// VM's worker.pid, beating as boat-1 at an old version) runs before the job is sent.
const STALE = `import fs from 'node:fs';
const [url, token, pidfile, took] = process.argv.slice(3);
fs.writeFileSync(pidfile, String(process.pid));
for (;;) {
  try {
    const r = await fetch(url + '/worker/beat', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'boat-1', os: 'linux', cores: 4, memTotal: 8 * 1024 ** 3, version: '0.0.1', running: [], busy: {} }) });
    const a = await r.json();
    if (a.jobs?.length) fs.appendFileSync(took, a.jobs.map(j => j.id).join(' ') + '\\n');
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
`;
test('a worker brought back on an older dibs as the VM wakes gets no job, and is replaced before the job runs', async t => {
  // A slow resume keeps the VM waking while the old worker beats with the token it had.
  const g = await setup(t, { env: { FAKE_BOAT_RESUME_MS: '2000' } });
  const token = sync(g.h0, ['invite', 'boat-1'], { agent: 'tester' }).out.match(/dibs join \S+ (\S+) --name boat-1/)[1];
  const vmHome = path.join(g.boatDir, `vm-${ID}`);
  fs.mkdirSync(path.join(vmHome, '.dibs'), { recursive: true });
  fs.mkdirSync(path.join(vmHome, 'old'), { recursive: true });
  fs.writeFileSync(path.join(vmHome, 'old', 'dibs.mjs'), STALE);
  const took = path.join(g.boatDir, 'took');
  const old = track(t, spawn(process.execPath, [path.join(vmHome, 'old', 'dibs.mjs'), 'worker', `http://127.0.0.1:${g.port}`, token, path.join(vmHome, '.dibs', 'worker.pid'), took], { stdio: 'ignore' }));
  await until(() => machinesOf(g.hc).machines.some(m => m.name === 'boat-1' && m.version === '0.0.1'));
  // In the background, so this process reaps the old worker once it's stopped (a sync wait would leave it a zombie).
  const r = bg(t, g.hc, ['run', 'test', '--on', 'boat-1', '--', 'sh', '-c', 'echo "on $HOME"'], { cwd: g.proj });
  assert.equal(await r.done, 0, r.err);
  assert.match(r.out, new RegExp(`on ${vmHome}`), 'it ran on the VM, by the worker dibs started');
  assert.ok(!fs.existsSync(took), `the old worker took a job: ${fs.existsSync(took) && fs.readFileSync(took, 'utf8')}`);
  assert.notEqual(await old.done, 0, 'the old worker was stopped');
  await until(() => vmState(g.boatDir) === 'stopped', 30e3);
});

// 2026-10-20: boat-1-temp's row ("dibs temporary VM ...") matched boat-1's "dibs" too, so boat-1
// couldn't be found while a temporary VM existed, and jobs sent there ran on the Mac.
test("a temporary VM's row beside the dedicated one doesn't hide the dedicated one", async t => {
  const dir = tmp(t, 'boat');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ vms: { [ID]: { state: 'stopped', pids: [] }, bx_tmp1: { state: 'running', pids: [] } } }));
  const wrapper = path.join(dir, 'boat');
  fs.writeFileSync(wrapper, `#!/bin/sh\nFAKE_BOAT_DIR="${dir}" exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const registry = path.join(dir, 'VMS.md');
  fs.writeFileSync(registry, REGISTRY([...ROWS, ['bx_tmp1', 'alex-3b', '', 'dibs temporary VM (boat-1-temp) for a job too big for its dedicated one', 'Created 23:34 by dibs', 'temporary']]));
  const was = process.env.DIBS_BOAT;
  process.env.DIBS_BOAT = wrapper;
  t.after(() => { if (was == null) delete process.env.DIBS_BOAT; else process.env.DIBS_BOAT = was; });
  assert.deepEqual(await findVm({ registry, match: 'dibs', owner: 'alex-3b' }), { id: ID, state: 'stopped' });
});
