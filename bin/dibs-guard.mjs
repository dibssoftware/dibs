#!/bin/sh
":" //; D=${DIBS_HOME:-$HOME/.dibs}; S=$D/guard.sock; if [ -S "$S" ] && command -v curl >/dev/null 2>&1; then in=$(cat); out=$({ printf '%s\000%s\000' "$PPID" "$PWD"; env -0; printf '\000%s\000' "$in"; } | curl -sf --max-time 2 --unix-socket "$S" --data-binary @- http://guard/ 2>/dev/null); case $out in ok*) r=${out#ok}; r=${r#?}; [ -n "$r" ] && printf '%s\n' "$r"; exit 0;; esac; printf '%s' "$in" | node "$0"; exit $?; fi; exec node "$0"
// Line 2 is read by sh and ignored by Node (a string, then a comment). As a
// script it is the hook's fast way in: when the resident guard is running
// (dibs service install guard, src/guardd.mjs), sh sends the call down its
// socket, with this hook's parent pid, folder and environment, and prints the
// answer. With no guard running, no curl, or no "ok" back within 2 s, it runs
// the hook in Node below, as it always did. Run as `node dibs-guard.mjs` (the
// plugin, Windows) it is the Node hook straight away.
//
// The Claude Code hook behind `dibs guard`. It loads only the guard and its
// file leases (plus the subagent limit, for subagent events, and src/talk.mjs
// when the person has a message waiting), so a tool call pays for a few small
// modules instead of all of dibs.
import { hook } from '../src/guard.mjs';
hook();
