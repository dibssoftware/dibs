// What dibs says to someone who isn't technical: the plain sentences on the
// board, in dibs why and in dibs --json, for the situations people hit.
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, MACHINE, tmp, sync as dibs, bg as spawnDibs, until, board } from './helpers.mjs';
import { plainBoard, lineSentences, ordinal } from '../src/plain.mjs';
import { wrap, columns, quoted } from '../src/style.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const sync = (h, agent, args) => dibs(h, args, { agent });
const bg = (t, h, agent, args) => spawnDibs(t, h, args, { agent });

const T = 1_000_000_000_000;
const MIN = 6e4;
// roomyMemFree over 100 means the machine never counts as roomy, so the budgets always apply.
const cfg = { ...DEFAULT_CONFIG, roomyMemFree: 101, resources: { ...DEFAULT_CONFIG.resources }, quotas: { asc: { per: '1h', limit: 10 } } };
let n = 0;
const q = (o = {}) => ({ id: ++n, res: ['sim'], mem: 1 * G, cpu: 1, disk: 0, pid: 1, who: `w${n}`, enq: T, key: `sim|w${n}`, ...o });
const lease = (o = {}) => ({ id: ++n, res: ['sim'], mem: 1 * G, cpu: 1, kind: 'run', pid: 1, who: 'onboarding', start: T, key: 'sim|xcrun', ...o });
const st = (leases = [], queue = [], extra = {}) => ({ leases, queue, ...extra });
const onMachine = (o, fn) => {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, ...o });
  try { return fn(); } finally { process.env.DIBS_FAKE_MACHINE = was; }
};
const view = (s, hist = [], c = cfg) => plainBoard(s, c, hist, T);
const line = (p, r) => p.lines.find(l => l.res === r);
// A run time in history: dibs knows how long this command takes.
const ran = (key, dur, who = 'someone', at = T - 3 * 3.6e6) => ({ key, dur, who, at });

test('ordinals read the way people say them', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd']);
});

// One row per situation: the state, then what the person should read.
const SITUATIONS = [
  ['nothing running: every line is free', () => st(), p => {
    assert.equal(line(p, 'sim').summary, 'Free');
    assert.equal(line(p, 'sim').clearsIn, 0);
    assert.deepEqual(lineSentences(p), ['Free: Simulator, Private simulators, Xcode builds, Browser tests, Test runs, Deploys, Heavy jobs.']);
  }],
  ['in use with a known run time: about N min left, and the waiter starts in about N min', () => {
    const l = lease({ purpose: 'snapshot tests' });
    return { s: st([l], [q({ who: 'ios-checkout' })]), hist: [ran('sim|xcrun', 4 * MIN)] };
  }, (p, s) => {
    const w = p.waiting.get(s.queue[0].id);
    assert.equal(w.headline, 'Next in the simulator queue');
    assert.equal(w.startsText, 'about 4 min');
    assert.equal(w.startsIn, 4 * MIN);
    assert.equal(w.waitingFor, "onboarding's snapshot tests to finish (about 4 min left)");
    assert.equal(lineSentences(p)[0], 'Simulator: onboarding is using it, about 4 min left. Next: ios-checkout.');
    assert.equal(p.held.get(s.leases[0].id).headline, 'Using the simulator');
    assert.equal(p.held.get(s.leases[0].id).endsText, 'about 4 min left');
  }],
  ['in use with no run time: "as soon as X finishes", never a made-up number', () => st([lease()], [q({ who: 'ios-checkout' }), q({ who: 'web-app' })]), (p, s) => {
    const [a, b] = s.queue.map(x => p.waiting.get(x.id));
    assert.equal(a.startsText, 'as soon as onboarding finishes');
    assert.equal(a.startsIn, null);
    assert.equal(a.waitingFor, "onboarding's simulator run to finish");
    assert.equal(b.headline, '2nd in the simulator queue');
    assert.equal(b.waitingFor, "ios-checkout to go first, and onboarding's simulator run to finish");
    assert.equal(b.startsText, 'as soon as ios-checkout finishes');
    assert.equal(line(p, 'sim').summary, '1 in use, 2 waiting');
    assert.equal(line(p, 'sim').clearsIn, null);
    assert.equal(lineSentences(p)[0], 'Simulator: onboarding is using it, time left unknown. Next: ios-checkout, then web-app.');
  }],
  ['behind a waiter with a known run time: names the job running now, never a made-up number', () => {
    const hold = lease({ kind: 'hold', who: 'ios-checkout', expires: T + 14 * MIN });
    return st([hold], [q({ who: 'onboarding', est: 2 * MIN, kind: 'run' }), q({ who: 'ios-checkout', res: ['sim', 'xcode-build'], kind: 'run' })]);
  }, (p, s) => {
    const w = p.waiting.get(s.queue[1].id);
    assert.doesNotMatch(w.waitingFor, /NaN/);
    assert.equal(w.waitingFor, 'onboarding to go first, and ios-checkout to give the simulator back (up to 14 min left)');
  }],
  ['a hold: "up to" its time left, since it may be given back sooner', () => st([lease({ kind: 'hold', expires: T + 12 * MIN })], [q({ who: 'ios-checkout' })]), (p, s) => {
    const w = p.waiting.get(s.queue[0].id);
    assert.equal(w.waitingFor, 'onboarding to give the simulator back (up to 12 min left)');
    assert.equal(w.startsText, 'as soon as onboarding finishes');
  }],
  ['a busy line with known times says when it clears', () => {
    const hist = [ran('sim|xcrun', 4 * MIN), ran('sim|test', 3 * MIN)];
    return { s: st([lease()], [q({ who: 'a', key: 'sim|test' }), q({ who: 'b', key: 'sim|test' })]), hist };
  }, p => assert.equal(line(p, 'sim').summary, '1 in use, 2 waiting, clear in about 10 min')],
  ['low disk: says the numbers, and the start time is unknown', () => onMachine({ diskFree: 8.8 * G }, () => {
    const s = st([lease({ res: ['test'] })], [q({ who: 'ios-checkout', disk: 9 * G })]);
    return { s, p: view(s) };
  }), (p, s) => {
    const w = p.waiting.get(s.queue[0].id);
    assert.equal(w.waitingFor, 'more free disk (8.8 GB free, it needs 9.0 GB)');
    assert.equal(w.startsText, 'unknown');
    assert.equal(lineSentences(p)[0], 'Simulator: free, but ios-checkout is waiting for more free disk (8.8 GB free, it needs 9.0 GB).');
  }],
  ['over the load ceiling: waiting for the machine to cool down', () => onMachine({ load: 11 }, () => {
    const s = st([lease({ res: ['test'] })], [q({ who: 'ios-checkout' })]);
    return { s, p: view(s, [], { ...cfg, maxLoad: 10 }) };
  }), (p, s) => {
    assert.match(p.waiting.get(s.queue[0].id).waitingFor, /^the machine to cool down \(load 11\.0; new work waits while it's over 10\)\. Held by load since \d\d:\d\d( [AP]M)?, starts by \d\d:\d\d( [AP]M)? at the latest/i);
    assert.equal(p.waiting.get(s.queue[0].id).startsText, 'unknown');
  }],
  ['memory share used up: says how much is out and how much it needs, without the word budget', () => {
    const s = st([lease({ res: ['test'], mem: 6 * G })], [q({ who: 'big', mem: 3 * G })]);
    return { s, p: view(s) };
  }, (p, s) => {
    const w = p.waiting.get(s.queue[0].id);
    assert.match(w.waitingFor, /^room in memory: it needs 3\.0 GB; 6\.0 GB of the 8\.0 GB dibs shares out is taken, 2\.0 GB left, and the machine has [\d.]+ GB free or reclaimable\. Taking the most: \w+ #\d+: not measured yet, asked 6\.0 GB$/);
    assert.equal(w.advice, 'Keep waiting: raising the priority is not the fix');
    assert.doesNotMatch(w.waitingFor, /budget/);
  }],
  ['a file lease: who has the path, and the overlap', () => st(
    [lease({ res: ['files:/repo/src/auth/**'], who: 'alice', kind: 'hold', expires: T + 5 * MIN })],
    [q({ res: ['files:/repo/src/auth/login.ts'], who: 'carol' })]), (p, s) => {
    const w = p.waiting.get(s.queue[0].id);
    assert.equal(w.waitingFor, 'alice to finish with the files in /repo/src/auth, which include /repo/src/auth/login.ts (up to 5 min left)');
    assert.equal(line(p, 'files:/repo/src/auth/**').label, 'Files in /repo/src/auth');
    assert.match(lineSentences(p)[0], /^Files in \/repo\/src\/auth: alice has reserved them, up to 5 min left\.$/);
    assert.equal(lineSentences(p)[1], 'Files in /repo/src/auth/login.ts: free, but carol is waiting for alice to finish with the files in /repo/src/auth, which include /repo/src/auth/login.ts (up to 5 min left).');
  }],
  ['a quota: when it refills, worked out from the refill rate', () => st([], [q({ res: ['quota:asc'], who: 'uploader', cost: 5 })], { quotas: { asc: { tokens: 0, at: T } } }), (p, s) => {
    const w = p.waiting.get(s.queue[0].id);
    assert.equal(w.headline, 'Next in the App Store Connect budget queue');
    assert.equal(w.waitingFor, 'the App Store Connect budget to refill (0 of 10 left, enough in about 30 min)');
    assert.equal(w.startsText, 'about 30 min');
  }],
  ['paused for urgent work: says whose and what', () => st([lease({ res: ['test'], who: 'audit', prio: 'low', pausedAt: T,
    pauses: [{ lease: 99, who: 'web-app', prio: 'urgent', res: ['deploy'], at: T }] })]), (p, s) => {
    assert.equal(p.held.get(s.leases[0].id).paused, "Paused so web-app's urgent deploy could go first");
    assert.match(lineSentences(p)[0], /\(paused so web-app's urgent deploy could go first\)/);
  }],
  ['paused by the person, or by memory pressure', () => st([
    lease({ res: ['test'], pausedAt: T, pauses: [{ owner: true, at: T }] }),
    lease({ res: ['heavy'], pausedAt: T, pauses: [{ watcher: 5, at: T }] })]), (p, s) => {
    assert.equal(p.held.get(s.leases[0].id).paused, 'Paused by the person at this machine');
    assert.equal(p.held.get(s.leases[1].id).paused, 'Paused because the machine is short on memory');
  }],
  ['moved up: urgent, with the reason everyone sees', () => st([lease()], [q({ who: 'web-app', prio: 'urgent', purpose: 'prod is down' })]), (p, s) => {
    assert.deepEqual(p.waiting.get(s.queue[0].id).moves, [{ dir: 'up', amount: '2 hr', label: 'urgent', reason: "it's urgent: prod is down" }]);
  }],
  ['moved back: this agent used the simulator a lot in the last hour', () => {
    const hist = [ran('sim|xcrun', 30 * MIN, 'heavy', T - MIN)];
    return { s: st([lease()], [q({ who: 'heavy' })]), hist };
  }, (p, s) => {
    assert.deepEqual(p.waiting.get(s.queue[0].id).moves, [{ dir: 'down', amount: '6 min', label: 'taking turns', reason: 'this agent used the simulator a lot in the last hour' }]);
  }],
  ['moved up: let ahead, short job and a deadline each name their reason', () => {
    const hist = [ran('sim|quick', 30e3)];
    return { s: st([lease()], [q({ key: 'sim|quick', yieldRank: T - 20 * MIN, yieldBy: 'ios-checkout' }), q({ by: T + 5 * MIN, est: 10 * MIN })]), hist };
  }, (p, s) => {
    const [a, b] = s.queue.map(x => p.waiting.get(x.id).moves.map(m => m.reason));
    assert.deepEqual(a, ["it's a short job (under a minute)", 'ios-checkout let it go first']);
    assert.match(b[0], /^it's due by /);
  }],
  ['several resources: one sentence each, busiest first', () => st(
    [lease(), lease({ res: ['xcode-build'], who: 'web-app' }), lease({ res: ['xcode-build'], who: 'ios-checkout' })],
    [q({ res: ['sim', 'xcode-build'], who: 'api-refactor' }), q({ res: ['xcode-build'], who: 'onboarding' })]), (p, s) => {
    assert.deepEqual(p.lines.slice(0, 2).map(l => l.res), ['xcode-build', 'sim']);
    const w = p.waiting.get(s.queue[0].id);
    assert.equal(w.headline, 'Next in the simulator queue');
    assert.equal(p.held.get(s.leases[0].id).headline, 'Using the simulator');
    assert.equal(lineSentences(p)[0], 'Xcode builds: web-app and ios-checkout are building, time left unknown for both. Next: api-refactor, then onboarding.'
      + " api-refactor also needs the simulator and is waiting for onboarding's simulator run to finish.");
  }],
  ['a run on two resources has one headline', () => st([lease({ res: ['sim', 'xcode-build'] })]), (p, s) => {
    assert.equal(p.held.get(s.leases[0].id).headline, 'Using the simulator and building with Xcode');
  }],
  ['a label in the config names a resource dibs does not know', () => ({ s: st([lease({ res: ['gpu'] })]), cfg: { ...cfg, resources: { ...cfg.resources, gpu: { slots: 1, label: 'The GPU' } } } }), p => {
    assert.equal(line(p, 'gpu').label, 'The GPU');
  }],
];

for (const [name, setup, check] of SITUATIONS) {
  test(`plain: ${name}`, () => {
    const r = setup();
    const s = r.s || r;
    const p = r.p || view(s, r.hist || [], r.cfg || cfg);
    check(p, s);
  });
}

// Words a person who isn't technical shouldn't have to learn, from the contract.
const JARGON = /\b(lease|slot|preempt|QoS|rank|verdict|pace)\b/i;
const LONG_DASH = String.fromCharCode(0x2014);
test('no plain sentence uses the words people would have to learn', () => {
  for (const [, setup] of SITUATIONS) {
    const r = setup();
    const s = r.s || r;
    const p = r.p || view(s, r.hist || [], r.cfg || cfg);
    const text = [...lineSentences(p), ...p.lines.map(l => l.summary), ...[...p.held.values()].flatMap(h => [h.headline, h.endsText, h.paused || '']),
      ...[...p.waiting.values()].flatMap(w => [w.headline, w.startsText, w.waitingFor, ...w.moves.map(m => m.reason)])];
    for (const x of text) {
      assert.doesNotMatch(x, JARGON, x);
      assert.doesNotMatch(x, /—/, x);
    }
  }
});

test('dibs --json: lines, and plain on every held and waiting row, shaped like the contract', async t => {
  const h = tmp(t);
  bg(t, h, 'onboarding', ['-m', 'snapshot tests', 'sim', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  bg(t, h, 'ios-checkout', ['sim', '--', 'true']);
  await until(() => board(h).waiting.length === 1);
  const b = board(h);
  const sim = b.lines[0];
  assert.equal(sim.res, 'sim');
  assert.equal(sim.label, 'Simulator');
  assert.deepEqual(Object.keys(sim).sort(), ['clearsIn', 'label', 'res', 'serving', 'summary', 'waiting']);
  assert.deepEqual(Object.keys(sim.serving[0]).sort(), ['endsIn', 'endsText', 'id', 'label', 'purpose', 'who']);
  assert.equal(sim.serving[0].purpose, 'snapshot tests');
  assert.equal(sim.summary, '1 in use, 1 waiting');
  assert.deepEqual(sim.waiting, [b.waiting[0].id]);
  assert.deepEqual(Object.keys(b.waiting[0].plain).sort(), ['ahead', 'family', 'headline', 'moves', 'of', 'place', 'res', 'startsIn', 'startsText', 'waitingFor']);
  assert.equal(b.waiting[0].plain.headline, 'Next in the simulator queue');
  assert.equal(b.waiting[0].plain.startsText, 'as soon as onboarding finishes');
  assert.deepEqual(b.held[0].plain, { headline: 'Using the simulator', endsText: 'time left unknown', paused: null });
  assert.ok(b.lines.slice(1).every(l => l.summary === 'Free'));
});

test('plain dibs leads with the answer, then a column per line; --detail keeps the table', async t => {
  const h = tmp(t);
  assert.match(sync(h, 'viewer', []).out.split('\n')[0], /^Nothing queued\. Everything's free\.$/);
  bg(t, h, 'onboarding', ['sim', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  bg(t, h, 'ios-checkout', ['sim', '--', 'true']);
  await until(() => board(h).waiting.length === 1);
  const out = sync(h, 'viewer', []).out;
  const lines = out.split('\n');
  assert.equal(lines[0], '1 running, 1 waiting. Next up: ios-checkout for the simulator, as soon as onboarding finishes.');
  assert.equal(lines[2], 'Simulator   onboarding is using it, time left unknown');
  assert.equal(lines[3], '            Next: ios-checkout');
  assert.match(out, /^Free {8}Private simulators, Xcode builds/m);
  assert.ok(lines.every(l => l.length <= 100), 'nothing wider than 100 columns');
  assert.doesNotMatch(out, /HELD|QUEUE|\x1b\[/);
  assert.match(sync(h, 'viewer', ['--detail']).out, /HELD\n {2}sim +onboarding/);
  // An agent reading the board sees its own place first.
  assert.match(sync(h, 'ios-checkout', []).out.split('\n')[1], /^You: next in the simulator queue, as soon as onboarding finishes\. Why: dibs why$/);
});

test('dibs why says it in sentences, with who to ask; --detail still has the math', async t => {
  const h = tmp(t);
  bg(t, h, 'onboarding', ['sim', '--', 'sleep', '30']);
  await until(() => board(h).held.length === 1);
  bg(t, h, 'web-app', ['-p', 'urgent', '-m', 'prod is down', 'sim', '--', 'true']);
  await until(() => board(h).waiting.length === 1);
  const plain = sync(h, 'web-app', ['why']).out;
  assert.match(plain, /^You're next in the simulator queue \("prod is down"\)\. Starts as soon as onboarding finishes\.$/m);
  assert.match(plain, /^ {2}Waiting for onboarding's simulator run to finish\.$/m);
  assert.match(plain, /^ {2}Moved ahead because it's urgent: prod is down\.$/m);
  assert.match(plain, /^To go first, ask onboarding to run: dibs yield web-app$/m, "outside Claude Code there's no SendMessage to point at");
  const inClaude = dibs(h, ['why'], { agent: 'web-app', env: { CLAUDECODE: '1' } }).out;
  assert.match(inClaude, /^To go first, ask onboarding to run: dibs yield web-app$/m, "onboarding isn't a Claude Code session SendMessage can reach");
  assert.doesNotMatch(plain, /2 hr|120 min/, 'how far is detail, not the plain sentence');
  const detail = sync(h, 'web-app', ['why', '--detail']).out;
  assert.match(detail, /blocked by slot: sim is in use/);
  assert.match(detail, /place in the queue: arrived .+, urgent \+2h00m/);
});

test('dibs why points a Claude Code agent at SendMessage only when the one ahead is a Claude Code session too', async t => {
  const h = tmp(t);
  spawnDibs(t, h, ['sim', '--', 'sleep', '30'], { agent: 'onboarding', env: { CLAUDE_CODE_SESSION_ID: 'sess-o' } });
  await until(() => board(h).held.length === 1);
  spawnDibs(t, h, ['-p', 'urgent', '-m', 'prod is down', 'sim', '--', 'true'], { agent: 'web-app' });
  await until(() => board(h).waiting.length === 1);
  assert.match(dibs(h, ['why'], { agent: 'web-app', env: { CLAUDECODE: '1' } }).out, /^To ask onboarding to let you go first: SendMessage onboarding\. They run: dibs yield web-app$/m);
  assert.match(dibs(h, ['why'], { agent: 'web-app' }).out, /^To go first, ask onboarding to run: dibs yield web-app$/m);
});

test('dibs mine says what you have and where you wait, and exits 1 with nothing', async t => {
  const h = tmp(t);
  assert.equal(sync(h, 'a', ['hold', 'deploy', '--for', '5m']).code, 0);
  assert.match(sync(h, 'a', ['mine']).out, /^You've reserved deploys \(#\d+\) until .* \(up to 5 min left\)\. Give it back: dibs release deploy\n$/);
  const none = sync(h, 'b', ['mine']);
  assert.equal(none.code, 1);
  assert.equal(none.out, "You don't have anything and aren't waiting for anything.\n");
});

test('color only on a terminal: piped output is plain, FORCE_COLOR paints it, NO_COLOR wins', t => {
  const h = tmp(t);
  assert.doesNotMatch(sync(h, 'viewer', []).out, /\x1b\[/);
  const forced = dibs(h, [], { agent: 'viewer', env: { FORCE_COLOR: '1' } }).out;
  assert.match(forced, /^\x1b\[1mNothing queued\. Everything's free\.\x1b\[22m$/m);
  assert.doesNotMatch(dibs(h, [], { agent: 'viewer', env: { FORCE_COLOR: '1', NO_COLOR: '1' } }).out, /\x1b\[/);
  // Errors are red; "not your turn yet" (75) and "nothing matched" (1) aren't errors.
  assert.match(dibs(h, ['run', '--', 'true'], { agent: 'a', env: { FORCE_COLOR: '1' } }).err, /^\x1b\[31mdibs:\x1b\[39m which resource/m);
  assert.match(dibs(h, ['release'], { agent: 'a', env: { FORCE_COLOR: '1' } }).err, /^dibs: you have nothing reserved/m);
});

test('wrapping keeps lines inside the width, under their own indent', () => {
  const long = 'Waiting for hotfix and ios-checkout to go first, and onboarding\'s snapshot tests to finish (about 4 min left).';
  const w = wrap(`  ${long}`, '    ', 50).split('\n');
  assert.ok(w.every(l => l.length <= 50), w.join('|'));
  assert.ok(w[0].startsWith('  Waiting') && w.slice(1).every(l => l.startsWith('    ') && l[4] !== ' '));
  const c = columns([['Simulator', long, 'Next: a'], ['A label far too long for the column', 'text']], 60, 12);
  assert.ok(c.every(l => l.length <= 60), c.join('|'));
  assert.equal(c.at(-2), 'A label far too long for the column');
  assert.equal(c.at(-1), '               text');
  assert.equal(quoted(['run', 'sim', '-m', "it's urgent", '--', 'echo', 'a b']), "run sim -m 'it'\\''s urgent' -- echo 'a b'");
});

test("the footer names the caller only when it's an agent", t => {
  const h = tmp(t);
  assert.match(sync(h, 'web-app', []).out, /^You're web-app\. Why you're waiting: dibs why\./m);
  const person = sync(h, '', []).out;
  assert.match(person, /^More: dibs why, dibs --detail$/m);
  assert.doesNotMatch(person, /You're/);
});

test('questions waiting for the person lead the plain board', t => {
  const h = tmp(t);
  sync(h, 'shipper', ['question', 'Ship 123 now please?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'tests pass', '--one-way', 'it can not be taken back once done']);
  assert.match(sync(h, 'viewer', []).out.split('\n')[1], /^1 question is waiting for your answer: dibs questions$/);
});
