// dibs relay: the person's dibs page from any browser, a phone included, through
// a relay that can't read or forge anything. The page at https://app.dibs.cc talks
// to this Mac over a WebSocket the relay (relay/ in this repo, a Cloudflare Worker)
// only forwards. Everything between the page and this Mac is end-to-end encrypted
// and authenticated, so whoever runs the relay sees opaque frames and their sizes.
//
// Keys, all made here on first use and kept in relay-keys.json (0600), never sent:
//   identity  Ed25519. Signs every session handshake. Browsers pin its fingerprint.
//   relay     Ed25519. Proves to the relay that this Mac owns its machine id, which
//             is a hash of this key. It opens no session and decrypts nothing.
//
// Pairing: `dibs pair --remote` prints https://app.dibs.cc/#p=<machine id>.<secret>.<fingerprint>.
// The fragment never reaches a server. The browser makes its own Ed25519 key, and
// both pairing messages carry an HMAC under a key derived from the 256-bit secret,
// so only someone holding the link can pair, and the browser checks this Mac's key
// against the fingerprint, so a relay that swaps keys is caught. One use, ten
// minutes, spent on success.
//
// Sessions: each browser connection runs a fresh X25519 exchange, signed by this
// Mac's identity key and the device's key over the whole transcript (forward
// secrecy, mutual authentication). HKDF gives one AES-256-GCM key per direction.
// Every frame carries a sequence number in its nonce and associated data, and must
// be exactly the next one: a replayed, dropped, reordered or altered frame closes
// the session. Frames are padded to fixed sizes so their lengths say little.
//
// The protocol, message by message, is written out in docs/relay.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './config.mjs';
import { die, now, log, sleep, dur } from './util.mjs';
import { makeAlive, singleInstance } from './proc.mjs';
import { qr, render } from './qr.mjs';
import { logChange } from './owner.mjs';
import { remoteAccess, LOCAL_ONLY_TEXT, lookOnlyText, remoteMcp, MCP_ORIGIN, mcpCodes } from './web.mjs';

export const PAGE = process.env.DIBS_RELAY_PAGE || 'https://app.dibs.cc/';
export const RELAY = process.env.DIBS_RELAY_URL || 'wss://app.dibs.cc';
const KEYS = path.join(HOME, 'relay-keys.json');
const FILE = path.join(HOME, 'relay.json');
const LOCK = path.join(HOME, 'relay.lock');
export const STATUS = path.join(HOME, 'relay-status.json');
const PIDFILE = path.join(HOME, 'relay.pid');

const MIN = 6e4, HOUR = 36e5;
// Same as the local codes: long enough to walk to the phone, dead by the time a screenshot leaks.
const PAIR_LIFE = 10 * MIN;
// Pending links at once. A new one past this drops the oldest.
const MAX_PAIRS = 5;
// Wrong MACs a link takes before it's thrown away. Only someone without the secret sends one.
const PAIR_FAILS = 3;
// A session is re-keyed by reconnecting at least this often.
const SESSION_LIFE = 12 * HOUR;
// A browser that hasn't finished its handshake by then is dropped.
const HANDSHAKE_TIME = 20e3;
// Channels (browser tabs) at once; the relay caps them too.
const MAX_CHANNELS = 16;
// A call api() hasn't answered by then gets a 504, so a page never waits forever.
const CALL_TIME = 30e3;
// Pings keep the relay's idle timer and NATs happy, and tell a dead connection from a quiet one.
const PING_EVERY = 25e3;
const PONG_WAIT = 60e3;
const BACKOFF_MIN = 1000, BACKOFF_MAX = 60e3;
// How often relay.json is checked for changes the relay must hear about. A stat and a read; cheap.
const TOKEN_SYNC = 1000;
// Request frames are small; responses carry the board.
export const MAX_REQUEST = 64 * 1024;
export const BUCKETS = [1024, 4096, 16384, 65536, 262144, 1048576, 4194304];
const NAME_MAX = 60;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const T_HS = 1, T_FRAME = 2;
const DIR_B2M = 1, DIR_M2B = 2;

export const b64u = b => Buffer.from(b).toString('base64url');
// Strict: only the base64url alphabet, and exactly the length expected, or null.
export function unb64u(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  return b64u(b) === s && (len == null || b.length === len) ? b : null;
}
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const utf8 = s => Buffer.from(String(s), 'utf8');
// Every field length-prefixed after a label, so no two different transcripts encode the same.
export const tx = (label, ...fields) => Buffer.concat([label, ...fields].flatMap(f => { const b = Buffer.isBuffer(f) ? f : typeof f === 'string' ? utf8(f) : Buffer.from(f); return [u32(b.length), b]; }));
const sha = b => crypto.createHash('sha256').update(b).digest();
const hkdf = (ikm, salt, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, utf8(info), n));
const rawPub = k => Buffer.from(k.export({ format: 'jwk' }).x, 'base64url');
const okp = (crv, raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv, x: b64u(raw) }, format: 'jwk' });
export const machineId = relayPub => b64u(sha(Buffer.concat([utf8('dibs-mid-v1\0'), relayPub])).subarray(0, 16));
export const fingerprint = idPub => b64u(sha(Buffer.concat([utf8('dibs-fp-v1\0'), idPub])));
export const pairId = secret => hkdf(secret, Buffer.alloc(0), 'dibs-relay-v1 pair id', 16);
export const pairKey = secret => hkdf(secret, Buffer.alloc(0), 'dibs-relay-v1 pair key', 32);
// The device's name travels encrypted, and so does its relay token: the relay has no
// business knowing it's "Safari on iPhone", and must only ever see the token's hash from us.
export const nameKey = secret => hkdf(secret, Buffer.alloc(0), 'dibs-relay-v1 pair name', 32);
// What lets a tab into the relay's pairing pool: only someone holding the link can derive it,
// and the relay holds only its hash, so it can't tell an open link from a closed one by asking.
export const pairTicket = secret => hkdf(secret, Buffer.alloc(0), 'dibs-relay-v1 pair ticket', 32);
const NAME_AAD = utf8('dibs-pair-name-v1');
// 12-byte nonce, then AES-GCM of the name padded to NAME_PAD bytes and the 32-byte relay token, then the tag.
const NAME_PAD = 64, TOKEN_LEN = 32;
const BOX_LEN = 12 + NAME_PAD + TOKEN_LEN + 16;
// What the relay checks a tab's token against (relay/src/index.js tokenHash()).
export const tokenHash = rt => b64u(sha(Buffer.concat([utf8('dibs-relay-token-v1\0'), rt])).subarray(0, 16));
// The hashes the relay may hold in the Mac socket's attachment (relay/src/index.js MAX_HASHES).
const MAX_HASHES = 56;
// Sign-in codes the relay's index takes from one machine at once (relay/src/index.js MAX_CODES).
const MAX_CODES = 10;
function openBox(key, box) {
  if (box.length !== BOX_LEN) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
    d.setAAD(NAME_AAD);
    d.setAuthTag(box.subarray(box.length - 16));
    const p = Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
    const names = p.subarray(0, NAME_PAD), n = names.indexOf(0);
    return { name: names.subarray(0, n < 0 ? NAME_PAD : n).toString('utf8'), rt: p.subarray(NAME_PAD) };
  } catch { return null; }
}
const hmac = (k, ...parts) => crypto.createHmac('sha256', k).update(Buffer.concat(parts)).digest();
const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const ZERO = Buffer.alloc(32);

// The keys: made once, and never replaced by a second process racing the first
// (link fails if one exists, and then that one is read).
export function keys() {
  try { return parseKeys(fs.readFileSync(KEYS, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(HOME, { recursive: true });
  const pem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const tmp = `${KEYS}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, identity: pem(), relay: pem(), created: now() }), { mode: 0o600 });
  try { fs.linkSync(tmp, KEYS); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  fs.rmSync(tmp, { force: true });
  return parseKeys(fs.readFileSync(KEYS, 'utf8'));
}
function parseKeys(s) {
  const j = JSON.parse(s);
  const identity = crypto.createPrivateKey(j.identity), relay = crypto.createPrivateKey(j.relay);
  const idPub = rawPub(crypto.createPublicKey(identity)), relayPub = rawPub(crypto.createPublicKey(relay));
  return { identity, relay, idPub, relayPub, mid: machineId(relayPub), fp: fingerprint(idPub) };
}

// relay.json: { devices: {id: {pub, name, created, seen, act}}, pairs: [{pid, key, nk, exp, fails, act}], mcp }
// mcp: the person turned on remote MCP (dibs relay mcp on). Off unless they did.
// act: the device may change things (any call but GET). Absent means look only.
export function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { devices: j.devices && typeof j.devices === 'object' ? j.devices : {}, pairs: Array.isArray(j.pairs) ? j.pairs : [], mcp: j.mcp === true };
  } catch { return { devices: {}, pairs: [], mcp: false }; }
}

// `dibs pair` and the connector both write relay.json; this keeps one from undoing the other.
function locked(fn) {
  fs.mkdirSync(HOME, { recursive: true });
  const t0 = now();
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (now() - fs.statSync(LOCK).mtimeMs > 5000) {
          const aside = `${LOCK}.stale.${process.pid}`;
          fs.renameSync(LOCK, aside);
          fs.rmSync(aside, { recursive: true, force: true });
        }
      } catch {}
      if (now() - t0 > 5000) throw new Error(`${LOCK} stayed locked; remove it if no dibs is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const w = load();
    const out = fn(w);
    w.pairs = w.pairs.filter(p => p.exp > now());
    const tmp = `${FILE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return out;
  } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}

// A one-time pairing link. The secret is shown once and only its derived pieces are kept.
// act: the device it pairs may change things, not only look.
export function newPairing({ act = false } = {}) {
  const k = keys();
  const secret = crypto.randomBytes(32);
  locked(w => {
    w.pairs.push({ pid: b64u(pairId(secret)), key: b64u(pairKey(secret)), nk: b64u(nameKey(secret)), th: tokenHash(pairTicket(secret)), exp: now() + PAIR_LIFE, fails: 0, ...(act ? { act: true } : {}) });
    w.pairs = w.pairs.slice(-MAX_PAIRS);
  });
  return { link: `${PAGE}#p=${k.mid}.${b64u(secret)}.${k.fp}`, mid: k.mid, fp: k.fp, life: PAIR_LIFE, act };
}

export const devices = () => Object.entries(load().devices).map(([id, d]) => ({ id, ...d }));

// Removes every device whose id starts with `which` (or all). Live sessions end on their next frame.
export function revoke(which) {
  return locked(w => {
    let n = 0;
    for (const id of Object.keys(w.devices)) if (which === 'all' || id.startsWith(which)) { delete w.devices[id]; n++; }
    if (which === 'all') w.pairs = [];
    return n;
  });
}

// No control or format characters: a name with a bidi override could pass for another
// device's in dibs pair --list, and a line break for another line in the history.
const cleanName = s => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '') || 'a browser';

// Padding: a 4-byte length, the JSON, zeros up to the next bucket.
export function pad(obj, max = BUCKETS.at(-1)) {
  const j = utf8(JSON.stringify(obj));
  const size = BUCKETS.find(b => b >= j.length + 4);
  if (!size || size > max) return null;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(j.length);
  j.copy(out, 4);
  return out;
}
export function unpad(b) {
  if (b.length < 4 || !BUCKETS.includes(b.length)) return null;
  const n = b.readUInt32BE(0);
  if (n > b.length - 4) return null;
  try { return JSON.parse(b.subarray(4, 4 + n).toString('utf8')); } catch { return null; }
}

const nonce = seq => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(seq), 4); return n; };
const frameAad = (sid, dir, head) => Buffer.concat([utf8('dibs-frame-v1'), sid, Buffer.from([dir]), head]);
export function seal(key, sid, dir, seq, plain) {
  const head = Buffer.alloc(9);
  head[0] = T_FRAME;
  head.writeBigUInt64BE(BigInt(seq), 1);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(seq));
  c.setAAD(frameAad(sid, dir, head));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, body, c.getAuthTag()]);
}
// The plaintext, or null for anything that isn't exactly frame `seq` under this key.
export function open(key, sid, dir, seq, buf) {
  if (buf.length < 9 + 16 || buf[0] !== T_FRAME) return null;
  const head = buf.subarray(0, 9);
  if (head.readBigUInt64BE(1) !== BigInt(seq)) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(seq));
    d.setAAD(frameAad(sid, dir, head));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(9, buf.length - 16)), d.final()]);
  } catch { return null; }
}
const hs = obj => Buffer.concat([Buffer.from([T_HS]), utf8(JSON.stringify(obj))]);

// The Mac's half of the protocol, for every channel (one per browser tab) the relay
// opens. No sockets in here: `send(ch, bytes)` and `kick(ch, why)` go to the relay,
// and `call({method, path, body, session})` is src/web.mjs's api().
// admit(ch, hash): tell the relay a pairing tab is now a paired one (after its token's hash is registered).
export function macPeer({ k = keys(), send, kick, call, admit = () => {}, clock = now }) {
  const chans = new Map();
  const drop = (ch, why) => { clearTimeout(chans.get(ch)?.timer); chans.delete(ch); kick(ch, why); };
  // Errors before a session exists are unauthenticated hints for the page, nothing more.
  const refuse = (ch, code) => { send(ch, hs({ t: 'err', code })); drop(ch, code); };

  function opened(ch) {
    if (chans.size >= MAX_CHANNELS) {
      const oldest = [...chans.keys()][0];
      drop(oldest, 'too many tabs');
    }
    const timer = setTimeout(() => chans.get(ch)?.stage !== 'ready' && drop(ch, 'handshake took too long'), HANDSHAKE_TIME);
    timer.unref?.();
    chans.set(ch, { stage: 'new', at: clock(), timer });
  }

  function pair1(ch, m) {
    const pid = unb64u(m.pid, 16), d = unb64u(m.d, 32), nb = unb64u(m.nb, 32), sig = unb64u(m.sig, 64), mac = unb64u(m.mac, 32), box = unb64u(m.name, BOX_LEN);
    if (!pid || !d || !nb || !sig || !mac || !box) return refuse(ch, 'bad-pair');
    const t1 = tx('dibs-pair1-v1', k.mid, pid, d, nb, box);
    let name, rth;
    // Look up, check and spend under one lock, so a link can't pair twice.
    const r = locked(w => {
      const p = w.pairs.find(x => x.pid === b64u(pid) && x.exp > clock());
      if (!p) return { err: 'pair-expired' };
      if (!sameBytes(hmac(unb64u(p.key, 32), t1, sig), mac)) {
        if (++p.fails >= PAIR_FAILS) w.pairs = w.pairs.filter(x => x !== p);
        return { err: 'bad-pair' };
      }
      let devKey;
      try { devKey = okp('Ed25519', d); } catch { return { err: 'bad-pair' }; }
      if (!crypto.verify(null, t1, devKey, sig)) return { err: 'bad-pair' };
      const opened = openBox(unb64u(p.nk, 32), box);
      if (!opened) return { err: 'bad-pair' };
      name = cleanName(opened.name);
      rth = tokenHash(opened.rt);
      w.pairs = w.pairs.filter(x => x !== p);
      const did = b64u(crypto.randomBytes(16));
      w.devices[did] = { pub: b64u(d), name, rth, created: clock(), ...(p.act === true ? { act: true } : {}) };
      return { did, key: unb64u(p.key, 32) };
    });
    if (r.err) return refuse(ch, r.err);
    const nm = crypto.randomBytes(32);
    const t2 = tx('dibs-pair2-v1', k.mid, pid, d, nb, box, k.idPub, nm, utf8(r.did));
    const s2 = crypto.sign(null, t2, k.identity);
    send(ch, hs({ t: 'pair2', m: b64u(k.idPub), nm: b64u(nm), did: r.did, sig: b64u(s2), mac: b64u(hmac(r.key, t2, s2)) }));
    // The relay lets this tab stay once it knows the new token's hash.
    admit(ch, rth);
    log(`relay: paired ${name} (${r.did.slice(0, 8)})`);
  }

  function hello1(ch, c, m) {
    const eb = unb64u(m.eb, 32), nb = unb64u(m.nb, 32);
    const ds = load().devices;
    const dev = typeof m.did === 'string' && Object.hasOwn(ds, m.did) ? ds[m.did] : null;
    if (!eb || !nb) return refuse(ch, 'bad-hello');
    if (!dev) return refuse(ch, 'unpaired');
    const D = unb64u(dev.pub, 32);
    const eph = crypto.generateKeyPairSync('x25519');
    const em = rawPub(eph.publicKey), nm = crypto.randomBytes(32);
    let ss;
    try { ss = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: okp('X25519', eb) }); } catch { return refuse(ch, 'bad-hello'); }
    // A low-order point gives all zeros: an attacker's attempt to fix the secret.
    if (sameBytes(ss, ZERO)) return refuse(ch, 'bad-hello');
    const th = tx('dibs-hs-v1', k.mid, utf8(m.did), D, eb, nb, k.idPub, em, nm);
    const sigM = crypto.sign(null, tx('dibs-hs2-v1', th), k.identity);
    Object.assign(c, { stage: 'hello', did: m.did, D, ss, th, sigM });
    send(ch, hs({ t: 'hello2', em: b64u(em), nm: b64u(nm), sig: b64u(sigM) }));
  }

  function hello3(ch, c, m) {
    const sigD = unb64u(m.sig, 64);
    if (!sigD || !crypto.verify(null, tx('dibs-hs3-v1', c.th, c.sigM), okp('Ed25519', c.D), sigD)) return drop(ch, 'device signature failed');
    // Revoked between hello1 and now: no session.
    if (load().devices[c.did]?.pub !== b64u(c.D)) return drop(ch, 'unpaired');
    const salt = sha(tx('dibs-hs-keys-v1', c.th, c.sigM, sigD));
    Object.assign(c, {
      stage: 'ready', kIn: hkdf(c.ss, salt, 'dibs-relay-v1 key b2m', 32), kOut: hkdf(c.ss, salt, 'dibs-relay-v1 key m2b', 32),
      sid: hkdf(c.ss, salt, 'dibs-relay-v1 sid', 32), seqIn: 0, seqOut: 0, began: clock(), ss: null, th: null,
    });
    try { locked(w => { if (w.devices[c.did]) w.devices[c.did].seen = clock(); }); } catch {}
    // Key confirmation: the page waits for this before it sends a call.
    out(ch, c, { t: 'ready' });
  }

  function out(ch, c, obj) {
    const p = pad(obj) || pad({ t: 'res', id: obj.id, status: 500, json: { error: 'the answer was too big to send through the relay' } });
    send(ch, seal(c.kOut, c.sid, DIR_M2B, c.seqOut++, p));
  }

  async function frame(ch, c, buf) {
    if (buf.length > 9 + MAX_REQUEST + 16) return drop(ch, 'request frame too big');
    const p = open(c.kIn, c.sid, DIR_B2M, c.seqIn, buf);
    if (!p || p.length > MAX_REQUEST) return drop(ch, 'a frame failed to decrypt, or came out of order');
    c.seqIn++;
    const m = unpad(p);
    if (!m || m.t !== 'req' || !Number.isSafeInteger(m.id)) return drop(ch, 'malformed request');
    if (clock() - c.began > SESSION_LIFE) return drop(ch, 'session too old; reconnecting makes new keys');
    const dev = load().devices[c.did];
    if (!dev || dev.pub !== b64u(c.D)) return drop(ch, 'unpaired');
    let res;
    // The route as api() will see it (src/web.mjs parses it the same way), so /api/x/../hook is /api/hook here too.
    let route = null;
    try { if (typeof m.path === 'string' && m.path.startsWith('/api/') && m.path.length <= 512) route = new URL(m.path, 'http://dibs').pathname; } catch {}
    const refused = route && remoteAccess(m.method, route, dev.act === true);
    if (!METHODS.includes(m.method) || !route?.startsWith('/api/')) res = { status: 400, json: { error: 'not an API call' } };
    else if (refused) res = { status: 403, json: { error: refused === 'look' ? lookOnlyText(c.did) : LOCAL_ONLY_TEXT } };
    else {
      let timer;
      try {
        res = await Promise.race([
          call({ method: m.method, path: m.path, body: m.body ?? null, session: { kind: 'remote', device: c.did, name: dev.name, act: dev.act === true } }),
          new Promise(r => { timer = setTimeout(() => r({ status: 504, json: { error: 'dibs took too long to answer' } }), CALL_TIME); }),
        ]);
      } catch (e) { res = { status: e.status || 500, json: { error: e.status ? e.message : 'dibs hit a bug answering that' } }; }
      clearTimeout(timer);
    }
    // The channel may have closed while api() worked.
    if (chans.get(ch) === c) out(ch, c, { t: 'res', id: m.id, status: res.status, json: res.json ?? null });
  }

  function data(ch, buf) {
    const c = chans.get(ch);
    if (!c) return;
    if (buf[0] === T_FRAME) return c.stage === 'ready' ? frame(ch, c, buf) : drop(ch, 'frame before handshake');
    if (buf[0] !== T_HS || buf.length > 8192) return drop(ch, 'malformed');
    let m;
    try { m = JSON.parse(buf.subarray(1).toString('utf8')); } catch { return drop(ch, 'malformed'); }
    if (c.stage === 'new' && m?.t === 'pair1') { c.stage = 'paired'; return pair1(ch, m); }
    if ((c.stage === 'new' || c.stage === 'paired') && m?.t === 'hello1') return hello1(ch, c, m);
    if (c.stage === 'hello' && m?.t === 'hello3') return hello3(ch, c, m);
    drop(ch, 'unexpected handshake message');
  }

  return {
    open: opened,
    data,
    gone: ch => { clearTimeout(chans.get(ch)?.timer); chans.delete(ch); },
    // After a revoke: sessions of devices no longer paired end now, not on their next call.
    sweep() { const d = load().devices; for (const [ch, c] of chans) if (c.did && d[c.did]?.pub !== b64u(c.D)) drop(ch, 'unpaired'); },
    closeAll() { for (const ch of [...chans.keys()]) drop(ch, 'Mac going offline'); },
    get size() { return chans.size; },
  };
}

// What the relay needs to know whom to let in: the hashes of paired browsers' relay tokens
// (the newest MAX_HASHES), the hashes of open links' pairing tickets, and, while remote MCP
// is on, the index hashes of live sign-in codes, so https://mcp.dibs.cc can route a code here.
export function relayTokens(w = load(), t = now()) {
  const h = Object.values(w.devices).filter(d => typeof d.rth === 'string').sort((a, b) => (b.seen || b.created) - (a.seen || a.created)).slice(0, MAX_HASHES).map(d => d.rth);
  return { t: 'tokens', h, p: w.pairs.filter(p => p.exp > t && typeof p.th === 'string').map(p => p.th), c: w.mcp ? mcpCodes().slice(-MAX_CODES) : [] };
}

function status(state, extra = {}) {
  try {
    const tmp = `${STATUS}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ state, since: now(), pid: process.pid, ...extra }));
    fs.renameSync(tmp, STATUS);
  } catch {}
}

// One line for `dibs service status relay`.
export function statusLine() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
    if (!makeAlive([s.pid])(s.pid)) return 'not running';
    return `${s.state} ${dur(now() - s.since)}${s.state === 'connected' ? ` to ${s.url}` : s.error ? ` (${s.error})` : ''}, ${devices().length} device${devices().length === 1 ? '' : 's'} paired, ${mcpLine()}`;
  } catch { return null; }
}
// The one to give an MCP client. https://mcp.dibs.cc/<machine id>/mcp works too.
const mcpUrl = () => `${MCP_ORIGIN}/mcp`;
const mcpLine = () => (load().mcp ? `remote MCP on at ${mcpUrl()}` : 'remote MCP off (dibs relay mcp on)');

// What a forwarded MCP request may carry in, and its answer out. Nothing else crosses.
const MCP_IN = ['content-type', 'authorization', 'origin', 'accept', 'mcp-protocol-version'];
const MCP_OUT = ['Content-Type', 'WWW-Authenticate', 'Allow'];
const MCP_BODY_MAX = 64 * 1024;
// The whole http-res message, after JSON: under the relay's 4 MiB socket limit with room to
// spare, so a big answer is a 502 for that request, never a closed connection for everyone.
const MCP_ANSWER_MAX = 3.5 * 1024 * 1024;
// The message carrying an answer back, or a 502 in its place when it would be too big to send.
export function httpRes(id, r) {
  const msg = JSON.stringify({ t: 'http-res', id, ...r });
  return Buffer.byteLength(msg) > MCP_ANSWER_MAX ? JSON.stringify({ t: 'http-res', id, ...offJson(502) }) : msg;
}
const offJson = status => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not here' }) });

// One request the relay forwarded from mcp.dibs.cc: answered by src/web.mjs's own MCP and
// sign-in, only while the person has remote MCP on, read fresh each time so `off` is immediate.
const mcpHandles = {};
export async function mcpAnswer(m, k = keys()) {
  if (!load().mcp) return offJson(404);
  if (!['GET', 'POST'].includes(m.method) || typeof m.path !== 'string' || !m.path.startsWith('/') || m.path.length > 2048) return offJson(400);
  const body = typeof m.body === 'string' ? m.body : '';
  if (Buffer.byteLength(body) > MCP_BODY_MAX) return offJson(413);
  const headers = {};
  for (const h of MCP_IN) if (typeof m.headers?.[h] === 'string' && m.headers[h].length <= 4096) headers[h] = m.headers[h];
  // bare: sent to https://mcp.dibs.cc itself and routed here by code or token tag.
  const bare = m.bare === true;
  mcpHandles[bare] ||= remoteMcp(k.mid, MCP_ORIGIN, bare);
  const ip = typeof m.ip === 'string' ? m.ip.slice(0, 64) : 'unknown';
  const r = await mcpHandles[bare]({ method: m.method, path: m.path, headers, body, ip });
  const out = {};
  for (const h of MCP_OUT) if (r.headers[h] != null) out[h] = String(r.headers[h]);
  return { status: r.status, headers: out, body: r.body };
}

function relayUrl(u) {
  let x;
  try { x = new URL(u); } catch { die(`${u} isn't a URL. dibs relay [--url wss://app.dibs.cc]`); }
  // ws:// only to this machine (the local test relay): elsewhere the relay's own
  // authentication would travel in the clear. The frames are end-to-end encrypted either way.
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
  if (!(x.protocol === 'wss:' || (x.protocol === 'ws:' && local))) die(`the relay has to be wss:// (ws:// only on this machine), not ${u}`);
  return x;
}

// dibs relay [--url wss://app.dibs.cc]: keeps one outbound connection to the relay
// up, with backoff. Off until the person turns it on (dibs service install relay).
export async function relay(args) {
  // dibs relay mcp on|off: whether MCP clients may reach this Mac through mcp.dibs.cc.
  if (args[0] === 'mcp') {
    if (args[1] !== 'on' && args[1] !== 'off') return console.log(`${mcpLine()}. dibs relay mcp on|off`);
    const on = args[1] === 'on';
    locked(w => { w.mcp = on; });
    logChange('relay mcp', { on });
    if (!on) return console.log('Remote MCP is off: requests through mcp.dibs.cc get 404. Clients signed in through it stay listed in dibs pair --list until you revoke them.');
    return console.log(`Remote MCP is on. Add ${mcpUrl()} as a connector in Claude (or any MCP client) and sign in with a code from dibs pair (12 characters while remote MCP is on).\nThe relay carries this traffic decrypted (TLS ends at Cloudflare), unlike the page. It stays read-only. Turn it off: dibs relay mcp off`);
  }
  let url = RELAY;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') url = args[++i] || die('--url needs the relay address');
    else die(`unknown ${args[i]}. dibs relay [--url ${RELAY}]`);
  }
  const base = relayUrl(url);
  await singleInstance(PIDFILE, 'dibs relay is already running');
  const k = keys();
  const { api } = await import('./web.mjs');
  log(`dibs relay: machine ${k.mid}, fingerprint ${k.fp.slice(0, 16)}...; pair a browser with dibs pair --remote`);
  let wait = BACKOFF_MIN;
  for (;;) {
    const began = now();
    const why = await connectOnce(base, k, api);
    // A connection that held a while starts the backoff over.
    if (now() - began > BACKOFF_MAX) wait = BACKOFF_MIN;
    status('reconnecting', { url: base.origin, error: why });
    log(`relay: ${why}; trying again in ${dur(wait)}`);
    await sleep(wait * (0.75 + Math.random() / 2));
    wait = Math.min(wait * 2, BACKOFF_MAX);
  }
}

// One connection, until it drops. Resolves with why.
export function connectOnce(base, k, call) {
  return new Promise(resolve => {
    const url = new URL(`/ws/m/${k.mid}`, base);
    status('connecting', { url: base.origin });
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return resolve(e.message); }
    ws.binaryType = 'arraybuffer';
    let authed = false, lastHeard = now(), done = false, sentTokens = '';
    const finish = why => { if (done) return; done = true; clearInterval(beat); clearInterval(watch); peer.closeAll(); try { ws.close(); } catch {} resolve(why); };
    // The relay's list of who may connect follows relay.json within a second: a new link opens
    // the pairing pool, a pairing adds a hash, a revoke removes one (and its open sessions end).
    const syncTokens = () => {
      if (!authed || ws.readyState !== 1) return;
      const t = JSON.stringify(relayTokens());
      if (t === sentTokens) return;
      sentTokens = t;
      ws.send(t);
      peer.sweep();
    };
    const watch = setInterval(syncTokens, TOKEN_SYNC);
    const peer = macPeer({
      k, call,
      send: (ch, buf) => ws.readyState === 1 && ws.send(Buffer.concat([Buffer.from(ch, 'base64url'), buf])),
      kick: ch => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'kick', ch })),
      admit: (ch, h) => { syncTokens(); if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'admit', ch, h })); },
    });
    const beat = setInterval(() => {
      if (now() - lastHeard > PONG_WAIT) return finish('the relay stopped answering');
      if (ws.readyState === 1) ws.send('{"t":"ping"}');
    }, PING_EVERY);
    ws.onmessage = e => {
      lastHeard = now();
      if (typeof e.data === 'string') {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'challenge' && !authed) {
          const n = unb64u(m.n, 32);
          if (!n) return finish('the relay sent a bad challenge');
          const sig = crypto.sign(null, tx('dibs-relay-auth-v1', k.mid, n, base.host), k.relay);
          return ws.send(JSON.stringify({ t: 'auth', pub: b64u(k.relayPub), sig: b64u(sig) }));
        }
        if (m.t === 'ok') { authed = true; syncTokens(); status('connected', { url: base.origin }); return log(`relay: connected to ${base.origin}`); }
        if (!authed) return;
        if (m.t === 'http' && typeof m.id === 'string') {
          return mcpAnswer(m, k).catch(() => offJson(500)).then(r => { if (ws.readyState === 1) ws.send(httpRes(m.id, r)); });
        }
        if (m.t === 'open' && unb64u(m.ch, 16)) return peer.open(m.ch);
        if (m.t === 'gone' && unb64u(m.ch, 16)) return peer.gone(m.ch);
        return;
      }
      if (!authed) return;
      const b = Buffer.from(e.data);
      if (b.length < 17) return;
      peer.data(b64u(b.subarray(0, 16)), b.subarray(16));
    };
    ws.onclose = e => finish(e.code === 4401 ? 'the relay refused this machine\'s signature' : `connection closed (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
    ws.onerror = e => finish(`couldn't reach ${base.origin}: ${e.message || e.error?.message || 'connection failed'}`);
  });
}

const ago = t => (t ? `${dur(now() - t)} ago` : 'never');

// The remote half of `dibs pair`: --remote [--allow-actions], and its rows in --list and --revoke.
export function pairRemote({ act = false } = {}) {
  const p = newPairing({ act });
  logChange('pair remote', { actions: act });
  console.log(`${render(qr(p.link))}\n${p.link}\n`);
  console.log(`Open it on the phone or browser you want to use (scan the code, or send yourself the link some private way).`);
  console.log(`One use, good for ${p.life / MIN} minutes. That browser checks it reached this Mac by its fingerprint ${p.fp.slice(0, 16)}...`);
  console.log(act ? 'It can act: boost, pause, resume and stop jobs, cap an agent, set the pace, cancel scheduled runs. Never message agents, answer their questions, or change the hook or your hours. Revoke it if the device is lost.'
    : 'It can only look. To let a browser change things too: dibs pair --remote --allow-actions');
  const s = statusLine();
  if (!s || s.startsWith('not running')) console.log(`\nThis Mac isn't connected to the relay yet. Turn it on: dibs service install relay`);
}
export function listRemote() {
  const ds = devices();
  if (load().mcp) console.log(`(${mcpLine()})`);
  for (const d of ds) console.log(`${d.id.slice(0, 8)}  remote: ${d.name}, ${d.act === true ? 'can act' : 'look only'}  paired ${new Date(d.created).toLocaleString()}, last connected ${ago(d.seen)}`);
  return ds.length;
}
