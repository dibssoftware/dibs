// What a waiting or running dibs costs. On 2026-10-15, 45 of them held 2.4 GB:
// each poll ranked the line by scanning all history per comparison, rewrote
// the state file, and V8 kept the heap that garbage grew.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, BIN, tmp, bg, until, board, env, track, group, posixOnly } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict, forecast } from '../src/schedule.mjs';
import { plainBoard } from '../src/plain.mjs';
import { dibsMem } from '../src/platform.mjs';

const T = Date.now();
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, ...o });
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['test'], who: `l${n}`, mem: 2 * G, cpu: 2, start: T - 120e3, pid: 1, key: 'k', ...o });
const waiter = o => ({ id: ++n, res: ['test'], who: 'me', mem: 2 * G, cpu: 2, disk: 0, pid: 1, enq: T, key: 'test|npm test', kind: 'run', ...o });
// The Mac that day: 7 GB of swap and 6 GB of disk free.
const STUCK = { swapUsed: 7 * G, diskFree: 6 * G };

function judge(s, me, c, m = {}, hist = []) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memTotal: 16 * G, memFree: 40, swapGrowth: 0, diskDrain: 0, ...m });
  try { return verdict(s, me, c, hist, T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}

test("dibs's own processes are never the reason the swap gate holds", () => {
  const me = waiter({ res: ['heavy'] });
  const s = { leases: [lease()], queue: [me] };
  // 5 GB of swap, growing, 2 GB of it what dibs's own waiters could account for: 3 GB is under maxSwap (4G).
  assert.equal(judge(s, me, cfg(), { swapUsed: 5 * G, dibsMem: 2 * G, swapGrowth: 1 * G, diskFree: 20 * G }).ok, true);
  assert.equal(judge(s, me, cfg(), { swapUsed: 5 * G, dibsMem: 0, swapGrowth: 1 * G, diskFree: 20 * G }).rule, 'swap', 'without them it would hold');
  // Short of disk for it to grow into, growing swap holds whoever is in it.
  assert.equal(judge(s, me, cfg(), { swapUsed: 5 * G, dibsMem: 2 * G, swapGrowth: 1 * G, diskFree: 6 * G }).rule, 'swaproom');
  // Flat swap holds nothing (0.0.102): it's left over.
  assert.equal(judge(s, me, cfg(), { swapUsed: 5 * G, dibsMem: 0, diskFree: 6 * G }).ok, true);
});

test('the real machine reading counts the memory of every dibs process', () => {
  const procs = [
    { args: 'node /Users/x/bin/dibs run test -- npm test', rss: 50 * 2 ** 20 },
    { args: '/opt/homebrew/bin/node --max-semi-space-size=1 /Users/x/dibs/bin/dibs.mjs hold sim', rss: 40 * 2 ** 20 },
    { args: 'node /Users/x/dibs/bin/dibs-guard.mjs', rss: 30 * 2 ** 20 },
    { args: 'node /Users/x/proj/node_modules/.bin/vitest', rss: 900 * 2 ** 20 },
  ];
  assert.equal(dibsMem(procs), 90 * 2 ** 20);
});

test("a waiter's turn through a line of 40 reads the 1000 lines of history once, not once per waiter per comparison", () => {
  // Each poll ranks the whole line. Scanning all history for each waiter in
  // each comparison took 100 ms per poll, every 1.5 s, in every waiter.
  // Counted in reads, not milliseconds, so a busy machine can't fail it.
  const lines = Array.from({ length: 1000 }, (_, i) => ({ key: `test|npm test / x${i % 30}`, dur: 60e3, who: `a${i % 40}`, at: T - (i % 50) * 6e4 }));
  let reads = 0;
  const hist = new Proxy(lines, { get: (a, k) => { if (/^\d+$/.test(String(k))) reads++; return Reflect.get(a, k); } });
  const leases = Array.from({ length: 30 }, (_, i) => lease({ who: `a${i}`, res: [i % 2 ? 'test' : 'files:/x/' + i], key: `test|npm test / x${i}` }));
  const queue = Array.from({ length: 40 }, (_, i) => waiter({ who: `a${i}`, enq: T - i * 1000, key: `test|npm test / x${i % 30}` }));
  const s = { leases, queue, seq: 200 };
  const me = queue[0];
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...STUCK, memTotal: 16 * G, memFree: 40, swapGrowth: 0, diskDrain: 0 });
  try {
    for (let i = 0; i < 10; i++) { verdict(s, me, cfg(), hist, T); plainBoard(s, cfg(), hist, T, undefined, me); forecast(s, cfg(), hist, T); }
    assert.ok(reads <= 2 * lines.length, `ten polls read history lines ${reads} times`);
  } finally { process.env.DIBS_FAKE_MACHINE = was; }
});

test('the real CLI: a poll that changes nothing leaves the state file alone', async t => {
  const h = tmp(t);
  // No measuring after the first, which would write its reading.
  const quiet = { env: { DIBS_SAMPLE_MS: '3600000' } };
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources: { one: { slots: 1, mem: '1G' } } }));
  // A job that uses no CPU, so its idle mark (a real change) is set once and stays.
  const first = bg(t, h, ['run', 'one', '--', 'sleep', '60'], { ...quiet, agent: 'a' });
  await until(() => board(h).held.length === 1);
  const second = bg(t, h, ['run', 'one', '--', 'true'], { ...quiet, agent: 'b' });
  await until(() => board(h).waiting.length === 1);
  // Two real changes come once each: the job's first measurement, and its idle mark, set by the
  // first look at the process table after a just-started process's CPU share falls under 1%.
  // At load 40 both could land in the six seconds below, and a third write would pass unseen.
  const lease = () => JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).leases[0] || {};
  await until(() => lease().use && lease().idleSince);
  // Six seconds of the waiter's polls, 1.5 s apart: every one used to rewrite the file.
  const seen = new Set();
  for (const t0 = Date.now(); Date.now() - t0 < 6000; await new Promise(r => setTimeout(r, 200))) seen.add(fs.statSync(path.join(h, 'state.json')).mtimeMs);
  assert.equal(seen.size, 1, `the state file was written ${seen.size - 1} times`);
  first.kill('SIGTERM');
  await first.done;
  assert.equal(await second.done, 0);
});

test("the real CLI: dibs started by its own first line (as ~/bin/dibs is) runs with V8's low-memory settings", { skip: posixOnly("Windows runs no script by its #! line; there bin/dibs.mjs starts as node bin/dibs.mjs") }, async t => {
  const h = tmp(t), bin = tmp(t, 'bin'), cwd = tmp(t, 'job');
  const link = path.join(bin, 'dibs');
  fs.symlinkSync(BIN, link);
  const p = track(t, spawn(link, ['run', 'test', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { env: env(h), cwd, stdio: 'ignore' }));
  await until(() => board(h).held.length === 1);
  const args = execFileSync('ps', ['-o', 'args=', '-p', String(p.pid)], { encoding: 'utf8' });
  // As the shell's own Node, which got in line and runs it (src/broker.mjs inlineCall), or after a wait.
  assert.match(args, /node --max-semi-space-size=1 \S+\/dibs(\.mjs)? (_enqueue \d+ \d+ \S+ )?run (--lease \d+ )?test/);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await p.done, 0);
});

test("dibs's Node settings keep fetch working, which every call to the coordinator needs", async t => {
  // --lite-mode shipped in 0.0.96 and turned off WebAssembly, which fetch needs: dibs machines and every remote call failed.
  const { LEAN } = await import('../src/util.mjs');
  const line = fs.readFileSync(BIN, 'utf8').split('\n')[1];
  const shFlags = line.match(/exec node (.*?) "\$0"/)[1].split(' ');
  const thin = fs.readFileSync(path.join(path.dirname(BIN), '..', 'src', 'thin.sh'), 'utf8').match(/^N="node (.*)"$/m)[1].split(' ');
  assert.deepEqual(shFlags, LEAN, 'bin/dibs.mjs passes LEAN');
  assert.deepEqual(thin, LEAN, 'src/thin.sh passes LEAN');
  const http = await import('node:http');
  const srv = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1');
  t.after(() => srv.close());
  await new Promise(r => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const out = await new Promise((res, rej) => {
    const p = spawn(process.execPath, [...LEAN, '-e', `fetch(${JSON.stringify(url)}).then(r => r.text()).then(console.log, e => { console.log(String(e.cause || e)); process.exit(1); })`]);
    let o = ''; p.stdout.on('data', d => (o += d)); p.on('exit', c => (c === 0 ? res(o) : rej(new Error(o))));
  });
  assert.equal(out.trim(), 'ok');
});

test('the real CLI under LEAN reaches a coordinator: a waiter started by bin/dibs, and a dibs the broker, later or worker spawns', { skip: posixOnly("Windows runs no script by its #! line; there bin/dibs.mjs starts as node bin/dibs.mjs") }, async t => {
  // The services (serve, worker, throttle) start plain node from launchd (src/service.mjs) and never get LEAN.
  const { LEAN } = await import('../src/util.mjs');
  const g = await group(t);
  const bin = tmp(t, 'bin'), link = path.join(bin, 'dibs');
  fs.symlinkSync(BIN, link);
  const viaBin = execFileSync(link, ['machines', '--json'], { env: env(g.hc), encoding: 'utf8' });
  assert.equal(JSON.parse(viaBin).machines.length, 2);
  const viaSpawn = execFileSync(process.execPath, [...LEAN, BIN, 'machines', '--json'], { env: env(g.hc), encoding: 'utf8' });
  assert.equal(JSON.parse(viaSpawn).machines.length, 2);
});
