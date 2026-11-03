# Simulators

`sim` is the one shared booted simulator, the one other sessions screenshot. `sim-own` gives your command a simulator nobody else touches:

```bash
dibs run sim-own -- sh -c 'xcrun simctl install "$SIM" App.app && xcrun simctl launch "$SIM" com.example.app'
dibs run sim-own,xcode-build -- sh -c 'xcodebuild test -scheme App -destination "id=$SIM"'   # single quotes: $SIM is set inside the run, not in your shell
dibs hold sim-own --for 20m        # keep one booted across tool calls; it prints the udid
dibs sims                          # the pool: devices, who has them, disk they use
dibs sims prune                    # delete the idle ones
```

- **What you get.** `$SIM` is the device's udid and `$SIM_NAME` its name (`dibs-pool-1`). It's booted when your command starts and shut down when it exits. A new device is an iPhone 17 on the newest installed iOS runtime; set `pool.deviceType` and `pool.runtime` on `sim-own` in the config to pick others (names like `iPhone 16` and `iOS 18.6` work).
- **Reuse.** Devices stay between leases, because creating one and its first boot are slow and each costs 1 to 5 GB of disk. You get the device you used last if it's free, so your installed app is still there. A device last used by another agent is erased first (`pool.erase`: `other-agent`, `always` or `never`).
- **How many at once.** A new one boots only if free memory covers another simulator (`pool.perSim`, 2G) and still leaves `minFreeMem` free. Devices still booting count as taken. `slots` caps it on top of that. A `sim-own` lease counts the simulator plus its job against the memory budget, and `--mem` names the job's own need, so `--mem 2G` hands out 4G.
- **Crashes.** If the command or dibs dies, even with `kill -9`, the next dibs call anywhere shuts the device down and puts it back in the pool.
- **What dibs deletes.** Only devices it named `dibs-pool-*`, and only on `dibs sims prune`. It never shuts down, erases or deletes any other simulator. It adopts or prunes only the pool devices this `DIBS_HOME` created (listed in `~/.dibs/pool-made`); another dibs's `dibs-pool-*` devices show as "not made by this dibs" and are left alone.
