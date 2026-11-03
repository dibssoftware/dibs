# Several machines

One machine runs the coordinator. Every machine that takes jobs runs a worker. Any machine in the group can send work to the others, and plain `dibs` shows every machine's board.

## Add a machine

```bash
dibs service install serve worker      # on the coordinator, once
dibs connect --machine                 # on the coordinator: a one-time code, e.g. K7QM-4XNA (dibs pair --machine is the same)
dibs join K7QM-4XNA                    # on the new machine: finds the coordinator and joins
dibs service install worker            # on the new machine: takes jobs from now on, across reboots
dibs machines                          # anywhere in the group: every machine, its load and lines
```

The code is 8 characters, works once, and lasts 10 minutes. Up to 5 can be open at once, and they live only in the coordinator's memory, so a restart ends them. `--name mini` makes a code for that name, which may replace a machine already called that; without it the new machine joins under its host name (or `dibs join <code> --name x`), and a name already in the group is refused.

`dibs join <code>` looks for the coordinator in three places:

- **The same network**: a UDP broadcast to the coordinator's port (7420 unless it serves on another). The coordinator listens for it only while a code is open, and answers at most 20 a second.
- **Tailscale**: every peer `tailscale status` shows online, at port 7420.
- **Anywhere else**: `--at <address>`.

The coordinator listens on 127.0.0.1 and on its Tailscale address (picked up within 30 seconds of Tailscale connecting). So a machine elsewhere on Tailscale joins as is; one on the same Wi-Fi without Tailscale needs the coordinator started with `--bind <its network address>`. Machine traffic is plain HTTP: on a network you don't trust, use Tailscale, which encrypts it. Machines never talk through the relay at app.dibs.cc, which carries the person's page only (64 KB calls; a worker needs working copies of up to 300 MB and live output).

Before the code goes anywhere, a machine that answered has to prove it holds it: the joiner sends 32 random bytes, and the coordinator answers with an HMAC over both sides' bytes, keyed by the code. Only then is the code sent and spent, and the machine gets a token of its own. After 10 wrong codes in 10 minutes, every try is refused until the window passes, the right code included.

`dibs connect --list` (or `dibs pair --list`) on the coordinator shows open codes and every machine in the group. `dibs pair --revoke <code id>` voids a code; `--revoke <machine>` removes a machine, as `dibs kick` does; `--revoke all` voids every open code and leaves the machines in.

Without codes: `dibs invite <name>` on the coordinator prints a line to run on the new machine, `dibs join <url> <token> --name <name>`. Inviting a name again replaces its old token.

## Send work

```bash
dibs run test --anywhere -- npm test                          # whichever machine would start it soonest, maybe this one
dibs run sim --on mini -- ./ui.sh                             # that machine
dibs run test --anywhere --bring coverage -- npm run cover    # copy coverage/ back when it ends
dibs run test --shards 2 -- npx vitest run                    # split a suite across machines, output and exit codes merged
```

**Where it goes.** The coordinator takes the machines reporting in that can run the job (sim and xcode-build need macOS, and the memory has to fit) and picks the one where it would wait least: the resource's line and slots there, load per core, low memory, jobs it was just sent. A machine that already has a free copy of your project, from an earlier job, gets a head start worth most of a job, so it wins unless a cold one would start a whole job sooner or is much less loaded. The machine you send from counts as the warmest of all and wins a near tie; if it wins, the job runs in place, exactly like a plain `dibs run`.

**What goes along.** The git working copy: tracked files, plus new files git doesn't ignore, uncommitted edits included. Outside git, the folder minus build output (`node_modules`, `DerivedData`, `build`, `dist`, `venv`, `__pycache__`, `Pods`, `target`) and hidden folders, except the ones builds read (`.github`, `.husky`, `.storybook`, `.swiftpm`, `.mvn`, `.yarn`, `.cargo`, `.devcontainer`, `.circleci`, `.changeset`, `.vscode`). Your home folder, or anything above it, is never sent: `--on` is refused and `--anywhere` runs here. A copy over 300 MB compressed is refused before anything is sent (exit 2): ignore build output in `.gitignore`.

**What never goes, even when tracked.** Secret-looking files: `.env*` and `*.env`, `.envrc`, `.dev.vars`, `.npmrc`, `.netrc` and the like, credentials, secrets and token files, cloud and Kubernetes configs, Terraform state and vars, private keys and certificates (`*.pem`, `*.key`, `*.p8`, `*.p12`, SSH keys), keychains, keystores, provisioning profiles, and everything in `.ssh`, `.aws`, `.gnupg` and `.dibs`. The full list is `SECRET` in src/remote.mjs. `GoogleService-Info.plist` does go: iOS builds need it, and Firebase treats it as public. Your environment doesn't go either; the job gets the worker's.

**On the other machine.** Each sender and project gets a folder in `~/.dibs/work`, kept between jobs so `node_modules` and build caches survive. Files you deleted are deleted there too. A folder unused for a week is removed, and every unused one goes when free disk falls under twice `minDisk`. The job runs through that machine's own `dibs run`, so it queues with that machine's agents and shows on its board as `you@yourmachine`.

**Coming back.** Output streams live (the coordinator keeps the last 16 MB of it), then the exit code. `--bring <path>` copies those files or folders back into your folder when the job ends; only the paths you named are unpacked.

**When it's lost.** Ctrl-C stops the remote job, and so does going away: nobody reading its output for 90 seconds. Two exit codes say a job was lost:

- **76, lost before it started.** The machine went quiet before picking it up and no other could take it, or the coordinator couldn't be reached. Nothing ran: send it again. With the coordinator unreachable, `--anywhere` runs here and `--on` another machine exits 76.
- **77, lost after it started.** The machine running it stopped reporting for 35 seconds or restarted, it was removed from the group mid-job, or the coordinator restarted and no machine took the job back within 2 minutes. It may have run, partly or fully, and may still be running. Check before running it again, above all a deploy. It's stopped when its worker comes back.

A coordinator restart (every dibs release does one) doesn't end jobs already running elsewhere: the worker keeps them going and holds their output and exit codes, and hands them over at its next check-in. Your `dibs run` says the coordinator restarted, waits up to 2 minutes, then carries on with every line once, in order. Jobs not yet started when it restarted are lost (76) and safe to send again.

**One board.** Plain `dibs` shows this machine's board first, then every other machine's leases and lines (who, what, the `-m` reason, priority, how long), then the jobs moving between them. Each worker sends its board with every check-in; one older than 20 seconds says so, and a machine that stopped reporting gets one line. Only what the board shows goes along: no pids, environment or full commands. If the coordinator doesn't answer within 1.5 seconds, you get this machine's board and one line saying the others couldn't be reached.

**Outside a group,** `--anywhere` runs here and says so, `--on` exits 2 with the line that sets a group up, and `dibs machines` says the machine isn't in a group (exit 0).

## Leave

```bash
dibs leave                             # on a machine that joined: it stops taking jobs and forgets the coordinator
dibs kick mini                         # on the coordinator: mini is out now, and its token stops working
```

`dibs leave` stops the machine's worker (the service, and one started by hand) and deletes `~/.dibs/remote.json`. The coordinator lists it as not reporting until `dibs kick <name>` there takes it off. On the coordinator itself, `dibs leave` refuses while any other machine is in the group and names them: kick each first. Then it removes the serve and worker services; a `dibs serve` running in a terminal keeps going until you stop it. Outside a group, `dibs leave` exits 1.

`dibs kick` takes effect on the machine's next request. Its jobs end for their senders with a line saying it was removed: 77 if they had started, 76 if not. Jobs it sent are stopped. `dibs machines` lists it under "removed" for a day. Its worker logs one line and waits for a new `dibs join` instead of exiting, so launchd or systemd doesn't restart it in a loop.

## Who may do what

- **One token per machine.** Each machine's token, from a code or `dibs invite`, works only for that name: it can't take jobs, read output or report results as another machine. The coordinator keeps the hashes in `~/.dibs/machines.json` (mode 600). Anyone holding a token can run commands on every worker, so an invite line goes only to the machine it names.
- **The coordinator's own token** (in its `~/.dibs/remote.json`) works only on the coordinator's machine, over loopback, and is the only one that can invite, kick or limit. From anywhere else it gets 401.
- **Anyone may run these.** `dibs join`, `leave`, `invite`, `kick`, `limit`, `service install` and `remove`, `guard install` and `remove`, and `serve --force` work from the person's terminal, the dibs app or an agent, and each goes in `dibs history` with who ran it. `join` logs the coordinator's address, never the token.
- **Limits**, on the coordinator:

```bash
dibs limit borrowed --only test        # borrowed takes only test jobs from other machines
dibs limit borrowed --sends none       # and may send no jobs to other machines (or --sends test,heavy)
dibs limit borrowed --any              # lift both
```

  Beyond `--sends`, `--on` another machine is refused and `--anywhere` runs on the sending machine. A machine with `--only` sees less of the others: the board and `dibs machines` show their work by resource, who and times, without commands, `-m` reasons, file lease paths or which projects they keep copies of. `dibs machines` shows each machine's limit, and invited machines that haven't joined yet.

## Where a project may go

A `.dibs.json` at a repo's root, committed so every clone has it, names the machines its code may go to:

```json
{ "stayOn": ["my-mac-mini"] }
```

The machine the job is sent from is always allowed, and `{"stayOn": []}` keeps the project home. Every `.dibs.json` in the folder you run from, the folders above it, and anywhere in the copy that would be sent applies; a job goes only where all of them agree. One that can't be read keeps the project home. A new machine is in no existing list, so it gets nothing until you add it.

The rule is checked three times: by the sender before anything is uploaded, by the coordinator when it places the job (and again if it moves one whose machine went quiet), and by the worker on the copy it unpacked, which refuses the job and deletes the copy if the rule rules it out. `--anywhere` with nowhere allowed runs here; `--on` a machine the rule or a limit rules out is refused, naming the rule, and nothing is sent.

## Machines that sleep until a job needs them

A cloud VM bills every second it runs, so dibs can keep one asleep and wake it only for work. On the coordinator, in `~/.dibs/config.json`:

```json
{ "machines": { "ondemand": [{ "name": "boat-1", "provider": "boat", "registry": "~/boat/VMS.md", "match": "dibs", "owner": "alex-3b" }] } }
```

**Which VM.** Never an id in config: VM ids change. The registry is a markdown table of who owns which VM, read by its column names (VM, Owner, Use, Notes; others are left alone). dibs takes the one row whose Use mentions `match` (and whose Owner is `owner`, when given) and checks that boat still has that VM. No row, more than one, or a VM boat doesn't have: `dibs machines` and the board say so, nothing is woken, and a job sent to it runs where it was sent from. dibs calls boat by id only and never touches another VM; the only VMs it makes or deletes are the temporary ones below. It keeps that row's Notes cell current ("Running dibs jobs ... since 20:14", "Stopped 20:31 by dibs (its queue is empty)"), rewriting only that cell and swapping the whole file into place.

**States.** `dibs machines` and the board show it `asleep`, `waking`, `running` or `stopping`. Asleep, it's a machine like any other for placement, except that a job there costs a wake.

**When it wakes.** `--on boat-1` always wakes it. `--anywhere` wakes it only when the job's wait on the best awake machine (about 3 minutes per job ahead) is longer than waking it (its last measured resume, or 45 seconds before the first) plus about 20 seconds of upload. With no awake machine to compare against, the job runs where it was sent from.

A job can also go there on its own, from any machine in the group, if the job can run there:

- It's been held 2 minutes by the machine it was sent from: its load, the memory or CPU budget, memory pressure, swap growth, the free disk swap needs, or a job ahead reserving memory.
- It's held for memory and dibs knows it usually uses more than that machine has: it goes at once.
- Its turn there is further off than 90 seconds plus its usual run time.

Jobs pack onto the VM while what's sent there fits its memory, less 1 GB. Jobs held for memory then go to the temporary VM made beside it (below), if that's on; the rest go only to a VM with room. A job never ships if it needs macOS (a macOS-only resource, a command naming a macOS tool, or a script that imports Apple frameworks such as Vision), if its project's `stayOn` keeps it here, if it runs from the home folder or a folder outside git, or if its command names a path on this machine (`/Users/...`, `~/...`, `/tmp/...`; `/usr/bin`, `/dev` and the like are fine). Without an on-demand machine in the config, none of this happens (docs/scheduling.md).

**Waking.** `boat resume`, then a reverse forward (`boat forward <id> --reverse --local <port>`), so the VM reaches the coordinator on its own 127.0.0.1, no Tailscale needed there. If the VM lacks Node v22.23.4 (pinned, checksum checked) or the coordinator's dibs version, they're installed. The VM gets a fresh token every wake, sent as a file, never on a command line, and a worker starts. boat's snapshot can bring back the VM's last worker on its old dibs; dibs stops it before starting its own, and an on-demand worker gets jobs only once it runs the coordinator's version. A first wake took 35 seconds on 2026-10-18 (resume 2.6 s, the rest installing Node and dibs); a later one, 19 seconds.

**Stopping.** Once nothing has run there or been sent to it for `idleStop` (30 seconds unless set, 3 minutes at most), the coordinator runs `boat stop`. boat's own one-hour auto-stop stays as the backstop, pushed back an hour every 30 minutes while a job runs. The VM's worker runs with `--ephemeral`: when it can't reach the coordinator for a minute (10 with a job running), it leaves. A coordinator that stops leaves a VM with jobs running up. One that starts and finds its VM up looks at what runs there (`boat ps`): its own worker with jobs, it takes the VM back; other work using CPU, it leaves the VM running and says so; nothing, it stops it. Every resume and stop is an event (`kind: "ondemand"`) with the seconds billed.

**Nothing kept.** Treat everything on the VM as gone after a stop: each job's copy there is deleted when the job ends, after `--bring` has sent back what you asked for. Node and dibs stay installed between wakes, since installing them again costs about 30 billed seconds. `.dibs.json` `stayOn` and machine limits apply as for any machine.

**When boat says no.** Before waking or making a VM, dibs reads `boat limits --json` (at most once a minute). With no starts left for the day or the hour, or `canStart` false, it doesn't try. A wake that fails anyway (a 429, say) is handled the same way: the jobs sent there go back to the machine that sent them when it takes jobs, and are lost (76) only when there's nowhere to go. The VM is marked `can't wake` with the reason and a time to try again: an hour for a quota or a 429, 5 minutes for anything else. Until then `dibs machines` shows `can't wake: <reason>`, `--anywhere` and jobs dibs ships on its own skip it, and a job sent `--on` it runs on the machine that sent it, saying why.

### A VM made for a job too big for it

Off unless set. Add `"create": { "max": "large" }` to the entry (`small`, `default` or `large`: the biggest dibs may make):

```json
{ "machines": { "ondemand": [{ "name": "boat-1", "provider": "boat", "registry": "~/boat/VMS.md", "match": "dibs", "owner": "alex-3b", "create": { "max": "large" } }] } }
```

- `dibs machines` then lists `boat-1-temp` beside `boat-1`. A job sent `--on boat-1` asking more `--mem` than it has (8 GB unless `mem` says) or more `--cpu` than its cores (4 unless `cores` says) goes to `boat-1-temp` instead, and so does `--anywhere` when that's the shorter wait. Only `--cpu` makes a VM, never a resource's own guess at cores.
- dibs makes the smallest size that takes every job waiting for it (`boat new --type small|default|large`: 2 cores and 4 GB, 4 and 8, 8 and 16), never with `--no-auto-stop`, and adds its row to the registry at once (Kind `temporary`, Owner `owner`). It's set up like a wake, Node included.
- Once its queue has been empty for `idleStop`, or anything fails, dibs deletes it (`boat delete <id> --yes`) and its row. If boat won't delete it, the row stays and says how to delete it by hand.
- A coordinator that starts deletes temporary VMs and rows of its own that a crash left behind. Nobody else's are touched.
- A job bigger than `max` is refused with the reason. One real run on 2026-10-19: a 3 GB job, a small VM made in 2 seconds and running in 35, deleted with its row 40 seconds after the job; 74 seconds billed.

`test/live/two-machines.sh` runs all this for real against the registry's VM: a coordinator on the VM through a boat forward, jobs each way, `--bring`, a worker killed mid-job (77), kick, then the VM woken on demand and stopped (`--temp` adds a temporary VM). It bills a few minutes, so it isn't part of the suite.

## Running by hand

`dibs serve --listen 7420` and `dibs worker --name x` run them in a terminal instead of as services. `dibs serve` writes `~/.dibs/remote.json` only once it's listening, and on a machine joined to another coordinator it refuses unless you pass `--force`, which leaves that group. It listens on no interface besides 127.0.0.1 and Tailscale unless you pass `--bind`. `dibs service status` shows what's installed and `dibs service remove worker` takes one out. Services are launchd agents on macOS, `systemd --user` units on Linux and logon tasks on Windows; logs go to `~/.dibs/<service>.log`.
