// src/accountbook.js on a Map standing in for Durable Object storage.
//   node --test test/accountbook.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AccountBook, LINK_LIFE, SESSION_LIFE, CHALLENGE_LIFE, MAX_MEMBERS, SWEEP_BATCH } from '../src/accountbook.js';
import { authenticator } from './authenticator.mjs';

// Durable Object storage as far as the book uses it: list in key order with prefix, limit and
// startAfter, and delete taking one key or many. lists counts list calls.
function store() {
  const m = new Map();
  const st = { m, lists: 0, get: async k => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async k => { for (const x of [k].flat()) m.delete(x); },
    list: async ({ prefix, limit = Infinity, startAfter }) => {
      st.lists++;
      return new Map([...m].filter(([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit));
    } };
  return st;
}
const book = (limits) => { const s = store(); return { s, b: new AccountBook(s, { secret: 'test-secret', rpId: 'app.dibs.cc', origin: 'https://app.dibs.cc', limits }) }; };
const rand = () => crypto.randomBytes(32).toString('base64url');
const sha = x => crypto.createHash('sha256').update(x).digest('base64url');
// An account whose browser holds the account key: its first keyring write set the proof.
async function owned(b, email = 'me@example.com', ip = 'ip') {
  const s = await b.redeemLink((await b.requestLink(email, ip)).token, ip);
  const proof = rand();
  await b.putKeyring(s.session, { keyring: 'c2VhbGVk', version: 0, proof });
  return { ...s, proof };
}

test('an email address is stored only as a keyed hash, and a link signs in once', async () => {
  const { s, b } = book();
  const { token } = await b.requestLink('  Person@Example.COM ', 'ip1');
  const r = await b.redeemLink(token, 'ip1');
  assert.equal(r.created, true);
  const all = JSON.stringify([...s.m]);
  assert.doesNotMatch(all, /person|example/i, 'no address anywhere');
  assert.doesNotMatch(all, new RegExp(token), 'no link token either, only its hash');
  await assert.rejects(b.redeemLink(token, 'ip1'), /already used or has expired/);
  // The same address, any case, finds the same account.
  const again = await b.redeemLink((await b.requestLink('person@example.com', 'ip1')).token, 'ip1');
  assert.equal(again.aid, r.aid);
  assert.equal(again.created, false);
});

test('a link expires after 10 minutes and a session after 30 days', async () => {
  const { b } = book();
  const t = Date.now();
  const { token } = await b.requestLink('a@b.co', 'ip', t);
  await assert.rejects(b.redeemLink(token, 'ip', t + LINK_LIFE + 1), /expired/);
  const r = await b.redeemLink((await b.requestLink('a@b.co', 'ip', t)).token, 'ip', t);
  await b.account(r.session, t + SESSION_LIFE - 1);
  await assert.rejects(b.account(r.session, t + SESSION_LIFE + 1), /Sign in again/);
});

test('three strangers asking for links to an address don\'t lock its owner out of email sign-in', async () => {
  const T = Date.UTC(2026, 10, 2, 22, 10);
  const { b } = book();
  for (const ip of ['7.7.7.1', '7.7.7.2', '7.7.7.3']) await b.requestLink('victim@example.com', ip, T);
  assert.equal(typeof (await b.requestLink('victim@example.com', '9.9.9.9', T)).token, 'string', 'the owner, from their own address, still gets a link');
  // From one IP an address gets three an hour; from anywhere, twenty.
  for (let i = 0; i < 2; i++) await b.requestLink('victim@example.com', '9.9.9.9', T);
  await assert.rejects(b.requestLink('victim@example.com', '9.9.9.9', T), /already went to that address/);
  for (let i = 0; i < 14; i++) await b.requestLink('victim@example.com', `10.0.0.${i}`, T);
  await assert.rejects(b.requestLink('victim@example.com', '10.0.1.1', T), /A lot of sign-in links went to that address/);
});

test('the global link cap counts every request, an IP\'s first included', async () => {
  const T = Date.UTC(2026, 10, 2, 22, 10);
  const { b } = book({ LINKS_GLOBAL: 5 });
  for (let i = 0; i < 5; i++) await b.requestLink(`n${i}@y.zz`, `ip${i}`, T);
  await assert.rejects(b.requestLink('late@y.zz', 'fresh-ip', T), /a lot of sign-in links right now/);
  const { b: b2 } = book();
  for (let i = 0; i < 10; i++) await b2.requestLink(`m${i}@y.zz`, 'ipA', T);
  await assert.rejects(b2.requestLink('eleventh@y.zz', 'ipA', T), /Too many sign-in links from here/);
});

// relayreview: the counts lived in memory, so an evicted object started over.
test('link counts are kept in storage: a fresh object on the same storage still refuses, and the next hour starts over', async () => {
  const s = store();
  const T = Date.UTC(2026, 10, 2, 22, 10);
  const mk = () => new AccountBook(s, { secret: 'test-secret', rpId: 'app.dibs.cc', origin: 'https://app.dibs.cc' });
  for (let i = 0; i < 3; i++) await mk().requestLink('evict@example.com', '5.5.5.5', T);
  await assert.rejects(mk().requestLink('evict@example.com', '5.5.5.5', T + 1000), /already went to that address/);
  assert.equal(typeof (await mk().requestLink('evict@example.com', '5.5.5.5', T + 36e5)).token, 'string');
  assert.doesNotMatch(JSON.stringify([...s.m.keys()]), /evict|5\.5\.5\.5/, 'neither the address nor the IP in a key');
  // The alarm sweeps the old hours' counts.
  while (await mk().sweep(T + 2 * 36e5));
  const left = [...s.m.keys()].filter(k => k.startsWith('r:'));
  assert.deepEqual([...new Set(left.map(k => k.split(':')[1]))], [String(Math.floor(T / 36e5) + 1)], 'only the newest hour is left');
});

test('the code is typed against its request: once, five wrong tries at most, and it spends the link with it', async () => {
  const { s, b } = book();
  const t = Date.now();
  const r = await b.requestLink('code@example.com', 'ip', t);
  assert.match(r.code, /^\d{6}$/);
  assert.match(r.rid, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!JSON.stringify([...s.m]).includes(r.code), 'the code is stored only as an HMAC');
  const wrong = String((Number(r.code) + 1) % 1e6).padStart(6, '0');
  for (let left = 4; left >= 1; left--) {
    const e = await b.redeemCode(r.rid, wrong, `ip${left}`, t).then(() => null, x => x);
    assert.equal(e.left, left);
    assert.match(e.message, new RegExp(`${left} tr(y|ies) left`));
  }
  const fifth = await b.redeemCode(r.rid, wrong, 'ip0', t).then(() => null, x => x);
  assert.ok(fifth.expired, 'the fifth wrong code ends it');
  await assert.rejects(b.redeemCode(r.rid, r.code, 'ipz', t), /expired or was already used/, 'even the right code, after that');
  await assert.rejects(b.redeemLink(r.token, 'ipz', t), /already used or has expired/, 'and its link went with it');

  const ok = await b.requestLink('code@example.com', 'ipb', t);
  const signed = await b.redeemCode(ok.rid, `${ok.code.slice(0, 3)} ${ok.code.slice(3)}`, 'ipq', t);
  assert.equal(signed.created, true);
  assert.equal(signed.passkeys, 0);
  await assert.rejects(b.redeemCode(ok.rid, ok.code, 'ipq', t), /already used/, 'once');
  await assert.rejects(b.redeemLink(ok.token, 'ipq', t), /already used/, 'the code spent the link');
  const late = await b.requestLink('code@example.com', 'ipc', t);
  await assert.rejects(b.redeemCode(late.rid, late.code, 'ipl', t + LINK_LIFE + 1), /expired/, '10 minutes');
  const viaLink = await b.requestLink('code@example.com', 'ipd', t);
  await b.redeemLink(viaLink.token, 'ipm', t);
  await assert.rejects(b.redeemCode(viaLink.rid, viaLink.code, 'ipm', t), /already used/, 'the link spent the code');
  await assert.rejects(b.redeemCode('not-an-id', '123456', 'ipm', t), /expired/);
});

// relayreview's race.mjs: 200 wrong guesses in flight at once, on storage that yields at every call.
test('guesses in flight together each count: five wrong ones and the code is gone, the right one after them too', async () => {
  const m = new Map();
  const tick = () => new Promise(r => setImmediate(r));
  const st = { get: async k => { await tick(); return structuredClone(m.get(k)); }, put: async (k, v) => { await tick(); m.set(k, structuredClone(v)); },
    delete: async k => { await tick(); [].concat(k).forEach(x => m.delete(x)); }, list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
  const b = new AccountBook(st, { secret: 'x', rpId: 'app.dibs.cc', origin: 'https://app.dibs.cc', limits: { SIGNINS_PER_IP: 1e9, WRONG_CODES_PER_DAY: 1e9 } });
  const { rid, code } = await b.requestLink('victim@example.com', '6.6.6.6');
  const guesses = Array.from({ length: 200 }, (_, i) => String((Number(code) + 1 + i) % 1e6).padStart(6, '0'));
  const results = await Promise.allSettled(guesses.map((g, i) => b.redeemCode(rid, g, `10.0.${i}.1`)));
  const checked = results.filter(r => r.status === 'rejected' && /isn't right|wrong codes, so/.test(r.reason.message)).length;
  assert.equal(checked, 5, 'five checked against the code, the rest found it gone');
  await assert.rejects(b.redeemCode(rid, code, '10.9.9.9'), /expired or was already used/);
});

test('an address takes ten wrong codes a day across its requests; then only its link signs in', async () => {
  const { b } = book({ SIGNINS_PER_IP: 1e9, LINKS_PER_EMAIL_IP: 1e9, LINKS_PER_EMAIL: 1e9 });
  const t = Date.UTC(2026, 10, 3, 12);
  const wrong = c => String((Number(c) + 1) % 1e6).padStart(6, '0');
  for (let n = 0; n < 10; n++) {
    const r = await b.requestLink('budget@example.com', `ip${n}`, t);
    await assert.rejects(b.redeemCode(r.rid, wrong(r.code), `g${n}`, t), /isn't right/);
  }
  const r = await b.requestLink('budget@example.com', 'ipz', t);
  await assert.rejects(b.redeemCode(r.rid, r.code, 'gz', t), /Too many wrong codes for this address today. Use the link/);
  assert.ok((await b.redeemLink(r.token, 'gz', t)).session, 'the link still works');
  const next = await b.requestLink('budget@example.com', 'ipy', t + 24 * 36e5);
  assert.ok((await b.redeemCode(next.rid, next.code, 'gy', t + 24 * 36e5)).session, 'the next day, codes work again');
});

test('an account that requires a passkey: email signs in only to ask a Mac, and turning it on needs a passkey and the key', async () => {
  const { b } = book();
  const o = await owned(b, 'only@example.com');
  await assert.rejects(b.setPasskeyOnly(o.session, o.proof, true), /Add a passkey first/);
  const a = await authenticator();
  const reg = await b.passkeyBegin(o.session, o.proof);
  await b.passkeyFinish(o.session, o.proof, reg.challenge, await a.create({ challenge: reg.challenge }), 'k');
  const thief = (await b.redeemLink((await b.requestLink('only@example.com', 'ip2')).token, 'ip2'));
  await assert.rejects(b.setPasskeyOnly(thief.session, rand(), true), /holds the account key/);
  assert.deepEqual(await b.setPasskeyOnly(o.session, o.proof, true), { passkeyOnly: true });
  const r = await b.requestLink('only@example.com', 'ip3');
  const rec = await b.redeemCode(r.rid, r.code, 'ip3');
  assert.equal(rec.recovery, true);
  await assert.rejects(b.keyring(rec.session), /holds the account key/, 'a recovery session reads nothing without the key');
  assert.ok((await b.askApproval(rec.session, rand(), 'Safari')).id, 'it can ask a Mac');
  assert.equal((await b.keyring(rec.session, Date.now(), o.proof)).passkeyOnly, true, 'with the key (from a Mac) it reads');
  await b.setPasskeyOnly(o.session, o.proof, false);
  const back = await b.redeemLink((await b.requestLink('only@example.com', 'ip4')).token, 'ip4');
  assert.equal(back.recovery, undefined);
});

test('the answer to a link request is the same whether or not the address has an account', async () => {
  const { b } = book();
  const known = await b.requestLink('known@x.io', 'i1');
  await b.redeemLink(known.token, 'i1');
  const a = await b.requestLink('known@x.io', 'i2');
  const u = await b.requestLink('unknown@x.io', 'i3');
  assert.deepEqual(Object.keys(a), Object.keys(u));
  for (const k of Object.keys(a)) assert.equal(a[k].length, u[k].length, k);
  await assert.rejects(b.requestLink('not an email', 'i4'), /not an email/);
});

test('sign-in tries are limited per IP', async () => {
  const { b } = book({ SIGNINS_PER_IP: 3 });
  for (let i = 0; i < 3; i++) await assert.rejects(b.redeemLink('nope', 'ipX'), /already used or has expired/);
  await assert.rejects(b.redeemLink('nope', 'ipX'), /Too many sign-in tries/);
});

test('the keyring is the browser\'s sealed blob: stored as given, versioned so two browsers can\'t overwrite each other', async () => {
  const { s, b } = book();
  const { session } = await b.redeemLink((await b.requestLink('k@r.ng', 'i')).token, 'i');
  assert.deepEqual((await b.keyring(session)).keyring, null);
  const proof = rand();
  await assert.rejects(b.putKeyring(session, { keyring: 'c2VhbGVk', version: 0 }), /proof/, 'the first write sets the proof, so it must carry one');
  const v1 = await b.putKeyring(session, { keyring: 'c2VhbGVk', version: 0, proof });
  assert.equal(v1.version, 1);
  await assert.rejects(b.putKeyring(session, { keyring: 'b3RoZXI', version: 0, proof }), /Another browser changed/);
  assert.equal((await b.keyring(session)).keyring, 'c2VhbGVk');
  await assert.rejects(b.putKeyring(session, { keyring: 'x'.repeat(70000), version: 1, proof }), /at most/);
  assert.ok([...s.m.values()].some(v => v.keyring === 'c2VhbGVk'));
  assert.ok(!JSON.stringify([...s.m]).includes(proof), 'the relay keeps only a hash of the proof');
});

// relayreview's emailonly.mjs: a stolen inbox signs in, and must not be able to change anything.
test('a session from an email link alone can\'t touch the keyring, the Macs, the passkeys or the sessions', async () => {
  const { b } = book();
  const owner = await owned(b);
  const macSecret = rand();
  await b.addMember(owner.session, owner.proof, sha(`dibs-member-v1\0${macSecret}`), 'M'.repeat(22));
  const thief = await b.redeemLink((await b.requestLink('me@example.com', '6.6.6.6')).token, '6.6.6.6');
  assert.equal(thief.aid, owner.aid, 'the link signs in, as it should');
  const wrong = rand();
  for (const proof of [undefined, wrong]) {
    await assert.rejects(b.addMember(thief.session, proof, sha(`dibs-member-v1\0${rand()}`)), /holds the account key/);
    await assert.rejects(b.putKeyring(thief.session, { keyring: 'ZXZpbA', version: 1, proof }), /holds the account key/);
    await assert.rejects(b.passkeyBegin(thief.session, proof), /holds the account key/);
    await assert.rejects(b.endSessions(thief.session, proof), /holds the account key/);
    await assert.rejects(b.removePasskey(thief.session, proof, 'x'), /holds the account key/);
  }
  assert.equal((await b.keyring(owner.session)).keyring, 'c2VhbGVk');
  assert.equal((await b.keyring(owner.session)).version, 1);
  assert.ok(await b.isMember(owner.aid, macSecret));
  // It can still ask a Mac for the key: that's the person's way in, and a Mac must approve it.
  assert.ok((await b.askApproval(thief.session, rand(), 'a browser')).id);
});

// relayreview's emailonly2.mjs: an account with a keyring from before proofs existed.
test('an account that had a keyring before proofs takes no first proof, from anyone', async () => {
  const { s, b } = book();
  const early = await b.redeemLink((await b.requestLink('early@example.com', 'ip')).token, 'ip');
  const a = s.m.get(`a:${early.aid}`);
  s.m.set(`a:${early.aid}`, { ...a, keyring: 'b2xk', version: 3 });
  const thief = await b.redeemLink((await b.requestLink('early@example.com', '6.6.6.7')).token, '6.6.6.7');
  await assert.rejects(b.putKeyring(thief.session, { keyring: 'ZXZpbA', version: 3, proof: rand() }), /made before dibs accounts could check/);
  assert.equal(s.m.get(`a:${early.aid}`).auth, undefined);
  assert.equal(s.m.get(`a:${early.aid}`).keyring, 'b2xk');
});

// relayreview's residual: one session holding every open request on the account.
test('one session keeps at most two approval requests open, so it can\'t crowd out the person\'s browsers', async () => {
  const { b } = book();
  await owned(b, 'cap@example.com');
  const thief = await b.redeemLink((await b.requestLink('cap@example.com', '6.6.6.6')).token, '6.6.6.6');
  for (let i = 0; i < 2; i++) await b.askApproval(thief.session, rand(), 'x');
  await assert.rejects(b.askApproval(thief.session, rand(), 'x'), /already has a request waiting/);
  const real = await b.redeemLink((await b.requestLink('cap@example.com', 'ip9')).token, 'ip9');
  assert.ok((await b.askApproval(real.session, rand(), 'Safari')).id, 'the person\'s new browser still gets in line');
  // Sessions enough to fill the account: the person is told what that means.
  const more = await b.redeemLink((await b.requestLink('cap@example.com', '6.6.6.7')).token, '6.6.6.7');
  for (let i = 0; i < 2; i++) await b.askApproval(more.session, rand(), 'x');
  const late = await b.redeemLink((await b.requestLink('cap@example.com', 'ip10')).token, 'ip10');
  await assert.rejects(b.askApproval(late.session, rand(), 'Safari'), /someone else may have your email.*Sign out everywhere else/);
});

test('an account refuses a Mac past its cap instead of dropping one, and a Mac joining again replaces itself', async () => {
  const { b } = book();
  const o = await owned(b);
  const first = rand();
  await b.addMember(o.session, o.proof, sha(`dibs-member-v1\0${first}`), 'A'.repeat(22));
  for (let i = 1; i < MAX_MEMBERS; i++) await b.addMember(o.session, o.proof, sha(`dibs-member-v1\0m${i}`), `${String(i).padStart(2, '0')}${'B'.repeat(20)}`);
  await assert.rejects(b.addMember(o.session, o.proof, sha(`dibs-member-v1\0${rand()}`), 'C'.repeat(22)), /at most 50 Macs/);
  assert.ok(await b.isMember(o.aid, first), 'the first Mac is still a member');
  const again = rand();
  await b.addMember(o.session, o.proof, sha(`dibs-member-v1\0${again}`), 'A'.repeat(22));
  assert.ok(await b.isMember(o.aid, again));
  assert.ok(!(await b.isMember(o.aid, first)), 'its old secret went with its old entry');
});

test('a session of an account that\'s gone is refused, and removed', async () => {
  const { s, b } = book();
  const o = await owned(b, 'gone@example.com');
  s.m.delete(`a:${o.aid}`);
  const before = [...s.m.keys()].filter(k => k.startsWith('s:')).length;
  await assert.rejects(b.account(o.session), /That account is gone/);
  assert.equal([...s.m.keys()].filter(k => k.startsWith('s:')).length, before - 1);
  await assert.rejects(b.account(o.session), /that session ended/);
});

test('ending every session signs out every browser but the one that asked', async () => {
  const { b } = book();
  const o = await owned(b);
  const other = await b.redeemLink((await b.requestLink('me@example.com', 'ip2')).token, 'ip2');
  const t = Date.now() + 5;
  const fresh = await b.endSessions(o.session, o.proof, t);
  await assert.rejects(b.account(other.session, t + 1), /every session of this account was ended/);
  await assert.rejects(b.account(o.session, t + 1), /every session of this account was ended/);
  assert.equal((await b.account(fresh.session, t + 1)).aid, o.aid);
});

test('a browser without the account key goes through the four steps with a member Mac; strangers can\'t see or answer', async () => {
  const { b } = book();
  const { session, aid, proof } = await owned(b, 'm@a.cc');
  const secret = 'member-secret-123';
  await b.addMember(session, proof, sha(`dibs-member-v1\0${secret}`));
  const ask = await b.askApproval(session, 'C'.repeat(43), 'Safari on iPhone');
  await assert.rejects(b.pending(aid, 'wrong secret'), /not a member/);
  assert.deepEqual((await b.pending(aid, secret)).map(x => [x.id, x.label, x.commit]), [[ask.id, 'Safari on iPhone', 'C'.repeat(43)]]);
  await assert.rejects(b.reveal(session, ask.id, 'P'.repeat(43), 'N'.repeat(43)), /Not the time/, 'no reveal before the Mac commits its key');
  await assert.rejects(b.answer(aid, secret, ask.id, { sealed: 'c2VhbGVk' }), /Not the time/, 'nothing sealed before the reveal');
  await b.answer(aid, secret, ask.id, { mac: 'M'.repeat(43) });
  assert.deepEqual(await b.poll(session, ask.id), { mac: 'M'.repeat(43), sealed: null, refused: false });
  await b.reveal(session, ask.id, 'P'.repeat(43), 'N'.repeat(43));
  await assert.rejects(b.answer(aid, 'wrong', ask.id, { sealed: 'c2VhbGVk' }), /not a member/);
  await b.answer(aid, secret, ask.id, { sealed: 'c2VhbGVk' });
  assert.equal((await b.poll(session, ask.id)).sealed, 'c2VhbGVk');
  await assert.rejects(b.poll(session, ask.id), /expired/, 'collected once');
});

test('the sweep removes expired links, codes, sessions, used challenges and approvals, and keeps accounts', async () => {
  const { s, b } = book();
  const t = Date.now();
  const { session } = await b.redeemLink((await b.requestLink('s@w.ep', 'i', t)).token, 'i', t);
  await b.requestLink('s@w.ep', 'i', t);
  await b.askApproval(session, 'B'.repeat(43), 'x', t);
  s.m.set('u:old', { exp: t });
  while (await b.sweep(t + SESSION_LIFE + 1));
  assert.deepEqual([...s.m.keys()].map(k => k.split(':')[0]).sort(), ['a', 'e']);
});

// relayreview: every request used to list every key in the one Durable Object.
test('requests never sweep, and the sweep goes a batch at a time', async () => {
  const { s, b } = book();
  const t = Date.now();
  for (let i = 0; i < SWEEP_BATCH * 2 + 5; i++) s.m.set(`l:${String(i).padStart(5, '0')}`, { exp: t - 1 });
  s.lists = 0;
  await b.signInBegin(t);
  await b.redeemLink((await b.requestLink('q@u.ie', 'i', t)).token, 'i', t);
  assert.equal(s.lists, 0, 'signing in lists nothing');
  assert.equal(await b.sweep(t), true, 'a full batch: more to go');
  assert.equal([...s.m.keys()].filter(k => k.startsWith('l:')).length, SWEEP_BATCH + 5, 'the redeemed link went when it was used');
  assert.equal(await b.sweep(t), true);
  assert.equal(await b.sweep(t), false);
  assert.equal([...s.m.keys()].filter(k => k.startsWith('l:')).length, 0);
});

test('asking for a passkey sign-in stores nothing, and a challenge works once, for five minutes', async () => {
  const { s, b } = book();
  const o = await owned(b, 'c@h.al');
  const a = await authenticator();
  const reg = await b.passkeyBegin(o.session, o.proof);
  const { id } = await b.passkeyFinish(o.session, o.proof, reg.challenge, await a.create({ challenge: reg.challenge }), 'k');
  const before = s.m.size;
  for (let i = 0; i < 100; i++) await b.signInBegin();
  assert.equal(s.m.size, before, 'a hundred challenges, nothing stored');
  const t = Date.now();
  const go = await b.signInBegin(t);
  await assert.rejects(b.signInFinish(go.challenge, id, await a.get({ challenge: go.challenge }), 'i', t + CHALLENGE_LIFE + 1), /expired/);
  const forged = go.challenge.slice(0, -2) + (go.challenge.endsWith('AA') ? 'BA' : 'AA');
  await assert.rejects(b.signInFinish(forged, id, await a.get({ challenge: forged }), 'i'), /expired/, 'a challenge the relay didn\'t make');
  // One made for adding a passkey doesn't sign in.
  await assert.rejects(b.signInFinish(reg.challenge, id, await a.get({ challenge: reg.challenge }), 'i'), /expired/);
});

test('a passkey seen used from a copy is turned off, so the copy can\'t retry its way past the count', async () => {
  const { b } = book();
  const o = await owned(b, 'clone@example.com');
  const a = await authenticator();
  const reg = await b.passkeyBegin(o.session, o.proof);
  const { id } = await b.passkeyFinish(o.session, o.proof, reg.challenge, await a.create({ challenge: reg.challenge }), 'k');
  const go = await b.signInBegin();
  await b.signInFinish(go.challenge, id, await a.get({ challenge: go.challenge, bump: 5 }), 'i');
  const stale = await b.signInBegin();
  await assert.rejects(b.signInFinish(stale.challenge, id, await a.get({ challenge: stale.challenge, bump: -3 }), 'i'), /copied/);
  const retry = await b.signInBegin();
  await assert.rejects(b.signInFinish(retry.challenge, id, await a.get({ challenge: retry.challenge, bump: 20 }), 'i'), /turned off/, 'a higher count later doesn\'t get it back');
  assert.ok((await b.keyring(o.session)).passkeys.find(p => p.id === id).copied, 'the account page can say so');
});

test('the wrapped account key goes only to a sign-in that verified the person', async () => {
  const { b } = book();
  const o = await owned(b, 'u@v.er');
  const a = await authenticator();
  const reg = await b.passkeyBegin(o.session, o.proof);
  await assert.rejects(b.passkeyFinish(o.session, o.proof, reg.challenge, await a.create({ challenge: reg.challenge, flags: 0x41 }), 'k'), /verify you/);
  const reg2 = await b.passkeyBegin(o.session, o.proof);
  const { id } = await b.passkeyFinish(o.session, o.proof, reg2.challenge, await a.create({ challenge: reg2.challenge }), 'k');
  await b.putKeyring(o.session, { keyring: 'c2VhbGVk', version: 1, proof: o.proof, wrapped: { [id]: 'd3JhcHBlZA' } });
  const go = await b.signInBegin();
  const touch = await b.signInFinish(go.challenge, id, await a.get({ challenge: go.challenge, flags: 0x01 }), 'i');
  assert.equal(touch.aid, o.aid, 'a touch alone still signs in');
  assert.equal(touch.wrapped, null, 'but without the wrapped key');
  const go2 = await b.signInBegin();
  assert.equal((await b.signInFinish(go2.challenge, id, await a.get({ challenge: go2.challenge }), 'i')).wrapped, 'd3JhcHBlZA');
});

test('a passkey added to an account signs in to it from anywhere, with the account key wrapped under its PRF', async () => {
  const { s, b } = book();
  const { session, aid, proof } = await owned(b, 'p@k.ey');
  const a = await authenticator();
  const begin = await b.passkeyBegin(session, proof);
  assert.equal(begin.user, aid);
  const { id } = await b.passkeyFinish(session, proof, begin.challenge, await a.create({ challenge: begin.challenge }), 'MacBook Touch ID');
  await b.putKeyring(session, { keyring: 'c2VhbGVk', version: 1, proof, wrapped: { [id]: 'd3JhcHBlZA' } });
  const go = await b.signInBegin();
  const r = await b.signInFinish(go.challenge, id, await a.get({ challenge: go.challenge }), 'i2');
  assert.equal(r.aid, aid);
  assert.equal(r.wrapped, 'd3JhcHBlZA', 'the browser gets its wrapped key back, to open with its PRF');
  await assert.rejects(b.signInFinish(go.challenge, id, await a.get({ challenge: go.challenge }), 'i2'), /expired/, 'a challenge works once');
  const other = await authenticator();
  const go2 = await b.signInBegin();
  await assert.rejects(b.signInFinish(go2.challenge, 'unknown-cred', await other.get({ challenge: go2.challenge }), 'i2'), /isn't on a dibs account/);
  assert.doesNotMatch(JSON.stringify([...s.m]), /"d"|privateKey/, 'only public keys are stored');
  // Removed, it signs in nowhere, and its wrapped key is gone.
  await b.removePasskey(session, proof, id);
  const go3 = await b.signInBegin();
  await assert.rejects(b.signInFinish(go3.challenge, id, await a.get({ challenge: go3.challenge }), 'i3'), /isn't on a dibs account/);
  assert.ok(!JSON.stringify([...s.m]).includes('d3JhcHBlZA'));
});
