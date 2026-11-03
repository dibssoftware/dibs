# dibs

Three coding agents, one Mac, one simulator. One installs its build over the app another is tapping through, a third starts a fourth `xcodebuild`, memory runs out, and the simulator crashes for all of them.

dibs makes agents take turns on the things that exist once on your machine (the simulator, Xcode builds, test suites, browser runs, deploys) and lets everything else run in parallel. It's a single Node CLI with no dependencies and no daemon.

## Install

macOS or Linux, Node 22.23.4, 24.22.1 or 26.12.1 or newer. Older builds of those lines have the Brotli decoder bug (CVE-2026-111497), so upgrade Node first if yours is behind. No sudo.

```bash
curl -fsSL https://dibs.cc/install.sh | sh
```

It downloads the release tarball from dibs.cc, checks its sha256, puts dibs in `~/.dibs-cli` and links `~/.local/bin/dibs`. If anything fails, it says what and exits nonzero, having installed nothing. Each release's tarball and sum are at `https://dibs.cc/releases/dibs-v<version>.tar.gz` and `.tar.gz.sha256`.

Or a pinned version from GitHub: `curl -fsSL https://raw.githubusercontent.com/dibssoftware/dibs/v0.0.176/install.sh | sh`. Or clone the repo and run `DIBS_SOURCE=<the clone> sh install.sh`.

## The first five commands

```bash
dibs run sim -m "checkout flow" -- ./ui-test.sh    # wait for the simulator, run, free it on exit
dibs run test --est 2m -- npm test                 # a test suite, side by side with others when there's room
dibs hold sim --for 20m -m "screenshot pass"       # keep it across several commands; dibs release sim gives it back
dibs                                               # the board: who has what, who's next
dibs why                                           # where you are in line and what you're waiting for
```

The board reads like this:

```
2 running, 1 waiting. Next up: api-refactor for the simulator, as soon as ios-checkout finishes.

Simulator      ios-checkout has reserved it, up to 15 min left
               Next: api-refactor
Xcode builds   web-app is building, about 1 min left
Free           Private simulators, Browser tests, Test runs, Deploys, Heavy jobs

This machine   quiet: 42% of memory free, 31 GB of disk free
```

A turn lasts exactly as long as the command. When it exits, crashes or gets `kill -9`'d, its whole process tree is killed and the next agent goes. No timeouts to tune, no stale locks.

## Who goes next

Mostly first come, first served, bent by four things. Short jobs move up: a command that usually takes 30 seconds goes ahead of a 20-minute suite that arrived a few minutes earlier, and one that takes under 15 seconds slips in beside running work. Priority shifts your place (`-p high` is worth an hour, `-p low` costs ten minutes). An agent that has had the same resource for most of the last hour drops back a little. A deadline (`--by 23:30`) pulls you forward as it gets close. Every shift is capped, so nobody waits forever.

Then the machine gets a say. dibs measures what each command really uses and books that, keeps running jobs inside a memory and CPU budget, and holds new work while the Mac is swapping or short on disk. One job always gets to run. The whole set of rules, with the numbers, is in [docs/scheduling.md](docs/scheduling.md).

**Make agents use it.** Agents forget to wrap commands, so add the guard hook. From Terminal:

```bash
dibs guard install
```

Or as a plugin, in a Claude Code session (Codex reads the same plugin; [docs/guard.md](docs/guard.md) has its commands):

```
/plugin marketplace add dibssoftware/dibs
/plugin install dibs@dibs
```

The guard rewrites a bare `xcodebuild` or `npm test` into `dibs run ...` only in bypass-permissions sessions, where the agent already runs everything without asking. In every other session it blocks the command and tells the agent the exact `dibs run` line to use, so the retry goes through your normal permission prompt. It never approves anything for you, and if it can't parse a command or hits an error, it lets the command through. The same hook turns away edits to files another agent has leased, starts each new session and subagent with a few lines on how to use dibs, and hands each agent your messages and dibs's notices about its own jobs (one looks stuck, used far more memory than it asked for, or was paused) on its next tool call. If you set `agents.slots` in `~/.dibs/config.json`, it also caps how many subagents run at once across every session; there's no cap until you do. Details: [docs/guard.md](docs/guard.md).

If you run one agent at a time, you don't need this.

**Upgrade** by running the install line again. It swaps `~/.dibs-cli` in one step, and your queue and settings in `~/.dibs` stay. Then `dibs guard install` again, from Terminal, so the hook has every event the new version listens to. A plugin install updates with `claude plugin update dibs@dibs` in Terminal, or in Claude Code from `/plugin`, Installed, dibs, Update now. Run `/reload-plugins` to load it in a session that's already open.

**Uninstall**, from Terminal:

```bash
dibs guard remove                              # or claude plugin uninstall dibs@dibs for a plugin install
dibs service remove serve worker throttle      # only if you installed services
rm -rf ~/.dibs-cli ~/.local/bin/dibs ~/.dibs   # ~/.dibs is the queue, history and settings
```

## Tell your agents

Paste this into your `CLAUDE.md` or `AGENTS.md` (the Claude Code plugin ships the same thing as a skill):

```markdown
## dibs (shared machine resources)
Other agents share this machine. Wrap anything that collides in dibs; plain reads, edits and small commands need nothing.
- `dibs run <resource> -m "why" -- <cmd>`: `test` (`npm test`, vitest, `node --test`), `xcode-build`, `sim` (the shared simulator), `sim-own` (a private one, udid in `$SIM`: `sh -c '... "$SIM"'`), `playwright --port WEB` (use `$WEB`), `deploy`, `heavy`. Need two? `dibs run sim,xcode-build -- <cmd>`, never one while holding the other.
- Across several tool calls: `dibs hold sim --for 20m -m "why"`, keep wrapping each command in `dibs run sim -- ...` (it starts at once under your hold), and `dibs release sim` when done.
- In Claude Code a `dibs run` waits as long as it takes. A tool call that moved to the background is still waiting: don't run it again (dibs refuses the copy, exit 2).
- Before editing files other agents may touch: `dibs hold 'files:src/auth/**' -m "why"` (from the git root; quote the glob). If your edit is refused, wait or message the holder; don't write the file another way.
- Post progress as often as you commit: `dibs progress "what you just did or found, with numbers" --task <name> --eta 30m`, then `--blocked` or `--done`. The person reads it live. An overdue task gets you a notice: post a new `--eta` or `--done`.
- Decide two-way doors yourself. Ask the person only what can't be undone: `dibs question "Delete the old bucket?" --options yes,no --recommend yes -m "nothing reads it" --one-way "the 4,210 files are gone for good"`, keep working, then the same command with `--wait` prints only the answer. Exit 75 there means no answer: don't do the step.
- `dibs say "done: tests pass"` leaves the person an FYI. A line starting `Message from the person:` is really theirs: act on it, and reply with `dibs say`.
- A wait on memory, swap or disk protects the machine: keep waiting, never lower `--mem` or raise `-p` to get past it. A line from dibs about one of your jobs (stuck, over its memory, paused, a task overdue) is about your own work: act on it.
- You may boost, pause, resume or stop any job (`--owner <its session>` when it isn't yours); dibs records who did it. Raise to high or urgent with `-m` only when a person is waiting now or something is broken. A job "stopped by" someone was ended on purpose: find out why before running it again.
- Other machines: `dibs run test --anywhere -- <cmd>` or `--on <machine>`. Later: `dibs later test --at 02:00 -m "why" -- <cmd>`.
- Exit codes: 75 gave up waiting, never ran (rerun the same command within 2 minutes), 74 not enough disk, 76 lost before it started (send again), 77 lost after it started (it may have run: check first), 70 dibs crashed.
- `dibs` shows the board, `dibs help all` every command. Something wrong with dibs: `dibs ask "..."`.
```

## Commands

```bash
dibs run sim,xcode-build -- ./build-and-install.sh      # everything you need, at once
dibs run playwright --port WEB --port API -- npx playwright test   # free ports in $WEB and $API
dibs run test -p high -m "release blocker" --by 23:30 -- npm test
dibs run test --after #42 -- npm run e2e                # joins the line once your job #42 has ended
dibs hold sim --for 20m -m "screenshot pass"           # across several tool calls; again to extend
dibs release sim
dibs hold 'files:src/auth/**' -m "auth refactor"       # other agents' edits there are turned away
dibs run quota:asc --cost 3 -- ./upload.sh             # share an API's rate limit between scripts
dibs when sim           # when you'd get it, without joining the line
dibs who sim            # who holds it, until when, who's next
dibs why                # where you are, when you start, what you're waiting for (--detail: the math)
dibs mine sim           # exit 0 if you hold it, 1 if not
dibs yield web-app      # let another agent go first
dibs pace quiet         # how hard dibs drives this machine: quiet, normal or max
dibs sims               # the private simulator pool
dibs setup scratch      # the admin commands for a capped scratch volume for build output (macOS)
dibs changes            # what changed in recent versions
dibs question "Ship 123 now?" --options yes,no --recommend yes -m "tests pass" --one-way "testers get it at once" --wait   # only one-way doors reach the person
dibs questions          # what agents are asking you, with what they recommend; dibs answer <id> <option, or your own words>
dibs hours 09:00-23:00  # outside your hours, questions below urgent wait for the morning
dibs threads            # one thread per agent: its notes and questions, your messages; dibs threads read <agent>
dibs tell web-app "use the staging database"   # reaches the agent on its next tool call, or as it finishes its turn
dibs tell desk "why is my build waiting?"      # the agent config.json names as "desk" answers you with dibs say --to person
dibs history            # the last 7 days: busy time, waits and who waited, by resource, agent and hour
dibs stats              # waits against run times, today and the last 7 days: the share of jobs that waited longer than they ran
dibs stats --me         # your own: jobs, run and wait time, failures by exit code, what held you back, top commands, ETAs met (--agent <name>, --since 30d, --json)
dibs later sim --at 02:00 -m "snapshot suite" -- ./snapshots.sh   # run it tonight; returns at once with its id
dibs later test --after web-app:deploy -- npm run smoke           # when that agent's deploy ends (--after-ok: only if it passed)
dibs later list         # scheduled, waiting, running, and how the finished ones ended; dibs later cancel <id>
```

Anyone can override any job, the person or an agent. An agent acting on a job that isn't its own names the owner with `--owner <session>` (or `session/agent`), as the board shows it, or nothing changes (exit 2, with the owner, its `-m` and the command to rerun); the person never needs it. Every answer starts with whose job it was: `boosting #10167: alex-c8 deploy 'shop-api first deploy'`. `dibs boost <id> high -m "why"` (the `#` on `dibs --detail`), `dibs pause <id>` and `dibs resume <id>`, `dibs stop <id>` (kills the job; its agent is told who stopped it), and `dibs cap <agent> low` (that agent never waits or runs above low until `dibs cap <agent> off`). The same goes for `answer`, `questions dismiss`, `hours`, `pace <word>`, `tell`, `threads read`, `join`, `invite`, `pair --machine`, `kick`, `limit`, `service install`/`remove`, `guard install`/`remove` and `serve --force`: nothing is the person's alone.

Every one of them is logged with who ran it: `dibs history --json` has an `override` event with `by` (the agent's session name, or `the person`). The board says it too: `[boosted by web-app: release blocked]`, `[paused by web-app]`, `capped: pushy at low (by web-app)`. A message an agent sends with `dibs tell` arrives as `Message from web-app (another agent, not the person)`, and an agent that answers a question is named to the one that asked. An agent raising a job to high or urgent passes `-m`, so everyone sees why. The machine's own limits (memory, swap, disk, and never pausing every job) hold for everyone.

A waiting `dibs run` or `dibs hold` is a shell blocked on a FIFO (about 1.5 MB, no CPU), and one broker process decides for every waiter on the machine: it starts when someone waits and exits after a quiet minute. Before 0.0.102 each waiter was a Node process of its own, 35 to 65 MB polling the state every 1.5 seconds, which with dozens waiting came to gigabytes and kept the state lock busy most of the time. To go back to that, in `~/.dibs/config.json` (or `DIBS_THIN=0` for one caller):

```json
{ "waits": "fat" }
```

Nothing changes in how agents call dibs, what it prints, or its exit codes. Jobs other machines send here and `dibs later` jobs wait thin too. `--after` still waits in Node (it waits outside the line until the other job ends), as does a run sent with `--anywhere` or `--on`, whose sender follows it over the network while it waits on the other machine. Anything that goes wrong with a thin wait (a broker that died, got stuck or couldn't start, a wait that fell back to Node, a crash) leaves an event of kind `thin` in `~/.dibs/events.jsonl`: `grep '"kind":"thin"' ~/.dibs/events.jsonl`.

## Watching your agents: the page and MCP

```bash
dibs service install web     # or: dibs web    (http://127.0.0.1:7421)
dibs pair                    # a one-time code, e.g. K7QM-4XNA: one use, 10 minutes
```

Open http://127.0.0.1:7421 and type the code. The rail on the left switches between views:

- **Now**: every agent's running and waiting jobs on a timeline that spans only the time something is in, file locks, tasks with their ETAs, and every `dibs progress` post, live. Click a job to make it go first, give it back its normal place, let others go first, pause, resume or stop it (stop asks twice). Pick an agent to hold all its jobs back (`dibs cap`).
- **Questions**: what agents asked you at one-way doors. Answer with an option or your own words, or say not now.
- **Messages**: one thread per agent. What you send reaches the agent with its next tool call.
- **Stats**: run and wait time by agent and by resource, how often jobs waited longer than they ran, failures by exit code, what held jobs back, top commands, ETAs met, a daily trend, a day-by-hour heatmap, and the machine's load, memory and disk over time. Agents get the same numbers from `dibs stats --me`.
- **Scheduled**: `dibs later` runs coming up and ended this week; cancel one.
- **History**: `dibs history` for the past day, week or 30 days, and every override with who made it.
- **Settings**: the speed (`dibs pace`), your hours, and the Claude Code hook.

Every change on the page runs the same CLI command you would, as you, so `dibs history` and the board name you, and the CLI's own rules apply. Changes need the page's sign-in; nothing else can make them.

The same server is an MCP server at `http://127.0.0.1:7421/mcp`, so your own Claude can answer "what are my agents doing?". Add it to Claude Code with `claude mcp add --transport http dibs http://127.0.0.1:7421/mcp`; the client opens a sign-in page in your browser, and you type a code from `dibs pair`. With a plain `dibs pair` code it gets read-only tools: `board`, `agents`, `agent`, `progress`, `stats`, `questions`, `history`, `resource`, `machines` and `messages`. A code from `dibs pair --allow-actions` adds tools that act: post progress, answer questions, message agents and you, hold and release, and boost, pause, resume and stop jobs. It acts as an agent named after the client (`mcp-<name>`), never as you, so agents treat its messages as a peer's. A model reads text agents wrote, and text can steer a model, so give actions only to a client you'd trust with them. A code from `dibs pair --allow-commands` also lets a client signed in here (never through mcp.dibs.cc) queue commands to run on this Mac with `queue_run`, the way `dibs later` does. `dibs pair --list` shows what's signed in and `dibs pair --revoke <id|all>` signs it out.

It answers only on 127.0.0.1 unless you pass `--bind <address>` (your Tailscale address, say), and only to requests that name that address, so a web page can't reach it by DNS rebinding. Codes and tokens are stored hashed in `~/.dibs/web.json`. After 10 wrong codes in 10 minutes every try is refused until the window passes; open codes stay good. To let claude.ai or another Claude account read your board, `dibs relay mcp on` serves it at `https://mcp.dibs.cc/mcp` through the relay (docs/relay.md).

## Mac app

`app/` builds a Mac app (macOS 26) over the same commands: the live board with boost, pause, stop and cap buttons, agents' questions to answer, the week's history, and the pace, in a window and the menu bar. It runs the `dibs` on your PATH and reads nothing else. A signed download will be at https://dibs.cc/mac/; until then, build it yourself. To build it yourself you need Xcode 26 and xcodegen (`brew install xcodegen`): [app/README.md](app/README.md) has the steps.

Priority is `-p urgent|high|normal|low|idle`. `urgent` and `high` need `-m` and everyone sees them. `low` and `idle` run at background priority, and may be paused while urgent work borrows their slot. `--est 5m` tells dibs how long a new job takes, so short jobs can move up. `--by 23:30` moves you up as a deadline gets close.

Agents show up by their Claude Code session name. Anywhere else, dibs names them after the folder they run in; set `DIBS_AGENT=name` to pick your own.

## Exit codes

Agents branch on these, so they don't change.

| code | meaning |
|---|---|
| the command's own | it ran |
| 75 | dibs stopped waiting in line. The command never started and did not fail. Run the same command again within 2 minutes to keep your place. For `dibs question --wait`: no answer (timed out or dismissed), nothing was decided |
| 74 | not enough free disk, and nothing running would free it. Other sessions' `/private/tmp/claude-*` folders are off limits for making room |
| 76 | lost the coordinator or the other machine before a remote job started. Nothing ran there: sending it again is safe |
| 77 | lost the other machine after a remote job started. It may have run, or may still be running: check before running it again |
| 127 | the command didn't start |
| 2 | bad usage, a job asking more memory or cores than the machine ever hands out (it says the most it can ask), a resource name close to a real one (`simulator` for `sim`), an agent's high or urgent boost without `-m`, `--on` on a machine that isn't in a group, or a `dibs run` you already have waiting or running (wait for that one) |
| 1 | nothing matched: `mine` with nothing held (the clean result after a release), `release` with nothing to give back |
| 70 | dibs itself crashed: a bug in dibs, not your command. Report it with `dibs ask "..."`. If your command already ran, you get its code instead |

Inside Claude Code, `dibs run` waits as long as it takes: when the tool call hits its timeout, Claude Code moves it to the background and tells the agent when it ends. Everywhere else (Codex, scripts, a terminal) dibs gives up after 8 minutes with exit 75, which fits a 10-minute tool call. `--wait` lifts the limit, `--max-wait 20m` sets your own.

## Resources

| name | slots | memory | cores | free disk | pausable |
|---|---|---|---|---|---|
| sim | 1 | 3G | 1 | 8G | no |
| sim-own | 4 on 16 GB (RAM / 4G, at most 4), and only as many as free memory fits | 3G | 2 | 6G | no |
| xcode-build | 2 | 4G | 4 | 4G | no |
| playwright | 2 | 3G | 2 | 3G | yes |
| test | 3 | 2G | 3 | | yes |
| deploy | 1 | 0.5G | 1 | | no |
| heavy | 1 | 4G | 4 | 10G | yes |
| any other name | 1 | 1G | 1 | | no |
| `files:<path or glob>` | one holder per path | 0 | 0 | | no |
| `quota:<name>` | a token bucket from config | 0 | 0 | | no |

A name close to a real one (`simulator`, `tests`, `xcode`) is refused with exit 2 and the right name, since two agents slipping differently would both get the real thing at once. A name of your own that looks like none of them starts a queue of its own.

Running jobs share a budget of 8 GB and 6 cores while the machine is busy, so light jobs run side by side and heavy ones take turns. The cores count what running jobs are measured using, not what they asked for. dibs measures what each job really uses, failed and killed runs included, and plans the next run of the same command at that, when it's more than asked (a command it hasn't measured yet goes by the same program on the same resource, so a new Playwright spec starts at what the others used); `--mem` and `--cpu` say what you need up front. Override any of it in `~/.dibs/config.json`; you only need the keys you change. State lives in `~/.dibs`. A resource you make up can have a name people read on the board: `"resources": { "gpu": { "slots": 1, "label": "The GPU" } }` (a quota takes `"label"` too).

## More

- [docs/scheduling.md](docs/scheduling.md): how a turn is decided, what a lease guarantees, nested runs, measuring what jobs use, rate-limit quotas, pausing low-priority work, `dibs pace`, running jobs side by side, resetting a resource after each use, throttling
- [docs/files.md](docs/files.md): file leases, and which edits the guard turns away
- [docs/questions.md](docs/questions.md): agents queuing questions for the person, `--wait`, working hours
- [app/README.md](app/README.md): the Mac app
- [docs/simulators.md](docs/simulators.md): `sim-own`, the pool of private simulators
- [docs/guard.md](docs/guard.md): the hook, what it matches, the subagent limit, installing it for Claude Code and Codex, your own rules
- [docs/machines.md](docs/machines.md): sending jobs to other machines, adding one (`dibs pair --machine` on the coordinator, `dibs join <code>` on the new machine), tokens, and keeping a project's code on the machines you name
- [AGENTS.md](AGENTS.md): working on dibs itself

Platforms: CI runs the full suite on macOS and Ubuntu on every push. Linux uses the same code paths (`ps`, process groups, `/proc/pressure/memory`). Windows support exists and is untested.

## License

dibs is free to use, change and share under the [GNU Affero General Public License v3](LICENSE) (AGPL-3.0-only), at home or at work. If you ship a changed dibs, or run one for other people over a network, the AGPL says you share your changes under the same license.

If your company can't use AGPL software, or you want to build dibs into something you don't open source, a commercial license is available from Creayo LLC: licensing@dibs.cc.

## Contributing

Bug reports, ideas and pull requests are welcome. Before your first pull request is merged you sign a contributor license agreement, so Creayo LLC can offer your change under both licenses: [CONTRIBUTING.md](CONTRIBUTING.md) says how. [AGENTS.md](AGENTS.md) is how the code is worked on.
