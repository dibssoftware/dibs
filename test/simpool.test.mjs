// The simulator pool, against a fake simctl: unit rules first, then the real
// binary handing out devices, surviving a kill -9 and pruning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, SIMCTL, G, MACHINE, tmp, shared, sync as dibs, bg as spawnDibs, until } from './helpers.mjs';
import { spec, claim, reapPool, poolRoom, poolBlock, simMem, checkout, checkin, PREFIX } from '../src/simpool.mjs';
import { simctl } from '../src/simctl.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { withState } from '../src/state.mjs';
import { verdict } from '../src/schedule.mjs';

const BIG_MAC = { ...MACHINE, memTotal: 16 * G };

const RUNTIMES = [
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6', name: 'iOS 18.6', version: '18.6', platform: 'iOS', isAvailable: true,
    supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', name: 'iPhone 16', productFamily: 'iPhone' }] },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', name: 'iOS 26.5', version: '26.5', platform: 'iOS', isAvailable: true,
    supportedDeviceTypes: [
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', name: 'iPhone 17 Pro', productFamily: 'iPhone' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', name: 'iPhone 17', productFamily: 'iPhone' },
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3', name: 'iPad Air 11-inch (M3)', productFamily: 'iPad' }] },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0', name: 'watchOS 26.0', version: '26.0', platform: 'watchOS', isAvailable: true, supportedDeviceTypes: [] },
];
// Somebody's own simulator, which dibs must never touch.
const THEIRS = { udid: 'USER-0001', name: 'iPhone 17 Pro', state: 'Booted', runtime: RUNTIMES[1].identifier, type: RUNTIMES[1].supportedDeviceTypes[0].identifier, size: 5 * G };

// A CoreSimulator of its own: a JSON file test/fake-simctl.mjs plays from.
function world(t, extra = {}, file = path.join(tmp(t, 'simpool'), 'simctl.json')) {
  fs.writeFileSync(file, JSON.stringify({ runtimes: RUNTIMES, devices: [{ ...THEIRS }], log: [], ...extra }));
  return { home: path.join(path.dirname(file), 'home'), file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

// The in-process tests use the home and fake simctl helpers.mjs set up before src loaded.
const unit = world(shared(), {}, SIMCTL);
Object.assign(process.env, { DIBS_FAKE_MACHINE: JSON.stringify(BIG_MAC) });

const cfg = { ...DEFAULT_CONFIG, roomyMemFree: 101, resources: { ...DEFAULT_CONFIG.resources } };
const POOL = cfg.resources['sim-own'].pool;
const SPEC = { type: 'T17', runtime: 'R26', typeName: 'iPhone 17', runtimeName: 'iOS 26.5' };

test('new devices get the newest iOS runtime and an iPhone 17, unless the config names others', () => {
  const sp = spec(POOL, simctl());
  assert.equal(sp.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
  assert.equal(sp.type, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17');
  const old = spec({ ...POOL, runtime: 'iOS 18.6', deviceType: 'iPhone 16' }, simctl());
  assert.equal(old.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-18-6');
  assert.equal(old.type, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16');
});

test('new devices are named dibs-pool-N, and a free one goes back to the agent that used it last', () => {
  const s = { leases: [], queue: [] };
  const a = claim(s, { id: 1, who: 'ann' }, 'sim-own', SPEC);
  const b = claim(s, { id: 2, who: 'bob' }, 'sim-own', SPEC);
  assert.deepEqual([a.dev.name, b.dev.name, a.create, b.create], [`${PREFIX}1`, `${PREFIX}2`, true, true]);
  for (const d of s.pool) Object.assign(d, { lease: null, lastWho: d.who, lastUsed: d.name.endsWith('1') ? 1 : 2 });
  const again = claim(s, { id: 3, who: 'bob' }, 'sim-own', SPEC);
  assert.deepEqual([again.dev.name, again.create, again.erase], [`${PREFIX}2`, false, false]);
  const other = claim(s, { id: 4, who: 'cat' }, 'sim-own', SPEC);
  assert.deepEqual([other.dev.name, other.erase], [`${PREFIX}1`, true]);
  // Another device type or runtime never shares a device.
  assert.equal(claim(s, { id: 5, who: 'ann' }, 'sim-own', { ...SPEC, runtime: 'R18' }).dev.name, `${PREFIX}3`);
});

test('erase policy: always wipes any used device, never wipes none', () => {
  const used = () => ({ leases: [], queue: [], pool: [{ name: `${PREFIX}1`, udid: 'U', res: 'sim-own', type: 'T17', runtime: 'R26', lastWho: 'ann' }] });
  assert.equal(claim(used(), { id: 1, who: 'ann' }, 'sim-own', SPEC, 'always').erase, true);
  assert.equal(claim(used(), { id: 1, who: 'bob' }, 'sim-own', SPEC, 'never').erase, false);
  assert.equal(claim(used(), { id: 1, who: 'ann' }, 'sim-own', SPEC, 'other-agent').erase, false);
});

test('free memory decides how many simulators boot, counting ones still booting', () => {
  const m = { ...BIG_MAC, memFree: 40 };   // 6.4G free, 2.4G kept free, 2G each
  const s = { leases: [{ id: 9, res: ['test'] }], queue: [], pool: [] };
  assert.equal(poolRoom(s, cfg, 'sim-own', m).fits, 2);
  s.pool.push({ res: 'sim-own', lease: 9, booted: false });
  assert.equal(poolRoom(s, cfg, 'sim-own', m).fits, 1);
  s.pool.push({ res: 'sim-own', lease: 10, booted: false });
  const me = { res: ['sim-own'] };
  assert.equal(poolBlock(s, me, cfg, new Set(), m).rule, 'ram');
  assert.equal(poolBlock(s, me, cfg, new Set(['sim-own']), m), null, 'your own hold covers you');
  assert.equal(poolBlock({ ...s, leases: [] }, me, cfg, new Set(), m), null, 'nothing running: nothing to wait for');
  assert.equal(poolBlock(s, { res: ['test'] }, cfg, new Set(), m), null);
});

test("a sim-own run waits when free memory can't fit another simulator", () => {
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...BIG_MAC, memFree: 20 });
  try {
    const s = { leases: [{ id: 1, res: ['test'], mem: G, cpu: 1, kind: 'run', pid: 1, who: 'x', start: Date.now(), key: 'k' }], queue: [] };
    const v = verdict(s, { id: 2, res: ['sim-own'], mem: G, cpu: 1, disk: 0, pid: 1, who: 'y', enq: Date.now(), key: 'k' }, cfg, []);
    assert.equal(v.ok, false);
    assert.equal(v.rule, 'ram');
    assert.match(v.why, /sim-own: .* another simulator needs 2\.0G/);
  } finally { process.env.DIBS_FAKE_MACHINE = JSON.stringify(BIG_MAC); }
});

test('--mem counts the job; the simulator is added on top', () => {
  assert.equal(simMem(cfg, ['sim-own']), 2 * G);
  assert.equal(simMem(cfg, ['test']), 0);
});

test('checkout creates and boots, checkin shuts down; the same agent gets the device back unwiped, another gets it wiped', async () => {
  const lease = (id, who) => withState(s => { const l = { id, res: ['sim-own'], who, kind: 'run', pid: process.pid, start: Date.now() }; s.leases.push(l); return l; });
  const drop = id => withState(s => { s.leases = s.leases.filter(l => l.id !== id); });
  const a = await checkout(lease(101, 'ann'), cfg);
  assert.equal(a.name, `${PREFIX}1`);
  assert.equal(unit.read().devices.find(d => d.udid === a.udid).state, 'Booted');
  checkin({ id: 101 }); drop(101);
  assert.equal(unit.read().devices.find(d => d.udid === a.udid).state, 'Shutdown');
  const again = await checkout(lease(102, 'ann'), cfg);
  checkin({ id: 102 }); drop(102);
  const other = await checkout(lease(103, 'bob'), cfg);
  checkin({ id: 103 }); drop(103);
  assert.equal(again.udid, a.udid);
  assert.equal(other.udid, a.udid);
  const log = unit.read().log;
  assert.equal(log.filter(l => l.startsWith('create')).length, 1, 'one device, reused');
  assert.deepEqual(log.filter(l => l.startsWith('erase')), [`erase ${a.udid}`], 'wiped once, for the other agent');
  assert.equal(unit.read().devices.find(d => d.udid === THEIRS.udid).state, 'Booted', "someone else's simulator is untouched");
});

test('a run under its own sim-own hold gets the held device, which stays booted after the run', async () => {
  const add = l => withState(s => { s.leases.push(l); return l; });
  const drop = (...ids) => withState(s => { s.leases = s.leases.filter(l => !ids.includes(l.id)); });
  const hold = add({ id: 201, res: ['sim-own'], who: 'ann', kind: 'hold', pid: process.pid, start: Date.now(), expires: Date.now() + 6e5 });
  try {
    const held = await checkout(hold, cfg);
    const run = add({ id: 202, res: ['sim-own'], who: 'ann', kind: 'run', pid: process.pid, spid: process.pid, covered: ['sim-own'], start: Date.now() });
    assert.deepEqual(await checkout(run, cfg), held);
    checkin(run); drop(202);
    assert.equal(unit.read().devices.find(d => d.udid === held.udid).state, 'Booted');
    checkin(hold);
    assert.equal(unit.read().devices.find(d => d.udid === held.udid).state, 'Shutdown');
  } finally { drop(201, 202); }
});

test('a device whose lease died is freed and shut down on the next state read', async () => {
  const udid = unit.read().devices.find(d => d.name === `${PREFIX}1`).udid;
  await simctl().boot(udid);
  withState(s => { s.pool.find(d => d.udid === udid).lease = 999; });   // lease 999 doesn't exist
  const d = withState(s => s.pool.find(x => x.udid === udid));
  assert.equal(d.lease, null);
  assert.equal(d.lastWho, d.who);
  assert.equal(unit.read().devices.find(x => x.udid === udid).state, 'Shutdown');
});

test('a state read leaves devices in use, and ones already shut down, alone', () => {
  let calls = 0;
  const ctl = { shutdownLater: () => calls++ };
  const s = { leases: [{ id: 1 }], pool: [{ name: 'a', udid: 'A', lease: 1, booted: true }, { name: 'b', udid: 'B', lease: null, booted: false }] };
  reapPool(s, ctl);
  assert.equal(calls, 0);
  assert.equal(s.pool[0].lease, 1);
});

// The real binary.
const opts = (w, agent) => ({ agent, env: { DIBS_FAKE_SIMCTL: w.file, DIBS_FAKE_MACHINE: JSON.stringify(BIG_MAC) } });
const sync = (w, agent, args) => dibs(w.home, args, opts(w, agent));
const bg = (t, w, agent, args) => spawnDibs(t, w.home, args, opts(w, agent));
const pool = w => JSON.parse(sync(w, 'viewer', ['sims', '--json']).out);
const held = w => JSON.parse(sync(w, 'viewer', ['--json']).out).held;

test('dibs run sim-own puts a private booted simulator in $SIM and shuts it down after', t => {
  const w = world(t);
  const r = sync(w, 'ann', ['run', 'sim-own', '--', 'sh', '-c', 'echo "$SIM $SIM_NAME"']);
  assert.equal(r.code, 0, r.err);
  const dev = w.read().devices.find(d => d.name === `${PREFIX}1`);
  assert.equal(r.out, `${dev.udid} ${PREFIX}1\n`);
  assert.equal(dev.state, 'Shutdown');
  assert.deepEqual(w.read().log.filter(l => !l.startsWith('shutdown')), [`create ${PREFIX}1`, `boot ${dev.udid}`]);
  const p = pool(w);
  assert.equal(p.devices[0].lastWho, 'ann');
  assert.equal(p.devices[0].lease, null);
});

test('two runs at once get two devices', async t => {
  const w = world(t);
  const dir = tmp(t);
  // Each says which device it got, then waits until both have one.
  const job = ['sh', '-c', `touch '${dir}'/$SIM_NAME; while [ ! -e '${dir}'/go ]; do sleep 0.05; done`];
  const runs = [bg(t, w, 'ann', ['run', 'sim-own', '--', ...job]), bg(t, w, 'bob', ['run', 'sim-own', '--', ...job])];
  await until(() => fs.readdirSync(dir).length === 2).catch(e => { throw new Error(`${e.message}\nann: ${runs[0].err}\nbob: ${runs[1].err}`); });
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${PREFIX}1`, `${PREFIX}2`]);
  fs.writeFileSync(path.join(dir, 'go'), '');
  assert.deepEqual(await Promise.all(runs.map(r => r.done)), [0, 0]);
});

test('--mem on a sim-own run adds the simulator to the memory handed out', async t => {
  const w = world(t);
  bg(t, w, 'ann', ['run', 'sim-own', '--mem', '1G', '--', 'sleep', '30']);
  await until(() => held(w).length === 1);
  assert.equal(held(w)[0].mem, 3 * G);
});

test('kill -9 on dibs: the next state read shuts its simulator down', async t => {
  const w = world(t);
  const p = bg(t, w, 'ann', ['run', 'sim-own', '--', 'sleep', '30']);
  await until(() => w.read().devices.some(d => d.name === `${PREFIX}1` && d.state === 'Booted'));
  process.kill(p.pid, 'SIGKILL');
  await p.done;
  assert.equal(pool(w).devices[0].lease, null);   // any state read
  await until(() => w.read().devices.find(d => d.name === `${PREFIX}1`).state === 'Shutdown');
  assert.equal(w.read().devices.find(d => d.udid === THEIRS.udid).state, 'Booted');
});

test('a simulator that will not boot: the command does not run and the lease is given back', t => {
  const w = world(t, { failBoot: true });
  const r = sync(w, 'ann', ['run', 'sim-own', '--', 'sh', '-c', 'echo ran']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /couldn't get dibs-pool-1 ready: Unable to boot device\. Your command did not run/);
  assert.equal(held(w).length, 0);
  assert.equal(pool(w).devices[0].lease, null);
});

test('a hold boots one device and says which; release shuts it down', t => {
  const w = world(t);
  const h = sync(w, 'ann', ['hold', 'sim-own', '--for', '5m']);
  assert.equal(h.code, 0, h.err);
  const dev = w.read().devices.find(d => d.name === `${PREFIX}1`);
  assert.match(h.out, new RegExp(`Your simulator: ${PREFIX}1, udid ${dev.udid}`));
  assert.equal(w.read().devices.find(d => d.udid === dev.udid).state, 'Booted');
  assert.equal(sync(w, 'ann', ['release', 'sim-own']).code, 0);
  assert.equal(w.read().devices.find(d => d.udid === dev.udid).state, 'Shutdown');
  assert.equal(pool(w).devices[0].lease, null);
});

test("sims prune deletes idle pool devices only, never anyone else's", async t => {
  const w = world(t);
  // A stray pool device this dibs made but the state file lost, one another dibs
  // on this Mac made (another DIBS_HOME), and one that only looks like a pool name.
  const raw = w.read();
  raw.devices.push({ udid: 'STRAY-1', name: `${PREFIX}7`, state: 'Shutdown', runtime: 'R', type: 'T', size: G });
  raw.devices.push({ udid: 'OTHER-1', name: `${PREFIX}8`, state: 'Booted', runtime: 'R', type: 'T', size: G });
  raw.devices.push({ udid: 'LOOKALIKE', name: 'dibs-poolside', state: 'Shutdown', runtime: 'R', type: 'T', size: G });
  fs.writeFileSync(w.file, JSON.stringify(raw));
  fs.mkdirSync(w.home, { recursive: true });
  fs.writeFileSync(path.join(w.home, 'pool-made'), 'STRAY-1\n');
  assert.equal(sync(w, 'ann', ['run', 'sim-own', '--', 'true']).code, 0);
  const busy = bg(t, w, 'bob', ['run', 'sim-own', '--', 'sleep', '30']);
  await until(() => pool(w).devices.some(d => d.lease));
  const list = sync(w, 'viewer', ['sims']).out;
  assert.match(list, /sim-own: 1 in use, at most \d at once/);
  assert.match(list, /dibs-pool-7 .* not tracked/);
  assert.match(list, /dibs-pool-8 .* not made by this dibs .*prune leaves it alone/);
  const r = sync(w, 'viewer', ['sims', 'prune']);
  assert.equal(r.code, 0, r.err);
  const names = w.read().devices.map(d => d.name).sort();
  assert.ok(!names.includes(`${PREFIX}7`));
  assert.ok(names.includes('iPhone 17 Pro') && names.includes('dibs-poolside'), 'devices dibs did not name stay');
  assert.ok(names.includes(`${PREFIX}8`), "another dibs's device stays");
  assert.equal(names.filter(n => n.startsWith(PREFIX)).length, 2, 'the busy one stays, with the other dibs\'s');
  assert.match(r.out, /kept dibs-pool-\d: in use/);
  busy.kill('SIGTERM');
  await busy.done;
});

test("a fresh dibs never takes over another dibs's pool device of the same name", t => {
  const w = world(t);
  const raw = w.read();
  const type = RUNTIMES[1].supportedDeviceTypes[1].identifier;
  raw.devices.push({ udid: 'OTHER-1', name: `${PREFIX}1`, state: 'Booted', runtime: RUNTIMES[1].identifier, type, size: G });
  fs.writeFileSync(w.file, JSON.stringify(raw));
  const r = sync(w, 'ann', ['run', 'sim-own', '--', 'sh', '-c', 'echo "$SIM"']);
  assert.equal(r.code, 0, r.err);
  assert.notEqual(r.out.trim(), 'OTHER-1');
  assert.ok(!w.read().log.some(l => l.includes('OTHER-1')), 'the other dibs\'s device was never touched');
  assert.equal(w.read().devices.find(d => d.udid === 'OTHER-1').state, 'Booted');
});
