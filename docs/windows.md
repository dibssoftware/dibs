# dibs on Windows

dibs works on Windows, with gaps. The full test suite runs on windows-latest in CI on every change; the tests that can't run there say why (`posixOnly` and `windowsGap` in test/helpers.mjs).

Install from PowerShell with `install.ps1`, or use WSL, where dibs is the Linux one and `install.sh` works as on any Linux machine (with a Linux Node inside WSL). Claude Code on Windows runs its commands in Git Bash, so `install.ps1` puts a `dibs` for Git Bash beside `dibs.cmd`.

## What's missing

- **No pausing.** Windows has no SIGSTOP. dibs never pauses a job there: urgent work waits its turn instead, memory and disk pressure hold new work back but don't freeze running jobs, and `dibs pause` says so and suggests `dibs stop`.
- **No measuring.** dibs doesn't read what jobs use on Windows yet, so there's no "this job used more than it asked for", and sizes aren't learned from past runs. `--mem` and `--cpu` count as given.
- **No process groups.** dibs ends a job's whole process tree, but a process whose parent already exited can escape it, unless dibs saw it on one of its checks every 3 seconds.
- **No signals.** Windows can't deliver SIGTERM or SIGINT to a job: stopping one ends it outright, with no chance to clean up.
- **Slower, and heavy contention.** Each look at the process table is a PowerShell call. Many dibs at once (a dozen on a 4-core machine) can keep one off the state file's lock past its 45-second limit, and that one exits 75.
- **Not tested on Windows:** on-demand VMs (boat) sent from a Windows machine, and Claude Code's temp folders in low-disk notices.
