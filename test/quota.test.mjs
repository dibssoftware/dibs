// Rate-limit buckets: the refill and wait math on a fake clock, then the real
// CLI sharing one bucket between runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, flat } from './helpers.mjs';
import { level, refillIn, quotaBlock, takeQuota, quotasNow } from '../src/quota.mjs';

const cfg = { quotas: { asc: { per: '1h', limit: 300 } } };
const T0 = 1_000_000_000_000;
const waiter = (id, cost, enq = T0) => ({ id, res: ['quota:asc'], cost, pid: 1, enq, who: `w${id}` });

test('a bucket refills its limit once per period, smoothly, and never past full', () => {
  const q = { per: 3.6e6, limit: 300 };
  assert.equal(level(undefined, q, T0), 300, 'a bucket nobody used is full');
  assert.equal(level({ tokens: 0, at: T0 }, q, T0 + 6e3), 0.5);
  assert.equal(level({ tokens: 0, at: T0 }, q, T0 + 1.8e6), 150);
  assert.equal(level({ tokens: 299, at: T0 }, q, T0 + 3.6e6), 300);
  assert.equal(refillIn(0, 1, q), 12e3);
  assert.equal(refillIn(0.5, 3, q), 30e3);
  assert.equal(refillIn(5, 3, q), 0);
});

test('a waiter takes its tokens once there are enough, and waiters ahead are served first', () => {
  const s = { leases: [], queue: [], quotas: { asc: { tokens: 0, at: T0 } } };
  const me = waiter(1, 1);
  s.queue.push(me);
  const v = quotaBlock(s, me, cfg, [], T0);
  assert.equal(v.rule, 'quota');
  assert.match(v.why, /quota:asc has 0 of 300 left .*you need 1: enough in ~12s/);
  assert.equal(quotaBlock(s, me, cfg, [], T0 + 12e3), null);
  takeQuota(s, me, cfg, T0 + 12e3);
  assert.equal(level(s.quotas.asc, { per: 3.6e6, limit: 300 }, T0 + 12e3), 0);

  // A big request that came first isn't passed by small ones behind it.
  const big = waiter(2, 3, T0 + 12e3), small = waiter(3, 1, T0 + 13e3);
  s.queue = [big, small];
  const later = T0 + 12e3 + 24e3;   // 2 tokens back: not enough for big
  assert.match(quotaBlock(s, big, cfg, [], later).why, /you need 3: enough in ~12s/);
  assert.match(quotaBlock(s, small, cfg, [], later).why, /you need 1 after 3 for 1 ahead of you: enough in ~24s/);
  assert.deepEqual(quotasNow(s, cfg, later), [{ name: 'asc', left: 2, limit: 300, per: 3.6e6 }]);
});

function home(t, quotas) {
  const h = tmp(t, 'quota');
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ quotas }));
  return h;
}

test('runs share one bucket: they wait while it is empty, and the board shows what is left', async t => {
  // slow refills one token every half hour, so it stays empty however long the
  // checks take. fast is full again 8s after it's emptied: the one wait here
  // that runs on the clock, since refilling is time passing.
  const h = home(t, { slow: { per: '1h', limit: 2 }, fast: { per: '8s', limit: 2 } });
  const first = sync(h, ['run', 'quota:slow', '--cost', '2', '--', 'true']);
  assert.equal(first.code, 0, first.err);
  const no = sync(h, ['run', 'quota:slow', '--no-wait', '--', 'true']);
  assert.equal(no.code, 75);
  assert.match(flat(no.err), /not free yet\. Waiting for the slow budget to refill \(0(\.\d)? of 2 left, enough in about 30 min\)\. --no-wait doesn't wait/);
  assert.match(sync(h, ['--detail']).out, /quotas: slow 0(\.\d)?\/2 per 1h/);
  assert.match(sync(h, []).out, /^slow budget {4}0(\.\d)? of 2 left, refills to 2 every hour$/m);
  // A run that needs the whole bucket right after it's emptied waits for the
  // refill, then starts on its own.
  assert.equal(sync(h, ['run', 'quota:fast', '--cost', '2', '--', 'true']).code, 0);
  const waits = bg(t, h, ['run', 'quota:fast', '--cost', '2', '--max-wait', '60s', '--', 'true']);
  assert.equal(await waits.done, 0, waits.err);
  assert.match(flat(waits.err), /Waiting for the fast budget to refill \(\d(\.\d)? of 2 left, enough in/);
});

test('a quota limits tokens, not how many jobs run at once', async t => {
  const h = home(t, { api: { per: '1h', limit: 10 } });
  const long = bg(t, h, ['run', 'quota:api', '--', 'sleep', '30']);
  await until(() => sync(h, ['--json']).out.includes('"quota:api"'));
  const r = sync(h, ['run', 'quota:api', '--no-wait', '--', 'true']);
  assert.equal(r.code, 0, r.err);
  long.kill('SIGTERM');
  await long.done;
});

test('an unconfigured quota or a cost it can never hold is refused before waiting', t => {
  const h = home(t, { api: { per: '1m', limit: 5 } });
  const missing = sync(h, ['run', 'quota:nope', '--', 'true']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /quota:nope isn't configured. Add it to config.json/);
  const big = sync(h, ['run', 'quota:api', '--cost', '6', '--', 'true']);
  assert.equal(big.code, 2);
  assert.match(big.err, /--cost 6 is more than quota:api ever holds \(5\)/);
  assert.equal(sync(h, ['run', 'quota:api', '--cost', '0', '--', 'true']).code, 2);
});
