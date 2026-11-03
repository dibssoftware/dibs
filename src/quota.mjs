// Rate-limit budgets shared machine-wide. `dibs run quota:asc --cost 3 -- cmd`
// takes 3 tokens from the asc bucket when cmd starts, and waits in line while
// there aren't enough, so scripts calling one API wait their turn instead of
// getting 429s. config.json: "quotas": { "asc": { "per": "1h", "limit": 300 } }.
// A bucket holds at most `limit` tokens and refills `limit` every `per`,
// smoothly. Buckets live in state.json under quotas: { name: { tokens, at } }.
import { byRank, sum } from './schedule.mjs';
import { dur, now } from './util.mjs';

export const QUOTA = 'quota:';
export const isQuota = r => r.startsWith(QUOTA);
const names = res => res.filter(isQuota).map(r => r.slice(QUOTA.length));

// A bucket's settings, or a sentence saying what's wrong with them.
export function bucketCfg(cfg, name) {
  const q = cfg.quotas?.[name];
  if (!q) return { error: `quota:${name} isn't configured. Add it to config.json: "quotas": { "${name}": { "per": "1h", "limit": 300 } }` };
  const m = String(q.per ?? '').trim().match(/^([\d.]+)\s*(ms|s|m|h|d)$/);
  const per = typeof q.per === 'number' ? q.per : m && parseFloat(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]];
  if (!(per > 0) || !(q.limit > 0)) return { error: `quotas.${name} in config.json needs "per" (like "1h" or "60s") and a "limit" above 0` };
  return { per, limit: q.limit };
}

// Tokens in a bucket at t. A bucket nobody has used yet is full.
export function level(b, q, t = now()) {
  if (!b) return q.limit;
  return Math.min(q.limit, b.tokens + Math.max(0, t - b.at) * q.limit / q.per);
}

// How long until a bucket holding `have` tokens holds `need`.
export const refillIn = (have, need, q) => (have >= need ? 0 : Math.ceil((need - have) * q.per / q.limit));

const cost = x => x.cost ?? 1;
const round = n => Math.floor(n * 10) / 10;

// Checked before a request waits at all: a quota that can't be read, or a cost
// the bucket can never hold, would wait forever.
export function quotaProblem(cfg, res, c = 1) {
  for (const name of names(res)) {
    const q = bucketCfg(cfg, name);
    if (q.error) return q.error;
    if (c > q.limit) return `--cost ${c} is more than quota:${name} ever holds (${q.limit})`;
  }
  return null;
}

// Why a waiter can't take its tokens yet, or null. Waiters ahead of it for the
// same bucket are served first, so a big request isn't passed forever by small ones.
export function quotaBlock(s, me, cfg, hist, t = now()) {
  const before = byRank(hist, t);
  for (const name of names(me.res)) {
    const q = bucketCfg(cfg, name);
    if (q.error) continue;
    const have = level(s.quotas?.[name], q, t);
    const ahead = s.queue.filter(x => x.pid && x.id !== me.id && x.res.includes(QUOTA + name) && before(x, me) < 0);
    const need = cost(me) + sum(ahead, cost);
    if (have >= need) continue;
    return { ok: false, rule: 'quota', on: QUOTA + name, in: refillIn(have, need, q), have: round(have), limit: q.limit,
      why: `quota:${name} has ${round(have)} of ${q.limit} left (refills ${q.limit} per ${dur(q.per)}), you need ${cost(me)}`
        + `${ahead.length ? ` after ${need - cost(me)} for ${ahead.length} ahead of you` : ''}: enough in ~${dur(refillIn(have, need, q))}` };
  }
  return null;
}

// Take a starting request's tokens. Called in the same state change that gives it the lease.
export function takeQuota(s, me, cfg, t = now()) {
  for (const name of names(me.res)) {
    const q = bucketCfg(cfg, name);
    if (q.error) continue;
    s.quotas ||= {};
    s.quotas[name] = { tokens: level(s.quotas[name], q, t) - cost(me), at: t };
  }
}

// For the board: every configured bucket and what's left in it.
export function quotasNow(s, cfg, t = now()) {
  return Object.keys(cfg.quotas || {}).map(name => {
    const q = bucketCfg(cfg, name);
    return q.error ? { name, error: q.error } : { name, left: round(level(s.quotas?.[name], q, t)), limit: q.limit, per: q.per };
  });
}
