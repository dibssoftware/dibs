// dibs _reads, the Mac app's reader: one process that stays up and answers the
// CLI's read-only verbs, each exactly as the CLI prints it, and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, bg, until, BIN, env } from './helpers.mjs';

function reader(t, home) {
  const p = spawn(process.execPath, [BIN, '_reads'], { env: env(home), stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => p.kill());
  const answers = new Map();
  readline.createInterface({ input: p.stdout }).on('line', l => { const j = JSON.parse(l); answers.set(j.id, j); });
  let id = 0;
  const ask = async args => {
    const n = ++id;
    p.stdin.write(`${JSON.stringify({ id: n, args })}\n`);
    await until(() => answers.has(n));
    return answers.get(n);
  };
  return { p, ask };
}

test('the app\'s reader answers each read as the CLI prints it, from one process', async t => {
  const home = tmp(t, 'reads');
  bg(t, home, ['run', 'test', '-m', 'read me', '--', 'sleep', '60'], { agent: 'a1' });
  await until(() => JSON.parse(sync(home, ['--json']).out).held.some(l => l.purpose === 'read me'));
  sync(home, ['progress', 'reading along', '--task', 'r'], { agent: 'a1' });
  const r = reader(t, home);
  const board = await r.ask(['--json']);
  assert.equal(board.code, 0, board.err);
  assert.equal(JSON.parse(board.out).held.find(l => l.purpose === 'read me').who, JSON.parse(sync(home, ['--json']).out).held.find(l => l.purpose === 'read me').who);
  for (const args of [['questions', '--json'], ['threads', '--json'], ['later', 'list', '--json'], ['pace', '--json'], ['progress', '--json', '-n', '50']]) {
    const a = await r.ask(args);
    assert.equal(a.code, 0, `${args.join(' ')}: ${a.err}`);
    assert.deepEqual(JSON.parse(a.out), JSON.parse(sync(home, args).out), args.join(' '));
  }
  assert.equal((await r.ask(['--version'])).out.trim(), sync(home, ['--version']).out.trim());
  assert.equal(r.p.exitCode, null, 'still the same process');
});

test('the app\'s reader refuses anything that would change something, and ends when the app closes its side', async t => {
  const home = tmp(t, 'reads-refuse');
  const r = reader(t, home);
  for (const args of [['run', 'test', '--', 'echo', 'hi'], ['pace', 'max'], ['hours', '09:00-17:00'], ['progress', 'not a read'], ['later', 'cancel', 'l1'], ['pair'], ['guard', 'install']]) {
    const a = await r.ask(args);
    assert.equal(a.code, 2, args.join(' '));
    assert.match(a.err, /answers only the read-only verbs/);
  }
  assert.equal(JSON.parse(sync(home, ['pace', '--json']).out).pace, null, 'the pace never changed');
  r.p.stdin.end();
  await until(() => r.p.exitCode !== null);
  assert.equal(r.p.exitCode, 0);
});
