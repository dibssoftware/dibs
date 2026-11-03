// Getting in line and waiting for a turn. Shared by `dibs run` and `dibs hold`.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resCfg, machine, paths, HOME, loadConfig } from './config.mjs';
import { identity, pstart, tag } from './proc.mjs';
import { processes, parent, OS } from './platform.mjs';
import { withState, history, KEEP_PLACE } from './state.mjs';
import { preempt } from './preempt.mjs';
import { isFiles, short, shellRes, projectKey } from './files.mjs';
import { jobSize } from './simpool.mjs';
import { sized, grewLine, grewPlain, treeOf } from './measure.mjs';
import { isQuota, quotaProblem, quotaBlock, takeQuota } from './quota.mjs';
import { capWaiter } from './override.mjs';
import { verdict, forecast, expected, remaining, byRank, holdingOf, PRIORITY_SHIFT, PRIORITIES, NEEDS_REASON, used, overBy, STALL, neverFits, explicitAsk, capToMachine } from './schedule.mjs';
import { event } from './events.mjs';
import { startLine } from './overlap.mjs';
import { dur, clock, die, say, sleep, now, ms, gb, SIGNALS, signalExit, KEY_SPLIT, noSpace, OFF_LIMITS, callerPid } from './util.mjs';
import { plainBoard, startPhrase, askFirst, named, andList, lower, ordinal, moves, stuckFor, STUCK_AFTER } from './plain.mjs';
import { quoted, wrap, width } from './style.mjs';
import { noticeScan } from './notices.mjs';
import { notify } from './talk.mjs';
import { mayShip, loadShipTarget } from './remote.mjs';

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'dibs.mjs');

// How long dibs run waits in line outside Claude Code, where nothing moves a
// long call to the background and the tool may kill it.
const DEFAULT_MAX_WAIT = 8 * 6e4;

export const POLL = 1500;
// A wait past its first minute checks less often, unless the state file
// changes (a job ends, someone joins or leaves the line): then it checks at
// the next POLL as before. What only the machine's readings change (swap,
// disk) is seen within QUIET_POLL. Dozens of waiters polling every 1.5 s for
// an hour kept the CPU and their own heaps busy.
const QUIET_AFTER = 6e4;
const QUIET_POLL = 5e3;
const stateTime = () => { try { return fs.statSync(paths.state).mtimeMs; } catch { return 0; } };
async function nextPoll(started) {
  const since = now(), was = stateTime();
  do await sleep(POLL);
  while (now() - started > QUIET_AFTER && now() - since < QUIET_POLL && stateTime() === was);
}
// A full disk seldom clears in seconds. Backing off to this keeps a line of
// waiters from retrying it constantly, and still starts soon after space is back.
const FULL_POLL_MAX = 15e3;
// With nothing new to say, a waiter hears from dibs this often: often enough
// to know it's alive, rare enough not to fill an agent's log.
const REPEAT_STATUS = 2 * 6e4;
// A new kind of wait is said once it has held for this many polls in a row
// (3 seconds): memory pressure and an over-budget reading take turns every
// few seconds in one crunch, and each turn used to print a line.
const STEADY = 3;
// A change of place is said at most this often, so a busy line doesn't print every start.
const MOVE_EVERY = 30e3;
const IDLE_AFTER = 5 * 6e4;
const HOLD_FOR = 20 * 6e4;        // a hold's length when --for doesn't say
export const HOLD_CAP = 60 * 6e4; // the most --for gets, and the most a hold lasts from its start while others wait
export const holdUntil = o => now() + Math.min(o.for ?? HOLD_FOR, HOLD_CAP);

const on = v => /^(1|true|yes|on)$/i.test(v || '');
// Claude Code doesn't kill a Bash command at its timeout: it moves it to the
// background and tells the agent when it exits ("Foreground commands that move
// to the background" in its tools reference). So a wait there needs no limit,
// unless background tasks are off (that setting, or bare mode). CLAUDECODE is
// also set in IDE terminals; CLAUDE_CODE_CHILD_SESSION only in the tool's own.
export const backgroundable = (env = process.env) =>
  env.CLAUDE_CODE_CHILD_SESSION === '1' && !on(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) && !on(env.CLAUDE_CODE_SIMPLE);
// How long a wait lasts when no flag says: forever where nothing kills it, else
// short enough for a tool call. DIBS_MAX_WAIT lets tests shorten the limit.
export const defaultMaxWait = () =>
  backgroundable() ? Infinity : process.env.DIBS_MAX_WAIT ? ms(process.env.DIBS_MAX_WAIT) : DEFAULT_MAX_WAIT;

// Said once, when the wait starts, so nobody has to guess what happens at the end of it.
function waitTerms(w) {
  if (w.maxWait === Infinity)
    return !w.info.waitSet
      ? "No time limit. If this tool call times out, Claude Code moves it to the background and tells you when it ends: don't run it again, or it runs twice."
      : 'No time limit (--wait).';
  return `Gives up at ${clock(w.started + w.maxWait)} if it's still waiting (exit 75: your command won't have run). To wait as long as it takes, add --wait.`;
}

// The command as the agent typed it, to paste back.
const again = () => `dibs ${quoted(process.argv.slice(2))}`;

// Note run leases whose whole process tree has used no CPU for a while. Called
// inside withState, so the first-seen time is kept between calls.
// Every process group the run spans counts: a test runner's workers split off
// into groups of their own, and a run whose own group sleeps while they work isn't idle.
// A simulator the run is using counts too (src/measure.mjs treeOf): its work runs there.
export function markIdle(s, procs) {
  const runs = s.leases.filter(l => l.kind === 'run' && l.pgid && !l.pausedAt);   // a paused job is quiet on purpose
  if (!runs.length) return;
  procs ||= processes();
  const cpu = new Map(procs.map(p => [p.pid, p.cpu]));
  for (const l of runs) {
    let used = 0;
    for (const pid of treeOf(l, s, procs)) used += cpu.get(pid) || 0;
    if (used < 1) l.idleSince ||= now();
    else delete l.idleSince;
  }
}
// Runs idle STUCK_AFTER or more while someone waits: likely orphaned, so the
// board marks them and the hook can tell their holder. Nothing is ended for them.
// Read straight off state.json too: a run lease whose idleSince is older than
// STUCK_AFTER, with a live waiter in queue.
export const stuckLeases = (s, t = now()) => (s.queue.some(q => q.pid) ? s.leases.filter(l => stuckFor(l, t)) : []);
export { STUCK_AFTER };
export const idleFor = (l, t = now()) => (l.idleSince && t - l.idleSince > IDLE_AFTER ? t - l.idleSince : 0);

export function describeLease(l, hist, t = now()) {
  const left = remaining(l, hist, t);
  const idle = idleFor(l, t);
  return `${tag(l)} for ${dur(t - l.start)}${l.purpose ? ` ("${l.purpose}")` : ''}${l.cmd ? `: ${l.cmd.slice(0, 60)}` : ' (hold)'}`
    + `${left != null ? `, ~${dur(left)} left` : ''}${idle ? `, but its command has used no CPU for ${dur(idle)}` : ''}`
    + `${overBy(l) ? `, using ${gb(l.use.mem)} of the ${gb(l.mem)} it asked for` : ''}`;
}

// Where a waiter stands, in plain words: { head, why, ask }. head says the
// place and start; why, what it's waiting for; ask, who could let it go first.
// prev: the place, line and jobs ahead when it was last said, so a move can say why.
function waitLine(s, me, v, cfg, hist, prev) {
  const t = now();
  const p = plainBoard(s, cfg, hist, t, undefined, me);
  const w = p.waiting.get(me.id);
  const eta = forecast(s, cfg, hist, t).get(me.id);
  const head = `You're ${lower(w.headline)}, ${startPhrase(w)}.`;
  let why = `Waiting for ${w.waitingFor}.${w.advice ? ` ${w.advice}.` : ''}`;
  if (me.by && eta && eta + expected(me, hist) > me.by) why += ` Your deadline, ${clock(me.by)}, is at risk.`;
  // Nobody holds a rate limit's tokens: they come back with time, so there's nobody to ask.
  return { head, why, ask: v.rule === 'quota' ? '' : askFirst(s, p, me), key: `${w.family}|${w.res}`, place: w.place, res: w.res, ahead: w.ahead,
           moved: prev && movedText(s, me, w, prev, cfg, hist, t) };
}

// What a waiter says on this poll, given its wait line: 'full' (the first
// time), 'change' (a new kind of wait that has held STEADY polls), 'moved'
// (its place changed, at most every MOVE_EVERY), 'repeat' (nothing new for
// REPEAT_STATUS) or null. One per wait; it keeps what was last said. seed is
// what save() gave, for a wait that carries on in another process (src/broker.mjs).
export function talker(seed) {
  let lastSaid = seed?.lastSaid || 0, lastKey = seed?.lastKey || '', pending = null;
  const out = { told: seed?.told ? { ...seed.told, ahead: new Set(seed.told.ahead) } : null };
  out.save = () => ({ lastSaid, lastKey, told: out.told && { ...out.told, ahead: [...out.told.ahead] } });
  out.step = (l, t = now()) => {
    pending = l.key === lastKey ? null : pending?.key === l.key ? { key: l.key, n: pending.n + 1 } : { key: l.key, n: 1 };
    let what = null;
    if (!lastSaid) what = 'full';
    else if (pending?.n >= STEADY) what = 'change';
    else if (l.moved && t - out.told.at >= MOVE_EVERY) what = 'moved';
    else if (t - lastSaid > REPEAT_STATUS) what = 'repeat';
    if (!what) return null;
    if (what !== 'repeat') out.told = { place: l.place, res: l.res, ahead: new Set(l.ahead), at: t };
    if (what === 'full' || what === 'change') { lastKey = l.key; pending = null; }
    lastSaid = t;
    return what;
  };
  return out;
}

// "moved up from 4th to 2nd in the test queue", or, losing places, who went
// ahead and why: a job sinking from 8th to 19th with no word looks broken.
export function movedText(s, me, w, prev, cfg, hist, t) {
  if (w.place == null || prev.place == null || w.res !== prev.res || w.place === prev.place) return '';
  const where = `${ordinal(prev.place)} to ${ordinal(w.place)} in ${named(cfg, w.res).queue}`;
  if (w.place < prev.place) return `moved up from ${where}.`;
  const came = w.ahead.filter(id => !prev.ahead.has(id)).map(id => s.queue.find(q => q.id === id)).filter(Boolean);
  const names = andList(came.length > 2 ? [...came.slice(0, 2).map(q => q.agent || q.who), `${came.length - 2} more`] : came.map(q => q.agent || q.who));
  const x = came[0];
  const low = me.prio === 'low' || me.prio === 'idle';
  const because = !x ? ''
    : low && !(x.prio === 'low' || x.prio === 'idle') ? `: you're ${me.prio} priority, so normal jobs that arrive later go ahead of you`
    : (() => { const m = moves(x, hist, t, cfg).find(m => m.dir === 'up'); return m ? `: ${m.reason}` : ': they ranked ahead of you'; })();
  return `moved back from ${where}${names ? `. ${names} went ahead${because}` : ''}.`;
}
// Several lines from dibs on stderr, each wrapped to fit, under one "dibs:".
export const saidText = (...lines) => `${lines.filter(Boolean).map((l, i) => wrap(`${i ? '      ' : 'dibs: '}${l}`, '        ', width(process.stderr))).join('\n')}\n`;
const said = (...lines) => process.stderr.write(saidText(...lines));

// The dibs run this process is nested in, or null. DIBS_LEASE names it, and
// its process must be one of ours: the variable alone can't borrow someone
// else's lease to skip the line.
export function outerLease() {
  const id = process.env.DIBS_LEASE;
  if (!id) return null;
  const up = new Set();
  for (let pid = callerPid(), i = 0; pid > 1 && i < 25; i++) { up.add(pid); pid = parent(pid)?.ppid; }
  // A plain read, with no lock to take, so a full disk can't stop a nested run here.
  // The state file is replaced whole, never written in place.
  let s;
  try { s = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch { return null; }
  const l = (s.leases || []).find(x => String(x.id) === id && x.kind === 'run');
  return l && up.has(l.pid) && (!l.pstart || pstart(l.pid) === l.pstart) ? l : null;
}

// What history is kept under: the program and its words that aren't flags, up
// to KEY_WORDS, each cut to its last path part so a temp folder doesn't make
// every run new. npm test and npm run lint, or a build and a test of one
// project, learn their run times and sizes apart. xcodebuild's words are
// mostly flag values, so it's keyed by its first, its scheme, its
// configuration and its actions. The first word stays where it was, before
// KEY_SPLIT, so history from before still counts (util.mjs runsOf).
const KEY_WORDS = 3;   // enough for npm run lint or node --test a.test.mjs b.test.mjs; more and a message or file list makes every run new
const XCODE_ACTIONS = new Set(['build', 'build-for-testing', 'test', 'test-without-building', 'analyze', 'archive', 'docbuild', 'install', 'installsrc', 'clean']);
export function commandKey(cmd) {
  const word = a => path.basename(a).slice(0, 40);
  const prog = path.basename(cmd[0]);
  const bare = cmd.slice(1).filter(a => !a.startsWith('-')).map(word);
  const after = f => { const i = cmd.indexOf(f); return i > 0 && cmd[i + 1] ? word(cmd[i + 1]) : null; };
  const more = (prog === 'xcodebuild'
    ? [after('-scheme'), after('-configuration'), ...cmd.slice(1).filter(a => XCODE_ACTIONS.has(a))]
    : bare.slice(1, KEY_WORDS)).filter(Boolean);
  const first = [prog, bare[0]].filter(Boolean).join(' ');
  return more.length ? `${first}${KEY_SPLIT}${more.join(' ')}` : first;
}


// Where a waiter's messages go. Here, stderr; a waiter of another process
// passes its own (src/broker.mjs), so one step serves both.
export const stderrOut = { say, said, raw: text => process.stderr.write(text), die, exit: code => process.exit(code) };

// One wait, between polls: what the request asked for that its queue entry
// doesn't keep (info), and what has been said so far. me is the entry. A thin
// waiter's info is its entry's wake, which carries on where its _enqueue left
// off (maxWait Infinity is null there, as JSON has no Infinity).
export function waiter(info, cfg, hist, out) {
  return { info, cfg, hist, out, me: null, started: info.started, maxWait: info.maxWait ?? Infinity, talk: talker(info.talk),
           blocked: !!info.blocked, warnedHolding: !!info.warnedHolding, saidAhead: !!info.saidAhead, full: false };
}

// A wait is recorded once it's blocked. One that ends any way but starting or
// timing out (a signal, a full disk, the owner) is closed in the history too,
// or dibs history would miss the waits agents gave up on.
const note = (w, what, extra) => event({ kind: what, id: w.me.id, res: w.me.res, who: w.me.who, prio: w.me.prio || 'normal', type: w.me.kind, ...extra });
const left = (w, why) => { if (w.blocked) note(w, 'left', { ms: now() - w.me.enq, why }); };

// On a full disk the place stays on record under this pid, and the next
// state read drops it once this process is gone.
function leave(w, keep) {
  try {
    withState(s => {
      const q = s.queue.find(x => x.id === w.me.id);
      if (keep && q) Object.assign(q, { pid: null, keepUntil: now() + KEEP_PLACE });
      else s.queue = s.queue.filter(x => x.id !== w.me.id);
    });
  } catch (e) { if (!noSpace(e)) throw e; }
}

// A wait ended from outside it: leaves the line, closes it in the history, says why.
export function abandon(w, why, code, text) {
  left(w, why);
  leave(w, false);
  return w.out.die(text, code);
}

// A disk too full to save the state is waited out like any low-disk wait,
// until the wait limit (exit 74). Called each time a save fails.
export function full(w) {
  const free = machine().diskFree;
  const room = free != null ? ` (${gb(free).replace(/G$/, ' GB')} free)` : '';
  if (now() - w.started >= w.maxWait) {
    left(w, 'disk full');
    return w.out.die(`the disk is still too full for dibs to save its state${room}.`
      + ` Your command did NOT run (exit 74). Free some disk space, then run it again:\n      ${w.info.again}\n      ${OFF_LIMITS}`, 74);
  }
  if (!w.full) {
    w.full = true;
    w.out.said(`the disk is too full for dibs to save your place in line${room}. Waiting for space and trying again.`,
      w.maxWait === Infinity ? 'No time limit.' : `Gives up at ${clock(w.started + w.maxWait)} if the disk is still full (exit 74: your command won't have run).`);
  }
}

// withState, retried less often the longer the disk stays full.
async function saved(w, fn) {
  for (let pause = POLL; ; pause = Math.min(pause * 2, FULL_POLL_MAX)) {
    try {
      const out = withState(fn);
      if (w.full) { w.full = false; say("there's disk space again; back in line."); }
      return out;
    } catch (e) { if (!noSpace(e)) throw e; }
    full(w);
    await sleep(pause);
  }
}

// One poll's part under the state lock: leave if the owner took this wait out
// of line, take the lease if the gates allow, else work out why not.
// Its size again from what its command has used, as dibs learns now: on
// 2026-10-20 nine browser runs sized when one run had read 15 GB still waited,
// two hours on, for the whole budget the new rule no longer planned.
const POLLED_EVERY = 60e3;
function resize(cur, w) {
  if (cur.sent) return;
  const base = { mem: cur.asked ?? cur.mem, cpu: cur.cpu, disk: cur.disk };
  const n = sized(base, w.hist, cur.key, w.cfg);
  if (n.mem === cur.mem && n.usual === cur.usual) return;
  cur.mem = n.mem;
  if (n.usual != null) cur.usual = n.usual; else delete cur.usual;
  Object.assign(w.info.size, { mem: n.mem, usual: n.usual });
}
export function decide(s, w) {
  const { me, cfg, hist, info } = w;
  const cur = s.queue.find(x => x.id === me.id) || me;
  if (cur.ownerStop) { s.queue = s.queue.filter(x => x.id !== me.id); return { stopped: true, by: cur.stopBy, reason: cur.stopReason }; }
  // Kept current here, so it lapses when the hold ages out or ends.
  const holding = holdingOf(s, cur, cfg);
  if (holding) cur.holding = holding; else delete cur.holding;
  resize(cur, w);
  // When its dibs last looked, so the board can tell a waiter that could start from one nobody
  // is deciding for. Once a minute at most: a poll that changes nothing leaves the state file alone.
  if (!(now() - (cur.polledAt || 0) < POLLED_EVERY)) cur.polledAt = now();
  let v = verdict(s, cur, cfg, hist);
  // A rate limit that would stop it anyway is checked before pausing anyone for it.
  if (!v.ok && v.rule === 'slot') v = quotaBlock(s, cur, cfg, hist) || preempt(s, cur, cfg, hist) || v;
  if (v.ok) v = quotaBlock(s, cur, cfg, hist) || v;
  // What held it and for how long, for its start event: on 2026-10-24 a 2-second test waited
  // 3 minutes with 11 GB of disk free, and the log said only that it waited. Kept in the
  // waiter's memory, so a poll that changes nothing still leaves the state file alone.
  const t = now();
  if (w.heldRule) w.heldBy = { ...w.heldBy, [w.heldRule]: (w.heldBy?.[w.heldRule] || 0) + t - w.heldAt };
  w.heldRule = v.ok ? null : v.rule || 'other';
  w.heldAt = t;
  // For the stall breaker (schedule.mjs): whether the machine, not the line, holds this one back.
  if (!v.ok && v.machine) cur.machineHeld = true; else delete cur.machineHeld;
  // When the load ceiling alone started holding it: after LOAD_STARVE it starts anyway (schedule.mjs).
  if (!v.ok && v.rule === 'load') cur.loadSince ??= v.since; else if (!v.ok) delete cur.loadSince;
  // And when the machine started holding it (any of HELD_BY), for step's move to an on-demand
  // machine. One clock for all: a crunch flips between load, memory and swap.
  if (machineHold(v)) v.shipSince = cur.shipSince ??= now(); else delete cur.shipSince;
  // Waiting its turn in line: how long until it starts here, at most once per SHIP_EVERY
  // (the forecast walks the whole queue), for step's choice to send it elsewhere.
  if (!v.ok && LINE_WAITS.has(v.rule) && now() - (w.forecastAt || 0) >= SHIP_EVERY) {
    w.forecastAt = now();
    const at = forecast(s, cfg, hist).get(cur.id);
    if (at != null) v.wait = at - now();
  }
  // Bigger than this machine's budget, lowered since it joined: asked for in so
  // many words, it would wait forever, so it leaves the line and says why. A
  // size dibs chose is booked down to what the machine hands out instead.
  const never = !v.ok && neverFits(cfg, cur) && neverFits(cfg, explicitAsk(cur));
  if (never) { s.queue = s.queue.filter(x => x.id !== me.id); return { never }; }
  // The lease is made from info.size, so it's booked down too.
  if (!v.ok && neverFits(cfg, cur) && capToMachine(cfg, cur)) Object.assign(info.size, { mem: cur.mem, cpu: cur.cpu });
  if (!v.ok) {
    // Sitting on one resource while waiting for another wastes it for everyone.
    // A file lease doesn't count: it keeps edits off files while you work, and a job waiting for a test slot doesn't change that.
    const sitting = s.leases.filter(l => l.kind === 'hold' && me.spid && l.pid === me.spid && !l.res.some(x => me.res.includes(x)) && !l.res.every(isFiles));
    return { v, line: waitLine(s, cur, v, cfg, hist, w.talk.told), idle: !s.leases.length, sitting, holding: cur.holding };
  }
  s.queue = s.queue.filter(x => x.id !== me.id);
  takeQuota(s, cur, cfg);
  const lease = { id: me.id, res: me.res, ...info.size, kind: me.kind, who: me.who, agent: me.agent, label: me.label, spid: me.spid,
                  purpose: cur.purpose, cmd: me.cmd, key: me.key, est: info.est, prio: cur.prio, by: cur.by,
                  cwd: info.cwd, ppid: info.ppid, start: now(), waited: now() - cur.enq, agentId: info.agentId, sessionId: info.sessionId,
                  owner: cur.owner, askedPrio: cur.askedPrio };
  if (w.heldBy) lease.held = Object.fromEntries(Object.entries(w.heldBy).map(([k, x]) => [k, Math.round(x)]));
  if (v.covered.length) lease.covered = v.covered;
  if (v.alongside) lease.alongside = v.alongside;
  if (v.trial) lease.trial = true;
  if (cur.repo) lease.repo = cur.repo;
  if (v.loadPast) Object.assign(lease, { loadPast: true, loadWaited: v.loadWaited });
  // The stall breaker's clock (schedule.mjs) runs from the last start the gates allowed.
  if (v.breaker) lease.breaker = true;
  else if (v.gated && me.kind === 'run') { lease.gated = true; s.lastStart = lease.start; }
  if (cur.outer) lease.outer = cur.outer;
  if (cur.requeues) lease.requeues = cur.requeues;   // stopped before for using far more than it booked (src/preempt.mjs)
  if (cur.disk) lease.disk = cur.disk;   // its share of the disk's fall is weighed by it (src/measure.mjs shareDisk)
  if (me.kind === 'hold') Object.assign(lease, { pid: me.spid, pstart: info.sstart, expires: holdUntil(info) });
  else Object.assign(lease, { pid: me.pid, pstart: me.pstart });
  // A thin hold's shell becomes the dibs hold that reports it (hold --lease).
  if (info.path) lease.shell = me.pid;
  s.leases.push(lease);
  return { lease, paused: v.paused };
}

// The rest of a poll, after the lock: what to say, and whether the wait ends.
// Returns { lease } on this waiter's turn, null to poll again. An ending goes
// through w.out (exit 74, 75, or the owner's stop).
export function step(r, w) {
  const { me, cfg, out } = w;
  if (r.stopped) {
    left(w, 'owner stop');
    return out.die(`stopped by ${r.by || 'the owner (the person at this machine)'} on purpose (dibs stop)${r.reason ? `: "${r.reason}"` : ''}. This was taken out of line and your command did not run.`
      + `${r.reason ? '' : ' Find out why before trying again: dibs history, or ask whoever stopped it.'}`, signalExit('SIGTERM'));
  }
  if (r.never) {
    left(w, 'never fits');
    const text = neverText(r.never, me, cfg, null);
    // Through the hook too: an agent that only reads its tool's result hears why its job left the line.
    notify({ sessionId: w.info.sessionId, who: me.who, agentId: w.info.agentId }, `never:${me.id}`, `#${me.id} ${text}`);
    return out.die(text, 2);
  }
  if (r.lease) {
    if (now() - w.started > 2000) out.say(`your turn, after ${dur(now() - w.started)} in the queue.`);
    if (r.lease.alongside) out.say(startLine(r.lease.alongside, cfg));
    if (r.lease.breaker) out.say(`starting although the machine is short of disk or memory: nothing had started for ${STALL / 6e4} min, so dibs lets the smallest waiter in, one at a time. The rest wait until yours ends or its memory holds steady.`);
    for (const p of r.paused || []) out.say(`paused ${p.who}'s ${p.prio} priority job on ${andList(p.res.map(x => named(cfg, x).the))} so you could start. It picks up again when you're done.`);
    return { lease: r.lease };
  }
  // A wait is a request that couldn't start at once; one that starts on its first try isn't one.
  if (!w.blocked) { w.blocked = true; note(w, 'wait', { rule: r.v.rule || 'other' }); }
  if (r.holding && !w.saidAhead) {
    w.saidAhead = true;
    out.say(`you already have ${andList(r.holding.res.map(x => named(cfg, x).the))}, so you go ahead of anyone who has nothing yet (urgent work still goes first).`);
  }
  if (w.warnedHolding && !r.sitting.length) {
    w.warnedHolding = false;
    out.say('you gave back what you were keeping, so nothing sits unused while you wait. Still in line.');
  }
  if (r.sitting.length && !w.warnedHolding) {
    w.warnedHolding = true;
    const kept = r.sitting.flatMap(l => l.res).filter(x => !isFiles(x));
    out.say(`you're keeping ${andList(kept.map(x => named(cfg, x).the))} reserved while you wait, so nobody else can use it.`
      + ` Give it back (dibs release ${kept[0]}) or ask for everything at once: dibs run ${[...new Set([...kept, ...me.res])].join(',')} -- <command>`);
  }
  // Waiting can't free disk when nothing else is running.
  if (r.v.disk && (r.idle || r.v.alone)) {
    left(w, 'not enough disk');
    leave(w, false);
    return out.die(`not enough free disk: ${gb(r.v.free).replace(/G$/, ' GB')} free, it needs ${gb(r.v.need).replace(/G$/, ' GB')}, and nothing running will free any.`
      + ` Your command did NOT run (exit 74). Free some space, or pass --disk with what this job really needs if that's less, then run it again:\n      ${w.info.again}\n      ${OFF_LIMITS}`, 74);
  }
  if (now() - w.started >= w.maxWait) {
    note(w, 'timeout', { ms: now() - me.enq });
    leave(w, w.maxWait > 0);
    if (!w.maxWait)
      return out.die(`not free yet. ${r.line.why} --no-wait doesn't wait, so your command did NOT run (exit 75).`
        + ` See when it frees up: dibs when ${shellRes(me.res.map(x => short(x)))}`, 75);
    out.said(`gave up after ${dur(now() - w.started)} in the queue. Your command did NOT run (exit 75, not a failure).`,
      r.line.head, `Your place is kept until ${clock(now() + KEEP_PLACE)}. To keep it, run the same command again before then:`);
    // The command on a line of its own, unwrapped, so it can be pasted as is.
    out.raw(`        ${w.info.again}\n`);
    out.raw(`${wrap('      Or wait as long as it takes: add --wait (in a background shell if your tool call has a time limit).', '        ', width(process.stderr))}\n`);
    return out.exit(75);
  }
  // Held by the machine SHIP_AFTER, and able to run elsewhere: try an on-demand machine (the
  // waiter's loop below does, since asking the coordinator takes a round trip).
  // A job that usually uses more than this machine's whole budget prefers a machine it fits, at once.
  const held = machineHold(r.v);
  const after = r.v.rule === 'memory' && me.usual != null ? 0 : held ? SHIP_AFTER : null;
  if (after != null && now() - (r.v.shipSince ?? now()) >= after && now() - (w.shipAt || 0) >= SHIP_EVERY && mayShip(me, cfg, w.info.cwd)) {
    w.shipAt = now();
    w.loadFrom = r.v.shipSince;
    return { ship: held };
  }
  // Its turn here is further off than sending it and running it there: it goes now.
  if (r.v.wait != null && r.v.wait > SHIP_OVERHEAD + expected(me, w.hist) && now() - (w.shipAt || 0) >= SHIP_EVERY && mayShip(me, cfg, w.info.cwd)) {
    w.shipAt = now();
    w.lineWait = r.v.wait;
    return { ship: 'line' };
  }
  // The whole picture once. After that a line when the kind of wait really
  // changes (and has held for STEADY polls), when the place moves (at most
  // every MOVE_EVERY), or now and then.
  const l = r.line;
  const what = w.talk.step(l);
  if (what === 'full') out.said(`queued for ${andList(me.res.map(x => named(cfg, x).the))}.${me.kind === 'hold' ? ' dibs hold waits for its turn like dibs run, then returns.' : ''}`, l.head, l.why, l.ask, w.maxWait > 0 ? waitTerms(w) : '');
  else if (what === 'change') out.said(`still queued (${dur(now() - w.started)}). ${l.head}`, l.why);
  else if (what === 'moved') out.say(`still queued (${dur(now() - w.started)}). You ${l.moved}`);
  else if (what === 'repeat') out.say(`still queued (${dur(now() - w.started)}). ${l.head}`);
  return null;
}

// A wait the machine causes (its load, the budgets, memory, the disk swap grows
// on, a job ahead reserving memory) moves to an on-demand machine after
// SHIP_AFTER, asking at most every SHIP_EVERY. Two minutes: by then the jobs
// ahead aren't about to finish, and waking boat-1 takes 15 to 40 s. On
// 2026-10-20 ten jobs waited on the Mac at load 48 while boat-1 sat idle.
// The 20-minute start at background priority (schedule.mjs LOAD_STARVE) is
// the fallback when no machine will take it.
const SHIP_AFTER = (Number(process.env.DIBS_SHIP_AFTER) * 1000) || 2 * 6e4, SHIP_EVERY = 6e4;
// Waits that are the line's, not the machine's: whose length the forecast knows.
const LINE_WAITS = new Set(['slot', 'ahead', 'together']);
// Waking boat-1 and copying the project there: 15 to 40 s to wake, a few more to send.
const SHIP_OVERHEAD = 90e3;
const HELD_BY = {
  load: "the machine's load", cpu: 'the cores dibs shares out on this machine', memory: 'the memory dibs shares out on this machine',
  ram: "this machine's free memory", oversize: "this machine's free memory", pressure: "this machine's memory pressure",
  swap: "this machine's swapping", swaproom: 'the free disk swap needs here', drain: 'free disk falling here',
  ahead: 'a job ahead of it waiting for memory',
};
// The waits on memory: those may also go to a VM made beside a full boat-1.
// The rest go to boat-1 only when it has room.
const MEMORY_HELD = new Set(['memory', 'ram', 'oversize', 'pressure', 'swap']);
// Its reason, when the machine is what holds it, else null.
const machineHold = v => (v.ok ? null : v.rule === 'ahead' ? (v.starved ? 'ahead' : null) : HELD_BY[v.rule] ? v.rule : null);
// Give up this place and run the same command with --on <machine>, as this
// same process where Node allows it (src/commands.mjs runAgain does the same):
// remoteRun checks the project's rules and the home folder again and sends it.
function shipTo(w, to, bail, why = 'load') {
  left(w, 'sent to ' + to);
  leave(w, false);
  for (const sig of SIGNALS) process.removeListener(sig, bail);
  w.out.say(why === 'line'
    ? `its turn here is about ${dur(w.lineWait)} off, longer than sending it and running it there, so it goes to ${to}, an on-demand machine with room.`
    : `${HELD_BY[why] || HELD_BY.load} has held this job for ${dur(now() - (w.loadFrom ?? w.started))}, so it goes to ${to}, an on-demand machine with room, instead of waiting here.`);
  const args = process.argv.slice(2);
  const dd = args.indexOf('--');
  args.splice(dd < 0 ? args.length : dd, 0, '--on', to);
  if (process.execve && OS !== 'windows') process.execve('/bin/sh', ['/bin/sh', BIN, ...args], process.env);
  const child = spawn(process.execPath, [BIN, ...args], { stdio: 'inherit' });
  for (const sig of SIGNALS) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, sig) => process.exit(code ?? signalExit(sig)));
  return new Promise(() => {});
}

const codeNow = () => { try { return fs.readFileSync(path.join(path.dirname(BIN), '..', 'src', 'version.mjs'), 'utf8'); } catch { return null; } };
// Keep this place and run the same command again, as this same process where Node allows it.
function rerun(w, bail) {
  leave(w, true);
  w.out.say('dibs was updated while this waited, so it carries on as the new dibs, in the same place.');
  for (const sig of SIGNALS) process.removeListener(sig, bail);
  const args = process.argv.slice(2);
  if (process.execve && OS !== 'windows') process.execve('/bin/sh', ['/bin/sh', BIN, ...args], process.env);
  const child = spawn(process.execPath, [BIN, ...args], { stdio: 'inherit' });
  for (const sig of SIGNALS) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, sig) => process.exit(code ?? signalExit(sig)));
  return new Promise(() => {});
}

// A thin waiter's turn (src/thin.sh): the broker wrote this lease for the
// shell, which has since become this process, with the same pid and start time.
function ownLease(id, kind) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch {}
  const l = (s.leases || []).find(x => x.id === id && (kind === 'run' ? x.pid : x.shell) === process.pid);
  if (!l) die('your turn was taken back before your command started, so it did NOT run (exit 75). Run it again.', 75);
  return l;
}

// o.thin: getting a thin waiter in line for its shell (src/broker.mjs
// thinCall), which waits once this hands it over. o.lease: that shell's turn.
const configAt = () => { try { return fs.statSync(paths.config).mtimeMs; } catch { return 0; } };
// The config as it is now, or null while it's half written (someone saving it).
function freshConfig() {
  try { JSON.parse(fs.readFileSync(paths.config, 'utf8')); return loadConfig(); } catch { return null; }
}

// A job that asks for more than this machine ever hands out: what to say.
// others: machines in the group with a budget it fits, when known.
export function neverText(nf, me, cfg, others) {
  const where = others == null ? (remoteConfigured() ? ' Or send it to a machine in your group with room for it: --anywhere, or --on <machine> (dibs machines lists them).' : '')
    : others.length ? ` Or send it where it fits: --on ${others[0]}${others.length > 1 ? ` (${others.slice(1).join(', ')} would fit too)` : ''}, or --anywhere.` : '';
  return `this job books ${nf.unit(nf.need)} of ${nf.what}, and dibs hands out at most ${nf.unit(nf.most)} at once on this machine`
    + ` (${nf.whole ? 'all the machine has' : `${nf.what === 'memory' ? 'budget' : 'cores'} in ~/.dibs/config.json`}), so it could never start here. Your command did not run (exit 2).`
    + ` Ask for ${nf.flag} ${nf.unit(nf.most)} or less.${where}`;
}
const remoteConfigured = () => fs.existsSync(path.join(HOME, 'remote.json'));

// Machines in the group whose budget the job fits, or null if the coordinator
// can't say in time. Asked only when a job is refused, so plain runs never wait on the network.
async function fitsElsewhere(need) {
  if (!remoteConfigured()) return [];
  try {
    const { remoteConf, call } = await import('./remote.mjs');
    const rc = remoteConf(() => null);
    if (!rc) return [];
    const r = await call(rc, 'GET', '/machines', undefined, { timeout: ELSEWHERE_WAIT });
    return r.machines.filter(m => !m.lost && m.name !== rc.name && (m.board?.memBudget ?? m.memTotal ?? 0) >= need.mem && (m.board?.cores ?? m.cores ?? 0) >= need.cpu).map(m => m.name);
  } catch { return null; }
}
// Plain dibs gives other machines 1.5 s (AGENTS.md); a refusal can afford as much.
const ELSEWHERE_WAIT = 1500;

export async function acquire(o, kind, cfg) {
  if (o.lease) return ownLease(o.lease, kind);
  if (!o.res.length) die('which resource? Name it, like dibs hold sim. The list: dibs help all');
  if (o.prio && !(o.prio in PRIORITY_SHIFT)) die(`priority is one of ${PRIORITIES.join(', ')} (or 1-5)`);
  if (NEEDS_REASON.has(o.prio) && !o.purpose) die(`${o.prio} priority needs a reason everyone can see: -m "why"`);
  const id = identity(o);
  const res = [...new Set(o.res)];
  const cmd = o.cmd ? o.cmd.join(' ') : '';
  // A shard's runs are a part of the suite's: learned apart, so the whole suite's time stays its own (src/shard.mjs).
  const key = `${res.join(',')}|${kind === 'hold' ? 'hold' : commandKey(o.cmd)}${process.env.DIBS_SHARD ? ' (shard)' : ''}`;
  const hist = history();
  // Planned at what this command really used last time, when that's more than it asked for.
  const sent = !!process.env.DIBS_REMOTE_JOB;
  const size = { ...sized(jobSize(cfg, res, o), hist, key, cfg), sent, declared: o.mem != null, cpuDeclared: o.cpu != null, ...(o.disk != null && { diskDeclared: true }) };
  // More than this machine ever hands out, asked for in so many words: it would
  // wait forever, and as the oldest waiter hold others back. Refused now, unless
  // an outer run or hold already has the resources (it runs inside what that
  // reserved). A size dibs chose is booked at what the machine hands out instead.
  const outer = 'outer' in o ? o.outer : outerLease();
  const nested = !!outer && res.every(r => outer.res?.includes(r));
  const never = !nested && neverFits(cfg, explicitAsk(size));
  if (never) die(neverText(never, null, cfg, await fitsElsewhere(explicitAsk(size))));
  if (!nested) capToMachine(cfg, size);
  const { mem, cpu, disk, asked, askedCpu, usual } = size;
  const grew = grewPlain({ mem, cpu, asked, askedCpu, usual }, key.split('|')[1]);
  // Booked at what it really used, not at its ask: dibs's own bookkeeping. It's
  // said on the run's own output and kept in the history, not sent through the
  // hook: on 2026-11-03 these were 6 of 35 notices, and agents called them noise.
  if (grew) {
    say(grew);
    event({ kind: 'sized', key, who: id.who, mem, cpu, ...(asked != null && { asked }), ...(askedCpu != null && { askedCpu }), ...(usual != null && { usual }) });
  }
  // Running the same request again soon after a timed-out wait keeps your place.
  const ticket = `${id.spid || id.who}|${res.join(',')}|${cmd}`;
  const maxWait = o.maxWait ?? defaultMaxWait();
  const pid = o.thin?.shell ?? process.pid;
  const myStart = pstart(pid);

  const quotaWrong = quotaProblem(cfg, res, o.cost);
  if (quotaWrong) die(quotaWrong);
  const unknown = res.filter(r => !isQuota(r) && !isFiles(r) && !cfg.resources[r] && !hist.some(h => h.key.split('|')[0].split(',').includes(r)));
  if (unknown.length)
    said(`note: ${unknown.join(', ')} isn't a resource dibs knows, so this starts a new queue for it: one job at a time, planned at ${resCfg(cfg, unknown[0]).mem} of memory.`
      + ` Known: ${Object.keys(cfg.resources).join(', ')}. Use the same name as the other agents, or you'll each have your own queue for one thing.`);
  if (machine().diskFree == null) say("couldn't read free disk space, so the disk check is off for this request.");

  const started = now();
  const w = waiter({ started, maxWait, waitSet: o.maxWait != null, for: o.for, est: o.est, agentId: o.agentId, sessionId: process.env.CLAUDE_CODE_SESSION_ID,
                     cwd: process.cwd(), ppid: callerPid(), sstart: id.sstart, size: { mem, cpu, asked, askedCpu, usual }, again: again(), path: o.thin?.fifo,
                     notify: o.notify ? path.resolve(o.notify) : undefined, follow: process.env.DIBS_REMOTE_JOB ? { pid: callerPid(), pstart: pstart(callerPid()) } : undefined }, cfg, hist, stderrOut);
  // A signal while getting in line is held until there's a place to give up,
  // instead of killing this process with its place still on record.
  let early = null;
  // On a full disk the place isn't saved yet, so there's nothing to give up: go at once.
  const hold = sig => { early ||= sig; if (w.full) process.exit(signalExit(sig)); };
  for (const sig of SIGNALS) process.on(sig, hold);
  w.me = await saved(w, s => {
    // Only a place someone left behind can be picked up again, never a live waiter's.
    let q = s.queue.find(x => x.ticket === ticket && !x.pid);
    if (q) { Object.assign(q, { pid, pstart: myStart, keepUntil: null }); delete q.wake; delete q.keptFor; }
    else {
      q = { id: ++s.seq, ticket, res, mem, cpu, disk, asked, askedCpu, usual, pid, pstart: myStart, enq: now(), polledAt: now(),
            who: id.who, agent: id.agent, label: id.label, spid: id.spid, purpose: o.purpose || '', cmd, key, kind,
            agentId: o.agentId, sessionId: process.env.CLAUDE_CODE_SESSION_ID, cwd: process.cwd(), ppid: callerPid(),
            // Its project, for resources one at a time per project (deploys): a job sent from another machine
            // carries its sender's (DIBS_REPO, src/worker.mjs), since its copy here has no .git.
            repo: process.env.DIBS_REPO || projectKey(process.cwd()) };
      if (outer) q.outer = outer.id;
      if (sent) q.sent = true;   // placed here by the coordinator for its size (neverFits)
      s.queue.push(q);
    }
    // Without -m, a wait for the rest of what a ship needs says what the ship is for.
    if (!q.purpose) q.purpose = holdingOf(s, q, cfg)?.purpose || '';
    if (o.prio && !q.owner) q.prio = o.prio;   // a place picked up again keeps the owner's word on it
    capWaiter(s, q);
    if (o.by) q.by = o.by;
    if (o.est) q.est = o.est;
    if (o.cost != null) q.cost = o.cost;
    if (o.mem != null) q.declared = true;   // a size to go on before dibs has measured it (src/overlap.mjs)
    if (o.cpu != null) q.cpuDeclared = true;   // asked for in so many words, which alone can make it never fit (neverFits)
    if (o.disk != null) q.diskDeclared = true;   // its own word on the disk it writes beats what earlier runs seemed to eat
    return { ...q };
  });
  const me = w.me;

  if (me.owner?.act === 'cap') say(`the person at this machine capped ${me.agent || me.who}'s work at ${me.prio} priority, so this waits and runs at ${me.prio}, not ${me.askedPrio}.`);

  const bail = sig => { left(w, sig); leave(w, false); process.exit(signalExit(sig)); };
  for (const sig of SIGNALS) { process.removeListener(sig, hold); process.on(sig, bail); }
  if (early) bail(early);

  let cfgAt = configAt(), first = true;
  const code = codeNow();
  for (;;) {
    // A release changed the code: this wait carries on as the new dibs, in its
    // place, as a thin waiter's broker does (src/broker.mjs). On 2026-10-20
    // waiters started before 0.0.134 kept judging memory by the old rules for
    // hours, while every fix went out.
    if (code && codeNow() !== code) return rerun(w, bail);
    // The first look skips reading the process table (ps, 30 to 60 ms on a busy Mac,
    // twice for a thin wait): it's for marking idle runs and noticing stuck ones, which
    // matter to a job that waits, and a job that can start now doesn't. The next poll does both.
    const alone = first;
    first = false;
    if (!alone) {
      processes();   // read the process table before taking the lock, not while holding it
      noticeScan();   // a waiter is who notices a job ahead of it is stuck: tell that job's agent (src/notices.mjs)
    }
    // A budget changed while this waits counts, as it does for the broker's waiters.
    const at = configAt();
    if (at !== cfgAt) { cfgAt = at; w.cfg = freshConfig() || w.cfg; }
    const r = await saved(w, s => { if (!alone) markIdle(s); return decide(s, w); });
    const x = step(r, w);
    if (x?.ship) {
      // A thin call can't wait on the coordinator: the shell waits in Node instead, keeping its place, and asks there.
      // One already in Node (src/broker.mjs inlineCall) just carries on here.
      if (o.thin?.inline) o.thin = null;
      if (o.thin) return o.thin.fat();
      const to = await loadShipTarget(me, cfg, w.info.cwd, { temp: MEMORY_HELD.has(x.ship) });
      if (to) return shipTo(w, to, bail, x.ship);
    } else if (x) {
      for (const sig of SIGNALS) process.removeListener(sig, bail);
      if (o.thin) o.thin.go(x.lease);
      return x.lease;
    }
    if (o.thin) {
      const r = o.thin.wait(w);
      if (r !== 'stay') return r;
      o.thin = null;   // couldn't go back to the shell: wait here, in Node
    }
    await nextPoll(started);
  }
}
