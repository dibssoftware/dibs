// The board: who holds what and who waits, on this machine and, when it's
// joined to a coordinator, on every other machine too.
import { resCfg } from './config.mjs';
import { tag, isMine } from './proc.mjs';
import { idleFor } from './acquire.mjs';
import { forecast, byRank, remaining, used, overBy, verdict, memUsed, cpuUsed, shownFree, swapGrowing, diskSqueeze, BREAKER_LINE } from './schedule.mjs';
import { grewLine, cappedLine } from './measure.mjs';
import { pauseLabel } from './preempt.mjs';
import { alongsideLabel } from './overlap.mjs';
import { ownerLabel } from './override.mjs';
import { quotasNow, quotaBlock } from './quota.mjs';
import { agentsNow } from './agents.mjs';
import { remoteConf, call } from './remote.mjs';
import { bytes, dur, gb, clock, now, holder, when } from './util.mjs';
import { short, isFiles, sameAgent } from './files.mjs';
import { named, about, minutes, usingText, nextText, stuckFor, heldByLoad } from './plain.mjs';

// Why a waiter isn't running, short enough for its board row: the rule and
// what it's stuck on (a file lease's path, a bucket's name). Disk says the
// numbers, since a disk wait is the one an agent can do something about.
// `dibs --json` carries it as is ("slot: xcode-build", "behind web-app").
export const waitReason = v => (v.ok ? null : v.rule === 'ahead' && v.ahead ? `behind ${tag(v.ahead)}`
  : v.rule === 'load' && v.since != null ? heldByLoad(v)
  : v.rule === 'disk' ? v.why.replace('you need', 'needs')
  : `${v.rule}${v.on ? `: ${short(v.on).replace(/^(files|quota):/, '')}` : ''}`);
const blockedBy = v => { const r = waitReason(v); return r && !/^(behind|held by) /.test(r) ? `blocked by ${r}` : r; };

// What holds a waiter back, as its own dibs decides (acquire.mjs decide: the
// line and the machine, then a shared rate limit), or, when nothing does, that
// nobody has decided for it lately. On 2026-10-20 two test runs showed no
// reason at all and didn't start, with free slots and memory.
const UNPOLLED = 3 * 6e4;   // a waiter's dibs decides every few seconds, and notes it once a minute (acquire.mjs POLLED_EVERY)
function waitingOn(s, q, cfg, hist, t) {
  const v = verdict(s, q, cfg, hist, t);
  if (!v.ok) return blockedBy(v);
  const quota = quotaBlock(s, q, cfg, hist, t);
  if (quota) return blockedBy(quota);
  return q.polledAt && t - q.polledAt > UNPOLLED ? `ready, but its dibs hasn't looked in ${dur(t - q.polledAt)}` : null;
}

const ASK_FOR = 1500;   // plain `dibs` never waits longer than this for other machines
const STALE = 20e3;     // a board older than this says how old it is

// What the board shows, in a form other machines can read: no pids, no
// environment, and times as durations so two clocks needn't agree. With `me`,
// rows that are the caller's are marked, and carry the ids the owner's
// commands take (dibs boost, pause, stop), which mean nothing elsewhere.
export function boardOf(s, cfg, hist, t = now(), me = null) {
  const fc = forecast(s, cfg, hist, t);
  // A sibling subagent's row is its session's, not the caller's own.
  const you = x => ({ ...(me && isMine(x, me) ? sameAgent(x, me) ? { you: true } : { yourSession: true } : {}), ...(me ? { id: x.id } : {}) });
  return {
    // The same numbers the scheduler decides by (schedule.mjs memUsed), so the board and the wait lines agree.
    memUsed: memUsed(s), memBudget: bytes(cfg.budget), cpuUsed: cpuUsed(s), cores: cfg.cores,
    held: [...s.leases].sort((a, b) => a.start - b.start).map(l => ({
      res: l.res.map(r => short(r)), who: l.who, label: l.label, agentId: l.agentId, for: t - l.start, left: remaining(l, hist, t), idle: idleFor(l, t),
      stuck: s.queue.some(q => q.pid) && stuckFor(l, t) > 0,
      prio: l.prio, paused: pauseLabel(l) || null, alongside: alongsideLabel(l) || (l.breaker ? BREAKER_LINE : null), owner: ownerLabel(l) || null, purpose: l.purpose, cmd: l.cmd ? l.cmd.slice(0, 40) : null,
      mem: l.mem, use: l.use?.mem ?? null, over: overBy(l) > 0, grew: grewLine(l) || null, ...you(l) })),
    waiting: [...s.queue].sort(byRank(hist, t)).map(q => ({
      res: q.res.map(r => short(r)), who: q.who, label: q.label, agentId: q.agentId, waited: t - q.enq, in: fc.has(q.id) ? fc.get(q.id) - t : null,
      prio: q.prio, owner: ownerLabel(q) || null, due: q.by ? q.by - t : null, yielded: q.yieldRank != null, kept: !q.pid, holds: q.holding?.res.map(r => short(r)) || null,
      blocked: q.pid ? waitingOn(s, q, cfg, hist, t) : null, capped: cappedLine(q) || null,
      purpose: q.purpose, ...you(q) })),
    free: Object.keys(cfg.resources).map(r => {
      // A per-project resource is free for other projects up to its cap across them (src/schedule.mjs roomFor).
      const c = resCfg(cfg, r), slots = c.exclusiveBy === 'repo' ? c.across ?? c.slots : c.slots;
      const left = slots - used(s, r);
      return left > 0 ? `${r}${slots > 1 ? `(${left})` : ''}` : null;
    }).filter(Boolean),
    quotas: quotasNow(s, cfg, t),
    agents: agentsNow(cfg),
    caps: s.caps || {},
  };
}

// The limits dibs starts work by and how much room each has left, in one
// line, so agents stop checking memory, disk and swap by hand.
const GB = b => gb(b).replace(/G$/, ' GB');
export function limitsLine(s, cfg, m) {
  const budget = bytes(cfg.budget), out = memUsed(s), free = shownFree(m);
  const mem = `memory ${GB(out)} of ${GB(budget)} taken (${out >= budget ? 'none' : GB(budget - out)} left)${free != null ? `, ${GB(free)} free or reclaimable on the machine` : ''}${m.vmPressure >= 1 ? ', pressure high' : ''}`;
  const floor = bytes(cfg.minDisk), sq = diskSqueeze(cfg, floor, m);
  const disk = m.diskFree == null ? 'disk unknown' : `disk ${GB(m.diskFree)} free (floor ${GB(sq?.rule === 'swaproom' ? sq.need : floor)}${sq?.rule === 'drain' ? `, falling ${GB(sq.fell)} in 5 min` : ''})`;
  const over = cfg.maxSwap != null && m.swapUsed > bytes(cfg.maxSwap);
  const swap = m.swapUsed == null ? '' : `swap ${GB(m.swapUsed)}${swapGrowing(m) ? `, growing (${GB(m.swapGrowth)} in 5 min)` : ', steady'}${over ? `, over maxSwap ${GB(bytes(cfg.maxSwap))}` : ''}`;
  return [mem, disk, swap].filter(Boolean).join('; ');
}

export const handedOut = b => `handed out: memory ${gb(b.memUsed)}/${gb(b.memBudget)}, CPU ${b.cpuUsed}/${b.cores} cores in use`;

// HELD, WAITING and free. `age` is how old the board is, so durations read as of now.
export function boardLines(b, t = now(), age = 0, yours = x => x.you) {
  const out = [];
  const you = x => `${x.id != null ? `  #${x.id}` : ''}${yours(x) ? '  <- you' : x.yourSession ? '  <- your session' : ''}`;
  if (b.held.length) {
    out.push('', 'HELD');
    for (const l of b.held)
      out.push(`  ${l.res.join(',').padEnd(14)} ${holder(l, tag).padEnd(28)} ${dur(l.for + age).padStart(7)}`
        + `${l.left != null ? `  ~${dur(l.left - age)} left` : ''}${l.prio && l.prio !== 'normal' ? `  [${l.prio}]` : ''}${l.owner ? `  [${l.owner}]` : ''}${l.idle ? `  [idle ${dur(l.idle + age)}${l.stuck ? ', may be stuck' : ''}]` : ''}${l.paused ? `  [${l.paused}]` : ''}${l.alongside ? `  [${l.alongside}]` : ''}`
        + `${l.over ? `  [over: using ${gb(l.use)} of ${gb(l.mem)}]` : l.grew ? `  [${l.grew}]` : ''}`
        + `${l.purpose ? `  "${l.purpose}"` : ''}${l.cmd ? `  ${l.cmd}` : '  (hold)'}${you(l)}`);
  }
  if (b.waiting.length) {
    out.push('', "QUEUE (in the order they'll go)");
    b.waiting.forEach((q, i) => {
      const flags = [q.prio && q.prio !== 'normal' ? q.prio : '', q.owner || '', q.holds ? `holds ${q.holds.join(',')}, goes first` : '', q.blocked || '', q.capped || '', q.due != null ? `due ${clock(t - age + q.due)}` : '',
        q.yielded ? 'let ahead' : '', q.kept ? 'place kept' : ''].filter(Boolean).join(', ');
      out.push(`  ${String(i + 1).padStart(2)} ${q.res.join(',').padEnd(11)} ${holder(q, tag).padEnd(28)} waited ${dur(q.waited + age).padStart(6)}`
        + `${q.in != null ? `  starts ~${clock(t - age + q.in)}` : ''}${flags ? `  [${flags}]` : ''}${q.purpose ? `  "${q.purpose}"` : ''}${you(q)}`);
    });
  }
  // An id typed from here can be someone else's: acting on it takes the owner by name (src/override.mjs).
  if ([...b.held, ...b.waiting].some(x => x.id != null && !yours(x)))
    out.push('', "Acting on a job that isn't yours (dibs boost, pause, resume, stop <id>): add --owner <the name before its #>.");
  out.push('', `free: ${b.free.join('  ') || 'nothing'}`);
  const caps = Object.entries(b.caps || {});
  if (caps.length) out.push(`capped: ${caps.map(([who, c]) => `${who} at ${c.prio}${c.by ? ` (by ${c.by})` : ''}`).join(', ')}`);
  if (b.quotas?.length)
    out.push(`quotas: ${b.quotas.map(q => (q.error ? `${q.name} (${q.error})` : `${q.name} ${q.left}/${q.limit} per ${dur(q.per)}`)).join('  ')}`);
  if (b.agents?.running.length) {
    const n = new Map();
    for (const a of b.agents.running) n.set(a.who, (n.get(a.who) || 0) + 1);
    out.push(`subagents: ${b.agents.running.length} of ${b.agents.slots} running (${[...n].map(([who, k]) => `${who} x${k}`).join(', ')})`);
  }
  return out;
}

// Every machine's board from the coordinator, or { error } within ASK_FOR.
export async function elsewhere(rc = remoteConf()) {
  if (!rc) return null;
  try { return await call(rc, 'GET', '/board', undefined, { timeout: ASK_FOR }); }
  catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer in ${ASK_FOR / 1000}s` : e.status ? e.message : e.cause?.code || e.message;
    return { error: why };
  }
}

// Another machine's busy lines in sentences, from its board rows. Built here
// rather than sent, so a limited machine's view hides the same purposes and
// paths its board rows do (src/serve.mjs bare).
function remoteSentences(b, cfg, age) {
  const live = b.waiting.filter(q => !q.kept);
  const res = [...new Set([...b.held.flatMap(l => l.res), ...live.flatMap(q => q.res)])];
  return res.map(r => {
    // A hold's row has no command (null). A limited view blanks a run's command to '', so it still reads as a run.
    const held = b.held.filter(l => l.res.includes(r)).map(l => {
      const hold = l.cmd == null, left = l.left == null ? null : Math.max(l.left - age, 0);
      return { who: l.who, hold, endsIn: left, endsText: left == null ? 'time left unknown' : hold ? `up to ${minutes(left)} left` : `${about(left)} left` };
    });
    const next = live.filter(q => q.res.includes(r)).map(q => q.who);
    return `${named(cfg, r).label}: ${held.length ? usingText(held, named(cfg, r)) : 'free'}${next.length ? `. ${nextText(next)}` : ''}.`;
  });
}

// The other machines in sentences, for plain `dibs`.
export function elsewherePlain(r, rc, cfg) {
  if (r.error) return [`Other machines: can't reach the coordinator at ${rc.url} (${r.error}).`];
  const out = [];
  for (const m of r.machines.filter(x => x.name !== rc.name).sort((a, b) => a.name.localeCompare(b.name))) {
    if (m.ondemand?.problem) out.push(`${m.name} is an on-demand VM dibs can't use: ${m.ondemand.problem}.`);
    else if (m.ondemand?.temp && m.ondemand.state === 'asleep') out.push(`${m.name} is made when a job is too big for ${m.ondemand.temp.of}, and deleted after.`);
    // Same words as `dibs machines`: on 2026-10-22 boat's compute ran out and the board still said a job would wake it.
    else if (m.ondemand?.cantWake && m.ondemand.state === 'asleep') out.push(`${m.name} is an on-demand VM that can't wake: ${m.ondemand.cantWake.why}. Jobs stay here; dibs checks again ${when(m.ondemand.cantWake.until)}.`);
    else if (m.ondemand && m.ondemand.state !== 'running') out.push(`${m.name} is an on-demand VM, ${m.ondemand.state}${m.ondemand.state === 'asleep' ? ': a job sent there wakes it' : ''}.`);
    else if (m.lost) out.push(`${m.name} hasn't reported in ${minutes(m.age)}.`);
    else if (!m.board) out.push(`${m.name} runs an older dibs (${m.version}) that doesn't share what it's running.`);
    else {
      const busy = remoteSentences(m.board, cfg, m.age);
      out.push(busy.length ? `On ${m.name}:` : `${m.name} has nothing running.`, ...busy.map(x => `  ${x}`));
    }
  }
  const moving = (r.jobs || []).filter(j => j.state !== 'done').length;
  if (moving) out.push(`${moving} job${moving > 1 ? 's' : ''} moving between machines. More: dibs --detail`);
  return out;
}

// The other machines' sections, then the jobs moving between machines.
export function elsewhereLines(r, rc, me, t = now()) {
  if (r.error) return [`other machines: can't reach the coordinator at ${rc.url} (${r.error})`];
  const out = [];
  // A job sent from here shows on the other machine as you@thismachine.
  const sentByMe = x => x.who === `${me.agent || me.who}@${rc.name}`;
  for (const m of r.machines.filter(x => x.name !== rc.name).sort((a, b) => a.name.localeCompare(b.name))) {
    out.push('');
    if (m.ondemand && m.ondemand.state !== 'running') { out.push(`${m.name}  ${m.ondemand.temp ? 'temporary' : 'on-demand'} VM, ${m.ondemand.temp && m.ondemand.state === 'asleep' ? 'none made' : m.ondemand.state}`); continue; }
    if (m.lost) { out.push(`${m.name}  not reporting, last heard ${dur(m.age)} ago`); continue; }
    if (!m.board) { out.push(`${m.name}  runs dibs ${m.version}, which doesn't send its board`); continue; }
    out.push(`${m.name}  ${handedOut(m.board)}    machine: ${m.memFree}% memory free${m.diskFree != null ? `, disk ${gb(m.diskFree)} free` : ''}, load ${m.load.toFixed(1)}`
      + `${m.age > STALE ? `  (as of ${dur(m.age)} ago)` : ''}`);
    out.push(...boardLines(m.board, t, m.age, sentByMe));
  }
  const jobs = (r.jobs || []).filter(j => j.state !== 'done');
  if (jobs.length) {
    out.push('', 'SENT BETWEEN MACHINES');
    for (const j of jobs)
      out.push(`  ${j.res.join(',').padEnd(14)} ${(j.agent || j.who).padEnd(20)} ${`${j.from} -> ${j.machine}`.padEnd(24)} ${j.state.padEnd(9)} ${dur(r.now - j.created).padStart(6)}`
        + `${j.purpose ? `  "${j.purpose}"` : ''}  ${j.cmd.join(' ').slice(0, 40)}`);
  }
  if (out.length) out.push('');
  return out;
}
