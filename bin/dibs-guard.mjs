#!/usr/bin/env node
// The Claude Code hook behind `dibs guard`. It loads only the guard and its
// file leases (plus the subagent limit, for subagent events, and src/talk.mjs
// when the person has a message waiting), so a tool call pays for a few small
// modules instead of all of dibs.
import { hook } from '../src/guard.mjs';
hook();
