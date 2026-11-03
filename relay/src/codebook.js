// The code index's bookkeeping, kept apart from the Durable Object around it (index.js
// CodeIndex) so it runs under node --test with a Map for storage (test/codebook.test.mjs).
//
// What it stores, and nothing else:
//   c:<hash>  { mid, exp }   the index hash of one live sign-in code, and its machine
//   m:<mid>   { hs, exp }    which hashes that machine listed, until the last one expires
// Every entry carries its expiry, at most CODE_LIFE ahead, and the sweep removes both kinds,
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

export class CodeBook {
  // storage: get, put, delete, list({prefix}) -> Map, all async (a Durable Object's storage).
  constructor(storage, { perIp = LOOKUPS_PER_IP, global = LOOKUPS_GLOBAL } = {}) {
    this.storage = storage;
    this.perIp = perIp;
    this.global = global;
    this.tries = new Map();
    this.all = [];
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
    const mine = (this.tries.get(ip) || []).filter(x => t - x < 60e3);
    this.all = this.all.filter(x => t - x < 60e3);
    // The global cap stops an address's second and later tries, never its first in a minute:
    // a flood from many addresses can't lock out a person typing their code once.
    if (mine.length >= this.perIp || (mine.length && this.all.length >= this.global)) return { limited: true };
    mine.push(t);
    this.tries.set(ip, mine);
    this.all.push(t);
    if (this.tries.size > PRUNE_AT) for (const [k, v] of this.tries) if (!v.some(x => t - x < 60e3)) this.tries.delete(k);
    const e = typeof h === 'string' && HASH.test(h) ? await this.storage.get(`c:${h}`) : null;
    return { mid: e && e.exp > t ? e.mid : null };
  }

  // A code its Mac just accepted: gone at once, not on the Mac's next update.
  async drop(h, mid) {
    const e = typeof h === 'string' ? await this.storage.get(`c:${h}`) : null;
    if (e && e.mid === mid) await this.storage.delete(`c:${h}`);
  }

  // Removes every expired entry, codes and machine lists alike. Returns when the next is due (0 for none).
  async sweep(t = Date.now()) {
    let next = 0;
    for (const prefix of ['c:', 'm:']) {
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
