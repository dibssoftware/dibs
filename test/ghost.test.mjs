// Places in line nobody decides for. On 2026-11-04 one client process (pid 97301)
// had two places for one command, #19783 and #19784. #19783 was never looked at
// again, held the head of heavy for 21 h, and dibs stop said it took it out of
// line while it stayed there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmp, sync, bg, until, env, track, board, BIN, PERSON } from './helpers.mjs';

const SRC = path.join(path.dirname(BIN), '..', 'src');
const MIN = 60e3;
const queue = h => { try { return JSON.parse(fs.readFileSync(path.join(h, 'state.json'), 'utf8')).queue; } catch { return []; } };
const events = h => { try { return fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };

// Changes the state as dibs does, under its lock: node edit.mjs <pid or 0> <js body of s => ...>.
// With a pid, PID and START are that process's number and start time, as dibs records them.
function editor(t) {
  const file = path.join(tmp(t, 'edit'), 'edit.mjs');
  fs.writeFileSync(file, `import { withState } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'state.mjs')).href)};
import { starts } from ${JSON.stringify(pathToFileURL(path.join(SRC, 'platform.mjs')).href)};
const PID = Number(process.argv[2]);
const START = PID ? starts([PID]).get(PID) : null;
const NOW = Date.now();
withState(new Function('PID', 'START', 'NOW', 'return ' + process.argv[3])(PID, START, NOW));
`);
  return file;
}
const edit = (h, file, pid, body) => {
  const r = sync(h, [], { env: {} });   // a state file to edit
  assert.equal(r.code, 0, r.err);
  const e = spawn(process.execPath, [file, String(pid), body], { env: env(h), stdio: 'inherit' });
  return new Promise(res => e.on('exit', res));
};

// A place for this command, as dibs makes one, with fields to change.
const place = (who, cmd, extra) => `s => { s.queue.push({ id: ++s.seq, ticket: '${who}|t|${cmd}', res: ['t'], mem: 1073741824, cpu: 1, pid: PID, pstart: START,
  enq: NOW, polledAt: NOW, who: '${who}', agent: '${who}', label: '', spid: null, purpose: '', cmd: '${cmd}', key: 't|${cmd}', kind: 'run', ${extra || ''} }); }`;

// Holds t until the test opens the gate.
async function holder(t, h) {
  const gate = path.join(tmp(t, 'gate'), 'open');
  const p = bg(t, h, ['run', 't', '--', 'sh', '-c', `while [ ! -e '${gate}' ]; do sleep 0.05; done`], { agent: 'a' });
  await until(() => board(h).held.length === 1);
  return { done: p.done, open: () => fs.writeFileSync(gate, '') };
}

test('a process that gets in line again takes back its own place: one process never has two', async t => {
  const h = tmp(t), file = editor(t), ran = path.join(tmp(t, 'ran'), 'ran');
  const a = await holder(t, h);
  // This shell's place is already in line under its pid and start time, as a thin waiter's is when its
  // shell becomes Node to wait there; then it becomes Node (exec: same pid, same start time) and gets in line.
  const p = track(t, spawn('sh', ['-c', `"${process.execPath}" "$1" $$ "$2" && exec "${process.execPath}" "${BIN}" run t -- touch '${ran}'`,
    'sh', file, place('b', `touch ${ran}`, 'planted: true')], { env: env(h, { agent: 'b' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let err = '';
  p.stderr.on('data', d => (err += d));
  const done = new Promise(r => p.on('exit', r));
  await until(() => events(h).some(e => e.kind === 'wait' && e.who === 'b'));
  const mine = queue(h).filter(q => q.pid === p.pid);
  assert.equal(mine.length, 1, `places under pid ${p.pid}: ${mine.map(q => `#${q.id}`).join(', ')}`);
  assert.equal(mine[0].planted, true, 'its own place, picked up');
  a.open();
  assert.equal(await done, 0, err);
  assert.ok(fs.existsSync(ran));
  assert.deepEqual(queue(h), []);
});

test("a place kept for one process's retry in Node is that process's alone, not another run of the same command's", async t => {
  const h = tmp(t), file = editor(t);
  const a = await holder(t, h);
  // Kept for a live shell (src/broker.mjs keptFor), the same command as the run below.
  const shell = track(t, spawn('sleep', ['60'], { stdio: 'ignore' }));
  await edit(h, file, shell.pid, place('b', 'true', 'pid: null, keptFor: PID, keepUntil: NOW + 120000'));
  const kept = queue(h)[0].id;
  const w = bg(t, h, ['run', 't', '--', 'true'], { agent: 'b' });
  await until(() => events(h).some(e => e.kind === 'wait' && e.who === 'b'));
  const q = queue(h);
  assert.equal(q.find(x => x.id === kept)?.pid, null, 'still kept for its shell');
  assert.ok(q.some(x => x.id !== kept && x.pid === w.pid), 'the run got a place of its own');
  a.open();
  assert.equal(await w.done, 0, w.err);
});

test("a place nobody has looked at for minutes holds nobody back, and leaves the line after ten", async t => {
  const h = tmp(t), file = editor(t);
  // A live process that isn't deciding for its place, ahead of everyone.
  const ghost = track(t, spawn('sleep', ['60'], { stdio: 'ignore' }));
  await edit(h, file, ghost.pid, place('ghost', 'true', `enq: NOW - 4 * ${MIN}, polledAt: NOW - 4 * ${MIN}`));
  const r = sync(h, ['run', 't', '--', 'echo', 'ran'], { agent: 'b', env: { DIBS_MAX_WAIT: '5s' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'ran\n');
  assert.equal(queue(h).length, 1, 'held nobody back, and still in line');

  await edit(h, file, 0, `s => { s.queue[0].polledAt = NOW - 11 * ${MIN}; }`);
  const id = queue(h)[0].id;
  assert.equal(sync(h, ['run', 't', '--', 'true'], { agent: 'b' }).code, 0);
  assert.deepEqual(queue(h), [], 'gone after ten minutes unlooked-at');
  assert.ok(events(h).some(e => e.kind === 'left' && e.id === id && e.why === 'unpolled'), 'and the history says why');
});

test('dibs stop takes a place nobody decides for out of line at once, for good', async t => {
  const h = tmp(t), file = editor(t);
  const ghost = track(t, spawn('sleep', ['60'], { stdio: 'ignore' }));
  await edit(h, file, ghost.pid, place('ghost', 'true', `enq: NOW - 4 * ${MIN}, polledAt: NOW - 4 * ${MIN}`));
  const id = String(queue(h)[0].id);
  const r = sync(h, ['stop', id], PERSON);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`took #${id} ghost out of line`));
  assert.deepEqual(queue(h), [], 'gone from the state file');
  assert.equal(sync(h, ['run', 't', '--', 'true'], { agent: 'b' }).code, 0);
  assert.deepEqual(queue(h), [], 'and not back');
});

test("a waiter whose place is gone from the line doesn't run on without it", async t => {
  const h = tmp(t), file = editor(t), ran = path.join(tmp(t, 'ran'), 'ran');
  const a = await holder(t, h);
  const w = bg(t, h, ['run', 't', '--', 'touch', ran], { agent: 'b' });
  await until(() => queue(h).some(q => q.pid === w.pid));
  await edit(h, file, 0, `s => { s.queue = s.queue.filter(q => q.who !== 'b'); }`);
  a.open();
  assert.equal(await w.done, 75, w.err);
  assert.match(w.err.replace(/\n +/g, ' '), /no longer in line.*did NOT run/);
  assert.ok(!fs.existsSync(ran));
});

test("dibs stop on a waiter its dibs is deciding for still ends that waiter, with the stop's words", async t => {
  const h = tmp(t);
  const a = await holder(t, h);
  const w = bg(t, h, ['run', 't', '--', 'true'], { agent: 'b' });
  await until(() => queue(h).some(q => q.pid === w.pid));
  const id = String(queue(h).find(q => q.pid === w.pid).id);
  assert.equal(sync(h, ['stop', id, '-m', 'wrong branch'], PERSON).code, 0);
  assert.equal(await w.done, 143);
  assert.match(w.err.replace(/\n +/g, ' '), /stopped by .* "wrong branch"/);
  assert.deepEqual(queue(h), []);
  a.open();
});

test('dibs who and the board name each waiter with its job id', async t => {
  const h = tmp(t);
  const a = await holder(t, h);
  const w = bg(t, h, ['run', 't', '--', 'true'], { agent: 'b' });
  await until(() => queue(h).some(q => q.pid === w.pid));
  const id = queue(h).find(q => q.pid === w.pid).id;
  assert.match(sync(h, ['who', 't'], { agent: 'c' }).out, new RegExp(`Next: b \\(#${id}\\)`));
  assert.match(sync(h, [], { agent: 'c' }).out, new RegExp(`Next: b \\(#${id}\\)`));
  a.open();
  assert.equal(await w.done, 0);
});

test('two places under one process: the one it stamped last stays, the other leaves the line', async t => {
  const h = tmp(t), file = editor(t);
  const shell = track(t, spawn('sleep', ['60'], { stdio: 'ignore' }));
  await edit(h, file, shell.pid, place('b', 'true', `polledAt: NOW - 2 * ${MIN}`));
  await edit(h, file, shell.pid, place('b', 'true'));
  const [old, fresh] = queue(h).map(q => q.id);
  assert.equal(sync(h, ['run', 'u', '--', 'true'], { agent: 'c' }).code, 0);
  assert.deepEqual(queue(h).map(q => q.id), [fresh]);
  assert.ok(events(h).some(e => e.kind === 'left' && e.id === old && e.why === 'duplicate'));
});

test('after the machine slept, nobody loses a place for not having looked at it: every waiter gets to look again first', async t => {
  const h = tmp(t);
  const a = await holder(t, h);
  const w = bg(t, h, ['run', 't', '--', 'true'], { agent: 'b' });
  await until(() => queue(h).some(q => q.pid === w.pid));
  // As if the machine had slept 11 minutes: the place last stamped then, and the state file
  // untouched for five, written under the state lock so the waiter can't look in between.
  const lock = path.join(h, 'lock'), file = path.join(h, 'state.json');
  await until(() => { try { fs.mkdirSync(lock); return true; } catch { return false; } });
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const q = s.queue.find(x => x.pid === w.pid);
  q.polledAt = Date.now() - 11 * MIN;
  fs.writeFileSync(file, JSON.stringify(s));
  const then = new Date(Date.now() - 5 * MIN);
  fs.utimesSync(file, then, then);
  fs.rmSync(lock, { recursive: true });
  await until(() => queue(h).find(x => x.pid === w.pid)?.polledAt > Date.now() - MIN);
  a.open();
  assert.equal(await w.done, 0, w.err);
});
