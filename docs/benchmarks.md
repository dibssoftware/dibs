# Does dibs speed work up or slow it down?

Measured on 2026-10-14, on a 10-core (4 performance, 6 efficiency), 16 GB Mac, with 0.0.72 and with this branch. Everything here can be rerun: the commands are under each section.

## Short answer

Before this branch, on a busy night, dibs made most work wait for a machine that had room. Tonight agents waited about 10 hours in all over 97 minutes, and for 72% of that waiting dibs's own running jobs were measured using few enough cores, with at least 25% of memory free, that the waiter would have fit. Three things held them, in this order:

1. **A memory budget counting what jobs asked for, not what they held.** Running leases were handed out 6.0G of memory on average while their measured peaks added up to 3.4G (holds aren't measured, so part of the gap is simulator holds). 45% of all waiting traces back to the memory budget, mostly by standing in line behind a job the budget held.
2. **One command planned at 14.1G.** An Xcode build measured 14.1G (15.1 GB) at its peak, which is bigger than the 11G budget, so every later run of the same command could run only "when nothing else is", and 0.0.72 counted every lease as something: its own agent's simulator hold and other agents' hour-long file leases. It could never start, and after 3 minutes (`starveAfter`) everyone behind it stopped passing it. At 00:32 and again at 00:53 this held seven or eight agents' work while the Mac showed 62 to 66% memory free.
3. **The load ceiling** (pace normal, `maxLoad` 10) reading a load average swollen by swapping: 14% of waiting directly, 7% more behind it. The median load reading was 8.4 and peaked at 173 while processes used 1 to 1.3 cores. 0.0.72 already fixed this (the ceiling reads cores in use).

What the branch changes: own holds and file leases no longer stop an oversized job; a job that can't start yet only blocks jobs that wouldn't finish before it could; the CPU budget counts measured cores; and `pace max` uses 1.5 measured cores per core and never skips the memory budget. In the simulator, with six agents on a model of this Mac, the same work finishes **26% sooner than tonight's settings** (34.8 minutes against 47.0), **34% sooner than no dibs**, with no swapping and no failed jobs. On tonight's own recorded work, the slowest 10% of jobs finish in 2.5 minutes instead of 11.1. On real processes (CPU-bound jobs on the efficiency cores), the old settings took 31 to 69% longer than no dibs, and the new CPU budget brought that to 2%.

Most of that is already on main: 0.0.73 (oversized jobs) and 0.0.74 (roomy reads cores in use) bring the owner's settings to 42.4 minutes, and pace max on main to 35.4. What's left on the branch is worth 1 to 3% of speed and all of pace max's swapping; see "Each proposal against main".

The comparison with no dibs depends on how bad swapping is, which no safe benchmark can measure on a shared Mac. If swapping cost nothing, no dibs would finish 25% sooner than dibs, and the OS would still have killed about 9 jobs for running out of swap. See "How much the model matters".

## 1. Tonight's waits

```bash
node bench/waits.mjs ~/.dibs                          # read only; replays the event log through the scheduler
node bench/waits.mjs ~/.dibs path/to/0.0.72/src       # with the scheduler that ran then
```

The event log covered 03:15 to 04:52 UTC (23:15 to 00:52 on the Mac), 125 waits. Every 5 seconds of every wait was replayed through the real `verdict()` with the leases, queue and nearest load sample of that moment, and the rule that held it was counted. "Ahead" waits were followed to the waiter in front, up to 5 deep, to name what held the front of the line.

| what held the waiter | waiting | share |
|---|---|---|
| behind someone, who waited on the memory budget | 203m | 34% |
| load ceiling | 84m | 14% |
| replay says it could start (rules the replay can't see: nesting, the exact load) | 67m | 11% |
| memory budget | 66m | 11% |
| behind someone who could start (one poll late, or a wrong forecast) | 43m | 7% |
| behind someone, who waited on the load ceiling | 38m | 6% |
| behind someone, who waited on the CPU budget | 35m | 6% |
| CPU budget | 34m | 6% |
| slot (resource in use) | 27m | 5% |

For 433 of the 597 waiting minutes (72%), dibs's running jobs were measured using few enough cores that the waiter would fit on 10, and memory was at least 25% free. Load samples: median 8.4, max 173. Memory free: median 50%, min 32%. Peak swap on the machine during the evening: 6.7G.

The `dibs history` totals the lead quoted (test busy 29 minutes, waited 1h40m; xcode-build busy 16 minutes, waited 54 minutes) come from the same log.

## 2. The simulator

```bash
node bench/sim.mjs                                         # 6 synthetic agents, 3 seeds, every scenario
node bench/sim.mjs --agents 8 --seeds 5
node bench/sim.mjs --workload bench/workloads/tonight.json # tonight's recorded work
node bench/sim.mjs --src ../other/src                      # the same with another scheduler
```

`bench/sim.mjs` runs dibs's real scheduler (`verdict()`, `sized()`, `jobSize()` and the config loading, imported from `src/`) against a model of the Mac, every 2 seconds of simulated time. It takes about a second per scenario and touches nothing.

The model, and what it assumes:

- 10 cores, 16 GB. Work outside dibs uses 2 cores and 6 GB (what the machine showed beyond dibs's jobs tonight).
- CPU is shared: past 10 runnable cores, every job slows by the same factor.
- A job's average CPU is 60% of the peak dibs measured, and it holds 80% of its measured peak memory for its whole run.
- Memory past 90% of RAM swaps. Swapping slows every job by `1 / (1 + 3 x swapped / RAM)`; past 8G of swap the largest job is killed.
- A run taking more than 3 times its length fails (a test timeout). An agent reruns a failed job up to twice.
- Agents wait for their own work: a job submitted after the same agent's earlier job ended arrives that same gap after it ends in the simulation. One step in five starts alongside the previous one.
- dibs measures each running job 10 seconds after it starts.

The synthetic workload: each agent does 10 things in a row with 15 to 75 seconds between them, picked from test suites (40%, 60 s, 4 cores peak, 1.4G), builds (22%, 90 s, 7 cores, 3G), clean builds (3%, 240 s, 9 cores, 7G), heavy jobs (10%), browser suites (10%), simulator holds (10%, 4 minutes) and deploys (5%). Half of agent 1's work is high priority. Shapes come from tonight's measured runs.

`bench/workloads/tonight.json` is tonight's event log (126 leases) with agents and commands renamed, made by `node bench/trace.mjs ~/.dibs`.

### Six agents, synthetic, 5 seeds

Makespan is the time until every agent's work is done. Job time is arrival to finish, including reruns. "failed" counts jobs killed or timed out, per run.

| settings | scheduler | makespan | vs no dibs | p50 job | p90 job | p90 wait | high p90 wait | peak swap | failed |
|---|---|---|---|---|---|---|---|---|---|
| no dibs | | 53.0m | | 4.7m | 10.6m | 0s | 0s | 9.3G | 63.6 |
| owner's live settings | 0.0.72 | 47.0m | -11% | 3.5m | 8.3m | 6.3m | 3.0m | 0.5G | 0 |
| stock defaults | 0.0.72 | 44.8m | -15% | 3.2m | 7.3m | 4.6m | 4.1m | 3.6G | 1.2 |
| pace quiet | 0.0.72 | 1.4h | +55% | 7.6m | 14.0m | 12.2m | 5.4m | 0.0G | 0 |
| pace normal | 0.0.72 | 48.5m | -8% | 3.5m | 8.3m | 6.3m | 2.9m | 0.0G | 0 |
| pace max | 0.0.72 | 36.3m | -31% | 2.3m | 6.6m | 4.1m | 2.4m | 1.4G | 0 |
| owner's live settings | branch | 44.6m | -16% | 2.7m | 8.0m | 5.8m | 3.8m | 0.0G | 0 |
| stock defaults | branch | 44.5m | -16% | 3.5m | 6.8m | 4.4m | 4.5m | 4.2G | 1 |
| pace normal | branch | 48.2m | -9% | 3.7m | 8.6m | 6.4m | 2.1m | 0.2G | 0 |
| **pace max** | **branch** | **34.8m** | **-34%** | **1.9m** | **5.6m** | **2.9m** | **2.2m** | **0.0G** | **0** |
| pace max, owner's cores 10 and budget 11G pinned | branch | 40.8m | -23% | 2.2m | 7.3m | 4.9m | 2.3m | 0.0G | 0 |
| pace max, skipping budgets when roomy (0.9 load per core, 25% free) | branch | 34.9m | -34% | 1.8m | 5.4m | 2.8m | 1.9m | 1.1G | 0 |
| no budgets, slots only | branch | 34.2m | -36% | 2.4m | 5.3m | 2.3m | 2.3m | 3.6G | 0 |
| pace max, memory budget counts measured use | branch | 34.5m | -35% | 1.8m | 5.6m | 2.4m | 1.6m | 1.0G | 0 |
| like that, twice the slots (an overlap mode) | branch | 31.2m | -41% | 2.0m | 5.0m | 2.6m | 57s | 1.6G | 0 |
| pace max, test 4, heavy 2, playwright 3 slots | branch | 33.1m | -38% | 2.2m | 5.3m | 3.1m | 2.0m | 0.0G | 0 |
| pace max, starveAfter 10m | branch | 33.2m | -37% | 2.0m | 5.2m | 3.1m | 1.9m | 0.0G | 0 |

Four and eight agents tell the same story. With 4 agents, pace max on the branch takes 26.0m against 30.3m for the owner's settings and 28.9m for no dibs (7.2 failures, 5.8G swap). With 8, 45.3m against 56.5m and 1.1h (159 failures, 11.3G swap).

### Tonight's recorded work

Tonight's work was light and long-chained (one 41-minute simulator hold, one 9-minute build), so total time barely moves: every setting finishes within 7% of no dibs. What moves is how long the slowest jobs take.

| settings | scheduler | p50 job | p90 job | p90 wait | peak swap | failed |
|---|---|---|---|---|---|---|
| no dibs | | 27s | 1.4m | 0s | 8.7G | 3 |
| owner's live settings | 0.0.72 | 53s | 11.1m | 1.5m | 4.8G | 0 |
| owner's live settings | branch | 46s | 8.5m | 1.2m | 5.5G | 0 |
| pace max | branch | 39s | 2.5m | 53s | 4.6G | 0 |
| pace max, owner's pins | branch | 47s | 3.6m | 1.2m | 4.6G | 0 |

The swap here is the 14.1G build: once it runs, nothing dibs does can stop the machine swapping.

### How much the model matters

dibs's runs never swap much, so its numbers barely change with the swap model. No dibs changes a lot. Six agents, 5 seeds, pace max on the branch at 34.8m throughout:

| swap slowdown factor | swap before kills | no dibs makespan | no dibs failures |
|---|---|---|---|
| 0 (swapping is free) | 8G | 26.0m | 9 |
| 0 | 16G | 28.3m | 1.4 |
| 1 | 8G | 30.1m | 13 |
| 1 | 16G | 49.1m | 30 |
| 3 (used above) | 8G | 53.0m | 64 |
| 6 | 8G | 57.1m | 82 |

Run it with `SIM_SWAP_SLOW=1 SIM_SWAP_MAX=16 node bench/sim.mjs`. Tonight a build that takes 48 seconds took 9.4 minutes while the machine swapped, and the load average reached 173, so a factor of 1 or less looks optimistic.

## 3. The real benchmark

```bash
~/bin/dibs run heavy -p low -m "dibs benchmark" -- node bench/run.mjs --reps 2
```

`bench/run.mjs` starts 4 simulated agents, each running 5 jobs in a row (1 to 4 seconds apart) through this checkout's dibs in a temp `DIBS_HOME`, or with no dibs. Jobs are `bench/job.mjs`: real threads spinning through a fixed amount of work while holding real memory (40 to 350 MB), so a crowded machine stretches them. It measures makespan, job latency, CPU used, failures, and samples the real machine's load, swap and free memory every 2 seconds.

Run at `-p low` as it must be on this shared Mac, it lives on the 4 efficiency cores, so it measures a box of "4 slow cores and 2 GB": every scenario's numbers are scaled to that (cores x 0.4, memory / 8), and dibs is shown a fixed reading of that box (30% memory free, 1.5 cores busy) so other agents' work doesn't steer its decisions. It allocates at most about 1.5 GB at once and never grew swap.

Two reps per scenario, interleaved (each rep runs every scenario before the next starts) so drift on the machine hits them about equally. 20 jobs per run, 1 to 12 seconds of work each on this box. All on this branch's scheduler.

| settings (scaled) | makespan | vs no dibs | rep 1 / rep 2 | p50 job | p90 job | p90 wait | high p90 wait | CPU used | failed |
|---|---|---|---|---|---|---|---|---|---|
| no dibs | 61.6s | | 65.4s / 57.8s | 8.3s | 15.2s | 0.4s | 0.3s | 83% | 0 |
| stock defaults | 103.8s | +69% | 125.1s / 82.6s | 13.4s | 26.8s | 20.6s | 13.3s | 45% | 0 |
| owner's live settings | 80.5s | +31% | 88.3s / 72.6s | 9.7s | 15.4s | 8.0s | 4.4s | 52% | 0 |
| pace max | 89.7s | +46% | 122.4s / 57.0s | 8.3s | 33.8s | 6.7s | 6.4s | 44% | 0 |
| cores 1.5 per core, budget 75%, no ceiling | 62.9s | +2% | 68.8s / 56.9s | 9.0s | 12.2s | 3.3s | 2.2s | 72% | 0 |

What it says, and doesn't:

- **On CPU-only work that fits in memory, no dibs is the ceiling**, and the old settings cost 31 to 69% against it: their CPU budgets counted cores jobs asked for, not used, so CPU sat at 45 to 52% while jobs waited. With the CPU budget counting measured cores at 1.5 per core, dibs matched no dibs within 2% and cut the slowest jobs' time (12.2 against 15.2 seconds). This is the part of the simulator's result the real machine can check, and it agrees.
- **It can't show what dibs is for**: these jobs never come near running the box out of memory, because making them do that on this shared Mac would hurt everyone. That half rests on the simulator and on tonight's swap.
- **Noise is large.** pace max's first rep took 122 seconds while another agent's work pushed the Mac's load from 6 to 21; its second took 57, the same as the uncapped run. The swap the machine gained during the max and uncapped runs (0.9 to 1.9G in rep 2) arrived with that outside load; the benchmark itself held under 1.5G.
- **Very short jobs pay for dibs.** An earlier run with sub-second jobs (the calibration was off) had no dibs finishing 21 to 80% sooner: each dibs run costs a Node start and up to one 1.5-second poll before it goes. For a job under a few seconds, dibs is overhead; for the minute-long suites and builds it's meant for, it's noise.

The raw results are in `bench/results/2026-10-14-real.json`.

## Each proposal against main (0.0.74)

0.0.73 (oversized jobs) and 0.0.74 (the roomy rule reads cores in use) landed while this ran, and took most of the gain: the owner's settings on main finish six synthetic agents' work in 42.4 minutes, against 47.0 on 0.0.72. Each remaining change, applied alone to main's scheduler, 5 seeds:

| scheduler | settings | 6 agents | 8 agents | swap (6 / 8) | tonight's p90 job |
|---|---|---|---|---|---|
| main | owner's | 42.4m | 54.0m | 0.2G / 0.5G | 8.5m |
| main + CPU budget by measured cores | owner's | 41.0m | 52.7m | 0.0G / 0.4G | 8.5m |
| main + a stuck job's start walks lease ends | owner's | 42.4m | 54.0m | 0.2G / 0.7G | 8.5m |
| main | pace max as on main | 35.4m | 45.4m | 2.0G / 1.4G | 1.5m (8.5G swap, 3 jobs killed) |
| main + CPU budget by measured cores | pace max as on main | 34.7m | 44.9m | 1.9G / 1.6G | 1.5m |
| bench branch | pace max as proposed | 34.8m | 45.3m | 0.0G / 0.0G | 2.5m (4.6G swap, none killed) |

What that says:

- **The CPU budget by measured cores** is worth 1 to 3% in the simulator, where the roomy rule (now reading cores in use) already lifts the budgets much of the time. Where the budgets do apply, it's the difference that matters: the real benchmark, whose fixed reading (30% memory free) keeps the machine from ever looking roomy, went from +31 to +69% against no dibs to +2%. Worth shipping.
- **The stuck job's start walking lease ends** made no measurable difference. It's more correct (a job needing three leases to end can't start when the first does), but it has no evidence behind it here. Don't ship it on these numbers.
- **pace max never skipping the budgets** costs nothing (34.8 against 35.4 minutes) and removes all of max's swapping, including on tonight's work, where skipping them let the 14.1G build start beside others: 8.5G of swap and 3 jobs killed in the model. Its slowest jobs take 2.5 minutes instead of 1.5 for it. Worth shipping, with the 1.5 measured cores per core that goes with it.

## What changed

The first item shipped in 0.0.73. The others are on the `bench` branch with tests, chosen by the section above. The stuck-job change it weighs (a start walking lease ends) made no difference and was taken out.

- **An oversized job runs beside its own holds and file leases** (0.0.73). "A job bigger than the whole budget runs when nothing else is" no longer counts the waiter's own holds or leases that cost nothing (file leases). Before, it waited for its own simulator hold to expire and for every file lease on the machine. Test (main's): `a job bigger than the budget runs when only its own hold and file leases are out, not when real work is`.
- **The CPU budget counts measured cores.** A running job counts the cores it was last measured using (every 10 seconds), and what it asked for until then. Memory still counts what was handed out: too many busy cores slows everyone a little, too little memory kills jobs. The board says `CPU 2.3/10 cores in use`. Test: `the CPU budget counts what a running job was measured using, not what it asked for`.
- **History keys keep kinds of runs apart.** A command's history key was its program and first word, so `xcodebuild -project App.xcodeproj ... build` and `... archive` shared run times and sizes, and so did `npm run lint` and `npm run build`. It's now the program and up to three words that aren't flags, cut to their last path part, and for xcodebuild the first word, scheme, configuration and action. History under the old key still counts until a command has its own. Tests: `history keeps a build, a test and an archive of one project apart, and a temp folder does not split a command`, `history from before the key grew counts until the command has its own`.
- **A plan is capped at the budget.** A command that has used more than the whole memory budget is planned at the budget, so it starts once the budget is empty, and the board and `dibs run` say `usually uses ~14G; planned at the 11G budget`. Asking for more with `--mem` is still honored. Tests: `a command that has used more than the whole budget is planned at the budget, and the board says so`, `a planned size is capped at the budget only when what it learned is over the budget`.
- **`pace max`: 1.5 measured cores per core, and the budgets always apply.** It was every core as asked for, with the budgets skipped below 0.9 load per core and 25% memory free. Skipping them bought nothing in the simulator (34.9 against 34.8 minutes) and was the only part of max that swapped (1.1G). The `maxLoad` ceiling (1.5 per core of cores in use) still caps the machine.

## Recommendations

For the owner's Mac, now: `dibs pace max`, and take `cores` and `budget` out of `~/.dibs/config.json` (they're pinned at 10 and 11G, which override the pace). In the simulator that's 40.8 against 34.8 minutes for six agents. Keep the memory budget at 75% (12G).

Proposals, not done here:

- **Stock defaults** (no pace): `cores` 6 counted as measured is about right for a Mac someone works at. Changing a stock value is a migration, since every config.json dibs wrote holds the old stock numbers and `paced()` treats any non-stock value as pinned. Better: make `pace max` the suggestion for machines only agents use, in `dibs pace` and the README.
- **More slots** (test 4, heavy 2, playwright 3) bought 5% under max with no swap. Worth it once the overlap work lands, which subsumes it.
- **An overlap mode** (run side by side when measured use fits) would buy 7 to 13% more than max on synthetic work (31.2 against 34.8 minutes at six agents, 39.3 against 45.3 at eight) at 1 to 1.6G of swap.
- **Learned sizes: split the key, don't decay.** The 14.1G wasn't a one-off. The long runs of that command measured 6.6 to 7.2G through the evening, then 14.1, 13.1, 14.2 and 13.6G in four runs over 50 minutes, each 6 to 10 minutes long at 7 to 8 cores. The short runs of the same command took 13 to 50 seconds at 1 to 2.6G. They share a history key because the key is the program plus its first bare argument (`xcodebuild Shop.xcodeproj`), so a 20-second incremental build is planned like a 7-minute full build, and its typical run time is a median of both. The sampler counted only the build's own process groups (the shared simulator isn't a pool device, and indexing in Xcode.app isn't in the tree), and footprint counts compressed pages too, which is memory the build really demanded: the Mac swapped 6.7G while those builds ran. So capping or decaying "only raises" would mostly plan the next big build too small. Both fixes are now on the branch ("What changed"). Still open: the peak sample could note its three largest processes, so the next surprise can be checked.
- **`starveAfter`** 10 minutes was 5% faster than 3 under max with no swap, but high-priority p90 wait got worse at 8 agents (5.2 against 2.6 minutes). Leave it.
- **pace normal's ceiling** (one busy job per core) is what makes normal 38% slower than max for agents. That's its job when a person is at the Mac.
