// Several machines, simulated on this one: a coordinator, two workers and a
// sender, each with its own state directory and machine name (helpers.mjs group()).
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { G, tmp, sync, bg, until, port, group, shared, alive, machinesOf, flat, PERSON, board } from './helpers.mjs';
import { place } from '../src/serve.mjs';
import { SECRET, safeRel, newToken } from '../src/remote.mjs';
import { cleanWork, runArgs } from '../src/worker.mjs';
import { jobSize } from '../src/simpool.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const T = Date.now();
const w = (name, extra) => [name, { name, os: 'macos', cores: 10, load: 0, memFree: 80, memTotal: 16e9, seen: T, busy: {}, ...extra }];
const fleet = () => new Map([w('a', { load: 9 }), w('b', { load: 1 }), w('lin', { os: 'linux' }), w('gone', { seen: T - 60e3 })]);
const sleeper = marker => ['sh', '-c', `echo $$ > ${marker}; echo started; sleep 60`];

test("a token never starts with '-', which dibs join would read as a flag", () => {
  for (let i = 0; i < 5000; i++) assert.notEqual(newToken()[0], '-');
});

test('placement picks the least busy machine with the right system, never a lost one', () => {
  assert.equal(place(fleet(), { res: ['test'], from: 'x' }, T).machine, 'lin');
  assert.equal(place(fleet(), { res: ['sim'], os: 'macos', from: 'x' }, T).machine, 'b');
});

test('a line for the resource weighs more than load', () => {
  const f = fleet();
  f.get('b').busy = { sim: { used: 1, slots: 1, waiting: 2 } };
  assert.equal(place(f, { res: ['sim'], os: 'macos', from: 'x' }, T).machine, 'a');
});

test('--on a machine that is lost, wrong or unknown is refused with the reason', () => {
  assert.match(place(fleet(), { res: ['sim'], on: 'gone', from: 'x' }, T).error, /isn't reporting/);
  assert.match(place(fleet(), { res: ['sim'], on: 'lin', os: 'macos', from: 'x' }, T).error, /needs macos/);
  assert.match(place(fleet(), { res: ['t'], on: 'nope', from: 'x' }, T).error, /no machine named nope/);
  assert.equal(place(fleet(), { res: ['t'], on: 'x', from: 'x' }, T).machine, 'x', '--on yourself always works');
});

test('a job nothing can take is refused, unless the sender itself can run it', () => {
  assert.match(place(fleet(), { res: ['t'], mem: 64e9, os: 'macos', from: 'x', fromOs: 'linux' }, T).error, /no machine can take it/);
  assert.equal(place(new Map(), { res: ['t'], from: 'x' }, T).machine, 'x');
});

test("the sender's own machine wins a near tie: nothing to ship", () => {
  assert.equal(place(new Map([w('x', { load: 1 }), w('y', { load: 0 })]), { res: ['t'], from: 'x' }, T).machine, 'x');
});

test('more free memory wins between two equally busy machines', () => {
  const f = new Map([w('tight', { memFree: 10 }), w('roomy', { memFree: 50 })]);
  assert.equal(place(f, { res: ['t'], from: 'x' }, T).machine, 'roomy');
});

test('secret-looking files are recognised by name, and lookalikes are not', () => {
  for (const f of ['.env', 'a/.env.local', '.dev.vars', 'AuthKey_X.p8', 'cert.pem', 'x/id_ed25519', '.npmrc', 'secrets.json', 'app.mobileprovision',
    '.envrc', 'config/prod.env', 'id_ed25519_github', 'secrets.env', 'secret.txt', '.git-credentials', 'service-account.json', 'infra/terraform.tfvars'])
    assert.ok(SECRET.test(f), f);
  for (const f of ['env.ts', 'src/key.ts', 'keys/readme.md', 'environment.md', 'p8.txt', 'id_ed25519.pub', 'src/secrets.ts', 'credentials.ts'])
    assert.ok(!SECRET.test(f), f);
});

test('--bring takes only paths inside the folder', () => {
  for (const p of ['../x', '/etc', '..', '.', 'a/../../b', 'C:/x']) assert.equal(safeRel(p), null, p);
  assert.equal(safeRel('out/./r.txt'), 'out/r.txt');
});

describe('a job sent to another machine', () => {
  const s = shared();
  let g;
  before(async () => {
    g = await group(s, { files: { 'a.txt': 'hi\n', '.env': 'SECRET=1\n', 'key.p8': 'k\n', '.gitignore': 'node_modules\n',
      'node_modules/big': 'x\n', 'sub/s.txt': 's\n' } });
  });
  const send = (args, opts = {}) => sync(g.hc, ['run', 'test', ...args], { cwd: g.proj, ...opts });

  test('goes to the idle machine, as the sender, and passes its output and exit code back', () => {
    const r = send(['--anywhere', '--', 'sh', '-c', 'echo "on $DIBS_AGENT"; echo err >&2; exit 3'], { cwd: path.join(g.proj, 'sub') });
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, /job [\w-]+ goes to alpha/);
    assert.equal(r.out, 'on tester@gamma\n');
    assert.match(r.err, /^err$/m);
  });

  test('--notify records how a sent job ended, with started unknown', t => {
    const file = path.join(tmp(t, 'notify'), 'done.jsonl');
    assert.equal(send(['--on', 'alpha', '--notify', file, '--', 'sh', '-c', 'exit 4']).code, 4);
    const n = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([n.code, n.started], [4, null]);
  });

  test('secret-looking files and ignored folders stay home', () => {
    const r = send(['--on', 'alpha', '--', 'ls', '-a']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /kept 2 secret-looking files on this machine/);
    assert.deepEqual(r.out.split('\n').filter(f => f && !f.startsWith('.')).sort(), ['a.txt', 'sub']);
    assert.doesNotMatch(r.out, /\.env|key\.p8|node_modules/);
  });

  test('--bring copies what the job made back to the folder it was sent from', t => {
    t.after(() => fs.rmSync(path.join(g.proj, 'sub', 'out'), { recursive: true, force: true }));
    const r = send(['--on', 'alpha', '--bring', 'out', '--', 'sh', '-c', 'mkdir -p out; echo made > out/r.txt'], { cwd: path.join(g.proj, 'sub') });
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(path.join(g.proj, 'sub', 'out', 'r.txt')), r.err);
    assert.equal(fs.readFileSync(path.join(g.proj, 'sub', 'out', 'r.txt'), 'utf8'), 'made\n');
  });

  test('a file deleted at home is gone from the copy there too', t => {
    assert.match(send(['--on', 'beta', '--', 'ls']).out, /a\.txt/);
    fs.rmSync(path.join(g.proj, 'a.txt'));
    t.after(() => fs.writeFileSync(path.join(g.proj, 'a.txt'), 'hi\n'));
    const r = send(['--on', 'beta', '--', 'ls']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /goes to beta/);
    assert.equal(r.out, 'sub\n');
  });

  test('a file the last job deleted comes back with the next copy', () => {
    const rm = send(['--on', 'beta', '--', 'sh', '-c', 'rm a.txt; ls']);
    assert.equal(rm.out, 'sub\n', rm.err);
    const cat = send(['--on', 'beta', '--', 'cat', 'a.txt']);
    assert.equal(cat.out, 'hi\n', cat.err);
  });

  test('the coordinator closes each connection once it answers, so a sender busy past its keep-alive never writes to a dead one', async () => {
    // A sender packing a big working copy blocks for seconds between calls. Had
    // the coordinator kept the connection for reuse, it would drop it after 5s
    // idle, and the next call could go out on it anyway: fetch failed, ECONNRESET.
    const r = await fetch(`http://127.0.0.1:${g.port}/hello`, { headers: { authorization: `Bearer ${g.token}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('connection'), 'close');
    await r.json();
  });

  test('big output arrives whole, even through a pipe', () => {
    const big = send(['--on', 'alpha', '--', process.execPath, '-e', "process.stdout.write('x'.repeat(4e6) + 'END')"]);
    assert.equal(big.code, 0);
    assert.equal(big.out.length, 4e6 + 3);
    assert.ok(big.out.endsWith('END'));
  });

  test('sent from the machine that is itself the best choice, it runs in place', () => {
    const r = sync(g.ha, ['run', 'test', '--anywhere', '--', 'pwd'], { cwd: g.proj });
    assert.equal(r.code, 0);
    assert.match(r.err, /running here/);
    assert.equal(fs.realpathSync(r.out.trim()), fs.realpathSync(g.proj));
  });

  test("it waits its turn in that machine's own line", async t => {
    const order = path.join(tmp(t), 'order'), gate = path.join(tmp(t), 'gate');
    // The same project as the job sent: deploys are one at a time per project, and a job sent carries its sender's.
    const holder = bg(t, g.ha, ['run', 'deploy', '--', 'sh', '-c', `echo held >> ${order}; while [ ! -e ${gate} ]; do sleep 0.05; done`],
      { agent: 'local-agent', cwd: g.proj });
    await until(() => fs.existsSync(order));
    const job = bg(t, g.hc, ['run', 'deploy', '--on', 'alpha', '--', 'sh', '-c', `echo after >> ${order}`], { cwd: g.proj });
    await until(() => /waiting/.test(job.err));
    // On alpha it waits as a thin waiter, through the worker's sh entry.
    await until(() => JSON.parse(fs.readFileSync(path.join(g.ha, 'state.json'), 'utf8')).queue.some(q => q.wake && q.who.endsWith('@gamma')));
    assert.equal(fs.readFileSync(order, 'utf8'), 'held\n');
    fs.writeFileSync(gate, '');
    assert.equal(await job.done, 0, job.err);
    assert.equal(await holder.done, 0);
    assert.equal(fs.readFileSync(order, 'utf8'), 'held\nafter\n');
  });

  test('Ctrl-C stops the remote job and its processes', async t => {
    const marker = path.join(tmp(t), 'pid');
    const p = bg(t, g.hc, ['run', 'test', '--on', 'beta', '--', ...sleeper(marker)], { cwd: g.proj });
    await until(() => p.out.includes('started'));
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    assert.ok(alive(pid));
    p.kill('SIGINT');
    assert.equal(await p.done, 130);
    await until(() => !alive(pid));
  });

  test('a sender that dies: its job is stopped', async t => {
    const marker = path.join(tmp(t), 'pid');
    const p = bg(t, g.hc, ['run', 'test', '--on', 'beta', '-m', 'orphan', '--', ...sleeper(marker)], { cwd: g.proj });
    await until(() => p.out.includes('started'));
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    p.kill('SIGKILL');
    await until(() => !alive(pid), 40000);   // clientLost (helpers.mjs TIMING), then the worker's next check-in
    await until(() => machinesOf(g.hc).jobs.find(j => j.purpose === 'orphan')?.state === 'done');
  });

  test('a wrong token is refused', t => {
    const r = sync(tmp(t), ['join', `127.0.0.1:${g.port}`, 'wrong-token'], PERSON);
    assert.equal(r.code, 2);
    assert.match(r.err, /rejected that token/);
  });
});

test('a coordinator restart mid-job: the job keeps running, and its output and exit code still reach the sender', async t => {
  const g = await group(t);
  const p = bg(t, g.hc, ['run', 'test', '--on', 'alpha', '--', 'sh', '-c', 'echo before; sleep 2; echo during; sleep 5; echo after; exit 5'], { cwd: g.proj });
  await until(() => p.out.includes('before'));
  // A release restarts the coordinator: same port, same tokens, no jobs in memory.
  g.serve.kill('SIGTERM');
  await g.serve.done;
  g.serve = bg(t, g.h0, ['serve', '--listen', String(g.port), '--bind', '127.0.0.1']);
  assert.equal(await p.done, 5, p.err);
  assert.equal(p.out, 'before\nduring\nafter\n', 'every line once, in order, including what it printed while the coordinator was down');
  assert.match(p.err, /coordinator restarted/);
  assert.match(g.serve.out, /picked up again after a restart/);
});

test('a machine that dies mid-job: the sender gets exit 77 (it may have run) and the job does not linger', async t => {
  const g = await group(t);
  const marker = path.join(tmp(t), 'pid');
  const p = bg(t, g.hc, ['run', 'test', '--on', 'beta', '--', ...sleeper(marker)], { cwd: g.proj });
  await until(() => p.out.includes('started'));
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  g.wb.kill('SIGKILL');
  assert.equal(await p.done, 77);
  assert.match(p.err, /beta stopped reporting/);
  await until(() => !alive(pid));
});

test('a sender that stops reading for too long is told, when it reads again, why its job was stopped', async t => {
  const g = await group(t, { timing: { clientLost: 2000 } });
  const marker = path.join(tmp(t), 'pid');
  const p = bg(t, g.hc, ['run', 'test', '--on', 'alpha', '--', ...sleeper(marker)], { cwd: g.proj });
  await until(() => p.out.includes('started'));
  // Asleep, as a laptop that closed its lid would be.
  p.kill('SIGSTOP');
  await until(() => g.serve.out.includes('nobody is reading its output'));
  p.kill('SIGCONT');
  assert.notEqual(await p.done, 0);
  assert.match(p.err, /the coordinator stopped the job: nothing read its output for 2s/);
  await until(() => !alive(Number(fs.readFileSync(marker, 'utf8'))));
});

test('a job quiet for longer than clientLost is not stopped while its sender waits on it', async t => {
  // The sender's read is held open (15s) longer than clientLost: it is still reading.
  const g = await group(t, { timing: { clientLost: 2000 } });
  const r = await bg(t, g.hc, ['run', 'test', '--on', 'alpha', '--', 'sh', '-c', 'sleep 5; echo woke'], { cwd: g.proj }).done;
  assert.equal(r, 0);
  assert.ok(!g.serve.out.includes('nobody is reading its output'));
});

test('with the coordinator gone, --anywhere runs here and --on another machine exits 76', async t => {
  const g = await group(t);
  g.serve.kill('SIGKILL');
  await g.serve.done;
  const r = sync(g.hc, ['run', 'test', '--anywhere', '--', 'echo', 'local'], { cwd: g.proj });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'local\n');
  assert.match(r.err, /can't reach the coordinator.*running here/);
  const on = sync(g.hc, ['run', 'test', '--on', 'beta', '--', 'echo', 'ran'], { cwd: g.proj });
  assert.equal(on.code, 76);
  assert.equal(on.out, '');
});

test('a machine that never joined runs --anywhere jobs here', t => {
  const r = sync(tmp(t), ['run', 'test', '--anywhere', '--', 'echo', 'solo']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'solo\n');
  assert.match(r.err, /not connected to a coordinator/);
});

test('joining a coordinator that is not there exits 76', async t => {
  const r = sync(tmp(t), ['join', `127.0.0.1:${await port()}`, 'nope'], PERSON);
  assert.equal(r.code, 76);
  assert.match(r.err, /can't reach/);
});

test('old copies in ~/.dibs/work are cleaned up, ones in use never', t => {
  const work = path.join(tmp(t), 'work');
  const mk = (name, ageDays) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(`${d}.files`, '[]');
    const at = new Date(Date.now() - ageDays * 864e5);
    fs.utimesSync(`${d}.files`, at, at);
    return d;
  };
  const old = mk('old', 9), fresh = mk('fresh', 1), busy = mk('busy', 30);
  cleanWork({ minDisk: '1K' }, new Set([busy]), work);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(busy));
});

test('a remote job passes on only the --mem its sender gave, so sim-own counts its simulator once', () => {
  const job = { res: ['sim-own'], cmd: ['true'], mem: 3 * 1024 ** 3 };
  assert.ok(!runArgs({ ...job, askedMem: null }).includes('--mem'), "the resource default is the worker's own");
  const a = runArgs({ ...job, askedMem: 1024 ** 3 });
  assert.equal(a[a.indexOf('--mem') + 1], String(1024 ** 3));
  const old = runArgs(job);   // a sender from before askedMem
  assert.equal(old[old.indexOf('--mem') + 1], String(3 * 1024 ** 3));
});

test('one size for a job everywhere: a pool simulator comes on top of --mem, never on top of the default', () => {
  assert.deepEqual(jobSize(DEFAULT_CONFIG, ['sim-own']), { mem: 3 * G, cpu: 2, disk: 6 * G });
  assert.equal(jobSize(DEFAULT_CONFIG, ['sim-own'], { mem: G }).mem, 3 * G);   // 1G of its own plus a 2G simulator
  assert.equal(jobSize(DEFAULT_CONFIG, ['test'], { mem: G }).mem, G);
  assert.deepEqual(jobSize(DEFAULT_CONFIG, ['test', 'heavy'], { cpu: 1 }), { mem: 4 * G, cpu: 1, disk: 10 * G });
});

test('dibs machines shows this machine before its worker checks in, with when the coordinator started', async t => {
  const g = await group(t);
  // gamma runs no worker, as this machine in the seconds after a coordinator restart.
  const r = sync(g.hc, ['machines']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ {2}gamma \(here\) {2}worker hasn't checked in since the coordinator started at \d\d:\d\d/m);
  await until(() => sync(g.ha, ['machines']).out.includes('alpha (here)'));
  assert.doesNotMatch(sync(g.ha, ['machines']).out, /checked in since/, 'a machine whose worker reports gets its usual row');
});

// Until 2026-11-03 dibs machines exited 2 here, and the MCP machines tool answered with an error.
test('dibs machines on a machine in no group says so and exits 0, as text and as JSON', t => {
  const h = tmp(t);
  const r = sync(h, ['machines']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /this machine isn't in a group\. dibs pair --machine on a coordinator adds one/);
  assert.deepEqual(JSON.parse(sync(h, ['machines', '--json']).out), { group: false, machines: [], jobs: [] });
});

test('dibs leave: a machine that joined stops taking jobs and forgets the coordinator; the coordinator leaves only once the others are gone', async t => {
  const g = await group(t, { invite: true });
  // Services go in a folder of the test's own, never the real LaunchAgents or systemd units.
  const svc = { env: { DIBS_LAUNCH_AGENTS: tmp(t, 'agents') } };
  const stay = sync(g.h0, ['leave'], svc);
  assert.equal(stay.code, 2);
  // gamma was invited and ran dibs join, but no worker of its own has reported yet: not counted.
  assert.match(flat(stay.err), /this machine is the group's coordinator, and alpha, beta are still in the group\. Remove each first \(dibs kick alpha, dibs kick beta\), then dibs leave again\. Nothing changed/);
  assert.ok(fs.existsSync(path.join(g.h0, 'remote.json')));

  const left = sync(g.ha, ['leave'], svc);
  assert.equal(left.code, 0, left.err);
  assert.match(left.out, /left the group at http:\/\/127\.0\.0\.1:\d+: this machine takes no more jobs from it\. On the coordinator, dibs kick alpha takes it off the list/);
  assert.ok(!fs.existsSync(path.join(g.ha, 'remote.json')));
  await g.wa.done;   // its worker, started by hand, is stopped
  assert.match(sync(g.ha, ['machines']).out, /isn't in a group/);
  const ev = fs.readFileSync(path.join(g.ha, 'events.jsonl'), 'utf8');
  assert.match(ev, /"act":"leave".*"as":"member"/);
  assert.match(sync(g.ha, ['leave'], svc).err, /isn't in a group, so there's nothing to leave/);

  for (const n of ['alpha', 'beta']) assert.equal(sync(g.h0, ['kick', n]).code, 0);
  const done = sync(g.h0, ['leave'], svc);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /no longer a coordinator/);
  assert.ok(!fs.existsSync(path.join(g.h0, 'remote.json')));
});

test('a broken remote.json is reported, not taken as "not connected"', t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'remote.json'), '{"url": "http://127.0.0.1:1", "tok');
  const m = sync(h, ['machines']);
  assert.equal(m.code, 2);
  assert.match(m.err, /remote\.json can't be read .*dibs join <url> <token>/);
  const board = sync(h, []);
  assert.equal(board.code, 0, board.err);
  assert.match(board.out, /^This machine {3}quiet: /m, 'plain dibs still shows this machine');
  assert.match(flat(board.out), /^Other machines: .*remote\.json can't be read/m);
  const run = sync(h, ['run', 'test', '--anywhere', '--', 'echo', 'ran']);
  assert.equal(run.code, 2, '--anywhere stops instead of quietly running here');
  assert.equal(run.out, '');
  assert.match(run.err, /remote\.json can't be read/);
});

test('a worker on an on-demand VM (--ephemeral) leaves once its coordinator has been out of reach for a while', async t => {
  const h = tmp(t);
  // A coordinator address nothing answers on.
  fs.writeFileSync(path.join(h, 'remote.json'), JSON.stringify({ url: `http://127.0.0.1:${await port()}`, token: 'x', name: 'vm' }));
  const w = bg(t, h, ['worker', '--ephemeral'], { env: { DIBS_LOST_EXIT_MS: '2000' } });
  // Its retries are 5s apart, so it notices on the first one past 2s.
  assert.equal(await w.done, 0);
  assert.match(w.out, /no coordinator for 2s on an on-demand machine: leaving/);
  // A worker without --ephemeral keeps trying, as a service should.
  const keep = bg(t, h, ['worker']);
  await new Promise(r => setTimeout(r, 8000));   // past where the ephemeral one left; nothing to wait on but time
  assert.equal(keep.exitCode, null);
});

// 2026-10-21: every job sent to boat-1 unpacked into an empty folder and installed its packages again.
test("an on-demand worker keeps a project's copy for its next job: what the last job built (node_modules) is still there", async t => {
  const g = await group(t);
  g.wa.kill('SIGTERM');
  await g.wa.done;
  const w = bg(t, g.ha, ['worker', '--ephemeral']);
  const first = sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'sh', '-c', 'mkdir -p node_modules/.bin && touch node_modules/.bin/x'], { cwd: g.proj });
  assert.equal(first.code, 0, first.err);
  const next = sync(g.hc, ['run', 'test', '--on', 'alpha', '--', 'ls', 'node_modules/.bin'], { cwd: g.proj });
  assert.equal(next.code, 0, next.err);
  assert.equal(next.out, 'x\n');
  assert.equal(w.exitCode, null, w.out);
});

// 2026-10-20: a job left a read-only folder in its copy; deleting the copy threw EACCES and
// crashed boat-1's worker, taking every job running there with it.
test('a copy with read-only folders in it is deleted when its time comes, without throwing', { skip: process.getuid?.() === 0 }, t => {
  const work = tmp(t, 'work');
  const copy = path.join(work, 'mac-0123456789ab');
  fs.mkdirSync(path.join(copy, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'node_modules', '.bin', 'x'), '');
  fs.writeFileSync(`${copy}.files`, '[]');
  fs.chmodSync(path.join(copy, 'node_modules', '.bin'), 0o555);
  fs.chmodSync(path.join(copy, 'node_modules'), 0o555);
  const old = (Date.now() - 8 * 24 * 36e5) / 1000;
  fs.utimesSync(`${copy}.files`, old, old);
  cleanWork({ minDisk: '1G' }, new Set(), work);
  assert.ok(!fs.existsSync(copy), 'a week unused: gone, read-only folders and all');
});

// 2026-10-20: jobs a full boat-1 sent back to the Mac waited there under the 8-minute limit of a
// dibs outside Claude Code, and gave up (75), though their senders wait as long as it takes.
test('a sender that waits as long as it takes: its job waits as long on the machine that runs it', async t => {
  const g = await group(t);
  g.wa.kill('SIGTERM');
  await g.wa.done;
  const w = bg(t, g.ha, ['worker'], { env: { DIBS_MAX_WAIT: '1s' } });
  // alpha's only test slot is taken for 4 s, longer than its own wait limit.
  fs.writeFileSync(path.join(g.ha, 'config.json'), JSON.stringify({ resources: { test: { slots: 1 } } }));
  const busy = bg(t, g.ha, ['run', 'test', '--', 'sleep', '4'], { agent: 'local' });
  await until(() => board(g.ha).held.some(l => l.who === 'local'));
  const r = sync(g.hc, ['run', 'test', '--on', 'alpha', '--wait', '--', 'echo', 'ran'], { cwd: g.proj });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'ran\n');
  assert.equal(await busy.done, 0);
  assert.equal(w.exitCode, null);
});
