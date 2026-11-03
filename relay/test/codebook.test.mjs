// The code index's bookkeeping (src/codebook.js), on a Map standing in for Durable Object storage.
//   node --test test/codebook.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CodeBook, CODE_LIFE } from '../src/codebook.js';

function store() {
  const m = new Map();
  return {
    m,
    get: async k => m.get(k),
    put: async (k, v) => { m.set(k, v); },
    delete: async k => { m.delete(k); },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
  };
}
const h = () => crypto.randomBytes(32).toString('base64url');
const mid = () => crypto.randomBytes(16).toString('base64url');

test('a Mac that lists codes and never comes back leaves nothing: the sweep removes its codes and its list', async () => {
  const s = store(), book = new CodeBook(s);
  const t = Date.now(), a = mid();
  await book.set(a, [{ h: h(), exp: t + 60e3 }, { h: h(), exp: t + 5 * 60e3 }], t);
  assert.equal([...s.m.keys()].filter(k => k.startsWith('m:')).length, 1);
  assert.equal(await book.sweep(t + 2 * 60e3), t + 5 * 60e3, 'next sweep at the last expiry');
  assert.equal([...s.m.keys()].filter(k => k.startsWith('c:')).length, 1);
  assert.ok(s.m.has(`m:${a}`), 'the list stays while a code in it lives');
  assert.equal(await book.sweep(t + 6 * 60e3), 0);
  assert.equal(s.m.size, 0, 'codes and the machine list both gone');
});

test('a machine list from before lists carried their expiry is swept too', async () => {
  const s = store(), book = new CodeBook(s);
  s.m.set(`m:${mid()}`, [h(), h()]);
  await book.sweep();
  assert.equal(s.m.size, 0);
});

test('entries never outlive a code\'s ten minutes, whatever the Mac says', async () => {
  const s = store(), book = new CodeBook(s);
  const t = Date.now(), a = mid(), x = h();
  await book.set(a, [{ h: x, exp: t + 24 * 3600e3 }], t);
  assert.equal(s.m.get(`c:${x}`).exp, t + CODE_LIFE);
  assert.equal(s.m.get(`m:${a}`).exp, t + CODE_LIFE);
  assert.deepEqual(await book.find(x, '1.1.1.1', t + CODE_LIFE + 1), { mid: null });
});

test('a list replaces the one before; a machine can\'t drop or take another\'s codes', async () => {
  const s = store(), book = new CodeBook(s);
  const t = Date.now(), a = mid(), b = mid(), x = h(), y = h();
  await book.set(a, [{ h: x, exp: t + 60e3 }], t);
  await book.set(b, [{ h: x, exp: t + 60e3 }, { h: y, exp: t + 60e3 }], t);
  assert.equal(s.m.get(`c:${x}`).mid, a, 'B listing A\'s hash doesn\'t take it');
  await book.set(b, [], t);
  assert.equal(s.m.get(`c:${x}`).mid, a, 'B emptying its list doesn\'t drop A\'s');
  assert.ok(!s.m.has(`c:${y}`) && !s.m.has(`m:${b}`));
  await book.drop(x, b);
  assert.ok(s.m.has(`c:${x}`), 'B can\'t drop A\'s code');
  await book.drop(x, a);
  assert.ok(!s.m.has(`c:${x}`));
});

test('malformed, unknown, expired and spent codes get one answer', async () => {
  const s = store(), book = new CodeBook(s, { perIp: 100 });
  const t = Date.now(), a = mid(), live = h(), old = h(), spent = h();
  await book.set(a, [{ h: live, exp: t + 60e3 }, { h: old, exp: t + 1 }, { h: spent, exp: t + 60e3 }], t);
  await book.drop(spent, a);
  assert.deepEqual(await book.find(live, 'ip', t + 2), { mid: a });
  for (const x of ['', 'short', 'x'.repeat(300), h(), old, spent, null]) assert.deepEqual(await book.find(x, 'ip', t + 2), { mid: null }, String(x));
});

test('lookups: per address, and the global cap never stops an address\'s first try in a minute', async () => {
  const book = new CodeBook(store(), { perIp: 3, global: 5 });
  const t = Date.now();
  const one = [];
  for (let i = 0; i < 4; i++) one.push(await book.find(h(), 'a', t));
  assert.deepEqual(one.map(r => !!r.limited), [false, false, false, true]);
  // 3 counted; 2 more fill the global budget of 5.
  assert.ok(!(await book.find(h(), 'b', t)).limited);
  assert.ok(!(await book.find(h(), 'b', t)).limited);
  assert.ok((await book.find(h(), 'b', t)).limited, 'b\'s third try, with the budget spent');
  for (let i = 0; i < 20; i++) assert.ok(!(await book.find(h(), `fresh${i}`, t)).limited, 'every address\'s first try gets an answer');
  assert.ok((await book.find(h(), 'fresh0', t)).limited, 'but not its second');
  assert.ok(!(await book.find(h(), 'a', t + 61e3)).limited, 'a minute later it all resets');
});
