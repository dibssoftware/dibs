// The few simctl calls the simulator pool makes, behind one small interface so
// tests can swap in a fake.
import { spawn, execFileSync } from 'node:child_process';

const BOOT_LIMIT = 5 * 6e4;   // a boot that hasn't finished by now isn't going to

function xc(args, timeout = 6e4) {
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 ** 2 });
}
const quiet = args => { try { xc(args); return true; } catch { return false; } };

// Devices from `simctl list -j devices`, flattened: { udid, name, state, runtime, type, size }.
const flat = byRuntime => Object.entries(byRuntime).flatMap(([runtime, list]) => list.map(d =>
  ({ udid: d.udid, name: d.name, state: d.state, runtime, type: d.deviceTypeIdentifier, size: d.dataPathSize ?? null })));

const real = {
  runtimes: () => JSON.parse(xc(['list', '-j', 'runtimes'])).runtimes,
  devices: () => flat(JSON.parse(xc(['list', '-j', 'devices'])).devices),
  create: (name, type, runtime) => xc(['create', name, type, runtime]).trim(),
  // Boot and wait until the device is usable. Already booted is fine.
  boot: udid => new Promise((res, rej) => {
    const p = spawn('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d));
    const t = setTimeout(() => p.kill('SIGKILL'), BOOT_LIMIT);
    p.on('error', e => { clearTimeout(t); rej(e); });
    p.on('exit', code => { clearTimeout(t); code === 0 ? res() : rej(new Error(err.trim().split('\n').pop() || `simctl bootstatus exited ${code}`)); });
  }),
  // True once the device is shut down, including when it already was.
  shutdown: udid => quiet(['shutdown', udid]) || devState(real, udid) !== 'Booted',
  // For cleanup inside the state lock: start the shutdown and don't wait.
  shutdownLater: udid => { try { spawn('xcrun', ['simctl', 'shutdown', udid], { stdio: 'ignore', detached: true }).unref(); } catch {} },
  erase: udid => { xc(['erase', udid]); },
  remove: udid => { xc(['delete', udid]); },
};

const devState = (ctl, udid) => { try { return ctl.devices().find(d => d.udid === udid)?.state ?? null; } catch { return null; } };

// Tests point DIBS_FAKE_SIMCTL at a JSON file that plays CoreSimulator; the
// fake that reads it lives in test/, loaded only then.
const fake = process.env.DIBS_FAKE_SIMCTL ? (await import('../test/fake-simctl.mjs')).fakeSimctl : null;
export const simctl = () => (fake ? fake(process.env.DIBS_FAKE_SIMCTL) : real);
