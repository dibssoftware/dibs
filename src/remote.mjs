// Several machines. One runs `dibs serve` (the coordinator); every machine that
// takes jobs runs `dibs worker`; any machine can send a job with
// `dibs run <res> --anywhere` or `--on <machine>`. The working copy goes along,
// the output streams back, and the exit code and any --bring files come home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { HOME, resCfg } from './config.mjs';
import { identity } from './proc.mjs';
import { OS } from './platform.mjs';
import { run } from './commands.mjs';
import { dur, gb, size, die, say, sleep, now, clock, when, SIGNALS } from './util.mjs';
import { VERSION } from './version.mjs';
import { bold, dim } from './style.mjs';
import { rulesAbove, readRules, ruleAllows, isRuleFile, isCode, normCode, codeKey, codeProof } from './trust.mjs';
import { projectKey } from './files.mjs';
import { jobSize } from './simpool.mjs';
import { defaultMaxWait } from './acquire.mjs';
import { logChange } from './owner.mjs';
import { ondemandOf } from './ondemand.mjs';

export const REMOTE = path.join(HOME, 'remote.json');
export const DEFAULT_PORT = 7420;
// What a joining machine broadcasts to find coordinators with an open pairing code (src/serve.mjs).
export const FIND = 'dibs-find-v1';
export const LOST = 76;                 // exit code: the coordinator or the machine running the job went away before it started
export const MAYBE_RAN = 77;            // exit code: lost after the job started; it may have run, or still be running
export const MAX_BUNDLE = 300 * 1024 ** 2;   // a compressed working copy, or the files a job brings back

// Files that never leave this machine, even when git tracks them: by name,
// and anything inside a folder that only ever holds keys.
const SECRET_FILES = [
  '\\.env[^/]*', '[^/]+\\.env', '\\.dev\\.vars[^/]*', '\\.npmrc', '\\.yarnrc\\.yml', '\\.netrc', '\\.pypirc', '\\.git-credentials', '\\.pgpass', '\\.my\\.cnf',
  '\\.htpasswd', '\\.vault-token', '\\.boto', '\\.s3cfg', 'auth\\.json', 'token\\.(json|pickle)',
  'id_(rsa|dsa|ecdsa|ed25519)(?![^/]*\\.pub$)[^/]*', 'deploy_key(?![^/]*\\.pub$)[^/]*',
  '\\.?credentials(\\.(json|ya?ml|csv|txt|toml))?', '\\.?secrets?(\\.(json|ya?ml|toml|env|txt|ini))?',
  '[^/]*service[-_]account[^/]*\\.json', '[^/]*-firebase-adminsdk-[^/]*\\.json', 'client_secret[^/]*\\.json',
  '[^/]*\\.tfvars', '[^/]*\\.tfstate(\\.backup)?', 'kubeconfig[^/]*', '\\.kube/config', '\\.docker/config\\.json', '\\.config/gh/hosts\\.ya?ml',
  '[^/]*\\.(p8|p12|pfx|pem|key|keystore|jks|mobileprovision|provisionprofile|asc|gpg|ppk|keychain|keychain-db)',
];
const SECRET_DIRS = ['\\.ssh', '\\.aws', '\\.gnupg', '\\.dibs'];
export const SECRET = new RegExp(`(^|/)((${SECRET_FILES.join('|')})$|(${SECRET_DIRS.join('|')})/)`, 'i');
// Folders skipped when the working copy isn't a git repo (git uses .gitignore instead).
const SKIP_DIRS = new Set(['node_modules', 'DerivedData', 'build', 'dist', 'venv', '__pycache__', 'Pods', 'target']);
// Outside git, hidden folders stay home (they hold tools' settings and
// tokens), except these, which builds and tests read.
const KEEP_DOT_DIRS = new Set(['.github', '.husky', '.storybook', '.swiftpm', '.mvn', '.yarn', '.cargo', '.devcontainer', '.circleci', '.changeset', '.vscode']);

export const shortHost = () => os.hostname().replace(/\.(local|lan|home)$/i, '');

// { url, token, name } from `dibs join`, or null when this machine isn't in a
// group. A file that's there but can't be read goes to onBad, by default a
// stop with the reason: taken as "not in a group", a worker would wait for
// dibs join forever and the board would quietly drop the other machines.
export function remoteConf(onBad = die) {
  let c;
  try { c = JSON.parse(fs.readFileSync(REMOTE, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    return onBad(`${REMOTE} can't be read (${e.message}). Fix it, or connect again: dibs join <url> <token>`);
  }
  return c?.url && c?.token ? { name: shortHost(), ...c } : null;
}
// Written whole and swapped in, so a dibs reading it meanwhile never sees half a file.
export function saveRemote(c) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${REMOTE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, REMOTE);
}
// Never starting with '-', which would read as a flag in `dibs join <url> <token>`.
export function newToken() {
  for (;;) { const t = crypto.randomBytes(24).toString('base64url'); if (t[0] !== '-') return t; }
}

// One HTTP call to the coordinator. JSON in and out unless raw is set.
export async function call(rc, method, route, body, { timeout = 20e3, raw = false } = {}) {
  const headers = { authorization: `Bearer ${rc.token}`, 'x-dibs-version': VERSION };
  let payload;
  if (Buffer.isBuffer(body)) { payload = body; headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(new URL(route, rc.url), { method, headers, body: payload, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch {}
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

// The operating system a set of resources needs (sim and xcode-build need macOS).
function needsOs(cfg, res) {
  const want = [...new Set(res.map(r => resCfg(cfg, r).os).filter(Boolean))];
  if (want.length > 1) die(`${res.join(', ')} need different systems (${want.join(', ')}); no machine has both`);
  return want[0] || null;
}

const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };   // no ._ files from macOS
// Past MAX_BUNDLE, tar's output overflows the buffer (ENOBUFS): that's the size
// limit, said as one, with a 413 so retry() doesn't try again.
export function tarCreate(cwd, files, max = MAX_BUNDLE) {
  try {
    return execFileSync('tar', ['-czf', '-', '--no-xattrs', '--null', '-T', '-'],
      { cwd, input: files.join('\0'), env: tarEnv, maxBuffer: max, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOBUFS') throw Object.assign(new Error(`over the ${size(max)} limit compressed`), { status: 413 });
    throw e;
  }
}
// only: extract just these paths (files, or folders with everything under
// them), whatever else the archive holds.
export function tarExtract(dir, buf, only = null) {
  fs.mkdirSync(dir, { recursive: true });
  let members = [];
  if (only) {
    const listed = execFileSync('tar', ['-tzf', '-'], { input: buf, env: tarEnv, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, stdio: ['pipe', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
    members = listed.filter(m => { const n = safeRel(m); return n && only.some(p => n === p || n.startsWith(`${p}/`)); });
    if (!members.length) return [];
  }
  execFileSync('tar', ['-xzf', '-', ...(members.length ? ['--', ...members] : [])], { cwd: dir, input: buf, env: tarEnv, stdio: ['pipe', 'ignore', 'pipe'] });
  return members;
}

// A path with its links resolved, the same way every time it's compared. On
// Windows only the native call also expands 8.3 names (C:\Users\RUNNER~1): the JS
// one left a temp folder short and the home folder long, so the job's folder came
// out as ../../RUNNER~1/... relative to its own project.
const real = p => { try { return (OS === 'windows' ? fs.realpathSync.native : fs.realpathSync)(p); } catch { return p; } };

// The folder a working copy comes from: the git repo around cwd, or cwd itself.
function projectRoot(cwd = process.cwd()) {
  try { return real(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return real(cwd); }
}
// A load-held job may go to an on-demand machine on its own (acquire.mjs step)
// only when it can run there. Never one that needs macOS: a resource that
// says os macos, a command naming a macOS tool, or a local script that uses
// Apple frameworks. On 2026-10-18 the job that waited hours on load was OCR
// through Apple Vision, run as python3 tools/reocr_batch.py: nothing in the
// command says macOS, so the script itself is read. Only its first SCRIPT_PEEK
// bytes, where the imports are.
const MAC_TOOLS = /(^|[\s/;&|("'])(xcrun|xcodebuild|xcode-select|swift|swiftc|osascript|sw_vers|simctl|pbcopy|pbpaste|codesign|mdfind|sips|screencapture|launchctl|plutil)(?=\s|$)|\.swift\b/;
const MAC_FRAMEWORKS = /\b(import\s+(Vision|Quartz|AppKit|Foundation|CoreML|Cocoa)\b|from\s+(Vision|Quartz|AppKit|Foundation|CoreML|Cocoa)\s+import|objc\.|pyobjc|NSApplication|VNRecognizeTextRequest|osascript|xcrun)/;
const SCRIPT_PEEK = 64 * 1024;
export function macOnly(cmd, cwd) {
  if (MAC_TOOLS.test(cmd)) return true;
  for (const word of cmd.split(/\s+/)) {
    if (!/\.(py|sh|js|mjs|rb|pl|swift)$/.test(word)) continue;
    try {
      const fd = fs.openSync(path.resolve(cwd, word), 'r');
      const buf = Buffer.alloc(SCRIPT_PEEK);
      const n = fs.readSync(fd, buf, 0, SCRIPT_PEEK, 0);
      fs.closeSync(fd);
      if (MAC_FRAMEWORKS.test(buf.toString('utf8', 0, n)) || MAC_TOOLS.test(buf.toString('utf8', 0, n))) return true;
    } catch {}
  }
  return false;
}
// The checks that cost nothing: a run of a command, no file leases, nothing
// that needs macOS, a project that isn't the home folder, a coordinator, and
// an on-demand machine in this machine's config. That last one keeps a thin
// waiter from turning into Node to ask about a machine that isn't there; a
// machine that isn't the coordinator doesn't list them, so only the
// coordinator's own waiters ship on their own.
export function mayShip(me, cfg, cwd) {
  if (me.kind !== 'run' || !me.cmd || me.res.some(r => r.startsWith('files:'))) return false;
  try { if (!ondemandOf(cfg).length) return false; } catch { return false; }
  try { if (needsOs(cfg, me.res) === 'macos') return false; } catch { return false; }
  if (macOnly(me.cmd, cwd) || !remoteConf(() => null) || namesPaths(me.cmd)) return false;
  const root = gitRoot(cwd);
  if (!root) return false;
  const home = real(os.homedir());
  return !(root === path.parse(root).root || home === root || home.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}
// Only a git working copy ships on its own: that's what the copy is, and a
// folder outside git may hold anything.
function gitRoot(cwd) {
  try { return real(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return null; }
}
// A command that names a path of this machine (/Users/..., ~/...) means a file the
// copy on another machine won't have there, even one inside the project. On
// 2026-10-20 a browser run naming /Users/alex/... shipped to boat-1 and failed.
// The system's own folders are the same on Linux; a temp folder's files aren't.
const SYSTEM_PATHS = /^\/(bin|sbin|usr\/bin|usr\/sbin|dev|etc|proc)(\/|$)/;
export function namesPaths(cmd) {
  for (const m of String(cmd).matchAll(/(?:^|[\s'"=:(])(~?\/[^\s'";|&)<>]*)/g))
    if (!m[1].startsWith('//') && (m[1].startsWith('~') || !SYSTEM_PATHS.test(m[1]))) return true;
  return false;
}
// The on-demand machine a load-held job should go to, or null. The machines
// list is read at most once a minute per waiter; the job's .dibs.json rules
// pick among them, and one /place call asks the coordinator to agree (its
// limits, memory, a problem since). A placement back here means stay.
const MACHINES_FOR = 60e3;
let known = { at: 0, rows: [], jobs: [] };
// temp: a VM made for the job may be used too, when the one it stands beside
// is full. A memory wait asks for that (acquire.mjs step): the job was held
// for memory, and a full boat-1 would only hold it again. A load wait doesn't:
// the temporary VM is made for jobs bigger than boat-1, and costs more.
// Jobs pack onto boat-1 while what's sent there fits its memory, then onto the
// one temporary VM beside it: every VM woken or made is a boat start, and the
// account has 200 a day.
const VM_RESERVE = 1024 ** 3;   // the VM's own system and its dibs worker
export async function loadShipTarget(me, cfg, cwd, { temp = false } = {}) {
  const rc = remoteConf(() => null);
  if (!rc) return null;
  if (now() - known.at > MACHINES_FOR) {
    try { const r = await call(rc, 'GET', '/machines', undefined, { timeout: 8000 }); known = { at: now(), rows: r.machines || [], jobs: r.jobs || [] }; }
    catch { known = { at: now(), rows: [], jobs: [] }; }
  }
  const rule = readRules(rulesAbove(cwd));
  const root = projectRoot(cwd);
  const booked = name => known.jobs.filter(j => j.machine === name && j.state !== 'done').reduce((a, j) => a + (j.mem || 0), 0);
  const full = m => booked(m.name) + (me.mem || 0) > (m.ondemand.mem || m.memTotal || 0) - VM_RESERVE;
  // Not one that can't wake now (boat's starts used up, a failed wake): the job would only come back.
  const usable = known.rows.filter(m => m.ondemand && !m.ondemand.problem && !(m.ondemand.cantWake?.until > now()) && m.name !== rc.name && ruleAllows(rule, m.name, rc.name));
  const vms = usable.filter(m => !m.ondemand.temp);
  // The VM itself while the job fits beside what's there; then the VM made beside a full one; then the full one.
  // Any other wait goes only to a VM with room: one already full would only hold it again.
  const order = temp
    ? [...vms.filter(m => !full(m)), ...usable.filter(m => m.ondemand.temp && vms.some(v => v.name === m.ondemand.temp.of && full(v))), ...vms.filter(full)]
    : vms.filter(m => !full(m));
  for (const vm of order) {
    const need = { res: me.res, os: null, on: vm.name, from: rc.name, fromOs: OS, root: rootHash(rc.name, root), mem: me.mem, cpu: me.cpu, ...(rule.stayOn && { stayOn: rule.stayOn, rule: rule.text }) };
    try { if ((await call(rc, 'POST', '/place', need, { timeout: 8000 })).machine === vm.name) return vm.name; } catch {}
  }
  return null;
}

// A project's id: the sending machine and the folder, hashed.
const rootHash = (from, root) => crypto.createHash('sha1').update(`${from}:${root}`).digest('hex').slice(0, 12);
// The name of a project's copy on a worker, in ~/.dibs/work.
export const copyKey = (from, root) => `${String(from).replace(/[^\w.-]/g, '_')}-${String(root).replace(/[^\w]/g, '')}`;

// The files of the working copy at root (from projectRoot): in git, tracked
// files plus new ones git doesn't ignore; outside it, the folder minus build
// output. Secret-looking files stay behind.
function workingCopy(root, cwd = process.cwd()) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    files = [];
    const walk = rel => {
      for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && (!e.name.startsWith('.') || KEEP_DOT_DIRS.has(e.name))) walk(p); }
        else files.push(p);
      }
    };
    walk('');
  }
  const kept = [], secret = [];
  for (const f of new Set(files)) {
    let st;
    try { st = fs.lstatSync(path.join(root, f)); } catch { continue; }   // deleted but still tracked
    if (st.isDirectory()) continue;                                      // a submodule
    (SECRET.test(f) ? secret : kept).push(f);
  }
  const cwdRel = path.relative(root, real(cwd)).split(path.sep).join('/');
  return { files: kept.sort(), secret, cwdRel };
}

// Paths a job is allowed to touch: relative, inside its folder.
export function safeRel(p) {
  const n = path.posix.normalize(String(p).split(path.sep).join('/'));
  return n && n !== '.' && !n.startsWith('../') && n !== '..' && !path.posix.isAbsolute(n) && !/^[a-z]:/i.test(n) ? n : null;
}

// dibs run <res> --anywhere | --on <machine>
export async function remoteRun(o, cfg) {
  const rc = remoteConf();
  if (!rc) {
    if (o.on && o.on !== shortHost()) die(`this machine isn't connected to a coordinator, so it can't reach ${o.on}. Set one up: dibs join <url> <token>   (see dibs help)`);
    say('not connected to a coordinator (dibs join), so running here');
    return run(o, cfg);
  }
  if (!o.cmd || !o.cmd.length) die('nothing to run. Use: dibs run <resource> --anywhere -- <command>');
  const res = [...new Set(o.res)];
  if (!res.length) die('name a resource, e.g. dibs run test --anywhere -- npm test');
  const id = identity(o);
  // The project's .dibs.json decides before anything is sent: --on a machine it
  // doesn't allow is refused, and --anywhere stays here rather than go there.
  const rule = readRules(rulesAbove(process.cwd()));
  const refuse = (machine, rule) => {
    const msg = `${rule.text}, so it can't go to ${machine}`;
    if (o.on) die(msg);
    say(`${msg}; running here`);
    return run(o, cfg);
  };
  if (o.on && !ruleAllows(rule, o.on, rc.name)) return refuse(o.on, rule);
  const root = projectRoot();
  // Your home folder, or a folder above it, holds far more than a project, keys included.
  const home = real(os.homedir());
  if (root === path.parse(root).root || home === root || home.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    const msg = `${root} is your home folder or above it, and dibs won't send all of that to another machine. Run from the project's folder`;
    if (o.on && o.on !== rc.name) die(msg);
    if (!o.on) say(`${msg}; running here`);
    return run(o, cfg);
  }
  // Every .dibs.json that applies, including the ones inside the copy that
  // would be sent, makes the rule the coordinator and the worker enforce too.
  const wc = workingCopy(root);
  const all = readRules([...rulesAbove(process.cwd()), ...wc.files.filter(isRuleFile).map(f => path.join(root, f))]);
  if (o.on && !ruleAllows(all, o.on, rc.name)) return refuse(o.on, all);
  const { mem, cpu } = jobSize(cfg, res, o);
  const need = {
    res, os: needsOs(cfg, res), on: o.on || null, from: rc.name, fromOs: OS, root: rootHash(rc.name, root), mem, cpu,
    askedCpu: o.cpu ?? null,   // what --cpu said; cpu is the resource's guess, which never makes a bigger VM
    ...(all.stayOn && { stayOn: all.stayOn, rule: all.text }),
  };
  let place;
  try { place = await call(rc, 'POST', '/place', need, { timeout: 8000 }); }
  catch (e) {
    if (e.status === 401 && !(o.on && o.on !== rc.name)) { say(`the coordinator refused this machine: ${e.message}. Running here`); return run(o, cfg); }
    if (e.status) die(e.message);
    if (o.on && o.on !== rc.name) die(`can't reach the coordinator at ${rc.url} (${e.message}), so the job didn't go to ${o.on}`, LOST);
    say(`can't reach the coordinator at ${rc.url} (${e.message}); running here`);
    return run(o, cfg);
  }
  if (place.machine === rc.name) {
    // --on another machine that the coordinator sent back here says why (an on-demand VM it can't find).
    if (o.on !== rc.name) say(`running here: ${place.why}`);
    return run(o, cfg);
  }

  // The coordinator honors the rule too, but the code is ours to keep.
  if (!ruleAllows(all, place.machine, rc.name)) return refuse(place.machine, all);
  const bring = o.bring.map(p => safeRel(p) ?? die(`--bring takes a path inside this folder, not ${p}`));
  let buf;
  try { buf = tarCreate(root, wc.files); }
  catch (e) { if (e.status === 413) die(`the working copy is ${e.message}. Ignore build output in .gitignore`); throw e; }
  if (wc.secret.length) say(`kept ${wc.secret.length} secret-looking file${wc.secret.length > 1 ? 's' : ''} on this machine: ${wc.secret.slice(0, 4).join(', ')}${wc.secret.length > 4 ? ', ...' : ''}`);

  const job = await call(rc, 'POST', '/jobs', {
    ...need, machine: place.machine, cmd: o.cmd, cwdRel: wc.cwdRel, files: wc.files, bring,
    who: id.who, agent: id.agent, label: id.label, purpose: o.purpose || '', prio: o.prio, by: o.by, est: o.est,
    disk: o.disk, ports: o.ports, repo: projectKey(process.cwd()),   // its project, which one-per-project resources go by there
    // Decided here: the worker isn't in a Claude Code session, but this end, which waits for it, may be.
    ...((o.maxWait ?? defaultMaxWait()) === Infinity ? { wait: true } : { maxWait: o.maxWait }),
    askedMem: o.mem ?? null,   // what --mem said; need.mem is the resource default when it said nothing
  }).catch(e => die(`the coordinator refused the job: ${e.message}`, e.status ? 2 : LOST));
  await call(rc, 'PUT', `/jobs/${job.id}/bundle`, buf, { timeout: 300e3 })
    .catch(e => die(`couldn't send the working copy: ${e.message}`, LOST));
  say(`job ${job.id} goes to ${job.machine}, ${place.why} (sent ${wc.files.length} files, ${size(buf.length)})`);
  return follow(rc, job.id, bring);
}

// Exiting right after a write to a pipe drops whatever hasn't drained yet.
const drained = () => Promise.all([process.stdout, process.stderr].map(s => new Promise(r => s.write('', r))));

// How long a sender waits, after a coordinator restart, for the machine running
// its job to check in and hand it over again. A worker retries every 5s, and an
// on-demand VM's needs its forward started again.
const REATTACH = 2 * 6e4;
// Stream a job's output until it ends, then bring its files home and exit with its code.
async function follow(rc, jobId, bring) {
  let next = 0, failingSince = 0, cancelling = 0, started = false, unknownSince = 0;
  // Lost before the job started, it's safe to send again (76); after, it may have run (77).
  const lost = () => (started ? MAYBE_RAN : LOST);
  const cancel = async () => {
    if (cancelling) process.exit(130);   // a second Ctrl-C stops waiting
    cancelling = now();
    say(`stopping job ${jobId}...`);
    await call(rc, 'POST', `/jobs/${jobId}/cancel`, {}).catch(() => {});
  };
  for (const sig of SIGNALS) process.on(sig, cancel);
  for (;;) {
    let r;
    try {
      r = await call(rc, 'GET', `/jobs/${jobId}/out?after=${next}`, undefined, { timeout: 30e3 });
      failingSince = 0; unknownSince = 0;
    } catch (e) {
      // A coordinator that restarted forgets every job until the machine running
      // it checks in again (src/serve.mjs adopt). Wait for that; a job never
      // picked up again was lost with the old coordinator.
      if (e.status === 404) {
        if (!unknownSince) say(`the coordinator restarted and doesn't know job ${jobId} yet; waiting for the machine running it to check in again`);
        unknownSince ||= now();
        if (now() - unknownSince > REATTACH) die(`the coordinator restarted and no machine picked job ${jobId} up again in ${Math.round(REATTACH / 1000)}s. ${started ? 'It may have run: check before running it again' : "It hadn't started: it's safe to send again"}`, lost());
        await sleep(2000);
        continue;
      }
      if (e.status === 401 || e.status === 403) die(`the coordinator stopped accepting this machine (${e.message}). Job ${jobId} was stopped${started ? ' after it started' : ' before it started'}`, lost());
      failingSince ||= now();
      if (now() - failingSince > 60e3) die(`lost the coordinator at ${rc.url} for a minute (${e.message}). Job ${jobId} ${started ? 'may still be running; check before running it again' : "hadn't started"}. See dibs machines`, lost());
      await sleep(2000);
      continue;
    }
    if (r.gap) process.stderr.write(`\ndibs: (${size(r.gap)} of output dropped; the coordinator keeps the last 16M)\n`);
    for (const [s, d] of r.chunks) (s === 2 ? process.stderr : process.stdout).write(Buffer.from(d, 'base64'));
    next = r.next;
    if (r.state === 'running' || r.chunks.length) started = true;
    if (r.state === 'done') {
      if (r.why) say(r.why);
      if (r.artifacts && bring.length) {
        try {
          const got = tarExtract(process.cwd(), await call(rc, 'GET', `/jobs/${jobId}/artifacts`, undefined, { raw: true, timeout: 300e3 }), bring);
          say(got.length ? `brought back: ${bring.join(', ')}` : `nothing came back at ${bring.join(', ')}`);
        }
        catch (e) { say(`couldn't bring back ${bring.join(', ')}: ${e.message}`); }
      }
      await drained();
      process.exit(cancelling ? 130 : r.code);
    }
    if (cancelling && now() - cancelling > 15e3) die(`job ${jobId} didn't confirm it stopped; see dibs machines`, 130);
  }
}

// Where the Tailscale CLI may be: on PATH, or inside the Mac app.
export const TS_CLI = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
// How long a joiner listens for coordinators answering its broadcast, and gives each a hello.
const LOOKUP_MS = 1500, HELLO_MS = 2500;
// Tailscale peers asked at most: a big tailnet is asked about the machines it has online, not every one.
const MAX_PEERS = 64;

// This machine's Tailscale peers that are online, as IPv4 addresses. DIBS_TAILSCALE
// names the CLI to ask instead (none: there's no Tailscale), so tests never reach a real tailnet.
function tailnetPeers() {
  const env = process.env.DIBS_TAILSCALE;
  if (env === 'none') return [];
  for (const cli of env ? [env] : TS_CLI) {
    try {
      const st = JSON.parse(execFileSync(cli, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 ** 2 }));
      return Object.values(st.Peer || {}).filter(p => p.Online).map(p => (p.TailscaleIPs || []).find(ip => /^100\.\d+\.\d+\.\d+$/.test(ip))).filter(Boolean).slice(0, MAX_PEERS);
    } catch {}
  }
  return [];
}

// Coordinators with an open pairing code on this network: a UDP broadcast on every
// interface (and loopback), answered with where to reach them. DIBS_PAIR_PORT moves it off 7420.
function lookup() {
  const port = Number(process.env.DIBS_PAIR_PORT) || DEFAULT_PORT;
  const targets = new Set(['255.255.255.255', '127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || !a.netmask) continue;
    const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
    targets.add(ip.map((x, i) => (x & mask[i]) | (~mask[i] & 255)).join('.'));
  }
  return new Promise(resolve => {
    const found = new Set();
    const sock = dgram.createSocket('udp4');
    const done = () => { try { sock.close(); } catch {} resolve([...found]); };
    sock.on('error', done);
    sock.on('message', (msg, from) => {
      try {
        const r = JSON.parse(String(msg));
        if (r.t !== 'dibs-coordinator-v1' || !Number.isInteger(r.port)) return;
        for (const u of Array.isArray(r.urls) ? r.urls : []) if (typeof u === 'string' && /^http:\/\/[\w.:[\]-]+$/.test(u)) found.add(u);
        found.add(`http://${from.address}:${r.port}`);
      } catch {}
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      for (const tgt of targets) sock.send(FIND, port, tgt, () => {});
      setTimeout(done, LOOKUP_MS);
    });
  });
}

// Which of these coordinators holds the code: each is asked to prove it (src/serve.mjs
// /pair/hello) before the code goes anywhere, so a machine that only answers learns nothing.
async function holder(urls, code) {
  const key = codeKey(code);
  const tries = urls.map(async url => {
    const nj = crypto.randomBytes(32).toString('base64url');
    const r = await call({ url, token: '' }, 'POST', '/pair/hello', { n: nj }, { timeout: HELLO_MS });
    if (typeof r?.nc !== 'string' || !Array.isArray(r.proofs) || !r.proofs.includes(codeProof(key, nj, r.nc))) throw new Error('not this one');
    return { url, name: r.name };
  });
  try { return await Promise.any(tries); } catch { return null; }
}

// dibs join <code> [--at <address>]: the one step after dibs pair --machine on the coordinator.
async function joinWithCode(o, code) {
  const name = o.name || shortHost();
  let urls, where;
  if (o.at) {
    let u;
    try { u = new URL(/^https?:\/\//.test(o.at) ? o.at : `http://${o.at}`); } catch { die(`can't read ${o.at} as an address`); }
    if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_PORT);
    urls = [u.origin];
    where = u.origin;
  } else {
    const net = await lookup(), peers = tailnetPeers();
    urls = [...new Set([...net, ...peers.map(ip => `http://${ip}:${DEFAULT_PORT}`)])];
    where = `this network${net.length ? ` (${net.length} answered)` : ''}${peers.length ? ` and ${peers.length} Tailscale peer${peers.length === 1 ? '' : 's'}` : ''}`;
  }
  const found = urls.length ? await holder(urls, code) : null;
  if (!found) die(`no coordinator holding that code answered on ${where}. Is the code still open (dibs pair --list on the coordinator)? If the coordinator is on another network, give its address: dibs join ${normCode(code).replace(/^(.{4})/, '$1-')} --at <address>`, 1);
  let r;
  try { r = await call({ url: found.url, token: '' }, 'POST', '/pair/join', { code: normCode(code), name }, { timeout: 8000 }); }
  catch (e) { die(e.status ? `the coordinator at ${found.url} refused: ${e.message}` : `can't reach ${found.url}: ${e.message}`, e.status ? (e.status === 401 ? 1 : 2) : LOST); }
  const rc = { url: found.url, token: r.token, name: r.name };
  saveRemote(rc);
  logChange('join', { url: found.url, code: true });   // never the code or the token
  console.log(`joined ${found.name || 'the coordinator'} at ${found.url} as ${r.name} (coordinator dibs ${r.version})`);
  console.log(`  take jobs on this machine: dibs service install worker   (or run dibs worker in a terminal)`);
  console.log(`  send a job: dibs run test --anywhere -- npm test`);
}

// dibs join <url> <token>, or dibs join <code>: connect this machine to a coordinator.
export async function join(o) {
  if (o.res.length === 1 && isCode(o.res[0])) return joinWithCode(o, o.res[0]);
  if (o.at) die('--at goes with a pairing code: dibs join <code> --at <address>');
  const [url, token] = o.res;   // the two words that aren't flags
  if (!url || !token) die('dibs join <code> (from dibs pair --machine on the coordinator), or dibs join <url> <token> (from dibs invite)');
  let u;
  try { u = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`); } catch { die(`can't read ${url} as an address`); }
  if (!u.port && u.protocol === 'http:') u.port = String(DEFAULT_PORT);
  logChange('join', { url: u.origin });   // never the token
  const rc = { url: u.origin, token, name: o.name || remoteConf(() => null)?.name || shortHost() };   // joining again is the fix for a broken file
  let hello;
  try { hello = await call(rc, 'GET', '/hello', undefined, { timeout: 8000 }); }
  catch (e) { die(e.status === 401 ? `the coordinator rejected that token: ${e.message}` : `can't reach ${rc.url}: ${e.message}`, e.status ? 2 : LOST); }
  saveRemote(rc);
  console.log(`joined ${rc.url} as ${rc.name} (coordinator dibs ${hello.version}, ${hello.machines.length} machine${hello.machines.length === 1 ? '' : 's'} online${hello.machines.length ? `: ${hello.machines.join(', ')}` : ''})`);
  console.log(`  take jobs on this machine: dibs service install worker   (or run dibs worker in a terminal)`);
  console.log(`  send a job: dibs run test --anywhere -- npm test`);
}

const sendsNote = (r, name) => { const s = r.sends?.[name]; return !s ? '' : s.length ? `sends only ${s.join(',')}` : 'sends nothing'; };

// dibs machines: every machine in the group, and the jobs moving between them.
export async function machines(o) {
  const rc = remoteConf();
  // A read, not a mistake: outside a group there's nothing to list (exit 0, not 2 as before 2026-11-03).
  if (!rc) {
    if (o.json) return console.log(JSON.stringify({ group: false, machines: [], jobs: [] }, null, 1));
    return console.log("this machine isn't in a group. dibs pair --machine on a coordinator adds one (then dibs join <code> here); dibs serve makes this one the coordinator.");
  }
  let r;
  try { r = await call(rc, 'GET', '/machines', undefined, { timeout: 8000 }); }
  catch (e) { die(`can't reach the coordinator at ${rc.url}: ${e.message}`, LOST); }
  if (o.json) return console.log(JSON.stringify(r, null, 1));
  const t = r.now;
  const here = copyKey(rc.name, rootHash(rc.name, projectRoot()));
  const live = r.machines.filter(m => !m.lost);
  const moving = r.jobs.filter(j => j.state !== 'done');
  console.log(bold(!r.machines.length ? 'No machines are taking jobs yet. On each one: dibs service install worker'
    : `${live.length} machine${live.length === 1 ? '' : 's'} taking jobs${live.length < r.machines.length ? `, ${r.machines.length - live.length} not reporting` : ''}`
      + `${moving.length ? `, ${moving.length} job${moving.length === 1 ? '' : 's'} moving between them` : ''}.`));
  const rows = r.machines.map(m => {
    const lines = Object.entries(m.busy || {}).filter(([, b]) => b.used || b.waiting)
      .map(([k, b]) => `${k} ${b.used} of ${b.slots}${b.waiting ? `, ${b.waiting} waiting` : ''}`);
    const perCore = m.load / (m.cores || 1);
    const vm = m.ondemand;
    // A sleeping VM has no readings of its own; its row says what it is instead.
    if (vm && vm.state !== 'running')
      return [m.name, m.os, m.cores, vm.problem ? 'unusable' : vm.cantWake ? "can't wake" : vm.state, '-', '-', vm.problem ? `on-demand ${vm.provider} VM, can't be used: ${vm.problem}`
        : vm.cantWake ? `can't wake: ${vm.cantWake.why}, checks again ${when(vm.cantWake.until)}`
        : vm.temp ? `${vm.provider} VM made for jobs too big for ${vm.temp.of} (up to ${vm.temp.max}), deleted after`
        : `${vm.state === 'asleep' ? `on-demand ${vm.provider} VM: a job sent here wakes it (${vm.resumeMs ? `~${Math.round(vm.resumeMs / 1000)}s` : 'under a minute'})` : `on-demand ${vm.provider} VM`}`];
    const notes = [vm ? `${vm.temp ? `temporary ${vm.provider} VM, deleted` : `on-demand ${vm.provider} VM, stops`} after ${dur(vm.idleStop)} idle` : '', m.lost ? `NOT REPORTING (last heard ${dur(t - m.seen)} ago)` : '', m.name !== rc.name && m.copies?.[here] ? `has this project${m.copies[here].free ? '' : ' (in use)'}` : '',
      m.only ? `only takes ${m.only.join(',')}` : '', sendsNote(r, m.name), m.version !== r.version ? `runs dibs ${m.version}` : ''].filter(Boolean);
    return [m.name + (m.name === rc.name ? ' (here)' : ''), m.os, m.cores, perCore < 0.5 ? 'quiet' : perCore < 1 ? 'busy' : 'very busy', `${m.memFree}%`,
      m.diskFree == null ? 'disk unknown' : gb(m.diskFree).replace(/G$/, ' GB'), [lines.join('; ') || '-', ...notes].join('  ')];
  });
  if (rows.length) {
    const head = ['', 'system', 'cores', 'busy', 'memory free', 'disk free', 'in use'];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map(x => String(x[i]).length)));
    console.log();
    for (const x of [head, ...rows]) console.log(`  ${x.map((c, i) => (i === x.length - 1 ? String(c) : String(c).padEnd(w[i]))).join('  ')}`.trimEnd());
  }
  // A coordinator that just started hears from this machine's worker a few seconds later; until then it isn't in the list.
  if (r.started && !r.machines.some(m => m.name === rc.name))
    console.log(`  ${rc.name} (here)  worker hasn't checked in since the coordinator started at ${clock(r.started)}`);
  for (const m of r.invited || [])
    console.log(`  ${m.name.padEnd(16)} ${m.joined ? 'no worker running since the coordinator started' : `invited ${dur(t - m.invited)} ago, hasn't joined yet`}`
      + `${r.limits?.[m.name] ? `  only takes ${r.limits[m.name].join(',')}` : ''}${sendsNote(r, m.name) ? `  ${sendsNote(r, m.name)}` : ''}`);
  const removed = (r.removed || []).filter(m => t - m.at < 24 * 3.6e6);
  if (removed.length) console.log(`  removed in the last day: ${removed.map(m => `${m.name} (${dur(t - m.at)} ago)`).join(', ')}`);
  const jobs = r.jobs.filter(j => j.state !== 'done' || t - j.doneAt < 5 * 6e4);
  if (jobs.length) {
    console.log(`\n${bold('Jobs sent between machines')}`);
    for (const j of jobs)
      console.log(`  #${String(j.id).padEnd(3)} ${(j.agent || j.who).padEnd(20)} ${`${j.from} -> ${j.machine}`.padEnd(22)} ${(j.state === 'done' ? `done, exit ${j.code}` : j.state).padEnd(12)}`
        + ` ${dur(t - j.created).padStart(6)}  ${j.res.join(',')}${j.purpose ? `  "${j.purpose}"` : ''}  ${dim(j.cmd.join(' ').slice(0, 40))}`);
  }
  console.log(`\n${dim(`Coordinator: ${rc.url}, dibs ${r.version}. Send a job: dibs run <resource> --anywhere -- <command>`)}`);
}
