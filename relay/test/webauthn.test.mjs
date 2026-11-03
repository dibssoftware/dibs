// src/webauthn.js against a software authenticator built here: real P-256 and Ed25519 keys,
// real CBOR, real signatures, so a registration and a sign-in go through every check.
//   node --test test/webauthn.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { register, verify, cbor, derToRaw, b64u } from '../src/webauthn.js';

import { cborEnc, rawToDer, RP, authenticator } from './authenticator.mjs';

for (const alg of ['ES256', 'EdDSA']) {
  test(`${alg}: a passkey registers, then signs in; the count must go up`, async () => {
    const a = await authenticator(alg);
    const cred = await register(await a.create({ challenge: 'c1' }), { ...RP, challenge: 'c1' });
    assert.equal(cred.jwk.kty, alg === 'ES256' ? 'EC' : 'OKP');
    const r = await verify(await a.get({ challenge: 'c2' }), cred, { ...RP, challenge: 'c2' });
    assert.equal(r.signCount, 1);
    await assert.rejects(verify(await a.get({ challenge: 'c3', bump: 0 }), { ...cred, signCount: 1 }, { ...RP, challenge: 'c3' }), /copied/);
  });
}

test('a registration for another site, origin or challenge, or without the person present, is refused', async () => {
  const a = await authenticator();
  await assert.rejects(register(await a.create({ challenge: 'c' }), { ...RP, challenge: 'other' }), /challenge/);
  await assert.rejects(register(await a.create({ challenge: 'c', origin: 'https://evil.example' }), { ...RP, challenge: 'c' }), /evil\.example/);
  await assert.rejects(register(await a.create({ challenge: 'c', rpId: 'evil.example' }), { ...RP, challenge: 'c' }), /another site/);
  await assert.rejects(register(await a.create({ challenge: 'c', flags: 0x44 }), { ...RP, challenge: 'c' }), /not present/);
});

test('a sign-in with a changed signature, data, origin or challenge is refused', async () => {
  const a = await authenticator();
  const cred = await register(await a.create({ challenge: 'c' }), { ...RP, challenge: 'c' });
  const good = await a.get({ challenge: 'd' });
  const flip = s => { const b = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0)); b[b.length - 1] ^= 1; return b64u(b); };
  await assert.rejects(verify({ ...good, signature: flip(good.signature) }, cred, { ...RP, challenge: 'd' }));
  await assert.rejects(verify({ ...good, authenticatorData: flip(good.authenticatorData) }, cred, { ...RP, challenge: 'd' }));
  await assert.rejects(verify(good, cred, { ...RP, challenge: 'e' }), /challenge/);
  await assert.rejects(verify(good, cred, { ...RP, challenge: 'd', origin: 'https://dibs.cc' }), /not https:\/\/dibs\.cc/);
  await assert.rejects(verify(await a.get({ challenge: 'f', flags: 0x04 }), cred, { ...RP, challenge: 'f' }), /not present/);
  // Another passkey's signature on this one's data.
  const b = await authenticator();
  await register(await b.create({ challenge: 'g' }), { ...RP, challenge: 'g' });
  await assert.rejects(verify(await b.get({ challenge: 'h' }), cred, { ...RP, challenge: 'h' }), /does not verify/);
});

test('CBOR: what WebAuthn uses decodes; floats, tags and truncation are refused', () => {
  const m = cbor(cborEnc(new Map([[1, 2], [-1, 'x'], ['k', Uint8Array.of(1, 2)]]))).value;
  assert.equal(m.get(1), 2);
  assert.equal(m.get(-1), 'x');
  assert.deepEqual([...m.get('k')], [1, 2]);
  assert.throws(() => cbor(Uint8Array.of(0xf9, 0, 0)));
  assert.throws(() => cbor(Uint8Array.of(0xc1, 0)));
  assert.throws(() => cbor(Uint8Array.of(0x58, 10, 1)));
});

test('a DER signature turns into r and s, leading zeros and all', () => {
  const raw = crypto.getRandomValues(new Uint8Array(64));
  raw[0] = 0x80; raw[32] = 0x00; raw[33] = 0x01;
  assert.deepEqual([...derToRaw(rawToDer(raw))], [...raw]);
});
