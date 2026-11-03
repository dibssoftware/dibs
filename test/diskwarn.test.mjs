// Before the disk runs out: under twice the floor dibs clears caches that rebuild
// themselves and tells every active session, again with more urgency under the
// floor; a job paused for disk tells its agent through the hook.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, tmp, G, bg, until, port, answers, MACHINE, SERVE_START } from './helpers.mjs';

const base = fs.mkdtempSync(path.join(fs.realpathSync(path.dirname(HOME)), 'dibs-claude-tmp-'));
process.env.DIBS_CLAUDE_TMP = base;
process.env.DIBS_HOG_PLACES = '{}';
const { hogsOnce } = await import('../src/hogs.mjs');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cfg = { minDisk: '5G' };
const notes = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'messages.json'), 'utf8')).messages.filter(m => m.kind === 'notice'); } catch { return []; } };
const clear = () => { for (const f of ['state.json', 'messages.json', 'hogs.json']) fs.rmSync(path.join(HOME, f), { force: true }); };

// 2026-10-20: the Mac hit 210 MB free; writes failed, Bash died for every session, and jobs sat silently on "free disk".
test('under twice the floor, dibs clears caches that rebuild themselves and tells every active session; under the floor, again, to save work now', async t => {
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
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ seq: 3,
    leases: [{ id: 1, res: ['test'], kind: 'run', who: 'builder', sessionId: 'sess-a', pid: process.pid, start: t0, purpose: 'suite', cmd: 'npm test' }],
    queue: [{ id: 2, res: ['test'], pid: process.pid, who: 'waiter', sessionId: 'sess-b', enq: t0, purpose: 'lint' }] }));

  await hogsOnce(cfg, { diskFree: 11 * G }, t0);
  assert.equal(notes().length, 0, 'over twice the floor: nothing');
  await hogsOnce(cfg, { diskFree: 8 * G }, t0);
  assert.ok(!fs.existsSync(path.join(caches, 'npm-cache')), 'the cache step ran');
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh), 'only build output unused for a day goes');
  let n = notes();
  assert.deepEqual(n.map(m => m.session).sort(), ['sess-a', 'sess-b']);
  assert.match(n.find(m => m.session === 'sess-a').text, /^free disk is getting low: 8\.0 GB left \(dibs starts nothing new under 5\.0 GB\)\. .*Free what you can of your own/);
  assert.doesNotMatch(n.find(m => m.session === 'sess-b').text, /waiting job/, 'over the floor a waiter waits for something else');
  assert.doesNotMatch(n[0].text, /freed 0\.0 GB/, 'nothing freed worth saying');
  assert.match(fs.readFileSync(path.join(HOME, 'cool.log'), 'utf8'), /disk low: dibs cleared npm cache, Xcode build output unused for a day, freeing/);

  await hogsOnce(cfg, { diskFree: 7 * G }, t0 + 6e4);
  assert.equal(notes().length, 2, 'not again within 15 minutes');

  await hogsOnce(cfg, { diskFree: 0.2 * G }, t0 + 2 * 6e4);
  n = notes();
  assert.equal(n.length, 4, 'under the floor: at once, with more urgency');
  const a = n.filter(m => m.session === 'sess-a').at(-1).text;
  assert.match(a, /^free disk is critically low: 0\.2 GB left .*Save your work now/);
  assert.match(a, /Your running dibs job #1 \("suite"\) may fail writing: save what it has done if you can/);
  assert.match(n.filter(m => m.session === 'sess-b').at(-1).text, /Your waiting job #2 \("lint"\) won't start until there's room/);
  await hogsOnce(cfg, { diskFree: 0.2 * G }, t0 + 12 * 6e4);
  assert.equal(notes().length, 4, 'still under: not again within 15 minutes');
  await hogsOnce(cfg, { diskFree: 0.2 * G }, t0 + 18 * 6e4);
  assert.equal(notes().length, 6, 'and again after them');
});

// 2026-10-20: a note every 15 minutes at a steady 9.2 GB taught agents to skip it.
test('over the floor, a session hears again only once free disk has fallen a gigabyte since its last note', async t => {
  t.after(clear);
  const t0 = Date.now();
  fs.writeFileSync(path.join(HOME, 'state.json'), JSON.stringify({ seq: 2, leases: [], queue: [{ id: 1, res: ['test'], pid: process.pid, who: 'w', sessionId: 'sess-c', enq: t0 }] }));
  await hogsOnce(cfg, { diskFree: 9.2 * G }, t0);
  assert.equal(notes().length, 1);
  await hogsOnce(cfg, { diskFree: 9.0 * G }, t0 + 16 * 6e4);
  assert.equal(notes().length, 1, 'steady: not again');
  await hogsOnce(cfg, { diskFree: 8.1 * G }, t0 + 32 * 6e4);
  assert.equal(notes().length, 2, 'down a gigabyte: again');
});

test("with the throttle watcher down, the coordinator sends the low-disk notes itself", async t => {
  const { watcherDown } = await import('../src/diskwarn.mjs');
  const h = tmp(t, 'coord');
  const at = await port();
  fs.writeFileSync(path.join(h, 'state.json'), JSON.stringify({ seq: 2, leases: [], queue: [{ id: 1, res: ['test'], pid: process.pid, who: 'w', sessionId: 'sess-d', enq: Date.now() }] }));
  bg(t, h, ['serve', '--listen', String(at), '--bind', '127.0.0.1'], { env: { DIBS_BACKUP_MS: '300', DIBS_HOG_PLACES: '{}', DIBS_CLAUDE_TMP: base,
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
