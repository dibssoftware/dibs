// Everything that differs between macOS, Linux and Windows lives here, so the
// rest of dibs never checks the platform.
//
// macOS and Linux use ps and process groups. Windows uses PowerShell's CIM
// process table and taskkill /T, since it has neither.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

export const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const WIN = OS === 'windows';

// Output of a command, or null when it couldn't run at all (spawn failed under
// memory pressure, killed by a signal). Callers must not read null as "nothing".
function tryRun(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
  catch (e) { return typeof e.status === 'number' ? e.stdout || '' : null; }   // ps exits 1 when any pid is gone
}
const run = (cmd, args) => tryRun(cmd, args) ?? '';
const ps = script => tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

// pid -> start time string. Comparing start times keeps a recycled pid from
// passing as a live holder. null when the process table couldn't be read.
// The highest pid each system hands out (macOS's PID_MAX, Linux's PID_MAX_LIMIT).
// ps refuses a list with anything past it and prints nothing for the rest.
const PID_MAX = OS === 'macos' ? 99999 : OS === 'linux' ? 4194304 : Infinity;
export function starts(pids) {
  const out = new Map();
  // One bad number in the state file mustn't make every holder look dead.
  pids = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0 && p <= PID_MAX))];
  if (!pids.length) return out;
  if (WIN) {
    const txt = ps(`Get-CimInstance Win32_Process -Filter "${pids.map(p => `ProcessId=${p}`).join(' OR ')}" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" }`);
    if (txt == null) return null;
    for (const line of txt.split(/\r?\n/)) { const m = line.trim().match(/^(\d+)\s+(\d+)$/); if (m) out.set(Number(m[1]), m[2]); }
    return out;
  }
  // ps exits 1 with no output when every pid is gone, and also when it refuses
  // the list (it says why on stderr). The second is "can't tell", not "all dead".
  const r = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status == null || (r.status !== 0 && !r.stdout && r.stderr.trim())) return null;
  const txt = r.stdout;
  for (const line of txt.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

// Parent pid and executable name, for walking up to the owning agent.
export function parent(pid) {
  if (WIN) {
    const m = (ps(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; "$($p.ParentProcessId) $($p.Name)"`) ?? '').trim().match(/^(\d+)\s+(.*)$/);
    return m ? { ppid: Number(m[1]), name: m[2].replace(/\.exe$/i, '') } : null;
  }
  const m = run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  let name = path.basename(m[2]);
  // Linux's comm is a thread name, and Node (22 and later) names its main
  // thread MainThread: a Claude Code run under node, or anything else in Node,
  // would never show its own name. The program it was started as does.
  if (OS === 'linux' && !AGENTS.test(name)) try { name = path.basename(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]) || name; } catch {}
  return { ppid: Number(m[1]), name };
}

// Every process: pid, parent, process group, % of one core, resident bytes
// (not on Windows), command line. The group is the pid on Windows, which has
// no process groups.
let procCache = null;
export function processes() {
  if (procCache && Date.now() - procCache.at < 5000) return procCache.list;
  return (procCache = { at: Date.now(), list: readProcesses() }).list;
}

function readProcesses() {
  if (WIN) {
    // Two samples of total processor time, a second apart, give a CPU %.
    const txt = ps(`$a = @{}; Get-Process | ForEach-Object { $a[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds }; Start-Sleep -Milliseconds 1000;`
      + ` Get-CimInstance Win32_Process | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;`
      + ` if ($p -and $a[$p.Id] -ne $null) { "$($_.ProcessId)\`t$($_.ParentProcessId)\`t$([math]::Round(($p.TotalProcessorTime.TotalMilliseconds - $a[$p.Id]) / 10, 1))\`t$($_.CommandLine)" } }`);
    return (txt ?? '').split(/\r?\n/).map(l => l.split('\t')).filter(f => f.length === 4 && f[3])
      .map(([pid, ppid, cpu, args]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pid), cpu: Number(cpu), args }));
  }
  return run('ps', ['-Ao', 'pid=,ppid=,pgid=,pcpu=,rss=,args=']).split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cpu: Number(m[4]), rss: Number(m[5]) * 1024, args: m[6] }));
}

// Resident memory of every dibs on the machine: waiters, supervisors, holds,
// services, the broker. A node whose script is bin/dibs or dibs.mjs, flags or
// not, or a thin waiter's shell (src/thin.sh).
const DIBS_PROC = /^\S*\bnode\s+(?:-\S+\s+)*\S*(?:\/bin\/dibs|\/dibs\.mjs)(?:\s|$)|^\S*\bsh\s+\S*\/src\/thin\.sh(?:\s|$)/;
export const isDibs = p => DIBS_PROC.test(p.args);
export const dibsMem = (procs = processes()) => procs.reduce((a, p) => a + (isDibs(p) ? p.rss || 0 : 0), 0);

// Every process group that has a process in it right now.
export function liveGroups() {
  procCache = null;
  return new Set(processes().map(p => p.pgid));
}

// The pids in these process groups right now.
export function pidsIn(groups) {
  procCache = null;
  return processes().filter(p => groups.includes(p.pgid)).map(p => p.pid);
}

// Process groups of everything descended from pid (its own included). Children
// that start their own group (browsers, dev servers) are found this way.
export function descendants(pid) {
  procCache = null;
  const kids = new Map();
  for (const p of processes()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const groups = new Set(), stack = [pid];
  while (stack.length) for (const p of kids.get(stack.pop()) || []) { groups.add(p.pgid); stack.push(p.pid); }
  return groups;
}

// pid -> physical footprint in bytes, or null when it can't be read (callers
// fall back to RSS). RSS counts shared libraries in every process and leaves
// out compressed memory, so a tree's RSS sum can be off either way by gigabytes.
// macOS: one top call reads every process (about 0.3s of CPU, whatever the
// count), the same number Activity Monitor shows. Linux: PSS from
// smaps_rollup, which splits shared pages between the processes sharing them.
// Windows: null. DIBS_FAKE_FOOTPRINT names a JSON file of { pid: bytes } for tests.
const UNITS = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
// Every process's memory, the way Activity Monitor's Memory column adds it up
// on macOS: top's MEM plus CMPRS, what it holds in RAM plus what the system
// squeezed of it. For telling the person what to close (src/alerts.mjs), so
// all processes, not only dibs's. Linux: resident memory. DIBS_FAKE_MEMORY,
// a JSON file of { pid: bytes }, stands in for tests.
export function memoryUse() {
  if (process.env.DIBS_FAKE_MEMORY) {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(process.env.DIBS_FAKE_MEMORY, 'utf8'))).map(([p, b]) => [Number(p), b])); } catch { return new Map(); }
  }
  if (OS !== 'macos') return new Map(processes().map(p => [p.pid, p.rss || 0]));
  const txt = tryRun('top', ['-l', '1', '-o', 'mem', '-stats', 'pid,mem,cmprs']);
  const out = new Map();
  const size = x => { const m = x?.match(/^([\d.]+)([BKMGT])[+-]?$/); return m ? Number(m[1]) * UNITS[m[2]] : 0; };
  for (const line of (txt || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length === 3 && /^\d+$/.test(f[0])) out.set(Number(f[0]), size(f[1]) + size(f[2]));
  }
  return out;
}

export function footprints(pids) {
  if (process.env.DIBS_FAKE_FOOTPRINT) {
    let f = {};
    try { f = JSON.parse(fs.readFileSync(process.env.DIBS_FAKE_FOOTPRINT, 'utf8')); } catch {}
    return new Map(pids.map(p => [p, f[p] ?? 0]));
  }
  if (OS === 'linux') {
    const out = new Map();
    for (const pid of pids) {
      try { const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m); if (m) out.set(pid, Number(m[1]) * 1024); } catch {}
    }
    return out;
  }
  if (OS !== 'macos') return null;
  const txt = tryRun('top', ['-l', '1', '-stats', 'pid,mem']);
  if (txt == null) return null;
  const out = new Map();
  for (const line of txt.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)([BKMGT])[+-]?$/);
    if (m) out.set(Number(m[1]), Number(m[2]) * UNITS[m[3]]);
  }
  return out;
}

// Linux, with enforce: true in config.json: run the job in a systemd user
// scope with MemoryHigh at its memory budget (past it the kernel throttles and
// reclaims; it never kills) and CPUQuota at its cores. No root needed where a
// systemd user session runs. Where there's none (containers, WSL1, ssh
// without lingering) the command runs as it is.
export function scoped(argv, { mem, cpu }, { os: on = OS, works = scopeWorks } = {}) {
  if (on !== 'linux' || !works()) return argv;
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryHigh=${Math.round(mem)}`,
    ...(cpu > 0 ? ['-p', `CPUQuota=${Math.round(cpu * 100)}%`] : []), '--', ...argv];
}
const scopeWorks = () => !!which('systemd-run')
  && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { stdio: 'ignore', timeout: 5000 }).status === 0;

// Where a command would be found on PATH, or null. Checked before launching,
// so a missing command is reported as one even behind a wrapper (systemd-run, cmd.exe).
export function which(cmd, env = process.env) {
  const exts = WIN ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase()) : [''];
  const ok = f => { try { return fs.statSync(f).isFile() && (WIN || (fs.accessSync(f, fs.constants.X_OK), true)); } catch { return false; } };
  // On Windows an extensionless file (npm's sh script next to npm.cmd) can't be run, so PATHEXT comes first.
  const tryAll = base => (WIN ? (path.extname(base) ? [''] : exts) : ['']).map(e => base + e).find(ok) || null;
  if (cmd.includes('/') || (WIN && cmd.includes('\\'))) return tryAll(path.resolve(cmd));
  for (const d of (env.PATH || env.Path || '').split(path.delimiter)) if (d) { const f = tryAll(path.join(d, cmd)); if (f) return f; }
  return null;
}

// Windows runs .cmd shims (npm, npx) only through cmd.exe, which needs its own quoting.
const winQuote = a => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

// Start a command so the whole tree it spawns can be stopped together.
// Background priority keeps it off the fast cores (macOS) or below normal work.
// With gate, the command waits until child.go(): the caller records the
// process group first, so a caller killed in between leaves nothing untracked.
// If the caller dies before go(), the pipe closes and the command never starts.
const GATE = 'IFS= read -r _ <&3 || exit 125; exec 3<&-; exec "$@"';
export function launch(argv, { env, background = false, gate = false }) {
  let cmd = argv;
  if (WIN && /\.(cmd|bat)$/i.test(which(argv[0], env) || '')) cmd = ['cmd.exe', '/d', '/s', '/c', `"${argv.map(winQuote).join(' ')}"`];
  const gated = gate && !WIN;
  if (gated) cmd = ['/bin/sh', '-c', GATE, 'dibs', ...cmd];
  const child = spawn(cmd[0], cmd.slice(1), { stdio: gated ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
    detached: !WIN, env, windowsHide: false, windowsVerbatimArguments: cmd[0] === 'cmd.exe' });
  // Lowered from outside, as the throttle watcher does, so dibs boost can raise it again: on macOS
  // a process started under `taskpolicy -b` keeps background QoS whatever `taskpolicy -B -p` says.
  // Its children inherit it. Gated, the command doesn't start until it's lowered.
  if (background && child.pid) lower(child.pid);
  child.go = () => { if (gated) child.stdio[3].end('go\n'); };
  return child;
}

// dibs killed outright (kill -9) can't stop its job, which would run on until
// the next dibs call reaped it. So a small shell, in a group of its own, holds
// a pipe from dibs: "g N" adds a process group, "r N" removes one that has
// emptied, "done" means dibs is cleaning up itself. If the pipe closes without
// "done", dibs died, and the shell kills every group it was told about.
const WATCH = 'while read -r w g; do case $w in done) exit 0;; g) gs="$gs $g ";; r) gs=$(printf %s "$gs" | sed "s/ $g / /");; esac; done; '
  + 'for g in $gs; do kill -KILL -"$g" 2>/dev/null; done';
export function watchdog() {
  const none = { add() {}, drop() {}, done() {} };
  if (WIN) return none;
  let p;
  try { p = spawn('/bin/sh', ['-c', WATCH], { stdio: ['pipe', 'ignore', 'ignore'], detached: true }); } catch { return none; }
  p.on('error', () => {});
  p.stdin.on('error', () => {});
  p.unref();
  const send = line => { if (!p.stdin.destroyed) p.stdin.write(`${line}\n`); };
  return { add: g => send(`g ${g}`), drop: g => send(`r ${g}`), done: () => { if (!p.stdin.destroyed) p.stdin.end('done\n'); } };
}

// Stop a tree started by launch(). On macOS and Linux the tree is the process
// group; on Windows taskkill walks the children.
export function stopTree(id, signal = 'SIGTERM') {
  if (!id) return;
  if (WIN) { run('taskkill', ['/PID', String(id), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]); return; }
  try { process.kill(-id, signal); } catch {}
}

// Pids in these process groups that are still running: not stopped (T), not
// a zombie (Z, an exited child its stopped parent hasn't reaped), and not in
// the kernel (D on Linux, U on macOS): a SIGSTOP already sent stops it before it
// runs any of its own code again. On Linux dash's loop shell sits in D while it
// waits on a vfork child the stop caught (2026-10-19). On macOS a low job's
// writes are throttled while other work writes, and it sits in U: a third of the
// time beside two dd loops, and long enough under a DMG build that a pause read as
// never landing (2026-11-03). One ps call for all of them. Windows can't stop a
// tree, so there's nothing to check.
export const inKernelOrStopped = stat => /[TZDU]/.test(stat || '');
export function runningIn(groups) {
  if (WIN || !groups.length) return [];
  const want = new Set(groups.map(Number));
  return run('ps', ['-A', '-o', 'pid=,pgid=,stat=']).split('\n').map(l => l.trim().split(/\s+/))
    .filter(([pid, pgid, stat]) => pid && want.has(Number(pgid)) && !inKernelOrStopped(stat)).map(([pid]) => Number(pid));
}

// Lower a running process's priority: background QoS on macOS (efficiency
// cores on Apple silicon), nice 10 on Linux, below normal on Windows.
export function lower(pid) {
  try {
    if (OS === 'macos') execFileSync('taskpolicy', ['-b', '-p', String(pid)], { stdio: 'ignore' });
    else os.setPriority(pid, WIN ? os.constants.priority.PRIORITY_BELOW_NORMAL : 10);
    return true;
  } catch { return false; }
}

// Undo lower(), for work the owner moved up (dibs boost). Linux lets only root
// lower a nice value, so there it usually fails.
export function raise(pid) {
  try {
    if (OS === 'macos') execFileSync('taskpolicy', ['-B', '-p', String(pid)], { stdio: 'ignore' });
    else os.setPriority(pid, 0);
    return true;
  } catch { return false; }
}

// Free bytes on the volume holding dir, or null when it can't be read. Null,
// not Infinity: a failed reading must not pass as plenty of room.
export function freeDisk(dir) {
  try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; } catch { return null; }
}

// Free disk where dibs lives, swap in use, % of memory free, 1-minute load.
// Windows has no load average, so CPU busy % across all cores stands in for it.
export function pressure(dir) {
  const diskFree = freeDisk(OS === 'macos' ? '/System/Volumes/Data' : dir);
  let swapUsed = 0, swapFiles = null, memFree = Math.round(100 * os.freemem() / os.totalmem()), memAvail = null;
  if (OS === 'macos') {
    const sw = run('sysctl', ['-n', 'vm.swapusage']).match(/used = ([\d.]+)M/);
    if (sw) swapUsed = parseFloat(sw[1]) * 1024 ** 2;
    // The swap files' total size, which is what swap takes from the disk: macOS adds them a gigabyte at a time, ahead of what's used.
    const tot = run('sysctl', ['-n', 'vm.swapusage']).match(/total = ([\d.]+)M/);
    if (tot) swapFiles = parseFloat(tot[1]) * 1024 ** 2;
    const lvl = Number(run('sysctl', ['-n', 'kern.memorystatus_level']));
    if (lvl) memFree = lvl;   // counts reclaimable cache as free, unlike os.freemem
    memAvail = vmAvail(run('vm_stat', []));
  } else if (OS === 'linux') {
    try {
      const mi = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
        .map(l => l.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map(m => [m[1], Number(m[2]) * 1024]));
      memFree = Math.round(100 * mi.MemAvailable / mi.MemTotal);
      memAvail = mi.MemAvailable ?? null;
      swapUsed = (mi.SwapTotal || 0) - (mi.SwapFree || 0);
    } catch {}
  }
  let load = os.loadavg()[0];
  if (WIN) {
    const pct = Number(ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'));
    load = (pct || 0) / 100 * os.cpus().length;
  }
  // Cores actually in use. The load average also counts processes waiting on
  // disk, so heavy swapping can read 20 on a machine that's nearly idle.
  // Just the CPU column (13 ms) unless the full table is fresh anyway: the full one,
  // with every command line, took 60 ms of each dibs run's start on a busy Mac.
  let busy = null;
  if (!WIN) {
    const cpus = procCache && Date.now() - procCache.at < 5000 ? procCache.list.map(p => p.cpu || 0)
      : run('ps', ['-Ao', 'pcpu=']).split('\n').map(Number).filter(x => !isNaN(x));
    if (cpus.length) busy = cpus.reduce((a, c) => a + c, 0) / 100;
  }
  return { diskFree, swapUsed, ...(swapFiles != null && { swapFiles }), memFree, memAvail, load, busy, cores: os.cpus().length, os: OS };
}

// Memory a new job can take without anything going to swap, from vm_stat: pages
// free, inactive, speculative or purgeable. Not kern.memorystatus_level, which
// counts the compressor's pages as room: on 2026-10-22 it read 65% free while
// the compressor held 22 GB of pages in 4 GB and swap was eating the disk.
export function vmAvail(text) {
  const size = Number(String(text).match(/page size of (\d+) bytes/)?.[1]);
  if (!size) return null;
  const pages = k => Number(String(text).match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] || 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * size;
}

// Memory pressure: 0 normal, 1 warning, 2 critical (swapping hard), or null
// when the OS doesn't say. One sysctl on macOS; PSI on Linux, where a tenth of
// the last 10s fully stalled on memory counts as critical. Windows: null.
export function memPressure() {
  if (OS === 'macos') return { 1: 0, 2: 1, 4: 2 }[Number(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']))] ?? null;
  if (OS !== 'linux') return null;
  try {
    const t = fs.readFileSync('/proc/pressure/memory', 'utf8');
    const avg = kind => Number(t.match(new RegExp(`^${kind} avg10=([\\d.]+)`, 'm'))?.[1] || 0);
    return avg('full') >= 10 ? 2 : avg('some') >= 10 ? 1 : 0;
  } catch { return null; }
}

// Name of the agent program a process belongs to (claude, codex, cursor...).
export const AGENTS = /^(claude|codex|cursor-agent|aider|gemini|opencode|amp)$/i;
