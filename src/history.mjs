// dibs history: what happened over the last few days, from the event log
// (src/events.mjs). summarize() is a pure function of the events, so the
// tests can feed it a made-up week.
import { withState } from './state.mjs';
import { readEvents } from './events.mjs';
import { short } from './files.mjs';
import { dur, clock, die, now } from './util.mjs';
import { named } from './plain.mjs';
import { bold, dim } from './style.mjs';

const HOUR = 36e5;
export const EVENT_CAP = 2000;   // the newest events --json carries; the app shows a timeline, not an archive
// Below this much waiting in all, nothing was a bottleneck worth naming.
const NOTABLE = 5 * 6e4;
// A resource is "the bottleneck" when it has at least this share of all the waiting.
const BOTTLENECK = 0.5;
// "mostly 18:00-22:00" names the shortest span of the day holding this share of a resource's waiting, if it's a few hours at most.
const MOSTLY = { share: 0.6, hours: 6 };
const UNITS = { m: 6e4, h: HOUR, d: 24 * HOUR, w: 168 * HOUR };

export function span(s = '7d') {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([mhdw])$/);
  if (!m) die(`can't read --since "${s}" (try 24h, 7d or 30d)`);
  return parseFloat(m[1]) * UNITS[m[2]];
}

// The most intervals open at once between lo and hi. An interval ending at the
// moment another starts doesn't overlap it.
function peak(ivs, lo, hi) {
  const pts = [];
  for (const { a, b } of ivs) {
    const x = Math.max(a, lo), y = Math.min(b, hi);
    if (y > x) pts.push([x, 1], [y, -1]);
  }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let n = 0, top = 0;
  for (const [, d] of pts) top = Math.max(top, (n += d));
  return top;
}

// Time covered by at least one interval, between lo and hi.
function union(ivs, lo, hi) {
  const cl = ivs.map(({ a, b }) => [Math.max(a, lo), Math.min(b, hi)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]);
  let total = 0, end = -Infinity;
  for (const [x, y] of cl) {
    if (y <= end) continue;
    total += y - Math.max(x, end);
    end = y;
  }
  return total;
}

const clip = (iv, lo, hi) => Math.max(0, Math.min(iv.b, hi) - Math.max(iv.a, lo));
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1] : 0);
const mean = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

// events: from readEvents(). current: what's held and waited for right now
// ({ leases: [{ id, res, who, start }], queue: [{ id, res, who, enq }] }),
// so work still going counts up to `until`. Returns the --json shape.
export function summarize(events, current, since, until) {
  const inWindow = e => e.at >= since && e.at <= until;
  const names = new Map();
  const name = r => (names.has(r) ? names.get(r) : names.set(r, short(r)).get(r));
  const holds = [], waits = new Map();
  const waited = new Set(events.filter(e => e.kind === 'wait').map(e => e.id));
  for (const e of events) {
    if (e.kind === 'end') holds.push({ res: e.res, who: e.who, a: e.at - e.ms, b: e.at });
    // A start that never had to wait isn't a wait. A place kept after a timeout
    // and picked up again is one wait, from when it first joined the line.
    // A waiter that left any other way (a signal, a full disk, the owner, a kill) still waited.
    if (((e.kind === 'start' || e.kind === 'left') && waited.has(e.id)) || e.kind === 'timeout')
      waits.set(e.id, { res: e.res, who: e.who, a: e.at - (e.ms || 0), b: e.at, done: true });
  }
  for (const l of current.leases) holds.push({ res: l.res, who: l.who, a: l.start, b: until });
  for (const q of current.queue) waits.set(q.id, { res: q.res, who: q.who, a: q.enq, b: until, done: false });
  const allWaits = [...waits.values()];
  const timeouts = events.filter(e => e.kind === 'timeout' && inWindow(e));
  const starts = events.filter(e => e.kind === 'start' && inWindow(e));

  const touched = x => clip(x, since, until) > 0 || (x.b >= since && x.b <= until);
  const resNames = new Set([...holds, ...allWaits].filter(touched).flatMap(x => x.res));
  for (const e of [...timeouts, ...starts]) for (const r of e.res) resNames.add(r);
  const resources = {};
  for (const r of [...resNames].sort()) {
    const on = xs => xs.filter(x => x.res.includes(r));
    const ws = on(allWaits);
    const finished = ws.filter(w => w.done && w.b >= since && w.b <= until).map(w => w.b - w.a);
    resources[name(r)] = {
      busyMs: union(on(holds), since, until), waits: finished.length, waitMs: ws.reduce((t, w) => t + clip(w, since, until), 0),
      p50WaitMs: pct(finished, 0.5), p90WaitMs: pct(finished, 0.9), peakQueue: peak(ws, since, until),
      timeouts: timeouts.filter(e => e.res.includes(r)).length,
      // The hours most of its waiting fell in, [startHour, hours] local, from every wait (the events --json carries are capped).
      mostly: mostly(ws, since, until),
    };
  }

  const agents = {};
  const agent = who => (agents[who] ||= { runs: 0, holdMs: 0, waitMs: 0, timeouts: 0 });
  for (const e of starts) agent(e.who).runs++;
  for (const h of holds) if (clip(h, since, until)) agent(h.who).holdMs += clip(h, since, until);
  for (const w of allWaits) if (clip(w, since, until)) agent(w.who).waitMs += clip(w, since, until);
  for (const e of timeouts) agent(e.who).timeouts++;

  const samples = events.filter(e => e.kind === 'sample');
  const hourly = [];
  for (let h = Math.floor(since / HOUR) * HOUR; h < until; h += HOUR) {
    const lo = Math.max(h, since), hi = Math.min(h + HOUR, until);
    const here = samples.filter(e => e.at >= h && e.at < h + HOUR);
    hourly.push({ hour: h, load: mean(here.map(e => e.load).filter(x => x != null)), waiting: peak(allWaits, lo, hi), held: peak(holds, lo, hi),
                  memFree: mean(here.map(e => e.memFree).filter(x => x != null)), diskFree: mean(here.map(e => e.diskFree).filter(x => x != null)) });
  }

  const shown = events.filter(e => e.kind !== 'sample' && inWindow(e)).slice(-EVENT_CAP)
    .map(e => ({ ...e, res: (e.res || []).map(name), who: e.who ?? null, prio: e.prio ?? null, code: e.code ?? null, ms: e.ms ?? null }));
  // The last three are for the plain report; --json leaves them out.
  return { since, until, resources, agents, hourly, events: shown,
           waitIntervals: allWaits.map(w => ({ ...w, res: w.res.map(name) })), started: starts.length, gaveUp: timeouts.length };
}

// The shortest span of the day (local hours, wrapping past midnight) holding
// MOSTLY.share of this resource's waiting, as [startHour, hours], or null.
function mostly(ws, since, until) {
  const by = new Array(24).fill(0);
  for (const w of ws) {
    for (let t = Math.max(w.a, since), end = Math.min(w.b, until); t < end;) {
      const d = new Date(t); d.setMinutes(60, 0, 0);
      const next = Math.min(d.getTime(), end);
      by[new Date(t).getHours()] += next - t;
      t = next;
    }
  }
  const total = by.reduce((a, b) => a + b, 0);
  if (!total) return null;
  for (let len = 1; len <= MOSTLY.hours; len++)
    for (let s = 0; s < 24; s++) {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += by[(s + i) % 24];
      if (sum >= MOSTLY.share * total) return [s, len];
    }
  return null;
}

const atHour = h => { const d = new Date(); d.setHours(h % 24, 0, 0, 0); return clock(d.getTime()); };
const day = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

// The few sentences at the top: only what the numbers carry.
export function verdict(h, cfg = { resources: {} }) {
  const res = Object.entries(h.resources);
  const totalWait = res.reduce((t, [, r]) => t + r.waitMs, 0);
  const turns = h.started;
  const label = r => named(cfg, r).label;
  const out = [];
  if (!res.length) return ['Nothing went through dibs in this period.'];
  if (totalWait < NOTABLE) {
    const n = res.reduce((t, [, r]) => t + r.waits, 0);
    out.push(n ? `Nobody had to wait long: ${n} wait${n > 1 ? 's' : ''}, ${dur(totalWait)} in all, across ${turns} turn${turns === 1 ? '' : 's'}.`
      : `Nobody had to wait: ${turns === 1 ? 'the 1 turn' : `all ${turns} turns`} started right away.`);
  } else {
    const [[top, r], ...rest] = res.sort((a, b) => b[1].waitMs - a[1].waitMs);
    if (r.waitMs >= BOTTLENECK * totalWait) {
      const m = mostly(h.waitIntervals.filter(w => w.res.includes(top)), h.since, h.until);
      out.push(`${label(top)} held everyone up: agents waited ${dur(r.waitMs)} for it${m ? `, mostly ${atHour(m[0])}-${atHour(m[0] + m[1])}` : ''}.`);
    } else out.push(`Waiting was spread out: ${[[top, r], ...rest].filter(([, x]) => x.waitMs >= NOTABLE).slice(0, 4).map(([k, x]) => `${label(k)} ${dur(x.waitMs)}`).join(', ')}.`);
  }
  const n = h.gaveUp;
  if (n) out.push(`${n} request${n > 1 ? 's' : ''} gave up waiting (exit 75) before ${n > 1 ? 'their commands' : 'its command'} started.`);
  const loaded = h.hourly.filter(x => x.load != null).sort((a, b) => b.load - a.load)[0];
  if (loaded) out.push(`The machine was busiest in the hour from ${day(loaded.hour)} ${clock(loaded.hour)} (load average ${loaded.load}).`);
  return out;
}

const table = (head, rows) => {
  const w = head.map((c, i) => Math.max(c.length, ...rows.map(r => String(r[i]).length)));
  return [head, ...rows].map(r => r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ').trimEnd());
};

export function report(h, label, cfg = { resources: {} }) {
  const [lead, ...more] = verdict(h, cfg);
  const out = [bold(lead), ...more, '', dim(`dibs history, last ${label}: ${day(h.since)} ${clock(h.since)} to ${day(h.until)} ${clock(h.until)}`)];
  const res = Object.entries(h.resources).sort((a, b) => b[1].waitMs - a[1].waitMs || b[1].busyMs - a[1].busyMs);
  if (!res.length) return out;
  out.push('', bold('By resource'), ...table(['', 'in use', 'waits', 'waited', 'typical wait', 'worst 1 in 10', 'most in the queue', 'gave up'],
    res.map(([k, r]) => [named(cfg, k).label, dur(r.busyMs), r.waits, dur(r.waitMs), r.waits ? dur(r.p50WaitMs) : '-', r.waits ? dur(r.p90WaitMs) : '-', r.peakQueue, r.timeouts])));
  const ag = Object.entries(h.agents).sort((a, b) => b[1].waitMs - a[1].waitMs || b[1].holdMs - a[1].holdMs);
  out.push('', bold('By agent'), ...table(['', 'turns', 'in use', 'waited', 'gave up'], ag.map(([k, a]) => [k, a.runs, dur(a.holdMs), dur(a.waitMs), a.timeouts])));
  // One waiter at a time is a line nobody stood in; hours with two or more are worth a look.
  const busy = h.hourly.filter(x => x.waiting > 1).sort((a, b) => b.waiting - a.waiting || b.held - a.held).slice(0, 5).sort((a, b) => a.hour - b.hour);
  if (busy.length) {
    out.push('', bold('Longest queues'));
    for (const x of busy)
      out.push(`  ${day(x.hour)} ${clock(x.hour).padEnd(8)}  ${x.waiting} waiting, ${x.held} running${x.load != null ? `, load average ${x.load}` : ''}`);
  }
  out.push('', dim('Another span: dibs history --since 24h (or 30d). For a program: dibs history --json'));
  return out;
}

export function history(o, cfg) {
  const until = now();
  const since = until - span(o.since);
  // Through withState, so leases whose process died are reaped (and their end recorded) first.
  const current = withState(s => ({
    leases: s.leases.map(l => ({ id: l.id, res: l.res, who: l.who, start: l.start })),
    queue: s.queue.filter(q => q.pid).map(q => ({ id: q.id, res: q.res, who: q.who, enq: q.enq })),
  }));
  const h = summarize(readEvents(until), current, since, until);
  if (o.json) {
    const { waitIntervals, started, gaveUp, ...app } = h;
    return console.log(JSON.stringify(app, null, 1));
  }
  console.log(report(h, o.since || '7d', cfg).join('\n'));
}

// dibs stats: how long jobs waited before they started, against how long they
// ran, today and over the last 7 days. The share that waited longer than they
// ran is the number to watch: a job should wait no longer than its own run
// time unless the machine is truly full. statsOf() is a pure function of the
// events (a run's start carries its wait in ms, its end its run time).
export function statsOf(events, since) {
  const starts = new Map();
  const jobs = [];
  for (const e of events) {
    if (e.type !== 'run' || e.at < since) continue;
    if (e.kind === 'start') starts.set(e.id, e);
    else if (e.kind === 'end' && starts.has(e.id)) jobs.push({ res: e.res[0], wait: starts.get(e.id).ms || 0, run: e.ms || 0 });
  }
  const by = {};
  for (const j of jobs) (by[j.res] ||= []).push(j.wait);
  return {
    jobs: jobs.length,
    waitedLonger: jobs.length ? jobs.filter(j => j.wait > j.run).length / jobs.length : null,
    byRes: Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([res, ws]) => ({ res, jobs: ws.length, median: pct(ws, 0.5), p90: pct(ws, 0.9) })),
  };
}
export function stats(o, cfg) {
  const t = now(), midnight = new Date(t).setHours(0, 0, 0, 0);
  const events = readEvents(t);
  const today = statsOf(events, midnight), week = statsOf(events, t - 7 * 24 * HOUR);
  if (o.json) return console.log(JSON.stringify({ today, week }, null, 1));
  const out = [];
  for (const [label, s] of [['Today', today], ['Last 7 days', week]]) {
    out.push(bold(label), s.jobs ? `  ${s.jobs} jobs; ${Math.round(100 * s.waitedLonger)}% waited longer than they ran` : '  no jobs');
    for (const r of s.byRes) out.push(`  ${named(cfg, r.res).label.padEnd(20)} ${String(r.jobs).padStart(5)} jobs   wait: median ${dur(r.median)}, 90% under ${dur(r.p90)}`);
    out.push('');
  }
  out.push(dim('A job should wait no longer than it runs unless the machine is truly full. For a program: dibs stats --json'));
  console.log(out.join('\n'));
}
