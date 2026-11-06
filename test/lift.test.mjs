// Priority inversion: a low or idle run is at background QoS, which macOS starves while normal
// work fills every core (a 0.08 s loop took 13.6 s at load 35, 2026-11-03). One holding a slot
// that a normal waiter wants is lifted to normal QoS while that waiter is in line.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, bg, until, board, allLow, noneLow, flat } from './helpers.mjs';

// macOS only: Linux lets only root raise a nice value back, so a lift can't land there.
test('a low job holding the simulator is lifted off background priority while a normal job waits for it, and dropped back when that one leaves', { skip: process.platform !== 'darwin' }, async t => {
  const h = tmp(t), dir = tmp(t, 'gate');
  const go = path.join(dir, 'go');
  t.after(() => { try { fs.writeFileSync(go, ''); } catch {} });
  const low = bg(t, h, ['run', 'sim', '-p', 'low', '--', 'sh', '-c', `while [ ! -f "${go}" ]; do sleep 0.1; done`], { agent: 'lo' });
  await until(() => board(h).held.some(l => l.pgid));
  const lease = board(h).held[0];
  await until(() => allLow(lease.pgid), 60e3);
  const next = bg(t, h, ['run', 'sim', '--', 'echo', 'next'], { agent: 'hi' });
  await until(() => noneLow(lease.pgid), 60e3);
  await until(() => /lifted #\d+ \(lo's low-priority job on sim\) off background priority/.test(flat(next.err)));
  const events = () => fs.readFileSync(path.join(h, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const waiting = board(h).waiting[0];
  assert.ok(events().some(e => e.act === 'lift' && e.why === `lifted #${lease.id} so #${waiting.id} isn't stuck behind it`));
  // It leaves the line: nobody is stuck behind the low job, so it goes back down.
  next.kill('SIGTERM');
  await next.done;
  await until(() => allLow(lease.pgid), 60e3);
  assert.ok(events().some(e => e.act === 'unlift' && e.id === lease.id));
  // A waiter that gets its turn: the low job is lifted again, and dropped once the waiter starts.
  const third = bg(t, h, ['run', 'sim', '--', 'echo', 'third'], { agent: 'hi' });
  await until(() => noneLow(lease.pgid), 60e3);
  fs.writeFileSync(go, '');
  assert.equal(await low.done, 0);
  assert.equal(await third.done, 0, third.err);
  assert.equal(third.out, 'third\n');
});

// relayreview, 2026-11-05: a waiter killed with kill -9 never leaves the line itself, so its lift
// would stay; the throttle watcher drops it back on its next pass.
test('a lift whose waiter was killed outright drops back on the throttle watcher\'s next pass', { skip: process.platform !== 'darwin' }, async t => {
  const h = tmp(t), dir = tmp(t, 'gate');
  const go = path.join(dir, 'go');
  t.after(() => { try { fs.writeFileSync(go, ''); } catch {} });
  bg(t, h, ['run', 'sim', '-p', 'low', '--', 'sh', '-c', `while [ ! -f "${go}" ]; do sleep 0.1; done`], { agent: 'lo' });
  await until(() => board(h).held.some(l => l.pgid));
  const lease = board(h).held[0];
  // Waiting in Node, so kill -9 leaves nobody to take its place out of line.
  const next = bg(t, h, ['run', 'sim', '--', 'echo', 'next'], { agent: 'hi', env: { DIBS_THIN: '0' } });
  await until(() => noneLow(lease.pgid), 60e3);
  next.kill('SIGKILL');
  await next.done;
  bg(t, h, ['throttle', '--watch']);
  await until(() => allLow(lease.pgid), 60e3);
});
