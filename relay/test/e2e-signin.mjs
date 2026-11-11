// Signing in at /account for real, in Chromium, Firefox and WebKit: the relay Worker under
// wrangler dev (email simulated: wrangler writes each message to a file). The emailed link
// opened in the tab that asked for it, in a new tab and in another browser; the code typed
// into the page that asked.
//
//   cd relay && ~/bin/dibs run playwright --port WEB -m "relay sign-in e2e" -- node test/e2e-signin.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = createRequire(import.meta.url)(process.env.DIBS_PLAYWRIGHT || 'playwright');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 30e3, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const PORT = Number(process.env.WEB) || await freePort();
const ORIGIN = `http://localhost:${PORT}`;
// Every step has this long; a hang fails naming the step it hung after.
const STEP_TIME = 120e3;
let lastStep = 'start', stepTimer = null, hung = null;
const hangs = new Promise((resolve, reject) => { hung = reject; });
hangs.catch(() => {});
const arm = () => { clearTimeout(stepTimer); stepTimer = setTimeout(() => hung(new Error(`hung for ${STEP_TIME / 1000}s after: ${lastStep}`)), STEP_TIME); };
const step = s => { console.log(`ok - ${s}`); lastStep = s; arm(); };
const browsers = [];
// SHOTS=<folder>: screenshots of each sign-in screen, at 1440 and 375 wide, in Chromium.
const SHOTS = process.env.SHOTS || null;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
let wrangler = null;

// What wrangler mailed last: it writes the text to a file and logs where.
const mails = () => wrangler.log.match(/[^\s]*email-text\/[^\s]+\.txt/g) || [];
async function ask(page, email) {
  const before = mails().length;
  // A page still showing the last code: back to the address, as the person would.
  if (await page.isVisible('[data-view="code"]')) await page.click('#code-back');
  await page.fill('#email', email);
  await page.click('#email-form button[type=submit]');
  await page.waitForSelector('[data-view="code"]:not([hidden])', { timeout: 15e3 });
  await until(() => mails().length > before, 15e3, `the sign-in email\n${wrangler.log.slice(-1500)}`);
  return fs.readFileSync(mails().at(-1), 'utf8');
}
// The nudge to add a passkey after a first email sign-in: skipping takes two clicks.
async function skipPasskey(page) {
  await page.waitForSelector('[data-view="passkey-offer"]:not([hidden])', { timeout: 15e3 });
  await page.click('#offer-skip');
  assert.ok(await page.isVisible('[data-view="passkey-offer"]'), 'one click only asks again');
  await page.click('#offer-skip-sure');
  await page.waitForSelector('[data-view="signed-in"]:not([hidden])', { timeout: 15e3 });
}
const linkIn = text => text.match(/http:\/\/localhost:\d+\/account#signin=[A-Za-z0-9_-]+/)[0];
const codeIn = text => text.match(/\b(\d{3}) (\d{3})\b/).slice(1).join('');
const signedIn = page => page.waitForSelector('[data-view="signed-in"]:not([hidden]), [data-view="passkey-offer"]:not([hidden])', { timeout: 15e3 })
  .catch(async e => { throw new Error(`${e.message}\nshowing: ${await page.evaluate(() => [...document.querySelectorAll('[data-view]')].filter(x => !x.hidden).map(x => x.dataset.view).join(',') + ' | ' + document.getElementById('status').textContent + ' | ' + location.href).catch(x => x.message)}`); });

async function main() {
  assert.equal(spawnSync(process.execPath, ['build.mjs'], { cwd: HERE }).status, 0);
  wrangler = spawn(path.join(HERE, 'node_modules', '.bin', 'wrangler'), ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', '0',
    '--var', `ACCOUNT_SECRET:${crypto.randomBytes(32).toString('base64url')}`,
    // Every sign-in here comes from one address, more than a person's ten in ten minutes.
    '--var', 'ACCOUNT_LIMITS:{"SIGNINS_PER_IP":200,"LINKS_PER_IP":200}'], { cwd: HERE, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' } });
  wrangler.log = '';
  wrangler.stdout.on('data', d => (wrangler.log += d));
  wrangler.stderr.on('data', d => (wrangler.log += d));
  await until(async () => { try { return (await fetch(`${ORIGIN}/account`)).ok; } catch { return false; } }, 90e3, `wrangler dev\n${wrangler.log}`);
  step('relay Worker up');

  // The wrapper: /url?q=<link> answers with a redirect to the link.
  const wrapSrv = http.createServer((req, res) => { res.writeHead(302, { Location: new URL(req.url, 'http://x').searchParams.get('q') }); res.end(); });
  await new Promise(r => wrapSrv.listen(0, '127.0.0.1', r));
  const WRAPPER = `http://127.0.0.1:${wrapSrv.address().port}`;
  let n = 0;
  const engines = (process.env.ENGINES || 'chromium,firefox,webkit').split(',');
  for (const name of engines) {
    const b = await pw[name].launch();
    browsers.push(b);
    // Reported: the link pasted into the tab already open on /account did nothing.
    // The code, typed into the page that asked: a wrong one says how many tries are left and
    // keeps the cursor in the field; the right one signs in.
    const coder = await (await b.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 })).newPage();
    await coder.goto(`${ORIGIN}/account`);
    if (name === 'chromium') {
      await coder.waitForSelector('[data-view="signed-out"]:not([hidden])');
      await shot(coder, 'after-signin-375');
      const wide = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await wide.goto(`${ORIGIN}/account`);
      await wide.waitForSelector('[data-view="signed-out"]:not([hidden])');
      await shot(wide, 'after-signin-1440');
      await ask(wide, 'wide@example.com');
      await shot(wide, 'after-code-1440');
    }
    const codeMail = await ask(coder, `code-${name}@example.com`);
    if (name === 'chromium') await shot(coder, 'after-code-375');
    assert.match(codeMail, /^Your dibs sign-in code:/);
    assert.equal(await coder.evaluate(() => document.activeElement.id), 'code-input');
    const right = codeIn(codeMail), wrong = String((Number(right) + 1) % 1e6).padStart(6, '0');
    await coder.fill('#code-input', wrong);
    await coder.waitForFunction(() => /4 tries left/.test(document.getElementById('code-state').textContent));
    assert.equal(await coder.evaluate(() => document.activeElement.id), 'code-input');
    assert.equal(await coder.inputValue('#code-input'), '');
    if (name === 'chromium') await shot(coder, 'after-code-wrong-375');
    await coder.fill('#code-input', right);
    if (name === 'chromium') {
      await coder.waitForSelector('[data-view="passkey-offer"]:not([hidden])');
      await shot(coder, 'after-passkey-offer-375');
      await coder.click('#offer-skip');
      await shot(coder, 'after-passkey-offer-skip-375');
      await coder.click('#offer-skip-sure');
      await coder.waitForSelector('[data-view="signed-in"]:not([hidden])');
    } else {
      await skipPasskey(coder);
    }
    assert.equal(await coder.evaluate(() => document.documentElement.scrollWidth <= 375), true, 'no sideways scroll at 375');
    step(`${name}: the code typed into the page that asked signs in (a wrong one says 4 tries left), and the passkey nudge takes two clicks to skip`);

    const page = await (await b.newContext()).newPage();
    await page.goto(`${ORIGIN}/account`);
    const mail = await ask(page, `same-tab-${name}@example.com`);
    await page.goto(linkIn(mail));
    await signedIn(page);
    assert.equal(await page.evaluate(() => location.hash), '', 'the token is out of the address bar');
    step(`${name}: the emailed link pasted into the tab that asked signs in there`);

    const asker = await (await b.newContext()).newPage();
    await asker.goto(`${ORIGIN}/account`);
    const mail2 = await ask(asker, `new-tab-${name}@example.com`);
    const other = await asker.context().newPage();
    await other.goto(linkIn(mail2));
    await signedIn(other);
    step(`${name}: the link opened in a new tab signs in there`);

    const mail3 = await ask(asker, `elsewhere-${name}@example.com`);
    const away = await (await b.newContext()).newPage();
    await away.goto(linkIn(mail3));
    await signedIn(away);
    step(`${name}: the link opened in another browser (another context) signs in there`);

    // A mail client's link wrapper (Gmail's google.com/url?q=, Outlook Safe Links): a redirect
    // to the link, which the query-string token survives.
    const mail4 = await ask(asker, `wrapped-${name}@example.com`);
    const wrapped = await (await b.newContext()).newPage();
    await wrapped.goto(`${WRAPPER}/url?q=${encodeURIComponent(linkIn(mail4))}`);
    await signedIn(wrapped);
    assert.equal(await wrapped.evaluate(() => location.search + location.hash), '', 'the token is out of the address bar');
    step(`${name}: the link through a mail client's redirect wrapper signs in`);

    // A wrapper that drops the fragment can be given the ?signin= form instead: loading the page
    // spends nothing (a mail scanner's prefetch runs no script); the page takes the token out of
    // the address bar and redeems it from script.
    const mail5 = await ask(asker, `query-${name}@example.com`);
    const q = await (await b.newContext()).newPage();
    const token = linkIn(mail5).split('#signin=')[1];
    const plain = await fetch(`${ORIGIN}/account?signin=${token}`);
    assert.equal(plain.headers.get('cache-control'), 'no-store');
    assert.equal(plain.headers.get('referrer-policy'), 'no-referrer');
    await q.goto(`${ORIGIN}/account?signin=${token}`);
    await signedIn(q);
    assert.equal(await q.evaluate(() => location.search), '');
    step(`${name}: the ?signin= form loads without spending the link (a plain fetch first) and signs in from the page`);
    n++;
  }
  assert.equal(n, engines.length);
}

try {
  arm();
  await Promise.race([main(), hangs]);
  console.log('e2e passed');
} catch (e) {
  console.error(`e2e FAILED: ${e.stack || e.message}`);
  if (wrangler) console.error(wrangler.log.slice(-2500));
  process.exitCode = 1;
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  try { process.kill(-wrangler.pid, 'SIGTERM'); } catch {}
  clearTimeout(stepTimer);
  process.exit(process.exitCode ?? 0);
}
