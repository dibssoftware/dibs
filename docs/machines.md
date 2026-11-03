# Several machines

One machine runs the coordinator, every machine that takes jobs runs a worker, and any machine can send work:

```bash
dibs service install serve worker      # on the coordinator machine
dibs pair --machine                    # on the coordinator: a one-time code, e.g. K7QM-4XNA
dibs join K7QM-4XNA                    # on mini: finds the coordinator and joins
dibs service install worker            # on mini
dibs run test --anywhere -- npm test   # whichever machine would start it soonest, maybe this one
dibs run sim --on mini -- ./ui.sh      # that machine
dibs run test --anywhere --bring coverage -- npm run cover   # copy coverage/ back afterwards
dibs machines                          # load and lines on every machine, which ones have this project, and the jobs moving between them
dibs                                   # the board, with every machine's leases and lines under this one's
```

- **Where a job goes.** The coordinator scores each machine that's reporting in and fits the job (sim and xcode-build need macOS, memory must fit) by how long the job would wait there: the resource's line and slots on that machine, its load per core, low memory, and jobs it was just sent. A machine that already has a free copy of your project (from an earlier job) gets most of one job's head start, so it wins unless a cold machine would start a whole job sooner or is much less loaded; no reinstall, no cold build. A copy another job is using doesn't count, since that job's folder is taken. The sender's own machine counts as the warmest of all and wins a near tie with any of them. If it wins, the job runs in place exactly like a plain `dibs run`.
- **What goes along.** The git working copy: tracked files plus new files git doesn't ignore, uncommitted edits included. Outside git, the folder minus build output, `node_modules` and hidden folders, except the ones builds read (`.github`, `.husky`, `.storybook`, `.swiftpm`, `.mvn`, `.yarn`, `.cargo`, `.devcontainer`, `.circleci`, `.changeset`, `.vscode`). dibs won't send your home folder or anything above it: `--on` is refused and `--anywhere` runs here.
- **What never goes, even when tracked.** `.env*` and `*.env`, `.envrc`, `.dev.vars`, `.npmrc`, `.yarnrc.yml`, `.netrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `.my.cnf`, `.htpasswd`, `.vault-token`, `.boto`, `.s3cfg`, `auth.json`, `token.json`, `token.pickle`, SSH private keys and `deploy_key`, `credentials` and `secrets` files (no extension, or json, yaml, toml, env, txt, ini, csv, with or without a leading dot), `*service-account*.json`, `*-firebase-adminsdk-*.json`, `client_secret*.json`, `*.tfvars`, `*.tfstate` and its `.backup`, `kubeconfig*`, `.kube/config`, `.docker/config.json`, `.config/gh/hosts.yml`, `*.p8`, `*.p12`, `*.pfx`, `*.pem`, `*.key`, `*.asc`, `*.gpg`, `*.ppk`, keychains, keystores, provisioning profiles, and everything inside `.ssh`, `.aws`, `.gnupg` and `.dibs`. `GoogleService-Info.plist` does go along, because iOS builds need it and Firebase treats it as public. Nothing from your environment goes either: the job gets the worker's environment.
- **On the other side.** Each sender and project gets a folder in `~/.dibs/work` that is kept between jobs, so `node_modules` and build caches survive. Folders unused for a week are deleted, and all unused ones go when free disk drops under twice `minDisk`. Files you deleted are deleted there too. The job runs through that machine's own `dibs run`, so it queues with that machine's local agents and shows on its board as `you@yourmachine`.
- **One board.** Once a machine has joined, plain `dibs` shows this machine's board first, then every other machine's leases and lines (who, what, the `-m` reason, priority, how long), then the jobs moving between machines. Each worker sends its board with every check-in, so it's at most a few seconds old; one older than 20 seconds says so, and a machine that stopped reporting gets one line. Only what the local board shows goes along: no pids, environment or full commands. If the coordinator doesn't answer within 1.5 seconds, you get this machine's board as usual plus one line saying the others couldn't be reached.
- **Coming back.** Output streams live (the coordinator keeps the last 16M), then the exit code. `--bring path` copies files or folders back into your folder when the job ends; only the paths you named are unpacked, whatever else comes back.
- **Failures.** Ctrl-C stops the remote job. Two exit codes say the job was lost, and they say different things:
  - **76: lost before it started.** The machine went quiet before picking the job up and no other machine could take it, or the coordinator couldn't be reached. Nothing ran, so sending it again is safe. If the coordinator is unreachable, `--anywhere` runs here; `--on` another machine exits 76. On a machine that never joined a group, `--anywhere` runs here and says so, while `--on` and `dibs machines` exit 2 with the line that sets one up.
  - **77: lost after it started.** The machine running it stopped reporting for 35 seconds or restarted, it was removed from the group mid-job, or the coordinator restarted and no machine picked the job up again within 2 minutes. It may have run, partly or fully, and may still be running. Check before running it again, above all for deploys. Its job is stopped when its worker comes back.
  - If you go away (nobody reads the output for 90 seconds), the job is stopped.
- **A coordinator restart** (every dibs release does one) doesn't end jobs already running on other machines. The worker keeps the job running and holds its output and exit code until the coordinator is back, and its next check-in hands the job over again. Your `dibs run` says the coordinator restarted, waits up to 2 minutes for that, then carries on with every line once, in order. Jobs not yet started when it restarted are lost (76) and safe to send again.
- **A working copy over 300M compressed** is refused before anything is sent, with exit 2: ignore build output in `.gitignore`.
- **Network and trust.** The coordinator listens on 127.0.0.1, plus the machine's Tailscale address when it has one (it picks that up within 30 seconds of Tailscale connecting). It asks the Tailscale CLI for that address, or failing that takes a 100.64.0.0/10 address on a tunnel interface. It never listens on other interfaces unless you pass `--bind`. Every request needs a token, and anyone with one can run commands on your workers, so see below.

## Machines that sleep until a job needs them

A cloud VM bills every second it runs, so dibs can keep one asleep and wake it only for work. On the coordinator, in `~/.dibs/config.json`:

```json
{ "machines": { "ondemand": [{ "name": "boat-1", "provider": "boat", "registry": "~/boat/VMS.md", "match": "dibs", "owner": "alex-3b" }] } }
```

- **Which VM.** Never an id in config: VM ids change. The registry is a markdown table of who owns which VM, read by its column names (VM, Owner, Use, Notes; others, like Kind, are left alone). dibs takes the one row whose Use mentions `match` (and whose Owner is `owner`, when given) and checks that boat still has that VM. No row, more than one, or a VM boat doesn't have: `dibs machines` and the board say so in plain words, nothing is woken, and a job sent to it runs where it was sent from. dibs never touches any other VM, and calls boat by id only. The only VMs it creates or deletes are the temporary ones below, when `create` is set.
- **Its row.** dibs keeps that row's Notes current ("Running dibs jobs ... since 20:14", "Stopped 20:31 by dibs (its queue is empty)"). It rewrites only that cell, keeps the rest of the file as it was, and writes the file whole and renames it into place.
- **Asleep.** `dibs machines` and the board show it as `asleep`, then `waking`, `running` and `stopping`. Asleep, it's a machine like any other for placement, except that taking a job costs waking it.
- **When it wakes.** `--on boat-1` always wakes it. `--anywhere` wakes it only when the job's wait on the best awake machine (jobs ahead, at about 3 minutes each) is longer than waking it (its last measured resume, or 45 seconds before the first) plus about 20 seconds of upload. With no awake machine to compare against, the job runs where it was sent from.
- **Waking.** `boat resume`, then a reverse forward (`boat forward <id> --reverse --local <port>`), so the VM's own 127.0.0.1 reaches the coordinator with no Tailscale on the VM. If the VM lacks Node v22.23.3 (pinned, checksum checked) or this coordinator's dibs version, they're installed (`boat push` of the coordinator's dibs). Then the VM gets a token of its own, a fresh `dibs invite` every wake, sent as a file and never on a command line, and a worker starts. Processes don't survive a stop, so this repeats on every wake, minus the installs. A first wake took 35 seconds on 2026-10-18 (resume 2.6 s, the rest installing Node and dibs).
- **Waking.** boat's snapshot can bring the VM's last worker back, on the dibs it ran before. dibs stops that worker before starting its own (in a call that ends before the new one starts), and an on-demand VM's worker gets jobs only once the VM is up and the worker runs the coordinator's version. A VM whose worker is on an older dibs (one taken back running jobs after a restart) finishes those jobs, stops, and the jobs waiting for it wake it again with the current version.
- **Stopping.** Once nothing has run there or been sent to it for `idleStop` (30 seconds unless set, enough for a script's next job to follow its last; 3 minutes at most), the coordinator stops it with `boat stop`. boat's own one-hour auto-stop stays as the backstop, pushed back an hour every 30 minutes while a job runs there. A coordinator that stops leaves a VM running jobs up. One that starts and finds its VM up looks at what runs there (`boat ps`): dibs's own worker with jobs, it takes the VM back and the jobs carry on; other work using CPU, it leaves the VM running and says so; nothing, it stops it. A VM's worker with a job running waits 10 minutes for its coordinator, not one. A project's copy stays on the VM between jobs, as on any worker, so its node_modules, build output and the browsers in `~/.cache` are there for the next job; a copy unused for a week, or any idle one when the VM's disk runs low, is deleted. The VM's worker runs with `--ephemeral`: when it can't reach the coordinator for a minute (the forward or the coordinator gone), it leaves. Every resume and stop is an event (`kind: "ondemand"`) with seconds billed.
- **Woken twice.** A later wake finds Node and dibs there and skips both: 19 seconds from asleep to running on 2026-10-19, when dibs itself needed updating.
- **Nothing kept.** Treat everything on the VM as gone after a stop. Each job's copy there is deleted when the job ends, after `--bring` has sent what you asked for back, so there's no warm copy to save upload time next wake: its disk is billed storage and may be wiped. Node and dibs stay installed between wakes, since installing them again costs about 30 seconds of billed time.
- **Rules still apply.** `.dibs.json` `stayOn` and machine limits work as for any machine.
- **When boat says no.** Before waking or making a VM, dibs reads `boat limits --json` (at most once a minute). With no starts left for the day or the hour, or `canStart` false, it doesn't try. A wake or make that fails anyway (a 429, say) is handled the same way: the jobs sent to that VM go back to the machine that sent them when it takes jobs, and are lost (76) only when there's nowhere to go. The VM is marked `can't wake` with the reason and a retry time: an hour for a quota or 429, 5 minutes for anything else. Until then `dibs machines` shows `can't wake: <reason>, retry 14:20`, `--anywhere` and jobs dibs sends on its own skip it, and `--on` it is refused with that line.
- **Jobs the machine holds.** On the coordinator, a job held for 2 minutes by the machine (its load, the memory or CPU budget, memory pressure, swap growth, the free disk swap needs, or a job ahead of it reserving memory) goes to an on-demand machine on its own, as if sent `--on` it. Jobs pack onto the dedicated VM while what's sent there fits its memory (its size less 1 GB). Jobs held for memory then go to the one VM made beside it (up to `create.max`); the rest only go to a VM with room. So a crunch costs one or two boat starts, not one per job. A VM boat can't start now (its starts used up) isn't tried. A job ships only when it can run there: never one that needs macOS (a macOS-only resource, a command naming a macOS tool, or a script that imports Apple frameworks such as Vision), one its project's `stayOn` keeps here, one from the home folder or from a folder outside git, or one whose command names a path of this machine (`/Users/...`, `~/...`, `/tmp/...`; `/usr/bin`, `/dev` and the like are fine): those files aren't in the copy. Without an on-demand machine in the config, nothing changes (docs/scheduling.md).

### A VM made for a job too big for it

Off unless set. Add `"create": { "max": "large" }` to the entry (`small`, `default` or `large`, the biggest dibs may make):

```json
{ "machines": { "ondemand": [{ "name": "boat-1", "provider": "boat", "registry": "~/boat/VMS.md", "match": "dibs", "owner": "alex-3b", "create": { "max": "large" } }] } }
```

- `dibs machines` then lists `boat-1-temp` beside `boat-1`. A job sent `--on boat-1` with more `--mem` than it has (8 GB unless `mem` says) or more `--cpu` than its cores (4 unless `cores` says) goes to `boat-1-temp` instead, and so does `--anywhere` when it's the cheaper wait. A resource's own guess at cores never makes a VM; only `--cpu` does.
- dibs makes the smallest boat size that takes every job waiting for it (`boat new --type small|default|large`: 2 cores and 4 GB, 4 and 8, 8 and 16), never with `--no-auto-stop`, and adds its row to the registry right away (Kind `temporary`, Owner `owner`). It's set up like a wake, Node included: a first job waits about 35 seconds on a small one.
- Once its queue has been empty for `idleStop`, or anything fails, dibs deletes it (`boat delete <id> --yes`) and takes its row out. If boat won't delete it, the row stays, saying so and how to delete it by hand.
- A coordinator that starts finds rows of its own temporary VMs a crash left behind (Kind `temporary`, its own Use text) and deletes those VMs and rows. Nobody else's are touched.
- A job bigger than `max` is refused with the reason. One real run on 2026-10-19: a 3 GB job, a small VM made in 2 seconds, running in 35, deleted with its row 40 seconds after the job, 74 seconds billed.

`test/live/two-machines.sh` runs the real thing against the registry's VM: a coordinator on the VM reached through a boat forward, jobs each way, `--bring`, a worker killed mid-job (77), kick, then the VM woken on demand and stopped. `--temp` adds a temporary VM. It bills a few minutes, so it isn't part of the suite.

## Who's in the group

### Pairing a machine with a code

`dibs pair --machine` on the coordinator prints a one-time code: 8 characters (40 bits), one use, 10 minutes, the same kind `dibs pair` gives the page. `--name mini` makes the code for that name, and lets it replace a machine of that name already in the group; without it, the new machine joins under its own host name (or `dibs join <code> --name x`), and a name already in the group is refused. Up to 5 codes are open at once. They live only in the coordinator's memory, so a restart ends them.

On the new machine, `dibs join <code>` looks for the coordinator:

- **The same network.** A UDP broadcast on port 7420 from every interface. The coordinator listens for it only while a code is open, and answers at most 20 a second with the addresses it serves on.
- **Tailscale.** Every peer `tailscale status` shows online, at port 7420.
- **Anywhere else.** `--at <address>` names it.

Before the code goes anywhere, each machine that answered has to prove it holds the code: the joiner sends 32 random bytes, and the coordinator answers with an HMAC over both sides' random bytes under a key made from the code. A machine that answers without the code learns only random bytes. Then the joiner sends the code, the coordinator spends it and gives the machine a token of its own, as `dibs invite` would. Ten wrong codes in 10 minutes and every try is refused until the window passes, the right code included; open codes stay good.

The coordinator has to be reachable from the new machine. By default it listens on 127.0.0.1 and its Tailscale address, so a machine elsewhere on Tailscale joins; one on the same Wi-Fi without Tailscale needs the coordinator started with `--bind <its network address>`. Machine traffic is plain HTTP, so on a network you don't trust use Tailscale, which encrypts it. The encrypted relay behind https://app.dibs.cc carries the person's page only: its calls are request and answer, at most 64 KB each, and a worker needs working copies of up to 300M and output streamed live, so machines don't pair or talk through it.

`dibs pair --list` on the coordinator shows the open codes and every machine in the group (joined with a code, or invited). `dibs pair --revoke <code id>` voids a code; `dibs pair --revoke <machine>` removes the machine, as `dibs kick` does. `--revoke all` voids every open code and leaves the machines in. The dibs page's Machines screen has the same as "Pair a machine", on this Mac only, never through the relay: whoever joins can run commands on every machine.

### Invite lines

Each machine gets its own token from `dibs invite <name>`, run on the coordinator, or from a pairing code. The token only works for that name: a machine can't take jobs, read output or report results as another one. The coordinator keeps the tokens' hashes in `~/.dibs/machines.json` (mode 600).

```bash
dibs invite mini                     # new token for mini; inviting it again replaces the old one
dibs kick mini                       # mini's token stops working now
dibs limit borrowed --only test      # borrowed only takes test jobs from other machines
dibs limit borrowed --sends none     # and may send no jobs to other machines (or --sends test,heavy)
dibs limit borrowed --any            # lift both
```

- **Kick.** The token stops working on the next request. Jobs on that machine end for their senders with a line saying it was removed: exit 77 if they had started (they may have run), 76 if not. Jobs it sent are stopped. It leaves `dibs machines`, which lists it under "removed" for a day. Its worker logs one line and waits for a new `dibs join` instead of exiting, so launchd or systemd doesn't restart it in a loop.
- **Anyone may run these.** `dibs join`, `invite`, `kick`, `limit`, `service install` and `remove`, `guard install` and `remove`, and `serve --force` work from the person's terminal, the dibs app, or an agent. Each one goes in `dibs history` (an `override` event) with who ran it; `join` logs the coordinator's address, never the token. An invite line still lets its holder run commands on every machine in the group, so send it only to the machine it names.
- **The coordinator's own token** (in its `~/.dibs/remote.json`) works only from the coordinator's machine, over loopback. It's the only token that can invite, kick or limit. A request that brings it from anywhere else gets 401, so a copy of the old shared token, from before machines had their own, is useless off that machine. Run `dibs invite` for each of the others.
- `dibs machines` shows invited machines that haven't joined yet, and each machine's limit.
- **A limited machine sees less.** On a machine with `dibs limit --only`, the board and `dibs machines` show other machines' work by resource, who and times only, without their commands, `-m` reasons, file lease paths (all of a machine's file leases show as one `files:` line) or which projects it keeps copies of. Its own jobs, and jobs it runs, show in full.
- **What a machine may send.** `--sends` caps what a machine may send elsewhere. Beyond it, `--on` another machine is refused and `--anywhere` runs on the sending machine.

## Where a project may go

A `.dibs.json` at a repo's root, committed so every clone carries it, names the machines its code may go to:

```json
{ "stayOn": ["my-mac-mini"] }
```

The machine the job is sent from is always fine. `{"stayOn": []}` keeps the project home. Every `.dibs.json` in the folder you run from, any folder above it, or anywhere in the copy that would be sent applies, and a job goes only where all of them agree. A `.dibs.json` that can't be read keeps the project home.

The sender checks the rule before anything is uploaded and sends the coordinator the rule all of them make together, `.dibs.json` files inside the copy included. The coordinator skips machines it rules out (and machines whose limit doesn't cover the job) when placing, and again if it has to move a job whose machine went quiet. The worker reads the `.dibs.json` files in the copy it unpacked and refuses the job, deleting the copy, if they rule it out. `--anywhere` with nowhere allowed runs here. `--on` a machine the rule or a limit rules out is refused with the rule's name and nothing is sent. A new machine is never in an existing list, so it gets nothing until you add it.

`dibs serve --listen 7420` and `dibs worker --name x` run them in a terminal instead. `dibs serve` writes `~/.dibs/remote.json` only once it is listening, and on a machine joined to another coordinator it refuses unless you pass `--force`, which leaves that group. `dibs service status` shows what's installed; `dibs service remove worker` takes it out. Services are launchd agents on macOS, `systemd --user` units on Linux and logon tasks on Windows. Logs go to `~/.dibs/<service>.log`.
