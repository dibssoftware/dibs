#!/bin/sh
":" //; case "$1" in run|hold) [ "${DIBS_THIN:-}" != 0 ] && ! grep -qsE '"waits"[[:space:]]*:[[:space:]]*"(fat|node)"' "${DIBS_HOME:-$HOME/.dibs}/config.json" && ! { grep -qs '"leases": \[\]' "${DIBS_HOME:-$HOME/.dibs}/state.json" && grep -qs '"queue": \[\]' "${DIBS_HOME:-$HOME/.dibs}/state.json"; } && { f=$0; while [ -L "$f" ]; do l=$(readlink "$f"); case $l in /*) f=$l;; *) f=${f%/*}/$l;; esac; done; exec /bin/sh "${f%/*}/../src/thin.sh" "$f" "$@"; };; esac; exec node --max-semi-space-size=1 "$0" "$@"
// Line 2 is read by sh and ignored by Node (a string, then a comment). sh
// sends run and hold to src/thin.sh unless config.json says "waits": "fat"
// (or "node") or DIBS_THIN=0 is set, and everything else to Node, as before.
// With nothing held and nobody in line it goes straight to Node too: a thin
// wait starts Node twice (to get in line, then to run), 75 ms more, for a wait
// that won't happen.
// dibs: take turns on shared machine resources so parallel agents stop colliding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths, profiled } from '../src/config.mjs';
import { identity } from '../src/proc.mjs';
import { changelog, seenBy, markSeen, newer } from '../src/news.mjs';
import { PRIORITY_SHIFT, PRIORITIES, priority } from '../src/schedule.mjs';
import { VERSION } from '../src/version.mjs';
import { run, notifyOnExit, hold, release, when, why, mine, who, yieldTo, ask, requests, status, freePort, pace, checkNames, nearest } from '../src/commands.mjs';
import { remoteRun, join, machines } from '../src/remote.mjs';
import { sims } from '../src/simpool.mjs';
import { question, questions, answer, hoursCmd } from '../src/questions.mjs';
import { say, tell, threads, noticesFor, listen } from '../src/talk.mjs';
import { bytes, ms, deadline, die, noSpace, fullDisk, setCaller, lastDie, lastDieCode } from '../src/util.mjs';
import { event } from '../src/events.mjs';
import { fileRes, isFiles, resList } from '../src/files.mjs';
import { boost, pause, resume, stop, cap } from '../src/override.mjs';
import { later } from '../src/later.mjs';
import { isQuota } from '../src/quota.mjs';

// Commands no waiting or running dibs needs load when called: a waiter is a
// long-lived process, and each module it never uses costs it memory.
const lazy = name => import(`../src/${name}.mjs`);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `dibs ${VERSION}: agents take turns on this machine's simulator, builds, test runs and deploys.

Wait your turn
  dibs run test -m "why" -- npm test         wait for a turn, run, give it back when it exits
  dibs run sim,xcode-build -- <command>      need two things? ask for both at once
  dibs hold sim --for 20m -m "why"           keep it across several commands, each still in dibs run sim -- <cmd>
                                             (no wait under your hold); give it back: dibs release sim
  dibs hold 'files:src/auth/**' -m "why"     keep other agents' edits off these files
  dibs run test --anywhere -- <command>      on whichever machine in the group starts it soonest (--on <machine>: that one)
  dibs run deploy --quick -- ./ship.sh       a command over in under 15 s starts at once (or --est 10s; dibs learns it after)

Tell the person
  dibs progress "what you did or found" --task <name> --eta 30m    as often as you commit; then --blocked or --done
  dibs question "Ship 123 now?" --options yes,no --recommend yes -m why --one-way "testers get it at once"
                                             only one-way doors reach the person; the same command plus --wait reads the answer
  dibs say "done: tests pass"                an FYI in your thread, no question

Other agents and their jobs
  dibs tell <agent> "..."                    a message that reaches it with its next tool call (or dibs say --to <agent>)
  dibs boost <id> high -m "why"              move a job up (urgent|high|normal|low|idle); --owner <its session> if not yours

Look around
  dibs                                       what each resource is doing and who's next
  dibs why                                   where you are in the queue and what you're waiting for
  dibs when sim                              when you'd get it, without joining the queue
  dibs who sim  |  dibs mine  |  dibs history   who has it, what you have (exit 1: nothing), what happened this week
  dibs yield web-app                         let another agent go first

Set up
  dibs pace quiet|normal|max                 how hard dibs drives this machine
  dibs guard install                         make Claude Code agents use dibs when they forget
  dibs init                                  point your agents' CLAUDE.md and AGENTS.md at dibs.md (install does it)
  dibs machines                              other machines in the group

Priority: -p urgent|high|normal|low|idle (urgent and high need -m "why"). Due by a time: --by 23:30.
Exit 75: your command never ran (you gave up waiting) and didn't fail. Run the same command again within 2 minutes.
Everything else: dibs help all`;

const LATER_HELP = `run it later
  dibs later <res> --at 02:00 -- <cmd>     schedule a run for a time (at most 7 days out); returns at once with its id
  dibs later <res> --in 3h -- <cmd>        ...or a while from now
  dibs later <res> --after <what> -- <cmd> ...or when something ends: #42 on the board, an agent (web-app, or web-app:deploy
                                           for its deploy), or an earlier later job (l3). --after-ok: only if it succeeded
                                           When due, it runs as dibs run --wait with your flags, in this folder, with PATH,
                                           HOME and LANG (more with --env NAME). Output: ~/.dibs/later/<id>.log
  dibs later list [--json]                 scheduled, waiting, running, and how the finished ones ended
  dibs later cancel <id>                   drop it, or stop it if it's running`;

const HELP_ALL = `dibs ${VERSION}: take turns on shared machine resources.

get a turn
  dibs run <res>[,<res>] [flags] -- <cmd>   wait for the resources, run cmd, release when it exits
  dibs run <res> --after #42 -- <cmd>      ...but join the line only once job #42 has ended
  dibs hold <res> [--for 20m]              keep a resource across several tool calls (max 1h); again to extend
  dibs release [<res>]                     give back your holds
  dibs hold 'files:src/auth/**' -m "why"    keep other agents' edits off these paths (from the git root; * ** ?; quote it)

ask without joining the queue
  dibs [--detail]                          the board: what each resource is doing and who's next (--detail: ids and numbers)
  dibs who <res>                           who holds it, until when, who's next
  dibs when <res>[,<res>]                  when you'd get it if you asked now
  dibs why [--detail]                      why you're waiting, in sentences (--detail: how your place was worked out)
  dibs mine [<res>]                        what you hold and wait for (exit 1 if nothing: "do I hold sim?")
  dibs alerts [--json] [--all]             what's wrong, each with its fix: long waits, memory holding work back, stuck or failed
                                           jobs, dibs's services and hook, a full disk. dibs alerts dismiss <id|all> closes one for a day
  dibs history [--since 7d] [--json]       what happened: busy time, waits and who waited, by resource, agent and hour
  dibs stats [--json]                      waits against run times, today and the last 7 days: median and 90% by resource
  dibs stats --me | --agent <name> [--since 30d] [--json]
                                           per agent and resource: run and wait time, failures by exit code, what held
                                           jobs back, top commands, ETAs met, the machine's load and memory over time

${LATER_HELP}

work with other agents
  dibs yield <agent> [<res>]               let another agent go first (and release your hold on what they need)
  dibs ask "..."                           send a request or bug report to whoever maintains dibs

ask the person (one-way doors only)
  dibs question "..." --recommend <option> -m why [--options a,b] [--one-way "what can't be undone"] [--wait]
                                           without --one-way: decided at once with your recommendation (printed on
                                           stdout, logged, shown to the person as done). With it: queued for the person;
                                           --wait prints only the answer; --timeout 1m caps the wait (exit 75: no answer
                                           by then, or dismissed; a question asked first without --wait stays open for the person)
  dibs questions [--json]                  open questions first, by priority then age
  dibs answer <id> <text>                  answer one with an option or any words (words reach the asker as a message too)
  dibs questions dismiss <id>              dismiss one; its waiting agent gets exit 75
  dibs hours [09:00-23:00|off] [--json]    the person's hours: outside them, questions below urgent wait for morning
  dibs say "..." [--as label] [--to person] an FYI to the person in your thread: progress, done, blocked on X.
                                           --to person: a reply to what they said (the desk's answers); --to <agent>: a message to that agent,
                                           the same as dibs tell

progress (post as often as you commit)
  dibs progress "..." [--task <name>] [--eta 30m|17:30] [--done|--blocked]
                                           what you just did, found or decided, in a sentence or a paragraph. The person
                                           reads every post live; other agents read them too. Post at each step, not at the end
  dibs progress [--agent <name>] [-n 50] [--json]   recent posts
  dibs progress list [--all] [--json]      your session's open tasks (--all: every session's), owner, state, ETA, last post

the person's page and MCP server
  dibs web [--port 7421] [--bind <address>] every agent's jobs, tasks and posts at http://127.0.0.1:7421, and the same as
                                           MCP tools at /mcp (read-only unless signed in with --allow-actions). dibs service install web keeps it up
  dibs connect                             connect a browser, a phone, your dibs account, another Claude's MCP or another
                                           machine: it explains each, and on a terminal asks which
  dibs connect --list | --remove <id>      everything connected to this Mac; disconnect one
  dibs connect --approve <code>            let a new browser of your dibs account in: the 6 digits it shows
  dibs connect --accounts [--json]         the dibs accounts this Mac is on, and the browsers waiting for its approval
  dibs connect --refuse <id>               turn down a waiting browser (its id from dibs connect --accounts)
  dibs pair                                a one-time code to sign the page or an MCP client in (10 minutes, one use)
  dibs pair --allow-actions                a code that also lets an MCP client act: post progress, answer, message agents, hold,
                                           boost, pause, resume and stop jobs, as an agent named after it (mcp-<name>)
  dibs pair --allow-commands               all that, and queue_run: commands to run on this Mac, as dibs later. Only on this
                                           Mac's own MCP (127.0.0.1:7421/mcp), never through mcp.dibs.cc
  dibs pair --list | --revoke <id|all>     what's signed in (MCP clients: can act or look only; on the coordinator, its machines)
  dibs pair --machine [--name x]           on the coordinator: a one-time code another machine joins with (10 minutes, one use);
                                           dibs pair --revoke <machine> removes one that joined
  dibs pair --remote [--allow-actions]     a one-time link and QR code to pair a phone or any browser with https://app.dibs.cc,
                                           end-to-end encrypted through the relay (dibs service install relay keeps it connected).
                                           It can only look unless --allow-actions; the hook and hours never change remotely
  dibs relay [--url wss://app.dibs.cc]     the relay connection itself, in the foreground
  dibs relay mcp on|off                    let MCP clients (another Claude account's connectors) reach this Mac's read-only MCP at
                                           https://mcp.dibs.cc/mcp through the relay, signing in with a dibs pair code. Off by default

talk with your agents
  dibs threads [--json]                    one thread per agent: its notes, questions, and your messages
  dibs threads read <agent>                the conversation; marks its notes read
  dibs tell <agent> "..."                  a message for that agent: it gets it with its next tool call, or as it
                                           finishes its turn (needs dibs guard install). From an agent, it says which agent sent it
  dibs tell desk "..."                     to the agent config.json names as "desk": it answers with dibs say --to person
  dibs listen [--for 60m] [--json]         waits until a message, an answer or a notice is queued for you, prints all of it
                                           and exits 0 (exit 3: none in time). Start it with run_in_background at the start of
                                           a session and again each time it exits: its exit wakes you even while idle

several machines
  dibs run <res> --anywhere -- <cmd>       run it on whichever machine would start it soonest (maybe this one)
  dibs run <res> --on <machine> -- <cmd>   run it on that machine
  dibs machines                            every machine, its load and line, and the jobs moving between them
  dibs serve                               be the coordinator (one machine does this); then dibs pair --machine or dibs invite <machine>
  dibs join <code> [--at <address>]        join with a code from dibs pair --machine: finds the coordinator on this network
                                           or through Tailscale (--at when it's elsewhere), then dibs service install worker
  dibs join <url> <token> [--name x]       connect this machine to a coordinator with a line from dibs invite
  dibs worker                              take jobs here (dibs service install worker keeps it running)
  dibs leave                               this machine out of its group: it stops taking jobs and forgets the coordinator.
                                           On the coordinator, only once no other machine is joined (dibs kick each first)
  dibs invite <machine>                    on the coordinator: a token for that machine, and the join line to run there
  dibs kick <machine>                      on the coordinator: remove it now; its jobs stop and its token stops working
  dibs limit <machine> --only test,heavy   on the coordinator: the only jobs it takes from others (--any lifts it)
  dibs limit <machine> --sends test|none   on the coordinator: the only jobs it may send to other machines
  .dibs.json {"stayOn": ["mini"]}          at a project's root: the machines its code may go to (besides its own)
  dibs service install|remove|status [serve] [worker] [throttle] [web] [relay]   start them at login and keep them up
  join, leave, invite, kick, limit, service, guard install/remove, pace, hours and cap go in the history with who ran them

priorities and pauses (ids are the #numbers on dibs --detail; anyone, person or agent, on any job; the board names who.
  An agent acting on a job that isn't its own adds --owner <session>, or session/agent, as the board names it)
  dibs boost <id|agent> <prio> [-m why]    change a waiter's or running job's priority: re-ranks it, and moves a run
                                           onto or off the efficiency cores (an agent name changes all its work).
                                           An agent raising a job to high or urgent passes -m, which everyone sees
  dibs pause <id> [--force] [-m why]       freeze a running job where it stands; it keeps its lease (sim, xcode-build
                                           and deploy need --force: frozen midway they can fail)
  dibs resume <id> [-m why]                continue a paused job
  dibs stop <id> [-m why]                  end a job and kill its processes, as a crash would; its agent is told
  dibs cap <agent> <prio|off>              that agent's work never waits or runs above prio until off

other
  dibs port                                print a free port
  dibs sims [prune]                        the simulators behind sim-own; prune deletes the idle ones
  dibs pace [quiet|normal|max|off]         how hard dibs drives this machine: quiet keeps the fan calm, max finishes fast
  dibs throttle [--watch]                  move CPU hogs running outside dibs to background priority when the machine is hot
  dibs setup scratch [--size 40G]          print the one-time commands for a capped volume for build output (--check: how full)
  dibs changes                             what changed in recent versions
  dibs guard install|remove|status|check   a Claude Code hook that runs heavy commands through dibs when an agent forgets
  dibs init [--repo] [--remove]            write dibs.md (the agent instructions) and a note pointing at it in ~/.claude/CLAUDE.md,
                                           ~/.codex/AGENTS.md and this repo's CLAUDE.md and AGENTS.md (install does it; --repo makes
                                           this repo's CLAUDE.md; --remove takes it all out; DIBS_NO_AGENT_NOTES=1 skips it)

flags
  -m "why"          shown to everyone (required with urgent and high)
  -p <level>        priority, how far it moves you in the queue:
                      urgent (1)  2 hr ahead     something is broken or a person is waiting now
                      high   (2)  1 hr ahead     on the critical path
                      normal (3)  arrival order
                      low    (4)  10 min back    nobody is waiting on it; runs at background priority
                      idle   (5)  60 min back    only when nobody else waits; runs at background priority
                    low and idle runs may be paused (not killed) for urgent or high work, or under memory pressure
  --by 23:30|20m    deadline: as it nears you move up the queue (up to an hour), and you're warned if it's at risk
  --est 5m          how long the job takes, when dibs has no history for it. Short jobs move up a little
  --quick           it takes under 15 s (quickUnder): it starts at once, past the line and full slots, at most 2 at a time.
                    On the simulator, or a deploy of the same repo, it goes to the front of the line instead. Trusted the
                    first time; a run that goes over loses the pass until it runs under again. A command dibs has seen run
                    under 15 s gets it without the flag
  --cost 3          tokens a quota:<name> job takes from its bucket (default 1)
  --mem 4G          memory the job needs (default from the resource). dibs measures what it really uses
                    and plans the next run at that when it's more
  --cpu 2           cores the job keeps busy (default from the resource)
  --disk 10G        free disk the job needs
  --port NAME       put a free port in env NAME for the command (repeatable)
  --wait            wait in the queue as long as it takes. The default inside Claude Code, which moves a
                    tool call that reaches its timeout to the background instead of killing it
  --max-wait 8m     stop waiting after this with exit 75. The default (8m) everywhere else
  --no-wait         don't wait at all
  --notify <file>   when dibs exits, append one JSON line to file: {"code", "started", "res", "cmd", ...}
  --as label        a label shown next to your agent name (for subagents)
  --json            machine-readable output (board, when, mine, requests, machines, history, questions, threads, hours, pace, guard status)
  --anywhere        send it to the least busy machine (see "several machines")
  --shards N        split a playwright test, vitest or node --test run into N pieces across machines, output and exit codes merged.
                    vitest and node --test suites that usually take over 5 minutes split in two on their own; --no-shard keeps one
  --on <machine>    send it to that machine
  --bring <path>    with --anywhere/--on: copy this file or folder back when the job ends (repeatable)

Your place in the queue is your arrival time, moved by priority, a near deadline, a short known run time
(up to 5 min), heavy use of the same resource in the last hour (up to 10 min back), and already holding a
lease (like high). dibs why says which moved you; dibs why --detail shows the math.

Agents are listed by session name, the same name SendMessage uses.
Resources: sim, sim-own, xcode-build, playwright, test, deploy, heavy, or any name you make up (use the same one as others).
quota:<name> is a rate limit shared by every script here (config.json "quotas": {"asc": {"per": "1h", "limit": 300}}):
a job waits until its bucket has --cost tokens, so scripts calling one API wait instead of getting 429s.
Subagents: with dibs guard installed, at most agents.slots (default 8) run at once across every Claude Code
session here. A spawn past that is denied, unless the session has none running; wait for one of yours to finish.
A profile is a name for a resource with its ports and sizes, set once in config.json "profiles":
{"playwright:web": {"res": "playwright", "ports": ["WEB", "API"], "mem": "3G", "cpu": 2}}, then dibs run playwright:web -- <command>.
files:<path or glob> is a file lease: while you hold it, dibs guard turns away other sessions' edits and writes there.
sim is the one shared booted simulator. sim-own boots a private one for your command: its udid is in $SIM, its name in $SIM_NAME.
Exit codes: the command's own, or 75 gave up waiting (NOT a failure: your command never started; run the
same command again within 2 minutes to keep your place), 74 not enough disk,
76 lost the coordinator or the other machine before the job started (safe to send again),
77 lost it after the job started on another machine (it may have run: check before running it again),
127 command didn't start, 2 bad usage (also: you already have this exact command waiting or running),
1 nothing matched (mine, release), 3 dibs listen heard nothing in time, 70 dibs itself crashed (a bug in dibs; report it: dibs ask "...").
A job sent to another machine takes the git working copy (tracked files plus new ones git doesn't ignore;
outside git, the folder minus build output). .env files, keys and certificates never leave this machine.
Config: ${paths.config}`;

function parse(argv) {
  const o = { res: [], cmd: null, ports: [], bring: [] };
  const dd = argv.indexOf('--');
  if (dd >= 0) { o.cmd = argv.slice(dd + 1); argv = argv.slice(0, dd); }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === '-m' || a === '--msg') o.purpose = next();
    else if (a === '-p' || a === '--priority') { o.prio = priority(next()); if (!(o.prio in PRIORITY_SHIFT)) die(`priority is one of ${PRIORITIES.join(', ')} (or 1-5)`); }
    else if (a === '--by') o.by = deadline(next());
    else if (a === '--est') o.est = ms(next());
    else if (a === '--quick') o.quick = true;
    else if (a === '--cost') { o.cost = Number(next()); if (!(o.cost > 0)) die('--cost takes a number of tokens above 0'); }
    else if (a === '--mem') o.mem = bytes(next());
    else if (a === '--cpu') { o.cpu = Number(next()); if (!(o.cpu >= 0)) die('--cpu takes a number of cores'); }
    else if (a === '--disk') o.disk = bytes(next());
    else if (a === '--max-wait') o.maxWait = ms(next());
    else if (a === '--no-wait') o.maxWait = 0;
    else if (a === '--wait') o.maxWait = Infinity;
    else if (a === '--notify') o.notify = next();
    else if (a === '--for') o.for = ms(next());
    else if (a === '--lease') o.lease = Number(next());   // src/thin.sh's, on its turn
    else if (a === '--after') o.after = next();
    else if (a === '--since') o.since = next();
    else if (a === '--as') o.as = next();
    else if (a === '--port') o.ports.push(next());
    else if (a === '--json') o.json = true;
    else if (a === '--detail') o.detail = true;
    else if (a === '--watch') o.watch = true;
    else if (a === '--anywhere') o.anywhere = true;
    else if (a === '--shards') { o.shards = Number(next()); if (!(Number.isInteger(o.shards) && o.shards >= 1 && o.shards <= 8)) die('--shards takes how many pieces to split a suite into, 1 to 8 (1: none)'); }
    else if (a === '--no-shard') o.shards = 1;
    else if (a === '--on') o.on = next();
    else if (a === '--bring') o.bring.push(next());
    else if (a === '--name') o.name = next();
    else if (a === '--at') o.at = next();
    else if (a === '--ephemeral') o.ephemeral = true;   // a worker on an on-demand VM (src/ondemand.mjs)
    else if (a === '--listen') { o.listen = Number(next()); if (!(o.listen > 0 && o.listen < 65536)) die('--listen takes a port number'); }
    else if (a === '--bind') o.bind = next();
    else if (a === '--only') { o.only = next().split(',').filter(Boolean); if (!o.only.length) die('--only takes resource names, e.g. --only test,heavy'); }
    else if (a === '--any') o.any = true;
    else if (a === '--sends') { const v = next(); o.sends = v === 'none' ? [] : v.split(',').filter(Boolean); if (v !== 'none' && !o.sends.length) die('--sends takes resource names, e.g. --sends test,heavy, or none'); }
    else if (a === '--force') o.force = true;
    else if (a === '--size') o.size = next();
    else if (a === '--check') o.check = true;
    else if (a.startsWith('-')) die(`unknown flag ${a}. Every flag: dibs help all`);
    else o.res.push(...resList(a).map(r => fileRes(r) ?? die("files: needs a path or glob, e.g. 'files:src/auth/**'")));
  }
  return o;
}

// The first time each agent session runs a new version, one line pointing at
// what changed. Only for an agent that ran an older one here: a brand-new
// install, or a session that never ran dibs before, has nothing to compare.
// Written to stderr, so it never lands in output a script reads.
function announce() {
  const id = identity();
  const key = String(id.spid || id.who);
  const before = seenBy(key);
  // Already heard of this one, or of a newer one (a dibs listen told it of an update this older
  // process hasn't been replaced by yet): nothing to say, and never move it back.
  if (before === VERSION || (before && newer(before, VERSION))) return;
  markSeen(key, VERSION);
  if (before) process.stderr.write(`dibs was updated to ${VERSION}: see \`dibs changes\`\n`);
}

// An npm install has no install script (the package runs none, by design), so the first
// command after an install or upgrade writes dibs.md and the agents' notes (src/notes.mjs).
// Only from node_modules: a checkout or install.sh's folder has dibs init and install.sh.
async function npmNotes() {
  if (!ROOT.split(path.sep).includes('node_modules')) return;
  try {
    const notes = await lazy('notes');
    if (!notes.stale()) return;
    for (const f of notes.write()) process.stderr.write(`dibs: wrote ${f}\n`);
  } catch (e) { process.stderr.write(`dibs: couldn't write dibs.md or the agents' notes (${e.message}). dibs init tries again\n`); }
}

// A caller with no hook to hand it notices (outside Claude Code) gets them here.
function notices() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return;
  const n = noticesFor(identity().who);
  if (n) process.stderr.write(`${n}\n`);
}

// Old names keep working, so nothing that already calls dibs breaks.
const ALIASES = { done: 'release', renew: 'hold', news: 'changes', cool: 'throttle', ls: 'status', board: 'status' };
const VERBS = new Set(['run', 'hold', 'release', 'when', 'why', 'mine', 'who', 'yield', 'ask', 'requests', 'port', 'throttle', 'changes', 'status', 'help',
  'machines', 'serve', 'join', 'leave', 'worker', 'service', 'invite', 'kick', 'limit', 'guard', 'sims', 'pace', 'setup', 'history', 'stats',
  'question', 'questions', 'answer', 'hours', 'say', 'tell', 'threads', 'listen', 'boost', 'pause', 'resume', 'stop', 'cap', 'later',
  'progress', 'web', 'pair', 'relay', 'connect', 'alerts', 'init']);

// A job sent from another machine ends when the worker that started it does,
// even if the worker was killed outright and couldn't say so.
function followParent() {
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.kill(process.pid, 'SIGTERM'); }, 2000).unref();
}

// A suite split across machines (src/shard.mjs), or null: --shards N, or on its own
// for a vitest or node --test suite that usually takes over 5 minutes, with an
// on-demand machine to send the other half to.
async function shardsFor(o, cfg) {
  if (!o.cmd?.length || o.shards === 1 || o.anywhere || o.on || o.lease || o.after || process.env.DIBS_SHARD) return null;
  const { sharder, runShards, AUTO_OVER, AUTO_SHARDS } = await lazy('shard');
  const split = sharder(o.cmd);
  if (!split) { if (o.shards > 1) die(`--shards splits a playwright test, vitest or node --test run, which this isn't: ${o.cmd.join(' ')}`); return null; }
  const { ondemandOf } = await lazy('ondemand');
  let vm = null;
  try { vm = ondemandOf(cfg).find(m => !m.temp)?.name || null; } catch {}
  let n = o.shards;
  if (!n && vm && split.which !== 'playwright') {
    const { typical } = await import('../src/schedule.mjs');
    const { history } = await import('../src/state.mjs');
    const { commandKey } = await lazy('acquire');
    if (typical(history(), `${o.res.join(',')}|${commandKey(o.cmd)}`) > AUTO_OVER) n = AUTO_SHARDS;
  }
  return n > 1 ? () => runShards(o, n, split, vm) : null;
}

async function main() {
  let argv = process.argv.slice(2);
  // Not for thin waits' own calls (_enqueue, _broker, _rewait, _leave): the broker follows
  // a remote job's worker for its waiter, and the broker outlives whoever started it.
  if (process.env.DIBS_REMOTE_JOB && !String(argv[0]).startsWith('_')) followParent();
  let verb = argv[0];
  if (verb === '--version' || verb === '-v' || verb === 'version') return console.log(VERSION);
  if (verb === '-h' || verb === '--help') verb = 'help';
  verb = ALIASES[verb] || verb;
  if (verb === 'help') return console.log(argv[1] === 'all' ? HELP_ALL : HELP);
  if (verb === 'changes') return console.log(changelog().slice(0, 3).map(c => `${c.version}\n${c.body}`).join('\n\n'));
  // The hook runs on every Bash call: no config file writes, no what's-new notice.
  if (verb === 'guard') {
    if (argv[1] === 'install' || argv[1] === 'remove') (await import('../src/owner.mjs')).logChange(`guard ${argv[1]}`);
    return (await lazy('guard')).guard(argv.slice(1));
  }
  // src/thin.sh's own calls, not commands anyone types (src/broker.mjs).
  if (verb === '_broker') return (await import('../src/broker.mjs')).broker();
  // The Mac app's reader: its polls, answered by one process that stays up (src/reads.mjs).
  if (verb === '_reads') return (await import('../src/reads.mjs')).reads(readOne);
  if (verb === '_rewait') { if (!(await import('../src/broker.mjs')).ensureBroker()) process.exitCode = 1; return; }
  if (verb === '_leave') return (await import('../src/broker.mjs')).leaveLine(Number(argv[1]), Number(argv[2]), argv[3]);
  let thin = null;
  if (verb === '_enqueue') {
    thin = (await import('../src/broker.mjs')).thinCall(Number(argv[1]), argv[3]);
    // Node's parent is the waiting shell; the caller, for twins and nesting, is the shell's parent.
    setCaller(Number(argv[2]));
    process.argv.splice(2, 4);   // the command as typed, for the line that says how to run it again
    argv = process.argv.slice(2);
    verb = argv[0];
  }
  calledVerb = verb;
  const cfg = loadConfig();
  // Services, jobs sent from another machine and scheduled ones have nobody to read the notes.
  // A thin waiter's turn has had them already, when it got in line.
  const lease = argv.slice(0, argv.indexOf('--') >>> 0).includes('--lease');
  if (!process.env.DIBS_REMOTE_JOB && !process.env.DIBS_LATER_JOB && !lease && !['serve', 'worker', 'service', 'relay', 'init'].includes(verb)) { announce(); notices(); }
  if (verb !== 'init') await npmNotes();
  // `dibs sim -- cmd` (no verb) means run; a bare `dibs` or `dibs --json` is the board.
  // `dibs -m why sim -- cmd` is a run too: anything with a command after -- is.
  if (!verb || (verb.startsWith('-') && verb !== '--' && !argv.includes('--'))) return status(parse(argv), cfg);
  if (!VERBS.has(verb) && !argv.includes('--') && !cfg.resources[verb] && !isFiles(verb) && !isQuota(verb)) {
    // `dibs list`, `dibs stauts`: a command that doesn't exist, not a run missing its --.
    const near = nearest(verb, [...VERBS, ...Object.keys(ALIASES)]);
    die(`unknown command ${verb}.${near ? ` Did you mean dibs ${near}?` : ''} Commands: dibs help. To run something: dibs run <resource> -- <command>`);
  }
  const rest = VERBS.has(verb) ? argv.slice(1) : argv;
  if (!VERBS.has(verb)) verb = 'run';
  switch (verb) {
    case 'run': {
      const o = profiled(parse(rest), cfg);
      if (o.bring.length && !o.anywhere && !o.on) die('--bring only means something with --anywhere or --on');
      if ((o.anywhere || o.on) && o.res.some(isFiles)) die("file leases cover this machine's files. Take them here (dibs hold files:...), then send the job without them");
      if (o.after && (o.anywhere || o.on)) die('--after works for a run on this machine; for another, use dibs later --after');
      checkNames(o.res, cfg);
      const shards = await shardsFor(o, cfg);
      // Paths thin waits don't cover: a shell's Node hands back to it to wait in Node; one already
      // the shell's own Node (src/broker.mjs inlineCall) just goes on here.
      if (thin?.inline && (shards || o.anywhere || o.on || o.after)) thin = null;
      if (shards) { if (thin) return thin.fat(); notifyOnExit(o); return shards(); }
      // Waiting thin covers a plain run here: the rest wait in-process.
      // A run sent to another machine waits there (thin, through its worker); --after waits outside the line.
      if (thin && (o.anywhere || o.on || o.after)) return thin.fat();
      o.thin = thin;
      notifyOnExit(o);
      return o.anywhere || o.on ? remoteRun(o, cfg) : run(o, cfg);
    }
    case 'machines': return machines(parse(rest));
    case 'serve': return (await lazy('serve')).serve(parse(rest));
    case 'join': return join(parse(rest));
    case 'worker': return (await lazy('worker')).worker(parse(rest), cfg);
    case 'invite': return (await lazy('admin')).invite(parse(rest));
    case 'kick': return (await lazy('admin')).kick(parse(rest));
    case 'leave': return (await lazy('admin')).leave();
    case 'limit': return (await lazy('admin')).limit(parse(rest));
    case 'service': return (await lazy('service')).service(rest);
    case 'hold': { const o = profiled(parse(rest), cfg); if (o.notify || o.after) die(`${o.notify ? '--notify' : '--after'} works with dibs run`); checkNames(o.res, cfg); o.thin = thin; return hold(o, cfg); }
    case 'release': return release(parse(rest));
    case 'when': { const o = profiled(parse(rest), cfg); checkNames(o.res, cfg); return when(o, cfg); }
    case 'why': return why(parse(rest), cfg);
    case 'mine': return mine(parse(rest), cfg);
    case 'who': return who(parse(rest), cfg);
    case 'yield': return yieldTo(parse(rest));
    case 'ask': return ask(rest, cfg);
    case 'requests': return requests(parse(rest));
    case 'port': return console.log(await freePort());
    case 'throttle': return (await lazy('cool')).throttle(parse(rest), cfg);
    case 'status': return status(parse(rest), cfg);
    case 'sims': { const o = parse(rest); return sims(o, o.res, cfg); }
    case 'pace': return pace(rest);
    case 'setup': { const o = parse(rest); return (await lazy('scratch')).setup(o.res, o); }
    case 'history': return (await lazy('history')).history(parse(rest), cfg);
    case 'stats': return (await lazy('stats')).stats(rest, cfg);
    case 'alerts': return (await lazy('alerts')).alerts(rest, cfg);
    case 'question': return question(rest, cfg);
    case 'questions': return questions(rest, cfg);
    case 'answer': return answer(rest);
    case 'hours': return hoursCmd(rest, cfg);
    case 'say': return say(rest);
    case 'progress': return (await lazy('progress')).post(rest);
    case 'web': return (await lazy('web')).web(rest);
    case 'pair': return (await lazy('web')).pair(rest);
    case 'connect': return (await lazy('connect')).connect(rest);
    case 'init': return (await lazy('notes')).init(rest);
    case 'relay': return (await lazy('relay')).relay(rest);
    case 'tell': return tell(rest);
    case 'threads': return threads(rest);
    case 'listen': return listen(rest);
    case 'boost': return boost(rest, cfg);
    case 'pause': return pause(rest, cfg);
    case 'resume': return resume(rest);
    case 'stop': return stop(rest);
    case 'cap': return cap(rest);
    case 'later': return /^(help|-h|--help)$/.test(rest[0] || '') ? console.log(LATER_HELP) : later(rest, cfg, parse);
  }
}

// One of the CLI's read-only verbs, exactly as main() runs it, for the Mac app's
// reader. Anything else is refused: the reader never changes anything.
const COUNT = /^\d{1,5}$/;
async function readOne(argv) {
  const cfg = loadConfig();
  const [verb, ...rest] = argv;
  const only = (...want) => rest.length === want.length && want.every((w, i) => (w instanceof RegExp ? w.test(rest[i]) : w === rest[i]));
  if (verb === '--version' && !rest.length) return console.log(VERSION);
  if (verb === '--json' && !rest.length) return status(parse(argv), cfg);
  if (verb === 'questions' && only('--json')) return questions(rest, cfg);
  if (verb === 'threads' && only('--json')) return threads(rest);
  if (verb === 'progress' && (only('--json') || only('--json', '-n', COUNT))) return (await lazy('progress')).post(rest);
  if (verb === 'later' && only('list', '--json')) return later(rest, cfg, parse);
  if (verb === 'history' && only('--json', '--since', /^\d+[mhd]$/)) return (await lazy('history')).history(parse(rest), cfg);
  if (verb === 'stats' && rest[0] === '--json' && (only('--json', '--since', /^\d+[mhd]$/) || only('--json', '--since', /^\d+[mhd]$/, '--agent', /^[^-]/)))
    return (await lazy('stats')).stats(rest, cfg);
  if (verb === 'guard' && only('status', '--json')) return (await lazy('guard')).guard(rest);
  if (verb === 'pace' && only('--json')) return pace(rest);
  if (verb === 'pair' && only('--list')) return (await lazy('web')).pair(rest);
  if (verb === 'connect' && only('--accounts', '--json')) return (await lazy('connect')).connect(rest);
  if (verb === 'service' && rest[0] === 'status' && rest.slice(1).every(k => /^[a-z]+$/.test(k))) return (await lazy('service')).service(rest);
  if (verb === 'sims' && only('--json')) { const o = parse(rest); return sims(o, o.res, cfg); }
  die(`the app's reader answers only the read-only verbs, not dibs ${argv.join(' ')}`, 2);
}

// A crash gets a code of its own (70, EX_SOFTWARE), never one an agent reads as
// "nothing matched" (1) or as its command's own failure.
const CRASHED = 70;
const crash = e => die(`dibs itself crashed (a bug in dibs, not in your command; exit ${CRASHED}). Report it: dibs ask "..."\n${e?.stack || String(e)}`, CRASHED);
// A full disk is no bug: say what to do, with the exit code agents know (74), not a stack.
const fail = e => (noSpace(e) ? die(fullDisk(e), 74) : crash(e));
process.on('uncaughtException', fail);

// A job lost on its way to or on another machine (76, 77) and dibs's own crash
// (70) go in the event log, so the person hears of them (src/alerts.mjs), not
// only the agent whose tool call ended.
let calledVerb = '';
process.on('exit', code => {
  if (code !== lastDieCode || !(code === CRASHED || ((code === 76 || code === 77) && calledVerb === 'run'))) return;
  try {
    event({ kind: code === CRASHED ? 'crash' : 'lost', code, verb: calledVerb, who: identity().who,
      cmd: process.argv.slice(2).join(' ').slice(0, 160), why: lastDie.split('\n')[0].slice(0, 300) });
  } catch {}
});
main().catch(fail);
