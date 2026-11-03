// onRelease: the command that puts a resource back after each lease on it ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder and fakes the machine before any src module loads.
import { tmp, sync, bg, until, board, alive } from './helpers.mjs';
import { paths } from '../src/config.mjs';
import { withState } from '../src/state.mjs';
import { pstart } from '../src/proc.mjs';

// onRelease runs in the system's shell: sh here, cmd.exe on Windows. These are node one-liners
// both shells read the same: the script in double quotes, nothing in it either shell expands.
const js = (code, ...args) => `"${process.execPath}" -e "${code}" ${args.map(a => `"${a}"`).join(' ')}`;
const append = (file, text) => js(`require('fs').appendFileSync(process.argv[1], ${text} + String.fromCharCode(10))`, file);
const config = (h, resources) => fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources }));
const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
// Every reset finished or dropped. A test waits for this before it ends, so no
// supervisor is still writing to its folder after teardown.
const settled = h => board(h).resets.length === 0;

test('a run that ends normally: onRelease runs once, told who released it', async t => {
  const h = tmp(t);
  const out = path.join(h, 'out');
  config(h, { t: { onRelease: append(out, "process.env.DIBS_RESOURCE + ' ' + process.env.DIBS_RELEASED_BY") } });
  assert.equal(sync(h, ['run', 't', '--', 'true'], { agent: 'a' }).code, 0);
  await until(() => settled(h) && read(out));   // settled first: reading the board is what reaps
  board(h);   // later state reads must not run it again
  assert.equal(read(out), 't a\n');
});

test('a dibs killed with -9: the next dibs call resets it, once', async t => {
  const h = tmp(t);
  const out = path.join(h, 'out');
  config(h, { t: { onRelease: append(out, "'reset'") } });
  const p = bg(t, h, ['run', 't', '--', 'sleep', '30'], { agent: 'a' });
  await until(() => board(h).held.length === 1);
  p.kill('SIGKILL');
  await p.done;
  await until(() => settled(h) && read(out));   // settled first: reading the board is what reaps
  board(h);
  assert.equal(read(out), 'reset\n');
});

test('a hold that runs out resets it, once', async t => {
  const h = tmp(t);
  const out = path.join(h, 'out');
  config(h, { t: { onRelease: append(out, "'reset'") } });
  assert.equal(sync(h, ['hold', 't', '--for', '1s'], { agent: 'a' }).code, 0);
  await until(() => settled(h) && read(out));   // settled first: reading the board is what reaps
  board(h);
  assert.equal(read(out), 'reset\n');
});

test("a run covered by its session's hold doesn't reset; the hold's end does", async () => {
  const out = path.join(path.dirname(paths.config), 'covered-out');
  fs.writeFileSync(paths.config, JSON.stringify({ resources: { cov: { onRelease: append(out, "'reset'") } } }));
  const me = { pid: process.pid, pstart: pstart(process.pid), who: 's', start: Date.now(), key: 'k', mem: 0, cpu: 1 };
  withState(s => {
    s.leases.push({ ...me, id: 9001, kind: 'hold', res: ['cov'], expires: Date.now() + 6e5 },
      { ...me, id: 9002, kind: 'run', res: ['cov'], covered: ['cov'], spid: process.pid });
  });
  withState(s => { s.leases = s.leases.filter(l => l.id !== 9002); });
  assert.equal(withState(s => (s.resets || []).length), 0);
  withState(s => { s.leases = s.leases.filter(l => l.id !== 9001); });
  await until(() => read(out) && withState(s => !s.resets.length));
  assert.equal(read(out), 'reset\n');
  fs.rmSync(paths.config);
});

test('a failing onRelease is logged and the job still succeeds; a hung one is killed at its timeout', async t => {
  const h = tmp(t);
  const pidfile = path.join(h, 'pid');
  const log = path.join(h, 'onrelease.log');
  config(h, { f: { onRelease: js("process.stderr.write('broke' + String.fromCharCode(10)); process.exit(3)") },
    g: { onRelease: js("require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)", pidfile), onReleaseTimeout: '1s' } });
  assert.equal(sync(h, ['run', 'f', '--', 'true']).code, 0);
  assert.equal(sync(h, ['run', 'g', '--', 'true']).code, 0);
  await until(() => /exited 3/.test(read(log)) && /killed after 1s/.test(read(log)) && settled(h));
  assert.match(read(log), /f after tester: exited 3: .*\n {2}broke/);
  assert.equal(alive(Number(read(pidfile))), false);
});

test('the next lease waits for the reset to finish', async t => {
  const h = tmp(t);
  const order = path.join(h, 'order');
  const gate = path.join(h, 'gate');
  // The reset lasts until the test opens the gate, so b is sure to find it running.
  config(h, { t: { onRelease: js("const fs = require('fs'); const t = setInterval(() => { if (!fs.existsSync(process.argv[1])) return; fs.appendFileSync(process.argv[2], 'reset' + String.fromCharCode(10)); clearInterval(t); }, 100)", gate, order) } });
  assert.equal(sync(h, ['run', 't', '--', 'true'], { agent: 'a' }).code, 0);
  const b = bg(t, h, ['run', 't', '--', 'sh', '-c', `echo b >> '${order}'`], { agent: 'b' });
  await until(() => /Waiting for t to be reset after a's turn\./.test(b.err));
  assert.equal(read(order), '');
  fs.writeFileSync(gate, '');
  assert.equal(await b.done, 0, b.err);
  assert.equal(read(order), 'reset\nb\n');
  await until(() => settled(h));
});
