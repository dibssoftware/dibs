// dibs _reads: the Mac app's reader. The app polls the board, the questions and
// the threads every few seconds; as a new `dibs ... --json` each, under load
// most of every read was node starting up (seconds, against milliseconds for
// the read). Here one process stays up for the app's lifetime and answers each
// read in turn: one JSON request per line on stdin, {"id", "args"}, and one
// JSON answer per line on stdout, {"id", "code", "out", "err"}, where out is
// exactly what `dibs <args>` would have printed and code its exit code.
// bin/dibs.mjs readOne() decides which verbs it answers: only the read-only ones.
//
// It ends when the app closes its stdin, or after an answer once dibs on disk
// is a new version, so the next read starts the new code.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inProcessAsync } from './util.mjs';

const VERSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'version.mjs');
const stamp = () => { try { return fs.statSync(VERSION_FILE).mtimeMs; } catch { return 0; } };

export async function reads(readOne) {
  const started = stamp();
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(req?.args) || !req.args.every(a => typeof a === 'string')) {
      write(`${JSON.stringify({ id: req?.id ?? null, code: 2, out: '', err: 'args is a list of strings' })}\n`);
      continue;
    }
    // What the read prints is its answer. One read at a time, so nothing else writes meanwhile.
    const out = [];
    console.log = (...a) => { out.push(`${util.format(...a)}\n`); };
    process.stdout.write = chunk => { out.push(String(chunk)); return true; };
    process.exitCode = 0;
    let code = 0, err = '';
    try {
      await inProcessAsync(() => readOne(req.args));
      code = Number(process.exitCode) || 0;
    } catch (e) {
      code = e.exitCode ?? 70;
      err = e.exitCode != null ? e.message : `dibs itself crashed (a bug in dibs; exit 70). Report it: dibs ask "..."\n${e.stack || e.message}`;
    } finally {
      console.log = log;
      process.stdout.write = write;
      process.exitCode = 0;
    }
    write(`${JSON.stringify({ id: req.id ?? null, code, out: out.join(''), err })}\n`);
    if (stamp() !== started) process.exit(0);
  }
}
