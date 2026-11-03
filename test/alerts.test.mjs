// Alerts: what earns one, that each shows once and closes with when, and that
// the board, `dibs alerts` and the page all carry them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, G, MACHINE, tmp, sync } from './helpers.mjs';
import { detect, merge, memoryUsers, scan, FILE } from '../src/alerts.mjs';
import { loadConfig } from '../src/config.mjs';

const MIN = 6e4;
const T = 2e12;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ minDisk: '5G', resources: { test: { slots: 1, mem: '1G', cpu: 1 }, deploy: { slots: 1, mem: '1G', cpu: 1 } } }));
const cfg = loadConfig();
const blank = () => ({ seen: {}, open: {}, resolved: [], dismissed: {}, waits: {}, ended: [], svc: {}, restarts: [], hook: [] });
const lease = (id, o = {}) => ({ id, kind: 'run', res: ['test'], who: 'web-app', pid: 4242, pgid: 4242, cmd: 'npm test', purpose: 'unit tests', start: T - 50 * MIN, mem: G, cpu: 1, ...o });
const waiter = (id, o = {}) => ({ id, kind: 'run', res: ['test'], who: 'api', pid: 999, cmd: 'npm test', mem: G, cpu: 1, enq: T - 15 * MIN, ...o });
const find = (list, id) => list.find(a => a.id === id);

test('a job waiting past 10 minutes and three times its usual wait is an alert naming what holds it and the fix', () => {
  const s = { leases: [lease(1)], queue: [waiter(2)] };
  const a = find(detect({ s, cfg, hist: [], m: MACHINE, t: T, st: blank() }), 'wait:#2');
  assert.ok(a, 'waited 15 min, usually nothing');
  assert.equal(a.level, 'warn', 'nobody is waiting on it in person');
  assert.match(a.title, /^api's #2 \(npm test\) has waited 15 min/);
  assert.match(a.fix, /web-app's #1 \(unit tests\) has held test for 50 min\. If api's job can't wait, dibs boost 2 urgent/);
  const usual = { ...blank(), waits: { test: [6 * MIN, 6 * MIN, 6 * MIN] } };
  assert.ok(!find(detect({ s, cfg, hist: [], m: MACHINE, t: T, st: usual }), 'wait:#2'), 'test usually takes 6 min, so 15 is under three times that');
  const due = { leases: [lease(1)], queue: [waiter(2, { prio: 'high' })] };
  assert.equal(find(detect({ s: due, cfg, hist: [], m: MACHINE, t: T, st: blank() }), 'wait:#2').level, 'urgent', 'a person waits on a high job');
});

test("with a deploy per project, the fix names the deploy of this job's own project", () => {
  const s = { leases: [lease(1, { res: ['deploy'], repo: 'web', who: 'web-app' }), lease(3, { res: ['deploy'], repo: 'ios', who: 'ios', purpose: 'ship 142' })],
    queue: [waiter(2, { res: ['deploy'], repo: 'ios' })] };
  assert.match(find(detect({ s, cfg, hist: [], m: MACHINE, t: T, st: blank() }), 'wait:#2').fix, /^ios's #3 \(ship 142\) has held deploy/);
});

test("a job behind one that's done nothing for 20 minutes gets the stop command, and the idle job its own alert", () => {
  const s = { leases: [lease(1, { idleSince: T - 40 * MIN })], queue: [waiter(2, { prio: 'urgent' })] };
  const found = detect({ s, cfg, hist: [], m: MACHINE, t: T, st: blank() });
  assert.match(find(found, 'wait:#2').fix, /dibs stop 1 --owner web-app/);
  const idle = find(found, 'idle:#1');
  assert.equal(idle.level, 'urgent', 'an urgent job waits behind it');
  assert.match(idle.title, /held test for 50 min and used no CPU for 40 min, while 1 job waits/);
  assert.ok(!find(detect({ s: { ...s, queue: [] }, cfg, hist: [], m: MACHINE, t: T, st: blank() }), 'idle:#1'), 'nobody waits: nothing to say');
});

test('memory holding jobs back for 10 minutes names the top memory users, apps dibs did not start included', () => {
  // Something already runs, and memory pressure is critical: the waiter is held by it (src/schedule.mjs swapping).
  const s = { leases: [lease(1, { res: ['deploy'] })], queue: [waiter(2)] };
  const tight = { ...MACHINE, memFree: 3, vmPressure: 2 };
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify(tight);
  const users = [{ name: 'Safari and other web pages', bytes: 3.2 * G, n: 14, dibs: false }, { name: 'dibs job #9 (ios)', bytes: 2 * G, n: 3, dibs: true, id: 9 }, { name: 'Google Chrome', bytes: 1.5 * G, n: 6, dibs: false }];
  const a = find(detect({ s, cfg, hist: [], m: tight, t: T, st: blank(), users }), 'memory');
  if (was == null) delete process.env.DIBS_FAKE_MACHINE; else process.env.DIBS_FAKE_MACHINE = was;
  assert.ok(a, 'the waiter is held by memory');
  assert.equal(a.after, 10 * MIN, 'only once it has lasted ten minutes');
  assert.match(a.detail, /Safari and other web pages \(3\.2 GB, 14 pages\), dibs job #9 \(ios\) \(2\.0 GB\), Google Chrome \(1\.5 GB\)/);
  assert.match(a.fix, /^Close what you can of Safari and other web pages \(3\.2 GB, 14 pages\) and Google Chrome \(1\.5 GB\)\. dibs won't close apps it didn't start\. Or stop a dibs job: dibs stop 9\./);
  const st = blank();
  merge(st, [a], T);
  assert.deepEqual(Object.keys(st.open), [], 'not yet: it has only just started');
  merge(st, [a], T + 11 * MIN);
  assert.equal(st.open.memory.since, T, 'open, dated from when it started');
});

test('memory users are grouped the way a person closes them: an app with its helpers, Safari pages, a dibs job', () => {
  const procs = [
    { pid: 1, ppid: 0, pgid: 1, cpu: 0, args: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { pid: 2, ppid: 1, pgid: 1, cpu: 0, args: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper' },
    { pid: 3, ppid: 0, pgid: 3, cpu: 0, args: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent' },
    { pid: 4, ppid: 0, pgid: 4, cpu: 0, args: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent' },
    { pid: 5, ppid: 0, pgid: 5, cpu: 0, args: 'node build.js' },
  ];
  const use = new Map([[1, G], [2, 2 * G], [3, G], [4, 0.5 * G], [5, 4 * G]]);
  const s = { leases: [lease(9, { pgid: 5, who: 'ios' })] };
  assert.deepEqual(memoryUsers(s, procs, use).map(g => [g.name, g.bytes / G, g.n]),
    [['dibs job #9 (ios)', 4, 1], ['Google Chrome', 3, 2], ['Safari and other web pages', 1.5, 2]]);
});

test('an alert shows once, keeps when it started, and says when it resolved', () => {
  const st = blank();
  const a = { id: 'disk', cause: 'disk', level: 'urgent', title: 'Free disk is low', fix: 'Free disk' };
  merge(st, [a], T);
  merge(st, [a], T + MIN);
  assert.equal(Object.keys(st.open).length, 1);
  assert.equal(st.open.disk.since, T);
  merge(st, [], T + 5 * MIN);
  assert.deepEqual(st.open, {});
  assert.equal(st.resolved[0].resolvedAt, T + 5 * MIN);
  assert.equal(st.resolved[0].since, T);
});

test('disk under the floor and a service that is down are urgent, each with what fixes it', () => {
  const st = { ...blank(), svc: { throttle: { what: 'moves hot work outside dibs to background priority', running: false, runs: 3, exit: 78 } } };
  const found = detect({ s: { leases: [], queue: [] }, cfg, hist: [], m: { ...MACHINE, diskFree: 2 * G }, t: T, st });
  assert.match(find(found, 'disk').title, /^Free disk is 2\.0 GB, under the 5\.0 GB dibs keeps free, so no new job starts/);
  const svc = find(found, 'service:throttle');
  assert.equal(svc.level, 'urgent');
  assert.match(svc.title, /throttle service isn't running \(it last exited with code 78\)/);
  assert.equal(svc.fix, 'Start it again: dibs service install throttle. Why it stopped is in ~/.dibs/throttle.log.');
});

test('a failed job, a stopped one and a lost one reach the person; a later pass of the same command closes the failure', t => {
  const home = tmp(t, 'ended');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ minDisk: '0' }));
  const ev = [
    { at: T - 9 * MIN, kind: 'end', type: 'run', id: 5, who: 'web-app', res: ['test'], key: 'k1', cmd: 'npm test', code: 1 },
    { at: T - 8 * MIN, kind: 'end', type: 'run', id: 6, who: 'web-app', res: ['test'], key: 'k1', cmd: 'npm test', code: 1 },
    { at: T - 7 * MIN, kind: 'override', act: 'stop', id: 7, by: 'the person' },
    { at: T - 7 * MIN, kind: 'end', type: 'run', id: 7, who: 'ios', res: ['deploy'], key: 'k2', cmd: './ship.sh', code: null },
    { at: T - 6 * MIN, kind: 'lost', code: 76, verb: 'run', who: 'api', cmd: 'run --on boat-1 test -- npm test', why: "can't reach the coordinator" },
  ];
  fs.writeFileSync(path.join(home, 'events.jsonl'), ev.map(e => JSON.stringify(e)).join('\n') + '\n');
  const list = JSON.parse(sync(home, ['alerts', '--json']).out);
  const failed = list.find(a => a.id.startsWith('failed:'));
  assert.match(failed.title, /^web-app's npm test failed 2 times, last at .* \(exit 1\)$/);
  assert.match(list.find(a => a.id === 'stopped:#7').title, /^ios's #7 \(\.\/ship\.sh\) was stopped by the person/);
  const lost = list.find(a => a.id.startsWith('lost:'));
  assert.equal(lost.level, 'urgent');
  assert.match(lost.fix, /never ran, so it's safe to run again/);
  fs.appendFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ at: T - MIN, kind: 'end', type: 'run', id: 8, who: 'web-app', res: ['test'], key: 'k1', cmd: 'npm test', code: 0 }) + '\n');
  const after = JSON.parse(sync(home, ['alerts', '--json']).out);
  assert.ok(after.find(a => a.id === failed.id).resolvedAt, 'the same command passed');
  assert.match(sync(home, ['alerts']).out, /Resolved at .*: web-app's npm test failed 2 times/);
});

test("a crash of dibs itself and a job lost on its way to another machine go in the event log", t => {
  const home = tmp(t, 'lost');
  // No coordinator at this address: the job is lost before it starts (76).
  fs.writeFileSync(path.join(home, 'remote.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'x', name: 'here' }));
  const r = sync(home, ['run', '--on', 'elsewhere', 'test', '--', 'true']);
  assert.equal(r.code, 76, r.err);
  const lines = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const lost = lines.find(e => e.kind === 'lost');
  assert.equal(lost.code, 76);
  assert.match(lost.why, /can't reach the coordinator/);
  assert.match(JSON.parse(sync(home, ['alerts', '--json']).out).find(a => a.id.startsWith('lost:')).title, /was lost before it started/);
});

test("the board and the page's board carry the alerts; dismissing one closes it for a day", t => {
  const home = tmp(t, 'board');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ minDisk: '5G' }));
  const low = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree: 2 * G }) } };
  const b = JSON.parse(sync(home, ['--json'], low).out);
  assert.equal(b.alerts.find(a => a.id === 'disk').level, 'urgent');
  assert.match(sync(home, [], low).out, /Free disk is 2\.0 GB.*\n\s+Fix: Free disk/);
  assert.match(sync(home, ['alerts', 'dismiss', 'disk'], low).out, /Dismissed disk for a day/);
  const st = JSON.parse(fs.readFileSync(path.join(home, path.basename(FILE)), 'utf8'));
  assert.deepEqual(st.open, {});
  assert.ok(st.resolved.find(a => a.id === 'disk' && a.dismissed));
  assert.ok(!JSON.parse(sync(home, ['alerts', '--json'], low).out).some(a => a.id === 'disk' && !a.resolvedAt), 'stays closed while dismissed');
});

test('a scan that fails says so instead of showing nothing', async () => {
  const list = scan({ s: null, cfg, hist: [], m: MACHINE, t: T, force: true });
  assert.equal(list[0].id, 'alerts');
  assert.match(list[0].title, /^dibs couldn't check for problems/);
});

test("dibs's own trouble is loud: a service launchd had to restart, the hook failing, a crash", () => {
  const st = { ...blank(),
    restarts: [{ k: 'serve', at: T - 20 * MIN, exit: 1, runs: 1 }, { k: 'serve', at: T - 5 * MIN, exit: 1, runs: 1 }],
    hook: [{ at: T - 30 * MIN, msg: 'Maximum call stack size exceeded' }, { at: T - 2 * MIN, msg: 'Maximum call stack size exceeded' }],
    ended: [{ kind: 'crash', at: T - MIN, who: 'web-app', verb: 'run', code: 70, why: 'dibs itself crashed' }] };
  const found = detect({ s: { leases: [], queue: [] }, cfg, hist: [], m: MACHINE, t: T, st });
  assert.match(find(found, 'restart:serve').title, /serve service crashed \(exit 1\) and launchd started it again, 2 times in the last hour/);
  const hook = find(found, 'hook');
  assert.match(hook.title, /^The Claude Code hook failed 2 times in the last hour, last at .*: Maximum call stack size exceeded$/);
  assert.match(hook.fix, /^Those tool calls ran without dibs's checks\./);
  assert.match(find(found, `crash:${T - MIN}`).title, /^dibs crashed at .* running dibs run for web-app$/);
});
