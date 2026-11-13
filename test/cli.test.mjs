// The real binary, with real processes, in a throwaway state directory:
// arguments, holds, and the commands that answer questions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmp, sync as dibs, bg, until, board, allLow, BIN, MACHINE, G, env, posixOnly } from './helpers.mjs';
import { freeDisk } from '../src/platform.mjs';
import { VERSION } from '../src/version.mjs';

const sync = (h, agent, args, opts) => dibs(h, args, { agent, ...opts });

test('runs the command and passes its exit code and output through', t => {
  const h = tmp(t);
  assert.equal(sync(h, 'a', ['t', '--', 'sh', '-c', 'exit 3']).code, 3);
  const r = sync(h, 'a', ['t', '--', 'echo', 'hi']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'hi\n');
});

// [args, what dibs says]. Each one exits 2 and never runs `echo ran`.
const BAD_USAGE = [
  [['--', 'echo', 'ran'], /which resource\? Name it before the --, like dibs run sim -- <command>/],
  [['run', 't'], /nothing to run: put the command after --, like dibs run sim -- \.\/ui-test\.sh/],
  [['t', '--frobnicate', '--', 'echo', 'ran'], /unknown flag --frobnicate\. Every flag: dibs help all/],
  [['t', '-m', '--', 'echo', 'ran'], /-m needs a value/],
  [['t', '--mem', '4X', '--', 'echo', 'ran'], /can't read size "4X" \(try 4G or 500M\)/],
  [['t', '--cpu', 'x', '--', 'echo', 'ran'], /--cpu takes a number of cores/],
  [['t', '--max-wait', 'soon', '--', 'echo', 'ran'], /can't read duration "soon"/],
  [['t', '--by', '25:00', '--', 'echo', 'ran'], /can't read time "25:00"/],
  [['t', '-p', '6', '--', 'echo', 'ran'], /priority is one of urgent, high, normal, low, idle \(or 1-5\)/],
  [['t', '-p', 'high', '--', 'echo', 'ran'], /high priority needs a reason everyone can see: -m "why"/],
  [['t', '-p', 'urgent', '--', 'echo', 'ran'], /urgent priority needs a reason everyone can see/],
  [['run', 't', '--bring', 'out', '--', 'echo', 'ran'], /--bring only means something with --anywhere or --on/],
  [['serve', '--listen', '0'], /--listen takes a port number/],
  [['serve', '--listen', '70000'], /--listen takes a port number/],
  [['limit', 'beta', '--only', ','], /--only takes resource names, e\.g\. --only test,heavy/],
  [['when'], /when for what\? dibs when sim/],
  [['yield'], /who should go first\?/],
  [['ask'], /ask what\?/],
];

test('bad usage exits 2, says what was wrong, and runs nothing', t => {
  const h = tmp(t);
  for (const [args, msg] of BAD_USAGE) {
    const r = sync(h, 'a', args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, msg, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  }
  assert.equal(board(h).held.length + board(h).waiting.length, 0);
});

test('priority 5 is idle, and a priority with its reason runs', t => {
  const h = tmp(t);
  // A hold, not a run: an idle run's command is lowered to background QoS, which macOS runs
  // only when the cores have time left over. At load 35 on 10 cores (2026-11-03) a shell
  // loop of 0.08 s took 13.6 s that way, and the idle echo went past the 60 s spawn limit.
  const idle = sync(h, 'a', ['hold', 't', '-p', '5', '--for', '1m']);
  assert.equal(idle.code, 0, idle.err);
  assert.equal(board(h).held[0].prio, 'idle');
  assert.equal(sync(h, 'a', ['release', 't']).code, 0);
  assert.equal(sync(h, 'a', ['t', '-p', 'high', '-m', 'release blocker', '--', 'echo', 'high']).out, 'high\n');
});

test('a command that does not exist exits 127, at any priority', t => {
  const h = tmp(t);
  const r = sync(h, 'a', ['t', '--', '/no/such/bin']);
  assert.equal(r.code, 127);
  assert.match(r.err, /couldn't start \/no\/such\/bin: it isn't on your PATH\. Nothing ran \(exit 127\)/);
  assert.equal(sync(h, 'a', ['t', '-p', 'low', '--', '/no/such/bin']).code, 127);
  assert.equal(sync(h, 'a', ['t', '-p', 'idle', '--', 'no-such-command-xyz']).code, 127);
  assert.equal(board(h).held.length, 0);
});

test('flags before the resource still run the command', t => {
  const r = sync(tmp(t), 'a', ['-m', 'why', 't', '--', 'echo', 'ran']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'ran\n');
});

// At background priority a busy machine can leave the job without a core for a minute and more
// (2026-11-01, an Xcode build alongside the suite): seen lowered, it's boosted to finish.
test('low priority runs the command at background priority and still passes its output and code through', { skip: posixOnly('the test reads priorities by process group with ps -g') }, async t => {
  const h = tmp(t);
  const gate = path.join(h, 'gate');
  const p = bg(t, h, ['t', '-p', 'low', '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done; echo low; exit 4`], { agent: 'a' });
  await until(() => { const l = board(h).held[0]; return l?.pgid && allLow(l.pgid); });
  const { id } = board(h).held[0];
  assert.equal(sync(h, 'a', ['boost', String(id), 'normal']).code, 0);
  fs.writeFileSync(gate, '');
  assert.equal(await p.done, 4, p.err);
  assert.equal(p.out, 'low\n');
});

test('hold, hold again to extend, release; old names still work', t => {
  const h = tmp(t);
  assert.match(sync(h, 'a', ['hold', 't', '--for', '2m', '-m', 'tour']).out, /^Reserved for you until .*: t\./);
  assert.equal(board(h).held[0].purpose, 'tour');
  assert.match(sync(h, 'a', ['hold', 't', '--for', '10m']).out, /You still have t, now until/);
  assert.equal(board(h).held.length, 1);
  assert.match(sync(h, 'a', ['renew', 't']).out, /You still have t/);
  assert.equal(sync(h, 'a', ['mine', 't']).code, 0);
  assert.equal(sync(h, 'b', ['mine', 't']).code, 1);
  assert.equal(sync(h, 'b', ['release', 't']).code, 1, "someone else's hold isn't yours to release");
  assert.equal(board(h).held.length, 1);
  assert.match(sync(h, 'a', ['release', 't']).out, /^Gave back t after/);
  assert.equal(sync(h, 'a', ['done', 't']).code, 1);
  assert.equal(sync(h, 'a', ['mine']).code, 1);
});

test('holding again without --for never shortens a hold', t => {
  const h = tmp(t);
  sync(h, 'a', ['hold', 'u', '--for', '50m']);
  sync(h, 'a', ['hold', 'u']);
  assert.ok(board(h).held[0].expires - Date.now() > 45 * 6e4);
});

test('with someone waiting, a hold extends 10 minutes at a time', async t => {
  const h = tmp(t);
  assert.equal(sync(h, 'a', ['hold', 't', '--for', '5m']).code, 0);
  const w = bg(t, h, ['run', 't', '--', 'true'], { agent: 'b' });
  await until(() => board(h).waiting.length === 1);
  const r = sync(h, 'a', ['hold', 't', '--for', '30m']);
  assert.match(r.out, /b is waiting for it, so more time comes 10 minutes at a time\. Give it back the moment you're done: dibs release t/);
  const left = board(h).held[0].expires - Date.now();
  assert.ok(left <= 10 * 6e4 && left > 9 * 6e4, `${left}ms left`);
  sync(h, 'a', ['release', 't']);
  assert.equal(await w.done, 0);
});

test('outside an agent session, hold and release from the same folder match', t => {
  const h = tmp(t);
  const opts = { cwd: h, env: { DIBS_AGENT: undefined } };
  assert.equal(dibs(h, ['hold', 't', '--for', '5m'], opts).code, 0);
  const r = dibs(h, ['release', 't'], opts);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Gave back t/);
});

test('when, who and why answer without joining the line', async t => {
  const h = tmp(t);
  assert.match(sync(h, 'a', ['when', 't']).out, /^Free now: t\. Take it: dibs run t -- <command>/);
  bg(t, h, ['run', 't', '-m', 'long one', '--', 'sleep', '120'], { agent: 'a' });
  await until(() => board(h).held.length === 1);
  const w = JSON.parse(sync(h, 'b', ['when', 't', '--json']).out);
  assert.equal(w.freeNow, false);
  assert.equal(w.blockedBy, 'slot');
  assert.match(sync(h, 'b', ['who', 't']).out, /^t {3}a is using it, time left unknown\n {4}Nobody waiting\n {4}a: "long one", running sleep 120/);
  assert.match(sync(h, 'b', ['when', 't']).out, /^You'd be next in the t queue, as soon as a finishes\.\n  You'd wait for a's long one to finish\.\nTo join the queue: dibs run t -- <command>\n$/);
  assert.equal(board(h).waiting.length, 0, 'asking put nobody in line');
  bg(t, h, ['run', 't', '--', 'true'], { agent: 'b' });
  await until(() => board(h).waiting.length === 1);
  const y = sync(h, 'b', ['why', '--detail']).out;
  assert.match(y, /blocked by slot/);
  assert.match(y, /place in the queue: arrived/);
  assert.match(sync(h, 'c', ['why']).out, /not waiting/);
});

test('ask records a request, answers from the docs it can, and points at a maintainer only where there is one', t => {
  const h = tmp(t);
  const stranger = sync(h, 'a', ['ask', 'what', 'does', 'exit', '74', 'mean']).out;
  assert.match(stranger, /^From the docs:\n[\s\S]*(docs\/reference\.md|skills\/dibs\/SKILL\.md) \(Exit codes\):\n {4}\| 74 \| this run can't fit on this disk/, 'the table row that answers it, not the table\'s start');
  assert.match(stranger, /If that doesn't answer it, or it's a bug, open an issue: https:\/\/github\.com\/dibssoftware\/dibs\/issues$/m);
  assert.doesNotMatch(stranger, /SendMessage|maintainer/, 'nobody maintains dibs on this machine');
  assert.match(sync(h, 'a', ['ask', 'please', 'add', 'gpu']).out, /^Nothing in the docs matched\. If it's a bug or something dibs should do, open an issue: https:/);
  assert.match(sync(h, 'z', ['requests']).out, /a: please add gpu/);

  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ maintainer: 'dibs-keeper' }));
  assert.match(sync(h, 'a', ['ask', 'please', 'add', 'gpu']).out, /^Noted for the dibs maintainer, dibs-keeper\.$/m, 'no SendMessage outside Claude Code');
  assert.match(sync(h, 'a', ['ask', 'please', 'add', 'gpu'], { env: { CLAUDECODE: '1' } }).out, /^Noted for the dibs maintainer, dibs-keeper\. For a faster answer, SendMessage dibs-keeper\.$/m);
});

test('--port puts distinct free ports in the environment', t => {
  const r = sync(tmp(t), 'a', ['t', '--port', 'WEB', '--port', 'API', '--', 'sh', '-c', 'echo $WEB $API']);
  const [web, api] = r.out.trim().split(' ').map(Number);
  assert.ok(web > 1024 && api > 1024 && web !== api, r.out);
});

test('dibs inside a dibs run that has the resource goes straight ahead', t => {
  const h = tmp(t);
  const r = sync(h, 'a', ['run', 't', '--max-wait', '5s', '--', process.execPath, BIN, 'run', 't', '--max-wait', '5s', '--', 'echo', 'nested']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'nested\n');
  const p = sync(h, 'a', ['run', 't', '--port', 'WEB', '--', process.execPath, BIN, 'run', 't', '--port', 'API', '--', 'sh', '-c', 'echo $WEB $API']);
  assert.match(p.out, /^\d+ \d+\n$/, p.err);
});

// Since 0.0.180 low disk is waited out (test/diskfloor.test.mjs); a run that doesn't wait still says why it didn't run.
test('not enough disk with --no-wait exits 74 and runs nothing', t => {
  const r = sync(tmp(t), 'a', ['sim', '--no-wait', '--', 'echo', 'ran'], { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree: 1e9 }) } });
  assert.equal(r.code, 74);
  assert.equal(r.out, '');
  assert.match(r.err, /not enough free disk: 0\.9 GB free, it needs 8\.0 GB\. Your command did NOT run \(exit 74\)\. Free some space, or pass --disk with what this job really needs if that's less, then run it again:\n {6}dibs sim --no-wait -- echo ran/);
  assert.match(r.err, /\n {6}Never delete in another session's \/private\/tmp\/claude-\* folder to make room: they're off limits\.$/m, 'and never by deleting other sessions\' temp folders');
});

test('an unreadable state file is saved aside and replaced', t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'state.json'), '{not json');
  const r = sync(h, 'a', ['t', '--', 'true']);
  assert.equal(r.code, 0);
  assert.match(r.err, /unreadable/);
  assert.equal(fs.readFileSync(path.join(h, fs.readdirSync(h).find(f => f.startsWith('state.json.corrupt-'))), 'utf8'), '{not json');
});

test('a lock left by a dead writer is taken over', t => {
  const h = tmp(t);
  const lock = path.join(h, 'lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '999999');
  // Old enough that dibs judges it abandoned rather than just taken.
  const old = new Date(Date.now() - 10e3);
  fs.utimesSync(lock, old, old);
  const r = sync(h, 'a', ['t', '--', 'echo', 'ran']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'ran\n');
  assert.ok(!fs.existsSync(lock));
});

// dibs with fs patched by a preload, to make the lock race happen on cue (2026-11-04, exit 70 twice).
function patched(t, h, patch, args) {
  const pre = path.join(tmp(t, 'pre'), 'patch.mjs');
  fs.writeFileSync(pre, `import fs from 'node:fs';\nimport path from 'node:path';\nconst LOCK = ${JSON.stringify(path.join(h, 'lock'))};\n${patch}\n`);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, BIN, ...args], { env: env(h, { agent: 'a' }), encoding: 'utf8', timeout: 60e3 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('a stale lock replaced by a fresh one before the takeover: the fresh one is never taken from its writer', t => {
  const h = tmp(t);
  const lock = path.join(h, 'lock');
  // Stale: an older dibs's lock whose writer died.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '999999');
  const log = path.join(h, 'fresh.json');
  // Just before this dibs claims the stale lock, another writer's fresh lock replaces it, held by a
  // live process for 4 s. The claim must find it isn't the lock it judged, and wait its turn.
  const r = patched(t, h, `
import { spawn } from 'node:child_process';
const rename = fs.renameSync;
let fresh = false;
fs.renameSync = (a, b) => {
  if (!fresh && a === path.join(LOCK, 'pid') && String(b).startsWith(path.join(LOCK, 'owner.'))) {
    fresh = true;
    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.mkdirSync(LOCK);
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' });
    kid.unref();
    fs.writeFileSync(path.join(LOCK, 'pid'), String(kid.pid));
    fs.writeFileSync(path.join(LOCK, 'owner.' + kid.pid + '.0.x'), '');
    fs.writeFileSync(${JSON.stringify(log)}, String(Date.now()));
  }
  return rename(a, b);
};`, ['t', '--', 'echo', 'ran']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'ran\n');
  const waited = Date.now() - Number(fs.readFileSync(log, 'utf8'));
  assert.ok(waited >= 3500, `it went ahead ${waited} ms after the fresh lock was made, while its writer still lived`);
});

test('a lock taken from this dibs before its pid went in: it waits its turn again, no crash', t => {
  const h = tmp(t);
  // The first pid write finds the lock directory gone, as when a takeover moved it aside.
  const r = patched(t, h, `
const write = fs.writeFileSync;
let once = false;
fs.writeFileSync = (p, ...rest) => {
  if (!once && p === path.join(LOCK, 'pid')) { once = true; fs.rmSync(LOCK, { recursive: true, force: true }); }
  return write(p, ...rest);
};`, ['t', '--', 'echo', 'ran']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'ran\n');
});

test('the update notice: one line, once per agent per version, and never on a fresh install', t => {
  const h = tmp(t);
  assert.equal(sync(h, 'a', []).err, '', 'a brand-new install has nothing to announce');
  const seen = path.join(h, 'seen.json');
  fs.writeFileSync(seen, JSON.stringify({ ...JSON.parse(fs.readFileSync(seen, 'utf8')), a: '0.0.1', b: '0.0.1' }));
  assert.equal(sync(h, 'a', []).err, `dibs was updated to ${VERSION}: see \`dibs changes\`\n`);
  assert.doesNotMatch(sync(h, 'a', []).err, /updated to/);
  assert.match(sync(h, 'b', ['why']).err, /^dibs was updated to/, 'every agent that ran the old version sees it once');
  assert.doesNotMatch(sync(h, 'c', []).err, /updated to/, 'an agent new to dibs has nothing to compare');
});

// 2026-11-02: dibs web 0.0.169 read the CLI's --json output, and one read just after an update
// answered 502. The notice can't have caused it: it goes to stderr, and the JSON stays whole.
test('right after an update, a --json command prints only its JSON: the notice goes to stderr', t => {
  const h = tmp(t);
  sync(h, 'a', []);
  const seen = path.join(h, 'seen.json');
  fs.writeFileSync(seen, JSON.stringify({ ...JSON.parse(fs.readFileSync(seen, 'utf8')), a: '0.0.1' }));
  const r = sync(h, 'a', ['threads', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.ok(Array.isArray(JSON.parse(r.out).threads));
  assert.match(r.err, /^dibs was updated to/);
});

test('dibs throttle, and its old name cool, run a pass and exit cleanly', async t => {
  // Each pass takes 6s by design, so both run at once.
  const runs = ['throttle', 'cool'].map(verb => bg(t, tmp(t), [verb], { agent: 'a' }));
  for (const r of runs) {
    assert.equal(await r.done, 0, r.err);
    assert.match(r.out, /^nothing to throttle \(load 0\.0, acts above \d+(\.\d+)?\)$/m);
  }
});

const disk = diskFree => ({ env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree }) } });

test('a disk reading that fails is reported as unknown, not as endless free space', t => {
  assert.equal(freeDisk(path.join(tmp(t), 'no-such-dir', 'x')), null);
  assert.ok(freeDisk(tmp(t)) > 0);
});

test('with free disk unknown, a run still starts and says the disk check is off', t => {
  const h = tmp(t);
  const r = sync(h, 'a', ['run', 'test', '--', 'true'], disk(null));
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /couldn't read free disk space/);
  const out = sync(h, 'a', [], disk(null)).out;
  assert.match(out, /disk unknown/);
  assert.doesNotMatch(out, /Infinity|NaN/);
});

test('dibs when counts the disk the resource needs, as a real run would', t => {
  const h = tmp(t);
  // sim needs 8G of disk by default; 7G is above minDisk (5G) but below that.
  const when = sync(h, 'a', ['when', 'sim', '--json'], disk(7 * G));
  assert.equal(when.code, 0, when.err);
  assert.deepEqual(JSON.parse(when.out).blockedBy, 'disk');
  assert.equal(JSON.parse(when.out).freeNow, false);
  assert.equal(sync(h, 'a', ['run', 'sim', '--no-wait', '--', 'true'], disk(7 * G)).code, 74);
});

test('one broken line in the run history leaves the rest of it in use', async t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'history.jsonl'),
    JSON.stringify({ key: 'test|sleep 30', dur: 10 * 6e4, who: 'a', at: Date.now() }) + '\n{"key":"test|sl\n');
  bg(t, h, ['run', 'test', '--', 'sleep', '30'], { agent: 'a' });
  await until(() => board(h).held.length === 1);
  // Ten minutes typical, a moment in: close to ten minutes left. Without the history it would be null.
  const left = board(h).held[0].remaining;
  assert.ok(left > 9 * 6e4 && left <= 10 * 6e4, `remaining ${left}`);
});

// 2026-10-21: brew upgrade replaced Cellar/node/25.9.0_2, and the services, started by that path, couldn't restart.
test("services start Node through a link that follows upgrades when there is one, not the versioned folder", { skip: posixOnly("Homebrew's Cellar is macOS and Linux only") }, async t => {
  const { stableNode } = await import('../src/service.mjs');
  const root = tmp(t, 'brew');
  const real = path.join(root, 'Cellar', 'node', '25.9.0_2', 'bin', 'node');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  const opt = path.join(root, 'opt', 'node', 'bin');
  fs.mkdirSync(opt, { recursive: true });
  fs.symlinkSync(real, path.join(opt, 'node'));
  assert.equal(stableNode(real, [path.join(root, 'nowhere', 'node'), path.join(opt, 'node')]), path.join(opt, 'node'));
  assert.equal(stableNode(real, [path.join(root, 'nowhere', 'node')]), real, 'no link to it: as it is');
  assert.equal(stableNode('/usr/bin/node', [path.join(opt, 'node')]), '/usr/bin/node', 'not versioned: as it is');
});

// 2026-10-22: launchctl bootout returned before the worker was gone, the bootstrap after it failed
// with "5: Input/output error", and reinstalling the services left the worker and throttle down.
test('dibs service install waits for launchd to let the old service go before loading the new one', { skip: process.platform !== 'darwin' && 'launchd is macOS only' }, t => {
  const home = tmp(t), agents = tmp(t, 'agents'), bin = tmp(t, 'fakebin');
  const loaded = path.join(bin, 'loaded');
  fs.writeFileSync(loaded, '');
  // A launchctl whose bootout takes a second to land, and whose bootstrap fails while the old one is still loaded.
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh
case "$1" in
  print) [ -f "${loaded}" ] ;;
  bootout) (sleep 1; rm -f "${loaded}") >/dev/null 2>&1 & ;;
  bootstrap) if [ -f "${loaded}" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi; touch "${loaded}" ;;
esac
`, { mode: 0o755 });
  const r = dibs(home, ['service', 'install', 'worker'], { env: { DIBS_LAUNCHCTL: path.join(bin, 'launchctl'), DIBS_LAUNCH_AGENTS: agents } });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(loaded), 'loaded again');
  assert.ok(fs.existsSync(path.join(agents, 'dev.dibs.worker.plist')));
});
