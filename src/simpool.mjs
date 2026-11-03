// The simulator pool: a resource with `pool` settings (sim-own by default)
// hands each lease its own simulator. dibs creates the devices, names them
// dibs-pool-N, keeps them between leases, and only ever deletes those.
//
// Devices live in the state file as s.pool, so taking one is atomic with the
// lease that uses it: { name, udid, res, type, runtime, lease, who, booted,
// lastWho, lastUsed, created }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resCfg, machine, paths, HOME, POOL_DEFAULTS } from './config.mjs';
import { withState } from './state.mjs';
import { simctl } from './simctl.mjs';
import { bytes, gb, size, dur, die, say, now } from './util.mjs';

export const PREFIX = 'dibs-pool-';
const ERASE = new Set(['other-agent', 'always', 'never']);
// Device types tried in order when none is configured: an iPhone 17-class phone.
const PREFERRED = ['iPhone-17', 'iPhone-17-Pro', 'iPhone-16', 'iPhone-16-Pro'];

const poolOf = (cfg, r) => { const p = resCfg(cfg, r).pool; return p ? { ...POOL_DEFAULTS, ...p } : null; };
const poolRes = cfg => Object.keys(cfg.resources).filter(r => cfg.resources[r].pool);
const ours = name => typeof name === 'string' && name.startsWith(PREFIX);

// Every device this DIBS_HOME created, one udid a line. Another dibs on the
// same Mac (a second DIBS_HOME, a trial install) names its devices
// dibs-pool-N too, so a pool device the state doesn't know is adopted or
// pruned only if it's in this list. The first time, the list starts as the
// devices the state already tracks.
const MADE = path.join(HOME, 'pool-made');
function madeHere() {
  try { return new Set(fs.readFileSync(MADE, 'utf8').split('\n').filter(Boolean)); } catch (e) { if (e.code !== 'ENOENT') return new Set(); }
  let pool = [];
  try { pool = JSON.parse(fs.readFileSync(paths.state, 'utf8')).pool || []; } catch {}
  const seed = pool.map(d => d.udid).filter(Boolean);
  try { fs.writeFileSync(MADE, seed.map(u => `${u}\n`).join('')); } catch {}
  return new Set(seed);
}
const noteMade = udid => { madeHere(); try { fs.appendFileSync(MADE, `${udid}\n`); } catch {} };

const ver = v => String(v).split('.').map(Number);
const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const isIOS = r => r.platform ? r.platform === 'iOS' : /^iOS /.test(r.name || '');

// The device type and runtime new devices get: what the config names, or the
// newest installed iOS runtime and an iPhone 17-class phone it supports.
export function spec(pool, ctl = simctl()) {
  const rts = ctl.runtimes().filter(r => r.isAvailable !== false && isIOS(r));
  const want = pool.runtime;
  const rt = want ? rts.find(r => [r.identifier, r.name, r.version].includes(want)) : rts.sort((a, b) => newer(b.version, a.version))[0];
  if (!rt) die(want ? `no installed iOS runtime matches "${want}". Installed: ${rts.map(r => r.name).join(', ') || 'none'}`
    : 'no iOS simulator runtime is installed (Xcode > Settings > Components)');
  const types = rt.supportedDeviceTypes || [];
  const dt = pool.deviceType
    ? types.find(t => [t.identifier, t.name].includes(pool.deviceType)) || { identifier: pool.deviceType, name: pool.deviceType }
    : PREFERRED.map(p => types.find(t => t.identifier.endsWith(`.${p}`))).find(Boolean) || types.filter(t => t.productFamily === 'iPhone').pop();
  if (!dt) die(`${rt.name} supports no iPhone device type; set pool.deviceType in the config`);
  return { runtime: rt.identifier, runtimeName: rt.name, type: dt.identifier, typeName: dt.name };
}

// Pick a free device for a lease, or a name for a new one. Called inside
// withState. Prefers the device this agent used last (no erase needed), then
// one nobody has used, then the one idle longest.
export function claim(s, lease, res, sp, policy = 'other-agent') {
  s.pool ||= [];
  const fits = d => !d.lease && d.res === res && d.type === sp.type && d.runtime === sp.runtime;
  const free = s.pool.filter(fits).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  let dev = free.find(d => d.lastWho === lease.who) || free.find(d => !d.lastWho) || free[0];
  const create = !dev;
  if (create) {
    let n = 1;
    while (s.pool.some(d => d.name === `${PREFIX}${n}`)) n++;
    dev = { name: `${PREFIX}${n}`, udid: null, res, type: sp.type, runtime: sp.runtime, created: now() };
    s.pool.push(dev);
  }
  const erase = !create && !!dev.lastWho && (policy === 'always' || (policy === 'other-agent' && dev.lastWho !== lease.who));
  Object.assign(dev, { lease: lease.id, who: lease.who, since: now() });
  return { dev: { ...dev }, create, erase };
}

// Free the devices of leases that are gone, and shut down any free device
// still booted. Called on every state read, inside the lock, so it only
// starts shutdowns and never waits for one.
export function reapPool(s, ctl = null) {
  if (!s.pool?.length) return;
  const live = new Set(s.leases.map(l => l.id));
  for (const d of s.pool) {
    if (d.lease && !live.has(d.lease)) {
      Object.assign(d, { lease: null, lastWho: d.who, lastUsed: now() });
      if (d.udid) d.booted = true;   // it may have booted before its lease died
    }
    if (!d.lease && d.booted && d.udid) { (ctl ||= simctl()).shutdownLater(d.udid); d.booted = false; }
  }
}

// Memory one more simulator needs, and how many fit now. Devices still
// booting haven't taken their memory yet, so they're counted here.
export function poolRoom(s, cfg, r, m = machine()) {
  const per = bytes(poolOf(cfg, r).perSim);
  const total = m.memTotal || os.totalmem();
  const keep = total * cfg.minFreeMem / 100;
  const booting = (s.pool || []).filter(d => d.res === r && d.lease && !d.booted).length;
  const free = total * m.memFree / 100 - booting * per;
  return { per, keep, free, booting, fits: Math.max(0, Math.floor((free - keep) / per)) };
}

// For verdict(): a pool resource waits while booting another simulator would
// push the machine under minFreeMem. Like the ram rule, it doesn't apply when
// nothing else holds anything, since then waiting can't free memory.
export function poolBlock(s, me, cfg, mine, m = machine()) {
  if (!s.leases.length) return null;
  for (const r of me.res) {
    if (!resCfg(cfg, r).pool || mine.has(r)) continue;
    const room = poolRoom(s, cfg, r, m);
    if (room.fits < 1)
      return { rule: 'ram', why: `${r}: ${gb(Math.max(room.free, 0))} memory free${room.booting ? ` (${room.booting} still booting)` : ''}, another simulator needs ${gb(room.per)} plus the ${gb(room.keep)} kept free`, on: r,
        free: Math.max(room.free, 0), need: room.per + room.keep };
  }
  return null;
}

// Memory a pool lease adds on top of what the job itself asked for with --mem.
export const simMem = (cfg, res) => Math.max(0, ...res.map(r => (resCfg(cfg, r).pool ? bytes(poolOf(cfg, r).perSim) : 0)));

// What a job asks for: --mem, --cpu and --disk, or the most any of its
// resources costs. A resource's own mem already counts its simulator; --mem
// names the job's own need, so a pool simulator comes on top of it. Everything
// that sizes a job uses this: dibs run and hold, dibs when, and --anywhere.
export function jobSize(cfg, res, o = {}) {
  const most = f => Math.max(...res.map(r => f(resCfg(cfg, r))));
  return {
    mem: o.mem != null ? o.mem + simMem(cfg, res) : most(c => bytes(c.mem)),
    cpu: o.cpu ?? most(c => c.cpu ?? 1),
    disk: o.disk ?? most(c => bytes(c.disk || 0)),
  };
}

// Give a lease its simulator: claim one, create or erase it if needed, boot
// it. Returns { udid, name } or null when the lease has no pool resource. A
// run covered by its own session's hold uses the hold's device.
export async function checkout(lease, cfg, ctl = simctl()) {
  const res = lease.res.find(r => resCfg(cfg, r).pool);
  if (!res) return null;
  if (lease.covered?.includes(res)) {
    const d = withState(s => (s.pool || []).find(d => d.res === res && d.lease && s.leases.some(l => l.id === d.lease && l.kind === 'hold' && l.pid === lease.spid)));
    if (d?.udid) return { udid: d.udid, name: d.name };
  }
  const pool = poolOf(cfg, res);
  if (!ERASE.has(pool.erase)) die(`pool.erase is one of ${[...ERASE].join(', ')}`);
  const sp = spec(pool, ctl);
  const c = withState(s => claim(s, lease, res, sp, pool.erase));
  const save = o => withState(s => { const d = (s.pool || []).find(x => x.name === c.dev.name); if (d && d.lease === lease.id) Object.assign(d, o); });
  try {
    let { udid } = c.dev, erase = c.erase;
    const devs = ctl.devices();
    if (!udid || !devs.some(d => d.udid === udid)) {
      // A device of ours that the state file lost track of is adopted, and wiped since its last user is unknown.
      const mine = madeHere();
      const stray = devs.find(d => d.name === c.dev.name && d.type === sp.type && d.runtime === sp.runtime && mine.has(d.udid));
      if (stray) { udid = stray.udid; erase = pool.erase !== 'never'; }
      else { say(`${res}: creating ${c.dev.name} (${sp.typeName}, ${sp.runtimeName})`); udid = ctl.create(c.dev.name, sp.type, sp.runtime); noteMade(udid); }
      save({ udid });
    }
    if (erase) {
      say(`${res}: erasing ${c.dev.name}, last used by another agent`);
      ctl.shutdown(udid);
      ctl.erase(udid);
    }
    const t = now();
    await ctl.boot(udid);
    if (now() - t > 3000) say(`${res}: booted ${c.dev.name} in ${dur(now() - t)}`);
    save({ booted: true });
    return { udid, name: c.dev.name };
  } catch (e) {
    // Let it go; reapPool shuts it down if it got as far as booting.
    withState(s => { const d = (s.pool || []).find(x => x.name === c.dev.name); if (d && d.lease === lease.id) Object.assign(d, { lease: null, lastWho: d.who, lastUsed: now(), booted: !!d.udid }); });
    throw new Error(`couldn't get ${c.dev.name} ready: ${e.message}`);
  }
}

// Shut a lease's simulator down and put it back in the pool. If the shutdown
// fails, the device stays marked booted and the next state read retries it.
export function checkin(lease, ctl = simctl()) {
  const d = withState(s => (s.pool || []).find(x => x.lease === lease.id));
  if (!d) return;
  const down = !d.udid || ctl.shutdown(d.udid);
  withState(s => {
    const x = (s.pool || []).find(y => y.name === d.name);
    if (x && x.lease === lease.id) Object.assign(x, { lease: null, lastWho: x.who, lastUsed: now(), booted: !down });
  });
}

// dibs sims [prune]: the pool, and deleting its idle devices.
// The pool as the state last recorded it, for dibs web: no simctl call and no
// write, so a device's booted state is what dibs last saw, not a fresh look.
export function poolJson(s, cfg, m = machine()) {
  const rows = (s.pool || []).map(d => ({ name: d.name, res: d.res, who: d.who || null, since: d.since || null, lastUsed: d.lastUsed || null, lastWho: d.lastWho || null, inUse: !!d.lease, creating: !d.udid }));
  const room = Object.fromEntries(poolRes(cfg).map(r => [r, { ...poolRoom(s, cfg, r, m), max: resCfg(cfg, r).slots, inUse: rows.filter(d => d.res === r && d.inUse).length }]));
  return { room, devices: rows };
}

export function sims(o, args, cfg, ctl = simctl()) {
  const devs = ctl.devices();
  const byUdid = new Map(devs.map(d => [d.udid, d]));
  // Forget devices deleted behind dibs' back; shut down free ones left booted.
  const s = withState(s => {
    s.pool = (s.pool || []).filter(d => d.lease || !d.udid || byUdid.has(d.udid));
    for (const d of s.pool) if (!d.lease && d.udid && byUdid.get(d.udid)?.state === 'Booted') { ctl.shutdownLater(d.udid); d.booted = false; }
    return s;
  });
  const tracked = new Set(s.pool.map(d => d.udid));
  const mine = madeHere();
  const strays = devs.filter(d => ours(d.name) && !tracked.has(d.udid) && mine.has(d.udid));
  const others = devs.filter(d => ours(d.name) && !tracked.has(d.udid) && !mine.has(d.udid));
  if (args[0] === 'prune') return prune(ctl, byUdid, strays);
  if (args[0]) die(`dibs sims lists the pool; dibs sims prune deletes its idle devices. Unknown: ${args[0]}`);
  const t = now();
  const rows = s.pool.map(d => {
    const real = byUdid.get(d.udid) || {};
    return { ...d, state: d.udid ? real.state || 'missing' : 'creating', disk: real.size ?? null };
  });
  if (o.json) {
    const room = Object.fromEntries(poolRes(cfg).map(r => [r, { ...poolRoom(s, cfg, r), max: resCfg(cfg, r).slots, inUse: rows.filter(d => d.res === r && d.lease).length }]));
    return console.log(JSON.stringify({ room, devices: rows, untracked: strays, otherDibs: others }, null, 1));
  }
  for (const r of poolRes(cfg)) {
    const room = poolRoom(s, cfg, r);
    const inUse = rows.filter(d => d.res === r && d.lease).length;
    console.log(`${r}: ${inUse} in use, at most ${resCfg(cfg, r).slots} at once; memory fits ${room.fits} more now `
      + `(${gb(Math.max(room.free, 0))} free, ${gb(room.keep)} kept free, ${gb(room.per)} each)`);
  }
  for (const d of others) console.log(`  ${d.name.padEnd(13)} ${d.udid.padEnd(36)} ${d.state.padEnd(9)} not made by this dibs (${HOME}); another dibs on this Mac may be using it, so prune leaves it alone`);
  if (!rows.length && !strays.length) return console.log('no pool devices yet. The first `dibs run sim-own -- <cmd>` creates one.');
  for (const d of rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const use = d.lease ? `in use by ${d.who} for ${dur(t - d.since)}` : d.lastUsed ? `idle ${dur(t - d.lastUsed)}, last used by ${d.lastWho}` : 'never used';
    console.log(`  ${d.name.padEnd(13)} ${String(d.udid || '').padEnd(36)} ${d.state.padEnd(9)} ${use}${d.disk != null ? `, ${size(d.disk)} on disk` : ''}`);
  }
  for (const d of strays) console.log(`  ${d.name.padEnd(13)} ${d.udid.padEnd(36)} ${d.state.padEnd(9)} not tracked (left from an older state file); prune deletes it`);
  console.log('dibs only creates and deletes devices named dibs-pool-*. Delete idle ones: dibs sims prune');
}

function prune(ctl, byUdid, strays) {
  const gone = withState(s => {
    const idle = (s.pool || []).filter(d => !d.lease);
    s.pool = (s.pool || []).filter(d => d.lease);
    return { idle, busy: s.pool.map(d => d.name) };
  });
  let freed = 0;
  const done = [];
  for (const d of [...gone.idle.filter(d => d.udid && byUdid.has(d.udid)), ...strays]) {
    if (!ours(d.name)) continue;   // never anything dibs didn't name
    ctl.shutdown(d.udid);
    try { ctl.remove(d.udid); done.push(d.name); freed += byUdid.get(d.udid)?.size || 0; }
    catch (e) { say(`couldn't delete ${d.name}: ${e.message}`); process.exitCode = 1; }
  }
  console.log(done.length ? `deleted ${done.join(', ')}, about ${size(freed)} freed` : 'no idle pool devices to delete');
  if (gone.busy.length) console.log(`kept ${gone.busy.join(', ')}: in use`);
}
