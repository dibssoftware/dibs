// Running a job next to others on a full resource, when the machine can take it.
//
// For most resources the slot count is a stand-in for "the machine can take
// this many": three test runs, two builds. When a full resource's running
// jobs leave real room, one more may start on top of them:
//   fit      its size fits what's really free: memory above minFreeMem, and
//            cores under the load ceiling (maxLoad, else one per core). The
//            size is what its command really used (src/measure.mjs), else the
//            --mem it asked for. A job with neither has an unknown cost and
//            doesn't overlap.
//   squeeze  also: a job that usually takes under squeezeUnder (from history,
//            never --est) starts if its memory fits, even when its cores would
//            take the load past the ceiling. The person accepted that load hit
//            by choosing it. Not once the load is already past it.
// Either way the machine's own gates still apply after this (src/schedule.mjs
// verdict): free disk, swap, the memory budget with no roomy exception, and
// the load ceiling.
// Never on a resource that's one at a time: exclusive in its config (sim and
// deploy by default, and names dibs doesn't know, which are often someone's
// lock), a pool, one with an onRelease reset, file leases and quotas.
//
// A job on top never takes a slot, so when a slot frees the next waiter in
// line gets it as usual and nobody is passed for good. It never pauses anyone.
// Under memory pressure it's the first to pause, newest first (src/preempt.mjs).
//
// config.overlap: off, fit or squeeze. loadConfig sets it from the pace when
// the file doesn't (quiet off, normal fit, max squeeze; no pace, off).
import { resCfg, machine, hardware } from './config.mjs';
import { tag } from './proc.mjs';
import { isFiles } from './files.mjs';
import { isQuota } from './quota.mjs';
import { learned } from './measure.mjs';
import { loadAhead, typical, cpuLoad } from './schedule.mjs';
import { OS } from './platform.mjs';
// plain.mjs imports the scheduler, which imports this; only functions cross, so the cycle is safe.
import { andList, about, named } from './plain.mjs';
import { gb, ms, now } from './util.mjs';

// A job reaches most of its memory over its first seconds, and the sampler
// sees a lease only every 10s, so for this long after a start the free reading
// doesn't show all of it yet. The rest is taken off what's free.
const SETTLE = 30e3;

// Everything the person reads about overlap, in one place, in the plain
// words the rest of dibs uses (src/plain.mjs): GB with a space, queue, no slots.
const GB = b => gb(b).replace(/G$/, ' GB');
const say = {
  oneAtATime: (r, cfg) => `Can't run alongside: ${named(cfg, r).queue} runs one job at a time.`,
  hold: () => "Can't run alongside: a hold keeps what it holds to itself.",
  unknown: () => "Can't run alongside: dibs hasn't measured this command yet and it gave no --mem, so it can't tell whether it fits. Pass --mem the first time.",
  mem: (need, free, from) => `Can't run alongside: it ${from === 'asked' ? 'asked for' : 'usually needs'} ${GB(need)} of memory and ${GB(free)} is free.`,
  load: (cpu, load, ceiling) => `Can't run alongside: it usually keeps ${cpu} cores busy, and that would take the machine from ${load.toFixed(1)} past its busy limit of ${ceiling}.`,
  ahead: q => `Can't run alongside yet: ${tag(q)} is ahead of you in the queue and fits alongside too, so it goes first.`,
  started: (a, queues) => a.kind === 'squeeze'
    ? `${queues} full, so this squeezes in next to ${andList(a.with)} (it usually takes ${about(a.usually)}).`
    : `${queues} full, so this runs alongside ${andList(a.with)}: it needs about ${GB(a.mem)} of memory, and there's room.`,
  pressured: () => 'paused your job: the machine is short on memory, and a job running alongside others is the first to pause.'
    + ' It keeps its place and picks up again when memory frees up.',
  row: a => (a.kind === 'squeeze' ? `squeezed in (usually takes ${about(a.usually)})` : `running alongside ${andList(a.with)}`),
};
export const startLine = (a, cfg) => say.started(a, `${andList(a.res.map(r => named(cfg, r).queue))} ${a.res.length > 1 ? 'are' : 'is'}`);
export const pausedLine = () => say.pressured();
export const alongsideLabel = l => (l.alongside ? say.row(l.alongside) : '');

// For dibs pace: what the machine does with a full queue, in a sentence.
export function sideBySide(cfg) {
  const mode = overlapMode(cfg);
  if (mode === 'off') return 'no. A job waits for its turn when its queue is full.';
  const fit = "when they fit. A job may start next to the ones filling its queue if the machine has the memory and cores for it";
  return mode === 'fit' ? `${fit}.` : `${fit}, and one that usually takes under ${about(ms(cfg.squeezeUnder))} squeezes in even if it takes the machine past its busy limit.`;
}

export const overlapMode = cfg => cfg.overlap || 'off';

// One at a time, whatever the machine has free. A name dibs doesn't know is
// one unless the config's unknown says exclusive: false.
export function exclusive(cfg, r) {
  if (isFiles(r) || isQuota(r)) return true;
  const c = resCfg(cfg, r);
  if (c.pool || c.onRelease) return true;
  // resCfg fills a configured resource's gaps from unknown, so read its own config here.
  return cfg.resources[r] ? cfg.resources[r].exclusive === true : cfg.unknown?.exclusive !== false;
}

// A lease running on top of r's slots, which it doesn't count against.
export const onTop = (l, r) => !!l.alongside?.res?.includes(r);

// Memory free now, less what jobs started in the last SETTLE haven't taken yet.
// A job planned at the budget (src/measure.mjs sized) will take what it usually uses.
function memFree(s, m, t) {
  const settling = s.leases.filter(l => l.kind === 'run' && !l.pausedAt && t - l.start < SETTLE)
    .reduce((a, l) => a + Math.max(0, (l.alongside?.mem ?? Math.max(l.mem, l.usual || 0)) - (l.use?.mem || 0)), 0);
  return m.memFree / 100 * hardware().mem - settling;
}

// What a job costs as far as overlap goes: what it really used, else what it
// asked for, else null.
function sizeOf(me, hist) {
  const got = learned(hist, me.key);
  if (got) return { mem: got.mem, cpu: got.cpu, from: 'learned' };
  return me.declared ? { mem: me.mem, cpu: me.cpu, from: 'asked' } : null;
}

// Whether a waiter could start on top of r now. Never mind who's ahead.
function fits(s, me, r, cfg, hist, m, t) {
  if (exclusive(cfg, r)) return { ok: false, why: say.oneAtATime(r, cfg) };
  if (me.kind === 'hold' || me.key?.endsWith('|hold')) return { ok: false, why: say.hold() };
  const size = sizeOf(me, hist);
  const usually = typical(hist, me.key);
  const quick = overlapMode(cfg) === 'squeeze' && usually != null && usually < ms(cfg.squeezeUnder);
  if (!size && !quick) return { ok: false, why: say.unknown() };
  const mem = size?.mem ?? me.mem;
  const room = memFree(s, m, t) - cfg.minFreeMem / 100 * hardware().mem;
  if (mem > room) return { ok: false, why: say.mem(mem, Math.max(0, room), size?.from) };
  const ceiling = cfg.maxLoad ?? (m.cores || hardware().cores);
  // Cores in use, as the load ceiling reads them (src/schedule.mjs overLoad): a
  // load average swollen by swapping isn't work. Plus recent starts it doesn't show yet.
  const load = cpuLoad(m) + loadAhead(s, m);
  const fitsLoad = !!size && load + size.cpu <= ceiling;
  if (!fitsLoad && !quick) return { ok: false, why: say.load(size.cpu, load, ceiling) };
  const next = new Set(s.leases.filter(l => l.res.includes(r) && !onTop(l, r)).map(l => tag(l)));
  return { ok: true, kind: fitsLoad ? 'fit' : 'squeeze', res: [r], with: [...next], mem, ...(usually != null ? { usually } : {}) };
}

// verdict's hook for a full resource: null when overlap is off, else { ok,
// why } or { ok, kind, res, with, mem, usually }. A waiter ahead that wants
// r and fits on top too goes first.
export function alongside(s, me, r, cfg, hist, t, ahead) {
  if (overlapMode(cfg) === 'off') return null;
  const m = machine();
  const a = fits(s, me, r, cfg, hist, m, t);
  if (!a.ok) return a;
  const first = ahead.find(q => q.res.includes(r) && fits(s, q, r, cfg, hist, m, t).ok);
  return first ? { ok: false, why: say.ahead(first), ahead: first } : a;
}

// Several resources' admissions as one, for the lease.
export function merge(as) {
  if (!as.length) return null;
  return { kind: as.some(a => a.kind === 'squeeze') ? 'squeeze' : 'fit', res: as.flatMap(a => a.res),
    with: [...new Set(as.flatMap(a => a.with))], mem: as[0].mem, ...(as[0].usually != null ? { usually: as[0].usually } : {}) };
}

// Under memory pressure, jobs on top, and a first run let in on probation
// (src/schedule.mjs probation), pause before anyone else's, newest first.
// Only on resources that allow pausing at all.
export function pressureVictim(s, cfg) {
  if (OS === 'windows') return null;
  return s.leases.filter(l => (l.alongside || l.trial) && l.kind === 'run' && l.pgid && !l.pauses?.some(p => p.watcher)
    && l.res.every(r => resCfg(cfg, r).pausable === true)).sort((a, b) => b.start - a.start)[0] || null;
}
