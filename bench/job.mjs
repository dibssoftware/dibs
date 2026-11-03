#!/usr/bin/env node
// A synthetic job for bench/run.mjs: `cores` threads each spin through a fixed
// amount of work while it holds `mem` MB of touched memory.
//   node bench/job.mjs <cores> <work> <memMB>
// work is in units the harness calibrated as about one second of one core, so
// a crowded machine stretches the job instead of shortening its work. Prints
// one JSON line when done: when it started, and the CPU time it used.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

const spin = n => { let x = 0; for (let i = 0; i < n; i++) x = (x * 31 + i) >>> 0; return x; };

if (!isMainThread) {
  parentPort.postMessage(spin(workerData));
} else {
  const started = Date.now();
  const [cores, work, memMB] = process.argv.slice(2).map(Number);
  const unit = Number(process.env.BENCH_UNIT) || 2e8;
  // Touch every page, so it's resident and not just reserved.
  const hold = memMB > 0 ? Buffer.alloc(memMB * 1024 ** 2, 1) : null;
  const each = Math.round((work * unit) / Math.max(1, cores));
  await Promise.all(Array.from({ length: Math.max(1, cores) }, () => new Promise((ok, fail) => {
    const w = new Worker(new URL(import.meta.url), { workerData: each });
    w.on('message', ok);
    w.on('error', fail);
  })));
  const u = process.cpuUsage();
  console.log(JSON.stringify({ started, cpuMs: Math.round((u.user + u.system) / 1000), held: hold?.length || 0 }));
}
