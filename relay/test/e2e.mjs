// The whole path for real, on this machine: the relay Worker under wrangler dev,
// `dibs relay` connected to it from a throwaway DIBS_HOME, `dibs pair --remote`,
// and headless Chromium opening the link, pairing, loading the board, reloading,
// riding out the Mac going away and coming back, and losing access on revoke.
// Also: the page's security headers, SRI refusing a changed script, the relay
// refusing a Mac with the wrong key and a browser from another origin.
//
//   cd relay && ~/bin/dibs run playwright --port WEB -m "relay e2e" -- node test/e2e.mjs
//
// It needs Playwright with Chromium installed: wherever Node finds `playwright`,
// or DIBS_PLAYWRIGHT=<the playwright package folder>. dibs itself has no dependencies.
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
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-relay-e2e-'));
const procs = [];
let browser = null;
// mcp.localhost stands in for mcp.dibs.cc: Chromium sends *.localhost to this machine, and
// the Node requests below name it in their Host header.
const MCP_HOST = `mcp.localhost:${PORT}`;
// human.localhost the same way for human.dibs.cc, the person check's own origin.
const HUMAN_HOST = `human.localhost:${PORT}`;
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
  const wrangler = start(path.join(HERE, 'node_modules', '.bin', 'wrangler'), ['dev', '--env', 'local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', '0', '--var', `MCP_HOST:${MCP_HOST}`, '--var', `HUMAN_HOST:${HUMAN_HOST}`, '--var', 'MCP_PER_MIN:40', '--var', 'MCP_ANON_PER_MIN:40', '--var', 'LOOKUPS_PER_IP:5', '--var', 'LOOKUPS_GLOBAL:20', '--var', `REG_SECRET:${crypto.randomBytes(32).toString('base64url')}`],
    { cwd: HERE, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' } });
  await until(async () => { try { return (await fetch(`${ORIGIN}/`)).ok; } catch { return false; } }, 90e3, `wrangler dev on ${PORT}\n${wrangler.log}`);
  step('relay Worker up under wrangler dev');

  const page0 = await fetch(`${ORIGIN}/`);
  const csp = page0.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /require-trusted-types-for 'script'/);
  assert.match(csp, new RegExp(`connect-src 'self' wss://127.0.0.1:${PORT} ws://127.0.0.1:${PORT};`));
  assert.equal(page0.headers.get('x-frame-options'), 'DENY');
  assert.equal(page0.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page0.headers.get('strict-transport-security'), /max-age=63072000/);
  const html = await page0.text();
  assert.match(html, /<script src="\/web\/transport.js" integrity="sha384-/);
  assert.doesNotMatch(html, /<script>/);
  step('page headers: CSP, frame-ancestors, HSTS, no-referrer; scripts carry SRI');

  // The relay keeps out a Mac with the wrong key, and browsers from another origin.
  const evil = crypto.generateKeyPairSync('ed25519');
  const someMid = crypto.randomBytes(16).toString('base64url');
  const code = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/m/${someMid}`);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'auth', pub: Buffer.from(evil.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64url'), sig: crypto.sign(null, Buffer.from('x'), evil.privateKey).toString('base64url') }));
    };
    ws.onclose = e => resolve(e.code);
  });
  assert.equal(code, 4401);
  const cross = await new Promise((resolve, reject) => {
    const r = http.get(`${ORIGIN}/ws/b/${someMid}`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' } });
    r.on('response', res => { res.resume(); resolve(res.statusCode); });
    r.on('upgrade', res => { res.socket?.destroy(); resolve(101); });
    r.on('error', reject);
  });
  assert.equal(cross, 403);
  step('relay refuses a Mac with the wrong key (4401) and a browser from another origin (403)');

  let mac = macRelay();
  await until(() => status().state === 'connected', 30e3, `dibs relay to connect\n${mac.log}`);
  const svc = dibs(['service', 'status', 'relay']);
  assert.match(svc, /relay: connected/);
  step('dibs relay connected; dibs service status relay says so');

  // Silent sockets claiming to be the Mac can't lock it out: each is closed on its own timer,
  // and past the cap the oldest waiting one goes, never the newcomer.
  const mid = mac.log.match(/machine ([A-Za-z0-9_-]{22})/)[1];
  const junk = [];
  for (let i = 0; i < 9; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/m/${mid}`);
    ws.closedWith = new Promise(r => { ws.onclose = e => r(e.code); });
    ws.opened = new Promise(r => { ws.onopen = () => r(true); ws.onerror = () => r(false); });
    junk.push(ws);
    await ws.opened;
  }
  assert.deepEqual(await Promise.all(junk.map(w => w.opened)), Array(9).fill(true));
  assert.equal(await junk[0].closedWith, 4401);
  stop(mac);
  await until(() => mac.exitCode !== null || mac.signalCode !== null, 10e3, 'dibs relay to stop');
  mac = macRelay();
  await until(() => status().state === 'connected' && status().pid === mac.pid, 30e3, `dibs relay to connect past the junk\n${mac.log}`);
  const t0 = Date.now();
  assert.deepEqual(await Promise.all(junk.slice(1).map(w => w.closedWith)), Array(8).fill(4401));
  assert.ok(Date.now() - t0 < 15e3, 'unauthenticated Mac sockets closed on their own timers');
  step('9 silent Mac sockets: all accepted, the oldest evicted, the rest closed within 10 s; the real Mac connected meanwhile');

  // A tab gets a slot only by proving it's paired. Forged-Origin clients without a token:
  // one sending a single byte, one with a made-up token, one asking to pair with no link open,
  // one sending nothing. All closed, and a fourth unproven tab from one address isn't let in.
  const tabs = [];
  for (let i = 0; i < 4; i++) tabs.push(await rawTab(mid));
  assert.deepEqual(tabs.map(x => x.status), [101, 101, 101, 429]);
  const t0b = Date.now();
  wsSend(tabs[0].socket, Buffer.from([1]));
  wsSend(tabs[1].socket, JSON.stringify({ t: 'hello', rt: crypto.randomBytes(32).toString('base64url') }));
  wsSend(tabs[2].socket, JSON.stringify({ t: 'pair' }));
  assert.deepEqual(await Promise.all(tabs.slice(0, 3).map(x => x.closed)), [4403, 4403, 4403]);
  assert.ok(Date.now() - t0b < 2000, 'refused at once, not after a grace');
  // A closed tab frees its slot once its connection ends; this client never acknowledges the close.
  for (const x of tabs) x.socket?.destroy();
  let silent;
  await until(async () => (silent = await rawTab(mid)).status === 101, 10e3, 'an unproven slot to free');
  assert.equal(await silent.closed, 4403);
  silent.socket.destroy();
  // The new-tab budget is per address: one address using all of it leaves another its own.
  const opened = [];
  for (let i = 0; i < 30; i++) { const x = await rawTab(mid, { ip: '203.0.113.7' }); opened.push(x.status); x.socket?.destroy(); }
  assert.ok(opened.every(x => x === 101 || x === 429) && opened.filter(x => x === 101).length >= 3);
  const over = await rawTab(mid, { ip: '203.0.113.7' });
  assert.equal(over.status, 429);
  assert.match(over.body, /too many new tabs from this address/);
  const other = await rawTab(mid, { ip: '198.51.100.4' });
  assert.equal(other.status, 101);
  other.socket.destroy();
  step('31 new tabs a minute from one address: refused past 30; another address still gets in');
  step('tabs without a registered relay token are closed: one byte, a made-up token, pairing with no link open, silence (5 s); a 4th unproven tab per address is refused');

  // Asking to pair without the link's ticket gets the same answer whether a link is open or
  // not (no oracle), and tabs without it can't take the pairing pool (no starvation).
  const askPair = async (ip, ticket) => {
    const x = await rawTab(mid, { ip });
    wsSend(x.socket, JSON.stringify(ticket === undefined ? { t: 'pair' } : { t: 'pair', ticket }));
    const code = await x.closed;
    x.socket.destroy();
    return JSON.stringify({ texts: x.texts, code });
  };
  const noLink = await askPair('192.0.2.10', crypto.randomBytes(32).toString('base64url'));
  const out = dibs(['pair', '--remote']);
  await wait(1500);   // the Mac tells the relay about a new link within a second (src/relay.mjs TOKEN_SYNC)
  const asked = [];
  for (let i = 0; i < 6; i++) asked.push(await askPair(`192.0.2.${20 + i}`, i % 2 ? undefined : crypto.randomBytes(32).toString('base64url')));
  assert.equal(noLink, JSON.stringify({ texts: ['{"t":"refused","why":"no-pairing"}'], code: 4403 }));
  assert.deepEqual(asked, Array(6).fill(noLink));
  step('without the ticket, asking to pair gets one answer whether or not a link is open; 6 such tabs never hold a pairing slot');
  const link = out.match(/http:\/\/127\.0\.0\.1:\d+\/#p=\S+/)[0];
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  // Every Playwright wait gives up long before the step watchdog.
  ctx.setDefaultTimeout(30e3);
  ctx.setDefaultNavigationTimeout(30e3);
  const page = await ctx.newPage();
  const frames = [];
  page.on('websocket', ws => {
    ws.on('framesent', f => frames.push(Buffer.from(f.payload)));
    ws.on('framereceived', f => frames.push(Buffer.from(f.payload)));
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // A CSP or Trusted Types refusal on the real page means the policy broke something.
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|TrustedHTML|Trusted Type|integrity/i.test(m.text())) errors.push(m.text()); });
  await page.goto(link);
  // The app shows as soon as there's a Mac to reach, saying what it waits on; the board follows.
  await page.waitForSelector('#app:not([hidden])', { timeout: 30e3 });
  await until(() => page.evaluate(() => dibsTransport.state.state === 'ready' && !document.querySelector('#eyebrow.busy') && document.getElementById('timeline').childElementCount > 0), 30e3, 'the board');
  assert.equal(await page.evaluate(() => location.hash), '');
  const key = await page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('dibs-relay', 1);
    r.onsuccess = () => {
      const g = r.result.transaction('macs').objectStore('macs').getAll();
      g.onsuccess = () => resolve(g.result.map(x => ({ alg: x.keys.privateKey.algorithm.name, extractable: x.keys.privateKey.extractable, name: x.name })));
    };
    r.onerror = reject;
  }));
  assert.deepEqual(key, [{ alg: 'Ed25519', extractable: false, name: 'Chrome on Mac' }]);
  assert.match(dibs(['pair', '--list']), /remote: Chrome on Mac/);
  step('Chromium paired from the link, the fragment is gone, the device key is non-extractable in IndexedDB, the board loaded');

  const posted = await page.evaluate(() => dibsTransport.fetchApi('POST', '/api/pace', { pace: 'quiet' }));
  assert.equal(posted.status, 403);
  assert.match(posted.json.error, /can only look.*--allow-actions/);
  const told = await page.evaluate(() => dibsTransport.fetchApi('POST', '/api/tell', { to: 'e2e', text: 'hi' }));
  assert.equal(told.status, 403);
  assert.match(told.json.error, /only works on the Mac itself/);
  step('a look-only browser\'s POST is refused with how to pair with actions; messaging an agent is refused outright');

  const seen = Buffer.concat(frames).toString('latin1');
  for (const word of ['/api/board', '"agents"', '"machine"', 'Chrome on Mac', await tokenOf(page)]) assert.ok(!seen.includes(word), `the relay carried ${word} in the clear`);
  step(`${frames.length} WebSocket frames carried no path, board field or device name in the clear`);

  // Nothing from the board stays in the browser: it's end to end.
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('dibs-board'))), []);
  // The reports a new tab draws at once are kept with numbers and names only, and their time.
  await until(() => page.evaluate(() => !!localStorage.getItem('dibs:/api/history?since=1d')), 30e3, 'the day\'s history to be kept');
  const report = await page.evaluate(() => localStorage.getItem('dibs:/api/history?since=1d'));
  assert.ok(JSON.parse(report).at > Date.now() - 60e3, 'a kept report says when');
  assert.doesNotMatch(report, /"(cmd|key|purpose|reason|why|text)":"[^"]/, 'no command lines or words anyone wrote are kept');
  assert.deepEqual(JSON.parse(report).v.lines, [], 'the written summary isn\'t kept');
  await page.reload();
  await page.waitForSelector('#app:not([hidden])', { timeout: 30e3 });
  await until(() => page.evaluate(() => dibsTransport.state.state === 'ready' && !document.querySelector('#eyebrow.busy')), 30e3, 'the board after reload');
  step('nothing from the board is kept in the browser; a reload opens a fresh session from the stored keys, no link needed');

  // A tab holding this browser's real token is let in; once the Mac goes, it's closed after the
  // grace even while it keeps sending.
  const rt = await tokenOf(page);
  const held = await rawTab(mid);
  wsSend(held.socket, JSON.stringify({ t: 'hello', rt }));
  await wait(300);   // the relay admits it before the Mac goes; nothing to poll from a raw socket
  stop(mac);
  const chatter = setInterval(() => { try { wsSend(held.socket, Buffer.from([2, 0, 0, 0])); } catch {} }, 300);
  const t1 = Date.now();
  const heldCode = await Promise.race([held.closed, wait(15e3).then(() => { throw new Error('a tab kept its slot while the Mac was offline'); })]);
  clearInterval(chatter);
  assert.equal(heldCode, 4408);
  assert.ok(Date.now() - t1 < 10e3);
  await until(() => page.evaluate(() => dibsTransport.state.state === 'offline'), 30e3, 'the page to see the Mac go');
  step('with the Mac offline, a paired tab is closed after the grace (4408) even while it keeps sending');
  mac = macRelay();
  await until(() => page.evaluate(async () => { try { return (await dibsTransport.fetchApi('GET', '/api/board')).status === 200; } catch { return false; } }), 60e3, 'the page to reconnect');
  step('the page saw the Mac go offline and reconnected with new keys when it came back');

  const reused = await ctx.newPage();
  await reused.goto(link);
  await until(() => reused.evaluate(() => dibsTransport.state.state === 'error'), 30e3, 'a used link to be refused');
  assert.match(await reused.evaluate(() => dibsTransport.state.detail), /already used or has expired/);
  await closeSoon(reused);
  step('the same link opened again is refused as used');

  const kept = await rawTab(mid);
  wsSend(kept.socket, JSON.stringify({ t: 'hello', rt }));
  await wait(300);   // admitted before the revoke
  dibs(['pair', '--revoke', 'all']);
  assert.equal(await Promise.race([kept.closed, wait(10e3).then(() => 'still open')]), 4403);
  step('a revoke takes the token\'s hash off the relay and closes that device\'s open tabs');
  await page.reload();
  await until(() => page.evaluate(() => dibsTransport.state.state === 'unpaired'), 30e3, 'the revoked page to be refused');
  assert.equal(await page.isVisible('#signin'), true);
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('dibs:/api/'))), [], 'the kept reports go with the pairing');
  step('after dibs pair --revoke all the page is refused, shows how to pair again, and the kept reports are gone');

  // The code dibs pair --remote shows beside the QR code, typed into the pair card.
  assert.equal(await page.isVisible('#code'), true, 'the pair card has a code box');
  assert.match(await page.textContent('label[for="code"]'), /Type the code from your Mac/);
  const pageReq = (body, headers = {}) => mcpReq('POST', '/pair/code', { headers: { Host: `127.0.0.1:${PORT}`, Origin: ORIGIN, ...headers }, body });
  const typedOut = dibs(['pair', '--remote']);
  const typed = typedOut.match(/^Code: (\S+)$/m)[1];
  await wait(1500);   // the Mac tells the relay about a new link within a second (src/relay.mjs TOKEN_SYNC)
  const wrongK = typed.slice(0, 5) + (typed[5] === '2' ? '3' : '2') + typed.slice(6);
  await page.fill('#code', wrongK.replace(/-/g, '').toLowerCase());
  assert.equal(await page.inputValue('#code'), wrongK, 'typing groups the code by fours');
  await page.click('#signin-form button');
  await until(async () => /doesn't match/.test(await page.textContent('#signin-error')), 30e3, 'a wrong code to be refused in the page');
  await page.fill('#code', 'ZZZZ-ZZZZ-ZZZZ');
  await page.click('#signin-form button');
  await until(async () => /No Mac has that code open/.test(await page.textContent('#signin-error')), 30e3, 'an unknown code to be refused');
  await page.fill('#code', typed);
  await page.click('#signin-form button');
  await page.waitForSelector('#app:not([hidden])', { timeout: 30e3 });
  await until(() => page.evaluate(() => dibsTransport.state.state === 'ready'), 30e3, 'the board after a typed code');
  await until(async () => (await pageReq({ r: typed.slice(0, 4) }, { 'CF-Connecting-IP': '192.0.2.50' })).status === 404, 10e3, 'a used link\'s box to leave the relay');
  step('a typed code pairs: a wrong last 8 and an unknown code are refused in the page with what to do, the right one pairs, and the box is gone once used');

  const capped = dibs(['pair', '--remote']).match(/^Code: (\S+)$/m)[1];
  await wait(1500);
  const takes = [];
  for (let i = 0; i < 4; i++) takes.push((await pageReq({ r: capped.slice(0, 4) }, { 'CF-Connecting-IP': `192.0.2.${60 + i}` })).status);
  assert.deepEqual(takes, [200, 200, 200, 404]);
  assert.equal((await pageReq({ r: 'ZZZZ' }, { Origin: 'https://evil.example' })).status, 403);
  const fromOne = [];
  for (let i = 0; i < 6; i++) fromOne.push((await pageReq({ r: 'ZZZZ' }, { 'CF-Connecting-IP': '192.0.2.77' })).status);
  assert.deepEqual(fromOne, [404, 404, 404, 404, 404, 429]);
  dibs(['pair', '--revoke', 'all']);
  step('a code\'s box is handed out 3 times at most, only to the page\'s own origin, and fetches are limited per address');

  // Remote MCP through mcp.dibs.cc (mcp.localhost here): off by default, then the whole sign-in.
  const B = `http://${MCP_HOST}/${mid}`;
  assert.equal((await mcpReq('GET', `/${mid}/.well-known/oauth-authorization-server`)).status, 404);
  step('remote MCP off: 404');
  dibs(['relay', 'mcp', 'on']);
  const as = await mcpReq('GET', `/.well-known/oauth-authorization-server/${mid}`);
  assert.equal(as.status, 200, as.text);
  assert.equal(as.json.issuer, B);
  assert.equal(as.json.authorization_endpoint, `${B}/authorize`);
  assert.equal((await mcpReq('GET', `/${mid}/.well-known/oauth-protected-resource`)).json.resource, `${B}/mcp`);
  assert.match(dibs(['service', 'status', 'relay']), /remote MCP on at http:\/\/mcp\.localhost/);
  step('remote MCP on: discovery (both path forms) names the mcp host and this machine id; dibs service status says so');
  for (const [m, p] of [['GET', `/${mid}/api/board`], ['POST', `/${mid}/api/login`], ['GET', `/${mid}/`], ['GET', '/'], ['GET', `/${mid}/web/app.js`], ['DELETE', `/${mid}/mcp`], ['GET', `/ws/b/${mid}`]]) {
    const r = await mcpReq(m, p);
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  step('through the mcp host, the page, its API, its WebSocket and anything but MCP are 404 at the relay');

  const redirect = 'http://localhost:9/callback';
  const reg = await mcpReq('POST', `/${mid}/oauth/register`, { body: { client_name: 'Claude (another account)', redirect_uris: [redirect] } });
  assert.equal(reg.status, 201, reg.text);
  const verifier = crypto.randomBytes(40).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  note('open the sign-in page');
  const auth = await ctx.newPage();
  let landed = null;
  await auth.route('http://localhost:9/**', route => { landed = route.request().url(); return route.fulfill({ status: 200, body: 'ok' }); });
  const authResp = await auth.goto(`${B}/authorize?${new URLSearchParams({ client_id: reg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8' })}`);
  assert.match(authResp.headers()['content-security-policy'], /frame-ancestors 'none'/);
  await auth.waitForFunction(() => document.getElementById('client').textContent.includes('another account'));
  // Where the token goes comes first and largest; the name is marked as the app's own description.
  assert.equal(await auth.textContent('#dest-host'), 'localhost:9');
  assert.ok(await auth.evaluate(() => !!(document.getElementById('dest-host').compareDocumentPosition(document.getElementById('client')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  assert.match(await auth.textContent('form'), /describes itself as/);
  note('type the code');
  await auth.fill('#code', dibs(['pair']).split('\n')[0].trim());
  note('submit');
  await auth.click('button[type=submit]', { noWaitAfter: true });
  note('wait for the redirect');
  await until(() => landed, 15e3, 'the sign-in to send the browser back to the client');
  const back = new URL(landed);
  assert.equal(back.searchParams.get('state'), 'st8');
  assert.equal(back.searchParams.get('iss'), B);
  note('close the sign-in page');
  await closeSoon(auth);
  note('exchange the code');
  const tok = await mcpReq('POST', `/${mid}/oauth/token`, { body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: reg.json.client_id, redirect_uri: redirect, code_verifier: verifier }).toString() });
  assert.equal(tok.status, 200, tok.text);
  const call = (token, method, params = {}) => mcpReq('POST', `/${mid}/mcp`, { headers: { Authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method, params } });
  const list = await call(tok.json.access_token, 'tools/list');
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.result.tools.map(x => x.name).sort(), ['agent', 'agents', 'board', 'history', 'machines', 'messages', 'progress', 'questions', 'resource', 'stats']);
  const board = await call(tok.json.access_token, 'tools/call', { name: 'board', arguments: {} });
  assert.equal(board.status, 200, board.text);
  assert.ok(board.json.result.content[0].text.length > 0);
  const unauth = await call('not-a-token', 'tools/list');
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers['www-authenticate'], new RegExp(`resource_metadata="${B.replace(/[.]/g, '\\.')}/\\.well-known/oauth-protected-resource"`));
  step('OAuth + PKCE through the relay: register, the sign-in page in Chromium with a dibs pair code, token, tools/list, tools/call');

  const listed = dibs(['pair', '--list']);
  const rid = listed.split('\n').find(x => x.includes('MCP via mcp.dibs.cc: Claude (another account)')).split(/\s+/)[0];
  dibs(['pair', '--revoke', rid]);
  assert.equal((await call(tok.json.access_token, 'tools/list')).status, 401);
  step('dibs pair --list names it "MCP via mcp.dibs.cc", and --revoke cuts it off');

  // The bare host, https://mcp.dibs.cc/mcp: no machine id in the URL. A second Mac (machine B)
  // shares the relay, to show codes and tokens reach only their own machine.
  const HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dibs-relay-e2e-b-'));
  const ENV2 = { ...ENV, DIBS_HOME: HOME2 };
  const dibsB = args => { const r = spawnSync(process.execPath, [BIN, ...args], { env: ENV2, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout; };
  dibsB(['relay', 'mcp', 'on']);
  const macB = start(process.execPath, [BIN, 'relay', '--url', `ws://127.0.0.1:${PORT}`], { env: ENV2 });
  procs.push({ ...macB, home: HOME2 });
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(HOME2, 'relay-status.json'), 'utf8')).state === 'connected'; } catch { return false; } }, 30e3, `machine B to connect\n${macB.log}`);
  const midB = macB.log.match(/machine ([A-Za-z0-9_-]{22})/)[1];
  const BARE = `http://${MCP_HOST}`;
  assert.match(dibs(['pair']).split('\n')[0], /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.match(dibs(['relay', 'mcp']), new RegExp(`remote MCP on at ${BARE.replace(/[.]/g, '\\.')}/mcp\\b`));
  step('with remote MCP on, dibs pair prints 12-character codes, and the URL to use is the bare one');

  const bas = await mcpReq('GET', '/.well-known/oauth-authorization-server');
  assert.equal(bas.json.issuer, BARE);
  assert.equal(bas.json.registration_endpoint, `${BARE}/oauth/register`);
  assert.equal((await mcpReq('GET', '/.well-known/oauth-protected-resource/mcp')).json.resource, `${BARE}/mcp`);
  const breg = await mcpReq('POST', '/oauth/register', { body: { client_name: 'Claude on the bare host', redirect_uris: [redirect] } });
  assert.equal(breg.status, 201, breg.text);
  assert.match(breg.json.client_id, /^b\./);
  step('bare host: discovery and registration answered by the relay, with nothing stored');

  // The person check has an origin of its own, framed out of sight by the account page: Turnstile's
  // script is allowed there and nowhere else, not on the account page's origin nor on this one. The
  // old email page here sends people to the account page, where the email step is now.
  const human = (method, p) => mcpReq(method, p, { headers: { Host: HUMAN_HOST } });
  const hp = await human('GET', '/');
  assert.equal(hp.status, 200);
  assert.match(hp.text, /challenges\.cloudflare\.com\/turnstile/);
  assert.match(hp.headers['content-security-policy'], /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(hp.headers['content-security-policy'], /frame-ancestors https?:\/\/[^ ;*]*(;|$)/, 'only the account page may frame it');
  assert.equal(hp.headers['x-frame-options'], undefined);
  assert.match((await human('GET', '/web/human.js')).text, /dibsHuman/);
  assert.equal((await human('GET', '/config')).json.sitekey, null);
  for (const p of ['/mcp', '/account', '/web/app.js', '/human']) assert.equal((await human('GET', p)).status, 404, `${p} isn't served on the person check's origin`);
  assert.equal((await human('POST', '/')).status, 405);
  for (const p of ['/human', '/human/config', '/web/human.js']) assert.equal((await mcpReq('GET', p)).status, 404, `${p} is gone from the MCP host`);
  assert.equal((await mcpReq('GET', '/email')).status, 301);
  assert.equal((await mcpReq('POST', '/email/link', { body: { email: 'a@b.cc', token: 'x' }, headers: { Origin: BARE } })).status, 404, 'nothing sends a code from here any more');
  const onPage = await new Promise((resolve, reject) => http.get(`${ORIGIN}/human`, r => { r.resume(); resolve(r.statusCode); }).on('error', reject));
  assert.equal(onPage, 404, 'the account page\'s origin never serves it');
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, 'public', 'account.html'), 'utf8'), /challenges\.cloudflare\.com/);
  step('the person check is on its own host with Turnstile allowed there only, framed only by the account page, and gone from the MCP host; the old email page redirects');

  const bverifier = crypto.randomBytes(40).toString('base64url');
  const bchallenge = crypto.createHash('sha256').update(bverifier).digest('base64url');
  const bauth = await ctx.newPage();
  let blanded = null;
  await bauth.route('http://localhost:9/**', route => { blanded = route.request().url(); return route.fulfill({ status: 200, body: 'ok' }); });
  await bauth.goto(`${BARE}/authorize?${new URLSearchParams({ client_id: breg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256', state: 'b1' })}`);
  await bauth.waitForFunction(() => document.getElementById('client').textContent.includes('bare host'));
  const codeA = dibs(['pair']).split('\n')[0].trim();
  await wait(1500);   // the Mac lists a new code with the relay's index within a second
  await bauth.fill('#code', codeA);
  await bauth.click('button[type=submit]', { noWaitAfter: true });
  await until(() => blanded, 15e3, 'the bare sign-in to send the browser back');
  await closeSoon(bauth);
  const bback = new URL(blanded);
  assert.ok(bback.searchParams.get('code').startsWith(`${mid}.`), 'machine A\'s code reached machine A');
  assert.equal(bback.searchParams.get('iss'), BARE);
  const btok = await mcpReq('POST', '/oauth/token', { body: new URLSearchParams({ grant_type: 'authorization_code', code: bback.searchParams.get('code'), client_id: breg.json.client_id, redirect_uri: redirect, code_verifier: bverifier }).toString() });
  assert.equal(btok.status, 200, btok.text);
  assert.ok(btok.json.access_token.startsWith(`${mid}.`));
  const bcall = (token, method, params = {}) => mcpReq('POST', '/mcp', { headers: { Authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method, params } });
  assert.equal((await bcall(btok.json.access_token, 'tools/list')).status, 200);
  const bboard = await bcall(btok.json.access_token, 'tools/call', { name: 'board', arguments: {} });
  assert.equal(bboard.status, 200, bboard.text);
  const brefresh = await mcpReq('POST', '/oauth/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: btok.json.refresh_token, client_id: breg.json.client_id }).toString() });
  assert.equal(brefresh.status, 200, brefresh.text);
  assert.equal((await bcall(brefresh.json.access_token, 'tools/list')).status, 200);
  step('bare host: OAuth + PKCE through the code index in Chromium, token and refresh routed by tag, tools/list and tools/call');

  // A client id is signed by the relay: an edited one (say, to swap in another redirect) is refused everywhere.
  const [, payload, sig] = breg.json.client_id.split('.');
  const evilPayload = Buffer.from(JSON.stringify({ n: 'Claude on the bare host', r: ['https://evil.example/cb'] })).toString('base64url');
  for (const forgedId of [`b.${evilPayload}.${sig}`, `b.${payload}.${'A'.repeat(22)}`, `b.${payload}`]) {
    assert.equal((await mcpReq('GET', `/oauth/client?client_id=${forgedId}`)).status, 404, forgedId);
    const fa = await mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': '198.51.100.40' }, body: { code: 'ZZZZ-ZZZZ-ZZZZ', client_id: forgedId, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
    assert.equal(fa.status, 400, fa.text);
    const ft = await mcpReq('POST', '/oauth/token', { body: new URLSearchParams({ grant_type: 'authorization_code', code: `${mid}.${crypto.randomBytes(32).toString('base64url')}`, client_id: forgedId, redirect_uri: 'https://evil.example/cb', code_verifier: bverifier }).toString() });
    assert.equal(ft.json.error, 'invalid_client');
  }
  step('an edited or unsigned bare client id: unknown at /oauth/client, refused at authorize and token');

  // Strangers can't spend the signed-in client's budget: unauthenticated requests drain their own.
  const anonBurst = [];
  for (let i = 0; i < 45; i++) anonBurst.push((await mcpReq('GET', `/${mid}/.well-known/oauth-protected-resource`, { headers: { 'CF-Connecting-IP': '192.0.2.100' } })).status);
  assert.ok(anonBurst.includes(429), `no 429 in ${anonBurst.join(',')}`);
  const stillOk = await bcall(brefresh.json.access_token, 'tools/list');
  assert.equal(stillOk.status, 200, 'the signed-in client still gets through');
  const garbage = [];
  for (let i = 0; i < 5; i++) garbage.push((await bcall(`${mid}.${crypto.randomBytes(32).toString('base64url')}`, 'tools/list')).status);
  assert.equal((await bcall(brefresh.json.access_token, 'tools/list')).status, 200, 'made-up tokens don\'t spend the signed-in budget');
  // And one address can hold at most 2 of the machine's 8 requests in flight.
  const parallel = await Promise.all(Array.from({ length: 10 }, () => bcall(brefresh.json.access_token, 'tools/list')));
  assert.ok(parallel.some(r => r.status === 429), `no 429 among ${parallel.map(r => r.status).join(',')}`);
  step(`budgets: ${anonBurst.filter(x => x === 429).length} of 45 unauthenticated requests refused while the signed-in client still got through; 10 at once from one address: ${parallel.filter(r => r.status === 429).length} refused`);

  // Knowing the machine id is not enough to lock the person out: a flood of made-up tokens with
  // that tag from two addresses costs only those addresses, and leaves no debt behind.
  const flood = [];
  for (let i = 0; i < 60; i++) flood.push((await mcpReq('POST', '/mcp', { headers: { Authorization: `Bearer ${mid}.junk${i}`, 'CF-Connecting-IP': i % 2 ? '198.18.0.1' : '198.18.0.2' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status);
  assert.ok(flood.every(x => x === 401 || x === 429), flood.join(','));
  const third = { 'CF-Connecting-IP': '198.18.0.3' };
  const renewed = await mcpReq('POST', '/oauth/token', { headers: third, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: brefresh.json.refresh_token, client_id: breg.json.client_id }).toString() });
  assert.equal(renewed.status, 200, `refresh after the flood: ${renewed.text}`);
  const codeF = dibs(['pair']).split('\n')[0].trim();
  await wait(1500);   // the Mac lists the new code with the index within a second
  const vF = crypto.randomBytes(40).toString('base64url');
  const signF = await mcpReq('POST', '/oauth/authorize', { headers: { ...third, Origin: BARE }, body: { code: codeF, client_id: breg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: crypto.createHash('sha256').update(vF).digest('base64url'), code_challenge_method: 'S256' } });
  assert.equal(signF.status, 200, `sign-in after the flood: ${signF.text}`);
  const tokF = await mcpReq('POST', '/oauth/token', { headers: third, body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(signF.json.redirect).searchParams.get('code'), client_id: breg.json.client_id, redirect_uri: redirect, code_verifier: vF }).toString() });
  assert.equal(tokF.status, 200, tokF.text);
  assert.equal((await bcall(tokF.json.access_token, 'tools/list')).status, 200);
  step(`60 made-up tokens tagged with the machine id from 2 addresses (${flood.filter(x => x === 401).length} x 401, ${flood.filter(x => x === 429).length} x 429), then from a third: refresh and a new sign-in both work`);

  // Machine B's code reaches B, and A's token with B's tag (or a made-up tag) gets nowhere.
  const breg2 = await mcpReq('POST', '/oauth/register', { body: { client_name: 'for machine B', redirect_uris: [redirect] } });
  const codeB = dibsB(['pair']).split('\n')[0].trim();
  await wait(1500);
  const v2 = crypto.randomBytes(40).toString('base64url');
  const authB = await mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': '198.51.100.2' }, body: { code: codeB, client_id: breg2.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: crypto.createHash('sha256').update(v2).digest('base64url'), code_challenge_method: 'S256' } });
  assert.equal(authB.status, 200, authB.text);
  assert.ok(new URL(authB.json.redirect).searchParams.get('code').startsWith(`${midB}.`), 'machine B\'s code reached machine B');
  // A spent code leaves the index at once: tried again right away, it reaches no Mac.
  const rfB = () => JSON.parse(fs.readFileSync(path.join(HOME2, 'web.json'), 'utf8')).rfails.length;
  const rfBefore = rfB();
  const again = await mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': '198.51.100.2' }, body: { code: codeB, client_id: breg2.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
  assert.equal(again.status, 401);
  assert.equal(rfB(), rfBefore, 'the spent code went to no Mac');
  const rest = btok.json.access_token.slice(23);
  for (const forged of [`${midB}.${rest}`, `${crypto.randomBytes(16).toString('base64url')}.${rest}`, rest, `${mid}.${crypto.randomBytes(32).toString('base64url')}`]) {
    const r = await bcall(forged, 'tools/list');
    assert.equal(r.status, 401, forged);
    assert.equal(r.headers['www-authenticate'], `Bearer resource_metadata="${BARE}/.well-known/oauth-protected-resource"`);
  }
  step('a code for machine B routes only to B; A\'s token re-tagged for B, a made-up tag, no tag, or a made-up token: all 401');

  // An unknown code gets the same answer as a wrong one checked by a Mac.
  const unknown = await mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': '198.51.100.1' }, body: { code: 'ZZZZ-ZZZZ-ZZZZ', client_id: breg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
  // Machine B's own budget, untouched by the bursts above.
  const reg2 = await mcpReq('POST', `/${midB}/oauth/register`, { body: { client_name: 'wrong code compare', redirect_uris: [redirect] } });
  const macWrong = await mcpReq('POST', `/${midB}/oauth/authorize`, { headers: { Origin: BARE }, body: { code: 'ZZZZ-ZZZZ-ZZZZ', client_id: reg2.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
  assert.deepEqual([unknown.status, unknown.json], [macWrong.status, macWrong.json]);
  assert.equal(unknown.status, 401);
  // A malformed code gets the very same answer: nothing tells malformed, unknown and expired apart.
  for (const [i, c] of ['', '!!!', 'x'.repeat(300)].entries()) {
    const r = await mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': `198.51.100.${50 + i}` }, body: { code: c, client_id: breg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
    assert.deepEqual([r.status, r.json], [unknown.status, unknown.json], JSON.stringify(c));
  }
  step('an unknown, malformed or spent code at the bare host: the same 401 and words as a wrong code at a Mac');

  // A revoked code leaves the index: trying it reaches no Mac (its wrong-code count doesn't move).
  const codeR = dibs(['pair']).split('\n')[0].trim();
  await wait(1500);
  dibs(['pair', '--revoke', 'all']);
  await wait(1500);
  const rf = () => JSON.parse(fs.readFileSync(path.join(HOME, 'web.json'), 'utf8')).rfails.length;
  const before = rf();
  const revoked = await mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': '198.51.100.3' }, body: { code: codeR, client_id: breg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
  assert.equal(revoked.status, 401);
  assert.equal(rf(), before, 'the relay sent it to no Mac');
  step('dibs pair --revoke all takes its codes out of the index: the code reaches no Mac');

  // Guessing limits at the index (5 a minute per address, 20 in total here).
  const guess = ip => mcpReq('POST', '/oauth/authorize', { headers: { Origin: BARE, 'CF-Connecting-IP': ip }, body: { code: `G${crypto.randomBytes(8).toString('hex')}`, client_id: breg.json.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: bchallenge, code_challenge_method: 'S256' } });
  const one = [];
  for (let i = 0; i < 6; i++) one.push((await guess('198.51.100.9')).status);
  assert.deepEqual(one, [401, 401, 401, 401, 401, 429]);
  // Across addresses the global budget runs out, but only for second and later tries: an
  // address's first try in a minute always gets an answer, so a flood can't lock everyone out.
  const firsts = [], seconds = [];
  for (let i = 0; i < 12; i++) { firsts.push((await guess(`203.0.113.${100 + i}`)).status); seconds.push((await guess(`203.0.113.${100 + i}`)).status); }
  assert.ok(seconds.includes(429), `no global 429 in ${seconds.join(',')}`);
  assert.deepEqual(firsts, Array(12).fill(401), 'every first try was answered');
  step(`guessing limits at the code index: the 6th try from one address is refused; the global budget refused ${seconds.filter(x => x === 429).length} second tries and no first try`);

  // Per machine, the relay lets through MCP_PER_MIN a minute (40 here, 120 deployed).
  const burst = [];
  for (let i = 0; i < 45; i++) burst.push((await mcpReq('GET', `/${mid}/.well-known/oauth-protected-resource`)).status);
  assert.ok(burst.includes(429), `no 429 in ${burst.join(',')}`);
  step(`a burst of 45 requests for one machine: ${burst.filter(x => x === 429).length} refused (429) past its budget`);
  dibs(['relay', 'mcp', 'off']);
  await wait(61e3 / 40 * 2);   // two requests' worth of the budget back, so the next one isn't a 429
  assert.equal((await mcpReq('GET', `/${mid}/.well-known/oauth-protected-resource`)).status, 404);
  step('dibs relay mcp off: 404 again');

  // A page whose script was changed in transit is refused by Subresource Integrity.
  const tamperCtx = await browser.newContext();
  const tp = await tamperCtx.newPage();
  await tp.route('**/web/transport.js', async route => {
    const r = await route.fetch();
    await route.fulfill({ response: r, body: `${await r.text()}\n// changed` });
  });
  const blocked = [];
  tp.on('console', m => blocked.push(m.text()));
  await tp.goto(`${ORIGIN}/`);
  await until(() => blocked.some(t => /integrity/i.test(t)), 10e3, 'SRI to refuse the changed script');
  assert.equal(await tp.evaluate(() => typeof window.dibsTransport), 'undefined');
  step('a changed transport.js is refused by SRI and never runs');

  assert.deepEqual(errors, []);
}

try {
  arm();
  await Promise.race([main(), hangs]);
  console.log('e2e passed');
} catch (e) {
  console.error(`e2e FAILED: ${e.stack || e.message}`);
  for (const p of procs) console.error(`--- ${p.spawnargs.slice(0, 3).join(' ')}\n${p.log.slice(-1500)}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) stop(p);
  for (const p of procs) if (p.home) fs.rmSync(p.home, { recursive: true, force: true });
  await wait(500);
  fs.rmSync(HOME, { recursive: true, force: true });
  clearTimeout(stepTimer);
  // A step abandoned by the watchdog may still hold a socket open; nothing here should outlive the run.
  process.exit(process.exitCode ?? 0);
}
