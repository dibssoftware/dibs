// The code index's bookkeeping, kept apart from the Durable Object around it (index.js
// CodeIndex) so it runs under node --test with a Map for storage (test/codebook.test.mjs).
//
// What it stores, and nothing else:
//   c:<hash>  { mid, exp }        the index hash of one live sign-in code, and its machine
//   m:<mid>   { hs, exp }         which hashes that machine listed, until the last one expires
//   r:<R>     { mid, b, exp, n }  a pairing code's drop: the box sealed under the code's last 8
//                                 characters, which never reach the relay (src/relay.mjs
//                                 CROCKFORD), and how many times it's been handed out
//   rm:<mid>  { rs, exp }         which drops that machine listed
// Every entry carries its expiry, at most CODE_LIFE ahead, and the sweep removes every kind,
// so a Mac that lists codes and never comes back leaves nothing behind.

// Sign-in codes are 10 minutes long; an entry never outlives that, whatever the Mac says.
export const CODE_LIFE = 10 * 60e3;
// Live sign-in codes one machine may list at once (src/relay.mjs MAX_CODES).
export const MAX_CODES = 10;
// Lookups: per address, and in total for an address's second and later tries, a minute.
// Each miss is a guess at every dibs user's live codes at once, so both are tight; a person
// signs in once or twice.
export const LOOKUPS_PER_IP = 10;
export const LOOKUPS_GLOBAL = 300;
// Past this many addresses in memory, the ones quiet for a minute are dropped.
const PRUNE_AT = 50000;
const MID = /^[A-Za-z0-9_-]{22}$/;
const HASH = /^[A-Za-z0-9_-]{43}$/;
// Pairing code drops one machine may list at once (src/relay.mjs MAX_PAIRS).
export const MAX_DROPS = 5;
// Each box is handed out this many times at most. A person mistyping the last 8 characters never
// fetches again (the page keeps the box), so 3 covers a reload or two; a guesser who hits a live
// drop name can't keep fetching it.
export const DROP_FETCHES = 3;
// A drop name: the code's first 4 Crockford base32 characters.
export const DROP_NAME = /^[0-9A-HJKMNP-TV-Z]{4}$/;
// iv, the link's fragment (110 characters) and the tag, base64url, with room to spare.
const BOX = /^[A-Za-z0-9_-]{100,400}$/;

// A per-address and global limiter over the last minute. The global cap stops an address's
// second and later tries, never its first in a minute: a flood from many addresses can't lock
// out a person typing their code once.
function limiter(perIp, global) {
  const tries = new Map();
  let all = [];
  return (ip, t) => {
    const mine = (tries.get(ip) || []).filter(x => t - x < 60e3);
    all = all.filter(x => t - x < 60e3);
    if (mine.length >= perIp || (mine.length && all.length >= global)) return false;
    mine.push(t);
    tries.set(ip, mine);
    all.push(t);
    if (tries.size > PRUNE_AT) for (const [k, v] of tries) if (!v.some(x => t - x < 60e3)) tries.delete(k);
    return true;
  };
}

export class CodeBook {
  // storage: get, put, delete, list({prefix}) -> Map, all async (a Durable Object's storage).
  constructor(storage, { perIp = LOOKUPS_PER_IP, global = LOOKUPS_GLOBAL } = {}) {
    this.storage = storage;
    this.lookup = limiter(perIp, global);
    this.fetches = limiter(perIp, global);
  }

  // A machine's whole list of live codes, replacing the one before. Returns when the next
  // sweep is due (0 for none), for the alarm.
  async set(mid, list, t = Date.now()) {
    if (typeof mid !== 'string' || !MID.test(mid)) return null;
    const s = this.storage;
    const before = await s.get(`m:${mid}`);
    const old = Array.isArray(before) ? before : before?.hs || [];
    const codes = (Array.isArray(list) ? list : []).filter(c => typeof c?.h === 'string' && HASH.test(c.h) && Number.isFinite(c.exp))
      .slice(0, MAX_CODES).map(c => ({ h: c.h, exp: Math.min(c.exp, t + CODE_LIFE) })).filter(c => c.exp > t);
    const mine = new Set(codes.map(c => c.h));
    for (const h of old) if (!mine.has(h)) {
      // Only this machine's own entries: a Mac can't drop another's.
      const e = await s.get(`c:${h}`);
      if (e?.mid === mid) await s.delete(`c:${h}`);
    }
    for (const c of codes) {
      const e = await s.get(`c:${c.h}`);
      if (!e || e.mid === mid || e.exp <= t) await s.put(`c:${c.h}`, { mid, exp: c.exp });
    }
    if (!codes.length) { await s.delete(`m:${mid}`); return 0; }
    const exp = Math.max(...codes.map(c => c.exp));
    await s.put(`m:${mid}`, { hs: codes.map(c => c.h), exp });
    return Math.min(...codes.map(c => c.exp));
  }

  // { mid } for a live code's hash, { mid: null } for anything else (malformed, unknown, expired,
  // spent: one answer), or { limited: true }.
  async find(h, ip, t = Date.now()) {
    if (!this.lookup(ip, t)) return { limited: true };
    const e = typeof h === 'string' && HASH.test(h) ? await this.storage.get(`c:${h}`) : null;
    return { mid: e && e.exp > t ? e.mid : null };
  }

  // A code its Mac just accepted: gone at once, not on the Mac's next update.
  async drop(h, mid) {
    const e = typeof h === 'string' ? await this.storage.get(`c:${h}`) : null;
    if (e && e.mid === mid) await this.storage.delete(`c:${h}`);
  }

  // A machine's whole list of open pairing code drops, replacing the one before: [{ r, b, exp }].
  // A drop name another machine holds stays theirs. Returns { next, ok, taken }: when the next
  // sweep is due (0 for none), the names now held for this machine, and the ones another holds,
  // which the machine is told so it can pick fresh codes (src/relay.mjs pairRemote).
  async setDrops(mid, list, t = Date.now()) {
    if (typeof mid !== 'string' || !MID.test(mid)) return null;
    const s = this.storage;
    const old = (await s.get(`rm:${mid}`))?.rs || [];
    const drops = (Array.isArray(list) ? list : []).filter(d => typeof d?.r === 'string' && DROP_NAME.test(d.r) && typeof d.b === 'string' && BOX.test(d.b) && Number.isFinite(d.exp))
      .slice(0, MAX_DROPS).map(d => ({ r: d.r, b: d.b, exp: Math.min(d.exp, t + CODE_LIFE) })).filter(d => d.exp > t);
    const mine = new Set(drops.map(d => d.r));
    for (const r of old) if (!mine.has(r)) {
      const e = await s.get(`r:${r}`);
      if (e?.mid === mid) await s.delete(`r:${r}`);
    }
    const kept = [], taken = [];
    for (const d of drops) {
      const e = await s.get(`r:${d.r}`);
      if (e && e.mid !== mid && e.exp > t) { taken.push(d.r); continue; }
      kept.push(d);
      // The same box listed again keeps its count: listing never earns more fetches.
      if (!(e && e.mid === mid && e.b === d.b)) await s.put(`r:${d.r}`, { mid, b: d.b, exp: d.exp, n: 0 });
    }
    const ok = kept.map(d => d.r);
    if (!kept.length) { await s.delete(`rm:${mid}`); return { next: 0, ok, taken }; }
    await s.put(`rm:${mid}`, { rs: ok, exp: Math.max(...kept.map(d => d.exp)) });
    return { next: Math.min(...kept.map(d => d.exp)), ok, taken };
  }

  // { box } for a live drop with fetches left, { box: null } for anything else (malformed,
  // unknown, expired, fetched out: one answer), or { limited: true }.
  async takeDrop(r, ip, t = Date.now()) {
    if (!this.fetches(ip, t)) return { limited: true };
    const e = typeof r === 'string' && DROP_NAME.test(r) ? await this.storage.get(`r:${r}`) : null;
    if (!e || e.exp <= t || e.n >= DROP_FETCHES) return { box: null };
    await this.storage.put(`r:${r}`, { ...e, n: e.n + 1 });
    return { box: e.b };
  }

  // Removes every expired entry, codes, drops and machine lists alike. Returns when the next is due (0 for none).
  async sweep(t = Date.now()) {
    let next = 0;
    for (const prefix of ['c:', 'm:', 'r:', 'rm:']) {
      for (const [k, e] of await this.storage.list({ prefix })) {
        // A machine list from before lists carried their expiry: no date, so it goes.
        const exp = Array.isArray(e) ? 0 : e?.exp || 0;
        if (exp <= t) await this.storage.delete(k);
        else next = next ? Math.min(next, exp) : exp;
      }
    }
    return next;
  }
}
