// dibs accounts on the relay: what's stored, for how long, and the rate limits, apart from the
// Durable Object around it (index.js Accounts) so it runs under node --test with a Map
// (test/accountbook.test.mjs). Storage: get, put, delete, list({prefix}), all async.
//
// What it keeps, and nothing else:
//   e:<email hash>   { aid }                         the account an email signs in to
//   a:<aid>          { eh, auth, creds, wrapped, members, keyring, version, since, created }
//   k:<cred id>      { aid }                         which account a passkey belongs to
//   l:<sha(token)>   { eh, exp }                     a sign-in link, 15 minutes, one use
//   s:<sha(token)>   { aid, exp, created, how }      a session, 30 days
//   u:<challenge>    { exp }                         a WebAuthn challenge already used, 5 minutes
//   r:<hour>:<what>  { n, exp }                      sign-in links sent that hour, per IP, address, both, or all
//   p:<aid>:<id>     { pub, exp, ... }               a browser waiting for a Mac to approve it, 10 minutes
// The email hash is HMAC-SHA-256 under ACCOUNT_SECRET of the trimmed, lowercased address: the
// relay can tell whether it's seen an address it's given, and can't list addresses. The keyring
// is sealed by the browser with the account key, which the relay never holds.
//
// A session says who you are; changing the account takes the account key too. An email link
// alone (a stolen inbox) signs in, but every write (the keyring, wrapped keys, member Macs,
// passkeys, ending sessions) carries a proof, HKDF(account key, 'dibs-account-auth'), whose
// SHA-256 the first keyring write stored as auth. A browser without the key can only ask a Mac.
import { b64u, unb64u, register, verify } from './webauthn.js';

export const LINK_LIFE = 15 * 60e3;
export const SESSION_LIFE = 30 * 24 * 36e5;
export const CHALLENGE_LIFE = 5 * 60e3;
export const APPROVAL_LIFE = 10 * 60e3;
// Sign-in links an hour: per address from one IP, per address from anywhere (higher, so a few
// strangers can't lock a person out), per IP, and in all. Every request counts toward all four;
// the page that asks has Turnstile in front of it (index.js emailPage), so the global cap is
// hard to spend.
export const LINKS_PER_EMAIL_IP = 3, LINKS_PER_EMAIL = 20, LINKS_PER_IP = 10, LINKS_GLOBAL = 300;
// Sign-in attempts (links redeemed, passkeys): per IP in 10 minutes.
export const SIGNINS_PER_IP = 10;
const HOUR = 36e5, TEN_MIN = 10 * 60e3;
export const MAX_KEYRING = 64 * 1024;
export const MAX_CREDS = 10, MAX_MEMBERS = 50, MAX_PENDING = 5;
// Open approval requests per session: one browser asks once (twice if it retries), so a single
// session can't hold all of an account's MAX_PENDING and keep the person's browsers waiting.
export const PENDING_PER_SESSION = 2;
// Expired entries are swept by the alarm, a batch per prefix at a time, never on a request
// (128: the most keys one storage delete takes).
export const SWEEP_BATCH = 128;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;

const enc = new TextEncoder();
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const normEmail = e => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
const err = (status, error) => Object.assign(new Error(error), { status });
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const timeBytes = t => { const b = new Uint8Array(6); for (let i = 5, n = Math.floor(t); i >= 0; i--, n = Math.floor(n / 256)) b[i] = n % 256; return b; };
// What the relay keeps of the account key's proof: its hash, so a copy of the storage can't write.
const authOf = proof => sha(`dibs-account-auth-v1\0${proof}`);

export class AccountBook {
  constructor(storage, { secret, rpId, origin, limits = {} } = {}) {
    this.s = storage;
    this.secret = secret;
    this.rp = { rpId, origin };
    this.lim = { LINKS_PER_EMAIL_IP, LINKS_PER_EMAIL, LINKS_PER_IP, LINKS_GLOBAL, SIGNINS_PER_IP, ...limits };
    this.counts = new Map();
    // Sign-in challenges in flight: so two finishes with one challenge can't both pass.
    this.inflight = new Set();
    this.cursor = {};
  }

  async emailHash(email) {
    const key = await crypto.subtle.importKey('raw', enc.encode(this.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(`dibs-email-v1\0${normEmail(email)}`)));
  }

  // In-memory counters: lost when the object sleeps, which only ever makes them more lenient.
  count(key, windowMs, t) {
    const v = (this.counts.get(key) || []).filter(x => t - x < windowMs);
    this.counts.set(key, v);
    if (this.counts.size > 50000) for (const [k, x] of this.counts) if (!x.some(y => t - y < HOUR)) this.counts.delete(k);
    return v;
  }
  allow(key, windowMs, max, t) {
    const v = this.count(key, windowMs, t);
    if (v.length >= max) return false;
    v.push(t);
    return true;
  }

  // A sign-in link for an address: the token to put in it, or a refusal. The answer is the same
  // whether or not the address has an account, so this can't be used to find out.
  async requestLink(email, ip, t = Date.now()) {
    if (!EMAIL.test(normEmail(email))) throw err(400, 'that is not an email address');
    const eh = await this.emailHash(email);
    // Counted in storage, by the clock hour, so an evicted object doesn't start over. The address
    // is in the key only as its hash, and the IP only hashed with it or alone under the secret.
    const hour = Math.floor(t / HOUR);
    const iph = (await this.emailHash(`ip\0${ip}`)).slice(0, 22);
    const caps = [
      [`r:${hour}:i:${iph}`, this.lim.LINKS_PER_IP, 'Too many sign-in links from here. Try again in an hour.'],
      [`r:${hour}:g`, this.lim.LINKS_GLOBAL, 'dibs is sending a lot of sign-in links right now. Try again in a few minutes, or sign in with a passkey.'],
      [`r:${hour}:e:${eh}`, this.lim.LINKS_PER_EMAIL, 'A lot of sign-in links went to that address in the last hour. Use the newest one, or try again later.'],
      [`r:${hour}:ei:${eh}:${iph}`, this.lim.LINKS_PER_EMAIL_IP, 'A few sign-in links already went to that address in the last hour. Use the newest one, or try again later.'],
    ];
    const now = await Promise.all(caps.map(([key]) => this.s.get(key)));
    const full = caps.findIndex(([, max], i) => (now[i]?.n || 0) >= max);
    if (full >= 0) throw err(429, caps[full][2]);
    for (const [i, [key]] of caps.entries()) await this.s.put(key, { n: (now[i]?.n || 0) + 1, exp: (hour + 2) * HOUR });
    const token = rand(32);
    await this.s.put(`l:${await sha(token)}`, { eh, exp: t + LINK_LIFE });
    return token;
  }

  // The link's token, once: a session for its account (made on first sign-in).
  async redeemLink(token, ip, t = Date.now()) {
    if (!this.allow(`si:${ip}`, TEN_MIN, this.lim.SIGNINS_PER_IP, t)) throw err(429, 'Too many sign-in tries from here. Wait ten minutes.');
    const key = `l:${await sha(String(token))}`;
    const l = await this.s.get(key);
    if (!l || l.exp <= t) throw err(401, 'That sign-in link was already used or has expired. Ask for a new one.');
    await this.s.delete(key);
    let e = await this.s.get(`e:${l.eh}`), created = false;
    if (!e) {
      e = { aid: rand(16) };
      await this.s.put(`e:${l.eh}`, e);
      await this.s.put(`a:${e.aid}`, { eh: l.eh, creds: [], wrapped: {}, members: [], keyring: null, version: 0, created: t });
      created = true;
    }
    return { ...(await this.session(e.aid, 'email', t)), created };
  }

  async session(aid, how, t) {
    const token = rand(32);
    await this.s.put(`s:${await sha(token)}`, { aid, exp: t + SESSION_LIFE, created: t, how });
    return { session: token, aid, expires: t + SESSION_LIFE };
  }

  async account(session, t = Date.now()) {
    const s = typeof session === 'string' && session ? await this.s.get(`s:${await sha(session)}`) : null;
    if (!s || s.exp <= t) throw err(401, 'Sign in again: that session ended.');
    const a = await this.s.get(`a:${s.aid}`);
    // A session outlives nothing it signed in to: when the account is gone, so is the session.
    if (!a) { await this.s.delete(`s:${await sha(session)}`); throw err(401, 'That account is gone.'); }
    if (s.created <= (a.since || 0)) throw err(401, 'Sign in again: every session of this account was ended.');
    return { aid: s.aid, a };
  }
  // The account, for a write: the session and the proof that this browser holds the account key.
  async owner(session, proof, t) {
    const { aid, a } = await this.account(session, t);
    if (!a.auth) throw err(403, 'This account has no keyring yet. Open app.dibs.cc/account in the browser that made it.');
    if (typeof proof !== 'string' || !B64_32.test(proof) || await authOf(proof) !== a.auth) throw err(403, 'Only a browser that holds the account key can change the account. Get it from one of your Macs first.');
    return { aid, a };
  }

  async signOut(session) { if (typeof session === 'string') await this.s.delete(`s:${await sha(session)}`); }
  // Every session of the account ends, this one's too; the browser that asked gets a new one.
  async endSessions(session, proof, t = Date.now()) {
    const { aid, a } = await this.owner(session, proof, t);
    a.since = t;
    await this.s.put(`a:${aid}`, a);
    return this.session(aid, 'renewed', t + 1);
  }

  // WebAuthn challenges are stateless: the time, 16 random bytes and an HMAC under ACCOUNT_SECRET
  // binding them to the kind and account. Nothing is stored until one is used, and then only
  // after the passkey checked out (or, to add one, the account key was proved), so asking for
  // challenges costs the relay nothing.
  async challengeMac(kind, aid, body) {
    const key = await crypto.subtle.importKey('raw', enc.encode(`dibs-challenge-v1\0${this.secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, cat(enc.encode(`${kind}\0${aid || ''}\0`), body))).subarray(0, 16);
  }
  async challenge(aid, kind, t) {
    const body = cat(timeBytes(t), crypto.getRandomValues(new Uint8Array(16)));
    return b64u(cat(body, await this.challengeMac(kind, aid, body)));
  }
  async takeChallenge(c, kind, aid, t) {
    const b = typeof c === 'string' && c.length === 51 ? unb64u(c) : null;
    const expired = err(400, 'That passkey request expired. Try again.');
    if (!b || b.length !== 38) throw expired;
    const at = b.subarray(0, 6).reduce((n, x) => n * 256 + x, 0);
    if (at > t + 60e3 || at + CHALLENGE_LIFE <= t) throw expired;
    const mac = await this.challengeMac(kind, aid, b.subarray(0, 22));
    if (mac.reduce((d, x, i) => d | (x ^ b[22 + i]), 0) !== 0) throw expired;
    if (this.inflight.has(c) || await this.s.get(`u:${c}`)) throw expired;
    return { at };
  }
  async usedChallenge(c, at) { await this.s.put(`u:${c}`, { exp: at + CHALLENGE_LIFE }); }

  // Passkeys: an account adds one with its key; anyone signs in with one. User verification
  // (the device's PIN or biometrics) is required: a passkey that opens the account key must
  // not open it for whoever picks up the unlocked device.
  async passkeyBegin(session, proof, t = Date.now()) {
    const { aid, a } = await this.owner(session, proof, t);
    if (a.creds.length >= MAX_CREDS) throw err(409, `An account keeps at most ${MAX_CREDS} passkeys. Remove one first.`);
    return { challenge: await this.challenge(aid, 'reg', t), user: aid, exclude: a.creds.map(c => c.id) };
  }
  async passkeyFinish(session, proof, challenge, response, label, t = Date.now()) {
    const { aid, a } = await this.owner(session, proof, t);
    const c = await this.takeChallenge(challenge, 'reg', aid, t);
    await this.usedChallenge(challenge, c.at);
    const cred = await register(response, { ...this.rp, challenge });
    if (!cred.uv) throw err(400, 'That passkey didn\'t verify you (a PIN, Touch ID or Face ID). Try again with one that does.');
    if (a.creds.length >= MAX_CREDS) throw err(409, `An account keeps at most ${MAX_CREDS} passkeys. Remove one first.`);
    if (await this.s.get(`k:${cred.id}`)) throw err(409, 'That passkey is already on an account.');
    a.creds.push({ id: cred.id, jwk: cred.jwk, signCount: cred.signCount, label: String(label || 'a passkey').slice(0, 60), created: t });
    await this.s.put(`a:${aid}`, a);
    await this.s.put(`k:${cred.id}`, { aid });
    return { id: cred.id };
  }
  async removePasskey(session, proof, id, t = Date.now()) {
    const { aid, a } = await this.owner(session, proof, t);
    if (!a.creds.some(c => c.id === id)) throw err(404, 'That passkey isn\'t on this account.');
    a.creds = a.creds.filter(c => c.id !== id);
    delete a.wrapped[id];
    await this.s.put(`a:${aid}`, a);
    await this.s.delete(`k:${id}`);
    return { ok: true };
  }
  async signInBegin(t = Date.now()) { return { challenge: await this.challenge(null, 'login', t) }; }
  async signInFinish(challenge, credId, response, ip, t = Date.now()) {
    if (!this.allow(`si:${ip}`, TEN_MIN, this.lim.SIGNINS_PER_IP, t)) throw err(429, 'Too many sign-in tries from here. Wait ten minutes.');
    const c = await this.takeChallenge(challenge, 'login', null, t);
    this.inflight.add(challenge);
    try {
      const k = typeof credId === 'string' ? await this.s.get(`k:${credId}`) : null;
      const a = k && await this.s.get(`a:${k.aid}`);
      const cred = a?.creds.find(x => x.id === credId);
      if (!cred) throw err(401, 'That passkey isn\'t on a dibs account.');
      let r;
      try { r = await verify(response, cred, { ...this.rp, challenge }); } catch (e) { throw err(401, `That passkey didn't check out: ${e.message}.`); }
      await this.usedChallenge(challenge, c.at);
      cred.signCount = r.signCount;
      cred.used = t;
      await this.s.put(`a:${k.aid}`, a);
      // The wrapped account key only to a sign-in that verified the person, not just a touch.
      return { ...(await this.session(k.aid, 'passkey', t)), wrapped: r.uv ? a.wrapped[credId] || null : null };
    } finally { this.inflight.delete(challenge); }
  }

  // The sealed keyring, and the account key wrapped under each passkey's PRF output. version is
  // for the browser: a put that names a stale version is refused, so two browsers don't overwrite
  // each other's machines.
  async keyring(session, t = Date.now()) {
    const { a } = await this.account(session, t);
    return { keyring: a.keyring, version: a.version, passkeys: a.creds.map(c => ({ id: c.id, label: c.label, created: c.created, prf: !!a.wrapped[c.id] })) };
  }
  // The first write sets the proof every later one must carry: the browser that made the account
  // writes its keyring at once, before the account is any use to anyone. Only an account that has
  // never had a keyring takes a first proof; one that got a keyring before proofs existed
  // (before 2026-11-02 23:00) takes none, so nobody can claim it by writing first.
  async putKeyring(session, { keyring, version, wrapped, proof }, t = Date.now()) {
    let { aid, a } = await this.account(session, t);
    if (a.auth) ({ aid, a } = await this.owner(session, proof, t));
    else if (a.keyring !== null || a.version !== 0) throw err(403, 'This account was made before dibs accounts could check the account key, and can\'t be changed. Sign in with another address to start a new one.');
    else if (typeof proof !== 'string' || !B64_32.test(proof)) throw err(400, 'the first keyring comes with the account key\'s proof');
    if (typeof keyring !== 'string' || keyring.length > MAX_KEYRING || !unb64u(keyring)) throw err(400, `a keyring is base64url, at most ${MAX_KEYRING} characters`);
    if (version !== a.version) throw err(409, 'Another browser changed this account a moment ago. Load it again.');
    if (!a.auth) a.auth = await authOf(proof);
    a.keyring = keyring;
    a.version++;
    for (const [id, w] of Object.entries(wrapped && typeof wrapped === 'object' ? wrapped : {})) {
      if (a.creds.some(c => c.id === id) && typeof w === 'string' && w.length <= 512 && unb64u(w)) a.wrapped[id] = w;
    }
    await this.s.put(`a:${aid}`, a);
    return { version: a.version };
  }

  // Macs that hold the account key, by the hash of a secret each was given when it joined. A Mac
  // shows that it's one to see browsers waiting for its approval.
  // A Mac joining again (by its machine id) replaces its old entry; a new one past the cap is
  // refused, never makes room by dropping another.
  async addMember(session, proof, memberHash, mid, t = Date.now()) {
    const { aid, a } = await this.owner(session, proof, t);
    if (typeof memberHash !== 'string' || !B64_32.test(memberHash)) throw err(400, 'bad member');
    const m = typeof mid === 'string' && /^[A-Za-z0-9_-]{22}$/.test(mid) ? mid : null;
    const rest = a.members.filter(x => !(m && x.m === m) && (x.h || x) !== memberHash);
    if (rest.length >= MAX_MEMBERS) throw err(409, `An account holds at most ${MAX_MEMBERS} Macs. Take one off first (dibs connect --remove on it).`);
    a.members = [...rest, { h: memberHash, m }];
    await this.s.put(`a:${aid}`, a);
    return { ok: true };
  }
  async isMember(aid, secret) {
    const a = typeof aid === 'string' ? await this.s.get(`a:${aid}`) : null;
    if (!a || typeof secret !== 'string') return false;
    const h = await sha(`dibs-member-v1\0${secret}`);
    return a.members.some(x => (x.h || x) === h);
  }

  // A browser signed in without the account key asks a Mac for it, in four steps through this
  // mailbox, so neither the relay nor anyone else can slip in a key of their own:
  //   1. the browser posts a commitment, SHA-256 of its ephemeral public key and a nonce
  //   2. a member Mac posts its own ephemeral public key
  //   3. the browser reveals its key and nonce; the Mac checks them against the commitment
  //   4. both show the same 6-digit code from the two keys; the person compares, approves at the
  //      Mac, and the Mac posts the account key sealed to the shared secret
  // Committing first means a go-between has to choose its keys blind, so its code matches by
  // chance one time in a million. The relay sees public keys and a sealed answer, nothing else.
  async askApproval(session, commit, label, t = Date.now()) {
    const { aid } = await this.account(session, t);
    if (typeof commit !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(commit)) throw err(400, 'bad commitment');
    const open = [...(await this.s.list({ prefix: `p:${aid}:`, limit: SWEEP_BATCH }))].filter(([, v]) => v.exp > t && !v.sealed && !v.refused);
    const sh = await sha(`dibs-session-v1\0${session}`);
    if (open.filter(([, v]) => v.sh === sh).length >= PENDING_PER_SESSION) throw err(429, 'This browser already has a request waiting for a Mac. Use that one, or wait for it to expire (10 minutes).');
    // The person meets this when someone else filled the account's places, which takes their
    // email: so it says what to do about that, not just to wait.
    if (open.length >= MAX_PENDING) throw err(429, `${MAX_PENDING} browsers are already waiting for approval on this account. If you didn't ask from them, someone else may have your email: in a browser that already opens your Macs, use Sign out everywhere else, then ask again here. Otherwise approve them or wait 10 minutes.`);
    const id = rand(9);
    await this.s.put(`p:${aid}:${id}`, { commit, sh, label: String(label || 'a browser').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 60), exp: t + APPROVAL_LIFE, created: t });
    return { id, expires: t + APPROVAL_LIFE };
  }
  async reveal(session, id, pub, nonce, t = Date.now()) {
    const { aid } = await this.account(session, t);
    const key = `p:${aid}:${id}`;
    const p = await this.s.get(key);
    if (!p || p.exp <= t) throw err(404, 'That request expired. Ask again.');
    if (!p.mac || p.pub) throw err(409, 'Not the time to reveal.');
    if (![pub, nonce].every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x))) throw err(400, 'bad key');
    Object.assign(p, { pub, nonce });
    await this.s.put(key, p);
    return { ok: true };
  }
  async poll(session, id, t = Date.now()) {
    const { aid } = await this.account(session, t);
    const key = `p:${aid}:${id}`;
    const p = await this.s.get(key);
    if (!p || p.exp <= t) throw err(404, 'That request expired. Ask again.');
    if (p.sealed) await this.s.delete(key);
    return { mac: p.mac || null, sealed: p.sealed || null, refused: !!p.refused };
  }
  async pending(aid, secret, t = Date.now()) {
    if (!(await this.isMember(aid, secret))) throw err(403, 'not a member of that account');
    return [...(await this.s.list({ prefix: `p:${aid}:`, limit: SWEEP_BATCH }))].filter(([, v]) => v.exp > t && !v.sealed && !v.refused).slice(0, MAX_PENDING)
      .map(([k, v]) => ({ id: k.split(':')[2], label: v.label, commit: v.commit, mac: v.mac || null, pub: v.pub || null, nonce: v.nonce || null, created: v.created, expires: v.exp }));
  }
  // A member Mac's step: its ephemeral key (step 2), the sealed account key (step 4), or no.
  async answer(aid, secret, id, step, t = Date.now()) {
    if (!(await this.isMember(aid, secret))) throw err(403, 'not a member of that account');
    const key = `p:${aid}:${id}`;
    const p = typeof id === 'string' ? await this.s.get(key) : null;
    if (!p || p.exp <= t) throw err(404, 'That request expired.');
    const b64 = (x, max) => typeof x === 'string' && x.length <= max && unb64u(x);
    if (step?.mac && !p.mac && b64(step.mac, 64)) p.mac = step.mac;
    else if (step?.sealed && p.mac && p.pub && b64(step.sealed, 4096)) p.sealed = step.sealed;
    else if (step?.refuse === true) p.refused = true;
    else throw err(409, 'Not the time for that step.');
    await this.s.put(key, p);
    return { ok: true };
  }

  // One batch of everything past its time (links, sessions, used challenges, approvals), from
  // where the last batch stopped. Only the alarm calls this. True while a prefix has more to go.
  async sweep(t = Date.now(), batch = SWEEP_BATCH) {
    let more = false;
    for (const prefix of ['l:', 's:', 'u:', 'p:', 'r:', 'c:']) {
      const after = this.cursor[prefix];
      const page = await this.s.list({ prefix, limit: batch, ...(after && { startAfter: after }) });
      const gone = [...page].filter(([, v]) => !v?.exp || v.exp <= t).map(([k]) => k);
      if (gone.length) await this.s.delete(gone);
      if (page.size === batch) { this.cursor[prefix] = [...page.keys()].pop(); more = true; } else delete this.cursor[prefix];
    }
    return more;
  }
}
