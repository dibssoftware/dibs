// What happened, one JSON line per event, for dibs history and the Mac app.
// Lease starts, ends, pauses and resumes are found by comparing the state
// before and after each change (logChanges, called by withState), so every
// way a lease ends is caught: exit, crash, release, a hold running out.
// Waits and timeouts come from acquire, load samples from the throttle
// watcher, owner overrides from whoever overrides. Appending never fails a
// run: an error is written once per process to dibs.log and dropped.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.mjs';
import { now } from './util.mjs';

export const EVENTS = path.join(HOME, 'events.jsonl');
export const OLDER = path.join(HOME, 'events.1.jsonl');
const LOG = path.join(HOME, 'dibs.log');
// Two files, each rotated out at half the limits, keep at most 30 days and 20 MB.
// A rename never loses an append racing it: the line lands in one file or the other.
export const KEEP_MS = 30 * 864e5;
export const KEEP_BYTES = 20 * 1024 ** 2;

let complained = false;
function complain(e) {
  if (complained) return;
  complained = true;
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} couldn't write ${EVENTS}: ${e.message}. History misses events from pid ${process.pid}.\n`); } catch {}
}

// Append one event: { kind, res, who, ... }. `at` is set when missing.
// Overrides go through here too: event({ kind: 'override', res, who, ... }).
export function event(e) {
  try { fs.appendFileSync(EVENTS, JSON.stringify({ at: now(), ...e }) + '\n'); } catch (err) { complain(err); }
}

// Move the current file aside once it's past half of either limit. Called
// under the state lock, so two processes never rotate at once.
export function rotate(t = now()) {
  try {
    const st = fs.statSync(EVENTS);
    if (st.size < KEEP_BYTES / 2 && t - firstAt() < KEEP_MS / 2) return;
    fs.renameSync(EVENTS, OLDER);
  } catch (e) { if (e.code !== 'ENOENT') complain(e); }
}

// When the current file's first event happened. Only its first bytes are read.
function firstAt() {
  const fd = fs.openSync(EVENTS, 'r');
  try {
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, 0);
    return Number(buf.toString().match(/^\{"at":(\d+)/)?.[1]) || now();
  } finally { fs.closeSync(fd); }
}

// Every event kept, oldest first. A line cut short by a crash is skipped.
export function readEvents(t = now()) {
  const out = [];
  for (const f of [OLDER, EVENTS]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch {}
    for (const l of text.split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (e.at >= t - KEEP_MS) out.push(e); } catch {}
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const fields = l => ({ id: l.id, res: l.res, who: l.who, prio: l.prio || 'normal', type: l.kind });

// before: the leases as read, before dead ones were reaped. paused: their
// pausedAt at that point (the lease objects themselves change in place).
export function logChanges(before, paused, s) {
  try {
    const t = now();
    const after = new Map(s.leases.map(l => [l.id, l]));
    const was = new Set(before.map(l => l.id));
    const out = [];
    for (const l of s.leases) {
      if (!was.has(l.id)) out.push({ at: t, kind: 'start', ...fields(l), ms: l.waited ?? 0, ...(l.held && { held: l.held }) });
      else if (!paused.get(l.id) && l.pausedAt) out.push({ at: t, kind: 'pause', ...fields(l) });
      else if (paused.get(l.id) && !l.pausedAt) out.push({ at: t, kind: 'resume', ...fields(l), ms: t - paused.get(l.id) });
    }
    for (const l of before) {
      if (after.has(l.id)) continue;
      const pausedMs = (l.pausedMs || 0) + (paused.get(l.id) ? t - paused.get(l.id) : 0);
      out.push({ at: t, kind: 'end', ...fields(l), code: l.code ?? null, ms: t - l.start, paused: pausedMs });
    }
    if (!out.length) return;
    rotate(t);
    for (const e of out) event(e);
  } catch (e) { complain(e); }
}
