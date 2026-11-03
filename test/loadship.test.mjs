// A job the load ceiling holds goes to an on-demand machine on its own after
// a while, when it can run there (src/acquire.mjs step, src/remote.mjs
// loadShipTarget), and stays when it needs macOS or its project says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp, bg, until, port, answers, gitProject, board, machinesOf, SERVE_START, MACHINE } from './helpers.mjs';
import { macOnly } from '../src/remote.mjs';
import { commandKey } from '../src/acquire.mjs';
import { NODE } from '../src/ondemand.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-boat.mjs');
const ID = 'bx_test1234';
const REGISTRY = `# Boat VMs\n\n| VM | Kind | Owner | Shared with | Use | Notes |\n|---|---|---|---|---|---|\n| ${ID} | dedicated | alex-3b |  | dibs on-demand machine | Stopped |\n`;

test("a command that needs macOS is never shipped: its tools, a .swift file, or a script that imports Apple's frameworks", t => {
  const dir = tmp(t, 'proj');
  fs.mkdirSync(path.join(dir, 'tools'));
  // 2026-10-18: Apple Vision OCR run as a Python script; nothing in the command says macOS.
  fs.writeFileSync(path.join(dir, 'tools', 'reocr_batch.py'), 'import sys\nimport Vision\nfrom Quartz import CIImage\n');
  fs.writeFileSync(path.join(dir, 'tools', 'plain.py'), 'import sys, json\nprint(json.dumps(sys.argv))\n');
  assert.equal(macOnly('python3 tools/reocr_batch.py 500', dir), true);
  assert.equal(macOnly('python3 tools/plain.py 500', dir), false);
  assert.equal(macOnly('xcrun simctl list', dir), true);
  assert.equal(macOnly('swift run ocr', dir), true);
  assert.equal(macOnly('sh -c "osascript -e beep"', dir), true);
  assert.equal(macOnly('node --test test/a.test.mjs', dir), false);
});

// A coordinator whose own machine has a sleeping on-demand VM (the fake boat runs it here),
// a load of 20 on a ceiling of 5, and waits that ship after 1 s instead of 5 min.
async function setup(t, { config = { maxLoad: 5 }, create, machine = { load: 20 } } = {}) {
  const boatDir = tmp(t, 'boat');
  fs.writeFileSync(path.join(boatDir, 'state.json'), JSON.stringify({ vms: { [ID]: { state: 'stopped', pids: [] } } }));
  const nodeDir = path.join(boatDir, `vm-${ID}`, '.dibs-node');
  fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeDir, 'bin', 'node'));
  fs.writeFileSync(path.join(nodeDir, '.pinned'), `${NODE.version}\n`);
  const wrapper = path.join(boatDir, 'boat');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const h = tmp(t, 'coord');
  fs.writeFileSync(path.join(boatDir, 'VMS.md'), REGISTRY);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ ...config, machines: { ondemand: [{ name: 'boat-1', provider: 'boat', registry: path.join(boatDir, 'VMS.md'), match: 'dibs', owner: 'alex-3b', idleStop: '2s', create }] } }));
  t.after(() => { try { for (const v of Object.values(JSON.parse(fs.readFileSync(path.join(boatDir, 'state.json'), 'utf8')).vms)) for (const pid of v.pids) process.kill(-pid, 'SIGKILL'); } catch {} });
  const at = await port();
  bg(t, h, ['serve', '--listen', String(at), '--bind', '127.0.0.1'], { env: { DIBS_BOAT: wrapper, FAKE_BOAT_DIR: boatDir, FAKE_BOAT_NODE: nodeDir } });
  await until(async () => fs.existsSync(path.join(h, 'remote.json')) && await answers(at), SERVE_START);
  const hot = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, ...machine }), DIBS_SHIP_AFTER: '1' } };
  return { h, boatDir, hot, proj: gitProject(t, { 'tools/ocr.py': 'import Vision\n', 'tools/count.py': 'print(1)\n' }) };
}

test('a job the load ceiling holds goes to an on-demand machine on its own, and one that needs macOS stays and waits', async t => {
  const { h, boatDir, hot, proj } = await setup(t);
  const mac = bg(t, h, ['run', 'test', '-m', 'ocr', '--', 'python3', 'tools/ocr.py'], { ...hot, cwd: proj, agent: 'ocr' });
  const job = bg(t, h, ['run', 'test', '-m', 'count', '--', 'sh', '-c', 'echo "ran on $HOME"'], { ...hot, cwd: proj, agent: 'counter' });
  assert.equal(await job.done, 0, job.err);
  assert.match(job.out, new RegExp(`ran on ${boatDir}/vm-${ID}`), 'it ran on the VM');
  assert.match(job.err, /the machine's load has held this job for .*, so it goes to boat-1, an on-demand machine with room, instead of waiting here/s);
  // The macOS job is still here, waiting, with its place.
  assert.ok(board(h).waiting.some(q => q.who === 'ocr'), mac.err);
  mac.kill('SIGTERM');
  await mac.done;
});

// 2026-10-19: 18 jobs waited on 16 GB booked of an 11 GB budget while the Mac had 12 GB free, and no VM ran.
// Here a 3 GB job fills most of a 4 GB budget, and the machine reads 20% free so the roomy rule stays out of it.
const FULL = { config: { budget: '4G', maxLoad: null }, machine: { memFree: 20, load: 0 } };
const filler = (t, h, opts, proj) => bg(t, h, ['run', 'heavy', '--mem', '3G', '-m', 'filler', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.2; done'], { ...opts, cwd: proj, agent: 'filler' });

test('a job the memory budget alone holds goes to an on-demand machine on its own', async t => {
  const { h, boatDir, hot, proj } = await setup(t, FULL);
  const big = filler(t, h, hot, proj);
  await until(() => board(h).held.some(l => l.who === 'filler'));
  const job = bg(t, h, ['run', 'test', '--mem', '2G', '-m', 'count', '--', 'sh', '-c', 'echo "ran on $HOME"'], { ...hot, cwd: proj, agent: 'counter' });
  assert.equal(await job.done, 0, job.err);
  assert.match(job.out, new RegExp(`ran on ${boatDir}/vm-${ID}`), 'it ran on the VM');
  assert.match(job.err, /the memory dibs shares out on this machine has held this job for .*, so it goes to boat-1/s);
  fs.writeFileSync(path.join(proj, 'stop'), '');
  assert.equal(await big.done, 0);
});

test('a job that usually uses more than the whole budget goes to an on-demand machine at once, without the usual wait', async t => {
  const { h, boatDir, hot, proj } = await setup(t, FULL);
  const big = filler(t, h, hot, proj);
  await until(() => board(h).held.some(l => l.who === 'filler'));
  // Its last run here used 6 GB of this 4 GB budget, so dibs plans it at the whole budget.
  const cmd = ['sh', '-c', 'echo "ran on $HOME"'];
  fs.appendFileSync(path.join(h, 'history.jsonl'), JSON.stringify({ key: `test|${commandKey(cmd)}`, dur: 1000, who: 'counter', at: Date.now(), fit: true, mem: 6 * 1024 ** 3, cpu: 1 }) + '\n');
  // Ten minutes before an ordinary memory wait would ship.
  const slow = { env: { ...hot.env, DIBS_SHIP_AFTER: '600' } };
  const job = bg(t, h, ['run', 'test', '-m', 'big suite', '--', ...cmd], { ...slow, cwd: proj, agent: 'counter' });
  assert.equal(await job.done, 0, job.err);
  assert.match(job.out, new RegExp(`ran on ${boatDir}/vm-${ID}`), 'it ran on the VM');
  fs.writeFileSync(path.join(proj, 'stop'), '');
  assert.equal(await big.done, 0);
});

test('with boat-1 full, a job the memory budget holds goes to a VM made for it, up to create.max', async t => {
  const { h, boatDir, hot, proj } = await setup(t, { ...FULL, create: { max: 'large' } });
  const big = filler(t, h, hot, proj);
  await until(() => board(h).held.some(l => l.who === 'filler'));
  // boat-1 full with a job of its own: 6 GB of its 8, so 2 more don't fit beside it.
  const there = bg(t, h, ['run', 'test', '--on', 'boat-1', '--mem', '6G', '-m', 'busy', '--', 'sh', '-c', 'while [ ! -f stop-vm ]; do sleep 0.2; done'], { ...hot, cwd: proj, agent: 'busy' });
  await until(() => fs.readFileSync(path.join(boatDir, 'state.json'), 'utf8').includes('"running"'), 60e3);
  const job = bg(t, h, ['run', 'test', '--mem', '2G', '-m', 'count', '--', 'sh', '-c', 'echo "ran on $HOME"'], { ...hot, cwd: proj, agent: 'counter' });
  assert.equal(await job.done, 0, job.err);
  assert.match(job.err, /so it goes to boat-1-temp, an on-demand machine with room/);
  const id = job.out.match(/vm-(bx_t\w+)/)?.[1];
  assert.ok(id && id !== ID, `it ran on a VM made for it: ${job.out}`);
  fs.writeFileSync(path.join(proj, 'stop'), '');
  assert.equal(await big.done, 0);
  there.kill('SIGTERM');
  await there.done;
});

// 2026-10-19: jobs waited on "this machine to stop swapping" and on memory pressure with boat-1 asleep.
// A 1 GB filler runs here, so the OS's pressure or swap growth holds the next job (over 0.5 GB) below urgent.
const PRESSED = { config: { maxLoad: null }, machine: { load: 0, vmPressure: 1 } };
const SWAPPING = { config: { maxLoad: null, maxSwap: '4G' }, machine: { load: 0, swapUsed: 6 * 1024 ** 3, swapGrowth: 1.2 * 1024 ** 3, swapRecent: 1.2 * 1024 ** 3 } };
const small = (t, h, opts, proj) => bg(t, h, ['run', 'heavy', '--mem', '1G', '-m', 'filler', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.2; done'], { ...opts, cwd: proj, agent: 'filler' });

for (const [name, how, said] of [['memory pressure', PRESSED, "this machine's memory pressure"], ['swap growth', SWAPPING, "this machine's swapping"]]) {
  test(`a job ${name} holds goes to an on-demand machine on its own`, async t => {
    const { h, boatDir, hot, proj } = await setup(t, how);
    const filler = small(t, h, hot, proj);
    await until(() => board(h).held.some(l => l.who === 'filler'));
    const job = bg(t, h, ['run', 'test', '--mem', '2G', '-m', 'count', '--', 'sh', '-c', 'echo "ran on $HOME"'], { ...hot, cwd: proj, agent: 'counter' });
    assert.equal(await job.done, 0, job.err);
    assert.match(job.out, new RegExp(`ran on ${boatDir}/vm-${ID}`), 'it ran on the VM');
    assert.match(job.err, new RegExp(`${said} has held this job for .*, so it goes to boat-1`, 's'));
    fs.writeFileSync(path.join(proj, 'stop'), '');
    assert.equal(await filler.done, 0);
  });
}

test('jobs memory pressure holds pack onto boat-1 while they fit its memory, then onto one VM made beside it', async t => {
  const { h, hot, proj } = await setup(t, { ...PRESSED, create: { max: 'large' } });
  const filler = small(t, h, hot, proj);
  await until(() => board(h).held.some(l => l.who === 'filler'));
  const forever = ['sh', '-c', 'while :; do sleep 0.2; done'];
  const sent = async who => {
    const j = bg(t, h, ['run', 'test', '--mem', '3G', '-m', who, '--', ...forever], { ...hot, cwd: proj, agent: who });
    // Sent, and the coordinator has it, so the next sender sees it booked there.
    await until(() => machinesOf(h).jobs?.some(x => x.agent === who && x.machine), 60e3);
    return j;
  };
  // boat-1 has 8 GB: two 3 GB jobs fit beside each other with 1 GB for the VM itself, a third doesn't.
  const a = await sent('first');
  assert.match(a.err, /so it goes to boat-1, /);
  const b = await sent('second');
  assert.match(b.err, /so it goes to boat-1, /, 'it fits beside the first, so no VM is made for it');
  const c = await sent('third');
  assert.match(c.err, /so it goes to boat-1-temp, /, 'boat-1 is full');
  for (const j of [a, b, c]) j.kill('SIGTERM');
  await Promise.all([a.done, b.done, c.done]);
  fs.writeFileSync(path.join(proj, 'stop'), '');
  assert.equal(await filler.done, 0);
});

// 2026-10-20: ten jobs waited on the Mac (load, the budgets, a reservation) while boat-1 sat idle.
test('a job the CPU budget holds goes to an on-demand machine on its own', async t => {
  const { h, boatDir, hot, proj } = await setup(t, { config: { cores: 4, maxLoad: null }, machine: { memFree: 20, load: 0 } });
  const busy = bg(t, h, ['run', 'heavy', '--cpu', '3', '--mem', '1G', '-m', 'busy', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.2; done'], { ...hot, cwd: proj, agent: 'busy' });
  await until(() => board(h).held.some(l => l.who === 'busy'));
  const job = bg(t, h, ['run', 'test', '--cpu', '2', '--mem', '1G', '-m', 'count', '--', 'sh', '-c', 'echo "ran on $HOME"'], { ...hot, cwd: proj, agent: 'counter' });
  assert.equal(await job.done, 0, job.err);
  assert.match(job.out, new RegExp(`ran on ${boatDir}/vm-${ID}`), 'it ran on the VM');
  assert.match(job.err, /the cores dibs shares out on this machine has held this job/);
  fs.writeFileSync(path.join(proj, 'stop'), '');
  assert.equal(await busy.done, 0);
});

// 2026-10-20: a browser run naming /Users/alex/... paths shipped to boat-1, where they don't exist.
test("a held job whose command names this machine's paths, or that runs outside git, stays here", async t => {
  const { h, hot, proj } = await setup(t);
  const plain = tmp(t, 'plain');
  const named = bg(t, h, ['run', 'test', '-m', 'named', '--', 'sh', '-c', `ls ${proj} >/dev/null`], { ...hot, cwd: proj, agent: 'named' });
  const outside = bg(t, h, ['run', 'test', '-m', 'outside', '--', 'true'], { ...hot, cwd: plain, agent: 'outside' });
  await until(() => ['named', 'outside'].every(a => board(h).waiting.some(q => q.who === a)));
  // Proving a job did not move takes time: ship-after is 1 s here, and a waiter asks at most once a minute.
  await new Promise(r => setTimeout(r, 4000));
  assert.ok(['named', 'outside'].every(a => board(h).waiting.some(q => q.who === a)), `${named.err}\n${outside.err}`);
  assert.doesNotMatch(named.err + outside.err, /so it goes to boat-1/);
  named.kill('SIGTERM'); outside.kill('SIGTERM');
  await Promise.all([named.done, outside.done]);
});

// When the Mac's line would hold a job longer than sending it to boat-1 and running it there, it goes at once.
test("a job whose turn here is further off than shipping it plus its run time goes to an on-demand machine", async t => {
  const { h, boatDir, hot, proj } = await setup(t, { config: { maxLoad: null, resources: { test: { slots: 1, mem: '1G', cpu: 1 } } }, machine: { load: 0 } });
  const long = bg(t, h, ['run', 'test', '--est', '10m', '-m', 'long', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.2; done'], { ...hot, cwd: proj, agent: 'long' });
  await until(() => board(h).held.some(l => l.who === 'long'));
  const job = bg(t, h, ['run', 'test', '--est', '10s', '-m', 'quick', '--', 'sh', '-c', 'echo "ran on $HOME"'], { ...hot, cwd: proj, agent: 'quick' });
  assert.equal(await job.done, 0, job.err);
  assert.match(job.out, new RegExp(`ran on ${boatDir}/vm-${ID}`), 'it ran on the VM');
  assert.match(job.err, /its turn here is about .* off, longer than sending it and running it there, so it goes to boat-1/s);
  fs.writeFileSync(path.join(proj, 'stop'), '');
  assert.equal(await long.done, 0);
});

// A big suite split across the Mac and boat-1 finishes in about half the time.
test('--shards splits a node --test suite across machines, each piece prefixed, the exit codes merged', async t => {
  const { h, hot, boatDir } = await setup(t, { config: { maxLoad: null }, machine: { load: 0 } });
  const proj = gitProject(t, {
    'a.test.mjs': "import test from 'node:test'; test('a', () => console.log('ran a on ' + process.env.HOME));\n",
    'b.test.mjs': "import test from 'node:test'; test('b', () => console.log('ran b on ' + process.env.HOME));\n",
  });
  const opts = { ...hot, cwd: proj, agent: 'suite' };
  const r = bg(t, h, ['run', 'test', '--shards', '2', '-m', 'suite', '--', 'node', '--test', '--test-reporter=tap', 'a.test.mjs', 'b.test.mjs'], opts);
  assert.equal(await r.done, 0, r.err);
  assert.match(r.err, /splitting this node run into 2 shards: the first here, the rest on boat-1/);
  assert.match(r.out, new RegExp(`ran [ab] on ${boatDir}/vm-${ID}`), r.out + r.err);
  assert.match(r.out, /^\[1\/2\] /m, r.err);
  assert.match(r.out, /^\[2\/2\] /m);
  assert.match(r.out, /# pass 1/);
  assert.match(r.err, /all 2 shards done: 1\/2 exit 0, 2\/2 exit 0/);
  // One shard failing makes the whole run fail.
  fs.writeFileSync(path.join(proj, 'b.test.mjs'), "import test from 'node:test'; test('b', () => { throw new Error('no'); });\n");
  const bad = bg(t, h, ['run', 'test', '--shards', '2', '-m', 'suite', '--', 'node', '--test', 'a.test.mjs', 'b.test.mjs'], opts);
  assert.notEqual(await bad.done, 0);
});

test('which runners dibs knows how to split, and where each puts its shard flag', async () => {
  const { sharder } = await import('../src/shard.mjs');
  assert.deepEqual(sharder(['npx', 'playwright', 'test', 'a.spec.ts']).at(2, 3), ['npx', 'playwright', 'test', '--shard=2/3', 'a.spec.ts']);
  assert.deepEqual(sharder(['npx', 'vitest', 'run']).at(1, 2), ['npx', 'vitest', 'run', '--shard=1/2']);
  assert.deepEqual(sharder(['node', '--test', 'test/a.test.mjs']).at(1, 2), ['node', '--test', '--test-shard=1/2', 'test/a.test.mjs']);
  assert.equal(sharder(['npm', 'test']), null, 'a script: dibs can\'t see its runner');
  assert.equal(sharder(['npx', 'playwright', 'test', '--shard=1/4']), null, 'already split');
});
