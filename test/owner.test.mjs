// Agents may do everything the person can (0.0.110): answer and dismiss
// questions, set hours and the pace, cap, tell, read threads, install the
// guard, change the group of machines, cancel anyone's scheduled run. Each
// change is logged with who made it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, group, AGENT, PERSON } from './helpers.mjs';

const agent = (h, args, o = {}) => sync(h, args, { agent: 'helper', ...o, env: { ...AGENT.env, ...o.env } });
const ok = r => { assert.equal(r.code, 0, r.err); return r; };
const ask = (h, q) => ok(sync(h, ['question', q, '--recommend', 'yes', '-m', 'it is ready', '--one-way', 'it can not be taken back once done'], { agent: 'asker' })).out.trim();
const questions = h => JSON.parse(sync(h, ['questions', '--json']).out).questions;
const changes = h => JSON.parse(sync(h, ['history', '--json'], { agent: 'viewer' }).out).events.filter(e => e.kind === 'override');

test("an agent answers and dismisses questions, sets hours and the pace, and caps; the log names it", t => {
  const h = tmp(t);
  const a = ask(h, 'Ship it to testers?'), b = ask(h, 'Rename the app now?');
  ok(agent(h, ['answer', a, 'yes']));
  ok(agent(h, ['questions', 'dismiss', b]));
  assert.deepEqual(questions(h).sort((x, y) => x.id - y.id).map(q => [String(q.id), q.state, q.answeredBy ?? null]), [[a, 'answered', 'helper'], [b, 'dismissed', null]]);
  ok(agent(h, ['hours', '09:00-23:00']));
  ok(agent(h, ['pace', 'quiet']));
  ok(agent(h, ['cap', 'pushy', 'low']));
  assert.match(sync(h, ['--detail'], { agent: 'viewer' }).out, /^capped: pushy at low \(by helper\)$/m);
  ok(sync(h, ['pace', 'off'], PERSON));
  const log = changes(h).map(e => [e.act, e.by, e.byAgent]);
  assert.deepEqual(log, [['answer', 'helper', true], ['dismiss', 'helper', true], ['hours', 'helper', true], ['pace', 'helper', true],
    ['cap', 'helper', true], ['pace', 'the person', false]]);
});

test('the agent that asked hears that an agent answered, beside the bare answer', async t => {
  const h = tmp(t);
  const w = bg(t, h, ['question', 'Deploy the site now?', '--options', 'yes,no', '--recommend', 'yes', '-m', 'tests pass', '--one-way', 'it can not be taken back once done', '--wait'], { agent: 'asker' });
  await until(() => questions(h).length === 1);
  ok(agent(h, ['answer', String(questions(h)[0].id), 'no']));
  assert.equal(await w.done, 0);
  assert.equal(w.out.trim(), 'no');
  assert.match(w.err, /answered by helper, an agent, not the person/);
});

test("an agent's dibs tell reaches the other agent marked as from that agent, never as the person", t => {
  const h = tmp(t);
  ok(sync(h, ['say', 'started'], { agent: 'worker' }));
  ok(agent(h, ['tell', 'worker', 'use the staging database']));
  ok(agent(h, ['threads', 'read', 'worker']));
  // Outside Claude Code it comes with worker's next dibs command, on stderr.
  const r = ok(sync(h, ['say', 'ok'], { agent: 'worker' }));
  assert.match(r.err, /Message from helper \(another agent, not the person\): use the staging database/);
  assert.doesNotMatch(r.out + r.err, /Message from the person/);
  assert.deepEqual(changes(h).map(e => [e.act, e.to, e.by]), [['tell', 'worker', 'helper']]);
});

test('an agent installs and removes the guard hook, and cancels another session\'s scheduled run', t => {
  const h = tmp(t), settings = path.join(tmp(t), 'settings.json');
  ok(agent(h, ['guard', 'install', '--settings', settings]));
  assert.match(fs.readFileSync(settings, 'utf8'), /dibs-guard/);
  ok(agent(h, ['guard', 'remove', '--settings', settings]));
  assert.doesNotMatch(fs.readFileSync(settings, 'utf8'), /dibs-guard/);
  const id = ok(sync(h, ['later', 'test', '--in', '1h', '--', 'true'], { agent: 'someone', cwd: tmp(t, 'proj') })).out.match(/^(l\d+):/)[1];
  ok(agent(h, ['later', 'cancel', id]));
  assert.equal(JSON.parse(sync(h, ['later', 'list', '--json']).out).jobs.find(j => j.id === id).state, 'cancelled');
  assert.deepEqual(changes(h).map(e => [e.act, e.by]), [['guard install', 'helper'], ['guard remove', 'helper']]);
});

test('an agent invites, joins, limits and kicks machines, and each change names it', async t => {
  const g = await group(t, { invite: true });
  ok(agent(g.h0, ['limit', 'beta', '--only', 'test']));
  ok(agent(g.h0, ['kick', 'beta']));
  const log = changes(g.h0).map(e => [e.act, e.machine, e.by]);
  assert.deepEqual(log, [['invite', 'alpha', 'helper'], ['invite', 'beta', 'helper'], ['invite', 'gamma', 'helper'],
    ['limit', 'beta', 'helper'], ['kick', 'beta', 'helper']].map(([a, m]) => [a, m, a === 'invite' ? 'tester' : 'helper']));
  assert.ok(changes(g.ha).some(e => e.act === 'join' && !('token' in e) && e.byAgent));
});
