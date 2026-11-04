// What every test file needs: the real CLI in a throwaway DIBS_HOME, waiting
// for a condition, and a simulated group of machines. Everything a test
// starts or creates is registered against it and torn down when it ends,
// pass or fail: processes first, then folders.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'dibs.mjs');
export const HOOK = path.join(ROOT, 'bin', 'dibs-guard.mjs');
export const G = 1024 ** 3;
export const wait = ms => new Promise(r => setTimeout(r, ms));

// Whether a job is paused or running, from the state of every process in its
// group (ps T is stopped). A job's own progress says the same thing only when
// it gets a core, and a low or idle job runs at background priority, which the
// full suite at load 15 to 24 can leave without one for 30 seconds or more.
const groupStates = pgid => (pgid ? spawnSync('ps', ['-o', 'stat=', '-g', String(pgid)], { encoding: 'utf8' }).stdout.split('\n').map(x => x.trim()).filter(Boolean) : []);
// A child that exited under a stopped parent stays a zombie (Z) until it's reaped: that counts as stopped.
// D (in the kernel) counts as stopped: a stop already sent takes it as it leaves (src/platform.mjs runningIn).
// U is macOS's D: a writer throttled while other work writes (src/platform.mjs inKernelOrStopped,
// not imported here: no src module may load before this file has set DIBS_HOME).
export const allStopped = pgid => { const s = groupStates(pgid); return s.some(x => x.includes('T')) && s.every(x => /[TZDU]/.test(x)); };
export const noneStopped = pgid => groupStates(pgid).every(x => !x.includes('T'));
// Every process in the group at background priority (background QoS on macOS, ps pri 4; nice 10
// on Linux), or none of them. A group that's gone is neither.
// A zombie (an exited child its parent hasn't reaped yet, which at background priority under
// load can take seconds) has no priority left to read, and counts as neither.
const priorities = pgid => (pgid ? spawnSync('ps', ['-o', 'pri=,nice=,stat=', '-g', String(pgid)], { encoding: 'utf8' }).stdout.split('\n').map(x => x.trim().split(/\s+/))
  .filter(([, , stat]) => stat && !stat.startsWith('Z')).map(([pri, ni]) => [Number(pri), Number(ni)]) : []);
const isLow = ([pri, ni]) => (process.platform === 'darwin' ? pri === 4 : ni >= 10);
export const allLow = pgid => { const p = priorities(pgid); return p.length > 0 && p.every(isLow); };
export const noneLow = pgid => { const p = priorities(pgid); return p.length > 0 && !p.some(isLow); };
export const groupTree = pgid => spawnSync('ps', ['-o', 'pid=,stat=,command=', '-g', String(pgid)], { encoding: 'utf8' }).stdout;

// A machine with room to spare, so nothing waits on this Mac's real memory or disk.
// 16 GB of memory whatever the host has: sizes are learned up to the machine's memory, and tests
// written on a 16 GB Mac failed on an 8 GB Linux VM (2026-10-18).
export const MACHINE = { diskFree: 1e12, swapUsed: 0, memFree: 90, load: 0, memTotal: 16 * 1024 ** 3 };
// Coordinator timeouts short enough for a test to see a machine go missing,
// and long enough that a worker or sender that is only slow (the whole suite
// at background priority, on the efficiency cores) isn't taken for gone.
// Silence is what these measure, so there's no condition to wait on instead.
const TIMING = JSON.stringify({ beatHold: 800, workerLost: 10e3, clientLost: 10e3 });
// How long a process gets to exit on SIGTERM (and take its process tree with it) before SIGKILL.
const TERM_GRACE = 5000;

// src modules read DIBS_HOME and the machine when they load. Test files import
// this file before any of them, so code run in-process never sees the real
// ~/.dibs or this Mac's memory.
export const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-inprocess-'));
process.env.DIBS_HOME = HOME;
process.env.DIBS_FAKE_MACHINE = JSON.stringify(MACHINE);
for (const k of ['DIBS_LEASE', 'DIBS_REMOTE_JOB', 'DIBS_LATER_JOB']) delete process.env[k];
// src/simctl.mjs picks the fake when it loads, so no test, in-process or spawned,
// can reach the real CoreSimulator. simpool.test.mjs fills this file with devices.
export const SIMCTL = path.join(HOME, 'simctl.json');
fs.writeFileSync(SIMCTL, JSON.stringify({ runtimes: [], devices: [], log: [] }));
process.env.DIBS_FAKE_SIMCTL = SIMCTL;
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// One teardown per test (or per suite, see shared()), however many things it registers.
const scopes = new WeakMap();
function scope(t) {
  let s = scopes.get(t);
  if (!s) {
    s = { procs: [], dirs: [] };
    scopes.set(t, s);
    t.after(async () => {
      await Promise.all(s.procs.map(stop));
      // A dibs still saving its last state when its parent shell exits can add a
      // file mid-delete (ENOTEMPTY); rmSync's own retries ride that out.
      for (const d of s.dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
  }
  return s;
}

// A stand-in for `t` that lives as long as the enclosing describe() or file,
// for a fixture several tests share. Call it where the suite is declared.
export function shared() {
  const hooks = [];
  after(async () => { for (const f of hooks) await f(); });
  return { after: f => hooks.push(f) };
}

async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill('SIGTERM');
  const timer = setTimeout(() => p.kill('SIGKILL'), TERM_GRACE);
  await p.done;
  clearTimeout(timer);
}

export function tmp(t, name = 'test') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `dibs-${name}-`));
  scope(t).dirs.push(d);
  return d;
}

// opts: agent (default 'tester'), load (the fake machine's load), env (merged last), cwd.
export function env(home, opts = {}) {
  // The suite usually runs inside Claude Code, where dibs waits without a limit;
  // a test that wants that sets these itself.
  // Nor does a test inherit the agent markers that name the caller an agent
  // (src/owner.mjs actor); a test that wants an agent's call passes AGENT.
  const e = { ...process.env, CLAUDECODE: undefined, CLAUDE_CODE_CHILD_SESSION: undefined, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined,
    CLAUDE_CODE_SIMPLE: undefined, CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, AI_AGENT: undefined,
    CODEX_SANDBOX: undefined, CODEX_THREAD_ID: undefined, CURSOR_AGENT: undefined, GEMINI_CLI: undefined, OPENCODE: undefined,
    DIBS_MAX_WAIT: undefined, FORCE_COLOR: undefined, NO_COLOR: undefined,
    // Nor what a suite run as a dibs job carries: on another machine, DIBS_REMOTE_JOB made every
    // dibs a test started follow its parent and act as a shipped job (4 failures on boat-1, 2026-10-19).
    DIBS_LEASE: undefined, DIBS_REMOTE_JOB: undefined, DIBS_LATER_JOB: undefined,
    // Nor this runner's own: a job that runs node --test would think it's one of our files and skip its own.
    NODE_TEST_CONTEXT: undefined, DIBS_SHARD: undefined,
    DIBS_HOME: home, DIBS_NO_SESSION: '1', DIBS_AGENT: opts.agent ?? 'tester', DIBS_SERVE_TIMING: TIMING,
    DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, load: opts.load || 0 }), ...opts.env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

export function sync(home, args, opts = {}) {
  const r = spawnSync(process.execPath, [opts.bin || BIN, ...args], { env: env(home, opts), cwd: opts.cwd, encoding: 'utf8', timeout: 60000,
    maxBuffer: 64 * 1024 ** 2, input: opts.input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A background dibs. p.done resolves to the exit code, or the signal name if it was killed.
export function bg(t, home, args, opts = {}) {
  const p = spawn(process.execPath, [BIN, ...args], { env: env(home, opts), cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', d => (p.out += d));
  p.stderr.on('data', d => (p.err += d));
  p.done = exited(p);
  scope(t).procs.push(p);
  return p;
}

// The exit code once the process has exited and what it printed has been read. Node can emit
// 'exit' before the last of its output reaches 'data': on Linux CI a listener that printed its
// message and exited 0 read as having printed nothing (2026-11-04). A child that leaves the
// pipes open behind it (a background grandchild) doesn't hold this up past DRAIN_FOR.
const DRAIN_FOR = 2000;
function exited(p) {
  const closed = s => new Promise(r => (s.readableEnded || s.destroyed ? r() : s.once('close', r)));
  return new Promise(r => p.once('exit', (code, sig) => {
    const late = new Promise(ok => setTimeout(ok, DRAIN_FOR));
    Promise.race([Promise.all([closed(p.stdout), closed(p.stderr)]), late]).then(() => r(code ?? sig));
  }));
}

// Any other process a test starts, so it's stopped with the rest.
export function track(t, p) {
  p.done ??= new Promise(r => p.on('exit', (code, sig) => r(code ?? sig)));
  scope(t).procs.push(p);
  return p;
}

const POLL = 100;
// The limit only catches a condition that never comes. It's generous because
// with the whole suite at background priority one CLI start can take seconds,
// and a step that starts three or four of them in turn needs most of 15s.
export async function until(fn, ms = 30e3) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await wait(POLL); }
  throw new Error(`timed out after ${ms / 1000}s waiting for: ${String(fn).replace(/\s+/g, ' ')}`);
}

// Output wraps at 100 columns: a sentence may span lines. This reads it as one.
export const flat = s => s.replace(/\n +/g, ' ');

export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function board(home, opts = {}) {
  const r = sync(home, ['--json'], { ...opts, agent: 'viewer' });
  try { return JSON.parse(r.out); } catch { throw new Error(`dibs --json printed no board (exit ${r.code}): ${r.err}`); }
}

export function port() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// Whether something accepts connections on a local port right now.
export const answers = p => new Promise(r => {
  const c = net.connect(p, '127.0.0.1', () => { c.destroy(); r(true); });
  c.on('error', () => r(false));
});
// How long a coordinator gets to start. Under the full suite on a loaded Mac
// one took longer than 30 s, in a run where every test took about 290 s; the
// suite's own per-test limit is 120 s, so waiting any longer would be pointless.
export const SERVE_START = 110e3;

export function gitProject(t, files = { 'a.txt': 'hi\n' }) {
  const d = tmp(t, 'proj');
  execFileSync('git', ['init', '-q'], { cwd: d });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), body);
  }
  return d;
}

// The person, as the Mac app calls dibs: setup commands (join, invite, kick,
// limit) are refused to anyone else. Under the test runner there's no terminal.
// The person's call, as the Mac app makes it (no agent variables).
export const PERSON = { env: { DIBS_OWNER: '1' } };
// An agent's tool call, as Claude Code makes it. Since 0.0.110 an agent may do everything the person can.
export const AGENT = { env: { CLAUDECODE: '1' } };

// Invite a machine on the coordinator and run the join line it prints there.
export function inviteAndJoin(g, home, name) {
  const inv = sync(g.h0, ['invite', name], AGENT);
  assert.equal(inv.code, 0, inv.err);
  const m = inv.out.match(/dibs join (\S+) (\S+) --name (\S+)/);
  assert.ok(m, inv.out);
  assert.equal(m[3], name);
  const j = sync(home, ['join', m[1], m[2], '--name', name], AGENT);
  assert.equal(j.code, 0, j.err);
  return { token: m[2], out: inv.out };
}

export const machinesOf = (home, opts) => JSON.parse(sync(home, ['machines', '--json'], opts).out);

// Several machines, simulated on this one: a coordinator (h0) on loopback,
// workers alpha (idle, ha) and beta (load 7, hb), sender gamma (hc), and a git
// project. invite: true gives each machine its own token, as dibs invite does;
// otherwise all three join with the group token. timing overrides the
// coordinator's timeouts. If setup fails half way, the test's teardown still
// stops whatever started.
export async function group(t, { invite = false, files, timing } = {}) {
  const g = { h0: tmp(t, 'coord'), ha: tmp(t, 'alpha'), hb: tmp(t, 'beta'), hc: tmp(t, 'gamma'), port: await port(), tok: {} };
  const env = timing && { DIBS_SERVE_TIMING: JSON.stringify({ ...JSON.parse(TIMING), ...timing }) };
  g.serve = bg(t, g.h0, ['serve', '--listen', String(g.port), '--bind', '127.0.0.1'], { env });
  await until(async () => fs.existsSync(path.join(g.h0, 'remote.json')) && await answers(g.port), SERVE_START);
  g.token = JSON.parse(fs.readFileSync(path.join(g.h0, 'remote.json'), 'utf8')).token;
  for (const [h, name] of [[g.ha, 'alpha'], [g.hb, 'beta'], [g.hc, 'gamma']]) {
    if (invite) g.tok[name] = inviteAndJoin(g, h, name).token;
    else assert.equal(sync(h, ['join', `127.0.0.1:${g.port}`, g.token, '--name', name], AGENT).code, 0);
  }
  g.wa = bg(t, g.ha, ['worker']);
  g.wb = bg(t, g.hb, ['worker'], { load: 7 });
  await until(() => { const r = sync(g.hc, ['machines', '--json']); return r.code === 0 && JSON.parse(r.out).machines.length === 2; });
  g.proj = gitProject(t, files);
  return g;
}
