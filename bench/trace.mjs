#!/usr/bin/env node
// Turn a dibs home's event log into a workload bench/sim.mjs can replay:
//   node bench/trace.mjs ~/.dibs > bench/workloads/tonight.json
// Read only. Agents become agent1..N and commands lose their arguments, so
// the file says nothing about whose project ran what.
import fs from 'node:fs';
import path from 'node:path';

const home = process.argv[2] || path.join(process.env.HOME, '.dibs');
const lines = f => { try { return fs.readFileSync(path.join(home, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const events = [...lines('events.1.jsonl'), ...lines('events.jsonl')].sort((a, b) => a.at - b.at);
const hist = lines('history.jsonl');
if (!events.length) { console.error(`no events in ${home}`); process.exit(1); }

const names = new Map();
const agent = w => (names.has(w) ? names.get(w) : names.set(w, `agent${names.size + 1}`).get(w));
const cmds = new Map();
const cmd = key => { const c = key.split('|')[1] || ''; if (!cmds.has(c)) cmds.set(c, `cmd${cmds.size + 1}`); return cmds.get(c); };
const res = rs => rs.map(r => (r.startsWith('files:') ? 'files:x' : r));

const t0 = events[0].at, t1 = events.at(-1).at;
const waits = new Map(events.filter(e => e.kind === 'wait').map(e => [e.id, e]));
const starts = new Map(events.filter(e => e.kind === 'start').map(e => [e.id, e]));
const jobs = [];
for (const e of events.filter(e => e.kind === 'end')) {
  const s = starts.get(e.id), w = waits.get(e.id);
  const start = e.at - e.ms - (e.paused || 0);
  // A run's measured peak is the history line its end wrote: same agent, same resources, same moment.
  const h = e.type === 'run' && hist.find(h => h.who === e.who && Math.abs(h.at - e.at) < 3000 && h.key.split('|')[0] === e.res.join(','));
  jobs.push({
    id: e.id, who: agent(e.who), res: res(e.res), kind: e.type, prio: e.prio || 'normal',
    arrive: Math.round(((w || s)?.at ?? start) - t0), realStart: Math.round(start - t0), dur: e.ms,
    key: h ? `${e.res.join(',')}|${cmd(h.key)}` : `${e.res.join(',')}|${e.type}`,
    ...(h && h.mem != null ? { peakMem: h.mem, peakCpu: h.cpu } : {}),
    // Started before the log did: it's already running when the replay begins.
    ...(start < t0 ? { before: true } : {}),
  });
}
const samples = events.filter(e => e.kind === 'sample').map(e => ({ at: e.at - t0, load: e.load, memFree: e.memFree }));
console.log(JSON.stringify({ from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), jobs: jobs.sort((a, b) => a.arrive - b.arrive), samples }, null, 1));
