# Questions for the person

With five or ten agents running, the person who runs them is the scarcest thing on the machine. Each agent that stops to ask "ship it?" or "which name?" interrupts them, and an agent that stops dead waits until they notice. dibs queues those questions like any other resource: the agent asks, keeps working on whatever doesn't depend on the answer, and the person answers when they get to it, in order.

```bash
dibs question "Ship build 123 to TestFlight now?" --options yes,no --recommend yes -m "tests pass, notes written" \
  --one-way "testers get it at once; it can't be pulled back" --wait   # blocks; prints only the answer
dibs question "Use port 5173 for the dev server?" --options yes,no --recommend yes -m "nothing else listens there"
                                   # a two-way door: prints "yes" at once, logged, shown to the person as done
dibs questions                     # open first, by priority then age (--json for scripts and the Mac app)
dibs answer 4 yes                  # the person answers with an option...
dibs answer 4 "wait until Monday"  # ...or in their own words
dibs questions dismiss 5           # or waves it off
```

The board's first line says `3 questions for you: dibs questions` while any are open, and `dibs --json` has a `questions` count. `dibs questions --json` has an `open` count for a badge.

## For agents: one-way doors only

The person's standing rule: walk through two-way doors (anything you can undo) and show them after. Bring them one-way doors (anything that can't be undone) and taste calls only, one at a time, with your recommendation. dibs holds you to it:

- Every question needs `--recommend <option>` and `-m "why"`. With `--options`, the recommendation must be one of them.
- **Without `--one-way`**, nobody is asked. dibs prints your recommendation on stdout at once (exit 0, `--wait` or not), logs `decided by <you>: two-way door` in `dibs history`, and shows it in the person's threads as done. They message you if they want it otherwise.
- **With `--one-way "what can't be undone"`**, it's queued for the person, who sees the question, your recommendation and why, and what can't be undone.
- dibs refuses (exit 2, nothing recorded) a question that isn't a short sentence of at least three words (a bare "2"), one without a recommendation or a reason, and options that repeat.

1. Ask without `--wait`. It prints the id and returns. Carry on with the work that doesn't need the answer.
2. When you reach the step that does, run the same command again with `--wait`. It prints the answer on stdout, and only the answer, so `answer=$(dibs question ... --wait)` works.
3. Exit 75 means no answer: the person dismissed it, or your wait's `--timeout` (a duration: `30s`, `1m`, `2h`) passed. Nothing was decided. Don't take silence as a yes; carry on without that step and say so in your report. A question you asked in step 1 stays open for the person after a wait gives up: run the same command with `--wait` again later to collect it. One asked only with `--wait` stays open 2 minutes after its wait gives up, so the same command picks it back up.

- The person may answer in their own words instead of an option. Those words are the answer (on stdout with `--wait`), and they also reach you through the hook as `Message from the person: (answering your question #N) ...`.
- `-p urgent|high|normal|low|idle` places it like a job in line: urgent goes 2 hours ahead, high 1 hour, low 10 minutes back. Use urgent only when something is broken or the person is waiting on you right now.
- Asking the same text again from the same session is the same question, not a new one (a two-way one gives the same decision), until it's answered and read, dismissed or expired. After that the same text is a new question with a new id.
- Inside a Claude Code tool call, `--wait` has no time limit, as with `dibs run`: if the call reaches its timeout, Claude Code moves it to the background and tells you when the answer comes.
- A question belongs to whoever asked. Asked with `--wait` only, that's the waiting dibs: if it's killed, the question expires. Asked without it, it's your agent session: its questions expire when the session ends, or at the `--timeout` you gave when you asked, never at a later wait's.

An agent may answer another agent's question with `dibs answer <id> <text>` when it knows the answer: the asker sees `answered by <agent>, an agent, not the person` on stderr, beside the bare answer on stdout, and the history names who answered.

## The person's threads, and the desk

`dibs threads` holds what's for the person: one-way questions, and agents' `dibs say` notes, marked FYI. dibs's own notices to an agent about its jobs (bookings, stuck-job advice, "pass --mem 7G") go only to that agent through the hook, never into the person's threads. Neither do the notes dibs writes in an agent's name (how a `dibs later` run ended), or one agent's `dibs tell` to another.

`dibs threads --json` keeps those apart for the page and the Mac app: `between` lists what agents told each other (`from`, `to`, delivery state), and `fromDibs` lists dibs's notices and notes to agents. Each thread's `reach` says how a message sent now would get to its agent: `listening` (within seconds), `working` (its next tool call), `idle` (not until it works again), `ended`, or `command` (not a Claude Code session). A message the person sent carries `deliveredAt` and `via` (`tool`, `stop`, `listen`, `say`, `command`) once it's handed over.

Set `"desk": "<agent name>"` in `~/.dibs/config.json` to give the person one agent to talk to. `dibs tell desk "..."` (and the Mac app's chat) reaches that agent through the hook, and it answers with `dibs say --to person "..."`. `dibs threads --json` names it (`desk`), marks its thread `desk: true`, and its answers `reply: true`.

## For the person: hours

```bash
dibs hours 09:00-23:00     # dibs hours off clears them; dibs hours [--json] shows them
```

(or `"hours": { "start": "09:00", "end": "23:00" }` in `~/.dibs/config.json`) keeps questions below urgent out of your way at night. They stay in the list, marked "for tomorrow", and the board doesn't count them until `start`. An end before the start runs past midnight. Agents asking off hours are told their question waits for the morning unless it's urgent.

`dibs answer`, `dibs questions dismiss` and `dibs hours` work for the person and for agents alike; `dibs history` names who did each.

Closed questions stay in `dibs questions --json` for 7 days (at most 200), in `~/.dibs/questions.json`.

## Threads: notes and messages both ways

Questions are one half of a conversation. Each agent also has a thread, keyed by its session (and, for a subagent, its agent id), that holds its questions and your answers, the notes it leaves you, and the messages you send it.

```bash
dibs say "migration done, tests pass"        # an agent: a note to the person, no answer expected (--as <label> for a subagent)
dibs threads                                 # the person: every thread, newest first, with unread counts
dibs threads read web-app                    # the conversation; marks its notes and questions read
dibs tell web-app "use the staging database" # the person: a message for that agent
dibs tell web-app/Explore "check the tests"  # a subagent's thread is <session name>/<label>
```

How a message reaches the agent, with `dibs guard install` (or the plugin):

- On the agent's next Bash, edit or Agent tool call, the hook adds it next to the call as `additionalContext` ("Message from the person: ..."). The call itself goes through unchanged, through the normal permission checks. If the guard turns that call away (a heavy command outside dibs, a file another agent leased), the message waits for the next one.
- If the agent is ending its turn instead, the Stop hook (SubagentStop for a subagent) answers with the message as `additionalContext`, so it keeps going and reads it as hook feedback (a `decision: "block"` would read as a hook error). Each message is handed over once, and a stop that's already a stop hook's continuation (`stop_hook_active`) never gets another, so this can't loop.
- An agent that's idle, waiting for its person to type, gets it on its next tool call. A session that has ended keeps the message queued, shown as not delivered, in case it's resumed.
- Without the guard, the agent gets queued messages the next time it runs `dibs say`.

dibs leaves notices of its own in an agent's thread, as lines from dibs: a job of the agent's that has used no CPU for 20 minutes while others wait for it, one that used far more memory than it asked for (with the `--mem` to pass next time), and one paused for low disk or memory (it resumes by itself). Each is said once and handed over the same way as your messages, beside the next tool call, with "dibs has a notice about your jobs". A notice never keeps an agent from stopping, and one nobody picked up expires after an hour. Outside Claude Code, notices arrive on stderr with the agent's next dibs command.

Plain `dibs` counts unread notes with the questions: `2 questions and 1 note are waiting for you: dibs threads` (`dibs --detail`: `2 questions and 1 note for you: dibs threads`), and `dibs --json` has a `notes` count. Agents may run `dibs tell` and `dibs threads read` too, as they may `dibs answer`: a message from an agent reaches its reader marked as another agent's, never the person's. Threads keep 7 days and at most 200 lines each, in `~/.dibs/messages.json`.
