// dibs worker: take jobs from the coordinator and run them here, each through
// this machine's own dibs queue, so local agents and remote jobs take turns.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, machine, resCfg } from './config.mjs';
import { withState, history } from './state.mjs';
import { used } from './schedule.mjs';
import { markIdle, tableFirst } from './acquire.mjs';
import { boardOf } from './board.mjs';
import { singleInstance } from './proc.mjs';
import { OS, stopTree } from './platform.mjs';
import { REMOTE, remoteConf, call, tarCreate, tarExtract, safeRel, copyKey, LOST } from './remote.mjs';
import { readRules, ruleAllows, isRuleFile } from './trust.mjs';
import { now, sleep, bytes, log, SIGNALS, signalExit, LEAN } from './util.mjs';
import { VERSION } from './version.mjs';
import { runLater } from './later.mjs';
import { unpatched } from './nodecheck.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dibs.mjs');
const PIDFILE = path.join(HOME, 'worker.pid');
const WORK = path.join(HOME, 'work');
const FLUSH = 250;
const REJOIN_CHECK = 3000;
// --ephemeral, a worker on an on-demand VM (src/ondemand.mjs): with its
// coordinator out of reach this long (the forward dropped, the coordinator
// stopped), it leaves, since nobody is left to stop the VM's work or read it.
// DIBS_LOST_EXIT_MS lets a test see it leave in seconds.
const EPHEMERAL_LOST = Number(process.env.DIBS_LOST_EXIT_MS) || 60e3;
// With a job running it waits longer: a coordinator restart (every release does
// one) comes back and picks the job up again, and the job keeps the VM busy, so
// nothing stops it as idle meanwhile.
const EPHEMERAL_LOST_BUSY = 10 * 6e4;

// What the coordinator needs to pick a machine: size, load, each resource's
// line here and the copies kept here. Plus this machine's board, for other machines to show.
function report(cfg, name, running, inUse = new Set()) {
  const m = machine();
  const hist = history();
  tableFirst();
  const { busy, board } = withState(s => {
    markIdle(s);
    const out = {};
    const names = new Set([...Object.keys(cfg.resources), ...s.leases.flatMap(l => l.res), ...s.queue.flatMap(q => q.res)]);
    for (const r of names) out[r] = { used: used(s, r), slots: resCfg(cfg, r).slots, waiting: s.queue.filter(q => q.pid && q.res.includes(r)).length };
    return { busy: out, board: boardOf(s, cfg, hist) };
  });
  return { name, os: OS, cores: m.cores ?? os.cpus().length, memTotal: os.totalmem(), memFree: m.memFree, load: m.load,
           diskFree: m.diskFree, version: VERSION, busy, running, copies: copies(inUse), board };
}

// The copies kept here, by project: when one was last used and how many aren't
// in use by a job right now. Names and times only, nothing from inside them.
export function copies(inUse = new Set(), work = WORK) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(work, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return out; }
  for (const n of names) {
    const key = n.match(/^(.+-[0-9a-f]{12})(-\d+)?$/)?.[1];
    if (!key) continue;
    const dir = path.join(work, n);
    let at;
    try { at = fs.statSync(`${dir}.files`).mtimeMs; } catch { continue; }   // never finished unpacking
    const c = out[key] ||= { used: 0, free: 0 };
    c.used = Math.max(c.used, Math.round(at));
    if (!inUse.has(dir)) c.free++;
  }
  return out;
}

// A folder per sender and working copy, reused between jobs so installed
// dependencies and build caches survive. Two jobs at once get two folders.
function workspace(job, inUse) {
  const base = copyKey(job.from, job.root);
  for (let n = 1; ; n++) {
    const dir = path.join(WORK, n === 1 ? base : `${base}-${n}`);
    if (!inUse.has(dir)) return dir;
  }
}

// A job's copy, deleted, and its file list. A job can leave folders it can't
// be deleted from (a read-only node_modules/.bin): on 2026-10-20 one such copy
// threw EACCES, crashed boat-1's worker, and took every job running there with it.
// So what's read-only is made writable first, and a copy that still won't go
// is left for the next cleanup, said in the log.
function dropCopy(d) {
  const rm = () => { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(`${d}.files`, { force: true }); };
  try { rm(); return true; } catch {}
  const open = p => {
    try { fs.chmodSync(p, 0o700); } catch {}
    let list = [];
    try { list = fs.readdirSync(p, { withFileTypes: true }); } catch {}
    for (const e of list) if (e.isDirectory() && !e.isSymbolicLink()) open(path.join(p, e.name));
  };
  open(d);
  try { rm(); return true; } catch (e) { log(`couldn't delete the copy ${path.basename(d)}: ${e.message}`); return false; }
}

// Copies nobody has sent work to for a week are deleted, and when disk runs
// low every copy not in use goes, oldest first.
const KEEP_WORK = 7 * 24 * 3600e3;
export function cleanWork(cfg, inUse, work = WORK) {
  let dirs = [];
  try { dirs = fs.readdirSync(work, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(work, e.name)); } catch { return; }
  const used = d => { try { return fs.statSync(`${d}.files`).mtimeMs; } catch { try { return fs.statSync(d).mtimeMs; } catch { return 0; } } };
  const idle = dirs.filter(d => !inUse.has(d)).sort((a, b) => used(a) - used(b));
  const low = () => { const free = machine().diskFree; return free != null && free < 2 * bytes(cfg.minDisk); };
  for (const d of idle) {
    if (now() - used(d) < KEEP_WORK && !low()) continue;
    if (dropCopy(d)) log(`deleted the unused copy ${path.basename(d)}`);
  }
}

// Files the last job had that this one doesn't were deleted by the sender.
function prune(dir, files) {
  const list = `${dir}.files`;
  let old = [];
  try { old = JSON.parse(fs.readFileSync(list, 'utf8')); } catch {}
  const keep = new Set(files);
  for (const f of old) {
    const rel = safeRel(f);
    if (rel && !keep.has(rel)) fs.rmSync(path.join(dir, rel), { force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(list, JSON.stringify(files));
}

// 404 too: a coordinator that just restarted doesn't know the job until this
// worker's next check-in tells it (src/serve.mjs adopt), so the output and the
// exit code wait for that rather than being lost.
async function retry(fn, what, ms = 60e3) {
  const t = now();
  for (;;) {
    try { return await fn(); } catch (e) {
      if (e.status && e.status !== 404 && e.status !== 502 && e.status !== 503) throw e;
      if (now() - t > ms) throw new Error(`${what}: ${e.message}`);
      await sleep(1000);
    }
  }
}

export async function worker(o, cfg) {
  { const hole = unpatched(); if (hole) console.error(`warning: ${hole}. Then dibs service install worker on a fixed Node replaces this one.`); }
  // Scheduled jobs (dibs later) are this machine's own, so they run whether or not it ever joins a coordinator.
  runLater();
  let rc = remoteConf();
  if (!rc) {
    // As a service it may start before dibs serve or dibs join has written the address.
    console.log('not connected to a coordinator yet; waiting for dibs join (or dibs serve on this machine)');
    while (!(rc = remoteConf())) await sleep(5000);
  }
  let name = o.name || rc.name;
  await singleInstance(PIDFILE, 'a worker is already running here');
  const running = new Map();   // job id -> { dir, stop() }
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    log(`stopping ${running.size} job${running.size === 1 ? '' : 's'} and leaving`);
    for (const r of running.values()) r.stop(`${name} was shut down`);
    const t = now();
    const check = setInterval(() => {
      if (!running.size || now() - t > 15e3) { try { if (Number(fs.readFileSync(PIDFILE, 'utf8')) === process.pid) fs.rmSync(PIDFILE); } catch {} process.exit(0); }
    }, 200);
  };
  for (const sig of SIGNALS) process.on(sig, quit);
  log(`taking jobs as ${name} from ${rc.url}`);
  let down = 0;
  while (!quitting) {
    let r;
    try {
      // What each running job is, so a coordinator that restarted can pick it up again.
      r = await call(rc, 'POST', '/worker/beat', { ...report(cfg, name, [...running.keys()], new Set([...running.values()].map(x => x.dir))),
        jobs: [...running.values()].map(x => x.job) }, { timeout: 25e3 });
      if (down) log(`back in touch with ${rc.url}`);
      down = 0;
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        // Exiting would only get us restarted by launchd or systemd, over and over.
        log(`the coordinator at ${rc.url} turned this machine away: ${e.message}. Not taking jobs until dibs join is run here again`);
        for (const r of running.values()) r.stop(`${name} was turned away by the coordinator`);
        const old = JSON.stringify(rc);
        while (!quitting) {
          await sleep(REJOIN_CHECK);
          const n = remoteConf();
          if (n && JSON.stringify(n) !== old) { rc = n; name = o.name || rc.name; log(`${REMOTE} changed; taking jobs as ${name} from ${rc.url}`); break; }
        }
        continue;
      }
      if (!down) log(`can't reach ${rc.url} (${e.message}); retrying`);
      down ||= now();
      const limit = running.size ? EPHEMERAL_LOST_BUSY : EPHEMERAL_LOST;
      if (o.ephemeral && now() - down > limit) { log(`no coordinator for ${Math.round(limit / 1000)}s on an on-demand machine: leaving`); quit(); break; }
      await sleep(5000);
      continue;
    }
    for (const id of r.cancel) running.get(id)?.stop();
    for (const job of r.jobs) start(rc, job, running, cfg, name);
  }
}

// The `dibs run` a job becomes here: the sender's flags, in this machine's queue.
export function runArgs(job) {
  const args = ['run', job.res.join(','), '--as', job.label || 'remote'];
  if (job.purpose) args.push('-m', job.purpose);
  if (job.prio) args.push('-p', job.prio);
  if (job.by) args.push('--by', String(Math.max(1, Math.round((job.by - now()) / 1000))) + 's');
  if (job.est) args.push('--est', `${Math.round(job.est / 1000)}s`);
  // Only a --mem the sender gave: the resource default is this machine's own,
  // and a pool resource adds its simulator on top of any --mem.
  const mem = 'askedMem' in job ? job.askedMem : job.mem;
  if (mem) args.push('--mem', String(mem));
  if (job.cpu != null) args.push('--cpu', String(job.cpu));
  if (job.disk) args.push('--disk', String(job.disk));
  if (job.wait) args.push('--wait');
  else if (job.maxWait != null) args.push(job.maxWait === 0 ? '--no-wait' : '--max-wait', ...(job.maxWait === 0 ? [] : [`${Math.round(job.maxWait / 1000)}s`]));
  for (const p of job.ports || []) args.push('--port', p);
  args.push('--', ...job.cmd);
  return args;
}

function start(rc, job, running, cfg, name) {
  const inUse = new Set([...running.values()].map(r => r.dir));
  const dir = workspace(job, inUse);
  try { cleanWork(cfg, new Set([...inUse, dir])); } catch (e) { log(`cleaning ~/.dibs/work: ${e.message}`); }
  let child = null, stopped = false, stopWhy = null, killTimer = null, ended = false;
  // dibs run passes SIGTERM on to the job's process tree and releases its lease.
  const kill = () => {
    if (!child || killTimer) return;
    try { child.kill('SIGTERM'); } catch {}
    // If dibs run doesn't finish in time, kill it; the next state read then
    // reaps its lease and kills what the job left running.
    killTimer = setTimeout(() => { stopTree(child.pid, 'SIGKILL'); setTimeout(() => withState(() => {}), 500); }, 10e3);
  };
  const entry = {
    dir,
    job: { id: job.id, from: job.from, who: job.who, agent: job.agent, label: job.label, res: job.res, cmd: job.cmd, purpose: job.purpose, created: job.created, bring: job.bring },
    // why is for the sender when someone else stopped it; a sender's own cancel needs none.
    stop: why => {
      if (stopped) return;
      stopped = true;
      stopWhy = why || null;
      kill();
    },
  };
  running.set(job.id, entry);
  log(`job ${job.id} from ${job.agent || job.who}@${job.from}: ${job.cmd.join(' ').slice(0, 100)}`);

  // Output goes up in order, a batch at a time.
  let pending = [], sending = Promise.resolve();
  const flush = () => {
    if (!pending.length) return sending;
    const chunks = pending.map(([s, d]) => [s, d.toString('base64')]);
    pending = [];
    sending = sending.then(() => retry(() => call(rc, 'POST', `/jobs/${job.id}/out`, { chunks }), 'sending output')
      .then(a => { if (a.cancel) entry.stop(); }, e => log(`job ${job.id}: ${e.message}`)));
    return sending;
  };
  const timer = setInterval(flush, FLUSH);
  const tellSender = msg => pending.push([2, Buffer.from(`dibs@${rc.name || 'worker'}: ${msg}\n`)]);

  const end = async (code, why) => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    clearTimeout(killTimer);
    await flush();
    const cwd = path.join(dir, job.cwdRel || '');
    const want = (job.bring || []).map(safeRel).filter(Boolean);
    const have = want.filter(p => fs.existsSync(path.join(cwd, p)));
    if (want.length && !stopped) {
      if (have.length < want.length) { tellSender(`nothing at ${want.filter(p => !have.includes(p)).join(', ')} to bring back`); await flush(); }
      if (have.length) {
        try { await retry(() => call(rc, 'PUT', `/jobs/${job.id}/artifacts`, tarCreate(cwd, have), { timeout: 300e3 }), 'sending files back'); }
        catch (e) { tellSender(`couldn't send ${have.join(', ')} back: ${e.message}`); await flush(); }
      }
    }
    try { await retry(() => call(rc, 'POST', `/jobs/${job.id}/done`, { code, why: stopWhy || why }), 'reporting the exit code'); }
    catch (e) { log(`job ${job.id}: ${e.message}`); }
    running.delete(job.id);
    // The copy stays, on an on-demand VM too: its disk outlives each wake, and the
    // next job from the project gets only the changed files, its node_modules and
    // build output as the last job left them, and the browsers in ~/.cache. A copy
    // nobody uses for a week, or any idle one when the disk runs low, goes (cleanWork).
    log(`job ${job.id} ended: exit ${code}`);
  };

  (async () => {
    // The sender checked its project's rule, and so did the coordinator; this is the last door.
    if (job.stayOn && job.from !== name && !job.stayOn.includes(name)) return end(2, `${name} refused it: ${job.rule || 'the project rule'}`);
    try {
      const buf = await retry(() => call(rc, 'GET', `/jobs/${job.id}/bundle`, undefined, { raw: true, timeout: 300e3 }), 'fetching the working copy');
      if (stopped) return end(130);
      prune(dir, (job.files || []).map(safeRel).filter(Boolean));
      tarExtract(dir, buf);
    } catch (e) { return end(LOST, `${rc.name} couldn't unpack the working copy: ${e.message}`); }
    // The copy's own .dibs.json files, read here rather than taken on the sender's word.
    const rule = readRules((job.files || []).map(safeRel).filter(f => f && isRuleFile(f)).map(f => path.join(dir, f)));
    if (!ruleAllows(rule, name, job.from)) {
      dropCopy(dir);
      return end(2, `${name} refused it and deleted the copy: ${rule.text}`);
    }
    if (job.cwdRel && !safeRel(job.cwdRel)) return end(2, `bad working folder ${job.cwdRel}`);
    const cwd = path.join(dir, job.cwdRel || '');
    fs.mkdirSync(cwd, { recursive: true });
    // Through bin/dibs.mjs's sh lines, so the job waits thin here like a local one (Node on Windows).
    const argv = OS === 'windows' ? [process.execPath, ...LEAN, BIN] : ['/bin/sh', BIN];
    const env = { ...process.env, DIBS_AGENT: `${job.agent || job.who}@${job.from}`, DIBS_NO_SESSION: '1', DIBS_REMOTE_JOB: String(job.id), ...(typeof job.repo === 'string' && job.repo && { DIBS_REPO: job.repo }) };
    delete env.DIBS_AS;
    child = spawn(argv[0], [...argv.slice(1), ...runArgs(job)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: OS !== 'windows', windowsHide: true });
    child.stdout.on('data', d => pending.push([1, d]));
    child.stderr.on('data', d => pending.push([2, d]));
    if (stopped) kill();
    child.on('error', e => end(127, `couldn't start dibs: ${e.message}`));
    child.on('exit', (code, sig) => end(code ?? signalExit(sig)));
  })();
}
