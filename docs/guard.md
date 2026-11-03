# The guard

Agents forget. You can tell every agent to wrap builds in `dibs run`, and an hour later one of them types a bare `xcodebuild`. The guard is a pre-tool hook that catches those commands before they run.

## What it does

Before each Bash call it reads the command, without running it, and looks for anything heavy outside `dibs run`: `xcodebuild` builds and tests, `xcrun simctl` (except `list` and other reads: `ui` without a value, `status_bar list`, `getenv`, `listapps`, `appinfo`, `get_app_container` and the like, and managing devices that aren't running: `create`, `delete`, `erase` and `runtime`), `swift test`, Playwright, vitest, jest, `npm test` and friends, `node --test`, `wrangler deploy`, `vercel deploy`, `ship*.sh`/`deploy*.sh` and `npm run deploy`. Then:

- **In a `bypassPermissions` session it rewrites the command.** `cd ios && xcodebuild build` runs as `cd ios && dibs run xcode-build -m 'guard: xcodebuild build' -- xcodebuild build`. The session already runs everything without asking, so approving the new command grants nothing it didn't have.
- **Anywhere else it blocks the command** and tells the agent the exact `dibs run` line to use. The agent's retry goes through your normal permission checks. The hook never approves anything on your behalf.

It leaves alone `dibs` calls themselves, and commands after a `dibs hold` on the same line that the hold covers, but a heavy command elsewhere on a line with a `dibs` call still needs its turn (`xcodebuild build && dibs say done` is caught). It also leaves alone reads like `xcodebuild -list` or `-showBuildSettings`, words inside quotes, heredocs, `$(...)` and `bash -c` strings, and anything it can't parse. Any error inside the hook lets the command through unchanged and leaves one line in `~/.dibs/guard.log`. `DIBS_GUARD=off cmd` (or `env DIBS_GUARD=off cmd`) skips it for that command only, and `export DIBS_GUARD=off;` for the rest of the line; the words inside a quoted message don't count. It takes no lock and answers in about 50 ms, most of it Node starting.

```bash
dibs guard check "cd app && npm test"   # what it would do with a command, without a session
```

## Leased files

The hook also runs before Edit, Write, MultiEdit and NotebookEdit, and before Bash commands that obviously write a file. A write to a path another agent holds a `files:` lease on is denied, with who holds it, why and until when. See [files.md](files.md).

## New sessions, messages and notices

On SessionStart, and the first SubagentStart of each subagent, the hook hands the agent a few lines on how to use dibs: wrap heavy work in `dibs run`, don't rerun a call that moved to the background, keep waiting on memory and disk, what each exit code says, quote file globs, that an agent may do anything the person can (and is logged doing it), and that a stopped job was stopped on purpose. Most agents never read the docs; this way they start with the rules.

Messages from the person (`dibs tell`) and dibs's own notices about an agent's jobs (stuck, over its memory, paused) reach the agent beside its next tool call. See [questions.md](questions.md).

## The subagent limit

Fan-outs that start together hit the account's usage limit together and die mid-edit. So the hook also counts subagents running at once across every Claude Code session on the machine, through the Agent tool (Task in older Claude Code) and the SubagentStart and SubagentStop events. It's off unless you set a limit. Past `agents.slots`, a spawn is denied with who is running how many. A denied spawn started nothing and isn't a failure: wait for one of your own subagents to report back, then spawn again. A session with none running can always start one, so a big fan-out elsewhere can't starve it. The board shows `subagents: 5 of 8 running (web-app x3, api x2)`.

Turn it on in `~/.dibs/config.json` with `"agents": { "slots": 8 }`. `"agents": false`, the default, means no limit.

It keeps its own small file and lock (`~/.dibs/agents.json`), never the queue's, and gives up and allows the spawn after a second if the lock is busy. A subagent whose transcript hasn't changed in a long while, or whose session exited, stops counting.

## Installing it

Pick one of these. Installing both runs the hook twice.

**Claude Code plugin.** In a session:

```
/plugin marketplace add dibssoftware/dibs
/plugin install dibs@dibs
```

or from a shell:

```bash
claude plugin marketplace add dibssoftware/dibs
claude plugin install dibs@dibs
```

The plugin brings the hook and a short `dibs` skill that tells agents how to queue, what exit 75 means, and how to trade places. It also puts its `bin/` folder on the Bash tool's PATH, so `dibs.mjs` works in sessions even before you install the CLI. `claude plugin disable dibs@dibs` turns it off. `dibs guard status` only looks at settings.json, so it reports a plugin install as "not installed".

**settings.json.** `dibs guard install` adds the hook to `~/.claude/settings.json` (PreToolUse for Bash and the edit tools, PreToolUse for Agent and Task, SubagentStart, SubagentStop, Stop and SessionStart), keeping everything else and the old file in `settings.json.dibs-backup`. Run it again after an upgrade: an older install that hooked fewer events is replaced, not added to, and `dibs guard status` says when yours is older. Install and remove are the person's: run them from Terminal. From inside Claude Code, your own `!` commands included, they're refused and nothing changes.

```bash
dibs guard install
dibs guard status                       # installed? exit 1 if not
dibs guard remove
```

**Codex.** Codex reads the same marketplace and plugin files:

```bash
codex plugin marketplace add dibssoftware/dibs
codex plugin add dibs@dibs
```

Codex sends the same hook input as Claude Code (`tool_name` is `Bash`, and `permission_mode` is set), so the guard rewrites in bypass mode and blocks everywhere else, as above. Codex doesn't trust a plugin's hooks until you review them: open `/hooks` in a Codex session and trust the dibs hook, and again after each update that changes it. The skill loads without that step. If Codex runs in a sandbox that can't write `~/.dibs`, `dibs run` fails there; give the sandbox that folder or run dibs outside it.

Other agents (Gemini CLI, Cursor, Factory, Copilot CLI) have pre-tool hooks in similar formats, but dibs doesn't ship adapters for them yet. `dibs run` itself works under any agent or a plain terminal.

## Your own rules

Add rules or switch built-ins off in `~/.dibs/config.json`. A rule matches the command's first words (the first by basename, `*` as a wildcard) once `env`, `time`, `npx`, `xcrun` and the like are peeled off. `"rewrite"` is `"bypass"` (default), `"always"` or `"never"`:

```json
"guard": {
  "rewrite": "bypass",
  "rules": {
    "pytest": { "match": ["pytest", "python -m pytest"], "res": "test", "unless": ["--collect-only"] },
    "vercel": false
  }
}
```

The built-in rule names are `xcodebuild`, `simctl`, `swift-test`, `playwright`, `vitest`, `jest`, `npm-test`, `node-test`, `wrangler`, `vercel` and `deploy-script`.

`"guard": false` switches off the rewriting and blocking of heavy commands, but edits to files another agent leased are still turned away. `"guard": { "files": false }` stops only those, and `"guard": { "commands": false, "files": false }` turns both off.
