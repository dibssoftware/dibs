'use strict';
// How the dibs page reaches dibs. Loaded before app.js; app.js calls
// dibsTransport.fetchApi(method, path, body) and gets { status, json } back.
//
// At http://127.0.0.1:7421 (the page dibs web serves) that's a plain fetch with
// the session token from a code sign-in. Anywhere else (https://app.dibs.cc) it's
// the end-to-end encrypted channel to the person's Mac through the relay: this
// file holds the browser's half of the protocol src/relay.mjs speaks (described
// message by message in docs/relay.md). WebCrypto only. The device's private key
// is made non-extractable and kept in IndexedDB, so even this page's own script
// can use it but never read it out.
(function (root) {
  const subtle = root.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const T_HS = 1, T_FRAME = 2, DIR_B2M = 1, DIR_M2B = 2;
  const BUCKETS = [1024, 4096, 16384, 65536, 262144, 1048576, 4194304];
  const MAX_REQUEST = 65536;
  // Device names are padded to this many bytes before they're encrypted (src/relay.mjs NAME_PAD).
  const NAME_PAD = 64;
  // A call the Mac hasn't answered by then fails, so the page can say so.
  const CALL_TIME = 35e3;
  const BACKOFF_MIN = 1000, BACKOFF_MAX = 30e3;
  const PING_EVERY = 25e3;
  // Tries for a link the relay says no pairing is open for (it may not have heard of it yet).
  const PAIR_TRIES = 4;
  // Waiting for the Mac and the whole handshake together.
  const HANDSHAKE_TIME = 30e3;

  const b64u = b => {
    let s = '';
    for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  // Strict: the base64url alphabet, exactly `len` bytes, and it re-encodes the same, or null.
  function unb64u(s, len) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    let bin;
    try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); } catch { return null; }
    const b = Uint8Array.from(bin, c => c.charCodeAt(0));
    return b64u(b) === s && (len == null || b.length === len) ? b : null;
  }
  const bytes = x => (typeof x === 'string' ? enc.encode(x) : new Uint8Array(x));
  function cat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
  // Same encoding as src/relay.mjs tx(): a label, then every field length-prefixed.
  const tx = (label, ...fields) => cat(...[label, ...fields].flatMap(f => { const b = bytes(f); return [u32(b.length), b]; }));
  const sha = async b => new Uint8Array(await subtle.digest('SHA-256', b));
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const random = n => root.crypto.getRandomValues(new Uint8Array(n));
  const fingerprint = async idPub => b64u(await sha(cat(enc.encode('dibs-fp-v1\0'), idPub)));
  async function hkdfKey(ikm) { return subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']); }
  const hkdfParams = (salt, info) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) });
  const edPub = raw => subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  const sign = async (priv, data) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, priv, data));
  const fail = (code, msg) => Object.assign(new Error(msg), { code });
  // Errors the Mac sends before a session exists. They're unauthenticated, so the relay
  // could write them: only these codes are believed, and only these words are shown.
  const ERR_CODES = ['unpaired', 'pair-expired', 'bad-pair', 'bad-hello'];
  const SAID = { unpaired: 'the Mac says this browser isn\'t paired', 'pair-expired': 'the link was used or has expired',
    'bad-pair': 'the Mac refused the pairing', 'bad-hello': 'the Mac refused the handshake', error: 'the Mac refused the connection' };
  // What the person reads about a failed connection, by code. Nothing here comes from
  // the relay: not a close reason, not an error text, so a relay can't put words on the page.
  const SHOWN = {
    unpaired: 'The Mac says this browser isn\'t paired (or was signed out). Run dibs pair --remote for a new link.',
    impostor: 'Something between this browser and your Mac failed a security check, so the connection was dropped. Nothing was sent.',
    tampered: 'Something between this browser and your Mac failed a security check, so the connection was dropped. Nothing was sent.',
    offline: 'Your Mac isn\'t connected to the relay. Is dibs relay running? (dibs service status)',
    timeout: 'Your Mac took too long to answer. Trying again.',
  };
  const shown = e => SHOWN[e?.code] || 'Connecting to your Mac.';

  function pad(obj) {
    const j = enc.encode(JSON.stringify(obj));
    const size = BUCKETS.find(b => b >= j.length + 4);
    if (!size || size > MAX_REQUEST) return null;
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, j.length);
    out.set(j, 4);
    return out;
  }
  function unpad(b) {
    if (b.length < 4 || !BUCKETS.includes(b.length)) return null;
    const n = new DataView(b.buffer, b.byteOffset).getUint32(0);
    if (n > b.length - 4) return null;
    try { return JSON.parse(dec.decode(b.subarray(4, 4 + n))); } catch { return null; }
  }
  const hs = obj => cat(Uint8Array.of(T_HS), enc.encode(JSON.stringify(obj)));
  function readHs(b) {
    if (b[0] !== T_HS) throw fail('protocol', 'expected a handshake message');
    let m;
    try { m = JSON.parse(dec.decode(b.subarray(1))); } catch { throw fail('protocol', 'malformed handshake message'); }
    // Unauthenticated: the relay could have written it. A hint for the person, never a reason to forget keys.
    if (m && m.t === 'err') { const code = ERR_CODES.includes(m.code) ? m.code : 'error'; throw fail(code, SAID[code]); }
    return m;
  }

  const nonce = seq => { const n = new Uint8Array(12); new DataView(n.buffer).setBigUint64(4, BigInt(seq)); return n; };
  const head = seq => { const h = new Uint8Array(9); h[0] = T_FRAME; new DataView(h.buffer).setBigUint64(1, BigInt(seq)); return h; };
  const aad = (sid, dir, h) => cat(enc.encode('dibs-frame-v1'), sid, Uint8Array.of(dir), h);

  // What admits a pairing tab at the relay (src/relay.mjs pairTicket): only the link's holder can derive it.
  const pairTicket = async link => b64u(await subtle.deriveBits(hkdfParams(new Uint8Array(0), 'dibs-relay-v1 pair ticket'), await hkdfKey(link.secret), 256));

  // The link `dibs pair --remote` prints: #p=<machine id>.<secret>.<fingerprint>.
  function parseLink(hash) {
    const m = /^#p=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(hash || '');
    if (!m) return null;
    const secret = unb64u(m[2], 32);
    return secret && unb64u(m[1], 16) && unb64u(m[3], 32) ? { mid: m[1], secret, fp: m[3] } : null;
  }

  // chan: { send(Uint8Array), recv(): Promise<Uint8Array>, close(why) }, one browser
  // tab's connection to the Mac through the relay. store: get(mid), put(record), all().
  // keys: a device key pair to pair with instead of a new one (a dibs account's, from its keyring).
  async function pair(chan, link, name, store, keys = null) {
    const secretKey = await hkdfKey(link.secret);
    const pid = new Uint8Array(await subtle.deriveBits(hkdfParams(new Uint8Array(0), 'dibs-relay-v1 pair id'), secretKey, 128));
    const macKey = await subtle.deriveKey(hkdfParams(new Uint8Array(0), 'dibs-relay-v1 pair key'), secretKey, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    const nameKey = await subtle.deriveKey(hkdfParams(new Uint8Array(0), 'dibs-relay-v1 pair name'), secretKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    // The name goes encrypted and padded, so the relay learns neither it nor its length. With it,
    // this browser's relay token: the relay admits this browser's tabs by it, and only ever
    // gets its hash from the Mac.
    const rt = random(32);
    const namePlain = new Uint8Array(NAME_PAD + 32);
    namePlain.set(enc.encode(name).subarray(0, NAME_PAD));
    namePlain.set(rt, NAME_PAD);
    const nameIv = random(12);
    const box = cat(nameIv, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nameIv, additionalData: enc.encode('dibs-pair-name-v1'), tagLength: 128 }, nameKey, namePlain)));
    keys ||= await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const d = new Uint8Array(await subtle.exportKey('raw', keys.publicKey));
    const nb = random(32);
    const t1 = tx('dibs-pair1-v1', link.mid, pid, d, nb, box);
    const s1 = await sign(keys.privateKey, t1);
    const mac1 = new Uint8Array(await subtle.sign('HMAC', macKey, cat(t1, s1)));
    chan.send(hs({ t: 'pair1', pid: b64u(pid), d: b64u(d), nb: b64u(nb), name: b64u(box), sig: b64u(s1), mac: b64u(mac1) }));

    const m = readHs(await chan.recv());
    const M = unb64u(m.m, 32), nm = unb64u(m.nm, 32), s2 = unb64u(m.sig, 64), mac2 = unb64u(m.mac, 32);
    if (m.t !== 'pair2' || !M || !nm || !s2 || !mac2 || typeof m.did !== 'string' || !unb64u(m.did, 16)) throw fail('protocol', 'malformed pairing answer');
    // The key that answered must be the one the link named, or someone in between swapped it.
    if (await fingerprint(M) !== link.fp) throw fail('impostor', 'the key that answered is not the Mac in the link');
    const t2 = tx('dibs-pair2-v1', link.mid, pid, d, nb, box, M, nm, m.did);
    if (!await subtle.verify('HMAC', macKey, mac2, cat(t2, s2))) throw fail('impostor', 'the pairing answer failed its check');
    if (!await subtle.verify({ name: 'Ed25519' }, await edPub(M), s2, t2)) throw fail('impostor', 'the Mac\'s signature failed');
    const record = { mid: link.mid, m: b64u(M), fp: link.fp, did: m.did, keys, rt: b64u(rt), name, paired: Date.now() };
    await store.put(record);
    return record;
  }

  // A session over chan for a paired record. Resolves once the Mac has proved it holds the keys.
  async function open(chan, record) {
    const M = unb64u(record.m, 32);
    if (!M || await fingerprint(M) !== record.fp) throw fail('impostor', 'the stored Mac key doesn\'t match its fingerprint');
    const D = new Uint8Array(await subtle.exportKey('raw', record.keys.publicKey));
    const eph = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const eb = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const nb = random(32);
    chan.send(hs({ t: 'hello1', did: record.did, eb: b64u(eb), nb: b64u(nb) }));

    const m = readHs(await chan.recv());
    const em = unb64u(m.em, 32), nm = unb64u(m.nm, 32), sigM = unb64u(m.sig, 64);
    if (m.t !== 'hello2' || !em || !nm || !sigM) throw fail('protocol', 'malformed handshake answer');
    const th = tx('dibs-hs-v1', record.mid, record.did, D, eb, nb, M, em, nm);
    if (!await subtle.verify({ name: 'Ed25519' }, await edPub(M), sigM, tx('dibs-hs2-v1', th))) throw fail('impostor', 'the Mac\'s handshake signature failed');
    let ss;
    try {
      const peer = await subtle.importKey('raw', em, { name: 'X25519' }, false, []);
      ss = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peer }, eph.privateKey, 256));
    } catch { throw fail('impostor', 'the Mac\'s ephemeral key is unusable'); }
    if (ss.every(x => x === 0)) throw fail('impostor', 'the Mac\'s ephemeral key is unusable');
    const sigD = await sign(record.keys.privateKey, tx('dibs-hs3-v1', th, sigM));
    chan.send(hs({ t: 'hello3', sig: b64u(sigD) }));

    const salt = await sha(tx('dibs-hs-keys-v1', th, sigM, sigD));
    const ikm = await hkdfKey(ss);
    const aes = (info, use) => subtle.deriveKey(hkdfParams(salt, info), ikm, { name: 'AES-GCM', length: 256 }, false, [use]);
    const kOut = await aes('dibs-relay-v1 key b2m', 'encrypt'), kIn = await aes('dibs-relay-v1 key m2b', 'decrypt');
    const sid = new Uint8Array(await subtle.deriveBits(hkdfParams(salt, 'dibs-relay-v1 sid'), ikm, 256));
    let seqOut = 0, seqIn = 0, dead = null, nextId = 1;
    const pending = new Map();

    async function readFrame(b) {
      if (b.length < 25 || b[0] !== T_FRAME) throw fail('tampered', 'not an encrypted frame');
      const h = b.subarray(0, 9);
      if (new DataView(h.buffer, h.byteOffset).getBigUint64(1) !== BigInt(seqIn)) throw fail('tampered', 'a frame came out of order or twice');
      let p;
      try { p = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(seqIn), additionalData: aad(sid, DIR_M2B, h), tagLength: 128 }, kIn, b.subarray(9))); }
      catch { throw fail('tampered', 'a frame failed to decrypt'); }
      seqIn++;
      const msg = unpad(p);
      if (!msg) throw fail('tampered', 'a frame held no message');
      return msg;
    }
    // The first frame is the Mac's proof it derived the same keys.
    const first = await readFrame(await chan.recv());
    if (first.t !== 'ready') throw fail('protocol', 'the Mac didn\'t confirm the session');

    function die(e) {
      if (dead) return;
      dead = e;
      chan.close(e.message);
      for (const p of pending.values()) p.reject(e);
      pending.clear();
    }
    (async () => {
      try {
        for (;;) {
          const msg = await readFrame(await chan.recv());
          const p = msg.t === 'res' && pending.get(msg.id);
          if (p) { pending.delete(msg.id); p.resolve({ status: msg.status, json: msg.json }); }
        }
      } catch (e) { die(e); }
    })();

    // Frames go out in the order their sequence numbers were taken, whatever order encryption finishes in.
    let queue = Promise.resolve();
    function request(method, path, body) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      const plain = pad({ t: 'req', id, method, path, body: body ?? null });
      if (!plain) return Promise.reject(fail('too-big', 'that request is too big to send'));
      const seq = seqOut++;
      const h = head(seq);
      const sealed = subtle.encrypt({ name: 'AES-GCM', iv: nonce(seq), additionalData: aad(sid, DIR_B2M, h), tagLength: 128 }, kOut, plain);
      queue = queue.then(async () => { const c = new Uint8Array(await sealed); if (!dead) chan.send(cat(h, c)); });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(fail('timeout', 'the Mac didn\'t answer in time')); }, CALL_TIME);
        pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      });
    }
    return { request, close: () => die(fail('closed', 'closed')), get dead() { return dead; } };
  }

  // IndexedDB: one record per paired Mac, the device's CryptoKeyPair stored as the
  // non-extractable object itself.
  function idbStore(idb = root.indexedDB) {
    const db = new Promise((resolve, reject) => {
      const r = idb.open('dibs-relay', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('macs', { keyPath: 'mid' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const run = (mode, fn) => db.then(d => new Promise((resolve, reject) => {
      const t = d.transaction('macs', mode), req = fn(t.objectStore('macs'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    }));
    return {
      get: mid => run('readonly', s => s.get(mid)),
      put: rec => run('readwrite', s => s.put(rec)),
      all: () => run('readonly', s => s.getAll()),
      remove: mid => run('readwrite', s => s.delete(mid)),
    };
  }

  // A tab's connection through the relay as a chan: binary frames for the Mac, text for
  // the relay's own notes. `macUp` resolves once the relay says the Mac is connected.
  // first: what the tab tells the relay on opening, its relay token or a request to pair.
  function socketChan(url, WS, onMac, first) {
    const ws = new WS(url);
    ws.binaryType = 'arraybuffer';
    const inbox = [], waiters = [];
    let closed = null, up, refused = null;
    const macUp = new Promise((resolve, reject) => { up = { resolve, reject }; });
    macUp.catch(() => {});
    const shut = why => {
      if (closed) return;
      closed = refused ? Object.assign(fail(refused, SAID[refused]), { relay: true }) : fail('closed', why || 'the connection closed');
      clearInterval(ping);
      up.reject(closed);
      for (const w of waiters.splice(0)) w.reject(closed);
    };
    ws.onopen = () => ws.send(JSON.stringify(first));
    ws.onerror = () => shut('couldn\'t reach the relay');
    ws.onclose = () => shut('the connection closed');
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        // The relay turning a tab away: only these two reasons are believed, and the page shows its own words.
        if (m.t === 'refused') { refused = m.why === 'unpaired' ? 'unpaired' : m.why === 'no-pairing' ? 'pair-expired' : null; return; }
        if (m.t !== 'mac') return;
        onMac(!!m.up);
        // The Mac dropping mid-session ends the session: the next call reconnects with new keys.
        if (m.up) up.resolve(); else if (inbox.length || waiters.length || chan.started) chan.close('your Mac disconnected from the relay');
        return;
      }
      const b = new Uint8Array(e.data);
      const w = waiters.shift();
      w ? w.resolve(b) : inbox.push(b);
    };
    const ping = setInterval(() => { if (ws.readyState === 1) ws.send('{"t":"ping"}'); }, PING_EVERY);
    const chan = {
      macUp,
      started: false,
      send: b => { chan.started = true; if (!closed && ws.readyState === 1) ws.send(b); },
      recv: () => (inbox.length ? Promise.resolve(inbox.shift()) : closed ? Promise.reject(closed) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))),
      close: why => { shut(why); try { ws.close(1000); } catch {} },
    };
    return chan;
  }

  function deviceName(ua = root.navigator?.userAgent || '') {
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
  }

  // The remote transport: pairs if the page opened with a link, then keeps one
  // session up, reconnecting with backoff and fresh keys each time.
  function remote({ store = idbStore(), WS = root.WebSocket, base = root.location, link = null } = {}) {
    const listeners = new Set();
    let state = { state: 'connecting', detail: '' };
    const set = (s, detail = '') => { state = { state: s, detail }; for (const f of listeners) { try { f(state); } catch {} } };
    let session = null, connecting = null, wait = BACKOFF_MIN, macUp = null, pairTries = 0;
    const wsUrl = mid => `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/ws/b/${mid}`;

    // One attempt: wait for the Mac, pair if there's a link, run the handshake.
    async function connect() {
      // A record from before relay tokens can't get in: it pairs again.
      // ?m=<machine id> picks one Mac when this browser reaches several (a dibs account's).
      const want = new URLSearchParams(base.search || '').get('m');
      const usable = (await store.all()).filter(r => unb64u(r.rt, 32));
      const rec = link ? null : (usable.find(r => r.mid === want) || usable.sort((a, b) => b.paired - a.paired)[0]);
      if (!link && !rec) { set('unpaired'); throw fail('unpaired', 'this browser isn\'t paired with a Mac'); }
      set(link ? 'pairing' : 'connecting');
      const chan = socketChan(wsUrl(link ? link.mid : rec.mid), WS, upNow => {
        macUp = upNow;
        if (!upNow) set('offline', 'your Mac isn\'t connected to the relay. Is dibs relay running? (dibs service status)');
      }, link ? { t: 'pair', ticket: await pairTicket(link) } : { t: 'hello', rt: rec.rt });
      const timer = setTimeout(() => chan.close('the Mac took too long to answer'), HANDSHAKE_TIME);
      try {
        await chan.macUp;
        set(link ? 'pairing' : 'connecting');
        let r = rec;
        if (link) { r = await pair(chan, link, deviceName(), store); link = null; }
        session = await open(chan, r);
        clearTimeout(timer);
        wait = BACKOFF_MIN;
        set('ready');
        return session;
      } catch (e) {
        clearTimeout(timer);
        chan.close(e.message);
        // The relay hears of a new link within a second or so of dibs pair --remote; a link opened
        // faster than that is tried again a few times before it's taken as used.
        if (link && e.relay && e.code === 'pair-expired' && ++pairTries < PAIR_TRIES) set('pairing');
        else if (link && ['pair-expired', 'bad-pair', 'impostor', 'protocol'].includes(e.code)) { link = null; set('error', pairingError(e)); }
        else if (e.code === 'unpaired') set('unpaired', 'the Mac says this browser isn\'t paired (or was signed out). Run dibs pair --remote for a new link.');
        else if (e.code === 'impostor' || e.code === 'tampered') set('error', 'something between this browser and your Mac failed a security check, so the connection was dropped. Nothing was sent.');
        else if (macUp === false) set('offline', 'your Mac isn\'t connected to the relay. Is dibs relay running? (dibs service status)');
        else set('connecting', shown(e));
        throw e;
      }
    }
    const pairingError = e => (e.code === 'pair-expired' ? 'that link was already used or has expired. Run dibs pair --remote for a new one.'
      : e.code === 'impostor' ? 'the Mac that answered isn\'t the one in the link, so this browser refused it. Nothing was sent.'
        : 'pairing failed. Run dibs pair --remote for a new link.');

    // A failed attempt stays the answer for `wait`, so a page polling every few
    // seconds doesn't hammer the relay; the wait doubles up to BACKOFF_MAX.
    function ensure() {
      if (session && !session.dead) return Promise.resolve(session);
      if (!connecting) {
        connecting = connect().then(s => { connecting = null; return s; }, e => {
          const w = wait;
          wait = Math.min(wait * 2, BACKOFF_MAX);
          setTimeout(() => { connecting = null; }, w);
          throw e;
        });
        connecting.catch(() => {});
      }
      return connecting;
    }

    return {
      remote: true,
      start: () => ensure().catch(() => {}),
      async fetchApi(method, path, body) {
        const s = await ensure();
        try { return await s.request(method, path, body); }
        catch (e) { if (s.dead) session = null; throw e; }
      },
      onState(f) { listeners.add(f); f(state); return () => listeners.delete(f); },
      get state() { return state; },
      forget: async () => { for (const r of await store.all()) await store.remove(r.mid); session?.close(); session = null; set('unpaired'); },
    };
  }

  function local() {
    // The session token lives in localStorage, which belongs to this port alone (a cookie
    // would go to every server on 127.0.0.1). Private windows may refuse storage.
    const KEY = 'dibs-session';
    let memo = null;
    const token = {
      get: () => { try { return localStorage.getItem(KEY) || memo; } catch { return memo; } },
      set: v => { memo = v; try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
    };
    return {
      remote: false,
      token,
      start() {},
      async fetchApi(method, path, body) {
        const headers = { Accept: 'application/json' };
        if (token.get()) headers.Authorization = `Bearer ${token.get()}`;
        if (body != null) headers['Content-Type'] = 'application/json';
        const r = await fetch(path, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
        let json = null;
        try { json = await r.json(); } catch {}
        return { status: r.status, json };
      },
      onState(f) { f({ state: 'local', detail: '' }); return () => {}; },
      state: { state: 'local', detail: '' },
    };
  }

  const internals = { parseLink, pairTicket, pair, open, tx, b64u, unb64u, fingerprint, pad, unpad, deviceName, remote, local, socketChan, idbStore };
  if (root.document) {
    // The relay's copy of the page says so (relay/build.mjs); the one dibs web serves doesn't.
    const isLocal = root.document.querySelector('meta[name="dibs-transport"]')?.content !== 'relay';
    let link = null;
    if (!isLocal && root.location.hash.startsWith('#p=')) {
      link = parseLink(root.location.hash);
      // The secret is gone from the address bar (and so from history and any
      // screenshot) before anything else runs.
      root.history.replaceState(null, '', root.location.pathname + root.location.search);
    }
    const t = isLocal ? local() : remote({ link });
    root.dibsTransport = Object.assign(t, { _internals: internals });
    // The account page (web/account.js) uses this file's protocol but opens no session of its own.
    if (!root.document.getElementById('account')) t.start();
  } else {
    root.dibsTransport = { _internals: internals };
  }
})(globalThis);
