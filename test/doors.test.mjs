// Questions for the person are one-way doors only. A question carries the
// asker's recommendation and why; without --one-way, dibs answers at once
// with the recommendation and shows the person the decision as done. Junk
// ("2") is refused, the person can answer in words, dibs's own notices stay
// out of the person's threads, and a desk agent answers the person's chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, flat, PERSON, AGENT } from './helpers.mjs';

const qs = h => JSON.parse(sync(h, ['questions', '--json'], { agent: 'viewer' }).out);
const threads = h => JSON.parse(sync(h, ['threads', '--json'], { agent: 'viewer' }).out);
const ASK = ['Use port 5173 for the dev server?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'nothing else listens there'];

test('a two-way door is decided at once with the recommendation: exit 0, the answer on stdout, logged, and shown to the person as done', t => {
  const h = tmp(t);
  const r = sync(h, ['question', ...ASK, '--wait'], { agent: 'web-app' });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'yes');
  assert.match(flat(r.err), /decided by web-app: two-way door, so nobody was asked\. Go ahead with yes/);
  const q = qs(h);
  assert.equal(q.open, 0, 'nothing for the person to answer');
  assert.deepEqual([q.questions[0].state, q.questions[0].answer, q.questions[0].recommend, q.questions[0].oneWay], ['decided', 'yes', 'yes', false]);
  const ev = JSON.parse(sync(h, ['history', '--json'], { agent: 'viewer' }).out).events.find(e => e.act === 'decided');
  assert.deepEqual([ev.by, ev.answer, ev.why], ['web-app', 'yes', 'nothing else listens there']);
  const m = threads(h).threads[0].messages[0];
  assert.deepEqual([m.kind, m.answer, m.why], ['decided', 'yes', 'nothing else listens there']);
  assert.equal(sync(h, ['question', ...ASK], { agent: 'web-app' }).out.trim(), 'yes', 'asked again: the same decision');
});

test('junk is refused before anything is recorded: a number, no recommendation, no reason, or a recommendation that is no option', t => {
  const h = tmp(t);
  for (const [args, msg] of [
    [['2', '--recommend', 'yes', '-m', 'x'], /"2" isn't a question anyone can answer: write it out in a short sentence/],
    [['Ship build 123 now?', '--options', 'yes,no'], /say what you'd do: --recommend <option>/],
    [['Ship build 123 now?', '--options', 'yes,no', '--recommend', 'yes'], /say why you recommend yes: -m "why"/],
    [['Ship build 123 now?', '--options', 'yes,no', '--recommend', 'maybe', '-m', 'x'], /--recommend maybe isn't one of the --options \(yes, no\)/],
    [['Ship build 123 now?', '--options', 'yes,Yes', '--recommend', 'yes', '-m', 'x'], /the same choice twice/],
    [['Ship build 123 now?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'x', '--one-way', 'no'], /--one-way says what can't be undone, in a short sentence/],
  ]) {
    const r = sync(h, ['question', ...args], { agent: 'b8' });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(flat(r.err), msg);
  }
  assert.deepEqual(qs(h).questions, []);
});

test('a one-way door reaches the person with what can not be undone, and the person may answer in their own words', async t => {
  const h = tmp(t);
  const w = bg(t, h, ['question', 'Delete the release branch now?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'merged into main',
    '--one-way', 'the branch has 3 commits not on main', '--wait'], { agent: 'web-app' });
  await until(() => qs(h).questions[0]?.waiting);
  const q = qs(h);
  assert.equal(q.open, 1);
  assert.deepEqual([q.questions[0].oneWay, q.questions[0].cantUndo, q.questions[0].recommend, q.questions[0].why],
    [true, 'the branch has 3 commits not on main', 'yes', 'merged into main']);
  assert.match(sync(h, ['questions'], { agent: 'viewer' }).out, /They recommend yes: merged into main[\s\S]*Can't be undone: the branch has 3 commits not on main/);
  const a = sync(h, ['answer', String(q.questions[0].id), 'keep it until Monday, then ask me again'], PERSON);
  assert.equal(a.code, 0, a.err);
  assert.equal(await w.done, 0);
  assert.equal(w.out.trim(), 'keep it until Monday, then ask me again', 'the words are the answer');
  assert.equal(qs(h).questions[0].freeText, true);
  const th = threads(h).threads[0];
  assert.ok(th.messages.some(m => m.kind === 'message' && m.from === 'person' && /keep it until Monday/.test(m.text)), 'and a message the hook hands over');
  assert.ok(th.messages.some(m => m.kind === 'answer' && m.freeText));
});

test('the desk: dibs tell desk reaches the agent config names, which answers the person with dibs say --to person', t => {
  const h = tmp(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ desk: 'helper' }));
  assert.equal(sync(h, ['say', 'on the desk today'], { agent: 'helper' }).code, 0);
  assert.equal(sync(h, ['say', 'tests pass'], { agent: 'other' }).code, 0);
  const told = sync(h, ['tell', 'desk', 'why is my build waiting?'], PERSON);
  assert.equal(told.code, 0, told.err);
  assert.match(told.out, /queued for helper/);
  assert.equal(sync(h, ['say', '--to', 'person', 'it waits for memory; about 3 minutes'], { agent: 'helper' }).code, 0);
  const j = threads(h);
  assert.equal(j.desk, 'helper');
  const desk = j.threads.find(x => x.to === 'helper');
  assert.equal(desk.desk, true);
  assert.ok(desk.messages.some(m => m.kind === 'message' && m.text === 'why is my build waiting?'));
  assert.ok(desk.messages.some(m => m.kind === 'note' && m.reply && /about 3 minutes/.test(m.text)));
  assert.ok(j.threads.find(x => x.to === 'other').messages.every(m => m.kind !== 'note' || m.fyi), 'other notes are FYI');
  // dibs say --to <agent> is a tell from the caller (2026-11-03: everyone wrote it that way).
  const peer = sync(h, ['say', '--to', 'other', 'your build is next'], { agent: 'helper', ...AGENT });
  assert.equal(peer.code, 0, peer.err);
  assert.match(peer.out, /^Sent as a message to other \(dibs tell other\): /);
  assert.equal(peer.out.trim().split('\n').length, 1, 'one line');
  const toOther = threads(h).threads.find(x => x.to === 'other').messages.find(m => m.text === 'your build is next');
  assert.equal(toOther.kind, 'message');
  assert.equal(toOther.by, 'helper', 'from the agent, never the person');
  assert.equal(sync(h, ['say', '--to', 'nobody-here', 'x'], { agent: 'helper' }).code, 1);
  fs.writeFileSync(path.join(h, 'config.json'), '{}');
  assert.match(sync(h, ['tell', 'desk', 'hi'], PERSON).err, /no desk agent is set/);
});
