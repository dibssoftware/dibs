// dibs stats --agent/--me/--since/--json, the web page's Stats view and the
// MCP stats tool: what each agent and each resource did, from what dibs
// already writes down. Nothing here is recorded for stats' sake:
//   events.jsonl    starts (with the wait and what held them), ends (run time,
//                   exit code), waits, give-ups, pauses, owner overrides, and
//                   the throttle watcher's machine samples
//   history.jsonl   each run's command and its measured memory
//   progress.jsonl  agents' posts: tasks, ETAs, done and blocked
// collect() is a pure function of those, so a test can feed it a made-up week.
import fs from 'node:fs';
import { paths } from './config.mjs';
import { readEvents } from './events.mjs';
import { read as readPosts } from './progress.mjs';
import { identity } from './proc.mjs';
import { span, stats as plainStats, statsOf } from './history.mjs';
import { die, now, dur, clock, masked } from './util.mjs';
import { bold, dim } from './style.mjs';

const HOUR = 36e5, DAY = 24 * HOUR;
// The machine chart: more points than this and a phone draws a smear.
const MACHINE_POINTS = 240;
const TOP = 6;
// Ends by signal: SIGTERM (143) and SIGKILL (137) are a stop, not the command failing.
const STOPPED = new Set([137, 143, 130]);
// What held a job back, as the start event's `held` and the wait event's `rule` name it (src/acquire.mjs).
export const RULES = {
  memory: 'free memory', pressure: 'memory pressure', swap: 'swapping', swaproom: 'disk for swap', disk: 'free disk',
  drain: 'disk filling', cpu: 'CPU cores', load: 'machine load', slot: 'a busy slot', ahead: 'someone ahead',
  together: 'a job it would slow', reset: 'a reset', files: 'a file lease',
};

const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1] : null);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const midnight = t => new Date(t).setHours(0, 0, 0, 0);
const nextDay = t => { const d = new Date(t); d.setDate(d.getDate() + 1); return d.setHours(0, 0, 0, 0); };
const top = (m, n = TOP) => [...m.entries()].sort((a, b) => b[1].n - a[1].n || b[1].ms - a[1].ms).slice(0, n).map(([k, v]) => ({ name: k, ...v }));
const bump = (m, k, ms = 0) => { const x = m.get(k) || { n: 0, ms: 0 }; x.n++; x.ms += ms; m.set(k, x); };
// A history key is "res,res|program words / more words" (src/acquire.mjs commandKey): the command part.
// File leases name one path each; together they're one line, as on the Mac app's schedule.
const resOf = rs => [...new Set((rs || []).map(r => (r.startsWith('files:') ? 'files' : r)))];
const cmdOf = key => masked(String(key || '').split('|').slice(1).join('|').split(' / ')[0].replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim()) || null;

// Every run time since `since`, from history.jsonl and the one rotated out before it.
// history() in state.mjs keeps only the newest 1000.
export function readRuns(since) {
  let text = '';
  for (const f of [paths.historyOlder, paths.history]) try { text += fs.readFileSync(f, 'utf8') + '\n'; } catch {}
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (r.at >= since) out.push(r); } catch {}
  }
  return out;
}

// One job per start that has an end: who, what, how long it waited and ran,
// and how it ended. A job still running counts its wait, not yet its run.
function jobsOf(events, since, until) {
  const starts = new Map(), out = [];
  for (const e of events) {
    if (e.kind === 'start') starts.set(e.id, e);
    else if (e.kind === 'end' && starts.has(e.id)) {
      const s = starts.get(e.id);
      starts.delete(e.id);
      if (s.at >= since && s.at <= until) out.push({ id: e.id, who: s.who, res: resOf(s.res), type: s.type || 'run', at: s.at, end: e.at, wait: s.ms || 0, run: e.ms || 0, code: e.code ?? null, held: s.held || null });
    }
  }
  for (const s of starts.values()) if (s.at >= since && s.at <= until) out.push({ id: s.id, who: s.who, res: resOf(s.res), type: s.type || 'run', at: s.at, end: null, wait: s.ms || 0, run: until - s.at, code: null, held: s.held || null, open: true });
  return out.sort((a, b) => a.at - b.at);
}

// How a task's ETA held up: for each task an agent finished, its last ETA
// before the done post against when it was done. late > 0 ms means past it.
function etas(posts) {
  const by = new Map(), out = [];
  for (const p of posts) {
    const key = `${p.who}\0${p.task || ''}\0${p.task ? '' : p.project || ''}`;
    const t = by.get(key) || { who: p.who, task: p.task || null, eta: null, blockedAt: null, blockedMs: 0 };
    by.set(key, t);
    // Blocked lasts from the blocked post to the task's next post.
    if (t.blockedAt != null) { t.blockedMs += p.at - t.blockedAt; t.blockedAt = null; }
    if (p.state === 'blocked') t.blockedAt = p.at;
    if (p.eta) t.eta = p.eta;
    if (p.state === 'done' && t.eta) { out.push({ who: p.who, task: t.task, eta: t.eta, done: p.at, late: p.at - t.eta }); t.eta = null; }
  }
  return { finished: out, tasks: [...by.values()] };
}

function heldOf(jobs) {
  const m = new Map();
  for (const j of jobs) for (const [rule, ms] of Object.entries(j.held || {})) bump(m, rule, ms);
  return [...m.entries()].sort((a, b) => b[1].ms - a[1].ms).map(([rule, v]) => ({ rule, label: RULES[rule] || rule, jobs: v.n, ms: v.ms }));
}

function exits(jobs) {
  const runs = jobs.filter(j => j.type === 'run' && !j.open);
  const codes = {};
  for (const j of runs) codes[j.code ?? 'none'] = (codes[j.code ?? 'none'] || 0) + 1;
  const failed = runs.filter(j => j.code != null && j.code !== 0 && !STOPPED.has(j.code)).length;
  const stopped = runs.filter(j => STOPPED.has(j.code)).length;
  return { runs: runs.length, failed, stopped, failRate: runs.length ? failed / runs.length : null, codes };
}

// A start a second or less after asking is dibs's own bookkeeping, not a wait anyone felt.
const FELT = 1000;
function waitsOf(jobs) {
  const w = jobs.filter(j => j.wait > FELT).map(j => j.wait);
  const done = jobs.filter(j => !j.open);
  return {
    waitMs: sum(jobs.map(j => j.wait)), waited: w.length, feltMedian: pct(w, 0.5), medianWait: pct(jobs.map(j => j.wait), 0.5), p90Wait: pct(jobs.map(j => j.wait), 0.9),
    waitedLonger: done.filter(j => j.wait > j.run).length, waitedLongerShare: done.length ? done.filter(j => j.wait > j.run).length / done.length : null,
  };
}

// Busy time per local hour of the day, as a share of that hour's time in the window.
function byHourOfDay(ivs, since, until) {
  const busy = new Array(24).fill(0), there = new Array(24).fill(0);
  for (let t = since; t < until;) {
    const d = new Date(t); d.setMinutes(60, 0, 0);
    const next = Math.min(d.getTime(), until);
    there[new Date(t).getHours()] += next - t;
    t = next;
  }
  for (const { a, b } of ivs) {
    for (let t = Math.max(a, since), end = Math.min(b, until); t < end;) {
      const d = new Date(t); d.setMinutes(60, 0, 0);
      const next = Math.min(d.getTime(), end);
      busy[new Date(t).getHours()] += next - t;
      t = next;
    }
  }
  return busy.map((ms, h) => (there[h] ? Math.min(1, ms / there[h]) : 0));
}

// Time covered by at least one interval.
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

// Run and wait time falling in each (day, hour) cell: days down, hours across.
function grid(jobs, since, until) {
  const days = [];
  for (let d = midnight(since); d < until; d = nextDay(d)) days.push({ day: d, run: new Array(24).fill(0), wait: new Array(24).fill(0), jobs: new Array(24).fill(0) });
  const spread = (a, b, key) => {
    for (let t = Math.max(a, since), end = Math.min(b, until); t < end;) {
      const d = new Date(t); d.setMinutes(60, 0, 0);
      const next = Math.min(d.getTime(), end);
      const row = days.find(x => x.day === midnight(t));
      if (row) row[key][new Date(t).getHours()] += next - t;
      t = next;
    }
  };
  for (const j of jobs) {
    spread(j.at - j.wait, j.at, 'wait');
    spread(j.at, j.at + j.run, 'run');
    const row = days.find(x => x.day === midnight(j.at));
    if (row) row.jobs[new Date(j.at).getHours()]++;
  }
  return days;
}

function machineOf(events, since, until, agent) {
  const samples = events.filter(e => e.kind === 'sample' && e.at >= since && e.at <= until);
  const step = Math.max(6e4, (until - since) / MACHINE_POINTS);
  const buckets = new Map();
  for (const s of samples) {
    const k = Math.floor((s.at - since) / step);
    const b = buckets.get(k) || { at: since + k * step, load: [], memFree: [], diskFree: [] };
    for (const f of ['load', 'memFree', 'diskFree']) if (typeof s[f] === 'number') b[f].push(s[f]);
    buckets.set(k, b);
  }
  const avg = xs => (xs.length ? sum(xs) / xs.length : null);
  const series = [...buckets.values()].sort((a, b) => a.at - b.at).map(b => ({ at: Math.round(b.at), load: avg(b.load), memFree: avg(b.memFree), diskFree: avg(b.diskFree) }));
  const inWin = e => e.at >= since && e.at <= until && (!agent || e.who === agent);
  const pauses = events.filter(e => e.kind === 'pause' && inWin(e));
  const overrides = events.filter(e => e.kind === 'override' && e.at >= since && e.at <= until && (!agent || e.who === agent || e.by === agent));
  // An owner's pause leaves an override event too; the rest are dibs's own (memory pressure, urgent work).
  const ownerPauses = overrides.filter(e => e.act === 'pause').length;
  const memLow = series.filter(x => x.memFree != null).sort((a, b) => a.memFree - b.memFree)[0] || null;
  const diskLow = series.filter(x => x.diskFree != null).sort((a, b) => a.diskFree - b.diskFree)[0] || null;
  const loadHigh = series.filter(x => x.load != null).sort((a, b) => b.load - a.load)[0] || null;
  return {
    series, samples: samples.length, memLow, diskLow, loadHigh,
    pauses: pauses.length, ownerPauses, dibsPauses: Math.max(0, pauses.length - ownerPauses),
    overrides: overrides.slice(-40).map(e => ({ at: e.at, act: e.act, by: e.by || null, byAgent: !!e.byAgent, id: e.id ?? null, who: e.who ?? null, to: e.to ?? null, prio: e.prio ?? null, reason: e.reason ?? null })),
    cleaned: sum(events.filter(e => e.kind === 'clean' && e.at >= since && e.at <= until).map(e => e.freed || 0)),
  };
}

// The whole picture between since and until, for everyone or one agent.
export function collect({ events, runs = [], posts = [], since, until, agent = null }) {
  const all = jobsOf(events, since, until);
  const jobs = agent ? all.filter(j => j.who === agent) : all;
  const gaveUp = events.filter(e => e.kind === 'timeout' && e.at >= since && e.at <= until && (!agent || e.who === agent));
  const left = events.filter(e => e.kind === 'left' && e.at >= since && e.at <= until && (!agent || e.who === agent));
  const myPosts = posts.filter(p => p.at >= since && p.at <= until && (!agent || p.who === agent));
  const eta = etas(posts.filter(p => p.at <= until && (!agent || p.who === agent)));
  const etaIn = eta.finished.filter(x => x.done >= since);
  const myRuns = runs.filter(r => r.at >= since && r.at <= until && (!agent || r.who === agent));

  const agentsOf = new Map();
  for (const j of jobs) (agentsOf.get(j.who) || agentsOf.set(j.who, []).get(j.who)).push(j);
  for (const p of myPosts) if (!agentsOf.has(p.who)) agentsOf.set(p.who, []);
  const agents = [...agentsOf.entries()].map(([who, js]) => {
    const res = new Map(), cmds = new Map();
    for (const j of js) for (const r of j.res) bump(res, r, j.open ? 0 : j.run);
    const rs = myRuns.filter(r => r.who === who);
    for (const r of rs) { const c = cmdOf(r.key); if (c) bump(cmds, c, r.dur || 0); }
    const ps = myPosts.filter(p => p.who === who);
    const mine = etaIn.filter(x => x.who === who);
    const tasks = eta.tasks.filter(x => x.who === who);
    return {
      who, jobs: js.length, runMs: sum(js.map(j => j.run)), ...waitsOf(js), ...exits(js),
      gaveUp: gaveUp.filter(e => e.who === who).length,
      resources: top(res), commands: top(cmds), heldBy: heldOf(js),
      peakMem: Math.max(0, ...rs.map(r => r.mem || 0)) || null,
      posts: ps.length, tasksDone: new Set(ps.filter(p => p.state === 'done').map(p => p.task || p.project)).size,
      blockedMs: sum(tasks.map(x => x.blockedMs)), blockedNow: tasks.filter(x => x.blockedAt != null).length,
      eta: { finished: mine.length, onTime: mine.filter(x => x.late <= 0).length, medianLate: pct(mine.map(x => x.late), 0.5) },
    };
  }).sort((a, b) => b.jobs - a.jobs || b.posts - a.posts);

  const resNames = [...new Set(jobs.flatMap(j => j.res))];
  const resources = resNames.map(r => {
    const js = jobs.filter(j => j.res.includes(r));
    const ivs = js.map(j => ({ a: j.at, b: j.at + j.run }));
    const busy = union(ivs, since, until);
    const holders = new Map();
    for (const j of js) bump(holders, j.who, j.run);
    return {
      res: r, jobs: js.length, busyMs: busy, utilization: busy / Math.max(1, until - since), ...waitsOf(js),
      hours: byHourOfDay(ivs, since, until), heldBy: heldOf(js), agents: top(holders, 4),
      gaveUp: gaveUp.filter(e => resOf(e.res).includes(r)).length,
      waitRules: Object.entries(events.filter(e => e.kind === 'wait' && e.at >= since && e.at <= until && resOf(e.res).includes(r) && (!agent || e.who === agent))
        .reduce((m, e) => ({ ...m, [e.rule || 'slot']: (m[e.rule || 'slot'] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).map(([rule, n]) => ({ rule, label: RULES[rule] || rule, n })),
    };
  }).sort((a, b) => b.busyMs - a.busyMs);

  const days = [];
  for (let d = midnight(since); d < until; d = nextDay(d)) {
    const js = jobs.filter(j => j.at >= d && j.at < nextDay(d));
    days.push({ day: d, jobs: js.length, runMs: sum(js.map(j => j.run)), waitMs: sum(js.map(j => j.wait)), ...exits(js) });
  }

  return {
    since, until, agent,
    totals: {
      jobs: jobs.length, agents: agents.filter(a => a.jobs).length, runMs: sum(jobs.map(j => j.run)), ...waitsOf(jobs), ...exits(jobs),
      gaveUp: gaveUp.length, leftLine: left.length, posts: myPosts.length,
      eta: { finished: etaIn.length, onTime: etaIn.filter(x => x.late <= 0).length, medianLate: pct(etaIn.map(x => x.late), 0.5) },
      heldBy: heldOf(jobs),
    },
    agents, resources, days, grid: grid(jobs, since, until), machine: machineOf(events, since, until, agent),
  };
}

// The same from the files on disk.
export function gather({ since, until = now(), agent = null } = {}) {
  return collect({ events: readEvents(until), runs: readRuns(since), posts: readPosts({ since: since - 7 * DAY }), since, until, agent });
}

// Plain sentences first, then the numbers: what an agent reads to see how it's doing.
const share = x => (x == null ? '-' : `${Math.round(100 * x)}%`);
export function text(s) {
  const t = s.totals, who = s.agent || 'Everyone';
  const out = [bold(`${who}, ${new Date(s.since).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(s.since)} to now`)];
  if (!t.jobs && !t.posts) return [...out, 'Nothing went through dibs in this period.'];
  out.push(`${t.jobs} job${t.jobs === 1 ? '' : 's'}: ran ${dur(t.runMs)}, waited ${dur(t.waitMs)}. ${t.waitedLongerShare != null ? `${share(t.waitedLongerShare)} waited longer than they ran.` : ''}`.trim());
  if (t.runs) out.push(`${t.runs} finished run${t.runs === 1 ? '' : 's'}: ${t.failed} failed (${share(t.failRate)}), ${t.stopped} stopped by a signal.${t.gaveUp ? ` ${t.gaveUp} gave up waiting (exit 75).` : ''}`);
  if (t.heldBy.length) out.push(`Held back most by ${t.heldBy.slice(0, 3).map(h => `${h.label} (${dur(h.ms)})`).join(', ')}.`);
  if (t.eta.finished) out.push(`ETAs: ${t.eta.onTime} of ${t.eta.finished} tasks done on time${t.eta.medianLate > 0 ? `, typically ${dur(t.eta.medianLate)} late` : ''}.`);
  if (t.posts) out.push(`${t.posts} progress post${t.posts === 1 ? '' : 's'}.`);
  const cols = (head, rows) => {
    const w = head.map((c, i) => Math.max(c.length, ...rows.map(r => String(r[i]).length)));
    return [head, ...rows].map(r => `  ${r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ')}`.trimEnd());
  };
  if (s.resources.length) {
    out.push('', bold('By resource'), ...cols(['', 'jobs', 'busy', 'in use', 'had to wait', 'usually', '1 in 10 over', 'gave up'],
      s.resources.slice(0, 12).map(r => [r.res, r.jobs, dur(r.busyMs), share(r.utilization), r.waited, r.waited ? dur(r.feltMedian) : '-', dur(r.p90Wait || 0), r.gaveUp])));
  }
  if (!s.agent && s.agents.length) {
    out.push('', bold('By agent'), ...cols(['', 'jobs', 'ran', 'waited', 'waited > ran', 'failed', 'posts', 'ETAs met'],
      s.agents.slice(0, 20).map(a => [a.who, a.jobs, dur(a.runMs), dur(a.waitMs), share(a.waitedLongerShare), share(a.failRate), a.posts, a.eta.finished ? `${a.eta.onTime}/${a.eta.finished}` : '-'])));
  }
  if (s.agent && s.agents[0]) {
    const a = s.agents[0];
    if (a.commands.length) out.push('', bold('Top commands'), ...a.commands.map(c => `  ${String(c.n).padStart(4)}x  ${dur(c.ms).padStart(7)}  ${c.name}`));
    const codes = Object.entries(a.codes).sort((x, y) => y[1] - x[1]);
    if (codes.length) out.push('', bold('Exit codes'), `  ${codes.map(([c, n]) => `${c}: ${n}`).join(', ')}`);
    if (a.peakMem) out.push('', `Most memory one run used: ${(a.peakMem / 1024 ** 3).toFixed(1)} GB.`);
    if (a.blockedMs) out.push(`Blocked for ${dur(a.blockedMs)} in all (from a --blocked post to the next).`);
  }
  const m = s.machine;
  if (m.samples) out.push('', `Machine: load peaked at ${m.loadHigh?.load?.toFixed(1) ?? '?'} around ${m.loadHigh ? clock(m.loadHigh.at) : '?'}; memory got down to ${m.memLow?.memFree != null ? Math.round(m.memLow.memFree) : '?'}% free. ${m.pauses} pause${m.pauses === 1 ? '' : 's'} (${m.ownerPauses} by hand).`);
  out.push('', dim('More: dibs stats --since 30d, --agent <name>, --me, --json'));
  return out;
}

// dibs stats [--since 7d] [--agent <name> | --me] [--json]. With no flags it
// prints what it always has: waits against run times, today and this week.
export function stats(args, cfg) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i], next = () => args[++i] ?? die(`${a} needs a value`);
    if (a === '--since') o.since = next();
    else if (a === '--agent') o.agent = next();
    else if (a === '--me') o.me = true;
    else if (a === '--json') o.json = true;
    else die(`unknown ${a.startsWith('-') ? 'flag' : 'word'} ${a}. Use: dibs stats [--since 7d] [--agent <name> | --me] [--json]`);
  }
  if (o.me && o.agent) die('--me or --agent, not both');
  if (!o.since && !o.agent && !o.me && !o.json) return plainStats(o, cfg);
  const until = now(), since = until - span(o.since || '7d');
  const agent = o.me ? identity().who : o.agent || null;
  const s = gather({ since, until, agent });
  if (o.json) {
    // The old --json shape stays for whoever reads it, with everything else beside it.
    const events = readEvents(until);
    return console.log(JSON.stringify({ today: statsOf(events, midnight(until)), week: statsOf(events, until - 7 * DAY), ...s }, null, 1));
  }
  console.log(text(s).join('\n'));
}
