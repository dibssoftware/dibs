// Overrides: "this one matters more" (boost), "not now" (pause, resume),
// "stop that" (stop) and "this agent never gets above low" (cap). The person
// runs them, and so may any agent, on any job. Each one names who did it
// (src/owner.mjs actor), on the job for the board and in the event log, so
// the person can see which agent did what.
//
// What was changed is kept on the waiter or lease itself, so the board
// can say so and cap off can undo it:
//   owner       { act: 'boost' | 'cap', prio, at, by?, reason? }: by is the
//               agent that did it (none: the person)
//   askedPrio   the priority the agent asked for, before the owner changed it
//   ownerStop   when it was stopped; its dibs process says so and exits
//   stopBy      the agent that stopped it (none: the person)
//   s.caps      { <agent>: { prio, at, by? } }
// An owner pause is an { owner, by? } entry in lease.pauses (src/preempt.mjs),
// so it ends with the lease like any other pause.
import { spawnSync } from 'node:child_process';
import { resCfg } from './config.mjs';
import { tag, makeAlive, identity, isMine } from './proc.mjs';
import { descendants, processes, pidsIn, stopTree, lower, raise, OS } from './platform.mjs';
import { withState, history } from './state.mjs';
import { ownerPause, pauseLabel } from './preempt.mjs';
import { PRIORITIES, BACKGROUND, NEEDS_REASON, priority, byRank } from './schedule.mjs';
import { actor } from './owner.mjs';
import { event } from './events.mjs';
import { die, now } from './util.mjs';
import { takeAgent, callKey } from './files.mjs';
import { quoted } from './style.mjs';

const rankOf = p => PRIORITIES.indexOf(p || 'normal');
const USAGE = {
  boost: 'dibs boost <id or agent> <urgent|high|normal|low|idle> [-m "why"] [--owner <session>]',
  pause: 'dibs pause <id> [--force] [-m "why"] [--owner <session>]',
  resume: 'dibs resume <id> [-m "why"] [--owner <session>]',
  stop: 'dibs stop <id> [-m "why"] [--owner <session>]',
  cap: 'dibs cap <agent> <urgent|high|normal|low|idle|off>',
};
const IDS = 'Ids are the #numbers on the board (dibs), or "id" in dibs --json.';

// History's event log gets one "override" event per change, naming who made
// it: by is the agent's session name, or 'the person'.
const recordAll = (act, changes, who, reason = '') => {
  for (const c of changes) event({ kind: 'override', act, ...c, by: who.name, byAgent: who.agent, ...(who.via && { via: who.via }), ...(reason && { reason }) });
};
// What goes on the job: the agent's name, the person's paired browser, or nothing for the person here.
const byOf = who => (who.agent || who.via ? { by: who.name } : {});

function argsOf(verb, args, flags = []) {
  const o = args.indexOf('--owner');
  let owner = null;
  if (o >= 0) {
    if (!args[o + 1] || args[o + 1].startsWith('-')) die(`--owner needs the job's owner: its session, or session/agent, as the board shows it. Use: ${USAGE[verb] || verb}`);
    owner = args[o + 1];
    args = [...args.slice(0, o), ...args.slice(o + 2)];
  }
  const parsed = argsOf1(verb, args, flags);
  return { ...parsed, owner };
}
function argsOf1(verb, args, flags = []) {
  const m = args.findIndex(a => a === '-m' || a === '--msg');
  let reason = '';
  if (m >= 0) {
    if (args[m + 1] == null) die(`-m needs a reason everyone can see: -m "why". Use: ${USAGE[verb]}`);
    reason = args[m + 1].trim();
    args = [...args.slice(0, m), ...args.slice(m + 2)];
  }
  const bad = args.find(a => a.startsWith('-') && !flags.includes(a));
  if (bad) die(`unknown flag ${bad}. Use: ${USAGE[verb]}`);
  return { words: args.filter(a => !a.startsWith('-')), flags: new Set(args.filter(a => flags.includes(a))), reason };
}

function prioArg(verb, p) {
  const prio = priority(p);
  if (!PRIORITIES.includes(prio)) die(`priority is one of ${PRIORITIES.join(', ')} (or 1-5). Use: ${USAGE[verb]}`);
  return prio;
}

const byName = name => x => x.agent === name || x.who === name;

// Whose a job is, as --owner names it: its session, then /agent for a subagent's.
export const ownerOf = x => `${x.agent || x.who}${x.label ? `/${x.label}` : ''}`;
// The calling agent: its session, and the subagent the guard hook saw make this
// call (src/files.mjs takeAgent), so siblings in one session aren't each other.
function caller(verb) {
  const a = takeAgent(verb, [], callKey(verb));
  return { ...identity({ as: a?.agentType || undefined }), agentId: a?.agentId || null };
}
// Its own: the same session, and the same subagent when either side was stamped
// (else the same label). An unstamped job of an older dibs needs --owner from
// a stamped caller: refusing too often is the safe side of this.
const own = (x, me) => isMine(x, me) && (x.agentId || me.agentId ? x.agentId === me.agentId : (x.label || '') === (me.label || ''));
// A job that isn't the calling agent's own takes --owner naming it, or nothing
// changes (exit 2). An id typed from memory or a board can be someone else's:
// on 2026-10-19 an agent boosted #10167 and only learned from the output whose
// it was, and crews sharing a session stopped each other's jobs. The person is
// never asked.
function notYours(verb, x, who, me, want) {
  if (!who.agent || own(x, me)) return null;
  if (want && (want === ownerOf(x) || want === (x.agent || x.who))) return null;
  return `#${x.id} is ${ownerOf(x)}'s ${x.res.join(',')} job${x.purpose ? ` ("${x.purpose}")` : ''}${want ? `, not ${want}'s` : ', not yours'}. Nothing changed.`
    + ` If you meant it: dibs ${quoted([verb, ...process.argv.slice(3).filter((a, i, all) => a !== '--owner' && all[i - 1] !== '--owner')])} --owner ${ownerOf(x)}`;
}
// The first line names whose job it is, before anything else is said about it.
const naming = (verbing, x) => `${verbing} #${x.id}: ${ownerOf(x)} ${x.res.join(',')}${x.purpose ? ` '${x.purpose}'` : ''}`;
const what = (s, x) => (s.queue.includes(x) ? 'wait' : x.kind === 'hold' ? 'hold' : 'run');
const brief = (s, x) => ({ id: x.id, res: x.res, who: tag(x), kind: what(s, x) });
const out = line => console.log(line);

// The run's own process group is still the one dibs started, not a reused number.
const ours = l => !!l.pgid && (!l.pgstart || makeAlive([l.pgid])(l.pgid, l.pgstart));
// Every group a run's tree is spread over, when it's still ours.
const groupsOf = l => (ours(l) ? new Set([l.pgid, ...(l.groups || []), ...(l.stopped || []), ...descendants(l.pgid)]) : new Set());

// Set a waiter's or lease's priority on the owner's say. Back at what the agent
// asked for, nothing is left marked.
function setPrio(x, prio, act, who, reason = '') {
  delete x.agentBoost;   // 0.0.91-0.0.109's own-job boost, replaced by this
  x.askedPrio ??= x.prio || 'normal';
  x.prio = prio;
  if (prio === x.askedPrio && act === 'boost') { delete x.owner; delete x.askedPrio; }
  else x.owner = { act, prio, at: now(), ...byOf(who), ...(reason && { reason }) };
}

// A run's background QoS follows its priority: low and idle on the efficiency
// cores, the rest off them. `from` is its priority before the change (runs
// started by an older dibs don't record their QoS). Returns the pids to move,
// found under the lock; they're moved after it, since a big tree takes a while.
// Reads of the process table after a boost moves a job, for children forked meanwhile.
const CATCH_UP = 3;
function requeue(l, from) {
  if (l.kind !== 'run' || !l.pgid || OS === 'windows') return null;
  const bg = BACKGROUND.has(l.prio);
  if ((l.background ?? BACKGROUND.has(from)) === bg) return null;
  l.background = bg;
  const groups = groupsOf(l);
  return { bg, groups: [...groups], pids: processes().filter(p => groups.has(p.pgid)).map(p => p.pid) };
}

// dibs boost <id or agent> <prio>: change a waiter's or running lease's
// priority. A waiter is re-ranked; a run's preemption (src/preempt.mjs pauses
// only low and idle runs) and background QoS follow the new priority.
export function boost(args) {
  const who = actor();
  const me = caller('boost');
  const { words: [target, p], reason, owner } = argsOf('boost', args);
  if (!target || !p) die(`Use: ${USAGE.boost}. ${IDS}`);
  const prio = prioArg('boost', p);
  // Everyone sees an agent's high or urgent, and why, as they do on dibs run -p.
  if (who.agent && NEEDS_REASON.has(prio) && !reason) die(`${prio} needs a reason everyone can see: dibs boost ${target} ${prio} -m "why". Nothing changed.`);
  const hist = history();
  const r = withState(s => {
    const items = /^\d+$/.test(target) ? [...s.leases, ...s.queue].filter(x => String(x.id) === target) : [...s.leases, ...s.queue].filter(byName(target));
    for (const x of items) { const no = notYours('boost', x, who, me, owner); if (no) return { refused: no }; }
    const changes = [];
    for (const x of items) {
      const from = x.prio || 'normal';
      if (from === prio) { changes.push({ ...brief(s, x), x: { ...x }, from, same: true }); continue; }
      setPrio(x, prio, 'boost', who, reason);
      changes.push({ ...brief(s, x), x: { ...x }, from, prio, qos: s.leases.includes(x) ? requeue(x, from) : null });
    }
    const order = s.queue.filter(q => q.pid).sort(byRank(hist));
    for (const c of changes) if (c.kind === 'wait') c.place = order.findIndex(q => q.id === c.id) + 1;
    return changes;
  });
  if (r.refused) die(r.refused, 2);
  if (!r.length) die(`nothing matched ${target}: no lease or waiter with that id or agent name. ${IDS}`, 1);
  for (const c of r) {
    out(naming('boosting', c.x));
    const head = `#${c.id} ${c.who}'s ${c.res.join(',')} ${c.kind}`;
    if (c.same) { out(`${head}: already ${c.prio || c.from}`); continue; }
    let line = `${head}: ${c.from} -> ${c.prio}`;
    if (c.place) line += `, now #${c.place} in the queue`;
    if (c.qos) {
      // One that exited meanwhile has nothing left to move, a zombie its parent hasn't reaped included.
      const gone = pid => !/^[^Z]/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
      const move = pid => (c.qos.bg ? lower(pid) : raise(pid)) || gone(pid);
      const tried = new Set(c.qos.pids);
      let moved = c.qos.pids.filter(move).length;
      // A child forked between reading the process table and moving its parent kept the old
      // priority, and at background priority on a busy machine even a sleep 0.05 can last
      // seconds. The parents are moved now, so what they start next follows: a few reads catch the rest.
      for (let i = 0; i < CATCH_UP; i++) {
        const late = pidsIn(c.qos.groups).filter(pid => !tried.has(pid));
        if (!late.length) break;
        for (const pid of late) tried.add(pid);
        moved += late.filter(move).length;
      }
      line += c.qos.bg ? ', moved to background priority (efficiency cores)' : ', moved off background priority';
      if (moved < tried.size) line += ` (${tried.size - moved} of its ${tried.size} processes couldn't be moved${OS === 'linux' && !c.qos.bg ? ': Linux lets only root raise a priority' : ''})`;
    }
    if (c.kind === 'run' && BACKGROUND.has(c.prio)) line += '; urgent and high work may now pause it';
    out(line);
  }
  recordAll('boost', r.filter(c => !c.same).map(({ id, res, who, prio, from }) => ({ id, res, who, prio, from })), who, reason);
}

// Why the owner can't pause this lease, or null. Resources marked pausable:
// false (sim, xcode-build and deploy by default) stay unpaused unless --force:
// a frozen deploy, simulator or build can time out against the services it
// talks to and fail in ways a clean stop wouldn't.
function unpausable(l, cfg, force) {
  if (OS === 'windows') return `Windows can't pause a process tree (it has no SIGSTOP). dibs stop ${l.id} ends it instead.`;
  if (l.kind === 'hold') return `#${l.id} is a hold: its process is the agent's own session, and pausing that would freeze the agent. dibs stop ${l.id} releases the hold instead.`;
  if (!l.pgid) return `#${l.id} hasn't started its command yet. Try again in a moment.`;
  const fixed = l.res.filter(r => resCfg(cfg, r).pausable !== true);
  if (fixed.length && !force)
    return `${fixed.join(', ')} is marked pausable: false: a deploy, simulator or build frozen midway can time out against the services it talks to`
      + ` and fail in ways a clean stop wouldn't. Nothing changed. dibs pause ${l.id} --force freezes it anyway; dibs stop ${l.id} ends it.`;
  return null;
}

function leaseArg(verb, args, flags) {
  const a = argsOf(verb, args, flags);
  if (a.words.length !== 1 || !/^\d+$/.test(a.words[0])) die(`Use: ${USAGE[verb]}. ${IDS}`);
  return { id: a.words[0], flags: a.flags, reason: a.reason, owner: a.owner };
}
const missing = (s, id) => `no lease #${id}${s.queue.some(q => String(q.id) === id) ? ' (it\'s waiting, not running)' : ''}. ${IDS}`;

// dibs pause <id> [--force]: stop a run's tree where it stands. It keeps its
// lease and its slot until dibs resume, or until it ends.
export function pause(args, cfg) {
  const who = actor();
  const me = caller('pause');
  const { id, flags, reason, owner } = leaseArg('pause', args, ['--force']);
  const r = withState(s => {
    const l = s.leases.find(x => String(x.id) === id);
    if (!l) return { err: s.queue.some(q => String(q.id) === id) ? `#${id} is waiting, not running: there's nothing to pause yet. To hold it back, lower it: dibs boost ${id} idle` : missing(s, id), code: 1 };
    const no = notYours('pause', l, who, me, owner);
    if (no) return { err: no, code: 2 };
    out(naming('pausing', l));
    const why = unpausable(l, cfg, flags.has('--force'));
    if (why) return { err: why, code: 2 };
    if (l.pauses?.some(p => p.owner)) return { same: brief(s, l) };
    ownerPause(l, true, now(), who.agent || who.via ? who.name : null, reason);
    return { done: brief(s, l) };
  });
  if (r.err) die(r.err, r.code);
  const c = r.done || r.same;
  if (r.same) return out(`#${id} ${c.who}'s ${c.res.join(',')} run is already paused by you. dibs resume ${id} continues it.`);
  out(`paused #${id} ${c.who}'s ${c.res.join(',')} run. It keeps its lease and its slot; dibs resume ${id} continues it.`);
  recordAll('pause', [{ id: c.id, res: c.res, who: c.who }], who, reason);
}

// dibs resume <id>: undo the owner's pause. Pauses dibs made itself (for an
// urgent job, for memory) stay until their reason ends.
export function resume(args) {
  const who = actor();
  const me = caller('resume');
  const { id, reason, owner } = leaseArg('resume', args);
  const r = withState(s => {
    const l = s.leases.find(x => String(x.id) === id);
    if (!l) return { err: missing(s, id) };
    const no = notYours('resume', l, who, me, owner);
    if (no) return { err: no, code: 2 };
    out(naming('resuming', l));
    if (!l.pauses?.some(p => p.owner))
      return { err: `#${id} isn't paused by you${l.pausedAt ? ` (it's ${pauseLabel(l)}, which dibs undoes by itself)` : ''}. Nothing changed.` };
    ownerPause(l, false);
    if (reason) l.resumeReason = reason; else delete l.resumeReason;
    return { done: brief(s, l), still: l.pausedAt ? pauseLabel(l) : null };
  });
  if (r.err) die(r.err, r.code || 1);
  const c = r.done;
  out(r.still ? `took your pause off #${id} ${c.who}'s ${c.res.join(',')} run, but it stays ${r.still} until that ends.`
    : `resumed #${id} ${c.who}'s ${c.res.join(',')} run.`);
  recordAll('resume', [{ id: c.id, res: c.res, who: c.who }], who, reason);
}

// dibs stop <id>: the owner's kill switch. A run's tree is killed as a crash
// would kill it, and its dibs process says "stopped by the owner" and gives
// the lease back. A waiter's dibs process leaves the line and exits. A hold is
// released.
export function stop(args) {
  const who = actor();
  const me = caller('stop');
  const { id, reason, owner } = leaseArg('stop', args);
  const r = withState(s => {
    const x = [...s.leases, ...s.queue].find(y => String(y.id) === id);
    if (!x) return null;
    const no = notYours('stop', x, who, me, owner);
    if (no) return { refused: no };
    out(naming('stopping', x));
    const c = brief(s, x);
    if (c.kind === 'hold') s.leases = s.leases.filter(l => l !== x);
    else if (c.kind === 'wait' && !x.pid) s.queue = s.queue.filter(q => q !== x);   // a kept place: nobody is waiting on it
    else {
      x.ownerStop = now();
      if (who.agent || who.via) x.stopBy = who.name;
      if (reason) x.stopReason = reason;
      // SIGKILL ends stopped processes too, so a paused run needs no SIGCONT first.
      // The lock is still held, so the run's own dibs can't remove the lease
      // (and its group number can't be handed out again) in between.
      if (c.kind === 'run') for (const g of groupsOf(x)) stopTree(g, 'SIGKILL');
    }
    return c;
  });
  if (!r) die(`no lease or waiter #${id}. ${IDS}`, 1);
  if (r.refused) die(r.refused, 2);
  out(r.kind === 'hold' ? `released #${id} ${r.who}'s hold on ${r.res.join(',')}. A hold has no process to kill; the agent finds out when it next asks.`
    : r.kind === 'wait' ? `took #${id} ${r.who} out of line for ${r.res.join(',')}. Its command never started.`
    : `stopped #${id} ${r.who}'s ${r.res.join(',')} run and killed its processes. Its dibs tells the agent it was stopped by ${who.agent || who.via ? who.name : 'the owner'}.`);
  recordAll('stop', [{ id: r.id, res: r.res, who: r.who }], who, reason);
}

// Lower a waiter to its agent's cap, or back up toward what it asked for when
// the cap rises. Returns [from, to] when it changed.
function capOne(q, prio, who) {
  const base = q.owner?.act === 'cap' ? q.askedPrio : q.prio || 'normal';
  const to = prio && rankOf(base) < rankOf(prio) ? prio : base;
  const from = q.prio || 'normal';
  if (to === from) return null;
  if (to === base) { q.prio = base; delete q.owner; delete q.askedPrio; } else setPrio(q, to, 'cap', who);
  return [from, to];
}

// At enqueue (src/acquire.mjs): a capped agent's new request waits at its cap.
export function capWaiter(s, q) {
  const c = s.caps?.[q.agent] || s.caps?.[q.who];
  if (c && rankOf(q.prio) < rankOf(c.prio)) setPrio(q, c.prio, 'cap', { agent: !!c.by, name: c.by });
}

// dibs cap <agent> <prio|off>: that agent's work never waits or runs above
// prio: its waiters now and every request it makes until off. Running jobs
// are left alone (dibs boost or dibs pause them).
export function cap(args) {
  const who = actor();
  const { words: [name, p] } = argsOf('cap', args);
  if (!name || !p) die(`Use: ${USAGE.cap}`);
  const prio = p === 'off' ? null : prioArg('cap', p);
  const r = withState(s => {
    const had = s.caps?.[name]?.prio || null;
    if (prio) (s.caps ||= {})[name] = { prio, at: now(), ...byOf(who) };
    else if (s.caps) { delete s.caps[name]; if (!Object.keys(s.caps).length) delete s.caps; }
    const changed = s.queue.filter(byName(name)).map(q => [q, capOne(q, prio, who)]).filter(([, d]) => d)
      .map(([q, [from, to]]) => ({ ...brief(s, q), from, prio: to }));
    return { had, changed };
  });
  out(prio ? `${name}'s work now waits and runs at ${prio} or below${r.had ? ` (was capped at ${r.had})` : ''}, until dibs cap ${name} off.`
    : r.had ? `took the ${r.had} cap off ${name}.` : `${name} had no cap. Nothing changed.`);
  for (const c of r.changed) out(`  #${c.id} ${c.who}'s ${c.res.join(',')} wait: ${c.from} -> ${c.prio}`);
  if (prio || r.had) recordAll('cap', [{ who: name, prio: prio || 'off', from: r.had }], who);
}

// What a board row says about the owner's hand in it: by owner (the person)
// or by the agent that did it, with its reason.
export function ownerLabel(x) {
  if (!x.owner) return '';
  const by = x.owner.by || 'owner';
  if (x.owner.act === 'cap') return `capped ${x.owner.prio} by ${by}`;
  return `${rankOf(x.owner.prio) < rankOf(x.askedPrio) ? 'boosted' : 'lowered'} by ${by}${x.owner.reason ? `: ${x.owner.reason}` : ''}`;
}
