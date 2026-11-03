// Named profiles in config.json, and config values that used to fail every
// call without saying which key was wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { G, tmp, sync, bg, until, board, flat } from './helpers.mjs';

const WIN = process.platform === 'win32';
const config = (h, c) => fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(c));
const WEB = { 'playwright:web': { res: 'playwright', ports: ['WEB', 'API'], mem: '3G', cpu: 2 } };

test('a profile gives a run its resource, its ports and its size', async t => {
  const h = tmp(t), cwd = tmp(t, 'job');
  config(h, { profiles: WEB });
  const r = sync(h, ['run', 'playwright:web', '--', 'sh', '-c', 'echo "ports $WEB $API"'], { cwd });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ports \d+ \d+$/m);
  const job = bg(t, h, ['run', 'playwright:web', '--', 'sh', '-c', 'while [ ! -f stop ]; do sleep 0.1; done'], { cwd });
  await until(() => board(h).held.length === 1);
  const l = board(h).held[0];
  assert.deepEqual(l.res, ['playwright']);
  assert.equal(l.mem, 3 * G);
  assert.equal(l.cpu, 2);
  // The command line wins over the profile.
  assert.match(flat(sync(h, ['when', 'playwright:web', '--mem', '1G']).out), /browser tests/);
  fs.writeFileSync(path.join(cwd, 'stop'), '');
  assert.equal(await job.done, 0);
});

test('a bad profile fails with its key named, before anything queues', t => {
  const h = tmp(t, 'bad');
  const cases = [
    [{ 'web:x': { res: 'playwright', mem: 'lots' } }, /profiles\["web:x"\] in .*config\.json: mem is a size like 3G, not "lots"/],
    [{ 'web:x': { res: 'playwright', ports: ['not a name'] } }, /profiles\["web:x"\].*ports is a list of variable names/],
    [{ 'web:x': { res: 'playwright', colour: 'red' } }, /profiles\["web:x"\].*unknown colour/],
    [{ 'web:x': { ports: ['WEB'] } }, /profiles\["web:x"\].*res names the resources it takes/],
    [{ test: { res: 'playwright' } }, /profiles\["test"\].*test is already a resource/],
    [{ 'files:x': { res: 'test' } }, /can't start with files: or quota:/],
  ];
  for (const [profiles, msg] of cases) {
    config(h, { profiles });
    const r = sync(h, ['run', 'web:x', '--', 'true']);
    assert.equal(r.code, 2, JSON.stringify(profiles));
    assert.match(r.err, msg);
  }
});

test('minDisk null means no floor; a budget that is not a size names its key', t => {
  const h = tmp(t);
  config(h, { minDisk: null });
  const r = sync(h, ['run', 'test', '--', 'true']);
  assert.equal(r.code, 0, r.err);
  config(h, { budget: null });
  const b = sync(h, ['run', 'test', '--', 'true']);
  assert.equal(b.code, 2);
  assert.match(b.err, /budget in .*config\.json is a size like 8G/);
  config(h, { minDisk: 'big' });
  assert.match(sync(h, ['run', 'test', '--', 'true']).err, /minDisk in .*config\.json is a size like 5G, or null for no floor, not "big"/);
});
