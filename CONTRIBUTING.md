# Contributing to dibs

Bug reports and pull requests are welcome at https://github.com/dibssoftware/dibs.

## Before your first pull request is merged

You sign a contributor license agreement with Creayo LLC. dibs is AGPL-3.0-only, and Creayo LLC also sells a commercial license to companies that can't use AGPL software. The agreement lets your change ship under both. You keep the copyright in your work.

Open your pull request first. A maintainer replies with the agreement to sign, or email licensing@dibs.cc and ask for it. Nothing is merged before it's signed.

## How to change dibs

[AGENTS.md](AGENTS.md) has the rules every change follows, for people and coding agents alike. The short version:

- No dependencies. Node built-ins only. `package.json` exists only so `npm i -g @dibssoftware/dibs` works: it has no dependencies and no scripts, and it stays that way.
- Exit codes and `~/.dibs/state.json` are an API. Agents on the old version and the new one share the state file.
- Every bug fix comes with a test that failed before the fix.
- No emojis, no em dashes, no curly quotes, in code, output or docs.

Run the suite before you open the pull request:

```bash
node --test --test-timeout=120000 test/*.test.mjs
```

If other agents share your machine, run it through dibs: `dibs run test -m "why" -- node --test --test-timeout=120000 test/*.test.mjs`. It takes a minute or two. CI runs it on macOS and Linux for every pull request.

## Reporting a security problem

Email hello@dibs.cc instead of opening an issue.
