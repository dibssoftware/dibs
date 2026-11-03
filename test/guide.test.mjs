// The dibs page's Schedule guide: jobs at once on one resource each get a row
// (deploys run one per project), one agent's back-to-back runs are one bar, and
// past MAX_LANES rows the rest are a +N. The functions are the page's own,
// taken from web/app.js, run on the live board's shape: three overlapping
// deploys and eight test runs a few seconds apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app.js'), 'utf8');
const from = src.indexOf('  const SITTING = '), to = src.indexOf('  // Agent, job, what it was');
assert.ok(from > 0 && to > from, 'the guide rules are still where this test looks for them');
const { sittings, packLanes, MAX_LANES } = new Function(`${src.slice(from, to)}; return { sittings, packLanes, MAX_LANES };`)();

const MIN = 6e4, T = 1.8e12;
const deploys = [
  { kind: 'run', who: 'ios', from: T - 40 * MIN, to: T + 20 * MIN, job: { id: 1 } },
  { kind: 'run', who: 'web', from: T - 10 * MIN, to: T + 5 * MIN, job: { id: 2 } },
  { kind: 'run', who: 'api', from: T - 5 * MIN, to: T + 30 * MIN, job: { id: 3 } },
];
// alex-0b's test loop: 8 runs of 40 s, 10 s apart.
const tests = Array.from({ length: 8 }, (_, i) => ({ kind: i === 5 ? 'failed' : 'ran', who: 'alex-0b', from: T - 30 * MIN + i * 50e3, to: T - 30 * MIN + i * 50e3 + 40e3, id: 100 + i, code: i === 5 ? 1 : 0 }));

test('three deploys at once get three rows; no bar is ever drawn over another', () => {
  const lanes = packLanes(sittings(deploys));
  assert.equal(lanes.length, 3);
  for (const lane of lanes) for (let i = 1; i < lane.length; i++) assert.ok(lane[i - 1].to <= lane[i].from, 'one row never overlaps itself');
  // One that starts after another ends reuses its row.
  const later = { kind: 'run', who: 'ops', from: T + 25 * MIN, to: T + 28 * MIN, job: { id: 4 } };
  assert.equal(packLanes(sittings([...deploys, later])).length, 3);
});

test("one agent's runs less than 30 s apart are one bar that knows how many runs and failures it holds", () => {
  const bars = sittings(tests);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].runs.length, 8);
  assert.equal(bars[0].kind, 'failed', 'one of the eight failed');
  assert.equal(bars[0].to, tests[7].to);
  const apart = tests.map((r, i) => ({ ...r, from: r.from + i * 60e3, to: r.to + i * 60e3 }));
  assert.equal(sittings(apart).length, 8, 'a minute apart: separate tries, separate bars');
  const two = [...tests.slice(0, 2), { ...tests[2], who: 'alex-9c' }];
  assert.equal(sittings(two).length, 2, "another agent's run is never folded into this one's");
});

test('more than four rows: the first four are drawn, the rest wait behind a +N', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ kind: 'run', who: `a${i}`, from: T, to: T + 10 * MIN, job: { id: i } }));
  const lanes = packLanes(sittings(many));
  assert.equal(MAX_LANES, 4);
  assert.equal(lanes.length, 6);
  assert.equal(lanes.slice(MAX_LANES).flat().length, 2, 'two for the +N');
});

test("a bar too narrow for the agent's name falls back to what's still worth reading: the run count, or the session's short suffix", () => {
  const { barLabels } = new Function(`${src.slice(from, to)}; return { barLabels };`)();
  const [merged] = sittings(tests);
  assert.deepEqual(barLabels(merged), ['alex-0b: 8 runs, 1 failed', '8 runs, 1 failed', '8 runs', '0b ×8', '×8']);
  const [one] = sittings([deploys[0]]);
  assert.deepEqual(barLabels({ ...one, who: 'alex-2e' }), ['alex-2e', '2e']);
});
