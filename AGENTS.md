# Working on dibs

dibs queues shared machine resources between AI agents: simulators, Xcode builds, browser suites, test runs, deploys, a person's attention later. It also sends jobs between machines. README.md says what it does for its users. This file says how to change it without breaking the agents that depend on it.

## A checkout can be production

If the `dibs` on your PATH is a link into a git checkout (`~/bin/dibs` -> `~/dibs/bin/dibs.mjs`, say), that checkout is production. Every agent on the machine runs whatever is on disk there on its next call, and the services (`dev.dibs.serve`, `dev.dibs.worker`, `dev.dibs.throttle` under launchd) run it too. A syntax error there breaks every session at once.

- Work in a worktree on a branch (`git -C ~/dibs worktree add ~/dibs-<topic> -b <topic>`), never in the checkout agents run.
- `main` only moves at a release (below).
- Never touch the live state in `~/.dibs`, the services, or `~/.claude/settings.json` from tests or experiments. Use a temp `DIBS_HOME`.

## Rules that don't bend

- **No dependencies.** Node built-ins only, on Node 22.23.4, 24.22.1, 26.12.1 or newer (src/nodecheck.mjs: older lines have the Brotli hole CVE-2026-111497). No build step. `package.json` is only for distribution (`npm i -g @dibssoftware/dibs`): no dependencies, no scripts, ever. If you want a library, write the 30 lines you actually need.
- **The lease ends when the command ends.** Exit, crash or kill -9: the lease is released and the process tree is killed (or resumed and killed, if paused). Any new state must be reaped the same way, on the next state read, by whoever reads it.
- **State stays compatible.** Agents on the old version and the new one share `~/.dibs/state.json` during a rollout. New fields are optional; never rename or repurpose one.
- **Exit codes are an API.** The command's own code, or 75 timed out waiting (did not run), 74 not enough disk, 76 lost the coordinator or remote machine before the job started (safe to send again), 77 lost it after the job started on another machine (it may have run; check before rerunning), 70 dibs itself crashed (a bug in dibs, never the command's failure), 127 command didn't start, 2 bad usage, 1 nothing matched. Agents branch on these. A new one goes in DIBS_CODES (src/commands.mjs), `dibs help all`, the table in docs/reference.md and SKILL.md's reference table. The session primer names only 75 and 74, the two agents hit.
- **Never signal what dibs didn't start.** Check `pstart` before killing, stopping or resuming a pid or group. Pids and pgids get reused.
- **Never delete what dibs didn't create.** Simulators: only `dibs-pool-*`. Folders: only `~/.dibs/work` copies. Nothing under Claude Code's temp folders (`/private/tmp/claude-*`). One exception, the person's (2026-10-20): under twice the disk floor, src/diskwarn.mjs clears caches that rebuild themselves (npm's and Homebrew's caches, simulators simctl calls unavailable, DerivedData folders no build has touched in a day). Nothing else, and never in a test's DIBS_HOME unless DIBS_CLEAN says what.
- **Code leaves a machine only when the rules allow it.** `.dibs.json` stayOn and machine limits are checked on the sender before anything is uploaded, again at placement, and again on the worker, which re-reads the `.dibs.json` files from the copy it unpacked. Secret-looking files (`SECRET` in src/remote.mjs) never ship. Tokens are stored hashed and never logged. The admin token works from loopback only.
- **The guard hook never breaks a session.** Any internal error means allow, unchanged, exit 0. On Bash and edit calls it stays under 50 ms, so it takes no lock and loads only src/guard.mjs, src/files.mjs and src/util.mjs. Subagent spawns, starts and stops load src/agents.mjs and take its own lock (agents.lock, never state.json's), giving up and allowing after 1 s. Messages from the person: the hook reads only `inbox.json` (absent when nothing is queued) and loads src/talk.mjs only when this agent has one waiting (dibs's own notices about its jobs arrive the same way). SessionStart and a subagent's first SubagentStart load src/primer.mjs, which reads config.json and nothing else.
- **Agents may do anything the person can, and it's on the record.** No command is the person's alone (since 0.0.110). A command that changes the person's settings, the group of machines or another agent's work logs it with `logChange()` (src/owner.mjs), or, for a job, puts `by` on the job and the override event (src/override.mjs), so the board and `dibs history` name the agent that did it. A message or answer from an agent never reads as the person's. The machine's limits (memory, swap, disk, never pausing every job) are not permissions: they hold for everyone.
- **Plain `dibs` never hangs.** Other machines get 1.5 s; after that the local board prints with one line saying they couldn't be reached.

## Code style

Read the file you're changing and match it.

- Short functions, flat control flow, plain names. A helper used once usually shouldn't exist.
- Comments say why, in plain English. Delete any comment that restates the line below it.
- Messages say what happened and what to do next: `port 7420 is taken. Is a coordinator already running? (dibs machines)`.
- `catch {}` is for things that may fail without anyone needing to know (a stale pidfile, a best-effort cleanup). Anything the user needs to know about surfaces.
- Numbers with a reason get a named constant and a comment saying why that value.
- No emojis, no em dashes, no curly quotes, in code, output or docs.

## Tests

```bash
cd ~/dibs-<topic> && ~/bin/dibs run test -m "what you're testing" -- node --test --test-timeout=120000 test/*.test.mjs
```

Always run the suite through dibs: it spawns real processes and coordinators, and several agents share the machine. It takes about 70 seconds. Run it twice before calling anything done; timing bugs show up on the second run.

- Shared helpers (spawning the CLI, waiting for a condition, a temp `DIBS_HOME`, a simulated group of machines) live in `test/helpers.mjs`. Use them instead of copying new ones.
- Every test gets its own temp `DIBS_HOME` and cleans up every process it starts, including when setup fails halfway.
- Coordinators in tests bind to `127.0.0.1` only (`--bind 127.0.0.1`), never the Tailscale address.
- Test behavior, not implementation: run the real CLI where you can, and ask whether the test would fail if the feature were deleted.
- Wait for conditions (`until`), not fixed sleeps. If a sleep is unavoidable, comment why.
- Name tests after the behavior a user sees: `a sender that dies: its job is stopped`.
- Never run real `simctl`, touch real settings files, or depend on Tailscale being up. Seams for that:

| variable | what it does |
|---|---|
| `DIBS_HOME` | state folder (default `~/.dibs`) |
| `DIBS_FAKE_MACHINE` | JSON overriding memory, disk, load and swap readings |
| `DIBS_FAKE_DISK` | a file holding free disk in bytes, read at every reading, so a test can free disk under a waiting run (with `DIBS_FAKE_MACHINE` set) |
| `DIBS_FAKE_SIMCTL` | JSON file that plays CoreSimulator for the simulator pool |
| `DIBS_FAKE_FOOTPRINT` | JSON file of `{ pid: bytes }` read in place of real memory footprints; pids not in it read 0 |
| `DIBS_FAKE_MEMORY` | JSON file of `{ pid: bytes }` read in place of top's MEM plus CMPRS for every process, for the memory alert's list of what to close (src/alerts.mjs) |
| `DIBS_SAMPLE_MS` | how often leases are measured (default 10s), so a test sees a measurement quickly |
| `DIBS_SCRATCH` | where `dibs setup scratch --check` looks for the scratch volume |
| `DIBS_FAKE_ENOSPC` | a file: while it exists, state writes fail as ENOSPC would. It lists the steps that fail (`lock`, `state`, `notes`), or none for all |
| `DIBS_THIN` | `0` makes this caller's run and hold wait in Node instead of as a thin shell |
| `DIBS_BROKER_IDLE` | how long the broker stays up with nobody waiting (default 60s), so a test can see it exit |
| `DIBS_BROKER_START_WAIT` | ms a thin waiter gives the broker it started to come up before taking it for slow and waiting in Node (default 10s), so a test can see a slow start |
| `DIBS_THIN_GIVE_UP` | seconds a thin waiter goes without a broker before waiting in Node instead (default 15) |
| `DIBS_LOST_EXIT_MS` | how long a `worker --ephemeral` (an on-demand VM's) goes without its coordinator before it leaves (default 60s) |
| `DIBS_SHIP_AFTER` | seconds a load-held wait lasts before it tries an on-demand machine (default 300), so a test can see it ship |
| `DIBS_BOAT` | the boat CLI the coordinator runs for on-demand VMs (default `boat` on PATH). Tests point it at test/fake-boat.mjs, whose VM runs on this machine |
| `DIBS_MAX_WAIT` | the default wait limit outside Claude Code (8m), so a test can outlast it in seconds |
| `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_SIMPLE` | whether dibs thinks a Claude Code tool call is waiting (no limit). test/helpers.mjs clears them; set them per test |
| `DIBS_PAIR_PORT` | the UDP port a coordinator answers pairing lookups on and `dibs join <code>` broadcasts to (default the coordinator's port, 7420), so a test's coordinator on a free port can be found |
| `DIBS_TAILSCALE` | the Tailscale CLI `dibs join <code>` asks for peers; `none` for no Tailscale, so tests never reach a real tailnet |
| `DIBS_LISTEN_POLL` | ms between `dibs listen`'s looks at its queue and its session (default 5000), so a test sees a listener notice its session is gone in a second |
| `DIBS_SERVE_TIMING` | shorter coordinator timeouts (beatHold, workerLost, clientLost) |
| `DIBS_CLAUDE_SETTINGS` | settings.json path for `dibs guard install` |
| `DIBS_CLEAN`, `DIBS_DERIVED` | the caches src/diskwarn.mjs clears, as `{label: argv}`, and the DerivedData folder; without DIBS_CLEAN a test's DIBS_HOME clears nothing |
| `DIBS_BACKUP_MS` | how often the coordinator checks for a dead throttle watcher and sends the low-disk notes itself (default 30s) |
| `DIBS_LAUNCHCTL`, `DIBS_LAUNCH_AGENTS` | the launchctl `dibs service` runs, and the folder its plists (or, on Linux, its systemd units) go in, so a test never touches the real services |
| `DIBS_HOG_MIN` | bytes a temp session folder must hold before a low disk notice names it (default 2 GB), so a test's small folders count |
| `DIBS_CLAUDE_TMP` | stands for `/tmp` when the guard looks for Claude Code's temp folder (`claude-<uid>` under it), so tests never touch the real one |
| `DIBS_NO_SESSION`, `DIBS_AGENT`, `DIBS_AS` | who dibs thinks is calling |
| `DIBS_REPO` | the project a job belongs to, for resources one at a time per project (deploys); a worker sets it to the sender's origin for a job from another machine, whose copy has no .git |
| `DIBS_VERSION_FILE` | the version.mjs a running `dibs listen` watches for an update (src/news.mjs), so a test can bump one |
| `DIBS_UPDATE_URL` | where `dibs listen` asks for the newest release (default https://dibs.cc/mac/latest.json), so a test can count the asks; set, it also checks from a git checkout |
| `DIBS_VIA` | the paired browser a page action came through the relay from (src/web.mjs sets it); the person's actions are then recorded as "the person via <device>". Ignored for an agent |
| `CLAUDE_CODE_SESSION_ID` | the Claude Code session, which matches the guard's notes on which subagent took a file lease. test/helpers.mjs clears it |
| `AI_AGENT`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE` | any of them makes a call an agent's (AGENT_ENV in src/owner.mjs). test/helpers.mjs clears them; set one per test |

Every bug fix comes with a test that failed before the fix.

`test/live/two-machines.sh` runs multi-machine and on-demand VM behavior for real, between this machine and the boat VM its registry names (docs/machines.md). It bills a VM for a few minutes, so it's not in the suite: run it after changing `remote`, `serve`, `worker` or `ondemand`.

## Releasing

1. The suite passes twice in a row on the branch.
2. Bump `src/version.mjs`, the `version` in `.claude-plugin/plugin.json` (installed plugins only update when it changes), `DEFAULT_VERSION` in `install.sh`, the `version` in `package.json`, the install link in README.md and `MARKETING_VERSION` in `app/project.yml`, then run `xcodegen generate` in `app/`. test/version.test.mjs fails until they all agree with each other and with the top CHANGELOG section.
3. `claude plugin validate --strict .` passes. The repo root is the plugin root, so everything in it ships in the plugin's copy, and a `CLAUDE.md` at the root fails the check; contributor instructions live in `.claude/CLAUDE.md`.
4. Add a section to the top of `CHANGELOG.md`. Every session sees it once, so write it for agents: what to do differently, not how it works inside.
5. If the way agents should call dibs changed: the rules every agent reads first live in `rules()` in src/primer.mjs, and `node -e "import('./src/primer.mjs').then(m => m.writeRules())"` copies them into the top of `skills/dibs/SKILL.md` and docs/reference.md's "Tell your agents" (test/rules.test.mjs fails until they match). Keep them to what changes behaviour; everything else goes in the skill's reference, under "When you need it".
6. Merge into `main` in the checkout agents run. That's the rollout on your machines. Publishing it (dibs.cc, the GitHub tag, the Mac app) is in [docs/releasing.md](docs/releasing.md).
7. Restart the services so they load the new code: `launchctl kickstart -k gui/$(id -u)/dev.dibs.<serve|worker|throttle>`, then check `dibs service status` and `dibs machines`.

Commit messages say what changed for users. No AI attribution lines.

## Where things are

`bin/dibs.mjs` parses arguments and dispatches; `src/acquire.mjs` and `src/schedule.mjs` decide who goes next; `src/commands.mjs` runs and holds; `src/state.mjs` owns the state file and its lock; `src/platform.mjs` is everything that differs between macOS, Linux and Windows. The multi-machine pieces are `serve`, `worker`, `remote`, `trust` and `admin`. `preempt`, `simpool`, `guard`, `files`, `agents`, `quota`, `measure` and `board` are one feature each.

```
bin/dibs.mjs        command line: flags, help, the what's-new notice
src/acquire.mjs     getting in line, waiting, the wait message: one step that a waiter runs for itself or the broker runs for it
src/thin.sh         a waiting run or hold as a shell blocked on its FIFO; bin/dibs.mjs's first lines send run and hold here
src/broker.mjs      the one process that waits for every thin waiter: _enqueue, _broker, _rewait, _leave, the stuck-broker check
src/schedule.mjs    who goes next: rank, budgets, backfill, forecasts (pure functions)
src/commands.mjs    run, hold, release, when, why, mine, who, yield, ask, the board
src/board.mjs       the board's rows, as data other machines can read, and the other machines' sections
src/state.mjs       the shared state file and its lock, cleanup of dead holders, run history
src/proc.mjs        process liveness, which Claude session is calling
src/cool.mjs        dibs throttle, and its memory pressure check
src/hogs.mjs        under the disk floor: measuring Claude Code's temp session folders, telling the biggest's agent, naming it in disk waits
src/diskwarn.mjs    under twice the disk floor: clearing caches that rebuild themselves, and telling every active session
src/preempt.mjs     pausing low and idle runs for urgent work and under memory pressure
src/reset.mjs       onRelease: queuing a resource's reset when a lease ends, and the supervisor that runs it
src/guard.mjs       dibs guard: the Claude Code hook, its rules, settings.json install
src/files.mjs       file leases: paths and globs, which overlap, which shell commands write, the hook's refusal
src/agents.mjs      the subagent limit: the hook's Agent, SubagentStart and SubagentStop half, its own ledger and lock
bin/dibs-guard.mjs  the hook's entry point (loads only the guard and file leases, plus agents.mjs for subagent events)
src/quota.mjs       quota:<name> token buckets for shared rate limits
src/questions.mjs   dibs question, questions, answer, hours: agents queuing questions for the person, its own file and lock
src/talk.mjs        dibs say, tell, threads: one thread per agent, and handing the person's messages over in the hook (its own file and lock)
src/notices.mjs     dibs's notices to an agent about its own jobs (stuck, over its memory, paused), and the duplicate-run check; detection lives in acquire, plain and measure
src/primer.mjs      the few lines every new session and subagent hears about dibs, from the hook's SessionStart
src/answers.mjs     dibs ask: the closest passages from the docs
src/later.mjs       dibs later: runs scheduled for a time or after something ends, its own file and lock; the worker runs them
src/owner.mjs       actor and logChange: who is calling (an agent's session name, or the person), for the record
src/measure.mjs     measuring what running leases really use, and the learned sizes
src/events.mjs      the event log (events.jsonl): lease starts and ends, waits, pauses, load samples, overrides; event() appends one
src/history.mjs     dibs history: busy time, waits and who waited, by resource, agent and hour, from the event log
src/alerts.mjs      dibs alerts: what's wrong and its fix (long waits, memory, idle slots, failed and lost jobs, dibs itself, disk), alerts.json, shown on the board, the page and the app
src/scratch.mjs     dibs setup scratch: the capped scratch volume's admin commands and --check
src/simpool.mjs     sim-own: the pool of simulators, dibs sims
src/simctl.mjs      the simctl calls the pool makes (test/fake-simctl.mjs stands in under DIBS_FAKE_SIMCTL)
src/remote.mjs      several machines: sending jobs, the working copy, join, machines
src/serve.mjs       the coordinator: placement, job relay, lost machines
src/ondemand.mjs    on-demand VMs (boat): asleep until a job needs one, woken, set up, and stopped when idle
src/trust.mjs       machine tokens, the coordinator's registry, limits, .dibs.json rules
src/admin.mjs       invite, kick, limit
src/worker.mjs      running other machines' jobs here
src/service.mjs     launchd / systemd / Task Scheduler services
src/platform.mjs    everything that differs between macOS, Linux and Windows
src/config.mjs      defaults, ~/.dibs/config.json, the paces, machine load (macOS and Linux)
src/util.mjs        sizes, durations, deadlines, formatting
src/version.mjs     the version number
test/               node --test: scheduling rules, the real binary under contention, and a simulated group of machines
.claude-plugin/     the Claude Code (and Codex) plugin and marketplace manifests
hooks/hooks.json    the plugin's guard hook
skills/dibs/        the plugin's skill: how agents should use dibs
docs/               the deep parts of the user docs
install.sh          per-user install into ~/.dibs-cli; dibs.cc serves it, the release's sum written in
package.json        only so npm i -g @dibssoftware/dibs works: no dependencies, no scripts
release.sh          publishing a release on dibs.cc: the tarball, its sum, install.sh and the Mac app
```

No dependencies. Node 22.23.4, 24.22.1, 26.12.1 or newer (src/nodecheck.mjs). macOS and Linux use `ps` and process groups. Windows uses PowerShell's process table and `taskkill /T`. The suite runs on macOS and on Linux (Ubuntu 24.04 on a boat VM); Windows isn't tested.
