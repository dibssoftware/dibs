// Questions for the person: agents queue them, the person answers, and a
// waiting agent gets only the answer on stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync as dibs, bg, until, board } from './helpers.mjs';

const sync = (h, agent, args, opts) => dibs(h, args, { agent, ...opts });
const owner = { env: { DIBS_OWNER: '1' } };
const list = h => JSON.parse(sync(h, 'viewer', ['questions', '--json']).out);
const get = (h, id) => list(h).questions.find(q => q.id === id);
// A one-way door, the only kind that reaches the person: recommendation, why, and what can't be undone.
const DOOR = ['--recommend', 'yes', '-m', 'it looks ready', '--one-way', 'it can not be taken back once done'];
const door = args => (args.includes('--recommend') ? args : [...args, ...DOOR]);
const ask = (h, agent, args, opts) => {
  const r = sync(h, agent, ['question', ...door(args)], opts);
  assert.equal(r.code, 0, r.err);
  return Number(r.out);
};

test('an agent that asks with --wait gets only the answer on stdout', async t => {
  const h = tmp(t);
  const p = bg(t, h, ['question', ...door(['Ship build 123 to TestFlight now?', '--options', 'yes,no', '--wait'])], { agent: 'shipper' });
  await until(() => list(h).questions[0]?.waiting);
  const q = list(h).questions[0];
  assert.deepEqual([q.who, q.text, q.options, q.state], ['shipper', 'Ship build 123 to TestFlight now?', ['yes', 'no'], 'open']);
  assert.match(sync(h, 'viewer', []).out.split('\n')[1], /^1 question is waiting for your answer: dibs questions$/);
  assert.equal(board(h).questions, 1);
  const a = sync(h, 'person', ['answer', String(q.id), 'yes'], owner);
  assert.equal(a.code, 0, a.err);
  assert.equal(await p.done, 0, p.err);
  assert.equal(p.out, 'yes\n');
  assert.deepEqual([get(h, q.id).state, get(h, q.id).answer], ['answered', 'yes']);
  assert.equal(board(h).questions, 0);
});

test('asked without --wait: prints the id, and the same command with --wait later collects the answer', async t => {
  const h = tmp(t);
  const id = ask(h, 'a', ['Rename the app to Harbor?']);
  assert.equal(ask(h, 'a', ['Rename the app to Harbor?']), id, 'asking again is the same question');
  assert.notEqual(ask(h, 'b', ['Rename the app to Harbor?']), id, "another agent's question is its own");
  assert.equal(sync(h, 'person', ['answer', String(id), 'yes,', 'go', 'ahead'], owner).code, 0);
  const r = sync(h, 'a', ['question', ...door(['Rename the app to Harbor?', '--wait'])]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'yes, go ahead\n');
  assert.notEqual(ask(h, 'a', ['Rename the app to Harbor?']), id, 'once read, asking again is a new question');
});

test('open questions are listed by priority, then age, before the closed ones', t => {
  const h = tmp(t);
  const normal = ask(h, 'a', ['Which icon should ship?']);
  const low = ask(h, 'b', ['Tidy the README?', '-p', 'low']);
  const high = ask(h, 'c', ['Release blocker: roll back?', '-p', 'high']);
  const done = ask(h, 'd', ['Use port 8080 for it?']);
  assert.equal(sync(h, 'person', ['questions', 'dismiss', String(done)], owner).code, 0);
  assert.deepEqual(list(h).questions.map(q => q.id), [high, normal, low, done]);
  assert.equal(board(h).questions, 3);
  const plain = sync(h, 'viewer', ['questions']).out;
  assert.match(plain, /^3 open questions/);
  assert.ok(plain.indexOf('Release blocker') < plain.indexOf('Which icon') && plain.indexOf('Which icon') < plain.indexOf('Tidy the README'), plain);
  assert.match(plain, /Recently closed\n.*dismissed.*Use port 8080 for it\?/);
  assert.match(plain, new RegExp(`Answer: dibs answer ${high} yes \\(or your own words\\)    Dismiss: dibs questions dismiss ${high}`));
});

test('a wait with no answer by its limit exits 75 and prints nothing; inside Claude Code there is no limit', async t => {
  const h = tmp(t);
  const r = sync(h, 'a', ['question', ...door(['Deploy the site now?', '--wait', '--timeout', '1s'])]);
  assert.equal(r.code, 75, r.err);
  assert.equal(r.out, '');
  assert.match(r.err, /no answer to question \d+ by .*nothing was decided/);
  // The default limit applies outside Claude Code, and not inside a tool call.
  const outside = bg(t, h, ['question', ...door(['Merge it into main?', '--wait'])], { agent: 'b', env: { DIBS_MAX_WAIT: '1s' } });
  const inside = bg(t, h, ['question', ...door(['Bump the version?', '--wait'])], { agent: 'c', env: { DIBS_MAX_WAIT: '1s', CLAUDE_CODE_CHILD_SESSION: '1' } });
  assert.equal(await outside.done, 75, outside.err);
  await until(() => list(h).questions.some(q => q.text === 'Bump the version?' && q.waiting));
  const q = list(h).questions.find(q => q.text === 'Bump the version?');
  assert.equal(q.due, null);
  assert.equal(inside.exitCode, null, 'still waiting after the default limit');
  assert.equal(sync(h, 'person', ['answer', String(q.id), 'no'], owner).code, 0);
  assert.equal(await inside.done, 0, inside.err);
  assert.equal(inside.out, 'no\n');
});

test('asked, then collected with --wait --timeout: a wait that gives up leaves the question open for the person', async t => {
  const h = tmp(t);
  const id = ask(h, 'a', ['Run the production migration now?']);
  const r = sync(h, 'a', ['question', ...door(['Run the production migration now?', '--wait', '--timeout', '1s'])]);
  assert.equal(r.code, 75, r.err);
  assert.match(r.err, /It stays open for the person: run the same command again/);
  assert.equal(get(h, id).state, 'open', 'the wait gave up, not the question');
  assert.equal(get(h, id).due, null, "the wait's limit isn't the question's");
  assert.equal(sync(h, 'person', ['answer', String(id), 'yes'], owner).code, 0);
  const again = sync(h, 'a', ['question', ...door(['Run the production migration now?', '--wait', '--timeout', '5s'])]);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out, 'yes\n');
});

test('a dismissed question ends its wait with exit 75', async t => {
  const h = tmp(t);
  const p = bg(t, h, ['question', ...door(['Delete the old branch?', '--wait'])], { agent: 'a' });
  await until(() => list(h).questions[0]?.waiting);
  assert.equal(sync(h, 'person', ['questions', 'dismiss', String(list(h).questions[0].id)], owner).code, 0);
  assert.equal(await p.done, 75, p.err);
  assert.equal(p.out, '');
  assert.match(p.err, /was dismissed without an answer/);
});

test('an asker that dies: its open question expires', async t => {
  const h = tmp(t);
  const p = bg(t, h, ['question', ...door(['Pick a name for it?', '--wait'])], { agent: 'a' });
  await until(() => list(h).questions[0]?.waiting);
  const id = list(h).questions[0].id;
  p.kill('SIGKILL');
  await p.done;
  await until(() => get(h, id).state === 'expired');
  assert.equal(board(h).questions, 0);
  assert.match(sync(h, 'viewer', ['questions']).out, /^No open questions\./);
  const a = sync(h, 'person', ['answer', String(id), 'Harbor'], owner);
  assert.equal(a.code, 1);
  assert.match(a.err, /already expired/);
});

test('an answer picks an option however it is spelled, and an answer of the owner\'s own words is the answer too', t => {
  const h = tmp(t);
  const id = ask(h, 'a', ['Ship it to testers?', '--options', 'yes,no']);
  assert.equal(sync(h, 'person', ['answer', String(id), 'YES'], owner).code, 0);
  assert.equal(get(h, id).answer, 'yes');
  assert.equal(get(h, id).freeText, false);
  const other = ask(h, 'b', ['Rename the app to Harbor?', '--options', 'yes,no']);
  assert.equal(sync(h, 'person', ['answer', String(other), 'maybe', 'later'], owner).code, 0);
  assert.deepEqual([get(h, other).answer, get(h, other).freeText], ['maybe later', true]);
  for (const [args, msg] of [[['question'], /ask what\?/], [['question', ...door(['x', '--options', 'yes'])], /two or more choices/],
    [['question', ...door(['x', '-p', '9'])], /priority is one of/], [['answer', String(id)], /answer with what\?/], [['answer', 'x', 'yes'], /which question\?/]]) {
    const r = sync(h, 'a', args, owner);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, msg, args.join(' '));
  }
});

test('outside working hours, questions below urgent are held for the morning', t => {
  const h = tmp(t);
  // A window that starts two hours from now and ends three hours from now, so now is outside it.
  const d = new Date(), at = k => `${String((d.getHours() + k) % 24).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const hours = { start: at(2), end: at(3) };
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ hours }));
  const r = sync(h, 'a', ['question', ...door(['Which icon should ship?'])]);
  assert.match(r.err, /outside the person's hours/);
  const later = Number(r.out);
  const now = ask(h, 'b', ['Prod is down: roll back?', '-p', 'urgent']);
  const l = list(h);
  assert.deepEqual(l.hours, hours);
  assert.deepEqual(l.questions.map(q => [q.id, q.held]), [[now, false], [later, true]]);
  assert.equal(board(h).questions, 1, 'only the urgent one needs the person now');
  assert.match(sync(h, 'viewer', []).out.split('\n')[1], /^1 question is waiting for your answer/);
  const plain = sync(h, 'viewer', ['questions']).out;
  assert.match(plain, /^2 open questions \(1 held until \d\d:\d\d\)/);
  assert.match(plain, /\[for tomorrow\]\n\s+Which icon should ship\?/);
  // Inside the window, nothing is held.
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ hours: { start: at(23), end: at(2) } }));
  assert.equal(board(h).questions, 2);
});

test('dibs hours sets, shows and clears the working hours; an agent may set them too', t => {
  const h = tmp(t);
  const show = () => JSON.parse(sync(h, 'viewer', ['hours', '--json']).out);
  assert.equal(show(), null);
  assert.match(sync(h, 'viewer', ['hours']).out, /no hours set/);
  for (const bad of ['9-23', '09:00', '09:00-24:00', '09:00-09:00', '09:00-12:00-13:00', 'soon']) {
    const r = sync(h, 'person', ['hours', bad], owner);
    assert.equal(r.code, 2, bad);
    assert.match(r.err, /can't read hours/, bad);
  }
  const r = sync(h, 'person', ['hours', '9:00-23:00'], owner);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hours 09:00 to 23:00/);
  assert.deepEqual(show(), { start: '09:00', end: '23:00' });
  assert.deepEqual(list(h).hours, { start: '09:00', end: '23:00' });
  assert.equal(sync(h, 'a', ['hours', 'off'], { env: { CLAUDE_CODE_CHILD_SESSION: '1' } }).code, 0);
  assert.equal(show(), null);
});
