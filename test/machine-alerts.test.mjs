// What the throttle watcher tells the person about the machine itself: cores
// that stopped taking work (and it stops lowering processes then), processes
// left running with their script gone; and the coordinator's listen failures
// said once, not every 30 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync } from './helpers.mjs';
import { coresStuck, orphans, scriptOf } from '../src/cool.mjs';
import { detect, CPU_FILE } from '../src/alerts.mjs';
import { duration } from '../src/platform.mjs';
import { oncePerChange } from '../src/serve.mjs';

const H = 36e5;
const st = () => ({ waits: {}, ended: [], svc: {}, restarts: [], hook: [], seen: {}, open: {} });
const machineAlerts = t => detect({ s: { leases: [], queue: [] }, cfg: {}, hist: [], m: { diskFree: 1e12 }, t, st: st() }).filter(a => a.cause === 'machine');

test('cores look stuck when the load is far past them while much of the CPU sits idle, and not when the load is only high', () => {
  // 2026-11-10: load 127 to 400 on 10 cores, a flat 40% idle.
  assert.equal(coresStuck({ load: 127, cores: 10, busy: 6 }), true);
  assert.equal(coresStuck({ load: 400, cores: 10, busy: 6 }), true);
  // Busy and loaded: every core working, the load is real.
  assert.equal(coresStuck({ load: 60, cores: 10, busy: 9.8 }), false);
  // Idle cores with a load a busy machine sees every day.
  assert.equal(coresStuck({ load: 20, cores: 10, busy: 4 }), false);
  // No reading of cores in use: nothing to say.
  assert.equal(coresStuck({ load: 400, cores: 10, busy: null }), false);
});

test('an orphan: a build or test tool outside dibs, running for hours, whose script is gone; never a leased one or a live script', () => {
  const procs = [
    { pid: 52035, pgid: 52035, args: 'node /private/tmp/claude-503/x/scratchpad/testfast.mjs --all', cpu: 99 },
    { pid: 52036, pgid: 52036, args: 'node /Users/me/app/server.mjs', cpu: 99 },
    { pid: 52037, pgid: 777, args: 'node /private/tmp/gone/run.mjs', cpu: 99 },
    { pid: 52038, pgid: 52038, args: 'node /private/tmp/gone/young.mjs', cpu: 99 },
    { pid: 52039, pgid: 52039, args: 'Safari /private/tmp/gone/page.js', cpu: 99 },
  ];
  const ages = new Map([[52035, { age: 23 * H, cpu: 17 * H }], [52036, { age: 23 * H, cpu: H }], [52037, { age: 23 * H, cpu: H }], [52038, { age: H, cpu: H }], [52039, { age: 23 * H, cpu: H }]]);
  const gone = f => f.includes('/tmp/');
  const found = orphans(procs, new Set([777]), ages, gone);
  assert.deepEqual(found.map(o => o.pid), [52035]);
  assert.equal(found[0].script, '/private/tmp/claude-503/x/scratchpad/testfast.mjs');
  assert.equal(scriptOf('python3 -u /a/b/train.py --x'), '/a/b/train.py');
  assert.equal(scriptOf('node --max-old-space-size=4096'), null);
});

test('ps run and CPU times read as milliseconds', () => {
  assert.equal(duration('23:04:05'), (23 * 3600 + 4 * 60 + 5) * 1000);
  assert.equal(duration('1-00:00:01'), 86401000);
  assert.equal(duration('17:03.21'), (17 * 60 + 3) * 1000 + 210);
  assert.equal(duration('1023:00:00.00'), 1023 * 3600 * 1000);
  assert.equal(duration('garbage'), null);
});

test('the watcher\'s notes become alerts: restart for stuck cores, the orphan by pid; none from a watcher that stopped, or while swapping', t => {
  t.after(() => fs.rmSync(CPU_FILE, { force: true }));
  const now = Date.now();
  const orphan = { pid: 52035, name: 'node', script: '/tmp/x/testfast.mjs', age: 23 * H, cpu: 17 * H };
  fs.writeFileSync(CPU_FILE, JSON.stringify({ at: now, stuckSince: now - 6e5, load: 400, idle: 40, cores: 10, swapping: false, orphans: [orphan] }));
  const list = machineAlerts(now);
  const cores = list.find(a => a.id === 'cores');
  assert.ok(cores, JSON.stringify(list));
  assert.match(cores.title, /load is 400 on 10 cores while 40% of the CPU sits idle/);
  assert.match(cores.fix, /^Restart the Mac/);
  assert.equal(cores.at, now - 6e5);
  assert.ok(cores.after >= 6e4, 'a passing spike is no alert');
  const o = list.find(a => a.id === 'orphan:52035');
  assert.match(o.title, /node 52035 has run 23 hours outside dibs, using 17 CPU-hours, and its script \/tmp\/x\/testfast.mjs is gone/);
  assert.match(o.fix, /kill 52035/);

  fs.writeFileSync(CPU_FILE, JSON.stringify({ at: now, stuckSince: now - 6e5, load: 400, idle: 40, cores: 10, swapping: true, orphans: [] }));
  assert.deepEqual(machineAlerts(now), [], 'a swapping machine reads the same way, and a restart is not its fix');
  fs.writeFileSync(CPU_FILE, JSON.stringify({ at: now - 10 * 6e4, stuckSince: now - 20 * 6e4, load: 400, idle: 40, cores: 10, orphans: [orphan] }));
  assert.deepEqual(machineAlerts(now), []);
});

test('a listen that fails every 30 s is logged once, again when the failure changes, and again after it worked', () => {
  const lines = [];
  const failed = oncePerChange(l => lines.push(l));
  for (let i = 0; i < 5; i++) failed('100.64.0.10', "can't listen on 100.64.0.10:7420: listen EADDRNOTAVAIL");
  assert.equal(lines.length, 1);
  failed('100.64.0.10', "can't listen on 100.64.0.10:7420: listen EADDRINUSE");
  assert.equal(lines.length, 2);
  failed('100.64.0.10', null);
  failed('100.64.0.10', "can't listen on 100.64.0.10:7420: listen EADDRINUSE");
  assert.equal(lines.length, 3);
});

test('the board scans for alerts only when nobody has for a minute: the throttle watcher keeps them fresh, and a scan reads launchd and top', t => {
  const h = tmp(t);
  const file = path.join(h, 'alerts.json');
  const at = () => JSON.parse(fs.readFileSync(file, 'utf8')).at;
  const recent = Date.now() - 20e3;
  fs.writeFileSync(file, JSON.stringify({ at: recent }));
  assert.equal(sync(h, []).code, 0);
  assert.equal(at(), recent, 'scanned 20 s ago: the board reads the list as it is');
  const old = Date.now() - 70e3;
  fs.writeFileSync(file, JSON.stringify({ at: old }));
  assert.equal(sync(h, []).code, 0);
  assert.ok(at() > old, 'a minute without a scan: the board scans');
});

test('the guard service logs to its own file, not the hook\'s error log the alerts read', { skip: process.platform !== 'darwin' }, t => {
  const h = tmp(t), agents = tmp(t, 'agents'), bin = tmp(t, 'fakebin');
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\n[ "$1" = print ] && exit 1\nexit 0\n', { mode: 0o755 });
  assert.equal(sync(h, ['service', 'install', 'guard'], { env: { DIBS_LAUNCHCTL: path.join(bin, 'launchctl'), DIBS_LAUNCH_AGENTS: agents } }).code, 0);
  const plist = fs.readFileSync(path.join(agents, 'dev.dibs.guard.plist'), 'utf8');
  assert.match(plist, /<key>StandardOutPath<\/key><string>[^<]*\/guard-service\.log<\/string>/);
  assert.doesNotMatch(plist, /\/guard\.log</);
});
