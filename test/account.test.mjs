// dibs accounts across the three parties: the browser's half (web/account.js, run here on
// Node's WebCrypto), the Mac's (src/relay.mjs), and the relay's mailbox (relay/src/accountbook.js
// on a Map). The relay here may read everything it's given: none of it may be the account key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, sync } from './helpers.mjs';
import * as relay from '../src/relay.mjs';
import { AccountBook } from '../relay/src/accountbook.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'web', 'transport.js'), 'utf8'), { filename: 'transport.js' });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'web', 'account.js'), 'utf8'), { filename: 'account.js' });
const B = globalThis.dibsTransport._internals;
const A = globalThis.dibsAccount._internals;

function store() {
  const m = new Map();
  return { m, get: async k => m.get(k), put: async (k, v) => { m.set(k, structuredClone(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))) };
}
const memStore = () => { const m = new Map(); return { get: async k => m.get(k), put: async r => { m.set(r.mid, r); }, all: async () => [...m.values()], remove: async k => { m.delete(k); } }; };
// A channel straight to the Mac's half, as the relay would carry it.
function wire() {
  const inbox = [], waiters = [];
  const ch = crypto.randomBytes(16).toString('base64url');
  const mac = relay.macPeer({ send: (c, b) => { const w = waiters.shift(); w ? w.resolve(new Uint8Array(b)) : inbox.push(new Uint8Array(b)); }, kick: () => {}, call: async () => ({ status: 200, json: {} }) });
  mac.open(ch);
  return { send: b => mac.data(ch, Buffer.from(b)), recv: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))), close() {} };
}
const linkOf = url => B.parseLink(`#p=${new URL(url).hash.replace(/^#join=/, '')}`);
const memberHash = secret => crypto.createHash('sha256').update(`dibs-member-v1\0${secret}`).digest('base64url');

// A browser signed in to an account with its key, and this Mac joined to it.
async function joined() {
  const relayStore = store();
  const book = new AccountBook(relayStore, { secret: 'relay-secret', rpId: 'app.dibs.cc', origin: 'https://app.dibs.cc' });
  const s = await book.redeemLink((await book.requestLink('owner@example.com', 'ip')).token, 'ip');
  const ak = crypto.randomBytes(32);
  const ring = await A.newRing();
  const link = linkOf(relay.newPairing({ account: true }).link);
  const chan = wire();
  const rec = await B.pair(chan, link, `account ${s.aid.slice(0, 8)}`, memStore(), await A.deviceKeys(ring));
  const session = await B.open(chan, rec);
  const secret = crypto.randomBytes(32).toString('base64url');
  const j = await session.request('POST', '/api/account/join', { aid: s.aid, secret, ak: ak.toString('base64url'), label: 'Chrome on Mac' });
  assert.equal(j.status, 200, JSON.stringify(j));
  ring.machines.push({ mid: rec.mid, m: rec.m, fp: rec.fp, did: rec.did, rt: rec.rt });
  const proof = await A.authProof(ak);
  await book.putKeyring(s.session, { keyring: await A.sealRing(ak, ring), version: 0, proof });
  await book.addMember(s.session, proof, memberHash(secret), rec.mid);
  return { book, relayStore, s, ak, ring, rec, proof };
}

test('a Mac paired with dibs connect --account joins it, and holds its key; a plain paired browser can\'t join', async () => {
  const { s, ak, ring, book } = await joined();
  const acct = relay.load().accounts[s.aid];
  assert.equal(acct.ak, ak.toString('base64url'));
  assert.match(sync(HOME, ['connect', '--list']).out, new RegExp(`${s.aid.slice(0, 8)}\\s+dibs account`));
  // The keyring the relay holds opens only with the account key.
  const k = await book.keyring(s.session);
  assert.deepEqual((await A.openRing(ak, k.keyring)).machines.map(x => x.mid), ring.machines.map(x => x.mid));
  await assert.rejects(A.openRing(crypto.randomBytes(32), k.keyring), /doesn't open/);
  // A phone paired the ordinary way can't give this Mac an account.
  const chan = wire();
  const rec = await B.pair(chan, linkOf(relay.newPairing().link.replace('#p=', '#join=')), 'a phone', memStore());
  const sess = await B.open(chan, rec);
  const r = await sess.request('POST', '/api/account/join', { aid: 'A'.repeat(22), secret: 'B'.repeat(43), ak: 'C'.repeat(43) });
  assert.equal(r.status, 403);
  assert.ok(!relay.load().accounts['A'.repeat(22)]);
});

// The browser's side of an approval, driven to the end, and the Mac's rounds in between.
async function approveRun({ book, s, aid, typed = null, meddle = x => x }) {
  const st = await A.approvalStart();
  const { id } = await book.askApproval(s.session, st.commit, 'Safari on iPhone');
  const eph = new Map();
  const macRound = async () => {
    const pending = (await book.pending(aid, relay.load().accounts[aid].secret)).map(meddle);
    for (const x of relay.approvalStep(aid, pending, eph)) await book.answer(aid, relay.load().accounts[aid].secret, x.id, x.step);
  };
  await macRound();                       // the Mac's key
  const p1 = await book.poll(s.session, id);
  await book.reveal(s.session, id, st.B.length ? B.b64u(st.B) : '', B.b64u(st.n));
  const keys = await A.approvalKeys(st.eph, aid, id, st.B, B.unb64u(p1.mac));
  await macRound();                       // the Mac works out the code and waits for the person
  const waiting = relay.waitingApprovals();
  const r = relay.approve(typed ? typed(keys.sas) : keys.sas);
  await macRound();                       // approved: the sealed key goes
  const p2 = await book.poll(s.session, id).catch(e => ({ error: e.message }));
  return { keys, waiting, approved: r, p2, id };
}

test('a new browser of the account gets its key from the Mac once the person types the code it shows', async () => {
  const { book, s, ak, relayStore } = await joined();
  const run = await approveRun({ book, s, aid: s.aid });
  assert.match(run.keys.sas, /^\d{6}$/);
  assert.ok(run.waiting.some(w => w.label === 'Safari on iPhone' && w.sas === run.keys.sas), 'the Mac sees the same code');
  assert.ok(run.approved);
  assert.equal(run.approved.confirm, run.keys.confirm, 'the Mac prints the code the browser expects');
  assert.match(sync(HOME, ['connect', '--approve', '123456']).err, /No waiting browser shows that code/);
  await assert.rejects(A.acceptSealed(run.keys, s.aid, run.id, run.p2.sealed, run.keys.sas), /isn't the code your Mac printed/);
  const got = await A.acceptSealed(run.keys, s.aid, run.id, run.p2.sealed, run.approved.confirm.replace(/(\d{3})/, '$1 '));
  assert.deepEqual(Buffer.from(got), ak);
  // Nothing the relay held along the way is the account key.
  assert.ok(!JSON.stringify([...relayStore.m]).includes(ak.toString('base64url')));
});

test('a wrong code approves nothing, and nothing is sent', async () => {
  const { book, s } = await joined();
  const run = await approveRun({ book, s, aid: s.aid, typed: sas => sas.slice(0, 5) + ((Number(sas[5]) + 1) % 10) });
  assert.equal(run.approved, null);
  assert.equal(run.p2.sealed, null);
  assert.ok(relay.waitingApprovals().some(w => w.sas === run.keys.sas), 'the real request still waits for the right code');
  assert.match(sync(HOME, ['connect', '--approve', '99999']).err, /6 digits/);
});

test('a relay that swaps the browser\'s revealed key is caught: the Mac refuses, nothing sealed', async () => {
  const { book, s } = await joined();
  const evil = crypto.generateKeyPairSync('x25519');
  const evilPub = Buffer.from(evil.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64url');
  const run = await approveRun({ book, s, aid: s.aid, meddle: x => (x.pub ? { ...x, pub: evilPub } : x) });
  assert.equal(run.approved, null, 'no code to approve: the reveal didn\'t match the commitment');
  assert.ok(!run.p2.sealed);
});

// relayreview's grind.mjs, without the grinding: a relay lists a throwaway commitment, takes the
// Mac's key, then lists a commitment to a key of its own whose code it knows. If the Mac checked
// round 2 against what the relay lists now, the relay's code would be one the person can be
// made to type (grinding makes it the person's own code), and the Mac would seal the account
// key to the relay.
test('a relay that swaps the commitment after seeing the Mac\'s key gets no code and no key', async () => {
  const { s } = await joined();
  const aid = s.aid, id = 'reqAttacker1';
  const eph = new Map();
  const [{ step: { mac } }] = relay.approvalStep(aid, [{ id, commit: crypto.randomBytes(32).toString('base64url'), label: 'Safari on iPhone' }], eph);
  const M = Buffer.from(mac, 'base64url');
  const kp = crypto.generateKeyPairSync('x25519');
  const Bk = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const ss = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: M.toString('base64url') }, format: 'jwk' }) });
  const theirs = relay.approvalKeys(ss, aid, id, Bk, M);
  const n = crypto.randomBytes(32);
  const list2 = [{ id, commit: relay.commitOf(Bk, n), mac, pub: Bk.toString('base64url'), nonce: n.toString('base64url'), label: 'Safari on iPhone' }];
  assert.deepEqual(relay.approvalStep(aid, list2, eph).map(x => x.step), [{ refuse: true }]);
  assert.ok(!relay.waitingApprovals().some(w => w.id === id), 'nothing for the person to approve');
  assert.equal(relay.approve(theirs.sas), null);
  assert.deepEqual(relay.approvalStep(aid, list2, eph), [], 'and nothing more for that request');
});

// relayreview's reconnect.mjs: the person approves their real browser; the relay drops the
// Mac's socket before it seals and replays that id, as new, with keys of its own.
test('a relay that drops the Mac\'s socket can\'t replay an approved request with its own keys', async () => {
  const { s } = await joined();
  const aid = s.aid, id = 'reqReplay001';
  const browser = () => { const kp = crypto.generateKeyPairSync('x25519'), Bk = Buffer.from(kp.publicKey.export({ format: 'jwk' }).x, 'base64url'), n = crypto.randomBytes(32); return { kp, Bk, n, commit: relay.commitOf(Bk, n) }; };
  const dh = (kp, M) => crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: M.toString('base64url') }, format: 'jwk' }) });
  const real = browser(), eph1 = new Map();
  const [{ step: { mac } }] = relay.approvalStep(aid, [{ id, commit: real.commit, label: 'Safari on iPhone' }], eph1);
  relay.approvalStep(aid, [{ id, commit: real.commit, mac, pub: real.Bk.toString('base64url'), nonce: real.n.toString('base64url') }], eph1);
  const M1 = Buffer.from(mac, 'base64url');
  assert.ok(relay.approve(relay.approvalKeys(dh(real.kp, M1), aid, id, real.Bk, M1).sas)?.id, 'the person approves the real browser');
  // A new connection: nothing in memory.
  const evil = browser(), eph2 = new Map();
  assert.deepEqual(relay.approvalStep(aid, [{ id, commit: evil.commit, label: 'Safari on iPhone' }], eph2), [], 'no new key for an id this Mac already pinned');
  // Even with the pin gone from relay.json, the approval holds the keys it was for.
  const file = path.join(HOME, 'relay.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete j.pins[id];
  fs.writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
  const eph3 = new Map();
  assert.deepEqual(relay.approvalStep(aid, [{ id, commit: evil.commit, label: 'Safari on iPhone' }], eph3), [], 'nor for an id with an approval waiting');
  // The real browser's next round on the first connection still gets its key.
  const out = relay.approvalStep(aid, [{ id, commit: real.commit, mac, pub: real.Bk.toString('base64url'), nonce: real.n.toString('base64url') }], eph1);
  assert.ok(out[0]?.step.sealed, 'the approved browser is sealed to');
});

test('a sealed key goes only to the keys the person approved, never to a new pin for that id', async () => {
  const { s } = await joined();
  const aid = s.aid, id = 'reqRebind001';
  const file = path.join(HOME, 'relay.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.approvals = { ...j.approvals, [id]: { aid, label: 'Safari', sas: '135790', confirm: '246801', keys: 'K'.repeat(43), exp: Date.now() + 5 * 60e3, approved: true } };
  fs.writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
  const st = await A.approvalStart();
  const eph = new Map();
  // An approval of other keys under this id: no fresh pin at all.
  assert.deepEqual(relay.approvalStep(aid, [{ id, commit: st.commit }], eph), []);
});

test('pins count toward the cap across connections, so reconnecting doesn\'t buy more tries', async () => {
  const { s } = await joined();
  const aid = s.aid;
  const req = i => ({ id: `reqCap${String(i).padStart(6, '0')}`, commit: crypto.randomBytes(32).toString('base64url') });
  let answered = 0;
  for (let c = 0; c < 4; c++) answered += relay.approvalStep(aid, [req(c * 2), req(c * 2 + 1)], new Map()).length;
  assert.equal(answered, relay.MAX_WAITING);
});

test('approving a browser whose key went with an earlier connection says to ask again, and the browser hears no', async () => {
  const { s } = await joined();
  const file = path.join(HOME, 'relay.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = 'reqStale0001';
  j.conn = 'now-connection';
  j.approvals = { ...j.approvals, [id]: { aid: s.aid, label: 'Safari on iPhone', sas: '864201', confirm: '975312', keys: 'K'.repeat(43), exp: Date.now() + 5 * 60e3, conn: 'old-connection' } };
  j.pins = { ...j.pins, [id]: { aid: s.aid, exp: Date.now() + 5 * 60e3, conn: 'old-connection' } };
  fs.writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
  const r = sync(HOME, ['connect', '--approve', '864201']);
  assert.match(r.err, /restarted since it asked.*Ask again from that browser/s);
  assert.doesNotMatch(r.out, /Now type this code/);
  const eph = Object.assign(new Map(), { conn: 'now-connection' });
  assert.deepEqual(relay.approvalStep(s.aid, [{ id, commit: 'C'.repeat(43), mac: 'M'.repeat(43) }], eph), [{ id, step: { refuse: true } }]);
  assert.ok(!relay.load().approvals[id]);
});

test('dibs connect --accounts lists the account and its waiting browsers without their codes; --refuse turns one down', async () => {
  const { book, s } = await joined();
  const st = await A.approvalStart();
  const { id } = await book.askApproval(s.session, st.commit, 'Firefox on Linux');
  const eph = new Map();
  const secret = relay.load().accounts[s.aid].secret;
  for (const x of relay.approvalStep(s.aid, await book.pending(s.aid, secret), eph)) await book.answer(s.aid, secret, x.id, x.step);
  await book.reveal(s.session, id, B.b64u(st.B), B.b64u(st.n));
  relay.approvalStep(s.aid, await book.pending(s.aid, secret), eph);
  const raw = sync(HOME, ['connect', '--accounts', '--json']).out;
  const j = JSON.parse(raw);
  assert.ok(j.accounts.some(a => a.id === s.aid.slice(0, 8)));
  const w = j.waiting.find(x => x.id === id);
  assert.equal(w.label, 'Firefox on Linux');
  assert.ok(w.expires > Date.now());
  const { sas, confirm } = relay.load().approvals[id];
  assert.ok(!raw.includes(sas) && !raw.includes(confirm), 'neither code is in the listing');
  assert.match(sync(HOME, ['connect', '--refuse', id]).out, /Refused Firefox on Linux/);
  assert.ok(!JSON.parse(sync(HOME, ['connect', '--accounts', '--json']).out).waiting.some(x => x.id === id));
  const out = relay.approvalStep(s.aid, await book.pending(s.aid, secret), eph);
  assert.deepEqual(out.find(x => x.id === id)?.step, { refuse: true }, 'the browser hears no');
  assert.match(sync(HOME, ['connect', '--refuse', id]).err, /No browser with that id/);
});

test('dibs connect --approve --json gives the browser\'s name and the code to type back', async () => {
  const { book, s } = await joined();
  const run = await approveRun({ book, s, aid: s.aid, typed: () => '000000' });
  assert.equal(run.approved, null);
  const r = sync(HOME, ['connect', '--approve', run.keys.sas, '--json']);
  assert.deepEqual(JSON.parse(r.out).approved, { id: run.id, label: 'Safari on iPhone', confirm: run.keys.confirm });
  assert.match(sync(HOME, ['connect', '--approve', '999999', '--json']).err, /No waiting browser shows that code/);
});

// The page's half: the same list and actions, on the Mac's own page only.
test('the page lists waiting browsers and approves one by its code, and a browser paired through the relay can do none of it', async () => {
  const web = await import('../src/web.mjs');
  const { book, s } = await joined();
  const run = await approveRun({ book, s, aid: s.aid, typed: () => '000000' });
  const remote = { kind: 'remote', device: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Safari on iPhone', act: true };
  for (const [method, p, body] of [['GET', '/api/accounts'], ['POST', '/api/accounts/approve', { code: run.keys.sas }], ['POST', '/api/accounts/refuse', { id: run.id }], ['POST', '/api/accounts/remove', { id: s.aid.slice(0, 8) }], ['POST', '/api/accounts/join', {}]]) {
    const r = await web.api({ method, path: p, body, session: remote });
    assert.equal(r.status, 403, p);
    assert.match(r.json.error, /only works on the Mac itself/);
  }
  assert.ok(relay.waitingApprovals().some(w => w.id === run.id), 'still waiting after every remote try');
  const list = await web.api({ method: 'GET', path: '/api/accounts', session: { kind: 'session' } });
  assert.ok(list.json.waiting.some(w => w.id === run.id && w.label === 'Safari on iPhone'));
  assert.ok(!JSON.stringify(list.json).includes(run.keys.sas));
  assert.equal((await web.api({ method: 'POST', path: '/api/accounts/approve', body: { code: '12345' }, session: { kind: 'session' } })).status, 400);
  const ok = await web.api({ method: 'POST', path: '/api/accounts/approve', body: { code: run.keys.sas.replace(/(\d{3})/, '$1 ') }, session: { kind: 'session' } });
  assert.deepEqual(ok.json, { id: run.id, label: 'Safari on iPhone', confirm: run.keys.confirm });
});

test('one request gets one key from the Mac, and the relay\'s list can\'t make it wait longer or for more', async () => {
  const { s } = await joined();
  const aid = s.aid;
  const eph = new Map();
  const req = i => ({ id: `req${String(i).padStart(9, '0')}`, commit: crypto.randomBytes(32).toString('base64url'), label: `browser ${i}`, expires: Date.now() + 365 * 864e5 });
  const flood = Array.from({ length: 20 }, (_, i) => req(i));
  const first = relay.approvalStep(aid, flood, eph);
  assert.equal(first.length, relay.MAX_WAITING, 'keys for five browsers, not twenty');
  // The same request listed again with no key on it: no second key to grind against.
  assert.deepEqual(relay.approvalStep(aid, [{ ...flood[0], mac: null }], eph), []);
  // Revealed honestly (another account: this one's five are taken), it waits ten minutes by
  // this Mac's clock, whatever the relay said.
  const other = (await joined()).s.aid;
  const st = await A.approvalStart();
  const eph2 = new Map();
  const r = { ...req(99), commit: st.commit, label: 'Safari on iPhone' };
  const [{ step }] = relay.approvalStep(other, [r], eph2);
  relay.approvalStep(other, [{ ...r, mac: step.mac, pub: B.b64u(st.B), nonce: B.b64u(st.n), label: 'Chrome, renamed by the relay' }], eph2);
  const w = relay.waitingApprovals().find(x => x.id === r.id);
  assert.ok(w.exp <= Date.now() + 10 * 60e3);
  assert.equal(w.label, 'Safari on iPhone', 'the label it first saw');
});

test('a code two waiting browsers show approves neither', async () => {
  const { s } = await joined();
  const file = path.join(HOME, 'relay.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const exp = Date.now() + 5 * 60e3;
  j.approvals = { ...j.approvals, reqTwinAAAAA: { aid: s.aid, label: 'Safari', sas: '424242', confirm: '111111', exp }, reqTwinBBBBB: { aid: s.aid, label: 'Safari', sas: '424242', confirm: '222222', exp } };
  fs.writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
  const r = sync(HOME, ['connect', '--approve', '424242']);
  assert.match(r.err, /2 waiting browsers show that code/);
  assert.ok(!relay.waitingApprovals().some(w => w.sas === '424242'));
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).approvals;
  assert.ok(!after.reqTwinAAAAA.approved && !after.reqTwinBBBBB.approved);
});

// relayreview's browserside.mjs: a relay answers a browser's request itself, posing as a Mac.
test('a browser never opens a key sealed by anyone but the Mac the person approved at', async () => {
  const aid = crypto.randomBytes(16).toString('base64url'), id = 'reqBrowser01';
  const st = await A.approvalStart();
  const evil = crypto.generateKeyPairSync('x25519');
  const M = Buffer.from(evil.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const ss = crypto.diffieHellman({ privateKey: evil.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: B.b64u(st.B) }, format: 'jwk' }) });
  const theirs = relay.approvalKeys(ss, aid, id, Buffer.from(st.B), M);
  const sealed = relay.sealFor(theirs.key, aid, id, crypto.randomBytes(32));
  const keys = await A.approvalKeys(st.eph, aid, id, st.B, new Uint8Array(M));
  // Nobody typed anything, or typed the code the browser itself shows: refused.
  for (const typed of ['', keys.sas, '000000']) await assert.rejects(A.acceptSealed(keys, aid, id, sealed, typed), /isn't the code your Mac printed/);
});

test('signing in again to the same account keeps the account key; another account asks first', () => {
  assert.equal(A.afterSignin(null, { aid: 'a' }), 'fresh');
  assert.equal(A.afterSignin({ session: 's', aid: 'a', ak: 'k' }, { aid: 'a' }), 'keep');
  assert.equal(A.afterSignin({ session: 's', aid: 'a', ak: 'k' }, { aid: 'b' }), 'ask');
  assert.equal(A.afterSignin({ session: 's', aid: 'a', ak: null }, { aid: 'b' }), 'ask');
});

test('the proof of the account key is fixed for a key and different for another', async () => {
  const ak = crypto.randomBytes(32);
  assert.equal(await A.authProof(ak), await A.authProof(Buffer.from(ak)));
  assert.notEqual(await A.authProof(ak), await A.authProof(crypto.randomBytes(32)));
  assert.match(await A.authProof(ak), /^[A-Za-z0-9_-]{43}$/);
});

test('a passkey\'s PRF output opens the wrapped account key; another one doesn\'t', async () => {
  const ak = crypto.randomBytes(32), prf = crypto.randomBytes(32);
  const w = await A.wrapAk(prf, ak);
  assert.deepEqual(Buffer.from(await A.unwrapAk(prf, w)), ak);
  await assert.rejects(A.unwrapAk(crypto.randomBytes(32), w), /doesn't open/);
});

test('dibs connect explains every way to connect, and dibs connect --remove takes the Mac off an account', async () => {
  const menu = sync(HOME, ['connect']).out;
  for (const w of ['this browser', 'a phone', 'your dibs account', 'another Claude account', 'another machine', 'dibs connect --list']) assert.ok(menu.includes(w), w);
  const { s } = await joined();
  const r = sync(HOME, ['connect', '--remove', s.aid.slice(0, 8)]);
  assert.match(r.out, /Took this Mac off that dibs account/);
  assert.ok(!relay.load().accounts[s.aid]);
  const acc = sync(HOME, ['connect', '--account']);
  assert.match(acc.out, /\/account#join=/);
  assert.match(acc.out, /One use, until \d/);
});
