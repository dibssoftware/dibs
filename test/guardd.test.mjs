// The resident guard: the hook answered by `dibs guard serve` over its socket,
// the same as the Node hook would answer, and the Node hook whenever the
// service is down, hung or answers anything but ok.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, bg, until, env, HOOK } from './helpers.mjs';
import { frame } from '../src/guardd.mjs';

const WIN = process.platform === 'win32';
const which = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const NO_CURL = WIN || !which('curl');

const input = (command, mode = 'default') => JSON.stringify({ session_id: 'gd-session', hook_event_name: 'PreToolUse', tool_name: 'Bash',
  permission_mode: mode, cwd: '/tmp', tool_input: { command } });
// The hook run the way Claude Code runs it: the file itself, so sh reads line 2.
const viaScript = (home, json, extra = {}) => spawnSync(HOOK, [], { input: json, env: { ...env(home), ...extra }, encoding: 'utf8', timeout: 30000 });
const viaNode = (home, json, extra = {}) => spawnSync(process.execPath, [HOOK], { input: json, env: { ...env(home), ...extra }, encoding: 'utf8', timeout: 30000 });

// A PATH with what the client needs and no node: an answer then can only have come from the service.
function noNode(t) {
  const bin = tmp(t, 'nonode');
  for (const n of ['cat', 'env', 'curl', 'sh']) fs.symlinkSync(which(n), path.join(bin, n));
  return bin;
}

async function service(t, home) {
  const p = bg(t, home, ['guard', 'serve']);
  await until(() => fs.existsSync(path.join(home, 'guard.sock')));
  return p;
}

const CASES = [
  ['a heavy command in a default session', input('npm test')],
  ['a heavy command under bypassPermissions', input('xcodebuild -scheme App build', 'bypassPermissions')],
  ['a quick read', input('ls -la')],
  ['an rm of a folder named by a variable', input('rm -rf "$GD_DIR"')],
  ['input that is not JSON', 'not json at all'],
];

test('the resident guard answers every call exactly as the Node hook does, without starting Node', { skip: NO_CURL }, async t => {
  const home = tmp(t);
  await service(t, home);
  const PATH = noNode(t);
  for (const [what, json] of CASES) {
    // The variable is the session's own: the service must see the hook's environment, not its own.
    for (const extra of [{}, { GD_DIR: '/tmp/gd-example/build' }]) {
      const fast = viaScript(home, json, { ...extra, PATH });
      const slow = viaNode(home, json, { ...extra, PATH });
      assert.equal(fast.status, 0, `${what}: ${fast.stderr}`);
      assert.equal(fast.stdout, slow.stdout, what);
    }
  }
  const heavy = viaScript(home, input('npm test'), { PATH });
  assert.match(heavy.stdout, /"permissionDecision":"deny"/, 'the service answered: there was no node to fall back to');
});

test('with no service running, the hook starts Node and answers as before', { skip: WIN }, t => {
  const home = tmp(t);
  const r = viaScript(home, input('npm test'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, viaNode(home, input('npm test')).stdout);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});

test('a service that hangs, or answers anything but ok, is passed over for the Node hook', { skip: NO_CURL }, async t => {
  for (const reply of [null, 'HTTP/1.1 500 Internal Server Error\r\ncontent-length: 4\r\n\r\nnope', 'HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nnope\n']) {
    const home = tmp(t);
    const server = net.createServer(s => { s.on('error', () => {}); if (reply) s.on('data', () => s.end(reply)); });
    await new Promise(r => server.listen(path.join(home, 'guard.sock'), r));
    try {
      const t0 = Date.now();
      // Async, so this process's server can answer while the hook waits on it.
      const r = await new Promise(resolve => {
        const p = spawn(HOOK, [], { env: env(home) });
        let out = '', err = '';
        p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
        p.on('exit', code => resolve({ status: code, stdout: out, stderr: err }));
        p.stdin.end(input('npm test'));
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /"permissionDecision":"deny"/, `reply ${reply}`);
      if (!reply) assert.ok(Date.now() - t0 >= 1800, 'it gave the hung one its 2 s');
    } finally { server.close(); }
  }
});

test('a frame is whole only once the hook input after the environment has its NUL', () => {
  const whole = Buffer.from('123\0/tmp\0A=1\0B=x=y\0\0{"a":1}\0');
  assert.deepEqual(frame(whole), { ppid: 123, cwd: '/tmp', env: { A: '1', B: 'x=y' }, input: '{"a":1}' });
  assert.equal(frame(whole.subarray(0, whole.length - 1)), null);
  assert.equal(frame(Buffer.from('123\0/tmp\0A=1\0')), null);
});

test('dibs service install guard keeps the resident guard running under launchd', { skip: process.platform !== 'darwin' }, t => {
  const home = tmp(t), agents = tmp(t, 'agents'), bin = tmp(t, 'fakebin');
  // Nothing loaded before: print says no, everything else works.
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\n[ "$1" = print ] && exit 1\nexit 0\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(path.dirname(HOOK), 'dibs.mjs'), 'service', 'install', 'guard'],
    { env: { ...env(home), DIBS_LAUNCHCTL: path.join(bin, 'launchctl'), DIBS_LAUNCH_AGENTS: agents }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plist = fs.readFileSync(path.join(agents, 'dev.dibs.guard.plist'), 'utf8');
  assert.match(plist, /<string>guard<\/string><string>serve<\/string>/);
  assert.match(plist, /Interactive/);
});
