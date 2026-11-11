// One function per subcommand.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resCfg, machine, HOME, paths, PACES, PACE_OVERLAP, paced, paceKnobs, hardware, writePace, loadConfig } from './config.mjs';
import { logChange } from './owner.mjs';
import { identity, isMine, tag } from './proc.mjs';
import { launch, stopTree, processes, descendants, which, starts, scoped, watchdog, OS } from './platform.mjs';
import { withState, withStateIfRoom, history, record, peakOf, KEEP_PLACE } from './state.mjs';
import { acquire, markIdle, idleFor, describeLease, commandKey, holdUntil, outerLease, defaultMaxWait, HOLD_CAP } from './acquire.mjs';
import { rank, rankParts, byRank, forecast, verdict, remaining, used, sum, lent, pausedFor, overLoad, loadWhy, loadAhead, holdingOf, swapping, swapWhy, diskSqueeze, BACKGROUND, roomFor } from './schedule.mjs';
import { noticeHandler } from './preempt.mjs';
import { checkout, checkin, jobSize } from './simpool.mjs';
import { bytes, dur, gb, clock, die, say, now, ms, sleep, SIGNALS, signalExit, noSpace, inClaudeCode, OFF_LIMITS } from './util.mjs';
import { boardOf, boardLines, handedOut, elsewhere, elsewhereLines, elsewherePlain, waitReason, limitsLine } from './board.mjs';
import { plainBoard, lineParts, headline, startPhrase, whyLines, askFirst, named, andList, minutes, lower, usingText, nextText, ends, freeText, machineHold } from './plain.mjs';
import { bold, dim, amber, columns, wrap, quoted } from './style.mjs';
import { quotasNow, isQuota } from './quota.mjs';
import { agentsNow } from './agents.mjs';
import { forYou } from './questions.mjs';
import { notesForYou, listeners } from './talk.mjs';
import { remoteConf, shortHost } from './remote.mjs';
import { sample, sized, grewLine, grewPlain, tellOverAsk } from './measure.mjs';
import { clash, isFiles, short, takeAgent, callKey, sameAgent, fileKey, shellRes, projectKey } from './files.mjs';
import { sideBySide } from './overlap.mjs';
import { laterBoard, laterLines, laterPlain } from './later.mjs';
import { noticeScan, NOTICE_EVERY, twinOf } from './notices.mjs';
import { answer, ISSUES } from './answers.mjs';
import { event } from './events.mjs';
import { scan as scanAlerts, alertLines, onBoard } from './alerts.mjs';

const REQUESTS = path.join(HOME, 'requests.jsonl');
// Exit codes dibs gives its own meaning (AGENTS.md).
const DIBS_CODES = new Set([1, 2, 3, 70, 74, 75, 76, 77, 127]);
const json = x => console.log(JSON.stringify(x, null, 1));

export function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

// --notify <file>: one JSON line when dibs exits, however it exits, so an agent
// can wait on a file instead of polling the board. A kill -9 writes nothing.
// started is true once the command was launched here, false if it never was,
// and null for a job sent to another machine, where this process can't tell.
let started = null;
export function notifyOnExit(o) {
  if (!o.notify) return;
  const file = path.resolve(o.notify);
  try { fs.accessSync(path.dirname(file), fs.constants.W_OK); } catch { die(`--notify ${o.notify}: can't write in ${path.dirname(file)}`); }
  const t0 = now();
  process.on('exit', code => {
    // Handed to the broker or to its own run: whoever ends the wait writes the line (src/broker.mjs).
    if (o.thin?.handed || handedOn) return;
    const line = { at: new Date().toISOString(), code, started, res: o.res, cmd: (o.cmd || []).join(' '), cwd: process.cwd(), secs: Math.round((now() - t0) / 1000), pid: o.thin?.shell ?? process.pid };
    try { fs.appendFileSync(file, JSON.stringify(line) + '\n'); } catch (e) { say(`couldn't write to --notify ${o.notify}: ${e.message}`); }
  });
}

// Which agent of this session is calling, when the guard hook saw it ask
// (src/files.mjs). Its type labels it on the board unless --as says.
function stamp(o, verb) {
  const a = takeAgent(verb, o.res, callKey(verb));
  if (!a) return;
  o.agentId = a.agentId;
  if (a.agentType) o.as ??= a.agentType;
}

// The caller, with the subagent stamp() found. ours(): a lease or wait that
// is this agent's own, not a sibling subagent's; unstamped ones (no guard
// hook) belong to the whole session, as before.
const caller = o => ({ ...identity(o), agentId: o.agentId });
const ours = (x, me) => isMine(x, me) && sameAgent(x, me);

// dibs run <res> -- <cmd>: wait, run, release when it exits.
export async function run(o, cfg) {
  started = false;
  // --lease: a thin waiter's turn (src/thin.sh). The checks before the line were made when it got in line.
  if (!o.lease) stamp(o, 'run');
  // A retried tool call is Claude Code's problem; scheduled and remote jobs aren't tool calls. A full disk skips the check.
  const twin = !o.lease && inClaudeCode() && !process.env.DIBS_LATER_JOB && !process.env.DIBS_REMOTE_JOB && twinOf(withStateIfRoom(s => s) || {}, o, identity(o));
  if (twin) {
    const id = identity(o);
    event({ kind: 'twin', id: twin.id, res: o.res, who: id.who, agent: id.agent, agentId: o.agentId, label: id.label, cmd: o.cmd.join(' ') });
    die(twin.text, 2);
  }
  if (!o.cmd || !o.cmd.length) die('nothing to run: put the command after --, like dibs run sim -- ./ui-test.sh');
  if (!o.res.length) die('which resource? Name it before the --, like dibs run sim -- <command>. The list: dibs help all');
  if (!which(o.cmd[0])) {
    // dibs run test -- "npm test && npm run lint": the whole line arrived as one program name.
    const line = o.cmd.length === 1 && /[\s;&|<>$]/.test(o.cmd[0]);
    die(`couldn't start ${o.cmd[0]}: it isn't on your PATH. Nothing ran (exit 127).`
      + `${line ? ` To run a shell line, use: dibs run ${shellRes(o.res.map(r => short(r)))} -- sh -c ${quoted(o.cmd)}` : ''}`, 127);
  }
  // Inside a dibs run that already has these resources (a script that wraps
  // its own steps in dibs), go straight ahead instead of queueing behind yourself.
  // Needing more than it has, it waits only for the rest, ahead of waiters that hold nothing.
  // A quota is never "had": each call pays its tokens, or a script looping
  // over an API inside one run would make every call for free.
  const outer = o.lease ? null : outerLease();
  if (outer && o.res.every(r => !isQuota(r) && outer.res.includes(r))) return o.thin && !o.thin.inline ? o.thin.fat() : runNested(o);
  if (o.after) await after(o);
  const lease = await acquire({ ...o, outer }, 'run', cfg);
  const env = { ...process.env, DIBS_LEASE: String(lease.id) };
  const sim = await simFor(lease, cfg);
  if (sim) { Object.assign(env, { SIM: sim.udid, SIM_NAME: sim.name }); say(`SIM=${sim.udid} SIM_NAME=${sim.name}`); }
  await addPorts(env, o.ports);
  const child = launch(cfg.enforce ? scoped(o.cmd, lease) : o.cmd, { env, background: BACKGROUND.has(lease.prio) || !!lease.loadPast, gate: true });
  // Children that split off into their own process group still belong to the
  // lease: note them as they appear, so they're stopped with it.
  const groups = new Set();
  // Each group's leader's start time, so whoever reaps the lease can tell the
  // group from a later one that reused its number (src/state.mjs killLease).
  const groupStarts = {};
  let recorded = '';   // the groups the state has, so a change a full disk kept out is tried again next tick
  // If dibs is killed outright, this kills the job instead of leaving it to the next dibs call.
  const wd = watchdog();
  // A group that has emptied is forgotten at once, before its number can be reused.
  const track = () => {
    if (!child.pid || OS === 'windows') return;
    const found = [...descendants(child.pid)].filter(g => g !== child.pid && !groups.has(g));
    const st = found.length ? starts(found) : null;
    for (const g of found) { groups.add(g); wd.add(g); if (st?.get(g)) groupStarts[g] = st.get(g); }
    const live = new Set(processes().map(p => p.pgid));
    for (const g of groups) if (!live.has(g)) { groups.delete(g); delete groupStarts[g]; wd.drop(g); }
    const cur = [...groups].join();
    if (cur !== recorded && withStateIfRoom(s => { const l = s.leases.find(x => x.id === lease.id); if (l) Object.assign(l, { groups: [...groups], groupStarts: { ...groupStarts } }); return true; })) recorded = cur;
  };
  const stopAll = sig => { stopTree(child.pid, sig); if (OS !== 'windows') for (const g of groups) stopTree(g, sig); };
  let finished = false, tracker = null, ran = null;
  let took = null;   // how long a run the quick lane let in really took
  const finish = code => {
    if (finished) return;
    finished = true;
    clearInterval(tracker);
    stopAll('SIGKILL');
    wd.done();
    if (sim) try { checkin(lease); } catch (e) { say(`couldn't put the simulator back in the pool (${e.message}). The next dibs command does it.`); }
    let again = null;
    try {
      withState(s => {
        const l = s.leases.find(x => x.id === lease.id);
        if (l?.requeue) { again = requeue(s, l, cfg); return; }
        // Groups stopped by a pause that this process never tracked would stay stopped forever.
        if (OS !== 'windows') for (const g of l?.stopped || []) stopTree(g, 'SIGKILL');
        if (l) l.code = code;   // for the end event in the history (src/events.mjs)
        if (l?.ownerStop) say(`stopped by ${l.stopBy || 'the owner (the person at this machine)'} on purpose (dibs stop)${l.stopReason ? `: "${l.stopReason}"` : ''}. This job was ended and its processes killed.`
          + `${l.stopReason ? '' : ' Find out why before running it again: dibs history, or ask whoever stopped it.'}`);
        s.leases = s.leases.filter(x => x.id !== lease.id);
        // A failing run is often the one that ran out of memory: its size counts too.
        if (l && (code === 0 || l.peak?.mem)) record(l.key, now() - l.start - pausedFor(l), l.who, peakOf(l), code !== 0);
        if (l?.quick) took = now() - l.start - pausedFor(l);
        tellOverAsk(l);
      });
    } catch (e) {
      // The job is already stopped. Its lease names this process, so the next
      // dibs call to read the state sees it gone, drops the lease and kills anything left.
      // Either way the command's own code comes back, not dibs's trouble.
      if (noSpace(e)) say(`the disk is full, so dibs couldn't record that this job ended. The next dibs command cleans it up. Free some disk space. ${OFF_LIMITS}`);
      else say(`dibs hit a bug recording that this job ended (${e.message}). Your command's exit code comes back anyway, and the next dibs command cleans up. Report it: dibs ask "..."`);
    }
    if (again) return runAgain(o, lease, again);
    // Over the quick lane's limit: its next runs wait their turn until one comes in under (src/schedule.mjs quickPass).
    const under = cfg.quickUnder == null ? null : ms(cfg.quickUnder);
    if (took != null && under != null && took >= under) say(`this took ${dur(took)}, over the ${dur(under)} the quick lane is for, so its next runs wait their turn until one finishes in under ${dur(under)}.`);
    // A failing command's code can look like one of dibs's own (75, 74, 127), so say whose it is.
    if (code && code < 128) say(`${path.basename(o.cmd[0])} exited with code ${code}${DIBS_CODES.has(code) ? ". That's your command's code, not dibs's" : ''}.`);
    // One line that says it all, for an agent that has lost the output above (a compacted context).
    say(`#${lease.id} ${lease.res.map(r => short(r)).join(',')}, waited ${dur(lease.waited || 0)}, ${ran == null ? 'never started' : `ran ${dur(now() - ran)}`}, exit ${code}`);
    process.exit(code);
  };
  // Signals are handled from here on, before the slow steps below, so one that
  // arrives early still reaches the job instead of killing dibs alone.
  for (const sig of SIGNALS) process.on(sig, () => {
    stopAll(sig);   // signal first; finding split-off groups takes a process-table read
    if (OS !== 'windows') stopAll('SIGCONT');   // a paused job can't act on the signal until it runs
    track();
    stopAll(sig);
    setTimeout(() => finish(signalExit(sig)), 3000).unref();
  });
  // Low and idle work can be paused for urgent work (src/preempt.mjs); say so when it happens.
  // Notices about this job and others go to their agents while it runs (src/notices.mjs).
  setInterval(noticeScan, NOTICE_EVERY).unref();
  const notify = OS !== 'windows';
  if (notify) process.on('SIGUSR2', noticeHandler(() => withStateIfRoom(s => s.leases.find(x => x.id === lease.id))));
  // The command starts only once its group is on record, so a wrapper killed
  // at any point has its job reaped with it, or the job never starts.
  // The gate shell execs the command, so its start time is the command's.
  const note = facts => s => { const l = s.leases.find(x => x.id === lease.id); if (l) Object.assign(l, facts); };
  const pgstart = child.pid ? starts([child.pid])?.get(child.pid) ?? null : null;
  // requeuable: this dibs run can put its job back in line if the watcher stops it (src/preempt.mjs diskRequeue).
  try { withState(note({ pgid: child.pid, pgstart, notify, background: BACKGROUND.has(lease.prio) || !!lease.loadPast, requeuable: true })); } catch (e) {
    if (!noSpace(e)) throw e;
    // Unrecorded, the job couldn't be reaped if dibs died: it doesn't start. The lease goes with this process.
    stopTree(child.pid, 'SIGKILL');
    wd.done();
    die(`the disk is full, so dibs couldn't record your job before starting it. Your command did NOT run (exit 74). Free some disk space, then run it again. ${OFF_LIMITS}`, 74);
  }
  child.go();
  started = true;
  ran = now();
  if (child.pid) wd.add(child.pid);
  if (child.pid && !pgstart) withStateIfRoom(note({ pgstart: starts([child.pid])?.get(child.pid) ?? null }));
  // Each tick also measures every lease on the machine, when it's this run's turn (src/measure.mjs).
  tracker = setInterval(() => { track(); sample(); }, 3000);
  tracker.unref();
  child.on('error', e => { say(`couldn't start ${o.cmd[0]}: ${e.message}`); finish(127); });
  // No last track(): once the child has exited, its process groups are found by the
  // reaping below (finish), and walking the process table here cost 30 ms of every return.
  child.on('exit', (code, sig) => finish(code ?? signalExit(sig)));
}

// A run the watcher stopped while it sat paused for low disk (src/preempt.mjs
// diskRequeue): its lease gives way to a place at the front of its line, kept
// for this process alone (keptFor, so it goes if this process dies), which the
// same command picks up when it runs again (acquire's ticket). Called under the lock.
function requeue(s, l, cfg) {
  const t = now();
  s.leases = s.leases.filter(x => x !== l);
  // What it really used goes into the history, so every later run of the command is planned at it too.
  if (l.peak?.mem) record(l.key, t - l.start - pausedFor(l), l.who, peakOf(l), true);
  const res = l.res;
  const front = Math.min(l.start - (l.waited || 0), ...s.queue.filter(q => q.res.some(r => res.includes(r))).map(q => q.enq)) - 1;
  // Booked at what it really used, up to all the memory dibs shares out (usual keeps the rest).
  const used = Math.max(l.use?.mem || 0, l.peak?.mem || 0), budget = bytes(cfg.budget);
  const size = used > l.mem ? (used > budget ? { mem: Math.max(l.mem, budget), usual: used } : { mem: used, usual: l.usual }) : { mem: l.mem, usual: l.usual };
  const q = { id: ++s.seq, ticket: `${l.spid || l.who}|${res.join(',')}|${l.cmd}`, res, ...size, cpu: Math.max(l.cpu || 0, Math.ceil(l.peak?.cpu || 0)), asked: l.asked ?? l.mem, askedCpu: l.askedCpu,
    pid: null, pstart: l.pstart, keptFor: l.pid, keepUntil: t + KEEP_PLACE, enq: front, who: l.who, agent: l.agent, label: l.label, spid: l.spid,
    purpose: l.purpose, cmd: l.cmd, key: l.key, kind: 'run', agentId: l.agentId, sessionId: l.sessionId, cwd: l.cwd, ppid: l.ppid, requeued: l.requeue.why };
  if (l.prio) q.prio = l.prio;
  if (l.by) q.by = l.by;
  if (l.requeue.why === 'over') q.requeues = (l.requeues || 0) + 1;
  s.queue.push(q);
  return { id: q.id, why: l.requeue.why, mem: q.mem };
}

// Run the same dibs run again, as this same process where Node allows it
// (process.execve keeps the pid the agent's tool call is waiting on), so it
// waits in line like any other and picks up the place requeue() kept.
const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'dibs.mjs');
let handedOn = false;
function runAgain(o, lease, again) {
  say(again.why === 'over'
    ? `stopped #${lease.id}: it was using far more memory than it booked while swap filled the disk. It's back at the front of the line as #${again.id},`
      + ` booked at ${gb(again.mem)}, and runs again from the start once that much memory is really free. Nothing for you to do: this call carries on.`
    : again.why === 'memory'
    ? `stopped #${lease.id}: it was paused for memory pressure, which stayed critical, and a paused job's memory only goes to swap.`
      + ` It's back at the front of the line as #${again.id} and runs again from the start when there's room. Nothing for you to do: this call carries on.`
    : `stopped #${lease.id}: it sat paused for low disk while its memory went to swap and filled the disk.`
      + ` It's back at the front of the line as #${again.id} and runs again from the start when there's room. Nothing for you to do: this call carries on.`);
  const args = process.argv.slice(2);
  const at = args.indexOf('--lease');
  if (at >= 0 && at < (args.indexOf('--') >>> 0)) args.splice(at, 2);
  handedOn = true;
  if (process.execve && OS !== 'windows') process.execve('/bin/sh', ['/bin/sh', BIN, ...args], process.env);
  // No execve (Node before 22.15, or Windows): the same command in a child, whose code is this one's.
  const child = spawn(process.execPath, [BIN, ...args], { stdio: 'inherit' });
  for (const sig of SIGNALS) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, sig) => process.exit(code ?? signalExit(sig)));
}

// --after #42: wait for one of your earlier jobs (or anyone's) to end before
// joining the line, so a second step can't overtake the first. The wait counts
// against the same limit as the queue.
const AFTER_POLL = 1500;
async function after(o) {
  const id = Number(String(o.after).replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) die(`--after takes a job number from the board, like --after #42 (dibs mine shows yours)`);
  const t0 = now();
  const limit = o.maxWait ?? defaultMaxWait();
  let first = true;
  for (;;) {
    const x = withState(s => { const l = s.leases.find(l => l.id === id) || s.queue.find(q => q.id === id && q.pid); return l && { ...l }; });
    if (!x) {
      if (first) say(`#${id} isn't running or waiting (it may have ended already), so this joins the line now.`);
      else say(`#${id} ended after ${dur(now() - t0)}; joining the line.`);
      if (limit !== Infinity) o.maxWait = Math.max(0, limit - (now() - t0));
      return;
    }
    if (first) {
      first = false;
      say(`waiting for #${id} (${tag(x)}, ${x.res.map(r => short(r)).join(',')}${x.purpose ? `, "${x.purpose}"` : ''}) to end before joining the line.`
        + `${limit === Infinity ? '' : ` Gives up at ${clock(t0 + limit)} (exit 75: your command won't have run).`}`);
    }
    if (now() - t0 >= limit) die(`#${id} is still going after ${dur(now() - t0)}, so this never joined the line. Your command did NOT run (exit 75). Run it again later, or add --wait.`, 75);
    await sleep(AFTER_POLL);
  }
}

// A name that isn't configured but is close to one that is (simulator, tset,
// xcode) is almost always a slip. Run under it and it gets a queue of its own,
// and two agents slipping differently both get the real thing at once. A name
// far from every known one is someone's own lock ("one migration at a time"),
// which dibs allows.
const ALIAS = { simulator: 'sim', simulators: 'sim', simctl: 'sim', xcode: 'xcode-build', xcodebuild: 'xcode-build', build: 'xcode-build', builds: 'xcode-build',
  tests: 'test', testing: 'test', browser: 'playwright', browsers: 'playwright', e2e: 'playwright', deploys: 'deploy', ship: 'deploy' };
export function checkNames(res, cfg) {
  const known = Object.keys(cfg.resources);
  for (const r of res) {
    if (isFiles(r) || isQuota(r) || cfg.resources[r]) continue;
    const near = closeTo(r, known);
    if (near) die(`no resource named ${r}. Did you mean ${near}? (A new name of your own: add it under "resources" in ${paths.config}.)`);
  }
}
function closeTo(r, known) {
  const low = r.toLowerCase();
  if (ALIAS[low] && known.includes(ALIAS[low])) return ALIAS[low];
  // sim-promax, test2, deploy_site: a known name with a suffix is a deliberate name of its own.
  return known.find(k => k === low) || (known.some(k => low.startsWith(k) && /[-_0-9]/.test(low[k.length] || '')) ? null
    : known.find(k => edits(low, k) <= (low.length >= 7 ? 2 : 1))) || null;
}
// Edits between two words, a swap of neighbours counting as one (tset is one from test).
function edits(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
export const nearest = (word, list) => list.find(k => edits(word, k) <= (word.length >= 5 ? 2 : 1)) || null;

// A pool lease's own simulator, booted. If it can't be had, the lease is given back.
async function simFor(lease, cfg) {
  try { return await checkout(lease, cfg); } catch (e) {
    withState(s => { s.leases = s.leases.filter(x => x.id !== lease.id); });
    die(`${e.message}. Your command did not run.`, 1);
  }
}

// A run inside a run that already holds the resources: no new lease, and
// nothing to track, since the outer run stops every group when it ends.
async function runNested(o) {
  started = true;
  const env = { ...process.env };
  await addPorts(env, o.ports);
  const child = launch(o.cmd, { env, background: false });
  const stop = sig => stopTree(child.pid, sig);
  for (const sig of SIGNALS) process.on(sig, () => { stop(sig); setTimeout(() => process.exit(signalExit(sig)), 3000).unref(); });
  child.on('error', e => { say(`couldn't start ${o.cmd[0]}: ${e.message}`); process.exit(127); });
  const t0 = now();
  child.on('exit', (code, sig) => {
    stop('SIGKILL');
    say(`inside #${process.env.DIBS_LEASE}, ran ${dur(now() - t0)}, exit ${code ?? signalExit(sig)}`);
    process.exit(code ?? signalExit(sig));
  });
}

// A free port in env for each --port name. Picked after any wait in line, so
// nobody takes them in between.
async function addPorts(env, names) {
  for (const name of names) env[name] = String(await freePort());
  if (names.length) say(names.map(n => `${n}=${env[n]}`).join(' '));
}

function myHolds(s, id, res, o = {}) {
  return s.leases.filter(l => l.kind === 'hold' && isMine(l, id) && sameAgent(l, o) && (!res.size || l.res.some(r => res.has(fileKey(r)))));
}
const CROWDED_EXTEND = 10 * 6e4;

// dibs hold <res>: take it across several tool calls, or extend it if you already have it.
export async function hold(o, cfg) {
  if (!o.lease) stamp(o, 'hold');
  const id = identity(o);
  const want = new Set(o.res);
  // With others waiting, a hold extends 10 minutes at a time, and not past an hour in total.
  const extended = o.lease ? [] : withState(s => {
    const mine = myHolds(s, id, want, o);
    for (const l of mine) {
      const waiting = s.queue.filter(q => q.pid && q.res.some(r => l.res.some(x => clash(x, r))));
      l.waiters = waiting.map(tag);
      // Asking again never shortens a hold.
      if (!waiting.length) { l.expires = Math.max(l.expires, holdUntil(o)); continue; }
      if (now() - l.start >= HOLD_CAP) { l.refused = true; continue; }
      l.expires = Math.max(l.expires, Math.min(now() + Math.min(o.for ?? CROWDED_EXTEND, CROWDED_EXTEND), l.start + HOLD_CAP));
    }
    return mine.map(l => ({ ...l }));
  });
  // Bare `dibs hold` (or the old `dibs renew`) extends every hold you have; with none, it's a slip.
  if (!o.res.length && !extended.length) die('hold what? dibs hold sim --for 20m -m "why"  (what you have: dibs mine)');
  // An hour is the most any hold gets, so a longer --for is cut to that, and says so.
  const capped = o.for > HOLD_CAP ? ` (${dur(o.for)} asked; an hour is the most a hold gets. Hold again before it ends to extend.)` : '';
  for (const l of extended) {
    if (l.refused) {
      console.log(`Can't give you more time on ${l.res.join(', ')}: you've had it ${dur(now() - l.start)} and ${l.waiters.join(', ')} ${l.waiters.length > 1 ? 'are' : 'is'} waiting. It ends at ${clock(l.expires)}. Give it back as soon as you can: dibs release ${shellRes(l.res.map(r => short(r)))}`);
      process.exitCode = 1;
    } else console.log(`You still have ${l.res.join(', ')}, now until ${clock(l.expires)}.${l.waiters.length ? '' : capped}`
      + `${l.waiters.length ? ` ${l.waiters.join(', ')} ${l.waiters.length > 1 ? 'are' : 'is'} waiting for it, so more time comes 10 minutes at a time. Give it back the moment you're done: dibs release ${shellRes(l.res.map(r => short(r)))}` : ''}`);
  }
  const missing = o.res.filter(r => !extended.some(l => l.res.includes(r)));
  if (!missing.length) return;
  const lease = await acquire({ ...o, res: missing }, 'hold', cfg);
  const sim = await simFor(lease, cfg);
  const names = shellRes(lease.res.map(r => short(r)));
  console.log(wrap(bold(`Reserved for you until ${clock(lease.expires)}: ${andList(lease.res.map(r => named(cfg, r).the))}.`) + capped
    + (lease.pid ? ` It also ends when your session does.` : ' No agent session found, so it ends at that time or when you run dibs release.')
    + (lease.label ? ` (held as ${tag(lease)})` : ''), '  '));
  if (sim) console.log(`  Your simulator: ${sim.name}, udid ${sim.udid}. Runs under this hold get SIM and SIM_NAME.`);
  if (lease.res.some(isFiles)) console.log("  Other agents' edits there are turned away (with dibs guard installed). Yours go through.");
  console.log(`  Run things on it, no waiting: dibs run ${names} -- <command>`);
  console.log(`  More time: dibs hold ${names} --for 20m    Done: dibs release ${names}`);
}

// dibs release [res]: give back your holds.
export function release(o) {
  stamp(o, 'release');
  const id = identity(o);
  // Shut pool simulators down before the holds go, so they don't outlive them.
  for (const l of withState(s => myHolds(s, id, new Set(o.res), o))) checkin(l);
  const ls = withState(s => {
    const mine = myHolds(s, id, new Set(o.res), o);
    s.leases = s.leases.filter(l => !mine.includes(l));
    return mine;
  });
  if (!ls.length) die(`you have nothing reserved${o.res.length ? ` matching ${o.res.join(', ')}` : ''} to give back. See what you have: dibs mine`, 1);
  for (const l of ls) console.log(`Gave back ${l.res.join(', ')} after ${dur(now() - l.start)}.`);
}

// dibs when <res>: when you'd get it, without joining the line.
export function when(o, cfg) {
  if (!o.res.length) die('when for what? dibs when sim  (or several: dibs when sim,xcode-build)');
  const id = identity(o);
  const hist = history();
  const t = now();
  const res = [...new Set(o.res)];
  const key = `${res.join(',')}|${o.cmd ? commandKey(o.cmd) : 'hold'}`;
  const probe = { id: -1, res, enq: t, pid: 1, who: id.who, agent: id.agent, spid: id.spid, prio: o.prio, by: o.by, est: o.est, declared: o.mem != null,
    ...sized(jobSize(cfg, res, o), hist, key, cfg), key };
  const s = withState(s => { markIdle(s); return s; });
  probe.holding = holdingOf(s, probe, cfg, t);
  const v = verdict(s, probe, cfg, hist, t);
  const at = v.ok ? t : forecast(s, cfg, hist, t, probe).get(-1);
  const ahead = s.queue.filter(q => q.pid && q.res.some(r => res.includes(r)) && rank(q, hist, t) < rank(probe, hist, t)).length;
  if (o.json) return json({ resources: res, freeNow: v.ok, start: at, waitMs: at - t, ahead, blockedBy: v.ok ? null : v.rule, why: v.why || null,
    mem: probe.mem, cpu: probe.cpu, askedMem: probe.asked ?? null, askedCpu: probe.askedCpu ?? null });
  const names = andList(res.map(r => named(cfg, r).the));
  const go = `dibs run ${shellRes(res.map(r => short(r)))} -- <command>`;
  const grew = grewPlain(probe, key.split('|')[1]);
  if (v.ok) {
    console.log(bold(`Free now: ${names}.`) + ` Take ${res.length > 1 ? 'them' : 'it'}: ${go}`);
    if (grew) console.log(dim(wrap(`  ${grew}`, '    ')));
    return;
  }
  // Where you'd land, worked out as if you joined the queue now.
  const p = plainBoard({ ...s, queue: [...s.queue, probe] }, cfg, hist, t);
  const w = p.waiting.get(-1);
  console.log(bold(`You'd be ${lower(w.headline)}, ${startPhrase(w)}.`));
  console.log(wrap(`  You'd wait for ${w.waitingFor}.`, '    '));
  if (v.alongside) console.log(wrap(`  ${v.alongside}`, '    '));
  if (grew) console.log(dim(wrap(`  ${grew}`, '    ')));
  console.log(`To join the queue: ${go}`);
}

// dibs why: why you're waiting, in sentences. --detail: how your place in line was worked out.
export function why(o, cfg) {
  stamp(o, 'why');
  const id = caller(o);
  const hist = history();
  const t = now();
  const s = withState(s => { markIdle(s); return s; });
  const mine = s.queue.filter(q => q.pid && ours(q, id));
  if (!mine.length) {
    const holds = s.leases.filter(l => ours(l, id));
    if (o.detail) return console.log(`you're not waiting for anything.${holds.length ? ` You hold: ${holds.map(l => l.res.join(',')).join('; ')}.` : ''}`);
    return console.log(`You're not waiting for anything.${holds.length ? ` You have ${andList(holds.flatMap(l => l.res.map(r => named(cfg, r).the)))}.` : ''}`);
  }
  if (!o.detail) {
    const p = plainBoard(s, cfg, hist, t, undefined, id);
    for (const q of mine) {
      const [head, ...rest] = whyLines(p, q, cfg);
      console.log(bold(wrap(head)));
      for (const x of rest) console.log(wrap(x, '    '));
      const ask = askFirst(s, p, q);
      if (ask) console.log(ask);
    }
    return console.log(dim('The numbers behind this: dibs why --detail'));
  }
  const order = s.queue.filter(q => q.pid).sort(byRank(hist, t));
  const fc = forecast(s, cfg, hist, t);
  // A wait on the machine has no start time, whatever the slots alone forecast; plain why says the same.
  const p = plainBoard(s, cfg, hist, t);
  for (const q of mine) {
    const v = verdict(s, q, cfg, hist, t);
    const { parts } = rankParts(q, hist, t);
    const w = p.waiting.get(q.id);
    console.log(`${q.res.join(', ')}${q.purpose ? ` ("${q.purpose}")` : ''}: #${order.indexOf(q) + 1} in the queue, `
      + `${w?.startsIn == null && w?.startsText === 'unknown' ? 'start time unknown (it waits on the machine, not a job)' : `expect to start ~${clock(fc.get(q.id) || t)}`}`);
    console.log(`  blocked by ${v.ok ? 'nothing, starting now' : `${v.rule}: ${v.why}`}`);
    if (v.alongside) console.log(`  ${v.alongside}`);
    if (q.holding) console.log(`  holds ${q.holding.res.join(', ')}, so it goes first: ahead of waiters that hold nothing, like high priority (urgent work still goes before it)`);
    console.log(`  place in the queue: arrived ${clock(q.enq)}${parts.map(p => `, ${p.label} ${p.shift > 0 ? '+' : '-'}${dur(Math.abs(p.shift))}`).join('')}`);
  }
}

// dibs mine [res]: what you hold and wait for. Exit 1 if nothing matches, so scripts can ask "do I hold sim?".
export function mine(o, cfg) {
  stamp(o, 'mine');
  const id = caller(o);
  const want = new Set(o.res);
  const match = x => !want.size || x.res.some(r => want.has(r));
  const s = withState(s => s);
  const held = s.leases.filter(l => ours(l, id) && match(l));
  const waiting = s.queue.filter(q => ours(q, id) && match(q));
  if (o.json) { json({ held, waiting }); process.exit(held.length || waiting.length ? 0 : 1); }
  if (!held.length && !waiting.length) {
    console.log(`You don't have ${want.size ? andList(o.res.map(r => named(cfg, r).the)) : 'anything'} and aren't waiting for ${want.size ? 'it' : 'anything'}.`);
    process.exit(1);
  }
  const p = plainBoard(s, cfg, history(), now(), undefined, id);
  // Several jobs from one session read alike; the -m and number tell them apart.
  const reason = x => ` (#${x.id}${x.purpose ? `, "${x.purpose}"` : ''})`;
  for (const l of held) {
    const h = p.held.get(l.id);
    console.log(l.kind === 'hold'
      ? `You've reserved ${andList(l.res.map(r => named(cfg, r).the))}${reason(l)} until ${clock(l.expires)} (${h.endsText}). Give it back: dibs release ${shellRes(l.res.map(r => short(r)))}`
      : `You're ${lower(h.headline)}${reason(l)}: ${l.cmd.slice(0, 50)}, ${h.endsText}.`);
  }
  for (const q of waiting) {
    const w = p.waiting.get(q.id);
    console.log(q.pid ? `You're ${lower(w.headline)}${reason(q)}, ${startPhrase(w)}. Why: dibs why` : `${w.headline}${reason(q)}. Run the same command again within 2 min to keep it.`);
  }
}

// dibs who <res>: who holds it, until when, and who's next.
export function who(o, cfg) {
  if (!o.res.length) return status(o, cfg);
  const hist = history();
  const t = now();
  const s = withState(s => { markIdle(s); return s; });
  const order = s.queue.filter(q => q.pid).sort(byRank(hist, t));
  const rows = [];
  for (const r of o.res) {
    // A file lease is held by whoever holds any path overlapping it.
    // One holder with two overlapping file leases is still one holder.
    const held = s.leases.filter(l => l.res.some(x => clash(x, r))).filter((l, i, all) => all.findIndex(x => x.who === l.who) === i);
    const next = order.filter(q => q.res.some(x => clash(x, r))).map(q => `${q.who} (#${q.id})`);   // the id, for dibs why, boost or stop
    const n = named(cfg, r);
    const room = isFiles(r) ? 'nobody has these files or any that overlap them' : `${resCfg(cfg, r).slots - used(s, r)} of ${resCfg(cfg, r).slots} free`;
    const hold = isFiles(r) ? '' : machineHold(s, cfg);
    // One per project: say whether it's this folder's project holding it, or others, beside which it starts.
    const perProject = !isFiles(r) && resCfg(cfg, r).exclusiveBy === 'repo' && held.length
      ? (roomFor(s, { repo: projectKey(process.cwd()), cwd: process.cwd() }, r, cfg).open > 0 ? ' (other projects: one from this folder starts beside them)' : '')
      : '';
    const using = held.length ? `${usingText(held.map(l => ({ who: l.who, hold: l.kind === 'hold', ...ends(l, hist, t) })), n)}${perProject}` : `free (${room})${hold ? `, but nothing new starts until ${hold}` : ''}`;
    rows.push([n.label, using, next.length ? nextText(next) : 'Nobody waiting',
      ...held.map(l => dim(`${l.who}: ${l.purpose ? `"${l.purpose}", ` : ''}${l.cmd ? `running ${l.cmd.slice(0, 40)}` : 'reserved'}, started ${t - l.start < 6e4 ? 'just now' : `${minutes(t - l.start)} ago`}`
        + `${isFiles(r) ? ` (${s.leases.filter(x => x.who === l.who).flatMap(x => x.res.filter(y => clash(y, r))).map(x => short(x).slice('files:'.length)).join(', ')})` : ''}`))]);
  }
  console.log(columns(rows).join('\n'));
}

// Let another agent go first: they take your place on every resource you both
// want, and any hold you have on what they're waiting for is released.
export function yieldTo(o) {
  const [target, ...rest] = o.res;
  if (!target) die('who should go first? dibs yield <agent>  (names are on the board: dibs)');
  const only = new Set(rest);
  const id = identity(o);
  if (target === id.agent || target === id.who) die("that's you");
  const hist = history();
  const lines = withState(s => {
    const t = now();
    const theirs = s.queue.filter(q => (q.agent === target || q.who === target) && (!only.size || q.res.some(r => only.has(r))));
    if (!theirs.length) return [`${target} isn't waiting for anything${only.size ? ' you named' : ''}. Nothing changed. Who's waiting: dibs`];
    const out = [];
    const want = new Set(theirs.flatMap(q => q.res));
    const holds = s.leases.filter(l => l.kind === 'hold' && isMine(l, id) && l.res.some(r => want.has(r)));
    for (const l of holds) out.push(`Gave back your hold on ${l.res.join(', ')}.`);
    s.leases = s.leases.filter(l => !holds.includes(l));
    const yours = s.queue.filter(q => isMine(q, id));
    const front = Math.min(t, ...s.queue.map(x => rank(x, hist, t))) - 1;
    for (const q of theirs) {
      const shared = yours.filter(m => m.res.some(r => q.res.includes(r)));
      let to = shared.length ? Math.min(...shared.map(m => rank(m, hist, t))) - 1 : null;
      if (holds.some(l => l.res.some(r => q.res.includes(r)))) to = Math.min(to ?? Infinity, front);
      if (to != null && to < rank(q, hist, t)) { q.yieldRank = to; q.yieldBy = id.agent || id.who; out.push(`${tag(q)} now goes before you for ${q.res.join(', ')}.`); }
    }
    if (!out.length) out.push(`${target} is already ahead of you, and you have nothing they need. Nothing changed.`);
    return out;
  });
  for (const l of lines) console.log(l);
}

// dibs ask "...": a request or bug report for whoever maintains dibs.
export function ask(args, cfg) {
  const text = args.filter(a => !a.startsWith('-')).join(' ').trim();
  if (!text) die('ask what? dibs ask "it should ..."');
  const id = identity();
  fs.appendFileSync(REQUESTS, JSON.stringify({ at: now(), who: id.who, agent: id.agent, text }) + '\n');
  const found = answer(text);
  const out = found.length ? ['From the docs:', ...found.map(f => `  ${f.where}:\n${f.text.split('\n').map(l => `    ${l}`).join('\n')}`), ''] : [];
  // Without a maintainer (someone else's machine), the request stays in a file nobody reads: point bugs at the project.
  if (cfg.maintainer) out.push(`Noted for the dibs maintainer, ${cfg.maintainer}.${inClaudeCode() ? ` For a faster answer, SendMessage ${cfg.maintainer}.` : ''}`);
  else out.push(`${found.length ? "If that doesn't answer it, or it's a bug" : "Nothing in the docs matched. If it's a bug or something dibs should do"}, open an issue: ${ISSUES}`);
  console.log(out.join('\n'));
}

export function requests(o) {
  let list = [];
  try { list = fs.readFileSync(REQUESTS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  if (o.json) return json(list);
  if (!list.length) return console.log('no requests yet');
  for (const r of list.slice(-30)) console.log(`${new Date(r.at).toLocaleString()}  ${r.who}: ${r.text}`);
}

// dibs pace [quiet|normal|max|off] [--json]: show or switch how hard dibs drives this machine.
const KNOBS = ['cores', 'budget', 'maxLoad', 'coolLoad', 'roomyLoad', 'roomyMemFree'];
// What `dibs pace --json` prints, for dibs web too.
export function paceJson() {
  const cfg = loadConfig();
  const file = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const hw = hardware();
  return { pace: cfg.pace || null, hardware: { cores: hw.cores, mem: hw.mem }, knobs: Object.fromEntries(KNOBS.map(k => [k, cfg[k] ?? null])),
    pinned: cfg.pace ? paced(file).pinned : [], paces: Object.fromEntries(Object.keys(PACES).map(p => [p, paceKnobs(p, hw)])), overlap: cfg.overlap };
}

export function pace(args) {
  const word = args.find(a => !a.startsWith('-'));
  if (word && word !== 'off' && !PACES[word]) die(`pace is one of ${Object.keys(PACES).join(', ')}, or off. See them: dibs pace`);
  if (word) { writePace(word === 'off' ? null : word); logChange('pace', { pace: word }); }
  const cfg = loadConfig();
  const file = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const pinned = cfg.pace ? paced(file).pinned : [];
  const hw = hardware();
  if (args.includes('--json')) return json(paceJson());
  const machineIs = `this machine (${hw.cores} cores, ${gb(hw.mem).replace(/G$/, ' GB')})`;
  console.log(bold(cfg.pace ? `Speed: ${cfg.pace}, on ${machineIs}.` : 'Speed: not set. dibs uses the numbers in config.json, with no limit on how busy the machine gets.'));
  console.log(wrap(`Side by side: ${sideBySide(cfg)}${file.overlap != null && cfg.pace ? ' (set in config.json, which wins over the speed)' : ''}`));
  if (word) return;
  const WHAT = { quiet: "the fan stays calm; you won't feel it at the Mac", normal: 'the usual numbers, with a limit at 1 job per core', max: 'finish fast: three quarters of memory' };
  const TOGETHER = { off: 'no', fit: 'if they fit', squeeze: 'squeeze in' };
  console.log(`\n${' '.repeat(11)}${'cores'.padEnd(7)}${'memory'.padEnd(8)}${'busy limit'.padEnd(12)}together`);
  for (const p of Object.keys(PACES)) {
    const k = paceKnobs(p);
    const row = `  ${p.padEnd(9)}${String(k.cores).padEnd(7)}${k.budget.replace(/G$/, ' GB').padEnd(8)}${String(k.maxLoad).padEnd(12)}${TOGETHER[PACE_OVERLAP[p]].padEnd(13)}${WHAT[p]}`;
    console.log(p === cfg.pace ? amber(row) : row);
  }
  console.log(`\n${dim(wrap('cores and memory: what jobs dibs starts may use at once, with cores counted as each running job is measured using them.'
    + ' busy limit: past this load, normal and lower work waits. together: whether a job may start next to the ones filling its queue when the machine has room;'
    + ` squeeze in also lets a job that usually takes under ${minutes(ms(loadConfig().squeezeUnder))} start even if it takes the machine past its busy limit.`))}`);
  if (pinned.length) console.log(`Your config.json sets ${andList(pinned)}, which win over the speed. To let the speed decide, remove them from ${paths.config}`);
  console.log('Switch: dibs pace quiet|normal|max   Back to config.json: dibs pace off\nAll six settings: dibs pace --json');
}

// Processes burning CPU that no lease accounts for, grouped by what they run.
// The bar is lower than dibs throttle's (50%): this only reports, it doesn't act.
const BUSY_CPU = 40;   // % of a core
function untracked(s) {
  // Windows reads CPU per process by sampling twice a second apart (platform.mjs): 1.8 s a call
  // on a CI runner, too much for every look at the board, for a line that's only informative.
  if (OS === 'windows') return [];
  const ours = new Set(s.leases.flatMap(l => [l.pgid, ...(l.groups || [])]).filter(Boolean));
  const groups = new Map();
  for (const p of processes()) {
    if (p.cpu < BUSY_CPU || ours.has(p.pgid)) continue;
    // "node audit.mjs" says more than "node".
    const [bin, ...args] = p.args.split(/\s+/);
    const base = path.basename(bin).replace(/\.exe$/i, '');
    if (/^(WindowServer|kernel_task|claude|codex|dibs)$/.test(base)) continue;
    const script = /^(node|python3?|bun|deno|ruby)$/.test(base) ? args.find(a => !a.startsWith('-')) : null;
    const name = script ? `${base} ${path.basename(script)}` : base;
    const g = groups.get(name) || { name, n: 0, cpu: 0 };
    g.n++; g.cpu += p.cpu;
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
}

// What `dibs --json` prints, as an object: the CLI prints it, and dibs web
// serves it from a read of the state taken without the lock (src/state.mjs peek).
// outside: the CPU hogs no lease accounts for, which costs a walk of the process table.
export function boardJson(s, cfg, { hist = history(), m = machine(), t = now(), rc = remoteConf(() => null), away = null, outside = true } = {}) {
  const fc = forecast(s, cfg, hist, t);
  const p = plainBoard(s, cfg, hist, t, m);
  const order = [...s.queue].sort(byRank(hist, t));
  return {
    // The name the group knows this machine by, so the app can tell its own section from the others.
    me: { name: rc?.name || shortHost() },
    machine: { ...m, memHandedOut: sum(s.leases, l => l.mem), memBudget: bytes(cfg.budget), coresHandedOut: sum(s.leases.filter(l => !lent(l)), l => l.cpu ?? 1), cores: cfg.cores,
      pace: cfg.pace, maxLoad: cfg.maxLoad, loadAhead: loadAhead(s, m) },
    resets: s.resets || [],
    held: s.leases.map(l => ({ ...l, remaining: remaining(l, hist, t), idleMs: idleFor(l, t), plain: p.held.get(l.id) })),
    waiting: order.map((q, i) => ({ place: i + 1, ...q, expectStart: fc.get(q.id) || null, rank: rankParts(q, hist, t),
      blocked: q.pid ? waitReason(verdict(s, q, cfg, hist, t)) : null, plain: p.waiting.get(q.id) })),
    lines: p.lines,
    // The board's Limits line, and what holds every new job back ('' when nothing does).
    limits: limitsLine(s, cfg, m), hold: p.hold,
    outside: outside ? untracked(s) : [],
    quotas: quotasNow(s, cfg, t),
    agents: agentsNow(cfg),
    questions: forYou(cfg, t),
    notes: notesForYou(),
    // Agents waiting on dibs listen for a message: dibs tell reaches them within seconds.
    listening: listeners(),
    caps: s.caps || {},
    later: laterBoard(t),
    // What's wrong, each with its fix (src/alerts.mjs): open ones, then those resolved lately.
    alerts: scanAlerts({ s, cfg, hist, m, t }),
    ...(away ? { elsewhere: away } : {}),
  };
}

export async function status(o, cfg) {
  const hist = history();
  const s = withState(s => { markIdle(s); return s; });
  const m = machine();
  const t = now();
  // A broken remote.json still leaves this machine's board worth showing.
  let broken = null;
  const rc = remoteConf(msg => { broken = msg; return null; });
  const away = rc ? await elsewhere(rc) : broken && { error: broken };
  if (o.json) return json(boardJson(s, cfg, { hist, m, t, rc, away }));
  stamp(o, 'status');
  const me = caller(o);
  if (!o.detail) return console.log(plainStatus(s, cfg, hist, m, t, rc, away, broken, me).join('\n'));
  const b = boardOf(s, cfg, hist, t, me);
  // With other machines to show, this one's section gets its name too.
  const others = (away?.machines || []).some(x => x.name !== rc.name);
  const out = [`${others ? `${rc.name} (this one)  ` : ''}${cfg.pace ? `pace ${cfg.pace}, ` : ''}${handedOut(b)}    `
    + `machine: ${m.memFree}% memory free, disk ${m.diskFree == null ? 'unknown' : `${gb(m.diskFree)} free`}, swap ${gb(m.swapUsed)}, load ${m.load.toFixed(1)}`
    + `${cfg.maxLoad != null ? ` (ceiling ${cfg.maxLoad})` : ''}`];
  out.unshift(...alertLines(scanAlerts({ s, cfg, hist, m, t }).filter(a => onBoard(a, t)), t));
  const asks = forYou(cfg, t), notes = notesForYou();
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  if (asks || notes) out.unshift(`${[asks && plural(asks, 'question'), notes && plural(notes, 'note')].filter(Boolean).join(' and ')} for you: dibs ${notes ? 'threads' : 'questions'}`);
  out.push(`limits: ${limitsLine(s, cfg, m)}`);
  const hot = overLoad(s, cfg, m);
  if (hot) out.push(`over the load ceiling: ${loadWhy(hot, cfg)}`);
  const sw = swapping(cfg, m);
  if (sw) out.push(`${sw.rule === 'pressure' ? 'memory pressure' : 'swapping'}: ${swapWhy(sw)}`);
  const squeeze = diskSqueeze(cfg, bytes(cfg.minDisk), m);
  if (squeeze) out.push(`${squeeze.rule === 'drain' ? 'disk filling' : 'disk for swap'}: ${squeeze.why}`);
  if (m.diskFree != null && m.diskFree < bytes(cfg.minDisk)) out.push(`disk: ${gb(m.diskFree)} free, under minDisk ${cfg.minDisk}, so nothing starts`);
  for (const x of s.resets || []) out.push(`resetting ${x.res} after ${x.agent || x.who}'s turn (onRelease, ${dur(t - (x.started || x.at))} so far)`);
  out.push(...boardLines(b, t), ...laterLines(laterBoard(t)));
  const outside = untracked(s);
  if (outside.length) out.push(`busy outside dibs: ${outside.map(x => `${x.name}${x.n > 1 ? ` x${x.n}` : ''} ${Math.round(x.cpu)}%`).join(', ')}`);
  if (broken) out.push(`other machines: ${broken}`);
  else if (away) out.push(...elsewhereLines(away, rc, me, t));
  out.push(`you are ${me.agent || me.who}. Why you're waiting: dibs why. To trade places, ${inClaudeCode() ? 'SendMessage the agent ahead' : 'ask the agent ahead to let you go first'}; they run: dibs yield <your name>`);
  console.log(out.join('\n'));
}

// Plain `dibs`: the one thing that matters most, then what each line is doing,
// for someone who's never seen dibs. `dibs --detail` is the full board, with ids and numbers.
function plainStatus(s, cfg, hist, m, t, rc, away, broken, me) {
  const p = plainBoard(s, cfg, hist, t, m, me);
  const agent = !!me.agent;
  const out = [bold(headline(p))];
  // What's wrong comes before anything else, so it can't be missed.
  const alerted = alertLines(scanAlerts({ s, cfg, hist, m, t }).filter(a => onBoard(a, t)), t);
  if (alerted.length) out.push('', ...alerted, '');
  // An agent reading the board wants its own place first.
  if (agent) {
    for (const q of s.queue.filter(q => q.pid && ours(q, me))) {
      const w = p.waiting.get(q.id);
      out.push(amber(`You: ${lower(w.headline)}, ${startPhrase(w)}. Why: dibs why`));
    }
    for (const l of s.leases.filter(l => ours(l, me))) out.push(`You: ${lower(p.held.get(l.id).headline)}, ${p.held.get(l.id).endsText}.`);
  }
  // Questions and agents' notes (src/talk.mjs) both live in the threads; questions alone have their own list.
  const asks = forYou(cfg, t), notes = notesForYou();
  const count = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  if (asks && !notes) out.push(amber(`${count(asks, 'question')} ${asks > 1 ? 'are' : 'is'} waiting for your answer: dibs questions`));
  else if (notes) out.push(amber(`${[asks && count(asks, 'question'), count(notes, 'note')].filter(Boolean).join(' and ')} ${asks + notes > 1 ? 'are' : 'is'} waiting for you: dibs threads`));
  const ears = listeners();
  if (ears.length) out.push(dim(`Listening for messages (dibs tell reaches them within seconds): ${ears.join(', ')}`));
  const { busy, free } = lineParts(p);
  out.push('', ...columns([...busy.map(b => [b.label, b.now, b.next]), ...(free.length ? [['Free', dim(freeText(p, free))]] : [])]));

  const hot = overLoad(s, cfg, m);
  const others = (away?.machines || []).some(x => x.name !== rc.name);
  // The load average per core: under half, the person at the Mac feels nothing; past one, everything slows down.
  const perCore = m.load / (m.cores || hardware().cores);
  const sw = swapping(cfg, m);
  const diskLow = m.diskFree != null && m.diskFree < bytes(cfg.minDisk);
  const squeeze = diskSqueeze(cfg, bytes(cfg.minDisk), m);
  const GB = b => gb(b).replace(/G$/, ' GB');
  // The same reason the wait lines give (plain.mjs machineHold), worded so nobody reads it as a cue to raise priority.
  const hold = machineHold(s, cfg, m);
  const feel = diskLow ? 'out of disk' : squeeze ? (squeeze.rule === 'drain' ? `disk filling fast (free disk fell ${GB(squeeze.fell)} in 5 min)` : 'short of disk for swap to grow into') : sw ? (sw.rule === 'pressure' ? 'memory pressure is high' : `swapping (swap grew ${gb(sw.grew).replace(/G$/, ' GB')} in 5 min, ${gb(sw.used).replace(/G$/, ' GB')} in use)`) : hot ? 'too busy for new work' : hold ? 'memory fully handed out' : perCore < 0.5 ? 'quiet' : perCore < 1 ? 'busy' : 'very busy';
  const holdBack = hold ? `Nothing new starts until ${hold}. Keep waiting: raising the priority is not the fix` : '';
  const outside = untracked(s);
  const subs = agentsNow(cfg);
  const mine = new Map();
  for (const a of subs?.running || []) mine.set(a.who, (mine.get(a.who) || 0) + 1);
  const rows = [
    [others ? `${rc.name} (here)` : 'This machine', `${feel}: ${m.memFree}% of memory free, `
      + `${m.diskFree == null ? 'free disk unknown' : `${gb(m.diskFree).replace(/G$/, ' GB')} of disk free`}${cfg.pace ? `, speed set to ${cfg.pace}` : ''}`,
      holdBack],
    ['Limits', dim(limitsLine(s, cfg, m))],
    // Busy processes dibs didn't start, which explain a busy machine with nothing in line.
    ...(outside.length ? [['Outside dibs', dim(outside.map(x => `${x.name} (${x.n > 1 ? `${x.n} processes, ` : ''}${(x.cpu / 100).toFixed(1)} cores)`).join(', '))]] : []),
    ...(s.resets || []).map(x => ['Resetting', `${named(cfg, x.res).label}, after ${x.agent || x.who}'s turn`]),
    ...Object.entries(s.caps || {}).map(([who, c]) => ['Capped', `${who}, at ${c.prio} priority, by ${c.by || 'the person at this machine'}`]),
    ...quotasNow(s, cfg, t).map(q => [named(cfg, `quota:${q.name}`).label,
      q.error || `${q.left} of ${q.limit} left, refills to ${q.limit} every ${minutes(q.per).replace(/^1 hr$/, 'hour').replace(/^1 min$/, 'minute')}`]),
    ...(mine.size ? [['Subagents', `${subs.running.length} of ${subs.slots} running (${[...mine].map(([who, k]) => `${k} for ${who}`).join(', ')})`]] : []),
  ];
  // Runs scheduled with dibs later, soonest first: what, then when.
  const later = laterBoard(t).map(v => laterPlain(v, cfg));
  if (later.length) out.push('', ...columns([['Later', ...later.flatMap(x => [x.what, dim(`  ${x.when}`)])]]));
  out.push('', ...columns(rows));
  if (broken) out.push('', wrap(`Other machines: ${broken}`, '  '));
  else if (away) { const x = elsewherePlain(away, rc, cfg); if (x.length) out.push('', ...x); }
  // An agent needs its own name to read the board; the person at the machine doesn't.
  out.push('', dim(agent ? `You're ${me.agent}. Why you're waiting: dibs why. Everything, with ids and numbers: dibs --detail` : 'More: dibs why, dibs --detail'));
  return out;
}
