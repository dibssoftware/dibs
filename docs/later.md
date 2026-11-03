# dibs later

Schedule a run for a time, or for when something else ends. `dibs later` records the command and returns at once with an id. When it's due, it joins the queue as `dibs run --wait` would, from the folder you scheduled it in, and gets the same guarantees: a lease, its place in the queue by priority, the process tree killed when it ends. When it ends, the person gets a note in your thread (`dibs threads`) saying how: `l3 (ios snapshot suite) finished: exit 0. Log: ~/.dibs/later/l3.log`.

```bash
dibs later sim --at 02:00 -m "ios snapshot suite" -- ./snapshots.sh
dibs later test --in 3h -- npm test
dibs later test --after web-app -- npm run smoke          # when everything web-app holds or waits for now has ended
dibs later test --after web-app:deploy -- npm run smoke   # only its deploy
dibs later test --after 42 -- npm run smoke               # #42 on the board
dibs later deploy --after-ok l3 -- ./ship.sh              # after later job l3, only if it exited 0
dibs later list [--json]
dibs later cancel l3
```

## When

- `--at 02:00`, `--at 9pm`, `--at 2026-10-20T02:00`. A clock time already past today means tomorrow.
- `--in 90s`, `--in 3h`, `--in 2d`.
- `--after <what>`: a lease or waiter on the board (`42` or `#42`), an agent's name (`web-app`, or `web-app:deploy` for one resource), or an earlier later job (`l3`). It fires when that ends, however it ends.
- `--after-ok <what>`: the same, but only if it succeeded: exit 0, or a hold that ended. Otherwise the job is skipped, with the reason in `dibs later list`. A job after one that was cancelled or skipped is skipped too.

More than 7 days out is refused, and an `--after` job still waiting after 7 days is skipped. Plans that old should be made again.

## What it runs with

Your flags (`-m`, `-p`, `--est`, `--mem`, `--cpu`, `--disk`, `--port`, `--as`, `--anywhere`, `--on`, `--bring`), the folder you were in, and from your environment only PATH, HOME, LANG, LC_ALL, USER, SHELL and TMPDIR. Pass anything else by name: `--env NPM_TOKEN` (its value now) or `--env STAGE=prod`. The file that keeps them (`~/.dibs/later/jobs.json`) is readable only by you.

It runs as you, as the agent that scheduled it: the board shows `web-app (later l3)`. If its folder is gone by then, it fails with that reason instead of running somewhere else.

## Where it shows

- The board's Later rows (`LATER` on `dibs --detail`): what's scheduled, waiting in the queue and running.
- `dibs later list`: those, plus how each finished one ended: `done` with its exit code, `failed` (the command never started, or its folder was gone), `lost` (its `dibs run` was killed or the machine restarted: it isn't run again), `skipped`, `cancelled`. Kept for 7 days.
- `~/.dibs/later/<id>.log`: the command's stdout and stderr, with a first line saying when it started (and "ran late by 2h" if the machine was asleep at its time) and a last line with the exit code.

## Who starts it

The worker service (`dibs service install worker`). It already runs under launchd or systemd and comes back after a crash or a reboot, and it runs scheduled jobs whether or not this machine ever joined a coordinator. A machine that was asleep at a job's time runs it on wake and says how late it was.

Without the service, `dibs later` starts a runner of its own that stays until nothing is left to run. It doesn't survive a restart, and the scheduling command says so.

Any number of runners can be up: each job is claimed under a lock by exactly one of them. A run outlives its runner (a service restart, say), and how it ended is still recorded.
