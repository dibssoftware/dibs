// Who is filling the disk: under the disk floor, the biggest session folders
// in Claude Code's temp folder are measured, their agents hear about it once
// per drop, and a disk wait names the biggest and whose it is.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, tmp, sync, MACHINE, G } from './helpers.mjs';

const base = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(HOME)), 'dibs-claude-tmp-'));
process.env.DIBS_CLAUDE_TMP = base;
process.env.DIBS_HOG_MIN = String(200 * 1024);   // bytes: folders in a test are small
process.env.DIBS_HOG_PLACES = '{}';   // never du the real ~/Library
const { hogsOnce } = await import('../src/hogs.mjs');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const root = path.join(base, `claude-${process.getuid()}`, '-Users-x');
const cfg = { minDisk: '5G' };
// The scratch folder notices; the low-disk notes to every session (src/diskwarn.mjs) have their own test.
const messages = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'messages.json'), 'utf8')).messages.filter(m => String(m.once).startsWith('diskhog:')); } catch { return []; } };
const hogs = () => JSON.parse(fs.readFileSync(path.join(HOME, 'hogs.json'), 'utf8'));
const KB = 1024;

// A session folder like alex-b1's on 2026-10-19: git worktrees in the scratchpad, a node_modules in each.
function session(id, worktrees, perModule) {
  const pad = path.join(root, id, 'scratchpad');
  for (let i = 0; i < worktrees; i++) {
    const wt = path.join(pad, `wt-${i}`);
    fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /x/.git/worktrees/wt\n');
    fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), Buffer.alloc(perModule));
  }
  return pad;
}

test('under the disk floor, the biggest scratch folders\' agents hear once per drop what fills them and how to free it', async t => {
  t.after(() => { for (const f of ['state.json', 'messages.json', 'hogs.json']) fs.rmSync(path.join(HOME, f), { force: true }); fs.rmSync(path.join(HOME, 'scratch'), { recursive: true, force: true }); });
  session('sess-b1', 3, 100 * KB);
  session('sess-small', 1, 4 * KB);
  // The agent that made the biggest folder, as the guard notes it (src/files.mjs).
  fs.mkdirSync(path.join(HOME, 'scratch', 'sess-b1'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'scratch', 'sess-b1', 'wt-0'), JSON.stringify({ agent: 'awebsite-1', type: 'fd-worker', at: 1 }));
  const t0 = Date.now();
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ seq: 2, queue: [{ id: 2, res: ['test'], pid: process.pid, who: 'alex-3b', enq: t0 }],
    leases: [{ id: 1, res: ['heavy'], kind: 'run', who: 'alex-b1', sessionId: 'sess-b1', pid: process.pid, start: t0 }] }));

  await hogsOnce(cfg, { diskFree: 6 * G }, t0);
  assert.equal(messages().length, 0, 'over the floor: nothing to say');

  await hogsOnce(cfg, { diskFree: 3 * G }, t0);
  const sent = messages();
  assert.equal(sent.length, 1, 'only the folder over the size that matters');
  assert.deepEqual([sent[0].session, sent[0].agentId, sent[0].kind], ['sess-b1', 'awebsite-1', 'notice']);
  assert.match(sent[0].text, new RegExp(`^your session's scratch folder ${path.join(root, 'sess-b1')} holds 0\\.\\d+ GB \\(3 git worktrees, node_modules in each\\)\\. `
    + 'This machine is under its disk floor \\(3\\.0 GB free, the floor is 5\\.0 GB\\) and 1 job waits\\. '
    + 'Free what you can: remove merged worktrees \\(git worktree remove <path>\\), and symlink node_modules'));
  assert.equal(hogs().folders[0].who, 'alex-b1');

  await hogsOnce(cfg, { diskFree: 2 * G }, t0 + 1000);
  await hogsOnce(cfg, { diskFree: 2 * G }, t0 + 11 * 6e4);
  assert.equal(messages().length, 1, 'the same drop, measured again: no repeat');

  await hogsOnce(cfg, { diskFree: 5.5 * G }, t0 + 12 * 6e4);
  assert.equal(hogs().under, true, 'just over the floor is the same drop');
  await hogsOnce(cfg, { diskFree: 7 * G }, t0 + 13 * 6e4);
  assert.equal(hogs().under, false);
  await hogsOnce(cfg, { diskFree: 3 * G }, t0 + 14 * 6e4);
  assert.equal(messages().length, 2, 'a new drop: told again');

  // A waiter held for its own disk need counts, over the floor too.
  fs.rmSync(path.join(HOME, 'hogs.json'));
  const s = JSON.parse(fs.readFileSync(path.join(HOME, 'state.json'), 'utf8'));
  s.queue[0].disk = 8 * G;
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify(s));
  await hogsOnce(cfg, { diskFree: 7 * G }, t0 + 20 * 6e4);
  assert.equal(hogs().under, true);
});

test('a disk wait names the biggest scratch folder and whose it is', t => {
  t.after(() => fs.rmSync(path.join(HOME, 'hogs.json'), { force: true }));
  const home = HOME;
  fs.writeFileSync(path.join(home, 'hogs.json'), JSON.stringify({ under: true, drop: Date.now(), at: Date.now(), free: 3 * G, floor: 5 * G, waiting: 4,
    folders: [{ folder: '/private/tmp/claude-503/-Users-x/sess-b1', session: 'sess-b1', bytes: 18 * G, what: '58 git worktrees, node_modules in each', who: 'alex-b1', agentId: 'main' }] }));
  const disk = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree: 3 * G }) } };
  const r = sync(home, ['when', 'test'], { agent: 'waiter', ...disk });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.replace(/\s+/g, ' '), /more free disk \(3\.0 GB free, it needs 5\.0 GB\)\. The most is in alex-b1's scratch folder \(18 GB, 58 git worktrees, node_modules in each\): ask alex-b1 \(SendMessage\) to free it, or the person/);
  // Once the disk has room again, the hint goes.
  fs.writeFileSync(path.join(home, 'hogs.json'), JSON.stringify({ under: false, at: Date.now(), folders: [] }));
  assert.doesNotMatch(sync(home, ['when', 'test'], { agent: 'waiter', ...disk }).out, /scratch folder/);
});

// 2026-10-20: the Mac kept dropping under the floor with no big session folder, and nobody knew what was writing.
test('under the disk floor, a disk wait names what grew most since the last reading', async t => {
  t.after(() => { for (const f of ['state.json', 'messages.json', 'hogs.json']) fs.rmSync(path.join(HOME, f), { force: true }); });
  const sim = tmp(t, 'sims');
  process.env.DIBS_HOG_PLACES = JSON.stringify({ simulators: sim });
  t.after(() => { process.env.DIBS_HOG_PLACES = '{}'; });
  const t0 = Date.now();
  // Near the floor (under twice it): a reading to compare with, and nothing said yet.
  await hogsOnce(cfg, { diskFree: 8 * G, swapUsed: 1 * G }, t0 - 10 * 6e4);
  assert.equal(hogs().under, false);
  assert.equal(hogs().readings.swap, 1 * G);
  assert.ok('simulators' in hogs().readings);
  // Ten minutes later it's under, and swap grew by 2.5 GB.
  await hogsOnce(cfg, { diskFree: 3 * G, swapUsed: 3.5 * G }, t0);
  assert.deepEqual([hogs().writer.label, hogs().writer.by], ['swap', 2.5 * G]);
  const disk = { env: { DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree: 3 * G }) } };
  const r = sync(HOME, ['when', 'test'], { agent: 'waiter', ...disk });
  assert.match(r.out.replace(/\s+/g, ' '), /more free disk \(3\.0 GB free, it needs 5\.0 GB\)\. Growing fastest: swap, up 2\.5 GB in 10 min/);
});
