// WebAuthn for dibs accounts, by hand and with WebCrypto only (no libraries): the CBOR this
// needs, the authenticator data, COSE keys (ES256 and EdDSA), and checking a registration and a
// sign-in. Attestation isn't checked (dibs asks for "none"): a passkey proves the same person
// comes back, not which make of authenticator they hold.
//
// Runs in the Worker and under node --test (test/webauthn.test.mjs): both have crypto.subtle.

const enc = new TextEncoder(), dec = new TextDecoder();
export const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0)); } catch { return null; }
}
const sha256 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const fail = msg => { throw Object.assign(new Error(msg), { webauthn: true }); };

// CBOR (RFC 8949), the subset WebAuthn uses: integers, byte and text strings, arrays, maps,
// false, true, null. Anything else (floats, tags, indefinite lengths) is refused.
export function cbor(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let i = 0;
  const need = n => { if (i + n > b.length) fail('CBOR ran out'); };
  const len = info => {
    if (info < 24) return info;
    const n = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!n) fail('CBOR length not supported');
    need(n);
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + b[i++];
    if (!Number.isSafeInteger(v)) fail('CBOR number too big');
    return v;
  };
  const item = depth => {
    if (depth > 16) fail('CBOR nested too deep');
    need(1);
    const ib = b[i++], major = ib >> 5, info = ib & 31;
    if (major === 0) return len(info);
    if (major === 1) return -1 - len(info);
    if (major === 2) { const n = len(info); need(n); const v = b.slice(i, i + n); i += n; return v; }
    if (major === 3) { const n = len(info); need(n); const v = dec.decode(b.subarray(i, i + n)); i += n; return v; }
    if (major === 4) { const n = len(info); if (n > 1024) fail('CBOR array too long'); return Array.from({ length: n }, () => item(depth + 1)); }
    if (major === 5) {
      const n = len(info);
      if (n > 1024) fail('CBOR map too long');
      const m = new Map();
      for (let k = 0; k < n; k++) { const key = item(depth + 1); m.set(key, item(depth + 1)); }
      return m;
    }
    if (major === 7 && info === 20) return false;
    if (major === 7 && info === 21) return true;
    if (major === 7 && info === 22) return null;
    return fail('CBOR type not supported');
  };
  const v = item(0);
  return { value: v, end: i };
}

// Authenticator data: rpIdHash, flags, signCount, and on registration the credential.
export function authData(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 37) fail('authenticator data too short');
  const out = { rpIdHash: b.slice(0, 32), flags: b[32], up: !!(b[32] & 1), uv: !!(b[32] & 4), at: !!(b[32] & 64),
    signCount: new DataView(b.buffer, b.byteOffset + 33, 4).getUint32(0), raw: b };
  if (out.at) {
    if (b.length < 55) fail('authenticator data has no credential');
    const n = new DataView(b.buffer, b.byteOffset + 53, 2).getUint16(0);
    if (55 + n > b.length) fail('credential id runs past the data');
    out.credId = b.slice(55, 55 + n);
    const key = cbor(b.slice(55 + n));
    out.coseKey = key.value;
  }
  return out;
}

// A COSE key as something WebCrypto can verify with, and as JWK to store.
export function coseToJwk(m) {
  if (!(m instanceof Map)) fail('not a COSE key');
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) {
    const x = m.get(-2), y = m.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) fail('bad P-256 key');
    return { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) };
  }
  if (kty === 1 && alg === -8 && m.get(-1) === 6) {
    const x = m.get(-2);
    if (!(x instanceof Uint8Array) || x.length !== 32) fail('bad Ed25519 key');
    return { kty: 'OKP', crv: 'Ed25519', x: b64u(x) };
  }
  return fail('only ES256 and EdDSA passkeys are supported');
}
const importJwk = jwk => (jwk.kty === 'EC'
  ? crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  : crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'Ed25519' }, false, ['verify']));

// An ECDSA signature from a passkey is DER; WebCrypto takes r and s, 32 bytes each.
export function derToRaw(der) {
  const d = new Uint8Array(der);
  let i = 0;
  const take = () => {
    if (d[i++] !== 0x02) fail('bad ECDSA signature');
    const n = d[i++];
    let v = d.slice(i, i + n);
    i += n;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) fail('bad ECDSA signature');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  if (d[i++] !== 0x30) fail('bad ECDSA signature');
  if (d[i] & 0x80) i += 1 + (d[i] & 0x7f); else i++;
  const r = take(), s = take();
  const raw = new Uint8Array(64);
  raw.set(r, 0); raw.set(s, 32);
  return raw;
}

function client(json, type, challenge, origin) {
  let c;
  try { c = JSON.parse(dec.decode(json)); } catch { fail('client data is not JSON'); }
  if (c.type !== type) fail(`client data is not ${type}`);
  if (c.challenge !== challenge) fail('the challenge does not match');
  if (c.origin !== origin) fail(`signed for ${c.origin}, not ${origin}`);
  if (c.crossOrigin === true) fail('signed from another origin');
  return c;
}

// A registration (navigator.credentials.create): the credential's id and public key, once the
// challenge, origin, relying party and user presence check out.
export async function register({ clientDataJSON, attestationObject }, { challenge, origin, rpId }) {
  const cd = unb64u(clientDataJSON), ao = unb64u(attestationObject);
  if (!cd || !ao) fail('missing registration data');
  client(cd, 'webauthn.create', challenge, origin);
  const att = cbor(ao).value;
  if (!(att instanceof Map) || !(att.get('authData') instanceof Uint8Array)) fail('bad attestation object');
  const ad = authData(att.get('authData'));
  if (!same(ad.rpIdHash, await sha256(enc.encode(rpId)))) fail('registered for another site');
  if (!ad.up) fail('the person was not present');
  if (!ad.at || !ad.credId) fail('no credential in the registration');
  if (ad.credId.length > 1023) fail('credential id too long');
  const jwk = coseToJwk(ad.coseKey);
  await importJwk(jwk);
  return { id: b64u(ad.credId), jwk, signCount: ad.signCount, uv: ad.uv };
}

// A sign-in (navigator.credentials.get) against a stored credential: the new sign count, once
// the signature, challenge, origin, relying party and presence check out, and the count went up.
export async function verify({ clientDataJSON, authenticatorData, signature }, cred, { challenge, origin, rpId }) {
  const cd = unb64u(clientDataJSON), adb = unb64u(authenticatorData), sig = unb64u(signature);
  if (!cd || !adb || !sig) fail('missing sign-in data');
  client(cd, 'webauthn.get', challenge, origin);
  const ad = authData(adb);
  if (!same(ad.rpIdHash, await sha256(enc.encode(rpId)))) fail('signed for another site');
  if (!ad.up) fail('the person was not present');
  const signed = new Uint8Array(adb.length + 32);
  signed.set(adb, 0);
  signed.set(await sha256(cd), adb.length);
  const key = await importJwk(cred.jwk);
  const ok = cred.jwk.kty === 'EC'
    ? await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), signed)
    : await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, signed);
  if (!ok) fail('the signature does not verify');
  // A counter that didn't go up means a copied authenticator; zero on both sides means it keeps none.
  if ((ad.signCount || cred.signCount) && ad.signCount <= cred.signCount) fail('the sign count went backwards: this passkey may have been copied');
  return { signCount: ad.signCount, uv: ad.uv };
}
