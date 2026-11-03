// A job that asks for more than this machine ever hands out can never start.
// It's refused at once, a waiter that stops fitting (the budget lowered) leaves
// the line, and neither holds anyone else back. On 2026-10-18 one asking 12G of
// an 11G budget held 26 jobs for 4.5 hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, board, flat } from './helpers.mjs';

function home(t, conf = {}) {
  const h = tmp(t, 'nofit');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ budget: '8G', cores: 6, resources: { t: { slots: 1, mem: '1G', cpu: 1 } }, ...conf }));
  return h;
}

test('a job asking for more memory or cores than the machine hands out is refused before it queues, with the most it can ask', t => {
  const h = home(t);
  const ran = path.join(h, 'ran');
  const r = sync(h, ['run', 't', '--mem', '12G', '-m', 'big', '--', 'touch', ran]);
  assert.equal(r.code, 2, r.err);
  assert.match(flat(r.err), /this job books 12G of memory, and dibs hands out at most 8\.0G at once on this machine \(budget in ~\/\.dibs\/config\.json\), so it could never start here\. Your command did not run \(exit 2\)\. Ask for --mem 8\.0G or less\./);
  assert.equal(fs.existsSync(ran), false);
  assert.equal(board(h).waiting.length, 0, 'nothing queued');
  const cores = sync(h, ['run', 't', '--cpu', '9', '-m', 'wide', '--', 'touch', ran]);
  assert.equal(cores.code, 2);
  assert.match(flat(cores.err), /books 9 of cores, and dibs hands out at most 6 at once .*Ask for --cpu 6 or less\./);
  assert.equal(sync(h, ['hold', 't', '--mem', '9G', '-m', 'big hold']).code, 2, 'a hold too');
  assert.equal(sync(h, ['run', 't', '--mem', '8G', '-m', 'fits', '--', 'touch', ran]).code, 0, 'the whole budget is fine');
});

test('a waiter that stops fitting (the budget lowered under it) leaves the line and says why, and the one behind it starts', async t => {
  const h = home(t);
  const gate = path.join(h, 'gate');
  const first = bg(t, h, ['run', 't', '--', 'sh', '-c', `while [ ! -f '${gate}' ]; do sleep 0.1; done`], { agent: 'first' });
  await until(() => board(h).held.some(l => l.who === 'first'));
  const big = bg(t, h, ['run', 't', '--mem', '6G', '-m', 'big', '--', 'true'], { agent: 'big' });
  await until(() => board(h).waiting.some(q => q.who === 'big'));
  const c = JSON.parse(fs.readFileSync(path.join(h, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ ...c, budget: '4G' }));
  assert.equal(await big.done, 2);
  assert.match(flat(big.err), /this job books 6\.0G of memory, and dibs hands out at most 4\.0G at once .*Your command did not run \(exit 2\)/);
  assert.equal(board(h).waiting.length, 0);
  fs.writeFileSync(gate, '');
  assert.equal(await first.done, 0);
});

test('a size dibs chose (a default, or one learned on a bigger machine) past what this machine hands out is booked at the most, not refused', t => {
  // The resource's own default asks for more than this machine has to give.
  const h = home(t, { resources: { t: { slots: 1, mem: '12G', cpu: 9 } } });
  const ran = path.join(h, 'ran');
  const r = sync(h, ['run', 't', '-m', 'default size', '--', 'touch', ran]);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(ran));
  const start = JSON.parse(sync(h, ['history', '--json'], { agent: 'viewer' }).out).events.find(e => e.kind === 'start');
  assert.ok(start, 'it ran as a job');
  // Only a number the agent typed can make it never fit.
  const typed = sync(h, ['run', 't', '--cpu', '9', '-m', 'typed', '--', 'true']);
  assert.equal(typed.code, 2);
  assert.match(flat(typed.err), /books 9 of cores, and dibs hands out at most 6/);
});

test('a typed --cpu at or under the cores always passes, even when the command has used more on a bigger machine', async () => {
  const { neverFits, explicitAsk, capToMachine } = await import('../src/schedule.mjs');
  const c = { budget: '8G', cores: 4 };
  // sized() raised it to the 5 cores learned on the 10-core Mac; the agent typed --cpu 4.
  const q = { mem: 2 * 1024 ** 3, cpu: 5, askedCpu: 4, cpuDeclared: true };
  assert.equal(neverFits(c, explicitAsk(q)), null);
  assert.equal(capToMachine(c, q), true);
  assert.equal(q.cpu, 4, 'booked at the cores this machine hands out');
  assert.ok(neverFits(c, explicitAsk({ mem: 1, cpu: 5, cpuDeclared: true })), 'a typed 5 still never fits');
});
