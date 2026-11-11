// The life of a lease, end to end: what a reap may kill, nested quota runs,
// --notify and --after, yield's flags, the waits history keeps, and the
// usage errors a newcomer hits first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, board, track, alive, flat, env, BIN, posixOnly } from './helpers.mjs';

const STATE = new URL('../src/state.mjs', import.meta.url).href;
const config = (h, c) => fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(c));
const state = h => { try { return JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')); } catch { return { leases: [], queue: [] }; } };
const events = h => {
  try { return fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
};

// Change the state the way dibs does, under its lock: body is the inside of withState(s => { ... }).
function edit(h, body, vars = {}) {
  const js = `import { withState } from ${JSON.stringify(STATE)}; const v = ${JSON.stringify(vars)}; withState(s => { ${body} });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', js], { env: env(h), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// A process in a group of its own, as any shell pipeline or detached spawn makes.
function groupLeader(t) {
  const p = track(t, spawn('perl', ['-e', 'setpgrp(0,0); exec "sleep", "60"'], { stdio: 'ignore' }));
  return p;
}
// The pid of a process that has exited, for a lease whose holder is gone.
function deadPid() {
  const r = spawnSync('true');
  return r.pid;
}
const deadLease = (pgid, extra = {}) => ({ id: 900, kind: 'run', res: ['t'], pid: deadPid(), pstart: 'Thu Jan  1 00:00:00 2024', pgid,
  pgstart: 'Thu Jan  1 00:00:00 2024', start: Date.now() - 5000, mem: 1, cpu: 1, who: 'gone', cmd: 'x', ...extra });

test("reaping a dead run never kills a group that reused its number, even when the disk is too full to save the reap", { skip: posixOnly("process groups are POSIX; Windows has no setsid") }, async t => {
  const h = tmp(t);
  const other = groupLeader(t);
  // Its own group once perl has called setpgrp.
  await until(() => spawnSync('ps', ['-o', 'pgid=', '-p', String(other.pid)], { encoding: 'utf8' }).stdout.trim() === String(other.pid));
  edit(h, 's.leases.push(v.l);', { l: deadLease(other.pid) });
  assert.equal(sync(h, ['mine']).code, 1);
  assert.ok(!state(h).leases.length, 'the dead lease is gone');
  assert.ok(alive(other.pid), "someone else's group lives");

  // A full disk keeps the lease in the state, so every call reaps it again.
  edit(h, 's.leases.push(v.l);', { l: deadLease(other.pid) });
  const full = path.join(h, 'full');
  fs.writeFileSync(full, 'state');
  for (let i = 0; i < 3; i++) assert.equal(sync(h, ['mine'], { env: { DIBS_FAKE_ENOSPC: full } }).code, 74);
  assert.equal(state(h).leases.length, 1);
  assert.ok(alive(other.pid), "someone else's group lives through every retry");
});

test("reaping a dead run kills its group when the leader is gone but the group isn't", { skip: posixOnly("process groups are POSIX; Windows has no setsid") }, async t => {
  const h = tmp(t);
  // The leader starts a sleep in its own group and exits: the group lives on without it.
  const pidFile = path.join(h, 'kid');
  const p = spawn('perl', ['-e', `setpgrp(0,0); my $k = fork(); if (!$k) { exec "sleep", "60" } open(F, ">${pidFile}"); print F $k; close F;`], { stdio: 'ignore' });
  await new Promise(r => p.on('exit', r));
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8'));
  const kid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(kid, 'SIGKILL'); } catch {} });
  edit(h, 's.leases.push(v.l);', { l: deadLease(p.pid) });
  sync(h, ['mine']);
  await until(() => !alive(kid));
});

test('a waiter with an impossible pid in the state does not make every running job look dead', async t => {
  const h = tmp(t);
  const job = bg(t, h, ['run', 't', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  edit(h, 's.queue.push({ id: 901, res: ["u"], pid: 100000, enq: Date.now(), who: "odd", kind: "run" });');
  sync(h, ['mine']);
  assert.equal(board(h).held.length, 1, 'the running job is still held');
  assert.equal(job.exitCode, null, 'and still running');
});

test('a dibs run killed with -9: its job is stopped without waiting for another dibs call', async t => {
  const h = tmp(t);
  const p = bg(t, h, ['run', 't', '--', 'sleep', '45']);
  await until(() => state(h).leases[0]?.pgid && state(h).leases[0]?.pgstart);
  const job = state(h).leases[0].pgid;
  assert.ok(alive(job));
  p.kill('SIGKILL');
  await p.done;
  await until(() => !alive(job), 10e3);
});

test('a dibs run nested in one that holds a quota still pays its own tokens', async t => {
  const h = tmp(t);
  config(h, { quotas: { asc: { per: '1h', limit: 2 } } });
  const inner = `"${process.execPath}" "${BIN}" run quota:asc --no-wait -- true`;
  const r = sync(h, ['run', 'quota:asc', '--', 'sh', '-c', `${inner}; echo "first $?"; ${inner}; echo "second $?"`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /first 0/);
  assert.match(r.out, /second 75/, 'the bucket ran out: outer took 1, the first nested call took 1');
});

test('--notify says started: false when the job never started', async t => {
  const h = tmp(t);
  // The first state write with the run's process group, made just before the command starts.
  // (Counting writes doesn't do: Windows makes one more before it.)
  const pre = path.join(h, 'pre.mjs');
  fs.writeFileSync(pre, `import fs from 'node:fs';
let failed = false;
const w = fs.writeFileSync;
fs.writeFileSync = function (f, ...a) {
  if (!failed && /state\\.json\\.\\d+\\.tmp$/.test(String(f)) && String(a[0]).includes('"pgid"') && (failed = true)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  return w.call(this, f, ...a);
};`);
  const note = path.join(h, 'n.jsonl'), ran = path.join(h, 'ran');
  const r = sync(h, ['run', 't', '--notify', note, '--', 'touch', ran], { env: { NODE_OPTIONS: `--import=${pathToFileURL(pre).href}` } });
  assert.equal(r.code, 74, r.err);
  assert.ok(!fs.existsSync(ran));
  const line = JSON.parse(fs.readFileSync(note, 'utf8'));
  assert.equal(line.code, 74);
  assert.equal(line.started, false);
});

test('every run ends with one line saying its number, wait, run time and exit code', t => {
  const h = tmp(t);
  const r = sync(h, ['run', 'test', '--', 'sh', '-c', 'exit 4']);
  assert.equal(r.code, 4);
  assert.match(r.err, /dibs: #\d+ test, waited \d+s, ran \d+s, exit 4\n$/);
});

test('--after #id joins the line only once that job has ended', async t => {
  const h = tmp(t);
  const gate = path.join(h, 'gate'), order = path.join(h, 'order');
  const first = bg(t, h, ['run', 'heavy', '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done; echo first >> '${order}'`]);
  await until(() => board(h).held.length === 1);
  const id = board(h).held[0].id;
  // test is free all along: only --after holds the second step back.
  const second = bg(t, h, ['run', 'test', '--after', `#${id}`, '--', 'sh', '-c', `echo second >> '${order}'`]);
  await until(() => second.err.includes(`waiting for #${id}`));
  assert.ok(!fs.existsSync(order));
  fs.writeFileSync(gate, '');
  assert.equal(await second.done, 0, second.err);
  assert.equal(await first.done, 0);
  assert.equal(fs.readFileSync(order, 'utf8'), 'first\nsecond\n');
  const gone = sync(h, ['run', 'test', '--after', '#999', '--', 'true']);
  assert.equal(gone.code, 0);
  assert.match(gone.err, /#999 isn't running or waiting/);
});

test('yield with -m still finds the agent and moves them ahead', async t => {
  const h = tmp(t);
  config(h, { resources: { t: { slots: 1, mem: '0.1G', cpu: 1 } } });
  const a = bg(t, h, ['run', 't', '--', 'sleep', '120'], { agent: 'alice' });
  await until(() => board(h).held.length === 1);
  bg(t, h, ['run', 't', '--wait', '--', 'true'], { agent: 'carol' });
  await until(() => board(h).waiting.length === 1);
  bg(t, h, ['run', 't', '--wait', '--', 'true'], { agent: 'bob' });
  await until(() => board(h).waiting.length === 2);
  const r = sync(h, ['yield', 'bob', '-m', 'his deploy is urgent'], { agent: 'carol' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /bob now goes before you for t/);
  a.kill('SIGTERM');
});

test('history counts a wait that ended by a signal or a kill, not only by starting or timing out', async t => {
  const h = tmp(t);
  config(h, { resources: { t: { slots: 1, mem: '0.1G', cpu: 1 } } });
  const a = bg(t, h, ['run', 't', '--', 'sleep', '120'], { agent: 'alice' });
  await until(() => board(h).held.length === 1);
  const bob = bg(t, h, ['run', 't', '--wait', '--', 'true'], { agent: 'bob' });
  const cid = bg(t, h, ['run', 't', '--wait', '--', 'true'], { agent: 'cid' });
  await until(() => events(h).filter(e => e.kind === 'wait').length === 2);
  bob.kill('SIGTERM');
  cid.kill('SIGKILL');
  await bob.done; await cid.done;
  sync(h, ['mine']);   // the next state read notices cid is gone
  const hist = JSON.parse(sync(h, ['history', '--json']).out);
  assert.equal(hist.resources.t.waits, 2);
  assert.ok(hist.agents.bob?.waitMs > 0 && hist.agents.cid?.waitMs > 0, JSON.stringify(hist.agents));
  assert.deepEqual(events(h).filter(e => e.kind === 'left').map(e => e.who).sort(), ['bob', 'cid']);
  a.kill('SIGTERM');
});

test('an onRelease command whose supervisor died is stopped before the next user gets the resource', async t => {
  const h = tmp(t);
  config(h, { resources: { t: { slots: 1, mem: '0.1G', cpu: 1, onRelease: 'sleep 40', onReleaseTimeout: '60s' } } });
  assert.equal(sync(h, ['run', 't', '--', 'true']).code, 0);
  await until(() => state(h).resets?.[0]?.cpid);
  const { pid, cpid } = state(h).resets[0];
  process.kill(pid, 'SIGKILL');
  await until(() => !alive(pid));
  sync(h, ['mine']);
  await until(() => !alive(cpid), 5000);
  assert.ok(!state(h).resets?.length);
});

test('dibs crashing on a bug exits 70 and says so, never 1', t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'state.json'), JSON.stringify({ leases: 5, queue: [] }));
  const r = sync(h, ['mine']);
  assert.equal(r.code, 70);
  assert.match(r.err, /dibs itself crashed \(a bug in dibs, not in your command; exit 70\)/);
});

test('a resource name close to a real one is refused with the real one; a new name gets its own queue', t => {
  const h = tmp(t);
  for (const [name, near] of [['simulator', 'sim'], ['tset', 'test'], ['xcode', 'xcode-build'], ['Sim', 'sim'], ['e2e', 'playwright'], ['tests', 'test']]) {
    const r = sync(h, ['run', name, '--', 'true']);
    assert.equal(r.code, 2, name);
    assert.match(flat(r.err), new RegExp(`no resource named ${name}\\. Did you mean ${near}\\?`));
  }
  assert.equal(sync(h, ['hold', 'simulators']).code, 2);
  for (const name of ['sim-promax', 'test2', 'migrations']) {
    const r = sync(h, ['run', name, '--', 'true']);
    assert.equal(r.code, 0, r.err);
    assert.match(flat(r.err), new RegExp(`${name} isn't a resource dibs knows, so this starts a new queue for it`));
  }
});

test('an unknown command says so, with the closest one; a resource without -- still asks for the command', t => {
  const h = tmp(t);
  for (const c of ['list', 'install', 'update', 'uninstall']) {
    const r = sync(h, [c]);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`unknown command ${c}\\. Commands: dibs help`));
  }
  assert.match(sync(h, ['stauts']).err, /unknown command stauts\. Did you mean dibs status\?/);
  assert.match(sync(h, ['sim']).err, /nothing to run: put the command after --/);
});

test('hold with no resource is a usage error; with holds, it extends them as renew did', t => {
  const h = tmp(t);
  for (const args of [['hold'], ['hold', '-m', 'x']]) {
    const r = sync(h, args);
    assert.equal(r.code, 2);
    assert.match(r.err, /hold what\? dibs hold sim --for 20m -m "why"/);
  }
  assert.equal(sync(h, ['hold', 'deploy']).code, 0);
  const again = sync(h, ['hold']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /You still have deploy/);
});

test('hold --for past an hour says it was cut to an hour', t => {
  const h = tmp(t);
  const r = sync(h, ['hold', 'heavy', '--for', '3h']);
  assert.equal(r.code, 0, r.err);
  assert.match(flat(r.out), /3h00m asked; an hour is the most a hold gets/);
  assert.match(flat(sync(h, ['hold', 'heavy', '--for', '2h']).out), /You still have heavy, now until .*2h00m asked; an hour is the most/);
  assert.doesNotMatch(sync(h, ['hold', 'heavy', '--for', '30m']).out, /asked/);
});

test('a whole shell line quoted after -- gets the sh -c form to use', t => {
  const h = tmp(t);
  const r = sync(h, ['run', 'test', '--', 'echo a && echo b']);
  assert.equal(r.code, 127);
  assert.match(flat(r.err), /To run a shell line, use: dibs run test -- sh -c 'echo a && echo b'/);
});

test('dibs later help and --help print the later usage', t => {
  const h = tmp(t);
  for (const a of ['help', '--help']) {
    const r = sync(h, ['later', a]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /dibs later <res> --at 02:00 -- <cmd>/);
  }
});

test('who says just now for a job that started seconds ago, and mine shows each job\'s number and reason', async t => {
  const h = tmp(t);
  bg(t, h, ['run', 'deploy', '-m', 'ship the site', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  assert.match(sync(h, ['who', 'deploy']).out, /"ship the site", running sleep 30, started just now/);
  assert.match(sync(h, ['mine']).out, /\(#\d+, "ship the site"\)/);
});

test('a held file lease is no reason to warn a waiting job about keeping things; a held resource is, until released', { skip: posixOnly("the stand-in for Claude Code is node behind a symlink named claude, which Windows lets only an administrator make") }, async t => {
  const h = tmp(t);
  const proj = tmp(t, 'proj');
  fs.mkdirSync(path.join(proj, '.git'));
  config(h, { resources: { t: { slots: 1, mem: '0.1G', cpu: 1 } } });
  bg(t, h, ['run', 't', '--', 'sleep', '30'], { agent: 'other' });
  await until(() => board(h).held.length === 1);
  // A stand-in for a Claude Code session (a process named claude), since holds hang off the session.
  const claude = path.join(tmp(t, 'session'), 'claude');
  fs.symlinkSync(process.execPath, claude);
  const err = path.join(h, 'err');
  const e = env(h, { agent: 'me' });
  delete e.DIBS_NO_SESSION;
  const script = `
    const { execFileSync, spawn } = require('node:child_process');
    const fs = require('node:fs');
    const dibs = (...a) => execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { env: process.env, stdio: 'ignore' });
    dibs('hold', 'files:src/**');
    dibs('hold', 'deploy');
    spawn(process.execPath, [${JSON.stringify(BIN)}, 'run', 't', '--wait', '--', 'true'], { env: process.env, stdio: ['ignore', 'ignore', fs.openSync(${JSON.stringify(err)}, 'w')] });
    const poll = setInterval(() => {
      if (!fs.readFileSync(${JSON.stringify(err)}, 'utf8').includes('reserved while you wait')) return;
      clearInterval(poll);
      dibs('release', 'deploy');
    }, 100);
    setInterval(() => {}, 1e6);`;
  track(t, spawn(claude, ['-e', script], { env: e, cwd: proj, stdio: 'ignore' }));
  const said = () => (fs.existsSync(err) ? flat(fs.readFileSync(err, 'utf8')) : '');
  await until(() => said().includes('you gave back what you were keeping'));
  assert.match(said(), /you're keeping the deploy slot reserved while you wait|you're keeping .*deploy.* reserved while you wait/i);
  assert.doesNotMatch(said().match(/you're keeping .*?reserved/)[0], /files/);
});
