// Who may talk to the coordinator, and where a job may go.
//
// The coordinator keeps a token per machine in ~/.dibs/machines.json (only
// their hashes), so each machine can be removed on its own and can't speak as
// another. The token in its own remote.json is the admin token: it works only
// over loopback, so it never helps anyone on another machine.
//
// A project says where it may go with a .dibs.json file, {"stayOn": ["mini"]},
// in its folder or any folder above it. Every clone carries the rule.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './config.mjs';
import { now } from './util.mjs';

export const MACHINES = path.join(HOME, 'machines.json');
export const NAME = /^[A-Za-z0-9][\w.-]{0,62}$/;
const RULE_FILE = '.dibs.json';

// dibs pair --machine: a one-time code a new machine joins with. The same codebook as
// dibs pair's: 8 Crockford base32 characters, 40 bits, 10 minutes, one use.
const CODE_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;
export const CODE_LIFE = 10 * 6e4;
export const normCode = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
// What a word on `dibs join`'s line looks like when it's a code, not an address: ABCD-EFGH.
export const isCode = s => /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(String(s || ''));
export function newCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
// The coordinator keeps this, not the code.
export const codeKey = code => crypto.createHash('sha256').update(`dibs-pair-machine-v1\0${normCode(code)}`).digest();
// A coordinator proves it holds the code before the joiner sends it: HMAC over both
// sides' random nonces. Anything else answering on the network learns only a nonce.
export const codeProof = (key, nj, nc) => crypto.createHmac('sha256', key).update(`dibs-pair-machine-proof-v1\0${nj}\0${nc}`).digest('base64url');

const hash = t => crypto.createHash('sha256').update(String(t)).digest();
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const loopback = addr => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));

export function loadRegistry(file = MACHINES) {
  let r = {};
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`${file} can't be read (${e.message}). Fix or delete it; deleting it removes every invited machine`); }
  return { machines: r.machines || {}, removed: r.removed || {}, limits: r.limits || {}, sends: r.sends || {} };
}

export function makeTrust({ token, file = MACHINES }) {
  const reg = loadRegistry(file);
  const admin = hash(token);
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  };
  const t = {
    reg,
    // { admin } or { name, hash } for a good token; { error } otherwise.
    who(req) {
      const got = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!got) return { error: 'no token' };
      const h = hash(got);
      if (same(h, admin)) return loopback(req.socket?.remoteAddress) ? { admin: true }
        : { error: "that is the coordinator's own token, and it only works on the coordinator's machine. On the coordinator, run dibs invite <name> and use the join line it prints" };
      for (const [name, m] of Object.entries(reg.machines)) if (same(h, Buffer.from(m.hash, 'hex'))) return { name, hash: m.hash };
      for (const [name, r] of Object.entries(reg.removed))
        if (r.hash && same(h, Buffer.from(r.hash, 'hex'))) return { error: r.why || `${name} was removed from the group` };
      return { error: 'bad token' };
    },
    // Still the token this machine has now (not kicked or re-invited since).
    current: who => who.admin || reg.machines[who.name]?.hash === who.hash,
    has: name => !!reg.machines[name],
    // extra: { paired } for a machine that joined with a code from dibs pair --machine.
    invite(name, extra = {}) {
      const token = `dibs_${crypto.randomBytes(24).toString('base64url')}`;
      reg.machines[name] = { hash: hash(token).toString('hex'), invited: now(), joined: null, ...extra };
      delete reg.removed[name];
      save();
      return token;
    },
    revoke(name, why) {
      const m = reg.machines[name];
      if (!m) return false;
      reg.removed[name] = { at: now(), hash: m.hash, why };
      delete reg.machines[name];
      save();
      return true;
    },
    // undefined leaves that half as it was; null lifts it.
    limit(name, only, sends) {
      if (only) reg.limits[name] = only; else if (only === null) delete reg.limits[name];
      if (sends) reg.sends[name] = sends; else if (sends === null) delete reg.sends[name];
      save();
    },
    only: name => reg.limits[name] || null,
    // What a machine may send to other machines: a list of resources ([] for nothing), or null for anything.
    sends: name => reg.sends[name] || null,
    joined(name) {
      const m = reg.machines[name];
      if (m && !m.joined) { m.joined = now(); save(); }
    },
  };
  return t;
}

// Why machine w may not run this job (its limit, or the project's rule), or null.
export function allowed(w, need) {
  if (!need.res || w.name === need.from) return null;     // the sender's own machine is always fine
  if (need.stayOn && !need.stayOn.includes(w.name)) return `${need.rule || 'the project rule'}, so not ${w.name}`;
  if (w.only && !need.res.every(r => w.only.includes(r))) return `${w.name} only takes ${w.only.join(', ')} jobs (dibs limit on the coordinator)`;
  return null;
}

// The .dibs.json files that apply to a folder: its own and every one above it.
export function rulesAbove(dir) {
  const found = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const f = path.join(d, RULE_FILE);
    if (fs.existsSync(f)) found.push(f);
    if (path.dirname(d) === d) return found;
  }
}
export const isRuleFile = f => path.basename(f) === RULE_FILE;

// The rule several .dibs.json files make together: a job may go only where all
// of them allow. A file that can't be read keeps the project home.
export function readRules(files) {
  let stayOn = null;
  const used = [], broken = [];
  for (const f of new Set(files)) {
    let list;
    try {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (r.stayOn === undefined) continue;
      if (!Array.isArray(r.stayOn) || !r.stayOn.every(x => typeof x === 'string')) throw new Error('stayOn must be a list of machine names');
      list = r.stayOn;
    } catch (e) { broken.push(`${f} (${e.message})`); list = []; }
    used.push(f);
    stayOn = stayOn ? stayOn.filter(x => list.includes(x)) : [...list];
  }
  if (!stayOn) return { stayOn: null };
  const where = stayOn.length ? `keeps this project on ${stayOn.join(', ')}` : 'keeps this project on the machine it lives on';
  const text = broken.length ? `${broken.join(' and ')} can't be read, so dibs ${where}`
    : `${used.join(' and ')} ${used.length > 1 ? where.replace(/^keeps/, 'keep') : where}`;
  return { stayOn, text };
}

export const ruleAllows = (rule, machine, from) => machine === from || !rule.stayOn || rule.stayOn.includes(machine);
