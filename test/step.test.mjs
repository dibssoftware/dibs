// acquire()'s poll as a step another process can run for a waiter: what it
// would print goes to the waiter's own out, and so does how its wait ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';   // first: a temp DIBS_HOME before any src module loads
import { waiter, decide, step } from '../src/acquire.mjs';
import { withState } from '../src/state.mjs';
import { loadConfig } from '../src/config.mjs';

// Lines and endings, as a waiter elsewhere would get them.
function collect() {
  const got = { lines: [], end: null };
  const out = {
    say: m => got.lines.push(`dibs: ${m}`),
    said: (...ls) => got.lines.push(ls.filter(Boolean).join(' ')),
    raw: t => got.lines.push(t),
    die: (m, code) => { got.lines.push(`dibs: ${m}`); got.end = code; return { exit: code }; },
    exit: code => { got.end = code; return { exit: code }; },
  };
  return { got, out };
}

function waitFor(cfg, info) {
  const { got, out } = collect();
  const w = waiter({ started: Date.now(), maxWait: Infinity, again: 'dibs run deploy -- true', size: {}, ...info }, cfg, [], out);
  w.me = withState(s => {
    s.leases.push({ id: ++s.seq, res: ['deploy'], kind: 'hold', who: 'other', pid: null, start: Date.now(), expires: Date.now() + 6e5, mem: 0, cpu: 0 });
    const q = { id: ++s.seq, res: ['deploy'], kind: 'run', who: 'me', pid: process.pid, enq: Date.now(), cmd: 'true', key: 'deploy|true', purpose: '' };
    s.queue.push(q);
    return { ...q };
  });
  return { w, got };
}
const poll = w => step(withState(s => decide(s, w)), w);
const clear = () => withState(s => { s.leases = []; s.queue = []; });

test("a step for a waiter elsewhere says the wait line to that waiter's out, not stderr", () => {
  clear();
  const { w, got } = waitFor(loadConfig(), {});
  assert.equal(poll(w), null);
  assert.match(got.lines.join('\n'), /queued for .*deploy/);
  assert.equal(got.end, null);
  assert.equal(poll(w), null);
  assert.equal(got.lines.length, 1, 'said once, not every poll');
});

test("a step past the waiter's limit ends it through its out, with 75, and keeps its place", () => {
  clear();
  const { w, got } = waitFor(loadConfig(), { maxWait: 1, started: Date.now() - 1000 });
  assert.deepEqual(poll(w), { exit: 75 });
  assert.equal(got.end, 75);
  assert.match(got.lines.join('\n'), /gave up after/);
  assert.match(got.lines.join('\n'), /dibs run deploy -- true/);
  withState(s => assert.equal(s.queue.find(q => q.id === w.me.id).pid, null));
});

test('a step on the turn of a waiter elsewhere writes the lease with its info', () => {
  clear();
  const { w } = waitFor(loadConfig(), { cwd: '/somewhere', ppid: 4242, est: 5000 });
  withState(s => { s.leases = []; });
  const x = poll(w);
  assert.equal(x.lease.id, w.me.id);
  assert.equal(x.lease.cwd, '/somewhere');
  assert.equal(x.lease.ppid, 4242);
  assert.equal(x.lease.pid, process.pid);
  withState(s => assert.ok(s.leases.some(l => l.id === w.me.id)));
});

// 2026-10-20: nine browser runs sized while one run had read 15 GB still waited, hours later, for the whole budget.
test('a waiter is sized again from what its command uses now, not only when it joined', () => {
  clear();
  const G = 1024 ** 3, key = 'playwright|npx playwright test';
  const hist = [2.4, 2.6, 2.5, 15, 2.5].map((m, i) => ({ key, dur: 60e3, at: i, fit: true, mem: m * G, cpu: 2 }));
  const { out } = collect();
  const w = waiter({ started: Date.now(), maxWait: Infinity, again: 'x', size: { mem: 11 * G, usual: 13.3 * G, asked: 3 * G } }, loadConfig(), hist, out);
  w.me = withState(s => {
    s.leases.push({ id: ++s.seq, res: ['playwright'], kind: 'hold', who: 'other', pid: null, start: Date.now(), expires: Date.now() + 6e5, mem: 0, cpu: 0 });
    s.leases.push({ id: ++s.seq, res: ['playwright'], kind: 'hold', who: 'other2', pid: null, start: Date.now(), expires: Date.now() + 6e5, mem: 0, cpu: 0 });
    const q = { id: ++s.seq, res: ['playwright'], kind: 'run', who: 'me', pid: process.pid, enq: Date.now(), cmd: 'npx playwright test', key, purpose: '', mem: 11 * G, usual: 13.3 * G, asked: 3 * G, cpu: 2 };
    s.queue.push(q);
    return { ...q };
  });
  poll(w);
  const q = withState(s => s.queue.find(x => x.id === w.me.id));
  assert.equal(q.mem, 3 * G, 'its ask: the middle of its last five runs is less');
  assert.equal(q.usual, undefined);
  assert.equal(w.info.size.mem, 3 * G, 'and the lease it gets is made at that');
});
