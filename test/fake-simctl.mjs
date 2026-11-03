// A fake CoreSimulator for the simulator pool tests. src/simctl.mjs loads it
// when DIBS_FAKE_SIMCTL names a JSON file: { runtimes, devices, log, bootMs, failBoot }.
// The devices live in that file so several dibs processes share them.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, sleepSync } from '../src/util.mjs';

export function fakeSimctl(file) {
  const lock = `${file}.lock`;
  const change = fn => {
    for (let i = 0; ; i++) { try { fs.mkdirSync(lock); break; } catch { if (i > 500) fs.rmSync(lock, { recursive: true, force: true }); sleepSync(5); } }
    try {
      const w = JSON.parse(fs.readFileSync(file, 'utf8'));
      w.devices ||= []; w.log ||= [];
      const out = fn(w);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(w, null, 1));
      fs.renameSync(`${file}.tmp`, file);
      return out;
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  };
  const find = (w, udid) => w.devices.find(d => d.udid === udid) || (() => { throw new Error(`Invalid device: ${udid}`); })();
  const op = (name, udid, fn) => change(w => { w.log.push(`${name} ${udid}`); return fn(w, find(w, udid)); });
  return {
    runtimes: () => change(w => w.runtimes),
    devices: () => change(w => w.devices.map(d => ({ ...d }))),
    create: (name, type, runtime) => change(w => {
      const udid = `FAKE-${String(w.devices.length + 1).padStart(4, '0')}-${path.basename(file).length}`;
      w.devices.push({ udid, name, state: 'Shutdown', runtime, type, size: 1024 ** 2 });
      w.log.push(`create ${name}`);
      return udid;
    }),
    boot: async udid => {
      const w = change(x => x);
      if (w.bootMs) await sleep(w.bootMs);
      op('boot', udid, (x, d) => { if (x.failBoot) throw new Error('Unable to boot device'); d.state = 'Booted'; d.size += 1024 ** 3; });
    },
    shutdown: udid => op('shutdown', udid, (x, d) => { d.state = 'Shutdown'; return true; }),
    shutdownLater: udid => { try { op('shutdown', udid, (x, d) => { d.state = 'Shutdown'; }); } catch {} },
    erase: udid => op('erase', udid, (x, d) => { if (d.state !== 'Shutdown') throw new Error('Unable to erase contents and settings in current state: Booted'); d.size = 1024 ** 2; }),
    remove: udid => change(w => { find(w, udid); w.log.push(`delete ${udid}`); w.devices = w.devices.filter(d => d.udid !== udid); }),
  };
}
