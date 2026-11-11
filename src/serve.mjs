// dibs serve: the coordinator. Workers check in and pick up jobs; clients place
// jobs and read their output. It never connects out, so it only needs to be
// reachable: on this machine, and on its Tailscale address when there is one.
import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, machine } from './config.mjs';
import { hogsOnce } from './hogs.mjs';
import { watcherDown } from './diskwarn.mjs';
import { FIND, TS_CLI, REMOTE, DEFAULT_PORT, LOST, MAYBE_RAN, MAX_BUNDLE, remoteConf, saveRemote, newToken, shortHost, copyKey } from './remote.mjs';
import { die, now, log, dur, clock } from './util.mjs';
import { VERSION } from './version.mjs';
import { makeTrust, allowed, NAME, MACHINES, newCode, codeKey, codeProof, CODE_LIFE } from './trust.mjs';
import { logChange } from './owner.mjs';
import { loadConfig } from './config.mjs';
import { ondemand, ondemandOf, worthWaking, wakePoints, cantWake } from './ondemand.mjs';
import { unpatched } from './nodecheck.mjs';

const OUT_HOLD = 15e3;           // a client's read waits this long for output
// Tests shorten these with DIBS_SERVE_TIMING.
const {
  beatHold: BEAT_HOLD,           // a worker's check-in waits this long for work before answering
  workerLost: WORKER_LOST,       // no check-in for this long: the machine is gone
  clientLost: CLIENT_LOST,       // nobody reading a job for this long: the sender is gone, stop it
} = { beatHold: 10e3, workerLost: 35e3, clientLost: 90e3, ...JSON.parse(process.env.DIBS_SERVE_TIMING || '{}') };
const KEEP_DONE = 15 * 6e4;      // finished jobs stay this long for late readers and --bring
// A little over the senders' own limit, so a bundle a sender accepted is never refused here.
const MAX_UPLOAD = MAX_BUNDLE + 10 * 1024 ** 2;
const MAX_JSON = 64 * 1024 ** 2; // a job's file list and output batches travel as JSON
const MAX_OUT = 16 * 1024 ** 2;  // output kept per job; older output is dropped
// Machine pairing codes (dibs pair --machine). Open at once: a new one past this drops the oldest.
const MAX_CODES = 5;
// Wrong codes in FAIL_WINDOW before every try is refused until it passes, the right code too.
// 40 bits at 10 tries per 10 minutes: one chance in two million a year. Open codes stay good,
// or anyone who can reach the port could keep the person from pairing for good.
const MAX_FAILS = 10, FAIL_WINDOW = 10 * 6e4;
const FAIL_DELAY = 800;
// Lookups (a joiner's broadcast, its hello) answered per second: enough for a few machines
// joining at once, too few for anyone to use the coordinator to flood someone else.
const LOOKUPS_PER_SEC = 20;

const fail = (status, msg) => Object.assign(new Error(msg), { status });
// What a worker's check-in may set. The rest of a worker's record (its queue,
// who is waiting on it, when it was seen) is the coordinator's own.
// Numbers are checked: placement does arithmetic on them for every sender.
const REPORT = ['os', 'version', 'busy', 'running', 'copies', 'board'];
const REPORT_NUM = ['cores', 'memTotal', 'memFree', 'load', 'diskFree'];

// A machine with a free copy of the job's project skips reinstalling
// dependencies and rebuilding caches. That's worth most of one job ahead in
// line (60), so a warm machine wins unless a cold one would start a whole job
// sooner, or is much less loaded. A copy a job is using, or that a job on its
// way there will take (need.claimed), doesn't count: that job would get a fresh folder.
const WARM = 40;
function warm(w, need) {
  if (!need.root || !w.copies) return false;
  const c = w.copies[copyKey(need.from, need.root)];
  return !!c && c.free > (need.claimed?.[w.name] || 0);
}

// Lower is better. Mostly: how long would the job wait there?
export function score(w, need, t = now()) {
  let s = 0;
  for (const r of need.res) {
    const b = w.busy?.[r];
    if (b) s += 60 * (b.waiting + Math.max(0, b.used - b.slots + 1));
  }
  s += 30 * Math.min(2, w.load / Math.max(1, w.cores));
  if (w.memFree < 20) s += 50;
  s += 20 * (w.assigned || 0);
  if (w.name === need.from) s -= 15 + WARM;         // nothing to ship, and the warmest copy of all
  else if (warm(w, need)) s -= WARM;
  return s;
}

// An on-demand machine asleep or waking (src/ondemand.mjs) isn't reporting, and needn't be: a job wakes it.
const reporting = w => !w.ondemand || w.ondemand.state === 'running';
function fits(w, need, t = now()) {
  if (reporting(w) && (w.lost || t - w.seen > WORKER_LOST)) return `${w.name} isn't reporting in`;
  if (w.ondemand?.state === 'stopping') return `${w.name} is stopping`;
  if (w.ondemand?.problem) return `${w.name} can't be used: ${w.ondemand.problem}`;
  const no = cantWake(w.ondemand, t);
  if (no) return `${w.name} can't wake: ${no.why}, retry ${clock(no.until)}`;
  if (need.os && w.os !== need.os) return `${w.name} runs ${w.os}, and ${need.res.join(', ')} needs ${need.os}`;
  if (need.mem && w.memTotal && need.mem > w.memTotal) return `${w.name} has less memory than the job needs`;
  return allowed(w, need);
}

const BACKUP_EVERY = Number(process.env.DIBS_BACKUP_MS) || 30e3;   // the watcher checks every few seconds; half a minute late is still early

// Where a job should go, or why it can't go anywhere.
export function place(workers, need, t = now()) {
  if (need.on) {
    const w = workers.get(need.on);
    if (!w) {
      if (need.on === need.from) return { machine: need.from, why: 'you asked for this machine' };
      return { error: `no machine named ${need.on}. Machines: ${[...workers.keys()].join(', ') || 'none'}` };
    }
    const bad = fits(w, need, t);
    // A VM that can't be found (src/ondemand.mjs findVm) is said plainly, and the job runs where it came from.
    if (bad && w.ondemand?.problem && need.from) return { machine: need.from, why: `${bad}, so it runs here` };
    // One already marked can't-wake (boat's starts used up) sends the job back the way a refused wake
    // does. Refused here instead, a send that came just after the coordinator's own check of boat's
    // limits exited 2, while one just before it ran on its sender (2026-11-03).
    const no = cantWake(w.ondemand, t);
    if (bad && no && bad.startsWith(`${w.name} can't wake`) && need.from)
      return { machine: need.from, why: `${w.name} can't wake (${no.why}), so it runs on ${need.from}` };
    // Too big for it: a VM made for the job (src/ondemand.mjs create), when that's on.
    const big = w.ondemand?.bigger && workers.get(w.ondemand.bigger);
    const short = bad || ((need.askedCpu || 0) > w.cores && `${w.name} has fewer cores than the job asked for`);
    if (big && short && !fits(big, need, t) && (need.askedCpu || 0) <= big.cores) return { machine: big.name, why: `${short}, so dibs makes a VM big enough for it, and deletes it after` };
    return bad ? { error: bad } : { machine: w.name, why: 'you asked for it' };
  }
  // A temporary VM is only made for jobs bigger than the VM it stands beside.
  const tooBigFor = o => (need.mem || 0) > o.mem || (need.askedCpu || 0) > o.cores;
  let ok = [...workers.values()].filter(w => !fits(w, need, t) && (!w.ondemand?.over || w.ondemand.state === 'running' || tooBigFor(w.ondemand.over)));
  // A sleeping VM only when the job's wait on every awake machine would outlast waking it.
  const awake = ok.filter(w => reporting(w));
  const best = Math.min(...awake.map(w => score(w, need, t)));
  // With nothing awake to compare against, the job's wait isn't known: it runs where it was sent from.
  ok = ok.filter(w => reporting(w) || (awake.length > 0 && worthWaking(w.ondemand, best)));
  if (!ok.length) {
    if (!need.os || need.os === need.fromOs) return { machine: need.from, why: 'no other machine is taking jobs' };
    const reasons = [...workers.values()].map(w => fits(w, need, t));
    return { error: `no machine can take it${reasons.length ? `: ${reasons.join('; ')}` : ' (no workers)'}` };
  }
  const cost = w => (reporting(w) ? score(w, need, t) : wakePoints(w.ondemand));
  ok.sort((a, b) => cost(a) - cost(b));
  const w = ok[0];
  if (!reporting(w)) return { machine: w.name, why: `it's asleep, and waking it (about ${Math.round(((w.ondemand.resumeMs ?? 45e3)) / 1000)}s) beats the wait anywhere awake` };
  const busy = need.res.map(r => w.busy?.[r]).filter(Boolean);
  const waiting = busy.reduce((a, b) => a + b.waiting, 0);
  return { machine: w.name, why: `${warm(w, need) ? 'it already has a copy of this project' : 'the least busy'} (load ${w.load.toFixed(1)} on ${w.cores} cores${waiting ? `, ${waiting} waiting` : ', nobody waiting'})` };
}

// The Tailscale address of this machine. Ask Tailscale itself when its CLI is
// around; otherwise a 100.64.0.0/10 address on a tunnel interface. That range
// alone isn't enough: carrier-grade NAT and some hotspots use it too.
// A log line said once for as long as it stays the same, per key: the Tailscale
// address is tried every 30 s, and on 2026-11-10 failed all day (EADDRNOTAVAIL),
// one line each time. null clears the key, so the next failure is said again.
export function oncePerChange(log) {
  const last = new Map();
  return (key, line) => {
    if (line == null) return last.delete(key);
    if (last.get(key) !== line) log(line);
    last.set(key, line);
  };
}

function tailscaleIp() {
  for (const cli of TS_CLI) {
    try {
      const ip = execFileSync(cli, ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().split('\n')[0];
      if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch {}
  }
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (!/^(utun\d+|tailscale\d*)$/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const [x, y] = a.address.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) return a.address;
    }
  }
  return null;
}

// A row as a limited machine sees it: resource and who, not what it runs or
// why. A file lease's path says what's being worked on, so it goes too.
const hidePath = r => (typeof r === 'string' && r.startsWith('files:') ? 'files:' : r);
// A machine's lines, with every file lease folded into one files: line.
export function bareBusy(busy) {
  const out = {};
  for (const [k, b] of Object.entries(busy || {})) {
    const o = out[hidePath(k)] ||= { used: 0, slots: 0, waiting: 0 };
    o.used += b?.used || 0; o.slots += b?.slots || 0; o.waiting += b?.waiting || 0;
  }
  return out;
}
export const bare = x => ({ ...x, cmd: x.cmd == null ? x.cmd : Array.isArray(x.cmd) ? [] : '', purpose: '',
  ...(Array.isArray(x.res) ? { res: x.res.map(hidePath) } : {}), ...(Array.isArray(x.holds) ? { holds: x.holds.map(hidePath) } : {}) });

// What a client sees of an on-demand machine: its state and how long it takes to wake.
// mem: the VM's size as configured, which a sender packs jobs into (src/remote.mjs loadShipTarget).
const vmOf = w => w.ondemand && { state: w.ondemand.state, provider: w.ondemand.provider, resumeMs: w.ondemand.resumeMs, idleStop: w.ondemand.idleStop, cantWake: cantWake(w.ondemand) || undefined, problem: w.ondemand.problem, mem: w.ondemand.memTotal,
  temp: w.ondemand.temp ? { of: w.ondemand.of, max: w.ondemand.create.max } : undefined };

// port: the coordinator's, which pairing lookups are answered on (UDP). addrs: the
// addresses other machines can reach it at, as URLs.
export function makeServer({ token, log = () => {}, self = null, joinUrl = () => null, registry = MACHINES, port = null, addrs = () => [] }) {
  const workers = new Map();
  const jobs = new Map();
  // up(w): src/ondemand.mjs marks a waking VM up the moment its new worker checks in, so that check-in gets the jobs.
  const hooks = {};
  // Ids carry this coordinator's start time, so a job from before a restart
  // can never be mistaken for a new one with the same number.
  let seq = 0;
  const started = now();
  const boot = started.toString(36);
  const jobDir = id => path.join(HOME, 'jobs', String(id));
  const trust = makeTrust({ token, file: registry });
  // Codes live in memory only: one outlives neither its ten minutes nor a restart.
  const codes = [];   // { id, key, exp, name, made }
  const open = () => { const t = now(); for (let i = codes.length; i--;) if (codes[i].exp <= t) codes.splice(i, 1); return codes; };
  const fails = [];
  let lookups = { sec: 0, n: 0 };
  const lookupOk = () => {
    const sec = Math.floor(now() / 1000);
    if (lookups.sec !== sec) lookups = { sec, n: 0 };
    return ++lookups.n <= LOOKUPS_PER_SEC;
  };
  // A machine on the same network finds this coordinator by broadcast. The socket is
  // open only while a code is, and its answer says no more than where to ask next.
  let finder = null;
  const findable = () => {
    if (finder || !port) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    finder = sock;
    sock.on('message', (msg, from) => {
      if (String(msg) !== FIND || !open().length || !lookupOk()) return;
      sock.send(JSON.stringify({ t: 'dibs-coordinator-v1', name: self, port, urls: addrs() }), from.port, from.address);
    });
    sock.on('error', e => { log(`can't answer pairing lookups on UDP ${port}: ${e.message}. Joining machines need --at <address>`); try { sock.close(); } catch {} if (finder === sock) finder = null; });
    sock.bind(Number(process.env.DIBS_PAIR_PORT) || port);
  };
  const unfindable = () => { if (finder && !open().length) { try { finder.close(); } catch {} finder = null; } };
  const machineList = () => Object.entries(trust.reg.machines).map(([name, m]) => ({ name, invited: m.invited, joined: m.joined, paired: m.paired || null, online: workers.has(name) && !fits(workers.get(name), {}) }));
  // Before any token: a joiner has none yet. Each answer is a step of dibs join <code>.
  const pairing = {
    'POST /pair/hello': async req => {
      const { n } = await jsonBody(req);
      if (typeof n !== 'string' || !/^[\w-]{43}$/.test(n)) throw fail(400, 'a hello carries a 32-byte nonce');
      if (!lookupOk()) throw fail(429, 'too many lookups this second; try again');
      if (!open().length) throw fail(404, 'no machine pairing code is open here. On the coordinator: dibs pair --machine');
      const nc = crypto.randomBytes(32).toString('base64url');
      return { name: self, nc, proofs: open().map(c => codeProof(c.key, n, nc)) };
    },
    'POST /pair/join': async req => {
      const { code, name: asked } = await jsonBody(req);
      const t = now();
      while (fails.length && t - fails[0] > FAIL_WINDOW) fails.shift();
      if (fails.length >= MAX_FAILS) throw fail(429, `too many wrong codes in the last ${FAIL_WINDOW / 6e4} minutes, so every try is refused for now. The code still works once that passes`);
      const k = codeKey(code);
      const c = open().find(x => crypto.timingSafeEqual(x.key, k));
      if (!c) {
        fails.push(t);
        await new Promise(r => setTimeout(r, FAIL_DELAY));
        throw fail(401, 'that code is wrong, used or expired. On the coordinator: dibs pair --machine for a new one');
      }
      const name = c.name || asked;
      if (!NAME.test(name || '')) throw fail(400, 'a machine name is letters, digits, dots, dashes and underscores (--name)');
      if (name === self) throw fail(409, `${name} is the coordinator's own name. Join with --name <another>`);
      // A code made for a name may replace that machine (as dibs invite does); an open one may not take a name in use.
      if (trust.has(name) && !c.name) throw fail(409, `a machine called ${name} is already in the group. Join with --name <another>, or on the coordinator make the code for it: dibs pair --machine --name ${name}`);
      codes.splice(codes.indexOf(c), 1);
      unfindable();
      const replaced = trust.has(name);
      if (replaced) {
        drop(name, `${name} joined again with a pairing code, so the job was stopped`);
        trust.revoke(name, `${name} joined again with a pairing code, so this token no longer works`);
      }
      const token = trust.invite(name, { paired: now() });
      log(`${name} joined with a pairing code${replaced ? ' (its old token no longer works)' : ''}`);
      return { name, token, url: joinUrl(), version: VERSION };
    },
  };
  // Every answer closes its connection. A kept-alive one is dropped here after
  // 5s idle, and a client that was busy longer (packing a big working copy)
  // can send its next call on it before it notices: fetch failed, ECONNRESET.
  const send = (resp, code, body) => {
    if (resp.writableEnded) return;
    if (Buffer.isBuffer(body)) {
      resp.writeHead(code, { 'content-type': 'application/octet-stream', 'content-length': body.length, connection: 'close' });
      resp.end(body);
      return;
    }
    const txt = JSON.stringify(body);
    resp.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(txt), connection: 'close' });
    resp.end(txt);
  };
  const body = (req, limit) => new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > limit) { reject(fail(413, 'too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  const jsonBody = async req => {
    const b = await body(req, MAX_JSON);
    try { return b.length ? JSON.parse(b) : {}; } catch { throw fail(400, 'bad JSON'); }
  };

  // Wake whoever is waiting on a job or a worker.
  const wake = x => { const ws = x.wake || []; x.wake = []; for (const f of ws) f(); };
  // The response's close event, unlike the request's, means the caller hung up.
  const waitFor = (x, ms, resp) => new Promise(resolve => {
    const done = () => { clearTimeout(timer); resp.off('close', done); x.wake = (x.wake || []).filter(f => f !== done); resolve(); };
    const timer = setTimeout(done, ms);
    (x.wake ||= []).push(done);
    resp.on('close', done);
  });

  const adopt = (w, x, running) => {
    if (!x || typeof x.id !== 'string' || !/^[\w-]+$/.test(x.id) || !running.has(x.id) || jobs.has(x.id) || typeof x.from !== 'string') return;
    const pick = k => (x[k] === undefined ? undefined : x[k]);
    const j = { id: x.id, from: x.from, who: pick('who'), agent: pick('agent'), label: pick('label'), purpose: x.purpose || '',
      res: Array.isArray(x.res) ? x.res.map(String) : [], cmd: Array.isArray(x.cmd) ? x.cmd.map(String) : [], bring: Array.isArray(x.bring) ? x.bring : [],
      machine: w.name, state: 'running', adopted: true, created: Number(x.created) || now(), started: now(), seen: now(),
      out: [], outBytes: 0, base: 0, next: 0, dropped: 0, code: null, artifacts: false };
    jobs.set(j.id, j);
    log(`job ${j.id} ${j.res.join(',')} from ${j.agent || j.who}@${j.from} on ${w.name}: picked up again after a restart`);
  };

  const finish = (j, code, why) => {
    if (j.state === 'done') return;
    Object.assign(j, { state: 'done', code, why: why || j.why || null, doneAt: now() });
    const w = workers.get(j.machine);
    if (w) w.assigned = Math.max(0, (w.assigned || 0) - 1);
    log(`job ${j.id} ${j.res.join(',')} on ${j.machine}: exit ${code}${why ? ` (${why})` : ''}`);
    wake(j);
  };
  const append = (j, s, buf) => {
    if (!buf.length) return;
    j.out.push([s, buf]); j.outBytes += buf.length; j.next++;
    while (j.outBytes > MAX_OUT && j.out.length > 1) { const [, d] = j.out.shift(); j.outBytes -= d.length; j.base++; j.dropped += d.length; }
    wake(j);
  };
  const assign = j => {
    if (j.state === 'done') return;
    let w = workers.get(j.machine);
    if (!w || fits(w, j)) {
      // Its machine went away before it started: any other machine that fits will do, unless --on named one.
      const need = { ...j, claimed: claimed(j, j) };
      const others = j.on ? [] : [...workers.values()].filter(x => !fits(x, j)).sort((a, b) => score(a, need) - score(b, need));
      if (!others.length) return finish(j, LOST, `${j.machine} stopped reporting before the job started${j.on ? '' : ', and no other machine can take it'}`);
      w = others[0];
      j.machine = w.name;
    }
    j.state = 'queued';
    w.pending.push(j.id);
    w.assigned = (w.assigned || 0) + 1;
    wake(w);
  };
  const cancelJob = (j, why) => {
    j.cancel = true;
    if (j.state === 'uploading' || j.state === 'queued') {
      const w = workers.get(j.machine);
      if (w) w.pending = w.pending.filter(x => x !== j.id);
      finish(j, 130, why);
    } else { const w = workers.get(j.machine); if (w) wake(w); }
  };
  // A removed machine: what it runs is lost to its senders, what it sent is stopped.
  const drop = (name, why) => {
    const w = workers.get(name);
    workers.delete(name);
    if (w) { w.pending = []; wake(w); }
    let lost = 0, cancelled = 0;
    for (const j of jobs.values()) {
      if (j.state === 'done') continue;
      if (j.machine === name && j.from !== name) { j.cancel = true; finish(j, j.state === 'running' ? MAYBE_RAN : LOST, why); lost++; }
      else if (j.from === name) {
        // Stopped there, and done here at once: a read already in flight gets 76 or 77, not the job's own exit.
        const code = j.state === 'running' ? MAYBE_RAN : LOST;
        cancelJob(j, `${name} sent it and was removed from the group`);
        finish(j, code, `${name} sent it and was removed from the group`);
        cancelled++;
      }
    }
    return { lost, cancelled };
  };
  // Jobs for the same project on their way to a machine will take its free
  // copies before the machine's next report can say so.
  const claimed = (need, skip) => {
    const out = {};
    for (const j of jobs.values()) {
      if (j === skip || j.state === 'done' || j.from !== need.from || j.root !== need.root) continue;
      const w = workers.get(j.machine);
      if (w && !(w.running || []).includes(j.id)) out[j.machine] = (out[j.machine] || 0) + 1;
    }
    return out;
  };
  const pub = j => ({ id: j.id, res: j.res, cmd: j.cmd, who: j.who, agent: j.agent, from: j.from, machine: j.machine, state: j.state,
    code: j.code, purpose: j.purpose, created: j.created, doneAt: j.doneAt || null, mem: j.mem });
  // A machine limited with dibs limit sees other machines' work without what
  // it runs or why: resource, who and times only. Admin and unlimited tokens see all.
  const limited = who => !who.admin && !!trust.only(who.name);
  const cannotSend = (name, res) => {
    const s = trust.sends(name);
    if (!s || res.every(r => s.includes(r))) return null;
    return `${name} ${s.length ? `may only send ${s.join(', ')} jobs` : 'may not send jobs'} to other machines (dibs limit on the coordinator)`;
  };
  const jobsFor = (who, js) => js.map(pub).map(j => (limited(who) && j.from !== who.name && j.machine !== who.name ? bare(j) : j));
  const boardFor = (who, w) => (!w.board || !limited(who) || w.name === who.name ? w.board || null
    : { ...w.board, held: (w.board.held || []).map(bare), waiting: (w.board.waiting || []).map(bare) });

  const routes = {
    'GET /hello': () => ({ version: VERSION, machines: [...workers.values()].filter(w => !fits(w, {}, now())).map(w => w.name) }),

    'GET /machines': (req, j, q, resp, who) => ({ now: now(), version: VERSION, started,
      machines: [...workers.values()].map(w => ({ ...w, pending: undefined, wake: undefined, board: undefined, lost: !!fits(w, {}), ondemand: vmOf(w),
        // A file lease's path says what's being worked on, and a copy's name which projects: not for a limited machine.
        ...(limited(who) && w.name !== who.name && { busy: bareBusy(w.busy), copies: undefined }) })),
      jobs: jobsFor(who, [...jobs.values()]),
      invited: Object.entries(trust.reg.machines).filter(([n]) => !workers.has(n)).map(([name, m]) => ({ name, invited: m.invited, joined: m.joined, paired: m.paired || null })),
      removed: Object.entries(trust.reg.removed).map(([name, r]) => ({ name, at: r.at, why: r.why })),
      limits: trust.reg.limits, sends: trust.reg.sends }),

    // Every machine's board, as of its last check-in, for plain `dibs`.
    'GET /board': (req, j, q, resp, who) => ({ now: now(), version: VERSION,
      machines: [...workers.values()].map(w => ({ name: w.name, os: w.os, cores: w.cores, load: w.load, memFree: w.memFree, diskFree: w.diskFree,
        version: w.version, lost: !!fits(w, {}), age: now() - (w.boardAt || w.seen), board: boardFor(who, w), ondemand: vmOf(w) })),
      jobs: jobsFor(who, [...jobs.values()].filter(j => j.state !== 'done')) }),

    'POST /place': async (req, j, q, resp, who) => {
      const need = await jsonBody(req);
      if (!who.admin) need.from = who.name;
      if (!Array.isArray(need.res) || !need.res.length) throw fail(400, 'name a resource');
      const no = !who.admin && cannotSend(who.name, need.res);
      if (no && need.on && need.on !== need.from) throw fail(409, no);
      if (no) return { machine: need.from, why: no };
      const p = place(workers, { ...need, fromOs: workers.get(need.from)?.os ?? need.fromOs, claimed: claimed(need) });
      // Invited but never joined reads as "no machine named mini" to placement, while dibs machines lists it.
      if (p.error && need.on && !workers.get(need.on) && trust.has(need.on))
        throw fail(409, `${need.on} was invited but hasn't joined yet: run the join line dibs invite printed on ${need.on}, then dibs service install worker there`);
      if (p.error) throw fail(409, p.error);
      return p;
    },

    'POST /jobs': async (req, j0, q, resp, who) => {
      const m = await jsonBody(req);
      if (!Array.isArray(m.cmd) || !m.cmd.length || !Array.isArray(m.res) || !m.res.length || !m.machine)
        throw fail(400, 'a job needs res, cmd and machine');
      if (!who.admin && m.from !== who.name) throw fail(403, `this machine's token is for ${who.name}; it can't send jobs as ${m.from}`);
      if (!trust.current(who)) throw fail(401, `${who.name} was removed from the group`);   // kicked while the body arrived
      const cant = !who.admin && cannotSend(who.name, m.res);
      if (cant) throw fail(403, cant);
      const no = allowed(workers.get(m.machine) || { name: m.machine, only: trust.only(m.machine) }, m);
      if (no) throw fail(409, no);
      const j = { ...m, id: `${boot}-${++seq}`, state: 'uploading', created: now(), seen: now(), out: [], outBytes: 0, base: 0, next: 0, dropped: 0, code: null, artifacts: false };
      jobs.set(j.id, j);
      log(`job ${j.id} ${j.res.join(',')} from ${j.agent || j.who}@${j.from} for ${j.machine}: ${j.cmd.join(' ').slice(0, 80)}`);
      return { id: j.id, machine: j.machine };
    },

    'PUT /jobs/:id/bundle': async (req, j) => {
      if (j.state !== 'uploading' || j.receiving) throw fail(409, 'already sent');
      // A slow upload is the sender at work, not a sender gone.
      j.receiving = true;
      req.on('data', () => { j.seen = now(); });
      let buf;
      try { buf = await body(req, MAX_UPLOAD); } finally { j.receiving = false; }
      if (j.state !== 'uploading') throw fail(409, 'the job was stopped while it uploaded');
      fs.mkdirSync(jobDir(j.id), { recursive: true });
      fs.writeFileSync(path.join(jobDir(j.id), 'bundle.tgz'), buf);
      j.seen = now();
      assign(j);
      return { ok: true, machine: j.machine };
    },

    'GET /jobs/:id/out': async (req, j, q, resp) => {
      j.seen = now();
      // Picked up after a restart, its output starts over at 0: number it on
      // from where its sender had read to, so nothing is skipped or repeated.
      if (j.adopted && !j.synced) {
        j.synced = true;
        const shift = Math.max(0, (Number(q.get('after')) || 0) - j.base);
        j.base += shift; j.next += shift;
      }
      const after = Math.max(Number(q.get('after')) || 0, j.base);
      // A read held open is a sender still there, however quiet the job: it counts as reading.
      j.readers = (j.readers || 0) + 1;
      try { if (j.next <= after && j.state !== 'done') await waitFor(j, OUT_HOLD, resp); } finally { j.readers--; }
      j.seen = now();
      const from = Math.max(Number(q.get('after')) || 0, j.base);
      const gap = Number(q.get('after')) < j.base ? j.dropped : 0;
      return { chunks: j.out.slice(from - j.base).map(([s, d]) => [s, d.toString('base64')]), next: j.next, gap,
               state: j.state, machine: j.machine, code: j.code, why: j.why, artifacts: j.artifacts };
    },

    'POST /jobs/:id/cancel': (req, j) => {
      cancelJob(j, 'stopped before it started');
      return { ok: true };
    },

    // Workers.
    'POST /worker/beat': async (req, j, q, resp, who) => {
      const info = await jsonBody(req);
      if (!info.name) throw fail(400, 'a worker needs a name');
      if (!who.admin && info.name !== who.name) throw fail(403, `this machine's token is for ${who.name}, so it can't take jobs as ${info.name}. Drop --name, or join again with --name ${who.name}`);
      if (!trust.current(who)) throw fail(401, `${who.name} was removed from the group`);   // kicked while the body arrived
      if (!who.admin) trust.joined(who.name);
      const w = workers.get(info.name) || { name: info.name, pending: [], assigned: 0 };
      const fresh = !workers.has(info.name) || w.lost || now() - w.seen > WORKER_LOST;
      if (typeof info.name !== 'string') throw fail(400, 'a worker needs a name');
      for (const k of REPORT) if (k in info) w[k] = info[k];
      for (const k of REPORT_NUM) w[k] = Number.isFinite(info[k]) ? info[k] : k === 'diskFree' ? null : w[k] ?? 0;
      if (!Array.isArray(w.running)) w.running = [];
      if (!w.busy || typeof w.busy !== 'object') w.busy = {};
      Object.assign(w, { seen: now(), boardAt: now(), lost: false, only: trust.only(info.name) });
      workers.set(w.name, w);
      if (fresh) log(`machine ${w.name} (${w.os}, ${w.cores} cores) is taking jobs`);
      const running = new Set(w.running);
      // Jobs it runs that this coordinator never heard of were sent before it
      // restarted: pick them up again, so their output and exit code still reach
      // the sender, which waits for that (src/remote.mjs follow).
      for (const x of Array.isArray(info.jobs) ? info.jobs : []) adopt(w, x, running);
      // Jobs the worker no longer runs but we think it does ended with it (it restarted).
      for (const j of jobs.values())
        if (j.machine === w.name && j.state === 'running' && !running.has(j.id) && now() - j.started > 5000) finish(j, MAYBE_RAN, `${w.name} restarted while running it`);
      const answer = () => {
        const cancel = [...running].filter(id => { const j = jobs.get(id); return !j || j.cancel || j.state === 'done'; });
        // An on-demand VM's worker gets jobs only once the VM is up and the worker is this
        // version: one boat's snapshot brought back on the old dibs is about to be replaced
        // (src/ondemand.mjs WORKER), and a job it took would die with it.
        const ready = !w.ondemand || (w.ondemand.state === 'running' && w.version === VERSION);
        const give = ready ? w.pending.splice(0).map(id => jobs.get(id)).filter(j => j && j.state === 'queued') : [];
        for (const j of give) Object.assign(j, { state: 'running', started: now() });
        return { cancel, jobs: give.map(j => ({ ...pub(j), cwdRel: j.cwdRel, files: j.files, bring: j.bring, root: j.root, label: j.label,
          prio: j.prio, by: j.by, est: j.est, mem: j.mem, askedMem: j.askedMem, cpu: j.cpu, disk: j.disk, ports: j.ports, wait: j.wait, maxWait: j.maxWait, stayOn: j.stayOn, rule: j.rule, repo: j.repo })) };
      };
      hooks.up?.(w);
      let a = answer();
      if (!a.jobs.length && !a.cancel.length) { await waitFor(w, BEAT_HOLD, resp); w.seen = now(); a = answer(); }
      return a;
    },

    'GET /jobs/:id/bundle': (req, j) => fs.readFileSync(path.join(jobDir(j.id), 'bundle.tgz')),

    'POST /jobs/:id/out': async (req, j) => {
      const { chunks } = await jsonBody(req);
      for (const [s, d] of chunks || []) append(j, s === 2 ? 2 : 1, Buffer.from(d, 'base64'));
      return { cancel: !!j.cancel };
    },

    'PUT /jobs/:id/artifacts': async (req, j) => {
      const buf = await body(req, MAX_UPLOAD);
      fs.mkdirSync(jobDir(j.id), { recursive: true });
      fs.writeFileSync(path.join(jobDir(j.id), 'artifacts.tgz'), buf);
      j.artifacts = true;
      return { ok: true };
    },

    'GET /jobs/:id/artifacts': (req, j) => {
      if (!j.artifacts) throw fail(404, 'the job brought nothing back');
      return fs.readFileSync(path.join(jobDir(j.id), 'artifacts.tgz'));
    },

    'POST /jobs/:id/done': async (req, j) => {
      const { code, why } = await jsonBody(req);
      finish(j, Number.isInteger(code) ? code : 1, why);
      return { ok: true };
    },

    // The coordinator's own machine only (checked in handle).
    'POST /admin/invite': async req => {
      const { name } = await jsonBody(req);
      if (!NAME.test(name || '')) throw fail(400, 'a machine name is letters, digits, dots, dashes and underscores');
      if (name === self) throw fail(409, `${name} is the coordinator's own machine; it uses the token in its remote.json`);
      const replaced = trust.has(name);
      const stopped = replaced ? drop(name, `${name} was given a new token, so the job was stopped`) : { lost: 0, cancelled: 0 };
      if (replaced) trust.revoke(name, `${name} was given a new token with dibs invite, so this one no longer works. Run the join line it printed on ${name}`);
      const token = trust.invite(name);
      log(`invited ${name}${replaced ? ' (its old token no longer works)' : ''}`);
      return { name, token, url: joinUrl(), replaced, ...stopped };
    },
    'POST /admin/pair': async req => {
      const { name } = await jsonBody(req);
      if (name != null && !NAME.test(name)) throw fail(400, 'a machine name is letters, digits, dots, dashes and underscores');
      if (name === self) throw fail(409, `${name} is the coordinator's own machine`);
      const code = newCode();
      if (open().length >= MAX_CODES) codes.shift();
      const c = { id: crypto.randomBytes(4).toString('hex'), key: codeKey(code), exp: now() + CODE_LIFE, name: name || null, made: now() };
      codes.push(c);
      findable();
      log(`pairing code ${c.id} open for ${CODE_LIFE / 6e4} minutes${c.name ? `, for ${c.name}` : ''}`);
      return { code, id: c.id, exp: c.exp, name: c.name, urls: addrs(), port };
    },
    'GET /admin/pairs': () => ({ now: now(), codes: open().map(c => ({ id: c.id, name: c.name, exp: c.exp, made: c.made })), machines: machineList() }),
    'POST /admin/unpair': async req => {
      const { id } = await jsonBody(req);
      const gone = open().filter(c => id === 'all' || c.id === id);
      for (const c of gone) codes.splice(codes.indexOf(c), 1);
      unfindable();
      return { removed: gone.length };
    },
    'POST /admin/kick': async req => {
      const { name } = await jsonBody(req);
      if (!trust.has(name)) throw fail(404, `no invited machine named ${name}. Invited: ${Object.keys(trust.reg.machines).join(', ') || 'none'}`);
      trust.revoke(name, `${name} was removed from the group with dibs kick. To bring it back: dibs pair --machine on the coordinator, then dibs join <code> on ${name}`);
      const r = drop(name, `${name} was removed from the group (dibs kick), so the job was stopped`);
      log(`removed ${name}: ${r.lost} running there reported lost, ${r.cancelled} it sent stopped`);
      return { name, ...r };
    },
    'POST /admin/limit': async req => {
      const { name, only, sends } = await jsonBody(req);
      if (!NAME.test(name || '')) throw fail(400, 'name a machine');
      const names = x => Array.isArray(x) && x.every(r => typeof r === 'string' && r);
      if (only != null && (!names(only) || !only.length)) throw fail(400, '--only takes resource names, e.g. --only test,heavy');
      if (sends != null && !names(sends)) throw fail(400, '--sends takes resource names, e.g. --sends test,heavy, or none');
      trust.limit(name, only, sends);
      const w = workers.get(name);
      if (w) w.only = trust.only(name);
      log(`${name}: takes ${trust.only(name)?.join(', ') || 'any'} jobs, sends ${trust.sends(name) ? trust.sends(name).join(', ') || 'none' : 'any'}`);
      return { name, only: trust.only(name), sends: trust.sends(name) };
    },
  };
  // Which side of a job each route belongs to.
  const OWNER = { 'GET /jobs/:id/out': 'from', 'POST /jobs/:id/cancel': 'from', 'GET /jobs/:id/artifacts': 'from', 'PUT /jobs/:id/bundle': 'from',
    'GET /jobs/:id/bundle': 'machine', 'POST /jobs/:id/out': 'machine', 'PUT /jobs/:id/artifacts': 'machine', 'POST /jobs/:id/done': 'machine' };

  const handle = async (req, resp) => {
    try {
      const pre = pairing[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
      if (pre) return send(resp, 200, await pre(req));
      const who = trust.who(req);
      if (who.error) return send(resp, 401, { error: who.error });
      const u = new URL(req.url, 'http://x');
      const m = u.pathname.match(/^\/jobs\/([\w-]+)\/(\w+)$/);
      const key = `${req.method} ${m ? `/jobs/:id/${m[2]}` : u.pathname}`;
      const h = routes[key];
      if (!h) return send(resp, 404, { error: `no such route ${key}` });
      let j;
      if (m) { j = jobs.get(m[1]); if (!j) return send(resp, 404, { error: `no job ${m[1]}` }); }
      if (!who.admin && m && j[OWNER[key]] !== who.name) return send(resp, 403, { error: `job ${j.id} isn't ${who.name}'s` });
      if (!who.admin && u.pathname.startsWith('/admin/')) return send(resp, 403, { error: "only the coordinator's own machine can do that. Run it there" });
      const out = await h(req, j, u.searchParams, resp, who);
      send(resp, 200, out);
    } catch (e) {
      send(resp, e.status || 500, { error: e.status ? e.message : `coordinator error: ${e.message}` });
      if (!e.status) log(`error on ${req.method} ${req.url}: ${e.stack}`);
    }
  };
  const server = () => {
    const s = http.createServer(handle);
    s.requestTimeout = 0;          // uploads of big working copies take a while
    s.headersTimeout = 30e3;
    return s;
  };

  // Machines that stop reporting take their jobs with them; senders that stop
  // reading get their jobs stopped; old jobs are cleaned up.
  const sweep = setInterval(() => {
    const t = now();
    for (const w of workers.values()) {
      if (!reporting(w) || w.lost || t - w.seen <= WORKER_LOST) continue;
      w.lost = true;
      log(`machine ${w.name} stopped reporting`);
      for (const id of w.pending.splice(0)) { const j = jobs.get(id); if (j) { w.assigned--; assign(j); } }
      for (const j of jobs.values()) if (j.machine === w.name && j.state === 'running') finish(j, MAYBE_RAN, `${w.name} stopped reporting while running the job`);
    }
    for (const j of jobs.values()) {
      if (j.state !== 'done' && !j.cancel && !j.receiving && !j.readers && t - j.seen > CLIENT_LOST) {
        j.cancel = true;
        log(`job ${j.id}: nobody is reading its output, stopping it`);
        if (j.state !== 'running') finish(j, 130, 'the sender went away');
        else {
          // A sender that was only slow or asleep reads again later: it's told why
          // its job ended early and brought nothing back.
          j.why = `the coordinator stopped the job: nothing read its output for ${dur(CLIENT_LOST)}`;
          const w = workers.get(j.machine);
          if (w) wake(w);
        }
      }
      if (j.state === 'done' && t - j.doneAt > KEEP_DONE) {
        jobs.delete(j.id);
        fs.rmSync(jobDir(j.id), { recursive: true, force: true });
      }
    }
    unfindable();
  }, Math.min(5000, WORKER_LOST / 4));
  sweep.unref();
  // A job not yet started, sent to another machine instead (an on-demand VM that can't be found).
  const move = (j, name, why) => {
    const w = workers.get(name);
    j.machine = name;
    append(j, 2, Buffer.from(`dibs: ${why}\n`));
    w.pending.push(j.id);
    w.assigned = (w.assigned || 0) + 1;
    wake(w);
  };
  return { server, workers, jobs, trust, finish, move, fits, LOST, hooks, stop: () => { clearInterval(sweep); if (finder) { try { finder.close(); } catch {} finder = null; } } };
}

// dibs serve [--listen 7420] [--bind addr]
export async function serve(o) {
  { const hole = unpatched(); if (hole) console.error(`warning: ${hole}. Then dibs service install serve on a fixed Node replaces this one.`); }
  let rc = remoteConf();
  const port = Number(o.listen) || (rc && Number(new URL(rc.url).port)) || DEFAULT_PORT;
  const local = rc && /^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(rc.url);
  // Joined to another coordinator: serving here would drop that join without a word.
  if (rc && !local && !o.force) die(`this machine is joined to the coordinator at ${rc.url}. To leave that group and be a coordinator here: dibs serve --force`);
  if (rc && !local) logChange('serve --force', { left: rc.url });
  // The coordinator's machine reaches it over loopback, with a token of its own
  // (never the old group's). Saved only once it listens, so a serve that fails changes nothing.
  const fresh = !local && { url: `http://127.0.0.1:${port}`, token: newToken(), name: rc?.name || shortHost() };
  if (fresh) rc = fresh;
  const listening = new Map();
  const joinUrl = () => { const ip = [...listening.keys()].find(h => h !== '127.0.0.1'); return ip ? `http://${ip}:${port}` : null; };
  let made;
  const addrs = () => [...listening.keys()].filter(h => h !== '127.0.0.1').map(h => `http://${h}:${port}`);
  try { made = makeServer({ token: rc.token, log, self: rc.name, joinUrl, port, addrs }); } catch (e) { die(e.message); }
  const { server } = made;
  const first = o.bind || '127.0.0.1';
  const failed = oncePerChange(log);
  const listen = host => new Promise(resolve => {
    if (listening.has(host)) return resolve(true);
    const s = server();
    s.once('error', e => { failed(host, `can't listen on ${host}:${port}: ${e.message}${host === first ? '' : '. Trying again every 30 s, quietly'}`); resolve(false); });
    s.listen(port, host, () => { failed(host, null); listening.set(host, s); resolve(true); });
  });
  const up = host => log(`listening on http://${host}:${port}`);
  if (!await listen(first)) die(o.bind ? `can't listen on ${o.bind}:${port}` : `port ${port} is taken. Is a coordinator already running? (dibs machines)`);
  // "listening" comes after remote.json is saved: whatever waits for the line
  // and then reads the file (a test on 2026-10-16) found it missing.
  if (fresh) saveRemote(fresh);
  up(first);
  fs.rmSync(path.join(HOME, 'jobs'), { recursive: true, force: true });   // jobs from a previous run are gone
  const announce = ip => {
    log(`other machines can reach http://${ip}:${port}. Give each its own token: dibs invite <name> on this machine`);
  };
  if (!o.bind) {
    const ts = tailscaleIp();
    if (ts && await listen(ts)) { up(ts); announce(ts); }
    else log('no Tailscale address yet, so only this machine can reach the coordinator. It starts listening on Tailscale as soon as it comes up.');
    setInterval(async () => {
      const ip = tailscaleIp();
      if (ip && !listening.has(ip) && await listen(ip)) { up(ip); announce(ip); }
    }, 30e3);
  } else if (o.bind !== '127.0.0.1') announce(o.bind);
  log(`this machine's token is in ${REMOTE} and only works here; other machines' tokens are in ${MACHINES} (hashed)`);
  let od = null;
  try {
    const list = ondemandOf(loadConfig());
    if (list.length) {
      od = ondemand(list, made, { port, log });
      log(`on-demand machines: ${list.map(m => `${m.name} (the ${m.provider} VM whose row in ${m.registry} has "${m.match}" in its Use${m.owner ? `, owned by ${m.owner}` : ''})`).join(', ')}`);
      await od.reconcile();
    }
  } catch (e) { log(`on-demand machines are off: ${e.message}`); }
  // The disk warnings and cleaning come from the throttle watcher (src/cool.mjs); while it
  // isn't running, the coordinator sends them, so one dead service can't silence them.
  let covering = false;
  const backup = setInterval(() => {
    const down = watcherDown();
    if (down !== covering) { covering = down; log(down ? "the throttle watcher isn't running, so the coordinator sends the low-disk notes and clears caches meanwhile" : 'the throttle watcher is back; it sends the low-disk notes again'); }
    if (down) hogsOnce(loadConfig(), machine());
  }, BACKUP_EVERY);
  backup.unref();
  const stop = async () => { if (od) await od.close(); for (const s of listening.values()) s.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
