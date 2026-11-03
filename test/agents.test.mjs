// The subagent limit: the guard hook on Agent spawns and subagent starts and
// stops, run as Claude Code runs it, against throwaway DIBS_HOMEs and settings files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, env, sync, track, until, HOOK, posixOnly } from './helpers.mjs';
import { install, remove, installed } from '../src/guard.mjs';

function setup(t, slots) {
  const home = tmp(t, 'agents');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: { slots } }));
  return home;
}

function hook(home, input, opts = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: env(home, opts), encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

let n = 0;
const spawnAgent = (session, cwd = '/work/app') => ({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { description: 'look around', prompt: 'x', subagent_type: 'Explore' }, tool_use_id: `toolu_${++n}` });
const started = (session, id) => ({ session_id: session, cwd: '/work/app', hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'Explore' });
const stopped = (session, id) => ({ session_id: session, cwd: '/work/app', hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'Explore' });
const denied = out => out?.hookSpecificOutput?.permissionDecision === 'deny';

// Spawn one subagent for a session, all the way to running.
function run(home, session, id, opts) {
  const out = hook(home, spawnAgent(session), opts);
  assert.equal(out, null, `spawn ${id} should go through: ${JSON.stringify(out)}`);
  hook(home, started(session, id), opts);
}

test('spawns go through under the limit and are denied at it, saying who runs what', t => {
  const home = setup(t, 2);
  run(home, 'sess-a', 'a1', { agent: 'web-app' });
  run(home, 'sess-a', 'a2', { agent: 'web-app' });
  const out = hook(home, spawnAgent('sess-a'), { agent: 'web-app' });
  assert.ok(denied(out), JSON.stringify(out));
  const why = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(why, /2 subagents are running on this machine and the limit is 2 \(you x2\)/);
  assert.match(why, /Nothing was started/);
  assert.match(why, /wait until one reports back, then spawn this one again/);
  // The older name of the tool counts the same.
  assert.ok(denied(hook(home, { ...spawnAgent('sess-a'), tool_name: 'Task' }, { agent: 'web-app' })));
  // Everyone can see them on the board.
  assert.match(sync(home, ['--detail']).out, /subagents: 2 of 2 running \(web-app x2\)/);
  assert.match(sync(home, []).out, /^Subagents {6}2 of 2 running \(2 for web-app\)$/m);
  assert.equal(sync(home, ['--json']).code, 0);
});

test('a subagent that stops frees its slot', t => {
  const home = setup(t, 1);
  run(home, 'sess-a', 'a1');
  assert.ok(denied(hook(home, spawnAgent('sess-a'))));
  // Internal agents (no type) and ids never counted change nothing.
  hook(home, { ...stopped('sess-a', 'other'), agent_type: '' });
  assert.ok(denied(hook(home, spawnAgent('sess-a'))));
  hook(home, stopped('sess-a', 'a1'));
  assert.equal(hook(home, spawnAgent('sess-a')), null);
});

test('a session with no subagents running may start one even at the limit, but not two', t => {
  const home = setup(t, 2);
  run(home, 'big', 'b1', { agent: 'fanout' });
  run(home, 'big', 'b2', { agent: 'fanout' });
  const out = hook(home, spawnAgent('small'), { agent: 'quiet' });
  assert.equal(out, null, 'the first one is never denied');
  hook(home, started('small', 's1'), { agent: 'quiet' });
  const second = hook(home, spawnAgent('small'), { agent: 'quiet' });
  assert.ok(denied(second));
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /3 subagents are running .*\(fanout x2, you\)/);
  assert.ok(denied(hook(home, spawnAgent('big'), { agent: 'fanout' })), 'the big fan-out stays capped');
});

test('a spawn the guard let through counts before its subagent starts, so a burst stops at the limit', t => {
  const home = setup(t, 2);
  assert.equal(hook(home, spawnAgent('sess-a')), null);
  assert.equal(hook(home, spawnAgent('sess-a')), null);
  assert.ok(denied(hook(home, spawnAgent('sess-a'))), 'two kept slots fill the limit');
  // Starting turns a kept slot into the subagent's own, not a second one.
  hook(home, started('sess-a', 'a1'));
  hook(home, started('sess-a', 'a2'));
  const out = hook(home, spawnAgent('sess-a'));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /2 subagents are running/);
});

test('subagents of a session whose process exits stop counting', { skip: posixOnly('the stand-in for Claude Code is node behind a symlink named claude, which Windows lets only an administrator make') }, async t => {
  const home = setup(t, 2);
  // A stand-in for a Claude Code session: a process named claude that runs the
  // hook itself, the way Claude Code does, then stays up until killed.
  const dir = tmp(t, 'session');
  const claude = path.join(dir, 'claude');
  fs.symlinkSync(process.execPath, claude);
  const e = env(home, { agent: 'gone' });
  delete e.DIBS_NO_SESSION;
  const script = `
    const { execFileSync } = require('node:child_process');
    for (const input of ${JSON.stringify([spawnAgent('dying'), started('dying', 'd1')])})
      execFileSync(process.execPath, [${JSON.stringify(HOOK)}], { input: JSON.stringify(input), env: process.env });
    console.log('ready');
    setInterval(() => {}, 1e6);`;
  const p = track(t, spawn(claude, ['-e', script], { env: e, stdio: ['ignore', 'pipe', 'inherit'] }));
  let out = '';
  p.stdout.on('data', d => (out += d));
  await until(() => out.includes('ready'));
  run(home, 'alive', 'x1', { agent: 'stays' });
  assert.ok(denied(hook(home, spawnAgent('alive'), { agent: 'stays' })), 'the other session still counts');
  p.kill('SIGKILL');
  await p.done;
  assert.equal(hook(home, spawnAgent('alive'), { agent: 'stays' }), null);
});

test('with no limit set (the default) or agents: false, spawns are never limited, and Bash calls never touch it', t => {
  const fresh = tmp(t, 'agents');   // no config.json: the default
  for (let i = 0; i < 20; i++) assert.equal(hook(fresh, spawnAgent('s')), null);
  const home = tmp(t, 'agents');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: false }));
  for (let i = 0; i < 8; i++) assert.equal(hook(home, spawnAgent('s')), null);
  const busy = setup(t, 1);
  run(busy, 's', 'a1');
  assert.equal(hook(busy, { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  assert.ok(!fs.existsSync(path.join(home, 'agents.json')));
});

test("the subagent ledger and file lease notes share one DIBS_HOME without touching each other", t => {
  const home = setup(t, 2);
  run(home, 'sess-a', 'a1');
  // A subagent's Bash call taking a file lease: the guard leaves a note in agents/ for dibs to claim.
  const out = hook(home, { session_id: 'sess-a', agent_id: 'a1', agent_type: 'Explore', cwd: home, hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_input: { command: 'dibs hold files:src/x.ts -m why' } });
  assert.equal(out, null);
  assert.equal(fs.readdirSync(path.join(home, 'agents')).filter(n => n.endsWith('.json')).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8')).agents.map(a => a.id), ['a1']);
  hook(home, stopped('sess-a', 'a1'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8')).agents, []);
  assert.equal(fs.readdirSync(path.join(home, 'agents')).filter(n => n.endsWith('.json')).length, 1, 'the note is still there for dibs');
});

test('install upgrades an older Bash-only install to every hook entry, once', t => {
  const file = path.join(tmp(t), 'settings.json');
  const cmd = '/opt/dibs/bin/dibs-guard.mjs';
  const before = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/other-hook.sh' }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  const older = structuredClone(before);
  older.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
  fs.writeFileSync(file, JSON.stringify(older, null, 2));
  assert.equal(installed(file).command, cmd);

  assert.match(install(file, cmd), /updated/);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ours = ev => s.hooks[ev].filter(g => g.hooks.some(h => h.command === cmd));
  assert.deepEqual(ours('PreToolUse').map(g => g.matcher), ['Bash|Edit|Write|MultiEdit|NotebookEdit', 'Agent|Task']);
  assert.deepEqual(ours('SubagentStart'), [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]);
  assert.deepEqual(ours('SubagentStop'), [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]);
  assert.deepEqual(s.hooks.SubagentStop[0], before.hooks.SubagentStop[0], "someone else's stop hook stays");

  const text = fs.readFileSync(file, 'utf8');
  assert.match(install(file, cmd), /already installed/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);

  assert.match(remove(file), /removed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
});
