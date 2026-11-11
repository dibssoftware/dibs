// One hook call in the resident guard (src/guardd.mjs): a worker thread that
// loads the hook's modules before its call comes, answers that one call as
// the hook process would, and ends. A fresh worker per call keeps every call
// as fresh as its own Node process was: the modules keep caches (the pool's
// simulators, the processes above the hook) that are only right for one call.
import { parentPort } from 'node:worker_threads';
import { decide } from './guard.mjs';
import { setCaller } from './util.mjs';

parentPort.once('message', async ({ input, env, ppid }) => {
  // The hook's own environment and parent, as the client saw them.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  setCaller(ppid);
  let out = null;
  try { out = await decide(input); } catch {}
  parentPort.postMessage({ out });
});
parentPort.postMessage({ ready: true });
