// Before the disk runs out: under twice the floor dibs clears caches that rebuild
// themselves and tells the sessions with something to free, once per band; a job
// paused for disk tells its agent through the hook.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, tmp, G, bg, until, port, answers, MACHINE, SERVE_START, windowsGap } from './helpers.mjs';

const base = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(HOME)), 'dibs-claude-tmp-'));
process.env.DIBS_CLAUDE_TMP = base;
process.env.DIBS_HOG_PLACES = '{}';
const { hogsOnce } = await import('../src/hogs.mjs');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cfg = { minDisk: '5G' };
const notes = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'messages.json'), 'utf8')).messages.filter(m => m.kind === 'notice'); } catch { return []; } };
const clear = () => { for (const f of ['state.json', 'messages.json', 'hogs.json']) fs.rmSync(path.join(HOME, f), { force: true }); };

// 2026-10-20: the Mac hit 210 MB free; writes failed, Bash died for every session, and jobs sat silently on "free disk".
// 2026-11-03: the warnings went to every session as the disk fell, 13 of 35 notices, mostly to agents with nothing to free.
test('under twice the floor, dibs clears caches and tells only the sessions with something to free, once per band', async t => {
  t.after(clear);
  const caches = tmp(t, 'caches'), derived = tmp(t, 'derived');
  fs.writeFileSync(path.join(caches, 'npm-cache'), 'x');
  const old = path.join(derived, 'Old-abc'), fresh = path.join(derived, 'Fresh-def');
  fs.mkdirSync(old); fs.mkdirSync(fresh);
  const twoDays = (Date.now() - 2 * 24 * 36e5) / 1000;
  fs.utimesSync(old, twoDays, twoDays);
  process.env.DIBS_CLEAN = JSON.stringify({ 'npm cache': ['rm', '-f', path.join(caches, 'npm-cache')] });
  process.env.DIBS_DERIVED = derived;
  t.after(() => { delete process.env.DIBS_CLEAN; delete process.env.DIBS_DERIVED; });
  const t0 = Date.now();
  // sess-a's job wrote 2 GB; sess-c's job wrote nothing; sess-b only waits. Only sess-a has something to free.
  // Each waiter under a process of its own: two places under one process are twins, and the clean's
  // state write (src/diskwarn.mjs clean marks running jobs) keeps only the newer (src/state.mjs reap).
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ seq: 4,
    leases: [{ id: 1, res: ['test'], kind: 'run', who: 'builder', sessionId: 'sess-a', pid: process.pid, start: t0, purpose: 'suite', cmd: 'npm test', ate: 2 * G },
      { id: 3, res: ['heavy'], kind: 'run', who: 'reader', sessionId: 'sess-c', pid: process.pid, start: t0, cmd: 'grep -r x', ate: 0.1 * G }],
    queue: [{ id: 2, res: ['test'], pid: process.pid, who: 'waiter', sessionId: 'sess-a', enq: t0, purpose: 'lint' },
      { id: 4, res: ['test'], pid: process.ppid, who: 'other', sessionId: 'sess-b', enq: t0 }] }));

  await hogsOnce(cfg, { diskFree: 11 * G }, t0);
  assert.equal(notes().length, 0, 'over twice the floor: nothing');
  await hogsOnce(cfg, { diskFree: 8 * G }, t0);
  assert.ok(!fs.existsSync(path.join(caches, 'npm-cache')), 'the cache step ran');
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh), 'only build output unused for a day goes');
  let n = notes();
  assert.deepEqual(n.map(m => m.session), ['sess-a'], 'not the sessions with nothing of their own to free');
  assert.match(n[0].text, /^free disk is getting low: 8\.0 GB left \(dibs starts nothing new under 5\.0 GB\)\. .*Free what you can of your own/);
  assert.doesNotMatch(n[0].text, /freed 0\.0 GB/, 'nothing freed worth saying');
  assert.match(fs.readFileSync(path.join(HOME, 'cool.log'), 'utf8'), /disk low: dibs cleared npm cache, Xcode build output unused for a day, freeing/);

  await hogsOnce(cfg, { diskFree: 6 * G }, t0 + 40 * 6e4);
  assert.equal(notes().length, 1, 'still in the same band, however long and however far it falls in it');

  await hogsOnce(cfg, { diskFree: 0.2 * G }, t0 + 41 * 6e4);
  n = notes();
  assert.equal(n.length, 2, 'under the floor: a new band, at once');
  const a = n.at(-1).text;
  assert.match(a, /^free disk is critically low: 0\.2 GB left .*Save your work now/);
  assert.match(a, /Your running dibs job #1 \("suite"\) may fail writing: save what it has done if you can/);
  assert.match(a, /Your waiting job #2 \("lint"\) won't start until there's room/);
  await hogsOnce(cfg, { diskFree: 0.2 * G }, t0 + 60 * 6e4);
  assert.equal(notes().length, 2, 'still under: never again for that band');

  await hogsOnce(cfg, { diskFree: 11 * G }, t0 + 70 * 6e4);
  await hogsOnce(cfg, { diskFree: 8 * G }, t0 + 80 * 6e4);
  assert.equal(notes().length, 3, 'room again, then a new fall: told again');
});

test("a session whose own scratch folder is big hears it's low on disk, though it runs nothing", { skip: windowsGap("Claude Code's temp folder is claude-<uid>, and Windows has no uid: src/files.mjs claudeTmp finds none") }, async t => {
  t.after(clear);
  process.env.DIBS_HOG_MIN = String(200 * 1024);
  t.after(() => delete process.env.DIBS_HOG_MIN);
  const pad = path.join(base, `claude-${process.getuid()}`, '-Users-x', 'sess-f', 'scratchpad');
  fs.mkdirSync(pad, { recursive: true });
  fs.writeFileSync(path.join(pad, 'big.bin'), Buffer.alloc(300 * 1024));
  t.after(() => fs.rmSync(path.join(base, `claude-${process.getuid()}`), { recursive: true, force: true }));
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ seq: 1, leases: [], queue: [] }));
  await hogsOnce(cfg, { diskFree: 8 * G }, Date.now());
  assert.deepEqual(notes().map(m => m.session), ['sess-f']);
  assert.doesNotMatch(notes()[0].text, /Free what you can of your own/, 'its files hold still: no telling it to free them again and again (e4)');
});

test("with the throttle watcher down, the coordinator sends the low-disk notes itself", { skip: windowsGap("Claude Code's temp folder is claude-<uid>, and Windows has no uid: src/files.mjs claudeTmp finds none") }, async t => {
  const { watcherDown } = await import('../src/diskwarn.mjs');
  const h = tmp(t, 'coord');
  const at = await port();
  fs.writeFileSync(path.join(h, 'state.json'), JSON.stringify({ seq: 2, leases: [], queue: [{ id: 1, res: ['test'], pid: process.pid, who: 'w', sessionId: 'sess-d', enq: Date.now() }] }));
  // sess-d has something of its own to free: a scratch folder over the line.
  const pad = path.join(base, `claude-${process.getuid()}`, '-Users-y', 'sess-d', 'scratchpad');
  fs.mkdirSync(pad, { recursive: true });
  fs.writeFileSync(path.join(pad, 'big.bin'), Buffer.alloc(300 * 1024));
  t.after(() => fs.rmSync(path.join(base, `claude-${process.getuid()}`), { recursive: true, force: true }));
  bg(t, h, ['serve', '--listen', String(at), '--bind', '127.0.0.1'], { env: { DIBS_BACKUP_MS: '300', DIBS_HOG_PLACES: '{}', DIBS_CLAUDE_TMP: base, DIBS_HOG_MIN: String(200 * 1024),
    DIBS_FAKE_MACHINE: JSON.stringify({ ...MACHINE, diskFree: 8 * G }) } });
  await until(async () => await answers(at), SERVE_START);
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(h, 'messages.json'), 'utf8')).messages.some(m => m.session === 'sess-d' && /free disk is getting low/.test(m.text)); } catch { return false; } });
  fs.writeFileSync(path.join(HOME, 'cool.pid'), String(process.pid));
  t.after(() => fs.rmSync(path.join(HOME, 'cool.pid'), { force: true }));
  assert.equal(watcherDown(), false, 'a live watcher in its pidfile');
  fs.writeFileSync(path.join(HOME, 'cool.pid'), '999999');
  assert.equal(watcherDown(), true);
});


test('under the floor, the clearing comes before measuring the folders', async t => {
  t.after(clear);
  const place = tmp(t, 'place');
  const big = path.join(place, 'cache.bin');
  fs.writeFileSync(big, Buffer.alloc(4 * 1024 ** 2));
  process.env.DIBS_HOG_PLACES = JSON.stringify({ caches: place });
  process.env.DIBS_CLEAN = JSON.stringify({ 'Homebrew cache': ['rm', '-f', big] });
  t.after(() => { process.env.DIBS_HOG_PLACES = '{}'; delete process.env.DIBS_CLEAN; });
  await hogsOnce(cfg, { diskFree: 2 * G }, Date.now());
  const h = JSON.parse(fs.readFileSync(path.join(HOME, 'hogs.json'), 'utf8'));
  assert.ok(h.cleaned && h.cleanedCritical, 'cleared under the floor');
  assert.ok(h.readings.caches < 1024 ** 2, `measured after the clearing (${h.readings.caches} bytes)`);
});

// 2026-10-22: swap gave back 3 GB while Homebrew's cleanup ran, and the note said the cleanup freed it.
test("what a clearing freed is its folder's shrink, not whatever else freed disk meanwhile", async t => {
  const { clean } = await import('../src/diskwarn.mjs');
  const cache = tmp(t, 'cache'), other = tmp(t, 'other');
  const inCache = path.join(cache, 'a.bin'), elsewhere = path.join(other, 'b.bin');
  fs.writeFileSync(inCache, Buffer.alloc(4 * 1024 ** 2));
  fs.writeFileSync(elsewhere, Buffer.alloc(64 * 1024 ** 2));
  process.env.DIBS_CLEAN = JSON.stringify({ 'Homebrew cache': { argv: ['rm', '-f', inCache, elsewhere], dir: cache } });
  t.after(() => delete process.env.DIBS_CLEAN);
  const got = await clean();
  const freed = got.steps[0].freed;
  assert.ok(freed >= 3.5 * 1024 ** 2 && freed < 8 * 1024 ** 2, `freed ${freed} bytes: the 4 MB in the cache, not the 64 MB elsewhere`);
});
