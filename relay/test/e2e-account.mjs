// dibs accounts for real, on this machine: the relay Worker under wrangler dev (its email
// simulated: wrangler writes each message to a file), `dibs relay` from a throwaway DIBS_HOME,
// and headless Chromium. One browser signs up by email link, adds this Mac with
// dibs connect --account and opens it; a second signs in by email, asks the Mac for the
// account key and gets it once dibs connect --approve gets its code; a passkey with PRF signs a
// third in with everything at once.
//
//   cd relay && ~/bin/dibs run playwright --port WEB -m "relay account e2e" -- node test/e2e-account.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(HERE, '..', 'bin', 'dibs.mjs');
const { chromium } = createRequire(import.meta.url)(process.env.DIBS_PLAYWRIGHT || 'playwright');
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-relay-e2e-'));
const procs = [];
let browser = null;
// mcp.localhost stands in for mcp.dibs.cc: Chromium sends *.localhost to this machine, and
// the Node requests below name it in their Host header.
const MCP_HOST = `mcp.localhost:${PORT}`;
const ENV = { ...process.env, DIBS_HOME: HOME, DIBS_NO_SESSION: '1', DIBS_AGENT: 'e2e', DIBS_RELAY_PAGE: `${ORIGIN}/`, DIBS_MCP_ORIGIN: `http://${MCP_HOST}`,
  DIBS_FAKE_MACHINE: JSON.stringify({ diskFree: 1e12, swapUsed: 0, memFree: 90, load: 0, memTotal: 16 * 1024 ** 3 }) };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'DIBS_LEASE']) delete ENV[k];
const dibs = args => { const r = spawnSync(process.execPath, [BIN, ...args], { env: ENV, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout; };
function start(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  p.log = '';
  p.stdout.on('data', d => (p.log += d));
  p.stderr.on('data', d => (p.log += d));
  procs.push(p);
  return p;
}
const stop = p => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
const macRelay = () => start(process.execPath, [BIN, 'relay', '--url', `ws://127.0.0.1:${PORT}`], { env: ENV });
const status = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'relay-status.json'), 'utf8')); } catch { return {}; } };
// Every step has STEP_TIME to finish. A hang fails the run naming the step it hung after,
// instead of holding the browser queue for hours (2026-11-02: 6.5 hours, no output).
const STEP_TIME = 120e3;
let lastStep = 'start', stepTimer = null, hung = null;
const hangs = new Promise((resolve, reject) => { hung = reject; });
hangs.catch(() => {});
const arm = () => { clearTimeout(stepTimer); stepTimer = setTimeout(() => hung(new Error(`hung for ${STEP_TIME / 1000}s after: ${lastStep}`)), STEP_TIME); };
const step = s => { console.log(`ok - ${s}`); lastStep = s; arm(); };
// Inside a step: where it got to, so a hang names the exact call.
const note = s => { lastStep = `${lastStep.split(' >> ')[0]} >> ${s}`; };
// Closing a page that's mid-navigation can wait forever in Playwright; the page isn't needed after.
const closeSoon = p => Promise.race([p.close().catch(() => {}), wait(5e3)]);
// A request that never answers fails after this long, naming what it asked.
const REQ_TIME = 30e3;

// A raw browser-style upgrade with any Origin, the way a non-browser client forges one.
// Resolves { status, socket, closed } where closed resolves when the relay hangs up.
// ip stands in for the address Cloudflare would put in CF-Connecting-IP (wrangler dev passes it through).
function rawTab(mid, { origin = ORIGIN, ip = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get(`${ORIGIN}/ws/b/${mid}`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13', Origin: origin, ...(ip && { 'CF-Connecting-IP': ip }) } });
    r.on('response', res => { let body = ''; res.on('data', d => (body += d)); res.on('end', () => resolve({ status: res.statusCode, body })); });
    // Closed means the relay sent a close frame (opcode 8): it waits for ours before the TCP
    // connection ends, and this client never answers.
    const texts = [];
    r.on('upgrade', (res, socket, head) => resolve({ status: 101, socket, texts, closed: new Promise(c => {
      let buf = head || Buffer.alloc(0);
      const scan = d => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f, at = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
          if (buf.length < at + len) return;
          if ((buf[0] & 0x0f) === 8) return c(buf.length >= at + 2 ? buf.readUInt16BE(at) : 0);
          if ((buf[0] & 0x0f) === 1) texts.push(buf.subarray(at, at + len).toString());
          buf = buf.subarray(at + len);
        }
      };
      socket.on('data', scan);
      socket.on('close', () => c(-1));
      if (buf.length) scan(Buffer.alloc(0));
    }) }));
    r.on('error', reject);
  });
}

// A client frame (masked, as clients must send): text if data is a string, else binary.
function wsSend(socket, data) {
  const body = Buffer.from(data), mask = crypto.randomBytes(4);
  const head = body.length < 126 ? Buffer.from([typeof data === 'string' ? 0x81 : 0x82, 0x80 | body.length])
    : Buffer.from([typeof data === 'string' ? 0x81 : 0x82, 0x80 | 126, body.length >> 8, body.length & 255]);
  socket.write(Buffer.concat([head, mask, body.map((b, i) => b ^ mask[i % 4])]));
}
// The relay token this browser keeps in IndexedDB, as a forger who stole it would hold it.
const tokenOf = page => page.evaluate(() => new Promise(resolve => {
  const r = indexedDB.open('dibs-relay', 1);
  r.onsuccess = () => { const g = r.result.transaction('macs').objectStore('macs').getAll(); g.onsuccess = () => resolve(g.result[0]?.rt); };
}));

// A request to the relay as mcp.dibs.cc would get it.
function mcpReq(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { Host: MCP_HOST, ...(data && { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.setTimeout(REQ_TIME, () => r.destroy(new Error(`no answer in ${REQ_TIME / 1000}s to ${method} ${p} (Host ${MCP_HOST})`)));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  assert.equal(spawnSync(process.execPath, ['build.mjs'], { cwd: HERE }).status, 0);
  const wrangler = start(path.join(HERE, 'node_modules', '.bin', 'wrangler'), ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', '0', '--var', `ACCOUNT_SECRET:${crypto.randomBytes(32).toString('base64url')}`, '--var', 'ACCOUNT_LIMITS:{"LINKS_PER_EMAIL_IP":20}'],
    { cwd: HERE, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' } });
  await until(async () => { try { return (await fetch(`${ORIGIN}/account`)).ok; } catch { return false; } }, 90e3, `wrangler dev on ${PORT}\n${wrangler.log}`);
  step('relay Worker up, the account page served');

  const mac = macRelay();
  await until(() => status().state === 'connected', 30e3, `dibs relay to connect\n${mac.log}`);
  const mid = mac.log.match(/machine ([A-Za-z0-9_-]{22})/)[1];

  // The link wrangler would have mailed: it writes the text to a file and logs where.
  const mailCount = () => (wrangler.log.match(/email-text\/[^\s]+\.txt/g) || []).length;
  // After an email sign-in with no passkey on the account, the page nudges for one; these runs
  // skip it (two clicks), as e2e-signin.mjs checks.
  async function landed(page) {
    await page.waitForSelector('[data-view="signed-in"]:not([hidden]), [data-view="passkey-offer"]:not([hidden])', { timeout: 30e3 });
    if (await page.isVisible('[data-view="passkey-offer"]')) { await page.click('#offer-skip'); await page.click('#offer-skip-sure'); }
    await page.waitForSelector('[data-view="signed-in"]:not([hidden])', { timeout: 30e3 });
  }
  async function linkFor(page, email) {
    const before = mailCount();
    await page.fill('#email', email);
    await page.click('#email-form button[type=submit]');
    await until(() => mailCount() > before, 15e3, `the sign-in email\n${wrangler.log.slice(-2000)}`);
    const file = wrangler.log.match(/[^\s]*email-text\/[^\s]+\.txt/g).at(-1);
    const text = fs.readFileSync(file, 'utf8');
    return text.match(/http:\/\/localhost:\d+\/account#signin=[A-Za-z0-9_-]{43}/)[0];
  }

  browser = await chromium.launch();
  const a = await (await browser.newContext()).newPage();
  const errors = [];
  a.on('pageerror', e => errors.push(e.message));
  await a.goto(`${ORIGIN}/account`);
  await a.waitForSelector('[data-view="signed-out"]:not([hidden])');
  const link = await linkFor(a, 'Person@Example.com');
  await a.goto(link);
  await landed(a);
  assert.equal(await a.evaluate(() => location.hash), '');
  step('a new account by email link: the link works once, the fragment is cleared, the account page opens');

  const join = dibs(['connect', '--account']).match(/http:\/\/localhost:\d+\/account#join=\S+/)[0];
  await a.goto(join);
  await until(async () => (await a.textContent('#status')).includes('Added'), 30e3, 'the Mac to join the account');
  const acct = JSON.parse(fs.readFileSync(path.join(HOME, 'relay.json'), 'utf8')).accounts;
  assert.equal(Object.keys(acct).length, 1);
  await a.waitForSelector('#machines a');
  assert.match(dibs(['connect', '--list']), /dibs account/);
  step('dibs connect --account: the browser pairs the Mac with the account and gives it the account key');

  await a.goto(`${ORIGIN}/?m=${mid}`);
  await a.waitForSelector('#app:not([hidden])', { timeout: 30e3 });
  step('the account\'s browser opens that Mac\'s board, end to end');

  // A second browser: signed in by email, no account key, until the Mac approves it.
  const b = await (await browser.newContext()).newPage();
  await b.goto(`${ORIGIN}/account`);
  const link2 = await linkFor(b, 'person@example.com');
  await b.goto(link2);
  await b.waitForSelector('[data-view="need-key"]:not([hidden])');
  await b.click('#ask-key');
  await b.waitForSelector('[data-view="approve"]:not([hidden])', { timeout: 30e3 });
  const code = (await b.textContent('#code')).replace(/\s/g, '');
  assert.match(code, /^\d{6}$/);
  // A reload carries on with the same request (its key kept in IndexedDB), not a new one.
  await b.reload();
  await b.waitForSelector('[data-view="approve"]:not([hidden])', { timeout: 30e3 });
  assert.equal((await b.textContent('#code')).replace(/\s/g, ''), code);
  await until(() => dibs(['connect', '--approve']).includes('is waiting, until'), 15e3, 'the Mac to see the request');
  assert.throws(() => dibs(['connect', '--approve', code === '000000' ? '111111' : '000000']), /No waiting browser shows that code/);
  const approved = dibs(['connect', '--approve', code]);
  assert.match(approved, /Approved/);
  const confirm = approved.match(/^\s+(\d{3} \d{3})$/m)[1];
  // The browser opens the key only with the code the Mac printed: not its own, not a guess.
  await b.waitForSelector('[data-view="confirm"]:not([hidden])', { timeout: 30e3 });
  await b.fill('#confirm', code);
  await b.click('#confirm-form button');
  await until(async () => /isn't the code your Mac printed/.test(await b.textContent('#status')), 10e3, 'its own code to be refused');
  await b.fill('#confirm', confirm);
  await b.click('#confirm-form button');
  await b.waitForSelector('[data-view="signed-in"]:not([hidden])', { timeout: 30e3 });
  await b.goto(`${ORIGIN}/?m=${mid}`);
  await b.waitForSelector('#app:not([hidden])', { timeout: 30e3 });
  step('a second browser by email: asks the Mac, dibs connect --approve with its code (a wrong one refused), types the Mac\'s code back, then opens the board');

  // Another link to the same account, in a browser that has its key: it keeps the key.
  const asker = await (await browser.newContext()).newPage();
  await asker.goto(`${ORIGIN}/account`);
  await asker.waitForSelector('[data-view="signed-out"]:not([hidden])');
  const link3 = await linkFor(asker, 'person@example.com');
  await b.goto(link3);
  await landed(b);
  step('signing in again by email to the same account keeps the account key');

  // A passkey with PRF, made in the first browser: a fresh browser signs in with it and opens everything.
  const cdpA = await a.context().newCDPSession(a);
  await cdpA.send('WebAuthn.enable');
  const { authenticatorId } = await cdpA.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  await a.goto(`${ORIGIN}/account`);
  await a.waitForSelector('[data-view="signed-in"]:not([hidden])');
  await a.click('#passkey-add');
  await until(async () => (await a.textContent('#status')).includes('Passkey added'), 30e3, 'a passkey to be added');
  const prfOk = (await a.textContent('#status')).includes('opens your Macs at once');
  const { credentials } = await cdpA.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.ok(prfOk, 'this Chromium\'s virtual authenticator gives PRF output');
  // Signed out, this browser keeps nothing of the account; the passkey brings it all back, key included.
  const sessionNow = () => a.evaluate(() => new Promise(resolve => { const q = indexedDB.open('dibs-account', 1); q.onsuccess = () => { const g = q.result.transaction('me').objectStore('me').get('me'); g.onsuccess = () => resolve(g.result?.session || null); }; }));
  const before = await sessionNow();
  await a.click('#signout');
  // The signed-out page offers this site's passkeys in the email field's autofill; Chromium's
  // virtual authenticator answers that at once, as a person picking it would. Either way in,
  // with a new session: the old one must be gone first.
  await until(async () => (await sessionNow()) !== before, 15e3, 'signing out');
  await a.waitForSelector('[data-view="signed-out"]:not([hidden]), [data-view="signed-in"]:not([hidden])', { timeout: 30e3 });
  if (await a.isVisible('[data-view="signed-out"]')) {
    assert.ok(await a.evaluate(() => document.getElementById('account').classList.contains('passkey-first')), 'a browser that used a passkey leads with it');
    await a.click('#passkey-signin').catch(() => {});
  }
  await a.waitForSelector('[data-view="signed-in"]:not([hidden])', { timeout: 30e3 });
  await a.waitForSelector('#machines a');
  await a.goto(`${ORIGIN}/?m=${mid}`);
  await a.waitForSelector('#app:not([hidden])', { timeout: 30e3 }).catch(async e => { throw new Error(`${e.message}\npage: ${(await a.evaluate(() => document.body.innerText)).slice(0, 600)}`); });
  step('a passkey with PRF: signed out and back in with it, the browser opens the account key itself and the Mac\'s board, no approval');
  // A copy of the passkey taken before that sign-in carries an older sign count: the relay takes
  // it for a cloned authenticator and refuses it.
  const c = await (await browser.newContext()).newPage();
  const cdpC = await c.context().newCDPSession(c);
  await cdpC.send('WebAuthn.enable');
  const authC = await cdpC.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  await cdpC.send('WebAuthn.addCredential', { authenticatorId: authC.authenticatorId, credential: credentials[0] });
  await c.goto(`${ORIGIN}/account`);
  // The email field's passkey autofill may offer the copy first; the virtual authenticator
  // answers it at once. Refused either way.
  const views = () => c.evaluate(() => [...document.querySelectorAll('[data-view]')].filter(e => !e.hidden).map(e => e.dataset.view).join(',') + ' | ' + document.getElementById('status').textContent);
  await until(async () => /copied/.test(await c.textContent('#status')) || await c.isVisible('[data-view="signed-out"]'), 30e3, `the signed-out page (${await views()})`);
  if (!/copied/.test(await c.textContent('#status'))) await c.click('#passkey-signin', { timeout: 10e3 }).catch(async e => { throw new Error(`${e.message}\nviews: ${await views()}`); });
  await until(async () => /copied/.test(await c.textContent('#status')), 30e3, 'the copied passkey to be refused');
  assert.ok(await c.isVisible('[data-view="signed-out"]'));
  step('a copy of the passkey with an older sign count is refused as a possible clone');

  // Passkeys only: an email code then gets a browser no further than asking a Mac.
  a.on('dialog', d => d.accept());
  await a.goto(`${ORIGIN}/account`);
  await a.waitForSelector('#passkey-only-row:not([hidden])');
  await a.click('#passkey-only');
  await until(async () => (await a.textContent('#status')).includes('now needs a passkey'), 15e3, 'passkeys only to be on');
  const r = await (await browser.newContext()).newPage();
  await r.goto(`${ORIGIN}/account`);
  const sent = mailCount();
  await r.fill('#email', 'person@example.com');
  await r.click('#email-form button[type=submit]');
  await r.waitForSelector('[data-view="code"]:not([hidden])');
  await until(() => mailCount() > sent, 15e3, 'the code email');
  const mailed = fs.readFileSync(wrangler.log.match(/[^\s]*email-text\/[^\s]+\.txt/g).at(-1), 'utf8').match(/\b(\d{3}) (\d{3})\b/).slice(1).join('');
  await r.fill('#code-input', mailed);
  await r.waitForSelector('[data-view="need-key"]:not([hidden])', { timeout: 15e3 });
  assert.match(await r.textContent('#need-key-lede'), /This account signs in with a passkey/);
  await a.click('#passkey-only');
  await until(async () => (await a.textContent('#status')).includes('Email codes sign in to this account again'), 15e3, 'passkeys only to be off');
  await closeSoon(r);
  step('passkeys only: an email code signs in to nothing but asking a Mac, and it turns off again');

  // Removing the passkey and ending every other session, from the browser that holds the key.
  await a.goto(`${ORIGIN}/account`);
  await a.waitForSelector('#passkeys button');
  await a.click('#passkeys button');
  await until(async () => (await a.textContent('#status')).includes('Passkey removed'), 15e3, 'the passkey to be removed');
  assert.equal(await a.$$eval('#passkeys li', l => l.length), 0);
  await a.click('#signout-all');
  await until(async () => (await a.textContent('#status')).includes('Every other browser is signed out'), 15e3, 'every other session to end');
  await b.goto(`${ORIGIN}/account`);
  await b.waitForSelector('[data-view="signed-out"]:not([hidden])', { timeout: 15e3 });
  await a.reload();
  await a.waitForSelector('[data-view="signed-in"]:not([hidden])', { timeout: 15e3 });
  step('a passkey removed, and every other browser signed out, from the account page');

  // What the relay holds about the account: no address, no account key, no keyring in the clear.
  const ak = (await a.evaluate(() => new Promise(r => { const q = indexedDB.open('dibs-account', 1); q.onsuccess = () => { const g = q.result.transaction('me').objectStore('me').get('me'); g.onsuccess = () => r(g.result.ak); }; })));
  const state = spawnSync('sh', ['-c', `grep -rl "${ak}" ${path.join(HERE, '.wrangler')} || true`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(state, '', 'the account key is nowhere in the relay\'s storage');
  const addr = spawnSync('sh', ['-c', `grep -rli "person@example.com" ${path.join(HERE, '.wrangler', 'state')} || true`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(addr, '', 'no email address in the relay\'s storage');
  step('the relay\'s storage holds neither the email address nor the account key');
  assert.deepEqual(errors, []);
}

try {
  arm();
  await Promise.race([main(), hangs]);
  console.log('e2e passed');
} catch (e) {
  console.error(`e2e FAILED: ${e.stack || e.message}`);
  for (const p of procs) console.error(`--- ${p.spawnargs.slice(0, 3).join(' ')}\n${p.log.slice(-2500)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) stop(p);
  await wait(500);
  fs.rmSync(HOME, { recursive: true, force: true });
  clearTimeout(stepTimer);
  process.exit(process.exitCode ?? 0);
}
