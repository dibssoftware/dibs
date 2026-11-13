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
// memory pressure, killed by a signal, or no answer in RUN_LIMIT). Callers must not read null as "nothing".
// Some of these run under the state lock (killLease reaping a dead job), where a ps that never
// returns would stop every dibs command: no process-table read gets longer than this.
const RUN_LIMIT = 15e3;
function tryRun(cmd, args, timeout = RUN_LIMIT) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout }); }
  catch (e) { return typeof e.status === 'number' ? e.stdout || '' : null; }   // ps exits 1 when any pid is gone
}
const run = (cmd, args) => tryRun(cmd, args) ?? '';
// A PowerShell that stalls (rebuilding its module cache, say) is "can't tell", not a hung dibs.
const ps = script => tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30e3);

// pid -> start time string. Comparing start times keeps a recycled pid from
// passing as a live holder. null when the process table couldn't be read.
// The highest pid each system hands out (macOS's PID_MAX, Linux's PID_MAX_LIMIT).
// ps refuses a list with anything past it and prints nothing for the rest.
const PID_MAX = OS === 'macos' ? 99999 : OS === 'linux' ? 4194304 : Infinity;
const START_TTL = 30e3, winStarts = new Map();
const exists = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function starts(pids) {
  const out = new Map();
  // One bad number in the state file mustn't make every holder look dead.
  pids = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0 && p <= PID_MAX))];
  if (!pids.length) return out;
  if (WIN) {
    // A start time read in the last START_TTL stands while kill 0 (cheap here)
    // finds the pid alive at every look, and is dropped the first time it doesn't.
    // Each read is a PowerShell, about 0.4 s of CPU: a dozen waiters polling
    // each read fresh kept a CI runner's cores busy and true took 40 s to run.
    // A new process (dibs stop, cancel) starts with nothing kept, so reads fresh.
    const now = Date.now(), need = [];
    for (const pid of pids) {
      const c = winStarts.get(pid);
      if (!c || now - c.at >= START_TTL) need.push(pid);
      else if (exists(pid)) out.set(pid, c.start);
      else winStarts.delete(pid);
    }
    if (!need.length) return out;
    // Get-Process, not a CIM query: 0.3 s against 0.5 s on a CI runner, paid by every dibs call that reads the state.
    const txt = ps(`Get-Process -Id ${need.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`);
    if (txt == null) return null;
    for (const line of txt.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) { out.set(Number(m[1]), m[2]); winStarts.set(Number(m[1]), { start: m[2], at: now }); }
    }
    return out;
  }
  // ps exits 1 with no output when every pid is gone, and also when it refuses
  // the list (it says why on stderr). The second is "can't tell", not "all dead".
  const r = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RUN_LIMIT });
  if (r.status == null || (r.status !== 0 && !r.stdout && r.stderr.trim())) return null;
  const txt = r.stdout;
  for (const line of txt.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

// How long each process has run and the CPU time it has used, in ms, from one ps.
// Empty on Windows. ps writes both as [[dd-]hh:]mm:ss, CPU time with hundredths.
export function duration(text) {
  const m = String(text).trim().match(/^(?:(\d+)-)?([\d:]+)(?:\.(\d+))?$/);
  if (!m) return null;
  const parts = m[2].split(':').map(Number).reverse();
  const secs = (parts[0] || 0) + (parts[1] || 0) * 60 + (parts[2] || 0) * 3600 + Number(m[1] || 0) * 86400;
  return secs * 1000 + (m[3] ? Number(`0.${m[3]}`) * 1000 : 0);
}
export function runtimes(pids) {
  const out = new Map();
  pids = [...new Set(pids.filter(p => Number.isInteger(p) && p > 0 && p <= PID_MAX))];
  if (WIN || !pids.length) return out;
  for (const line of run('ps', ['-o', 'pid=,etime=,time=', '-p', pids.join(',')]).split('\n')) {
    const [pid, age, cpu] = line.trim().split(/\s+/);
    const a = duration(age), c = duration(cpu);
    if (pid && a != null && c != null) out.set(Number(pid), { age: a, cpu: c });
  }
  return out;
}

// Parent pid and executable name, for walking up to the owning agent.
// On Windows each PowerShell CIM read costs about half a second, and a walk up
// to the agent is a dozen levels: one read of the whole table answers them all.
let parentCache = null;
export function parent(pid) {
  if (WIN) {
    if (!parentCache || Date.now() - parentCache.at > 5000) {
      const table = new Map();
      for (const l of (ps('Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }') ?? '').split(/\r?\n/)) {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: m[3].replace(/\.exe$/i, '') });
      }
      parentCache = { at: Date.now(), table };
    }
    return parentCache.table.get(Number(pid)) ?? null;
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
// (the working set on Windows), command line. The group is the pid on Windows,
// which has no process groups.
let procCache = null;
export function processes() {
  if (procCache && Date.now() - procCache.at < 5000) return procCache.list;
  return (procCache = { at: Date.now(), list: readProcesses() }).list;
}

function readProcesses() {
  if (WIN) {
    // Two samples of total processor time, a second apart, give a CPU %; one WMI query gives
    // parents, working sets and command lines. One PowerShell for all of it, never one per pid.
    // WMI's ProcessId is a UInt32 and Get-Process's Id an Int32: as hashtable keys they never match uncast.
    const txt = ps(`$a = @{}; Get-Process | ForEach-Object { $a[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds }; Start-Sleep -Milliseconds 1000;`
      + ` $b = @{}; Get-Process | ForEach-Object { $b[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds };`
      + ` Get-CimInstance Win32_Process | ForEach-Object { $i = [int]$_.ProcessId;`
      + ` if ($a[$i] -ne $null -and $b[$i] -ne $null) { "$i\`t$($_.ParentProcessId)\`t$([math]::Round(($b[$i] - $a[$i]) / 10, 1))\`t$($_.WorkingSetSize)\`t$($_.CommandLine)" } }`);
    return (txt ?? '').split(/\r?\n/).map(l => l.split('\t')).filter(f => f.length === 5 && f[4])
      .map(([pid, ppid, cpu, rss, args]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pid), cpu: Number(cpu), rss: Number(rss) || 0, args }));
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

// The process table as it is now, not as the last 5 seconds' cache had it: for joining with another
// reading by pid, where a pid that ended meanwhile would carry its name onto nothing.
export function processesNow() {
  procCache = null;
  return processes();
}

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
// Every process's memory, the way Activity Monitor's Memory column shows it on
// macOS: its physical footprint, top's MEM, which already counts what the system
// compressed of it. For telling the person what to close (src/alerts.mjs), so
// all processes, not only dibs's. Linux: resident memory. DIBS_FAKE_MEMORY,
// a JSON file of { pid: bytes }, stands in for tests.
export function memoryUse() {
  if (process.env.DIBS_FAKE_MEMORY) {
    try { return new Map(Object.entries(JSON.parse(fs.readFileSync(process.env.DIBS_FAKE_MEMORY, 'utf8'))).map(([p, b]) => [Number(p), b])); } catch { return new Map(); }
  }
  if (OS !== 'macos') return new Map(processes().map(p => [p.pid, p.rss || 0]));
  return topMemory(tryRun('top', ['-l', '1', '-o', 'mem', '-stats', 'pid,mem']));
}
// top's MEM by pid. MEM is the footprint, compressed pages included: adding CMPRS on top counted
// those twice, and under swap, when this is read, most of a process can be compressed. On
// 2026-11-05 a WebKit page read 813 MB in MEM and 805 MB in CMPRS, and footprint -p said 813 MB.
export function topMemory(txt) {
  const out = new Map();
  const size = x => { const m = x?.match(/^([\d.]+)([BKMGT])[+-]?$/); return m ? Number(m[1]) * UNITS[m[2]] : 0; };
  for (const line of (txt || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length >= 2 && /^\d+$/.test(f[0])) out.set(Number(f[0]), size(f[1]));
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
// A command line as the system can start it: on Windows a .cmd or .bat (npm's shims,
// boat's) runs only through cmd.exe. Spawn it with windowsVerbatimArguments when cmd[0] is cmd.exe.
export function runnable(argv, env = process.env) {
  return WIN && /\.(cmd|bat)$/i.test(which(argv[0], env) || '') ? ['cmd.exe', '/d', '/s', '/c', `"${argv.map(winQuote).join(' ')}"`] : argv;
}

// Windows has no exec, so its gate is a small Node that waits the same way, then
// runs the command and passes on its exit code. Stopping the gate's tree (taskkill /T)
// stops the command with it.
const WIN_GATE = "const fs=require('fs');let n=0;try{n=fs.readSync(3,Buffer.alloc(3),0,3,null)}catch{}if(!n)process.exit(125);fs.closeSync(3);"
  + "const[c,...a]=JSON.parse(process.argv[1]);const r=require('child_process').spawnSync(c,a,{stdio:'inherit',windowsVerbatimArguments:c==='cmd.exe'});"
  + "if(r.error){process.stderr.write(r.error.message+'\\n');process.exit(127)}process.exit(r.status??1)";
export function launch(argv, { env, background = false, gate = false }) {
  let cmd = runnable(argv, env);
  if (gate) cmd = WIN ? [process.execPath, '-e', WIN_GATE, JSON.stringify(cmd)] : ['/bin/sh', '-c', GATE, 'dibs', ...cmd];
  const child = spawn(cmd[0], cmd.slice(1), { stdio: gate ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
    detached: !WIN, env, windowsHide: false, windowsVerbatimArguments: cmd[0] === 'cmd.exe' });
  // Lowered from outside, as the throttle watcher does, so dibs boost can raise it again: on macOS
  // a process started under `taskpolicy -b` keeps background QoS whatever `taskpolicy -B -p` says.
  // Its children inherit it. Gated, the command doesn't start until it's lowered.
  if (background && child.pid) lower(child.pid);
  child.go = () => { if (gate) child.stdio[3].end('go\n'); };
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
// The volume's whole size: a job that needs more can never start there, however long it waits.
export function diskSize(dir) {
  try { const st = fs.statfsSync(dir); return st.blocks * st.bsize; } catch { return null; }
}

// Free disk where dibs lives, swap in use, % of memory free, 1-minute load.
// Windows has no load average, so CPU busy % across all cores stands in for it.
// The CPU's busy and total time so far, summed over every core (ms).
export function cpuTicks() {
  let busy = 0, total = 0;
  for (const { times: c } of os.cpus()) { busy += c.user + c.nice + c.sys + c.irq; total += c.user + c.nice + c.sys + c.irq + c.idle; }
  return { busy, total };
}
// Cores in use from two cpuTicks readings this far apart: closer is noise,
// further is an average that hides what's happening now.
const BUSY_GAP_MIN = 1000, BUSY_GAP_MAX = 60e3;
export function busyBetween(prev, ticks, gap, cores) {
  const dt = ticks.total - (prev?.total ?? NaN);
  if (!(gap >= BUSY_GAP_MIN && gap <= BUSY_GAP_MAX && dt > 0)) return null;
  return Math.max(0, (ticks.busy - prev.busy) / dt) * cores;
}

// prev: an earlier reading's { at, ticks }, from which the cores in use come
// without ps (src/config.mjs machine keeps the last one).
export function pressure(dir, prev = null) {
  const vol = OS === 'macos' ? '/System/Volumes/Data' : dir;
  const diskFree = freeDisk(vol), diskTotal = diskSize(vol);
  let swapUsed = 0, swapFiles = null, memFree = Math.round(100 * os.freemem() / os.totalmem()), memAvail = null;
  let vmPressure;
  if (OS === 'macos') {
    // One sysctl for all three: under heavy load each spawn costs 100 to 300 ms.
    const [usage = '', level = '', vmLevel = ''] = run('sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_level', MEM_PRESSURE]).split('\n');
    const sw = usage.match(/used = ([\d.]+)M/);
    if (sw) swapUsed = parseFloat(sw[1]) * 1024 ** 2;
    // The swap files' total size, which is what swap takes from the disk: macOS adds them a gigabyte at a time, ahead of what's used.
    const tot = usage.match(/total = ([\d.]+)M/);
    if (tot) swapFiles = parseFloat(tot[1]) * 1024 ** 2;
    const lvl = Number(level);
    if (lvl) memFree = lvl;   // counts reclaimable cache as free, unlike os.freemem
    vmPressure = PRESSURE_LEVEL[Number(vmLevel)] ?? null;
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
  // Windows has no load average: the cores' busy share over a short window stands in, times
  // the core count. Read from os.cpus() in-process: the CIM processor query it replaces took
  // 1.5 s on a CI runner, and every dibs call reads the machine.
  const load = WIN ? cpuBusy() * os.cpus().length : os.loadavg()[0];
  // Cores actually in use. The load average also counts processes waiting on
  // disk, so heavy swapping can read 20 on a machine that's nearly idle.
  // Just the CPU column (13 ms) unless the full table is fresh anyway: the full one,
  // with every command line, took 60 ms of each dibs run's start on a busy Mac.
  // The CPU's own counters since the last reading cost nothing; ps -Ao pcpu took
  // 0.1 to 1.8 s on 2026-11-11, at load 30 with a thousand processes.
  let busy = null;
  const ticks = cpuTicks(), cores = os.cpus().length;
  if (!WIN) {
    busy = busyBetween(prev?.ticks, ticks, Date.now() - prev?.at, cores);
    if (busy == null) {
      const cpus = procCache && Date.now() - procCache.at < 5000 ? procCache.list.map(p => p.cpu || 0)
        : run('ps', ['-Ao', 'pcpu=']).split('\n').map(Number).filter(x => !isNaN(x));
      if (cpus.length) busy = cpus.reduce((a, c) => a + c, 0) / 100;
    }
  }
  return { diskFree, ...(diskTotal != null && { diskTotal }), swapUsed, ...(swapFiles != null && { swapFiles }), memFree, memAvail, load, busy, cores, os: OS, ticks,
           vmPressure: vmPressure === undefined ? memPressure() : vmPressure };
}

// Share of all cores busy over CPU_WINDOW ms (0 to 1), from two os.cpus() readings.
const CPU_WINDOW = 100;
function cpuBusy() {
  const total = () => os.cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a; }, { busy: 0, all: 0 });
  const a = total();
  const until = Date.now() + CPU_WINDOW;
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - Date.now());
  const b = total();
  return b.all > a.all ? Math.min(1, Math.max(0, (b.busy - a.busy) / (b.all - a.all))) : 0;
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
// When the machine last woke from sleep (dark wakes and Power Nap included), or null:
// macOS's kern.waketime, which reads 0 until the first sleep after boot. DIBS_FAKE_WAKETIME
// (ms since 1970) stands in for it in tests.
export function wokeAt() {
  if (process.env.DIBS_FAKE_WAKETIME) return Number(process.env.DIBS_FAKE_WAKETIME) || null;
  if (OS !== 'macos') return null;
  const m = run('sysctl', ['-n', 'kern.waketime']).match(/sec = (\d+), usec = (\d+)/);
  return m && Number(m[1]) ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null;
}
const MEM_PRESSURE = 'kern.memorystatus_vm_pressure_level';
const PRESSURE_LEVEL = { 1: 0, 2: 1, 4: 2 };
export function memPressure() {
  if (OS === 'macos') return PRESSURE_LEVEL[Number(run('sysctl', ['-n', MEM_PRESSURE]))] ?? null;
  if (OS !== 'linux') return null;
  try {
    const t = fs.readFileSync('/proc/pressure/memory', 'utf8');
    const avg = kind => Number(t.match(new RegExp(`^${kind} avg10=([\\d.]+)`, 'm'))?.[1] || 0);
    return avg('full') >= 10 ? 2 : avg('some') >= 10 ? 1 : 0;
  } catch { return null; }
}

// Name of the agent program a process belongs to (claude, codex, cursor...).
export const AGENTS = /^(claude|codex|cursor-agent|aider|gemini|opencode|amp)$/i;
