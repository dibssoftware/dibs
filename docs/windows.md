# dibs on Windows

dibs works on Windows, with gaps. The full test suite runs on windows-latest in CI on every change; the tests that can't run there say why (`posixOnly` and `windowsGap` in test/helpers.mjs).

Install from PowerShell with `install.ps1`, or use WSL, where dibs is the Linux one and `install.sh` works as on any Linux machine (with a Linux Node inside WSL). Claude Code on Windows runs its commands in Git Bash, so `install.ps1` puts a `dibs` for Git Bash beside `dibs.cmd`.

## What's missing

- **No pausing.** Windows has no SIGSTOP. dibs never pauses a job there: urgent work waits its turn instead, memory and disk pressure hold new work back but don't freeze running jobs, and `dibs pause` says so and suggests `dibs stop`.
- **Memory is the working set.** dibs measures a job's process tree by its working set and CPU, a few seconds apart, the same way it learns sizes elsewhere.
- **No process groups.** dibs ends a job's whole process tree, but a process whose parent already exited can escape it, unless dibs saw it on one of its checks every 3 seconds.
- **No signals.** Windows can't deliver SIGTERM or SIGINT to a job: stopping one ends it outright, with no chance to clean up.
- **Slower.** Each look at the process table is a PowerShell call, so a dozen dibs at once on a 4-core machine take seconds each to get through the state file's lock.
- **Not tested on Windows:** on-demand VMs (boat) sent from a Windows machine.
