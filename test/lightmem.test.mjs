// Light jobs and memory, from the agents' report of 2026-11-03: a one-second test waited
// 29 minutes on the memory budget (F), and a deploy that uses under 0.5 GB waited on memory
// pressure blamed on an 11 GB Xcode booking that used 0.1 GB (2e).
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { G, MACHINE } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict, memHolders } from '../src/schedule.mjs';

const T = Date.now();
const M = 1024 ** 2;
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, budget: '11G', cores: 10, ...o, resources: { ...DEFAULT_CONFIG.resources, ...o.resources } });
let n = 0;
const lease = o => ({ id: ++n, kind: 'run', res: ['test'], who: `l${n}`, mem: 1 * G, cpu: 1, start: T - 60e3, pid: 1, key: `test|other ${n}`, ...o });
const waiter = o => ({ id: ++n, res: ['test'], who: 'me', mem: 2 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'test|npm test', kind: 'run', ...o });
function judge(s, me, c, m = {}, hist = []) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memTotal: 16 * G, memFree: 67, cores: 10, swapGrowth: 0, diskDrain: 0, ...m });
  try { return verdict(s, me, c, hist, T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}

// F. A 1-second node test waited 29 minutes on memory (#18336): its one earlier run took 14.9 s at 95 MB.
test('F: a quick test booked as a featherweight starts past a full memory budget; critical pressure still holds it', () => {
  const key = 'test|sh funnel-report.test.mjs';
  const hist = [{ key, dur: 14881, who: 'x', at: T - 36e5, mem: 95 * M, cpu: 0.1, ate: 0.3 * M }];
  const me = waiter({ key, enq: T - 29 * 6e4 });
  const s = { leases: [lease({ mem: 10.8 * G, res: ['heavy'], key: 'heavy|build' })], queue: [me] };
  const v = judge(s, me, cfg(), {}, hist);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.quick, true);
  assert.equal(judge(s, me, cfg(), {}, [{ ...hist[0], dur: 40e3 }]).rule, 'memory', 'a 40-second run waits on the budget as before');
  assert.equal(judge(s, me, cfg(), { vmPressure: 2, swapUsed: 9 * G, swapGrowth: 2 * G }, hist).ok, false, 'critical pressure');
});


// 2e: "an 11G Xcode job using 0.1 GB kept a 6G deploy waiting on memory pressure".
test('a deploy whose runs use under 0.5 GB starts under warning pressure past an 11 GB booking using 0.1 GB; critical still holds it, and the wait blames use, not bookings', () => {
  const xcode = lease({ res: ['xcode-build'], mem: 11 * G, cpu: 4, start: T - 20 * 6e4, key: 'xcode-build|xcodebuild archive', use: { mem: 0.1 * G, at: T } });
  const key = 'deploy|wrangler deploy';
  const hist = [1, 2, 3].map(i => ({ key, dur: 40e3, who: 'd', at: T - i * 36e5, mem: 0.3 * G, cpu: 0.2 }));
  const asked = waiter({ res: ['deploy'], mem: 6 * G, declared: true, key });
  const plain = waiter({ res: ['deploy'], mem: 0.5 * G, key });
  const warn = { vmPressure: 1, memFree: 30, memAvail: 2 * G };
  for (const me of [asked, plain]) {
    const s = { leases: [xcode], queue: [me] };
    const v = judge(s, me, cfg(), warn, hist);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(judge(s, me, cfg(), { ...warn, swapUsed: 6 * G, swapGrowth: 1 * G }, hist).ok, true, 'swap growing, pressure still warning');
    assert.equal(judge(s, me, cfg(), { ...warn, vmPressure: 2 }, hist).rule, 'pressure', 'critical');
  }
  assert.equal(judge({ leases: [xcode], queue: [asked] }, asked, cfg(), warn, hist.slice(0, 2)).ok, false, 'two runs are too few to overrule a 6 GB ask');
  const heavy = lease({ res: ['heavy'], mem: 4 * G, start: T - 20 * 6e4, key: 'heavy|train', use: { mem: 3.5 * G, at: T } });
  // A minute in, the Xcode job still books its whole 11 GB; measured, it uses 0.1 GB.
  const fresh = { ...xcode, start: T - 60e3 };
  assert.deepEqual(memHolders({ leases: [fresh, heavy], queue: [] }).map(h => h.id), [heavy.id, xcode.id], 'the 3.5 GB in use comes first');
});
