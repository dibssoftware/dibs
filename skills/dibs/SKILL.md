---
name: dibs
description: How to take turns with other agents on this machine's simulators, Xcode builds, test suites, browser runs, deploys and shared files using the dibs CLI, post progress, and ask the person questions. Use before running xcodebuild, xcrun simctl, swift test, Playwright, jest, vitest, npm test, node --test or a deploy, before editing files other agents may touch, before asking the person anything, before ending a turn while waiting on another agent or the person, when a command, edit or subagent spawn was blocked or rewritten by dibs guard, or when dibs exits 1, 2, 3, 70, 74, 75, 76 or 77.
---

# dibs

<!-- dibs:rules:start -->
dibs runs on this machine. Agents take turns through it on the simulator, Xcode builds, test suites, browser runs and deploys.
- Wrap those: `dibs run <resource> -m "why" -- <command>` (resources: sim, sim-own, xcode-build, test, playwright, deploy, heavy). Two at once: `dibs run sim,xcode-build -- ...`.
- No dibs for reads, edits, small commands, or long jobs that mostly wait on the network and use little CPU, memory or disk (crawlers, pollers, HTTP checks). The hook leaves those alone too.
- Start `dibs listen` with run_in_background now, and again each time it exits: it wakes you when the person or dibs has something for you.
- Waiting is normal. A call moved to the background is still waiting: don't run it again. A wait on memory, swap or disk protects the machine: keep waiting, and never lower `--mem` or raise `-p` to get past it.
- Exit 75: it gave up waiting and your command never ran; run the same command again. Exit 74: not enough free disk; free your own build output, or tell the person.
- Decide what you can undo yourself. Ask the person only before something you can't undo (`dibs question ... --one-way`). Lines starting "Message from the person:" are theirs: act on them.
- Post progress as you work: `dibs progress "what you did or found" --task <name> --eta 30m`, then `--done`.
- The rest (holding across tool calls, file leases, other machines, every exit code, overriding jobs, questions) is below, under "When you need it", and in `dibs help`.
<!-- dibs:rules:end -->

## When you need it

Everything below is reference. Read the part you need when it comes up.

### Running

```bash
dibs run xcode-build -m "why" -- xcodebuild -scheme App build
dibs run sim-own -- sh -c 'xcrun simctl install "$SIM" App.app'    # $SIM is the private simulator's udid
dibs run sim-own,xcode-build -- sh -c 'xcodebuild test -scheme App -destination "id=$SIM"'
dibs run playwright --port WEB -- npx playwright test               # a free port in $WEB
dibs run test --after #42 -- npm run e2e                            # joins the line once job #42 has ended
dibs run test -- sh -c 'npm run build && npm test'                  # a shell line goes in sh -c
```

- `sim` is the one shared booted simulator. `sim-own` boots a private one for your command (its udid in `$SIM`) and shuts it down after.
- `$SIM` and `--port` variables are set inside the run, so put them in single-quoted `sh -c '...'`. Use `$WEB` (or whatever you named the port), never a fixed port.
- Need two resources? Ask for both in one `dibs run a,b`. Never hold one while waiting for another.
- The turn lasts exactly as long as the command: when it exits or crashes, the turn is given back and its whole process tree is killed. Don't add keepalives, `timeout` wrappers or lock files of your own.
- Inside Claude Code, `dibs run` waits as long as it takes. Every run ends with one line on stderr, `dibs: #812 test, waited 2m10s, ran 3m04s, exit 0`; after a compaction, that line is the result.
- A command over in under 15 seconds (a deploy of a few seconds, a one-file test): add `--quick`, or `--est 10s`. It starts at once, past the line and full slots, at most 2 at a time; on the simulator, or a deploy of the same repo, it goes to the front of the line instead. dibs learns it after that. A run that goes over loses the pass until it runs under again, and you're told.
- `--est 3m` (a duration like `30s`, `5m`, `1h`) on a job dibs hasn't seen lets short jobs move up. `--mem 6G --cpu 4` the first time you run something heavy dibs hasn't measured; after that it plans at the measured peak, and says so if a job used far more than it asked.
- Priority: `-p urgent|high|normal|low|idle` (or 1-5). `urgent` (something's broken or a person is waiting now) and `high` (critical path) need `-m`, and everyone sees them. `normal` is the default. `low` (nobody waiting) and `idle` (audits, solvers, regenerating things) run at background priority on the cool cores. Pick the true level. `--by 23:30` for a deadline.
- `--notify <file>` appends a JSON line to that file when dibs exits.
- A shared API rate budget: `dibs run quota:<name> --cost N -- <cmd>` (the budgets are set in `~/.dibs/config.json` `quotas`).
- Work that runs outside dibs is moved to the slow cores when the machine runs hot (`dibs throttle`). Wrapping it lets you pick its priority.
- A resource name close to a real one (`simulator`, `tests`) is refused with exit 2 and the right name. A new name of your own starts its own queue.
- A suite that takes minutes: `dibs run test --shards 2 -- npx vitest run` splits it across the group's machines and merges the output and exit codes. vitest and `node --test` suites that usually take over 5 minutes split on their own; `--no-shard` keeps one piece.

### Listening for messages

`dibs listen`, started with run_in_background, waits until something comes for you, prints all of it and exits 0, and that exit wakes you even while you sit idle. Start it at the start of your session and again each time it exits. What wakes it:

- a message for you (`dibs tell`, from the person or another agent)
- the person answering your question in their own words
- a notice from dibs about your own jobs
- dibs on this machine was updated: it prints what changed since your last version, once
- a newer dibs is out on dibs.cc ("dibs X is out (you have Y)"): the person upgrades it; don't upgrade it yourself. Asked at most every 6 hours per machine, never from a git checkout, off with `"updateCheck": false` in config.json.

Exit 0 ends with "To keep listening, start dibs listen again with run_in_background." Exit 3 means nothing came within `--for` (60m by default). Either way, start it again. `--json` gives `{ messages }`, `{ updated, changes }` or `{ release }`.

One listener per agent: the main agent of a session, and each subagent, separately. A newer one replaces the older, which exits 0 saying another took over. Messages that arrive while you work come with your next tool call instead; none is lost or handed over twice. If you end a turn after your listener exited, the hook keeps you going once with "re-arm: your dibs listen has ended". The board, `dibs threads` and `dibs tell` say who is listening.

### Holding across tool calls

`dibs hold <res> --for 20m -m "why"` waits for its turn like `dibs run`, then returns. Keep wrapping each command in `dibs run <res> -- ...`: under your hold it starts without waiting. Run the hold again to extend it; an hour is the most it gets at once. `dibs release <res>` when you're done. `dibs mine` lists what you hold and wait for, and exits 1 when that's nothing, which is the clean result after a release.

A script running under `dibs run deploy` that calls `dibs run xcode-build` waits only for xcode-build, ahead of waiters holding nothing.

### When dibs holds you back

- **Memory, swap or disk** ("waiting for memory pressure to ease", "this machine to stop swapping", "free disk to stop falling"): dibs is protecting the machine. Keep waiting. Don't pass a smaller `--mem` or a higher `-p` to get past it. A memory wait names the jobs holding the most: if one is yours and finished, end it.
- **Disk at your turn:** a resource that declares a disk need (the simulator asks 8 GB) is refused with exit 74 when that much isn't free and nothing running will free it. If your job needs less, pass `--disk 1G` on the hold and on each `dibs run`. A job whose own past runs ate more disk than is free waits for disk too, even alone. While you wait on something else, the wait message says early when disk will hold you next, so free your own build output then.
- **Paused** ("paused your job: free disk is low", or for urgent work): leave it, it resumes by itself.
- **Load** ("waiting for the machine to cool down"): ends within 20 minutes.
- **A person is waiting on the job now:** run it with `-p high -m "why"`, or send it to another machine with `--on <machine>` (`dibs machines`). That's the only reason to raise it.
- **Someone ahead of you:** agents appear by session name, the same name SendMessage uses. Message the agent ahead and ask; whoever is ahead runs `dibs yield <your name>`. If someone asks you and their work is more urgent, run `dibs yield <their name>`.
- **Lines from the dibs hook about your jobs** (stuck with no CPU for 20 minutes while others wait, over its memory, paused, a progress task overdue): they're about your own work. Act on them.

### Exit codes

| code | meaning | what to do |
|---|---|---|
| the command's own | it ran | read it as usual |
| 75 | gave up waiting: your command never started and didn't fail (outside Claude Code, after `--max-wait`, 8m by default), or a question got no answer | rerun the same command within 2 minutes to keep your place, or add `--wait`. On a question: nothing was decided, skip that step |
| 74 | not enough free disk | the message says how much it needed. Free your own build output, or tell the person; if this run needs less, pass a smaller `--disk` on that `dibs run` (a hold's `--disk` doesn't cover the runs under it). Never delete in another session's `/private/tmp/claude-*` folder |
| 76 | lost the coordinator or the other machine before the job started | nothing ran there: send it again |
| 77 | lost the other machine after the job started | it may have run, or still be running: check before running it again, above all a deploy |
| 70 | dibs itself crashed | a bug in dibs, not your command: `dibs ask "..."` |
| 127 | the command didn't start | check the command and its path |
| 2 | bad usage: a near-miss resource name, a high or urgent boost without `-m`, a job bigger than this machine (ask for what it names, or `--anywhere`), `--on` or `dibs machines` outside a group, or a run you already have going | read the message: it names the fix |
| 1 | nothing matched (`mine` with nothing held, `release` with nothing to give back) | usually the clean result |
| 3 | `dibs listen` heard nothing within `--for` (60m by default) | start it again with run_in_background |

### Files other agents may edit

`dibs hold 'files:src/auth/**' -m "why"` (paths from the git root; `**` crosses folders) turns away other agents' edits and writes there, with who holds it and why. Quote the glob, or zsh expands it first and fails with "no matches found". `dibs release 'files:src/auth/**'` gives it back. If your edit is refused: wait (`dibs when files:<path>`) or message the holder. Don't write the file another way. Paths nobody leased need nothing.

### Progress

Post as often as you commit. The person reads every post live on their page, the Mac app and their own Claude; other agents read them with `dibs progress`.

```bash
dibs progress "Starting billing-migration: script written, dry run next" --task billing-migration --eta 45m
dibs progress "Dry run touched 4,210 rows, 0 errors. Asking before prod" --task billing-migration --eta 30m
dibs progress "Blocked: waiting on the person for the prod run (question #3)" --task billing-migration --blocked
dibs progress "Done: migrated 4,210 rows on prod, checks pass" --task billing-migration --done
dibs progress list        # your session's open tasks, with owner, state, ETA and last post (--all: every session's)
```

- Post when you start (with `--eta`), when you learn something (a test fails, a cause found, a plan changed, with the numbers), when you hand off or wait (`--blocked`), and at the end (`--done`). A task of a minute or two needs just the `--done` post.
- Keep `--task` the same short name across posts, and move `--eta` (`30m` or `17:30`) when the estimate moves.
- A task still open past its `--eta` shows as overdue, and dibs tells you once: post a new `--eta`, or `--done`. You hear once too if an open task goes 45 minutes without a post. Ending a task without finishing it: `--done` with a post that says what isn't done.
- Posts are for the record. Questions go through `dibs question`; a note the person should see now goes through `dibs say`.

### The guard

When dibs's hook sees a heavy command outside `dibs run`, it rewrites it into the `dibs run ...` line (in bypass-permissions sessions) or blocks it and prints that line. Run the line. If the command really builds, boots, tests and deploys nothing, put `DIBS_GUARD=off` in front of it. If the person set a subagent limit (config `agents.slots`), a denied spawn started nothing and isn't a failure: wait for one of yours to report back, then spawn again.

### Looking without joining the line

`dibs` (the board, whose `Limits` line has memory, disk and swap), `dibs when sim`, `dibs who sim`, `dibs why`, `dibs mine`, `dibs history` (the last 7 days). Every command and flag: `dibs help all`. Something wrong with dibs, or a question about it: `dibs ask "..."`, or SendMessage the maintainer its answer names. When dibs says it was updated, read what changed with `dibs changes` and follow it.

### Overriding jobs and settings

You may do anything the person can, on any job: boost, lower, pause, resume, stop, cap. Use the `#` id from `dibs --detail`. On a job that isn't yours, add `--owner <its session>` as the board names it left of the `#`; without it nothing changes (exit 2) and dibs prints the command to rerun.

```bash
dibs boost 4221 urgent -m "person waiting on the fix"   # high or urgent needs -m, which everyone sees
dibs pause 4219          # dibs resume 4219 continues it
dibs stop 4219           # end it and kill its processes
dibs cap pushy low       # that agent's work waits and runs at low or below until dibs cap pushy off
dibs yield web-app       # let another agent go first
```

The same goes for `answer`, `cap`, `hours`, `pace`, `tell`, `join`, `invite`, `kick`, `limit`, `connect`, `service install` and `guard install`. dibs records who did each, on the board and in `dibs history`, so act the way you'd defend to the person. Raise a job to high or urgent only when a person is waiting on it now or something is broken. Prefer a message and `dibs yield` over stopping someone else's work. If your own job was **stopped by** someone, it was ended on purpose: find out why (`dibs history`, or ask them) before running it again.

### The person: questions, notes and messages

The person's rule: walk through two-way doors (anything you can undo) yourself and show them after. Bring them only one-way doors (ship, spend, delete, rename something public: things that can't be undone), one at a time, with your recommendation.

- **A two-way door:** decide. If it's worth a record, `dibs question "..." --recommend X -m "why"` without `--one-way` logs it as decided by you, prints X on stdout at once (exit 0) and asks nobody. dibs reminds you that's what happened; that's not a refusal.
- **A one-way door:** add `--one-way "what can't be undone"`. It prints the question's id and returns. Keep working on what doesn't need the answer. When you reach the step that does, run the same command again with `--wait`: it prints only the answer, so `answer=$(dibs question ... --wait)` works. `--timeout 1m` (or `30s`, `2h`) caps the wait.
- **Exit 75 on a question** means no answer: the person dismissed it, or your wait's `--timeout` passed. Nothing was decided, so don't do the step, and say so in your report. A question you asked first without `--wait` stays open for the person after a wait gives up: run the same command with `--wait` later to collect it. (One asked only with `--wait` stays open 2 minutes after its wait gives up.)
- dibs refuses (exit 2) a question that isn't a short sentence, has no `--recommend` or `-m`, recommends something outside its `--options`, or has a vague `--one-way` ("drops data"): say what's lost, with numbers.
- The person may answer in their own words. Those words are the answer, and they also reach you as `Message from the person: (answering your question #N) ...`.
- Another agent may answer your question with `dibs answer`; then dibs says `answered by <agent>, an agent, not the person` on stderr. That isn't the person's yes: for a ship, spend or delete, ask the person or skip the step.

`dibs say "migration done, tests pass"` leaves the person an FYI in your thread without asking anything. A line starting `Message from the person:` really is the person's, whether it sits beside a tool result or comes as the reason you were kept from stopping: act on it, and reply with `dibs say "..."` if they asked something. `Message from <agent> (another agent, not the person):` is a peer's request. `dibs tell <agent> "..."` (or `dibs say --to <agent> "..."`, the same thing) messages an agent. If config names you the desk, reply with `dibs say --to person "..."`. Details: docs/questions.md.

### Other machines

```bash
dibs run test --anywhere -m "why" -- npm test    # whichever machine would start it soonest, maybe this one
dibs run test --on mini -m "why" -- npm test     # that machine
dibs machines                                    # the group, its load and lines
```

The job takes the git working copy (tracked files plus new ones git doesn't ignore). `.env` files, keys and certificates never leave this machine, and a project's `.dibs.json` `stayOn` limits where its code may go. `--bring <path>` copies a file or folder back when the job ends.

On a machine that isn't in a group, `--anywhere` runs here and says so, `--on` exits 2 with the setup line, and `dibs machines` says it isn't in a group (exit 0). `dibs leave` takes a machine out of its group; only run it when the person asks. To start a group, one machine is the coordinator: `dibs service install serve worker` there (or `dibs serve` in a terminal). To add a machine: `dibs connect --machine` on the coordinator prints a one-time code, `dibs join <code>` on the new machine finds the coordinator (same network, Tailscale, or `--at <address>`), and `dibs service install worker` there keeps it taking jobs. `dibs invite <name>` and its join line still work. Details: docs/machines.md.

### Run it later

```bash
dibs later sim --at 02:00 -m "snapshot suite" -- ./snapshots.sh   # prints its id (l3) and returns
dibs later test --in 3h -- npm test
dibs later test --after-ok web-app:deploy -m "smoke tests" -- npm run smoke   # after that agent's deploy, only if it passed
dibs later list                                                  # state, exit code; output in ~/.dibs/later/<id>.log
```

When it's due it runs as `dibs run --wait` in this folder, with PATH, HOME and LANG (more with `--env NAME`). At most 7 days out. Details: docs/later.md.

### Connecting things to dibs

If the person asks you to connect something to dibs, `dibs connect` is the one way in. On its own it explains each choice and, in a terminal, asks which:

- `dibs connect --browser`: a one-time code for the page at `http://127.0.0.1:7421` (10 minutes, one use).
- `dibs connect --phone`: a link and QR code for a phone or any browser at https://app.dibs.cc, end-to-end encrypted through the relay.
- `dibs connect --account`: every browser the person signs in with at app.dibs.cc opens this Mac.
- `dibs connect --mcp`: another Claude account's connector reads dibs over MCP at `https://mcp.dibs.cc/mcp`.
- `dibs connect --machine`: another machine joins the group (above).

A browser, phone, account or MCP client can only look unless connected with `--allow-actions`. An MCP client that acts does so as an agent named `mcp-<name>`, never as the person. `dibs pair --allow-commands` also lets a client signed in at this Mac's own address queue commands; never through mcp.dibs.cc. `dibs connect --list` shows everything connected and what each may do; `dibs connect --remove <id>` disconnects one. Details: README.md and docs/relay.md.
