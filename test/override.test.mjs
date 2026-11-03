// The owner's overrides: boost, pause, resume, stop and cap, run through the
// real CLI against real processes, and the gate that keeps agents out of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync as dibs, bg, until, board, alive, wait, allStopped, noneStopped } from './helpers.mjs';
import { MACHINE, flat, groupTree, allLow, noneLow } from './helpers.mjs';

const WIN = process.platform === 'win32';
const CONFIG = { resources: {
  t: { slots: 1, mem: '0.1G', cpu: 1, pausable: true },
  d: { slots: 1, mem: '0.1G', cpu: 1, pausable: false },
} };
function home(t) {
  const h = tmp(t, 'owner');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(CONFIG));
  return h;
}
// The person: no terminal under the test runner, so DIBS_OWNER=1, as the Mac app sets it.
const owner = (h, args, env = {}) => dibs(h, args, { agent: 'person', env: { DIBS_OWNER: '1', ...env } });
const held = (h, who) => board(h).held.find(l => l.who === who);
const waiter = (h, who) => board(h).waiting.find(q => q.who === who);
// Its group paused: nothing in it still running. Checking the leader alone missed it on Linux,
// where a loop shell sits in D, not T, while the vfork child the stop caught is stopped (2026-10-25).
const stopped = pgid => allStopped(pgid);

// A job that counts as fast as it can, so a stopped one is easy to see.
function counter(t, h, agent, res, prio = 'normal') {
  const file = path.join(h, `count-${agent}`);
  const p = bg(t, h, ['run', res, '-p', prio, '-m', 'counting', '--', 'sh', '-c', `i=0; while :; do i=$((i+1)); echo $i > ${file}; sleep 0.05; done`], { agent });
  p.count = () => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; } };
  p.lease = () => held(h, agent);
  return p;
}
// Paused: every process in its group stopped. Running: none stopped. Watching
// the counter instead failed under the full suite's load, where a job at
// background priority can go 30 seconds without a core (helpers.mjs).
const paused = p => until(() => allStopped(p.lease()?.pgid), 10e3);
async function runs(p, ms = 30e3) {
  const pgid = p.lease()?.pgid;
  try { await until(() => noneStopped(pgid), ms); return true; } catch { return false; }
}
// Holds t until the gate file appears, so the waiters behind it stay waiting.
function blocker(t, h) {
  const gate = path.join(h, 'gate');
  const p = bg(t, h, ['run', 't', '--', 'sh', '-c', `while [ ! -f '${gate}' ]; do sleep 0.1; done`], { agent: 'first' });
  p.open = () => fs.writeFileSync(gate, '');
  return p;
}

test('boost re-ranks a waiter: the boosted one goes first and the board says the owner did it', async t => {
  const h = home(t);
  const order = path.join(h, 'order');
  const first = blocker(t, h);
  await until(() => held(h, 'first'));
  const early = bg(t, h, ['run', 't', '--', 'sh', '-c', `echo early >> ${order}`], { agent: 'early' });
  await until(() => waiter(h, 'early'));
  const late = bg(t, h, ['run', 't', '-p', 'low', '--', 'sh', '-c', `echo late >> ${order}`], { agent: 'late' });
  await until(() => waiter(h, 'late'));
  assert.deepEqual(board(h).waiting.map(q => q.who), ['early', 'late']);
  const id = waiter(h, 'late').id;
  const r = owner(h, ['boost', String(id), 'high']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`#${id} late's t wait: low -> high, now #1 in the queue`));
  assert.deepEqual(board(h).waiting.map(q => q.who), ['late', 'early']);
  assert.equal(waiter(h, 'late').owner.act, 'boost');
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, new RegExp(`late .*\\[high, boosted by owner.*#${id}`));
  first.open();
  assert.equal(await late.done, 0);
  assert.equal(await early.done, 0);
  assert.deepEqual(fs.readFileSync(order, 'utf8').trim().split('\n'), ['late', 'early']);
  // By agent name, everything of theirs; nothing of theirs: exit 1.
  assert.equal(owner(h, ['boost', 'late', 'idle']).code, 1);
});

test('pausing a job that forks all the time stops every process in it, even one forked as the stop went out', { skip: WIN }, async t => {
  // 2026-10-16: a bare SIGSTOP to such a group left a child forked at that moment running in
  // 1 try of 30, so preempt.mjs stops until nothing in the group runs. Through dibs pause the
  // race is rarer still: this passed 3 runs of 3 on 0.0.105. It guards that every process
  // stops, not the race itself.
  const h = home(t);
  const job = bg(t, h, ['run', 't', '-m', 'forking', '--', 'sh', '-c', 'while :; do sleep 3 & sleep 0.005; done'], { agent: 'forks' });
  await until(() => held(h, 'forks')?.pgid);
  const { id, pgid } = held(h, 'forks');
  for (let i = 0; i < 10; i++) {
    assert.equal(owner(h, ['pause', String(id)]).code, 0);
    // On failure, what was still running and whether the pause gave up (cool.log), to tell a missed child from a slow stop.
    await until(() => allStopped(pgid), 10e3).catch(e => { throw new Error(`${e.message}\n${groupTree(pgid)}\ncool.log: ${(() => { try { return fs.readFileSync(path.join(h, 'cool.log'), 'utf8'); } catch { return 'none'; } })()}`); });
    assert.equal(owner(h, ['resume', String(id)]).code, 0);
    await until(() => noneStopped(pgid), 30e3);
  }
  job.kill('SIGTERM');
  await job.done;
});

test('boost of a running low job moves it off background priority, and back', { skip: WIN }, async t => {
  const h = home(t);
  const job = counter(t, h, 'slow', 't', 'low');
  await until(() => held(h, 'slow')?.pgid);
  assert.equal(held(h, 'slow').background, true, 'a low run starts on background priority');
  const { id, pgid } = held(h, 'slow');
  await until(() => allLow(pgid));
  const up = owner(h, ['boost', String(id), 'high']);
  assert.equal(up.code, 0, up.err);
  assert.match(up.out, /low -> high, moved off background priority/);
  // Really moved, and what it starts from now on with it. Until 2026-11-01 a run started
  // at background priority on macOS stayed there whatever boost said. Linux lets only root raise it.
  const tree = () => spawnSync('ps', ['-o', 'pid=,pri=,nice=,stat=,command=', '-g', String(pgid)], { encoding: 'utf8' }).stdout;
  if (process.platform === 'darwin') await until(() => noneLow(pgid), 10e3).catch(e => { throw new Error(`${e.message}\n${up.out}\n${tree()}`); });
  let l = held(h, 'slow');
  assert.equal(l.prio, 'high');
  assert.equal(l.background, false);
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, /\[high\]  \[boosted by owner\]/);
  // An urgent waiter can't pause a high job, so it waits instead.
  const urgent = bg(t, h, ['run', 't', '-p', 'urgent', '-m', 'now', '--', 'true'], { agent: 'boss' });
  await until(() => waiter(h, 'boss'));
  assert.equal(held(h, 'slow').pausedAt, undefined);
  assert.equal(await runs(job), true);
  urgent.kill('SIGTERM');
  await urgent.done;
  const down = owner(h, ['boost', String(id), 'idle']);
  assert.match(down.out, /high -> idle, moved to background priority .*urgent and high work may now pause it/);
  l = held(h, 'slow');
  assert.equal(l.background, true);
  await until(() => allLow(pgid)).catch(e => { throw new Error(`${e.message}\n${down.out}\n${tree()}`); });
  assert.equal(l.owner.act, 'boost');
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, /\[idle\]  \[lowered by owner\]/);
});

test('the owner pauses a running job of any priority and resumes it, and its agent is told both', { skip: WIN }, async t => {
  const h = home(t);
  const job = counter(t, h, 'busy', 't', 'normal');
  await until(() => held(h, 'busy')?.pgid);
  const { id, pgid } = held(h, 'busy');
  const r = owner(h, ['pause', String(id)]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /paused #\d+ busy's t run/);
  assert.ok(stopped(pgid));
  await paused(job);
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, /\[paused by owner\]/);
  assert.match(dibs(h, [], { agent: 'viewer' }).out, /^t {6}busy is using it, time left unknown \(paused by the person at this machine\)$/m);
  await until(() => /the owner \(the person at this machine\) paused your job/.test(job.err));
  // Said plainly (#16590 found "timeouts may fire on resume" ambiguous): what stopped, and what to check after.
  assert.match(job.err.replace(/\n\s*/g, ' '), /Its processes were stopped \(SIGSTOP\) and continue where they were when it resumes\. Anything waiting on a server meanwhile .* may have timed out on the far side: check its output for timeouts\./);
  assert.match(owner(h, ['pause', String(id)]).out, /already paused by you/);
  // A pause that only lasts as long as its lease: a later state change mustn't drop it.
  assert.equal(owner(h, ['cap', 'nobody', 'low']).code, 0);
  assert.ok(held(h, 'busy').pausedAt);
  const back = owner(h, ['resume', String(id)]);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /resumed #\d+ busy's t run/);
  await until(() => noneStopped(pgid));
  assert.equal(held(h, 'busy').pausedAt, undefined);
  await until(() => /resumed your job/.test(job.err));
  assert.equal(owner(h, ['resume', String(id)]).code, 1, 'nothing left to resume');
});

test('a resource marked pausable: false is not paused without --force, and the refusal says why', { skip: WIN }, async t => {
  const h = home(t);
  const job = counter(t, h, 'ship', 'd', 'low');
  await until(() => held(h, 'ship')?.pgid);
  const { id, pgid } = held(h, 'ship');
  const r = owner(h, ['pause', String(id)]);
  assert.equal(r.code, 2);
  assert.match(r.err, /d is marked pausable: false: .*can time out .*Nothing changed\. dibs pause \d+ --force freezes it anyway/);
  assert.equal(stopped(pgid), false);
  assert.equal(await runs(job), true);
  assert.equal(owner(h, ['pause', String(id), '--force']).code, 0);
  // The stop lands as the signal is handled; ps can show it a moment later on a busy machine.
  await until(() => stopped(pgid));
  assert.equal(owner(h, ['resume', String(id)]).code, 0);
  await until(() => noneStopped(pgid));
});

test('stop kills the whole tree like a crash, and the agent sees "stopped by the owner"', { skip: WIN }, async t => {
  const h = home(t);
  const kid = path.join(h, 'kid');
  const job = bg(t, h, ['run', 't', '--', 'sh', '-c', `sleep 300 & echo $! > ${kid}; wait`], { agent: 'runaway' });
  await until(() => held(h, 'runaway')?.pgid && fs.existsSync(kid) && fs.readFileSync(kid, 'utf8').trim());
  const child = Number(fs.readFileSync(kid, 'utf8'));
  const { id } = held(h, 'runaway');
  // Paused first: a stopped tree must die too.
  assert.equal(owner(h, ['pause', String(id)]).code, 0);
  const r = owner(h, ['stop', String(id)]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /stopped #\d+ runaway's t run and killed its processes/);
  assert.equal(await job.done, 137);
  assert.match(job.err, /stopped by the owner/);
  await until(() => !alive(child));
  assert.equal(held(h, 'runaway'), undefined, 'the lease is gone');
  // A waiter is taken out of line, and its command never runs.
  const first = blocker(t, h);
  await until(() => held(h, 'first'));
  const ran = path.join(h, 'ran');
  const w = bg(t, h, ['run', 't', '--', 'touch', ran], { agent: 'queued' });
  await until(() => waiter(h, 'queued'));
  assert.match(owner(h, ['stop', String(waiter(h, 'queued').id)]).out, /took #\d+ queued out of line/);
  assert.equal(await w.done, 143);
  assert.match(flat(w.err), /stopped by the owner \(the person at this machine\) on purpose \(dibs stop\)\. This was taken out of line and your command did not run\. Find out why before trying again/);
  first.open();
  await first.done;
  assert.equal(fs.existsSync(ran), false);
  assert.equal(owner(h, ['stop', '9999']).code, 1);
});

test('cap holds an agent at a priority: its waiters now and its new requests, until off', async t => {
  const h = home(t);
  const first = blocker(t, h);
  await until(() => held(h, 'first'));
  const old = bg(t, h, ['run', 't', '-p', 'urgent', '-m', 'everything is urgent', '--', 'true'], { agent: 'pushy' });
  await until(() => waiter(h, 'pushy'));
  const r = owner(h, ['cap', 'pushy', 'low']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pushy's work now waits and runs at low or below/);
  assert.match(r.out, /#\d+ pushy's t wait: urgent -> low/);
  assert.equal(waiter(h, 'pushy').prio, 'low');
  // A new request from the same agent waits at the cap, and is told.
  const fresh = bg(t, h, ['run', 't', '-p', 'high', '-m', 'also urgent', '--', 'true'], { agent: 'pushy', env: { DIBS_AS: 'two' } });
  await until(() => board(h).waiting.filter(q => q.who === 'pushy').length === 2);
  await until(() => /the person at this machine capped pushy's work at low priority, so this waits and runs at low, not high/.test(fresh.err));
  assert.ok(board(h).waiting.filter(q => q.who === 'pushy').every(q => q.prio === 'low' && q.owner.act === 'cap'));
  const calm = bg(t, h, ['run', 't', '--', 'true'], { agent: 'calm' });
  await until(() => waiter(h, 'calm'));
  assert.equal(board(h).waiting[0].who, 'calm', 'a normal request arriving later goes ahead of the capped ones');
  const text = dibs(h, ['--detail'], { agent: 'viewer' }).out;
  assert.match(text, /pushy .*\[low, capped low by owner/);
  assert.match(text, /^capped: pushy at low$/m);
  assert.match(dibs(h, [], { agent: 'viewer' }).out, /^Capped {9}pushy, at low priority, by the person at this machine$/m);
  const off = owner(h, ['cap', 'pushy', 'off']);
  assert.match(off.out, /took the low cap off pushy/);
  assert.deepEqual(board(h).waiting.filter(q => q.who === 'pushy').map(q => q.prio).sort(), ['high', 'urgent']);
  assert.deepEqual(board(h).caps, {});
  first.open();
  for (const p of [first, old, fresh, calm]) assert.equal(await p.done, 0);
});

// Agents may override any job, as the person can (0.0.110). An agent here is
// a call with CLAUDECODE set; its name is its DIBS_AGENT.
const agent = (h, who, args) => dibs(h, args, { agent: who, env: { CLAUDECODE: '1' } });
const events = h => JSON.parse(dibs(h, ['history', '--json'], { agent: 'viewer' }).out).events.filter(e => e.kind === 'override');

test("an agent boosts, pauses, resumes and stops another session's job; the board, the job's agent and the log name it", { skip: WIN }, async t => {
  const h = home(t);
  const job = counter(t, h, 'theirs', 't', 'low');
  // On record is enough. Its first count isn't: at background priority, under load, it can go 30 s and more without a core (2026-11-01).
  await until(() => held(h, 'theirs')?.pgid);
  const { id, pgid } = held(h, 'theirs');
  // High and urgent need a reason everyone sees.
  const bare = agent(h, 'helper', ['boost', String(id), 'high']);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /high needs a reason everyone can see: dibs boost \d+ high -m "why"\. Nothing changed\./);
  assert.equal(agent(h, 'helper', ['boost', String(id), 'high', '-m', 'the release waits on it', '--owner', 'theirs']).code, 0);
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, /\[high\]  \[boosted by helper: the release waits on it\]/);
  assert.equal(agent(h, 'helper', ['pause', String(id), '--owner', 'theirs']).code, 0);
  await until(() => stopped(pgid));
  assert.match(dibs(h, ['--detail'], { agent: 'viewer' }).out, /\[paused by helper\]/);
  await until(() => /helper paused your job \(dibs pause \d+\)/.test(job.err));
  assert.equal(agent(h, 'helper', ['resume', String(id), '--owner', 'theirs']).code, 0);
  await until(() => noneStopped(pgid));
  assert.equal(agent(h, 'helper', ['stop', String(id), '--owner', 'theirs']).code, 0);
  assert.equal(await job.done, 137);
  assert.match(job.err, /stopped by helper on purpose \(dibs stop\).*Find out why before running it again/);
  assert.deepEqual(events(h).map(e => [e.act, e.who, e.by, e.byAgent]),
    [['boost', 'theirs', 'helper', true], ['pause', 'theirs', 'helper', true], ['resume', 'theirs', 'helper', true], ['stop', 'theirs', 'helper', true]]);
  assert.equal(events(h)[0].reason, 'the release waits on it');
});

test("an agent's urgent gets what the person's does: past memory pressure, and pausing another session's low run", { skip: WIN }, async t => {
  const h = home(t);
  counter(t, h, 'theirs', 't', 'low');
  // On record is enough to be paused. Its first count isn't: at background priority, under
  // load, it can go 30 s and more without a core (2026-11-01).
  await until(() => held(h, 'theirs')?.pgid);
  const ran = path.join(h, 'ran');
  const me = bg(t, h, ['run', 't', '-p', 'urgent', '-m', 'broken build', '--', 'touch', ran], { agent: 'me', env: { CLAUDECODE: '1' } });
  await until(() => fs.existsSync(ran));
  assert.equal(await me.done, 0);
  // Under memory pressure, an agent's urgent asked for with -p starts on top of what runs.
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources: { two: { slots: 2, mem: '0.1G', cpu: 1 } } }));
  const pressure = { CLAUDECODE: '1', DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, vmPressure: 2 }) };
  const gate = path.join(h, 'gate');
  const first = bg(t, h, ['run', 'two', '--', 'sh', '-c', `while [ ! -f '${gate}' ]; do sleep 0.1; done`], { agent: 'first' });
  await until(() => held(h, 'first'));
  const ran2 = path.join(h, 'ran2');
  const urgent = bg(t, h, ['run', 'two', '-p', 'urgent', '-m', 'person waiting', '--', 'touch', ran2], { agent: 'me', env: pressure });
  await until(() => fs.existsSync(ran2));
  assert.equal(await urgent.done, 0);
  fs.writeFileSync(gate, '');
  assert.equal(await first.done, 0);
});

test('stop, pause and resume take -m: the job\'s agent hears the reason, and the history keeps it', { skip: WIN }, async t => {
  const h = home(t);
  const job = counter(t, h, 'stuck', 't', 'normal');
  await until(() => held(h, 'stuck')?.pgid && job.count() > 0);
  const { id, pgid } = held(h, 'stuck');
  assert.equal(owner(h, ['pause', String(id), '-m', 'checking its logs']).code, 0);
  await until(() => /paused your job \(dibs pause \d+\): "checking its logs"/.test(job.err));
  assert.equal(owner(h, ['resume', String(id), '-m', 'logs look fine']).code, 0);
  await until(() => noneStopped(pgid));
  await until(() => /resumed your job after .* paused: "logs look fine"/.test(job.err));
  const r = owner(h, ['stop', String(id), '-m', 'asked 12G of an 11G budget']);
  assert.equal(r.code, 0, r.err);
  assert.equal(await job.done, 137);
  assert.match(flat(job.err), /stopped by the owner \(the person at this machine\) on purpose \(dibs stop\): "asked 12G of an 11G budget"\. This job was ended/);
  const ev = JSON.parse(dibs(h, ['history', '--json'], { agent: 'viewer' }).out).events.filter(e => e.kind === 'override');
  assert.deepEqual(ev.map(e => [e.act, e.reason]), [['pause', 'checking its logs'], ['resume', 'logs look fine'], ['stop', 'asked 12G of an 11G budget']]);
});

// 2026-10-19: an agent boosted #10167 and only learned from the output whose job it was; crews
// sharing one session name stopped each other's jobs. Acting on a job that isn't yours names it first.
const asAgent = (h, agent, args, env = {}) => dibs(h, args, { agent, env: { AI_AGENT: '1', ...env } });
test("an agent acting on a job that isn't its own must name the owner with --owner, or nothing changes (exit 2)", async t => {
  const h = home(t);
  const job = counter(t, h, 'bob', 't');
  await until(() => held(h, 'bob')?.pgid);
  const id = String(held(h, 'bob').id);
  // Without --owner: refused, and it says whose job it is and how to go ahead.
  const no = asAgent(h, 'alice', ['boost', id, 'high', '-m', 'person waiting']);
  assert.equal(no.code, 2, no.err);
  assert.match(flat(no.err), new RegExp(`#${id} is bob's t job \\("counting"\\), not yours\\. Nothing changed\\. If you meant it: dibs boost ${id} high -m 'person waiting' --owner bob`));
  assert.equal(held(h, 'bob').prio || 'normal', 'normal');
  // The wrong owner: refused the same way.
  const wrong = asAgent(h, 'alice', ['stop', id, '--owner', 'carol']);
  assert.equal(wrong.code, 2);
  assert.match(flat(wrong.err), /not carol's\. Nothing changed/);
  assert.ok(held(h, 'bob'), 'still running');
  // Named right: it goes, and the first line says whose job it was.
  const yes = asAgent(h, 'alice', ['boost', id, 'high', '-m', 'person waiting', '--owner', 'bob']);
  assert.equal(yes.code, 0, yes.err);
  assert.equal(yes.out.split('\n')[0], `boosting #${id}: bob t 'counting'`);
  assert.equal(held(h, 'bob').prio, 'high');
  // pause and resume ask the same.
  assert.equal(asAgent(h, 'alice', ['pause', id]).code, 2);
  const p = asAgent(h, 'alice', ['pause', id, '--owner', 'bob']);
  assert.equal(p.code, 0, p.err);
  assert.equal(p.out.split('\n')[0], `pausing #${id}: bob t 'counting'`);
  assert.equal(asAgent(h, 'alice', ['resume', id]).code, 2);
  assert.equal(asAgent(h, 'alice', ['resume', id, '--owner', 'bob']).code, 0);
  // Its own job needs no flag; nor does the person.
  assert.equal(asAgent(h, 'bob', ['boost', id, 'low']).code, 0);
  const person = owner(h, ['boost', id, 'normal']);
  assert.equal(person.code, 0, person.err);
  assert.equal(person.out.split('\n')[0], `boosting #${id}: bob t 'counting'`);
  job.kill('SIGTERM');
  await job.done;
});

test('two agents of one session are told apart by their label: one crew member is refused on the other\'s job', async t => {
  const h = home(t);
  const job = bg(t, h, ['run', 't', '-m', 'crew job', '--', 'sh', '-c', 'while :; do sleep 0.2; done'], { agent: 'crew', env: { DIBS_AS: 'fix-a' } });
  await until(() => held(h, 'crew')?.pgid);
  const id = String(held(h, 'crew').id);
  const sibling = asAgent(h, 'crew', ['stop', id], { DIBS_AS: 'fix-b' });
  assert.equal(sibling.code, 2, sibling.err);
  assert.match(flat(sibling.err), new RegExp(`#${id} is crew/fix-a's t job \\("crew job"\\), not yours.*--owner crew/fix-a`));
  assert.ok(held(h, 'crew'));
  assert.equal(asAgent(h, 'crew', ['stop', id], { DIBS_AS: 'fix-a' }).code, 0, 'its own');
  await job.done;
});
