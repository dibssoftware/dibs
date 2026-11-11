// The line in sentences, for people who have never seen dibs: what each
// resource is doing, where a waiter stands, when it starts and what it's
// waiting for. Plain `dibs`, `dibs why` and `dibs --json` (`lines`, and `plain`
// on each row) all read from here; `--detail` keeps the numbers dibs decides by.
//
// Times are said only as surely as dibs knows them: "about 4 min" when every
// job in the way has a run time from history or --est, "as soon as X finishes"
// when X has none, and "unknown" when the wait is on the machine (disk, memory,
// load), which no clock predicts.
import { IDLE_MEM_FREE, verdict, forecastDetail, expected, known, remaining, rankParts, byRank, recentUse, coveredNow, memUsed, memHolders, shownFree, NOT_PRIORITY, swapping, diskSqueeze, overLoad, STALL, QUICK_LINE } from './schedule.mjs';
import { quotaBlock, isQuota, QUOTA } from './quota.mjs';
import { isFiles, short, elsewhere } from './files.mjs';
import { machine, resCfg } from './config.mjs';
import { hogHint } from './hogs.mjs';
import { gb, clock, now, bytes, inClaudeCode, agentLabel } from './util.mjs';

const MIN = 6e4;

// The built-in resources in words. the: after "for" ("Next for the
// simulator"). a: what a job has going ("a deploy"). doing: a running job's
// headline. noun: one job on it ("web-app's deploy"). one, many: what its users are doing.
const NAMES = {
  sim: { label: 'Simulator', the: 'the simulator', a: 'the simulator', doing: 'Using the simulator', noun: 'simulator run', one: 'is using it', many: 'are using it', queue: 'the simulator queue' },
  'sim-own': { label: 'Private simulators', the: 'a private simulator', a: 'a private simulator', doing: 'Using a private simulator', noun: 'simulator run', one: 'is using one', many: 'are using one each', queue: 'the private simulator queue' },
  'xcode-build': { label: 'Xcode builds', the: 'Xcode builds', a: 'an Xcode build', doing: 'Building with Xcode', noun: 'build', one: 'is building', many: 'are building', queue: 'the Xcode build queue' },
  playwright: { label: 'Browser tests', the: 'browser tests', a: 'browser tests', doing: 'Running browser tests', noun: 'browser tests', one: 'is running browser tests', many: 'are running browser tests', queue: 'the browser test queue' },
  test: { label: 'Test runs', the: 'test runs', a: 'a test run', doing: 'Running tests', noun: 'tests', one: 'is running tests', many: 'are running tests', queue: 'the test queue' },
  deploy: { label: 'Deploys', the: 'deploys', a: 'a deploy', doing: 'Deploying', noun: 'deploy', one: 'is deploying', many: 'are deploying', queue: 'the deploy queue' },
  heavy: { label: 'Heavy jobs', the: 'heavy jobs', a: 'a heavy job', doing: 'Running a heavy job', noun: 'heavy job', one: 'is running a heavy job', many: 'are running heavy jobs', queue: 'the heavy job queue' },
};
// Rate limits people are likely to share, by the name the README uses.
const QUOTA_NAMES = { asc: 'App Store Connect' };

// A resource's words. A `label` in its config wins, for resources dibs doesn't know.
export function named(cfg, r) {
  const n = words(cfg, r);
  return { a: n.the, one: 'is using it', many: 'are using it', queue: `the ${n.label} queue`, ...n };
}
function words(cfg, r) {
  if (isFiles(r)) {
    const p = short(r).slice('files:'.length).replace(/\/\*\*?$/, '');
    const files = { one: 'has reserved them', many: 'have reserved them' };
    if (!p) return { label: 'Files', the: 'files', doing: 'Editing files', noun: 'edit', queue: 'the files queue', ...files };
    return { label: `Files in ${p}`, the: `files in ${p}`, doing: `Editing files in ${p}`, noun: `edit of ${p}`, queue: `the queue for files in ${p}`, ...files };
  }
  if (isQuota(r)) {
    const n = r.slice(QUOTA.length);
    const label = cfg.quotas?.[n]?.label || `${QUOTA_NAMES[n] || n} budget`;
    return { label, the: `the ${label}`, doing: `Using the ${label}`, noun: 'job' };
  }
  const own = cfg.resources?.[r]?.label;
  if (own) return { label: own, the: own, doing: `Using ${own}`, noun: 'job', queue: `the ${own} queue` };
  return NAMES[r] || { label: r, the: r, doing: `Using ${r}`, noun: 'job', queue: `the ${r} queue` };
}

export const ordinal = n => {
  const tens = n % 100, ones = n % 10;
  return `${n}${tens >= 11 && tens <= 13 ? 'th' : ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th'}`;
};
export const andList = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
// A job held by the load ceiling starts on its own by v.by at the latest (schedule.mjs LOAD_STARVE).
export const heldByLoad = v => `held by load since ${clock(v.since)}, starts by ${clock(v.by)} at the latest`;
// High and urgent work passes the load ceiling, so here raising it is the fix, when it's really needed.
const LOAD_ADVICE = 'If a person is waiting on it now, run it with -p high -m "why". Or send it to another machine: --on <machine> (dibs machines lists them)';
export const minutes = t => {
  const m = Math.max(1, Math.round(t / MIN));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
};
export const about = t => (t < MIN ? 'under a minute' : `about ${minutes(t)}`);
const GB = b => gb(b).replace(/G$/, ' GB');
export const lower = s => s[0].toLowerCase() + s.slice(1);
const upper = s => s[0].toUpperCase() + s.slice(1);
// A holder on the board: session/subagent when a subagent took it (agentLabel).
const holderName = x => (agentLabel(x) ? `${x.who}/${agentLabel(x)}` : x.who);

// Whose board plainBoard is writing, set by its `me`: in the caller's own
// sentences a job of its own reads "your own job #12" and a sibling
// subagent's "alex-3b/fix-guard", never the session name the caller
// shares with them, which reads like waiting for yourself.
let viewer = null;
const who = x => {
  if (!viewer || !(viewer.spid ? x.spid === viewer.spid : !x.spid && x.who === viewer.who)) return x.who;
  // A sibling goes by its name, its -m reason or its id (agentLabel), never its session's name alone.
  if (viewer.agentId && x.agentId && x.agentId !== viewer.agentId)
    return agentLabel(x) ? `${x.who}/${agentLabel(x)}` : `another job from your session (#${x.id})`;
  // Unstamped (no guard hook), a job from the same session may be a sibling's.
  return viewer.spid && !(viewer.agentId && x.agentId) ? `a job from your session (#${x.id})` : `your own job #${x.id}`;
};

// Moves under a minute change nobody's turn in a way worth a sentence.
const MOVE_SHOWN = MIN;

// When a running job ends. A hold's end is only its longest: it may be given back sooner.
export function ends(l, hist, t) {
  if (l.kind === 'hold') { const left = Math.max(l.expires - t, 0); return { endsIn: left, endsText: `up to ${minutes(left)} left` }; }
  const left = remaining(l, hist, t);
  return left == null ? { endsIn: null, endsText: 'time left unknown' } : { endsIn: left, endsText: `${about(left)} left` };
}

// Who has a line now. rows: { who, endsIn, endsText, hold }.
// "onboarding is using it, about 4 min left"; "web-app and ios-checkout are using it, time left unknown for both"
export function usingText(rows, n) {
  if (rows.length === 1) {
    const x = rows[0];
    return `${x.who} ${x.hold && n.one !== 'has reserved them' ? 'has reserved it' : n.one}, ${x.endsText}`;
  }
  const soon = rows.filter(x => x.endsIn != null).sort((a, b) => a.endsIn - b.endsIn)[0];
  const tail = !soon ? `time left unknown for ${rows.length === 2 ? 'both' : `all ${rows.length}`}`
    : soon.hold ? `one is free within ${minutes(soon.endsIn)}` : `the first should be done in ${about(soon.endsIn)}`;
  return `${andList(rows.map(who))} ${n.many}, ${tail}`;
}

// "Next: api-refactor, then onboarding and 2 others"
export function nextText(names) {
  if (names.length < 3) return `Next: ${names.join(', then ')}`;
  return `Next: ${names[0]}, then ${names[1]} and ${names.length - 2} other${names.length > 3 ? 's' : ''}`;
}

// Why a job was paused, as a sentence, or null.
function pausedText(l, cfg) {
  if (!l.pausedAt) return null;
  const hand = l.pauses?.find(p => p.owner);
  if (hand) return `Paused by ${hand.by || 'the person at this machine'}`;
  const by = (l.pauses || []).filter(p => p.lease != null);
  if (!by.length) return l.pauses?.some(p => p.disk) ? `Paused because free disk is low and ${l.pauses.some(p => p.swap) ? 'swap is still growing on it' : 'still falling'}` : 'Paused because the machine is short on memory';
  return `Paused so ${andList([...new Set(by.map(p => `${p.who}'s ${p.prio && p.prio !== 'normal' ? `${p.prio} ` : ''}${named(cfg, p.res?.[0] || '').noun}`))])} could go first`;
}

// A job started on top of a full queue (src/overlap.mjs), as a sentence.
const alongsideText = a => (a.kind === 'squeeze' ? `Squeezed in next to ${andList(a.with)}, since it usually takes ${about(a.usually)}`
  : `Running alongside ${andList(a.with)}, since the machine had room`);

// "onboarding's snapshot tests to finish, about 4 min left"
function finishing(l, r, cfg, hist, t) {
  const e = ends(l, hist, t);
  const what = l.kind === 'hold' ? `${who(l)} to give ${named(cfg, r).the} back` : `${who(l)}'s ${l.purpose || named(cfg, r).noun} to finish`;
  const notes = [e.endsIn != null ? e.endsText : '', l.pausedAt ? "it's paused right now" : ''].filter(Boolean);
  return `${what}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}
// A run whose whole process tree has used no CPU this long while others wait
// is likely orphaned: a subagent's tool call died and left its test runner
// sitting on the slot (7 hours, once). A real job goes quiet for a simulator
// boot, a network call or a test timeout, a few minutes at most. 20 minutes is
// well past those, and short enough to matter to whoever is waiting.
export const STUCK_AFTER = 20 * MIN;
export const stuckFor = (l, t = now()) => (l.kind === 'run' && l.idleSince && t - l.idleSince >= STUCK_AFTER ? t - l.idleSince : 0);
export const stuckText = (l, t = now()) => { const d = stuckFor(l, t); return d ? `idle for ${minutes(d)}, may be stuck` : ''; };

// The memory picture a memory wait needs: what it needs, what's left of the
// budget and of the machine's real free memory, and who holds the most, so
// an agent can tell which of its own jobs to end.
export function memoryPicture(s, cfg, m, need, t = now()) {
  const budget = bytes(cfg.budget), out = memUsed(s), free = shownFree(m);
  const left = Math.max(0, budget - out);
  const holders = memHolders(s).map(h => `${h.who} #${h.id}${h.purpose ? ` ("${h.purpose}")` : ''}: ${h.use != null ? `using ${GB(h.use)}` : 'not measured yet'}, asked ${GB(h.asked)}`
    + `${h.idleSince && t - h.idleSince >= STUCK_AFTER ? `, idle for ${minutes(t - h.idleSince)}` : ''}`);
  return `it needs ${GB(need)}; ${GB(out)} of the ${GB(budget)} dibs shares out is taken, ${left ? `${GB(left)} left` : 'none left'}`
    + `${free != null ? `, and the machine has ${GB(free)} free or reclaimable` : ''}${m.vmPressure >= 1 ? ' with memory pressure high' : ''}`
    + `${holders.length ? `. Taking the most: ${holders.join('; ')}` : ''}`;
}

// What holds every new job back right now, as the end of "nothing new starts
// until ...", or ''. A line with free slots isn't free to use while this
// holds, so the board, who and the wait lines say it next to "free".
export function machineHold(s, cfg, m = machine()) {
  const othersRun = s.leases.some(l => (l.mem || 0) > 0 || (l.cpu ?? 1) > 0);
  if (m.diskFree != null && m.diskFree < bytes(cfg.minDisk)) return `more disk is free (${GB(m.diskFree)} free, under minDisk ${GB(bytes(cfg.minDisk))})`;
  const hot = overLoad(s, cfg, m);
  if (hot) return `the machine cools down (load ${(hot.load + hot.ahead).toFixed(1)}, over maxLoad ${cfg.maxLoad})`;
  if (!othersRun) return '';
  const sq = diskSqueeze(cfg, bytes(cfg.minDisk), m);
  if (sq) return sq.rule === 'drain' ? `free disk stops falling (it fell ${GB(sq.fell)} in 5 min)` : `${GB(sq.need)} of disk is free for swap to grow into`;
  const sw = swapping(cfg, m);
  if (sw) return sw.rule === 'pressure' ? 'memory pressure eases' : `swap stops growing (it grew ${GB(sw.grew)} in 5 min)`;
  const out = memUsed(s), budget = bytes(cfg.budget);
  if (out >= budget) return `memory frees up (${GB(out)} of the ${GB(budget)} dibs shares out is taken; jobs running a few minutes count at what they use, not what they asked)`;
  return '';
}

// The kinds of wait, for telling a real change from two readings of the same
// crunch: pressure and an over-budget reading take turns while memory is short.
const FAMILY = { pressure: 'memory', swap: 'memory', memory: 'memory', ram: 'memory', disk: 'disk', swaproom: 'disk', drain: 'disk', slot: 'line', ahead: 'line', files: 'line', reset: 'line' };
export const family = rule => FAMILY[rule] || rule;
// Waits on the machine itself, which no clock predicts.
const MACHINE = new Set(['memory', 'disk', 'load', 'cpu', 'idle']);

// A file lease's paths as a person reads them: src/auth, not files:src/auth/**.
const pathOf = r => short(r).slice('files:'.length).replace(/\/\*\*?$/, '');

// What a waiter is waiting for, in one sentence, from the rule that stops it.
function waitingFor(s, q, v, cfg, hist, t, m, f) {
  if (v.ok) return "nothing, it's about to start";
  const name = r => named(cfg, r);
  switch (v.rule) {
    case 'slot': {
      const end = l => ends(l, hist, t).endsIn ?? Infinity;
      // The job whose end the start time hangs on, when it's running; else the one that ends first.
      const l = (f?.after && s.leases.includes(f.after) && f.after.res.includes(v.on) ? f.after : null) || s.leases.filter(l => l.res.includes(v.on)).sort((a, b) => end(a) - end(b))[0];
      return l ? finishing(l, v.on, cfg, hist, t) : `${name(v.on).the} to free up`;
    }
    case 'ahead':
      if (v.starved) return `${who(v.ahead)} to go first (it's waited ${minutes(t - v.ahead.enq)} for room on the machine)`;
      return `${who(v.ahead)} to go first (it's ahead in the queue)`;
    case 'files': {
      const l = s.leases.find(l => l.res.includes(v.on));
      const include = q.res.includes(v.on) ? '' : `, which include ${andList(q.res.filter(isFiles).map(pathOf))}`;
      return `${l ? `${who(l)}${elsewhere(l)}` : 'another agent'} to finish with the files in ${pathOf(v.on)}${include}${l ? ` (${ends(l, hist, t).endsText})` : ''}`;
    }
    case 'reset': {
      const x = (s.resets || []).find(x => x.res === v.on);
      return `${name(v.on).the} to be reset after ${x?.agent || x?.who || 'the last'}'s turn`;
    }
    case 'memory':
      // Planned at all the memory dibs shares out because it usually uses more (src/measure.mjs sized).
      if (q.usual != null) return `all the memory dibs shares out to be free (it usually uses ${GB(q.usual)}, more than the ${GB(v.of)} there is): ${memoryPicture(s, cfg, m, v.need, t)}`;
      // The booked memory has room, but the machine doesn't show it free yet.
      if (v.real) return `memory the machine really has: ${GB(v.free)} free or reclaimable${v.untouched ? `, ${GB(v.untouched)} of it booked by running jobs` : ''}, while apps and sessions outside dibs hold the rest; it needs ${GB(v.need)}`;
      if (v.pressure) return `real free memory: running jobs ask for more than they use, but the machine has ${v.free == null ? 'an unknown amount' : GB(v.free)} free`
        + `${v.high ? ' with memory pressure high' : ''}${v.growing ? ' and swap growing' : ''}, and it needs ${GB(v.need)} plus ${GB(v.reserve)} to spare`;
      return `room in memory: ${memoryPicture(s, cfg, m, v.need, t)}`;
    case 'cpu': return `free processor cores (jobs running now are using ${v.used} of the ${v.of} cores dibs shares out, and it needs ${v.need})`;
    case 'disk': return `more free disk (${GB(v.free)} free, it needs ${GB(v.need)}${v.floorWhy ? `: ${v.floorWhy}` : ''})${hogHint()}`;
    case 'pressure': return `memory pressure to ease (the OS says it's high, so dibs starts nothing new until it eases): ${memoryPicture(s, cfg, m, q.mem, t)}`;
    case 'swaproom': return `more free disk for swap to grow into (${GB(v.free)} free; while this machine swaps, dibs starts nothing new until ${GB(v.need)} is free or nothing else is running)${hogHint()}`;
    case 'drain': return `free disk to stop falling (it fell ${GB(v.fell)} in 5 min to ${GB(v.free)}; dibs starts nothing new while it falls this fast and anything else is running)${hogHint()}`;
    case 'swap': return `this machine to stop swapping (swap grew ${GB(v.grew)} in 5 min, ${GB(v.used)} in use, so dibs starts nothing new until it stops growing): ${memoryPicture(s, cfg, m, q.mem, t)}`;
    case 'ram':
      return v.free != null ? `memory for another simulator (${GB(v.free)} free, it needs ${GB(v.need)})`
        : `more free memory (${m.memFree}% free, big jobs need ${cfg.minFreeMem}%)`;
    case 'load': return `${v.load != null ? `the machine to cool down (load ${v.load.toFixed(1)}; new work waits while it's over ${cfg.maxLoad})` : 'the machine to cool down'}`
      + `${v.since != null ? `. ${upper(heldByLoad(v))}, at background priority on the efficiency cores if the load is still high then` : ''}`;
    case 'idle':
      return v.ahead ? 'everyone else in the queue to go first (idle work goes last)' : `a quieter machine (idle work waits until ${IDLE_MEM_FREE}% of memory is free, now ${m.memFree}%)`;
    case 'together': return `${who(v.ahead)} to finish: ${v.why}, so both finish sooner one after the other (it waits at most as long as it runs)`;
    case 'quota': return `${name(v.on).the} to refill (${v.have} of ${v.limit} left, enough in ${about(v.in)})`;
    default: return v.why;
  }
}

// Behind others in its line, a waiter waits for them too, not only for the job running now.
const NAMED_AHEAD = 2;
function inTurn(ahead, v, why) {
  if (!ahead.length || v.ok || !['slot', 'files'].includes(v.rule)) return why;
  const names = ahead.length > NAMED_AHEAD ? [...ahead.slice(0, NAMED_AHEAD - 1).map(who), `${ahead.length - NAMED_AHEAD + 1} others`] : ahead.map(who);
  return `${andList(names)} to go first, and ${why}`;
}

// Why a waiter moved from its arrival time, one plain sentence per rule.
export function moves(q, hist, t, cfg) {
  const out = [];
  for (const p of rankParts(q, hist, t).parts) {
    if (Math.abs(p.shift) < MOVE_SHOWN) continue;
    let reason, label;
    if (p.label === q.prio) {
      label = q.owner ? (q.owner.act === 'cap' ? 'capped by the person' : 'set by the person') : q.prio === 'urgent' || q.prio === 'idle' ? q.prio : `${q.prio} priority`;
      const level = q.prio === 'urgent' ? 'urgent' : q.prio === 'idle' ? 'idle work' : `${q.prio} priority`;
      // Low and idle keep falling as normal work arrives; saying so stops an agent rerunning at normal to "fix" it.
      const sinks = q.prio === 'low' || q.prio === 'idle' ? ', so normal jobs that arrive later go ahead of it' : '';
      const by = q.owner?.by || 'the person at this machine';
      reason = q.owner ? `${by} ${q.owner.act === 'cap' ? `capped this agent at ${level}` : `set it to ${level}`}${q.owner.reason ? `: ${q.owner.reason}` : ''}${sinks}`
        : `it's ${level}${q.purpose && (q.prio === 'urgent' || q.prio === 'high') ? `: ${q.purpose}` : ''}${sinks}`;
    } else if (p.label.startsWith('holds ')) {
      label = 'finishing a job';
      reason = `it already has ${andList(q.holding.res.map(r => named(cfg, r).a))} going and needs this to finish`;
    } else if (p.label === 'deadline') {
      label = 'deadline';
      reason = q.by > t ? `it's due by ${clock(q.by)}` : `it was due at ${clock(q.by)}`;
    } else if (p.label === 'short job' || p.label === 'long job') {
      label = p.label;
      const e = known(q, hist) ? about(expected(q, hist)) : 'not seen before, so dibs tries it as a short one';
      reason = p.label === 'short job' ? `it's a short job (${e})` : `it's a long job (${e}), so shorter work that arrives soon after goes first`;
    } else if (p.label === 'recent use') {
      label = 'taking turns';
      reason = `this agent used ${andList(recentUse(hist, q.who, q.res, t).res.map(r => named(cfg, r).the))} a lot in the last hour`;
    } else if (p.label === 'quick') {
      label = 'quick';
      reason = "it runs in seconds (the quick lane), so it goes before anyone who'd hold the slot for longer";
    } else if (p.label === 'let ahead') {
      label = 'let ahead';
      reason = `${q.yieldBy || 'another agent'} let it go first`;
    } else reason = label = p.label;
    out.push({ dir: p.shift > 0 ? 'up' : 'down', amount: minutes(Math.abs(p.shift)), label, reason });
  }
  return out;
}

// When a waiter's start hangs on a job using another of the resources it
// needs, say which: "as soon as api finishes with Xcode builds".
function elsewhereOn(after, q, focus, s, cfg) {
  if (!s.leases.includes(after) || after.res.includes(focus)) return '';
  const r = q.res.find(x => after.res.includes(x));
  return r ? ` with ${named(cfg, r).the}` : '';
}

// Who a waiter could ask to let it go first: the one just ahead of it in its
// line, else whoever is using what it waits for. With the command they'd run.
export function askFirst(s, p, q) {
  const r = p.rules.get(q.id);
  const w = p.waiting.get(q.id);
  if (!w || w.place == null) return '';
  const line = p.lines.find(l => l.waiting.includes(q.id) && (!r?.on || l.res === r.on)) || p.lines.find(l => l.waiting.includes(q.id));
  const ahead = line && w.place > 1 ? s.queue.find(x => x.id === line.waiting[w.place - 2]) : null;
  const holder = r?.on && s.leases.find(l => l.res.includes(r.on));
  const x = ahead || holder;
  const them = x?.agent;
  if (!them || them === q.agent) return '';
  // SendMessage is Claude Code's, and reaches only another Claude Code session.
  if (inClaudeCode() && x.sessionId) return `To ask ${them} to let you go first: SendMessage ${them}. They run: dibs yield ${q.agent || q.who}`;
  return `To go first, ask ${them} to run: dibs yield ${q.agent || q.who}`;
}

// Waits whose start dibs can forecast from the jobs in the way. The others
// wait on the machine itself, or on a refill whose time is plain arithmetic.
const QUEUED = new Set(['slot', 'ahead', 'files', 'reset']);

// Where dibs stands, in sentences: { lines, held: Map(id -> plain), waiting: Map(id -> plain) }.
export function plainBoard(s, cfg, hist, t = now(), m = machine(), me = null) {
  viewer = me;
  const fc = forecastDetail(s, cfg, hist, t);
  const order = s.queue.filter(q => q.pid).sort(byRank(hist, t));
  const verdicts = new Map(order.map(q => {
    const v = verdict(s, q, cfg, hist, t);
    return [q.id, v.ok ? quotaBlock(s, q, cfg, hist, t) || v : v];
  }));

  // Every configured resource, then anything else in use or wanted.
  const res = [...new Set([...Object.keys(cfg.resources), ...s.leases.flatMap(l => l.res), ...order.flatMap(q => q.res)])];
  const lines = res.map((r, i) => {
    // A run its own hold covers is that hold's turn, so it isn't shown twice. Quota tokens aren't held.
    const serving = isQuota(r) ? [] : s.leases.filter(l => l.res.includes(r) && !coveredNow(s, l, r)).sort((a, b) => a.start - b.start).map(l => ({
      id: l.id, who: holderName(l), label: l.label || null, purpose: l.purpose || '', ...ends(l, hist, t) }));
    const waiting = order.filter(q => q.res.includes(r)).map(q => q.id);
    return { res: r, label: named(cfg, r).label, serving, waiting, clearsIn: null, summary: '', i };
  }).filter(l => !(isQuota(l.res) || isFiles(l.res)) || l.serving.length || l.waiting.length || cfg.resources[l.res]);

  const lineOf = new Map(lines.map(l => [l.res, l]));
  const waiting = new Map();
  const rules = new Map();
  for (const q of order) {
    const v = verdicts.get(q.id);
    const f = fc.get(q.id);
    const focus = q.res.includes(v.on) ? v.on : v.ahead ? q.res.find(r => v.ahead.res.includes(r)) || q.res[0] : q.res[0];
    const line = lineOf.get(focus);
    const place = line.waiting.indexOf(q.id) + 1;
    // Behind a waiter that the machine holds back (memory, disk, load), this
    // one waits on the machine too: no clock says when, whatever the forecast
    // of slots alone says. Said once, here, so the wait line, why, when and
    // the board all agree.
    const av = v.rule === 'ahead' && v.ahead ? verdicts.get(v.ahead.id) : null;
    const stuck = av && !av.ok && MACHINE.has(family(av.rule)) ? av : null;
    const kind = v.ok ? 'go' : family(stuck ? stuck.rule : v.rule);
    const start = v.ok ? { startsIn: 0, startsText: 'now' }
      : v.rule === 'quota' ? { startsIn: v.in, startsText: about(v.in) }
      : stuck || !QUEUED.has(v.rule) ? { startsIn: null, startsText: 'unknown' }
      : f.sure ? { startsIn: f.at - t, startsText: about(f.at - t) }
      : f.after ? { startsIn: null, startsText: `as soon as ${who(f.after)} finishes${elsewhereOn(f.after, q, focus, s, cfg)}` }
      : { startsIn: null, startsText: 'unknown' };
    const why = stuck ? `${who(v.ahead)} to go first, and it's waiting for ${waitingFor(s, v.ahead, stuck, cfg, hist, t, m, fc.get(v.ahead.id))}`
      : inTurn(line.waiting.slice(0, place - 1).map(id => order.find(x => x.id === id)), v, waitingFor(s, q, v, cfg, hist, t, m, f));
    // Said now, while there's time to free some, not at its turn.
    const diskNext = v.diskNext ? `. After that it needs more free disk than there is: ${GB(v.diskNext.free)} free, it needs ${GB(v.diskNext.need)}, so free some now or it waits again then${hogHint()}` : '';
    waiting.set(q.id, {
      place, of: line.waiting.length, res: focus, family: kind,
      ahead: line.waiting.slice(0, place - 1),
      headline: `${place === 1 ? 'Next' : ordinal(place)} in ${named(cfg, focus).queue}`,
      ...start, waitingFor: why + diskNext, ...(v.diskNext && { diskNext: v.diskNext }),
      ...(kind === 'load' ? { advice: LOAD_ADVICE } : MACHINE.has(kind) && kind !== 'idle' ? { advice: NOT_PRIORITY } : {}),
      moves: moves(q, hist, t, cfg),
    });
    if (!v.ok) rules.set(q.id, { rule: v.rule, on: v.on, alongside: v.alongside });
  }
  // A waiter whose dibs gave up keeps its place for a while, out of line.
  for (const q of s.queue.filter(q => !q.pid))
    waiting.set(q.id, { place: null, of: null, headline: `Place kept in ${named(cfg, q.res[0]).queue}`, startsIn: null, startsText: 'unknown',
      waitingFor: 'its agent to ask again within 2 minutes', moves: [] });

  for (const l of lines) {
    const rows = l.waiting.map(id => ({ q: order.find(q => q.id === id), p: waiting.get(id) }));
    // Clear when the last job in this line should be done, if every one of those times is known.
    const sure = l.serving.every(x => x.endsIn != null && !s.leases.find(y => y.id === x.id && y.kind === 'hold'))
      && rows.every(({ q, p }) => p.startsIn != null && known(q, hist));
    l.clearsIn = !l.serving.length && !l.waiting.length ? 0
      : sure ? Math.max(0, ...l.serving.map(x => x.endsIn), ...rows.map(({ q, p }) => p.startsIn + expected(q, hist))) : null;
    // One deploy per project (exclusiveBy repo): a deploy running is no reason for another project's to wait.
    const perProject = resCfg(cfg, l.res).exclusiveBy === 'repo';
    l.summary = !l.serving.length && !l.waiting.length ? 'Free'
      : [l.serving.length ? (perProject ? `${l.serving.length} deploying (one per project, up to ${resCfg(cfg, l.res).across ?? resCfg(cfg, l.res).slots} at once)` : `${l.serving.length} in use`) : 'Free', l.waiting.length ? `${l.waiting.length} waiting` : '',
        l.clearsIn ? `clear in ${about(l.clearsIn)}` : ''].filter(Boolean).join(', ');
  }
  lines.sort((a, b) => b.serving.length + b.waiting.length - a.serving.length - a.waiting.length || a.i - b.i);
  for (const l of lines) delete l.i;

  const someoneWaits = order.length > 0;
  const held = new Map(s.leases.map(l => [l.id, {
    headline: l.res.map((r, i) => (i ? lower(named(cfg, r).doing) : named(cfg, r).doing)).join(' and '),
    endsText: ends(l, hist, t).endsText, paused: pausedText(l, cfg), ...(l.alongside ? { alongside: alongsideText(l.alongside) } : l.breaker ? { alongside: `Let in although the machine is short of disk or memory, since nothing had started for ${STALL / 6e4} min` } : l.quick ? { alongside: upper(QUICK_LINE) } : {}),
    ...(someoneWaits && stuckFor(l, t) ? { stuck: `${stuckText(l, t)} (#${l.id}${l.purpose ? `, "${l.purpose}"` : ''})` } : {}) }]));
  return { lines, held, waiting, rules, names: new Map(s.queue.map(q => [q.id, holderName(q)])), holds: new Set(s.leases.filter(l => l.kind === 'hold').map(l => l.id)), cfg,
    hold: machineHold(s, cfg, m) };
}

// When a waiter starts, as a phrase: "in about 4 min", "as soon as onboarding finishes".
export const startPhrase = w => (w.startsText === 'unknown' ? 'start time unknown' : w.startsText === 'now' ? 'starting now'
  : w.startsText.startsWith('as soon') ? w.startsText : `in ${w.startsText}`);

// Each busy line in two parts, what's happening now and who's next, plus the free ones.
export function lineParts(p) {
  const busy = [];
  const free = [];
  for (const l of p.lines) {
    if (!l.serving.length && !l.waiting.length) { free.push(l.label); continue; }
    const rows = l.serving.map(x => ({ ...x, hold: p.holds.has(x.id) }));
    const paused = l.serving.map(x => [x.who, p.held.get(x.id)?.paused || p.held.get(x.id)?.stuck]).filter(x => x[1]);
    // Who is running on top of a full queue (src/overlap.mjs), after any pause.
    const side = l.serving.map(x => [x.who, p.held.get(x.id)?.alongside]).filter(x => x[1]);
    const notes = [...paused, ...side];
    let now = rows.length ? usingText(rows, named(p.cfg, l.res)) : 'free';
    if (notes.length) now += ` (${rows.length > 1 ? notes.map(([w, x]) => `${w} is ${lower(x)}`).join('; ') : lower(notes[0][1])})`;
    let next = '';
    const names = l.waiting.map(id => `${p.names.get(id)} (#${id})`);   // the id, for dibs why, boost or stop
    if (names.length) {
      // Say why the next one waits only when it isn't simply its turn here:
      // stuck on the machine, or on another resource it needs too.
      const r = p.rules.get(l.waiting[0]);
      const elsewhere = r && r.on && r.on !== l.res;
      const also = elsewhere && !(isFiles(r.on) && isFiles(l.res)) ? `also needs ${named(p.cfg, r.on).the} and ` : '';
      const stuck = r && (!['slot', 'ahead', 'files'].includes(r.rule) || elsewhere) ? `${also}is waiting for ${p.waiting.get(l.waiting[0]).waitingFor}` : '';
      const why = stuck && `${names[0]} ${stuck}`;
      const after = names.length > 1 ? `After it: ${names.slice(1).join(', ')}` : '';
      // A rate limit is never "free": its tokens refill with time.
      if (isQuota(l.res) && why) { now = why; next = after; }
      else if (!rows.length && why) { now += `, but ${why}`; next = after; }
      else next = !why ? nextText(names) : names.length === 1 ? `${nextText(names)}, who ${stuck}` : `${nextText(names)}. ${why}`;
    }
    busy.push({ res: l.res, label: l.label, now, next });
  }
  return { busy, free };
}

// The same, one sentence per line, for places without columns.
export function lineSentences(p) {
  const { busy, free } = lineParts(p);
  return [...busy.map(b => `${b.label}: ${b.now}${b.next ? `. ${b.next}` : ''}.`), ...(free.length ? [`Free: ${freeText(p, free)}.`] : [])];
}
// The free lines, and what holds them back when the machine does.
export const freeText = (p, free) => `${free.join(', ')}${p.hold ? `, but nothing new starts until ${p.hold}` : ''}`;

// The board's first line: the one thing that matters most.
export function headline(p) {
  const running = p.held.size, waiting = [...p.waiting.values()].filter(w => w.place != null);
  if (!running && !waiting.length) return "Nothing queued. Everything's free.";
  const counts = `${running} running, ${waiting.length ? `${waiting.length} waiting` : 'nobody waiting'}.`;
  const line = p.lines.find(l => l.waiting.length && p.waiting.get(l.waiting[0]).place === 1);
  if (!line) return counts;
  return `${counts} Next up: ${p.names.get(line.waiting[0])} for ${named(p.cfg, line.res).the}, ${startPhrase(p.waiting.get(line.waiting[0]))}.`;
}

// dibs why for one waiter: where it is, when it starts, what it waits for, and why it moved.
export function whyLines(p, q, cfg) {
  const w = p.waiting.get(q.id);
  const also = q.res.filter(r => !w.headline.endsWith(named(cfg, r).queue)).map(r => named(cfg, r).the);
  const start = startPhrase(w);
  return [`You're ${lower(w.headline)}${q.purpose ? ` ("${q.purpose}")` : ''}${also.length ? `, and you also need ${andList(also)}` : ''}.`
    + ` ${start.startsWith('start') ? 'Start time unknown' : `Starts ${start}`}.`,
    `  ${w.startsText === 'now' ? "It's about to start" : `Waiting for ${w.waitingFor}`}.${w.advice ? ` ${w.advice}.` : ''}`,
    // Why it can't start next to the jobs filling its queue (src/overlap.mjs), when that was tried.
    ...(p.rules.get(q.id)?.alongside ? [`  ${p.rules.get(q.id).alongside}`] : []),
    // How far it moved is in --detail and moves[].amount; the cause is what a person needs.
    ...w.moves.map(m => `  Moved ${m.dir === 'up' ? 'ahead' : 'back'} because ${m.reason}.`)];
}
