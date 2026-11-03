// A software passkey for the tests: real P-256 and Ed25519 keys, real CBOR, real signatures.
import { b64u } from '../src/webauthn.js';

const enc = new TextEncoder();
const sha = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// The CBOR an authenticator writes: just enough of an encoder for the test.
function enc0(major, n) {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
export function cborEnc(v) {
  if (typeof v === 'number') return v >= 0 ? enc0(0, v) : enc0(1, -1 - v);
  if (v instanceof Uint8Array) return cat(enc0(2, v.length), v);
  if (typeof v === 'string') { const b = enc.encode(v); return cat(enc0(3, b.length), b); }
  if (v instanceof Map) return cat(enc0(5, v.size), ...[...v].flatMap(([k, x]) => [cborEnc(k), cborEnc(x)]));
  throw new Error('test encoder');
}
// Raw r||s to DER, as a real authenticator signs.
export function rawToDer(raw) {
  const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(Uint8Array.of(0), v); return cat(Uint8Array.of(2, v.length), v); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

export const RP = { rpId: 'app.dibs.cc', origin: 'https://app.dibs.cc' };

export async function authenticator(alg = 'ES256') {
  const pair = alg === 'ES256'
    ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const x = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (jwk.x.length % 4)) % 4)), c => c.charCodeAt(0));
  const cose = alg === 'ES256'
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, Uint8Array.from(atob(jwk.y.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (jwk.y.length % 4)) % 4)), c => c.charCodeAt(0))]])
    : new Map([[1, 1], [3, -8], [-1, 6], [-2, x]]);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  let count = 0;
  const ad = async (rpId, flags, extra = new Uint8Array()) => cat(await sha(enc.encode(rpId)), Uint8Array.of(flags), Uint8Array.of(0, 0, 0, count), extra);
  return {
    async create({ challenge, origin = RP.origin, rpId = RP.rpId, flags = 0x45 }) {
      const cd = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      const attested = cat(new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cborEnc(cose));
      const ao = cborEnc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', await ad(rpId, flags, attested)]]));
      return { clientDataJSON: b64u(cd), attestationObject: b64u(ao) };
    },
    async get({ challenge, origin = RP.origin, rpId = RP.rpId, flags = 0x05, bump = 1 }) {
      count += bump;
      const cd = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const a = await ad(rpId, flags);
      const signed = cat(a, await sha(cd));
      const sig = alg === 'ES256'
        ? rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed)))
        : new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, signed));
      return { clientDataJSON: b64u(cd), authenticatorData: b64u(a), signature: b64u(sig) };
    },
  };
}

