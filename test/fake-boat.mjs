// Stands in for the boat CLI in tests (DIBS_BOAT points at a wrapper that runs
// this). A "VM" is an entry in FAKE_BOAT_DIR/state.json, and what runs on it
// runs here, under FAKE_BOAT_DIR/vm-<id> as its /home/user. Every call is
// logged to FAKE_BOAT_DIR/calls.log, one JSON line each.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const dir = process.env.FAKE_BOAT_DIR;
const file = path.join(dir, 'state.json');
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { vms: {} }; } };
// Written whole and renamed into place: the tests poll this file while boat calls write it.
const save = s => { fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(s)); fs.renameSync(`${file}.${process.pid}`, file); };
const args = process.argv.slice(2).filter(a => a !== '--no-update' && a !== '--json');
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ at: Date.now(), args }) + '\n');
const [cmd, ...rest] = args;
const home = id => path.join(dir, `vm-${id}`);
// The VM's own paths, here.
const map = (id, s) => s.replaceAll('/home/user', home(id));
const s = load();
const vm = id => (s.vms[id] ||= { state: 'stopped', pids: [] });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// What runs on the VM sees its own home, not the test's dibs.
const vmEnv = id => {
  const e = { ...process.env, HOME: home(id) };
  for (const k of ['DIBS_HOME', 'DIBS_BOAT', 'FAKE_BOAT_DIR', 'DIBS_AGENT', 'DIBS_NO_SESSION']) delete e[k];
  return e;
};

switch (cmd) {
  case 'info': {
    const id = rest[0];
    console.log(JSON.stringify({ sandbox: { id, state: vm(id).state } }));
    break;
  }
  case 'list':
    // Running ones only, unless --all, as boat does.
    console.log(JSON.stringify({ sandboxes: Object.entries(s.vms).filter(([, v]) => rest.includes('--all') || v.state === 'running').map(([id, v]) => ({ id, state: v.state })) }));
    break;
  case 'limits':
    // The account's start quota; plenty unless a test says otherwise.
    console.log(process.env.FAKE_BOAT_LIMITS || JSON.stringify({ canStart: true, starts: { day: { used: 3, limit: 200, remaining: 197 }, hour: { used: 1, limit: 60, remaining: 59 } } }));
    break;
  case 'resume': {
    const id = rest[0];
    if (process.env.FAKE_BOAT_RESUME_FAIL) { console.error(process.env.FAKE_BOAT_RESUME_FAIL); process.exit(1); }
    sleep(Number(process.env.FAKE_BOAT_RESUME_MS) || 200);
    vm(id).state = 'running';
    fs.mkdirSync(home(id), { recursive: true });
    save(s);
    console.log(JSON.stringify({ sandbox: { id, state: 'running' } }));
    break;
  }
  case 'stop': {
    const id = rest[0];
    // A stopped VM keeps its disk (the snapshot) and loses its processes.
    for (const pid of vm(id).pids) try { process.kill(-pid, 'SIGKILL'); } catch {}
    Object.assign(vm(id), { state: 'stopped', pids: [] });
    save(s);
    console.log(JSON.stringify({ stop: { status: 'completed' } }));
    break;
  }
  case 'new': {
    if (process.env.FAKE_BOAT_NEW_FAIL) { console.error('no_ready_machine'); process.exit(1); }
    const id = `bx_t${Math.random().toString(36).slice(2, 9)}`;
    s.vms[id] = { state: 'running', pids: [], type: rest[rest.indexOf('--type') + 1] || 'default' };
    fs.mkdirSync(home(id), { recursive: true });
    // A real new VM has no Node; a test hands it one so nothing is downloaded.
    if (process.env.FAKE_BOAT_NODE) fs.symlinkSync(process.env.FAKE_BOAT_NODE, path.join(home(id), '.dibs-node'));
    save(s);
    console.log(JSON.stringify({ sandbox: { id, state: 'running' } }));
    break;
  }
  case 'delete': {
    const id = rest[0];
    if (!s.vms[id]) { console.error(`sandbox ${id} not found`); process.exit(1); }
    for (const pid of s.vms[id].pids) try { process.kill(-pid, 'SIGKILL'); } catch {}
    delete s.vms[id];
    fs.rmSync(home(id), { recursive: true, force: true });
    save(s);
    console.log(JSON.stringify({ deleted: id }));
    break;
  }
  case 'ps': {
    // What runs "on" the VM: the processes it started and their descendants, here,
    // plus any a test lists in its state (work outside dibs).
    const id = rest[0];
    const rows = spawnSync('ps', ['-axo', 'pid=,ppid=,pcpu=,command='], { encoding: 'utf8' }).stdout.split('\n')
      .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, cpu, command]) => ({ pid: +pid, ppid: +ppid, cpu: +cpu, command }));
    const mine = new Set(vm(id).pids);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
    const processes = rows.filter(r => mine.has(r.pid)).map(r => ({ pid: r.pid, command: r.command, cpuPercent: r.cpu }));
    console.log(JSON.stringify({ processes: [...processes, ...(vm(id).ps || [])] }));
    break;
  }
  case 'extend':
    break;
  case 'forward':
    // The VM's worker reaches the coordinator on this machine's loopback anyway; this only has to stay up.
    setInterval(() => {}, 1e9);
    break;
  case 'exec': {
    const detach = rest.includes('--detach');
    const flags = new Set(['--detach']);
    const plain = rest.filter((a, i) => !flags.has(a) && rest[i - 1] !== '--timeout' && a !== '--timeout');
    const id = plain[0];
    const command = plain.slice(plain.indexOf('--') + 1).map(a => map(id, a));
    if (vm(id).state !== 'running') { console.error(`${id} is stopped`); process.exit(1); }
    if (detach) {
      const p = spawn(command[0], command.slice(1), { cwd: home(id), env: vmEnv(id), detached: true, stdio: 'ignore' });
      p.unref();
      vm(id).pids.push(p.pid);
      save(s);
      console.log(JSON.stringify({ pid: p.pid }));
      break;
    }
    // Off a terminal, boat answers in one JSON object, as here.
    const r = spawnSync(command[0], command.slice(1), { cwd: home(id), env: vmEnv(id), encoding: 'utf8' });
    console.log(JSON.stringify({ exitCode: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '', success: r.status === 0 }));
    process.exit(r.status ?? 1);
  }
  case 'scp': {
    const [src, dst] = rest.filter(a => a !== '-r');
    const [id, to] = dst.split(':');
    fs.mkdirSync(path.dirname(map(id, to)), { recursive: true });
    fs.copyFileSync(src, map(id, to));
    break;
  }
  case 'push': {
    const [id, from] = rest;
    const to = map(id, rest[rest.indexOf('--to') + 1]);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(path.resolve(from), to);
    break;
  }
  default:
    console.error(`fake boat: no ${cmd}`);
    process.exit(2);
}
