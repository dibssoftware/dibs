// dibs guard: a Claude Code PreToolUse hook that catches heavy Bash commands
// run outside dibs, and either wraps them in `dibs run` or sends the agent back
// with the exact command to use. It reads the shell command, never runs it, and
// takes no lock. Anything it can't read, or any error, lets the command through
// unchanged: blocking legit work is worse than missing a build. It also turns
// away edits to paths another session holds a file lease on (src/files.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpGuard, fileGuard, resList } from './files.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_BIN = path.join(ROOT, 'bin', 'dibs-guard.mjs');
// Claude Code runs hooks and Bash commands through Git Bash on Windows, where a
// .mjs doesn't run by name: there node runs it, from a path written with /.
const WIN = process.platform === 'win32';
const viaNode = file => (WIN ? `node ${quote(file.replace(/\\/g, '/'))}` : quote(file));
// The same folder as config.mjs's HOME, worked out here because the hook loads no other module.
const DIBS_HOME = process.env.DIBS_HOME || path.join(os.homedir(), '.dibs');
const CONFIG = path.join(DIBS_HOME, 'config.json');
const STATE = path.join(DIBS_HOME, 'state.json');
const LOG = path.join(DIBS_HOME, 'guard.log');
// Who has a message from the person waiting: { session_id: [agent ids] }, or
// no file at all. src/talk.mjs keeps it; the hook only reads it.
const INBOX = path.join(DIBS_HOME, 'inbox.json');
// dibs listen's list of who listens (src/talk.mjs), and the listeners already reminded about.
const LISTENERS = path.join(DIBS_HOME, 'listeners.json');
const REMINDED = path.join(DIBS_HOME, 'listen-reminded.json');
// Sessions remembered in REMINDED: enough for every session a machine runs in a day or two.
const REMIND_KEEP = 200;
// The threads themselves, which the hook only searches for a subagent's id.
const MESSAGES = path.join(DIBS_HOME, 'messages.json');
const SETTINGS = process.env.DIBS_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');

// What counts as heavy: the command's first words, once env, npx, time, cd and
// friends are peeled off, and the resource it needs. A word may use * and the
// first is matched by its basename; $ means "and nothing after". Any argument in
// `unless` makes it a quick read, as does `reads` returning true for the
// arguments; `with` needs one of its arguments present.
// Add or switch these off in ~/.dibs/config.json under guard.rules.
// A command aimed at a pool simulator ($SIM, a dibs-pool-N name, or the udid of
// one) belongs to sim-own. Queueing it for the shared sim would wait on a
// device it never touches.
const POOL_REF = /\$\{?SIM(_NAME)?\b|\bdibs-pool-\d+/;
let udids = null;
function poolUdids() {
  try { udids ??= (JSON.parse(fs.readFileSync(STATE, 'utf8')).pool || []).map(d => d.udid).filter(Boolean); } catch { udids = []; }
  return udids;
}
const ownSim = argv => argv.some(a => POOL_REF.test(a) || poolUdids().some(u => a.includes(u)));
const sim = argv => (ownSim(argv) ? 'sim-own' : 'sim');
// simctl subcommands that need no simulator turn: reads, and managing devices
// that aren't running (create, delete, erase, which refuses a booted one, and
// runtimes). Queueing those behind the shared sim and its disk floor would stop
// an agent deleting simulators to free disk until disk is free. Some read or
// write by their arguments: `ui <device> appearance` reads, with a value it sets.
const SIMCTL_READS = new Set(['list', 'help', '--help', '-h', '--version', 'getenv', 'get_app_container', 'listapps', 'appinfo', 'pbpaste',
  'create', 'delete', 'erase', 'runtime']);
function simctlRead(rest) {
  const i = rest[0] === '--set' ? 2 : 0;   // --set <path> picks a device set and comes first
  const [sub, a, b, c] = rest.slice(i);
  if (SIMCTL_READS.has(sub)) return true;
  if (sub === 'ui') return c == null;
  if (sub === 'status_bar') return b === 'list';
  if (sub === 'io') return b === 'enumerate';
  if (sub === 'bootstatus') return !rest.includes('-b');   // -b boots it first
  return false;
}
// A simulator named by its udid alone (-destination id=<udid>) is a simulator
// too. Real devices' ids aren't shaped 8-4-4-4-12.
const SIM_ID = /(^|,)id=[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}\b/i;
const simTest = argv => argv.some(a => a === 'test' || a === 'test-without-building') && (ownSim(argv) || argv.some(a => /Simulator/.test(a) || SIM_ID.test(a)));
const RULES = {
  xcodebuild: { match: 'xcodebuild', res: argv => (simTest(argv) ? `${sim(argv)},xcode-build` : 'xcode-build'),
    unless: ['-version', '-showsdks', '-list', '-showBuildSettings', '-showdestinations', '-showTestPlans', '-help', '-usage',
      '-license', '-checkFirstLaunchStatus', '-runFirstLaunch', '-find-executable', '-find-library', '-showComponent'] },
  simctl: { match: 'simctl', res: sim, reads: simctlRead },
  'swift-test': { match: 'swift test', res: 'test', unless: ['--help', '-h', '--list-tests'] },
  playwright: { match: ['playwright test', 'pnpm playwright test', 'yarn playwright test'], res: 'playwright', unless: ['--help', '-h', '--list'] },
  vitest: { match: ['vitest', 'pnpm vitest', 'yarn vitest'], res: 'test', unless: ['--version', '-v', '--help', '-h', 'list', 'init'] },
  jest: { match: ['jest', 'pnpm jest', 'yarn jest'], res: 'test', unless: ['--version', '-v', '--help', '-h', '--listTests', '--showConfig'] },
  'npm-test': { match: ['npm test', 'npm t', 'npm run test*', 'npm run-script test*', 'pnpm test', 'pnpm t', 'pnpm run test*',
    'yarn test', 'yarn run test*', 'bun test', 'bun run test*'], res: 'test' },
  'node-test': { match: 'node', with: ['--test'], res: 'test' },
  // A type check of a big app takes 1.5 GB: on 2026-10-22 six at once, outside
  // dibs, put 9 GB into swap and took free disk to 1.4 GB. Not --watch, which
  // never ends, and not the quick ones.
  tsc: { match: ['tsc', 'vue-tsc', 'npm run typecheck*', 'npm run type-check*', 'pnpm typecheck*', 'pnpm run typecheck*', 'pnpm type-check*',
    'yarn typecheck*', 'yarn run typecheck*', 'bun run typecheck*'], res: 'test',
    unless: ['--version', '-v', '--help', '-h', '--init', '--showConfig', '--watch', '-w', '--listFiles', '--listFilesOnly', '--all'] },
  wrangler: { match: ['wrangler deploy', 'wrangler publish', 'wrangler pages deploy', 'wrangler versions deploy'], res: 'deploy', unless: ['--help', '-h', '--dry-run'] },
  vercel: { match: ['vercel deploy', 'vercel --prod', 'vercel --yes', 'vercel -y', 'vercel $'], res: 'deploy', unless: ['--version', '-v', '--help', '-h'] },
  'deploy-script': { match: ['ship*.sh', 'deploy*.sh', 'npm run deploy*', 'pnpm run deploy*', 'yarn deploy', 'yarn run deploy*', 'bun run deploy*'], res: 'deploy' },
};

// Words that come before the command and stay before dibs.
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'time', 'command', 'exec']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// DIBS_GUARD=off in front of a command, as a real assignment: in a quoted
// message or a file name it's only words.
const OFF = /^DIBS_GUARD=(0|off|false|no)$/;

// Commands that run another command: dibs goes in front of them, and the
// command they run is what gets matched. Each returns the index of that
// command, or null when the word isn't acting as a wrapper here.
const flags = (words, j, takesValue = []) => {
  while (words[j]?.startsWith('-')) j += takesValue.includes(words[j]) ? 2 : 1;
  return j;
};
const runner = (words, i) => { const j = flags(words, i + 1, ['-p', '--package']); return words[j] === '--' ? j + 1 : j; };
const PREFIX = {
  env: (w, i) => { let j = flags(w, i + 1, ['-u', '--unset', '-C', '--chdir']); while (ASSIGN.test(w[j] || '')) j++; return j; },
  nice: (w, i) => flags(w, i + 1, ['-n']),
  caffeinate: (w, i) => flags(w, i + 1, ['-t', '-w']),
  timeout: (w, i) => flags(w, i + 1, ['-s', '-k', '--signal', '--kill-after']) + 1,
  gtimeout: (w, i) => PREFIX.timeout(w, i),
  nohup: (w, i) => i + 1,
  time: (w, i) => flags(w, i + 1, ['-o']),   // /usr/bin/time; the shell's own time is a keyword
  sudo: (w, i) => flags(w, i + 1, ['-u', '-g', '-C', '-D', '-h', '-p', '-U', '-r', '-t', '-T']),
  xcrun: (w, i) => {
    let j = i + 1;
    while (['-sdk', '--sdk', '-toolchain', '--toolchain'].includes(w[j])) j += 2;   // not --find: xcrun --find xcodebuild is a lookup
    return ['xcodebuild', 'simctl'].includes(w[j]) ? j : null;
  },
  npx: runner,
  bunx: runner,
  bun: (w, i) => (w[i + 1] === 'x' ? runner(w, i + 1) : null),
  npm: (w, i) => (w[i + 1] === 'exec' ? runner(w, i + 1) : null),
  pnpm: (w, i) => (['exec', 'dlx'].includes(w[i + 1]) ? runner(w, i + 1) : null),
  yarn: (w, i) => (['exec', 'dlx'].includes(w[i + 1]) ? runner(w, i + 1) : null),
  // bash -x deploy.sh runs the script; -c and -s run text we can't see as a command.
  bash: (w, i) => {
    const j = flags(w, i + 1, ['-o', '+o', '-O', '+O']);
    return w[j] && !w.slice(i + 1, j).some(f => /^-[a-zA-Z]*[cs]/.test(f)) ? j : null;
  },
  sh: (w, i) => PREFIX.bash(w, i),
  zsh: (w, i) => PREFIX.bash(w, i),
};
// Package managers' own flags before the script name (npm --prefix web test).
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_VALUE = ['--prefix', '-C', '--cwd', '--dir', '--filter', '-F', '-w', '--workspace'];

const base = s => s.slice(s.lastIndexOf('/') + 1);

// The shell command split into simple commands, each a list of words with
// where they start. Quotes are removed; $(...), backticks and $VARS mark a word
// opaque; redirect targets are marked; heredoc bodies are skipped. Each list
// also says how many ( ) subshells it's in (depth), so a cd inside one ends
// with it, and whether its input is piped from the one before (pipe). Null when
// it can't be read (an open quote, an unterminated heredoc).
export function split(src) {
  const segs = [], docs = [];
  let seg = [], w = null, redir = false, depth = 0, pipe = false;
  const word = i => (w ||= { text: '', start: i, quoted: false, opaque: false });
  const end = () => {
    if (!w) return;
    // A group's brace ends the simple command before it. The word is dropped
    // before cutting: cut() ends the current word first, and ending this one
    // again called cut() again, without end (every { ...; } overflowed the stack
    // until 0.0.178, and the hook let those commands through unguarded).
    if (!w.quoted && (w.text === '{' || w.text === '}')) { w = null; cut(); return; }
    w.redir = redir; redir = false;
    seg.push(w); w = null;
  };
  const cut = () => { w && end(); if (seg.length) { segs.push(Object.assign(seg, { depth, pipe })); pipe = false; } seg = []; w = null; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (c === ' ' || c === '\t') end();
    else if (c === '\n') {
      cut();
      if (docs.length) { i = bodies(src, i + 1, docs) - 1; if (i < 0) return null; docs.length = 0; }
    }
    else if (c === '#' && !w) { while (i + 1 < src.length && src[i + 1] !== '\n') i++; }
    else if (c === '\\') { if (d !== '\n') { word(i).text += d ?? ''; w.quoted = true; } i++; }
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return null;
      word(i).text += src.slice(i + 1, j); w.quoted = true; i = j;
    }
    else if (c === '"') {
      word(i).quoted = true;
      let j = i + 1;
      for (; src[j] !== '"'; j++) {
        if (j >= src.length) return null;
        if (src[j] === '\\') w.text += src[++j];
        else if (src[j] === '`' || (src[j] === '$' && src[j + 1] === '(')) {
          const k = src[j] === '`' ? src.indexOf('`', j + 1) : close(src, j + 1);
          if (k < 0) return null;
          w.opaque = true; w.text += src.slice(j, k + 1); j = k;
        }
        else { if (src[j] === '$') w.opaque = true; w.text += src[j]; }
      }
      i = j;
    }
    else if (c === '`' || (c === '$' && d === '(') || ((c === '<' || c === '>') && d === '(')) {
      const k = c === '`' ? src.indexOf('`', i + 1) : close(src, i + 1);
      if (k < 0) return null;
      word(i).opaque = true; w.text += src.slice(i, k + 1); i = k;
    }
    else if (c === '$') { word(i).opaque = true; w.text += c; }
    else if (c === '(' || c === ')' || c === ';') { cut(); depth = Math.max(0, depth + (c === '(') - (c === ')')); }
    else if (c === '|') { cut(); if (d === '|') i++; else { pipe = true; if (d === '&') i++; } }
    else if (c === '&' && d !== '>') { cut(); if (d === '&') i++; }
    else if (c === '<' || c === '>' || c === '&') {
      if (w && /^\d+$/.test(w.text) && !w.quoted) w = null;   // the fd in 2>&1
      else end();
      if (c === '<' && d === '<' && src[i + 2] !== '<') {
        i += 2;
        const dash = src[i] === '-';
        if (dash) i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let delim = '';
        for (; i < src.length && !/[\s;&|<>()]/.test(src[i]); i++) if (!`'"\\`.includes(src[i])) delim += src[i];
        i--;
        docs.push({ delim, dash });
        continue;
      }
      while ('<>&|'.includes(src[i + 1]) && src[i + 1] !== undefined) i++;
      redir = true;
    }
    else word(i).text += c;
  }
  if (docs.length) return null;
  cut();
  return segs;
}

// Index of the ")" closing the "(" at i, or -1.
function close(src, i) {
  for (let depth = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === "'") { i = src.indexOf("'", i + 1); if (i < 0) return -1; }
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

// Where the line after the last heredoc body starts, or -1 if one never ends.
function bodies(src, pos, docs) {
  for (const doc of docs) {
    for (;;) {
      if (pos > src.length) return -1;
      let nl = src.indexOf('\n', pos);
      if (nl < 0) nl = src.length;
      const line = src.slice(pos, nl);
      pos = nl + 1;
      if ((doc.dash ? line.replace(/^\t+/, '') : line) === doc.delim) break;
    }
  }
  return pos;
}

// One simple command: where dibs would go, and the words of what it runs.
// Null when it starts with something opaque or a form we don't follow.
function peel(seg) {
  const words = seg.filter(w => !w.redir);
  const t = words.map(w => w.text);
  let i = 0, at = null;
  for (;;) {
    const w = words[i];
    if (!w || w.opaque || (OFF.test(w.text) && at === null)) return null;
    if (!w.quoted && KEYWORDS.has(w.text) && at === null) {
      i++;
      if (w.text === 'time') i = flags(t, i);
      if (w.text === 'command' && t[i]?.startsWith('-')) return null;   // command -v is a lookup
      continue;
    }
    if (ASSIGN.test(w.text) && at === null) { i++; continue; }
    at ??= w.start;
    const next = PREFIX[w.quoted ? '' : base(w.text)]?.(t, i);
    if (next == null) break;
    // env DIBS_GUARD=off xcodebuild switches it off too
    if (t.slice(i, next).some(a => OFF.test(a))) return null;
    i = next;
  }
  let argv = t.slice(i);
  if (PM.has(base(argv[0]))) {
    argv = [argv[0], ...argv.slice(flags(argv, 1, PM_VALUE))];
    if (argv[1] === 'workspace') argv = [argv[0], ...argv.slice(3)];   // yarn workspace web test
  }
  return { at, argv };
}

const globs = new Map();
function glob(p) {
  if (!globs.has(p)) globs.set(p, new RegExp(`^${p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
  return globs.get(p);
}

// The arguments after a rule's words, or null if it doesn't match.
function after(pattern, argv) {
  const pat = pattern.trim().split(/\s+/);
  for (let k = 0; k < pat.length; k++) {
    if (pat[k] === '$') return argv.length === k ? [] : null;
    const word = k === 0 ? base(argv[0]) : argv[k];
    if (word === undefined || !glob(pat[k]).test(word)) return null;
  }
  return argv.slice(pat.length);
}

// The resource a command needs, or null.
function resourceFor(argv, rules) {
  for (const rule of Object.values(rules)) {
    if (!rule || !rule.res) continue;
    const rest = [].concat(rule.match).map(p => after(p, argv)).find(Boolean);
    if (!rest) continue;
    if (rule.unless?.some(u => rest.includes(u)) || rule.reads?.(rest)) continue;
    if (rule.with && !rule.with.some(a => argv.includes(a))) continue;
    return typeof rule.res === 'function' ? rule.res(argv) : String(rule.res);
  }
  return null;
}

// The rules after ~/.dibs/config.json's guard.rules: a name set to false
// switches a built-in off, anything else adds or replaces one.
export function rulesFrom(guardCfg) {
  return { ...RULES, ...(guardCfg?.rules || {}) };
}

// A ~ inside a word stays as typed (Windows short names: C:/Users/RUNNER~1); only a leading one expands.
const quote = s => (/^[\w@%+=:,./-][\w@%+=:,./~-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// What to do with a command: null to leave it alone, or the rewritten command
// and what was caught.
export function check(cmd, { rules = RULES, dibs = 'dibs' } = {}) {
  if (typeof cmd !== 'string') return null;
  const segs = split(cmd);
  if (!segs) return null;
  // dibs calls themselves are left alone, and what a `dibs hold` on this line
  // takes covers the commands after it. Anything else heavy on the line, before
  // or after a dibs call, still needs its turn.
  const held = new Set();
  const hits = [];
  for (const c of segs.map(peel).filter(Boolean)) {
    if (c.argv[0] === 'export' && c.argv.some(a => OFF.test(a))) break;   // export DIBS_GUARD=off: the rest of the line
    if (['dibs', 'dibs.mjs', 'dibs-guard.mjs'].includes(base(c.argv[0] || ''))) {
      if (c.argv[1] === 'hold') for (const r of c.argv.slice(2).filter(a => !a.startsWith('-'))) resList(r).forEach(x => held.add(x));
      continue;
    }
    const res = resourceFor(c.argv, rules);
    if (res && !res.split(',').every(r => held.has(r))) hits.push({ at: c.at, res, what: c.argv.slice(0, 3).join(' ') });
  }
  if (!hits.length) return null;
  // $SIM is only set inside the run, so a command that reads it goes to sh -c
  // whole, under one lease for everything it needs.
  if (/\$\{?SIM(_NAME)?\b/.test(cmd)) {
    const res = [...new Set(hits.flatMap(h => h.res.split(',')))].join(',');
    const why = `guard: ${hits[0].what}`.replace(/[^\w .:/=@,+-]/g, '').slice(0, 50).trim();
    return { command: `${dibs} run ${res} -m ${quote(why)} -- sh -c ${quote(cmd)}`, hits };
  }
  let out = cmd;
  for (const h of [...hits].sort((a, b) => b.at - a.at)) {
    const why = `guard: ${h.what}`.replace(/[^\w .:/=@,+-]/g, '').slice(0, 50).trim();
    out = `${out.slice(0, h.at)}${dibs} run ${h.res} -m ${quote(why)} -- ${out.slice(h.at)}`;
  }
  return { command: out, hits };
}

// The hook never stops a session over its own failure, but leaves one line
// here so the failure isn't invisible. Writing it may fail too; nothing to do then.
// Where in dibs it broke and on what kind of call, never the command itself
// (it can hold secrets): enough to find the bug, as `dibs alerts` reports it.
function logError(e, input) {
  // A full disk is no bug in dibs: the call goes through, and the board already says the disk is full.
  if (e?.code === 'ENOSPC' || e?.code === 'EDQUOT') return;
  const at = String(e?.stack || '').split('\n').find(l => l.includes('/src/'))?.match(/\/(src\/[\w.]+:\d+)/)?.[1];
  const on = input?.hook_event_name ? ` [${input.hook_event_name}${input.tool_name ? ` ${input.tool_name}` : ''}]` : '';
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${String(e?.message || e).split('\n')[0]}${at ? ` at ${at}` : ''}${on}\n`); } catch {}
}

function dibsConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') logError(`${CONFIG}: ${e.message}`); return {}; }
}
const guardConfig = () => dibsConfig().guard ?? {};

// Subagent spawns, starts and stops go to the subagent limit (src/agents.mjs),
// loaded only for those: a Bash call still pays for this module alone.
const AGENT_EVENT = input => ['Agent', 'Task'].includes(input?.tool_name) || ['SubagentStart', 'SubagentStop'].includes(input?.hook_event_name);

// `dibs` when it's on PATH, so the rewritten command reads the way agents
// write it; otherwise this copy's full path.
function dibsCommand() {
  for (const dir of (process.env.PATH || '').split(path.delimiter))
    if (dir && fs.existsSync(path.join(dir, 'dibs'))) return 'dibs';
  return viaNode(path.join(ROOT, 'bin', 'dibs.mjs'));
}

// Rewrite only where "allow" approves nothing the session wouldn't have run
// anyway (bypassPermissions), unless guard.rewrite says always or never.
// Everywhere else, deny with the exact command, so the agent's retry goes
// through the normal permission checks.
// "guard": false in config.json (or guard.commands false) switches off only
// the heavy-command half; file leases stay enforced unless guard.files is false.
export function respond(input, guardCfg = {}, dibs = 'dibs') {
  // Another session's file lease (src/files.mjs) turns a write away before anything else.
  // So does a delete in another session's temp folder, whatever the config says: it's the person's rule.
  const leased = tmpGuard(input, split) || (guardCfg?.files === false ? null : fileGuard(input, split));
  if (leased || input?.tool_name !== 'Bash' || guardCfg === false || guardCfg?.commands === false) return leased;
  const ti = input.tool_input || {};
  const plan = check(ti.command, { rules: rulesFrom(guardCfg), dibs });
  if (!plan) return null;
  const mode = guardCfg.rewrite || 'bypass';
  const what = [...new Set(plan.hits.map(h => h.what.split(' ')[0]))].join(', ');
  if (mode === 'always' || (mode === 'bypass' && input.permission_mode === 'bypassPermissions')) {
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `dibs guard wrapped ${what} in dibs run`,
      updatedInput: { ...ti, command: plan.command },
      additionalContext: `dibs guard ran this through dibs because ${what} wasn't wrapped: ${plan.command}\n` +
        'Wrap builds, simulator use, test suites and deploys in dibs run yourself. If this call reaches its timeout while waiting in the queue, Claude Code moves it to the background and tells you when it ends: don\'t run it again.',
    } };
  }
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `dibs guard: ${what} has to take its turn through dibs, or it collides with other agents. Run this instead:\n  ${plan.command}\n` +
      'If it really is a quick read that builds, boots, tests and deploys nothing, put DIBS_GUARD=off in front of it.',
  } };
}

const STOP_EVENT = input => ['Stop', 'SubagentStop'].includes(input?.hook_event_name);
const START_EVENT = input => ['SessionStart', 'SubagentStart'].includes(input?.hook_event_name);

// Whether the person has a message waiting for the agent making this call
// (src/talk.mjs). With none queued anywhere the file doesn't exist.
function queuedFor(input) {
  if (typeof input?.session_id !== 'string' || input.hook_event_name === 'SubagentStart') return false;
  try { return (JSON.parse(fs.readFileSync(INBOX, 'utf8'))[input.session_id] || []).includes(input.agent_id || 'main'); }
  catch { return false; }
}

// Whether a stopping subagent has a thread to mark ended. Most never talked,
// and talk.mjs loads most of dibs, so look for its id in the file first.
function talked(input) {
  if (typeof input.agent_id !== 'string' || !input.agent_id) return false;
  try { return fs.readFileSync(MESSAGES, 'utf8').includes(JSON.stringify(input.agent_id)); } catch { return false; }
}

// A main agent ending its turn after its dibs listen ended (it handed messages over, ran out of
// time or was killed) is kept going once, for that listener, to start it again: without one, a
// message sent while it waits sits until its next tool call. Only a session that listened
// before; one that never did hears about it at its start (src/primer.mjs). One read, and one
// small write when it reminds.
function rearm(input) {
  if (input?.hook_event_name !== 'Stop' || input.stop_hook_active || typeof input.session_id !== 'string') return null;
  let l;
  try { l = JSON.parse(fs.readFileSync(LISTENERS, 'utf8'))[`${input.session_id}|main`]; } catch { return null; }
  if (!Number.isInteger(l?.pid)) return null;
  try { process.kill(l.pid, 0); return null; } catch (e) { if (e.code !== 'ESRCH') return null; }
  let told = {};
  try { told = JSON.parse(fs.readFileSync(REMINDED, 'utf8')); } catch {}
  if (told[input.session_id] === l.pid) return null;
  delete told[input.session_id];
  told[input.session_id] = l.pid;
  const keys = Object.keys(told);
  for (const k of keys.slice(0, Math.max(0, keys.length - REMIND_KEEP))) delete told[k];
  fs.writeFileSync(`${REMINDED}.${process.pid}`, JSON.stringify(told));
  fs.renameSync(`${REMINDED}.${process.pid}`, REMINDED);
  return { decision: 'block', reason: 'dibs: re-arm: your dibs listen has ended. Start it again with run_in_background (dibs listen) before you end your turn, so a message sent while you wait wakes you. dibs reminds you once each time it ends.' };
}

// The hook itself: Claude Code's JSON on stdin, a decision on stdout. Any
// failure prints nothing, which leaves the command to the normal permission flow.
export async function hook() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { return logError(e, null); }
  const out = await decide(input);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
}

// What the hook answers for one event, or null to say nothing. The resident
// guard (src/guardd.mjs) runs this too, in a fresh worker per call.
export async function decide(input) {
  let out = null;
  try {
    if (AGENT_EVENT(input)) out = (await import('./agents.mjs')).agentHook(input, dibsConfig());
    else if (!STOP_EVENT(input) && !START_EVENT(input)) out = respond(input, guardConfig(), dibsCommand());
  } catch (e) { logError(e, input); }
  // A new session, or a subagent's first start, hears the few rules that keep it out of trouble (src/primer.mjs).
  try { if (START_EVENT(input)) out = (await import('./primer.mjs')).primer(input, out); } catch (e) { logError(e, input); }
  try {
    if (queuedFor(input)) out = (await import('./talk.mjs')).deliver(input, out);
    else if (input?.hook_event_name === 'SubagentStop' && talked(input)) (await import('./talk.mjs')).finished(input);
  } catch (e) { logError(e, input); }
  try { if (!out) out = rearm(input); } catch (e) { logError(e, input); }
  return out;
}

const isGuard = h => h?.type === 'command' && /dibs-guard\.mjs['"]?$|\bdibs(\.mjs)?['"]? guard['"]?$/.test(String(h.command || '').trim());

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw new Error(`${file} isn't valid JSON; not touching it`); }
}

// Back up the old file once per change, then swap the new one in whole.
// Returns where the backup went, if there was a file to back up.
function writeSettings(file, s) {
  const had = fs.existsSync(file);
  const real = had ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(real), { recursive: true });
  if (had) fs.copyFileSync(real, `${file}.dibs-backup`);
  const tmp = `${real}.dibs-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: had ? fs.statSync(real).mode & 0o777 : 0o600 });
  fs.renameSync(tmp, real);
  return had ? `${file}.dibs-backup` : null;
}

// Where the hook goes: Bash and the edit tools for the guard and file leases;
// the Agent tool (Task in older Claude Code) and subagent starts and stops for
// the subagent limit. No matcher on those two: agents.mjs sorts out which
// subagents count.
// Stop (no matcher: it takes none) hands the person's messages to an agent
// about to end its turn; SubagentStop does the same for subagents.
// SessionStart (no matcher: startup, resume, clear and compact all need it) tells a session the rules.
const ENTRIES = [['PreToolUse', 'Bash|Edit|Write|MultiEdit|NotebookEdit'], ['PreToolUse', 'Agent|Task'], ['SubagentStart', null], ['SubagentStop', null], ['Stop', null],
  ['SessionStart', null]];
const EVENTS = [...new Set(ENTRIES.map(e => e[0]))];

// Take our hook out of every event, dropping groups and lists it leaves empty.
function strip(s) {
  let found = false;
  for (const ev of EVENTS) {
    const groups = s.hooks?.[ev];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      const hs = Array.isArray(g?.hooks) ? g.hooks.filter(h => !isGuard(h)) : g?.hooks;
      if (Array.isArray(g?.hooks) && hs.length !== g.hooks.length) found = true;
      if (!Array.isArray(hs) || hs.length) kept.push(Array.isArray(g?.hooks) ? { ...g, hooks: hs } : g);
    }
    if (kept.length) s.hooks[ev] = kept;
    else delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return found;
}

export const MATCHER = ENTRIES[0][1];

// Our groups in one event.
const ours = (s, ev = 'PreToolUse') => (s.hooks?.[ev] || []).filter(g => Array.isArray(g?.hooks) && g.hooks.some(isGuard));
// Every entry there with this command, and nothing else of ours: an older
// install (Bash alone, or no subagent events) is replaced, not added to.
const complete = (s, command) => EVENTS.every(ev => ours(s, ev).length === ENTRIES.filter(e => e[0] === ev).length)
  && ENTRIES.every(([ev, matcher]) => ours(s, ev).some(g => (g.matcher ?? null) === matcher && g.hooks.some(h => isGuard(h) && h.command === command)));

export function installed(file = SETTINGS) {
  return ours(readSettings(file)).flatMap(g => g.hooks).find(isGuard) || null;
}

export function install(file = SETTINGS, command = viaNode(HOOK_BIN)) {
  const s = readSettings(file);
  const had = installed(file);
  if (complete(s, command)) return `already installed in ${file}`;
  strip(s);
  s.hooks ||= {};
  for (const [ev, matcher] of ENTRIES)
    (s.hooks[ev] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
  const backup = writeSettings(file, s);
  return `${had ? 'updated' : 'installed'} in ${file}${backup ? ` (old file in ${backup})` : ''}`;
}

export function remove(file = SETTINGS) {
  const s = readSettings(file);
  if (!strip(s)) return null;
  writeSettings(file, s);
  return `removed from ${file} (old file in ${file}.dibs-backup)`;
}

const USAGE = `dibs guard: catch heavy commands an agent runs outside dibs, turn away edits to files another session leased, cap subagents running at once when you set a limit, and hand agents the person's messages (dibs tell) (a Claude Code hook)
  dibs guard install [--settings file]   add the hook to ~/.claude/settings.json (backup kept)
  dibs guard remove [--settings file]    take it out again
  dibs guard status [--settings file] [--json]   is it installed (exit 1 if not; --json always exits 0)
  dibs guard check "<command>"           what the hook would do with a command
  dibs guard serve                       answer the hook from one running process (dibs service install guard keeps it up)
The hook reads Claude Code's JSON on stdin: dibs guard < input.json`;

// What `dibs guard status --json` prints, for dibs web too.
export function guardJson(file = SETTINGS) {
  const h = installed(file);
  const s = readSettings(file);
  const agents = dibsConfig().agents;
  return { installed: !!h, file, command: h?.command ?? null, complete: !!h && complete(s, h.command),
    matchers: EVENTS.flatMap(ev => ours(s, ev).map(g => ({ event: ev, matcher: g.matcher ?? null }))), rewrite: guardConfig().rewrite || 'bypass',
    subagents: Number(agents?.slots) > 0 ? { slots: Number(agents.slots) } : null };
}

// dibs guard [install|remove|status|check]. With no verb and JSON piped in, be the hook.
export function guard(args) {
  const reply = (msg, code = 0) => { (code ? process.stderr : process.stdout).write(`${msg}\n`); process.exitCode = code; };
  const at = args.indexOf('--settings');
  const file = at >= 0 ? args[at + 1] : SETTINGS;
  if (at >= 0 && !file) return reply('--settings needs a path', 2);
  const verb = args[0];
  try {
    if (!verb) return process.stdin.isTTY ? reply(USAGE) : hook();
    if (verb === 'serve') return import('./guardd.mjs').then(m => m.serveGuard());
    if (verb === 'install') return reply(`dibs guard: ${install(file)}`);
    if (verb === 'remove') { const r = remove(file); return r ? reply(`dibs guard: ${r}`) : reply(`dibs guard: not installed in ${file}`, 1); }
    if (verb === 'status') {
      const h = installed(file);
      const mode = guardConfig().rewrite || 'bypass';
      const agents = dibsConfig().agents;
      // For the Mac app: the same facts as an object, exit 0 either way.
      if (args.includes('--json')) return reply(JSON.stringify(guardJson(file), null, 1));
      if (!h) return reply(`dibs guard is off: it isn't in ${file}. Turn it on: dibs guard install`, 1);
      return reply([`dibs guard is on (in ${file}).`,
        `  Heavy commands an agent runs outside dibs: ${guardConfig() === false || guardConfig().commands === false ? 'let through (switched off in config.json)' : mode === 'bypass' ? 'run through dibs in bypassPermissions sessions, turned away in others' : `run through dibs in "${mode}" sessions, turned away in others`}.`,
        `  Edits to files another agent reserved: ${guardConfig().files === false ? 'let through (guard.files is false in config.json)' : 'turned away'}.`,
        '  New sessions and subagents: told in a few lines how to use dibs. Messages from the person (dibs tell) and notices about their own jobs: handed over on their next tool call.',
        `  Subagents: ${Number(agents?.slots) > 0 ? `at most ${agents.slots} at once across every session` : 'no limit (set agents.slots in config.json to add one)'}.`,
        ...(complete(readSettings(file), h.command) ? [] : ['  This is an older install without the file checks, the subagent limit, messages from the person or the new-session primer. Add them: dibs guard install']),
        `  The hook: ${h.command}`].join('\n'));
    }
    if (verb === 'check') {
      const plan = check(args.slice(1).join(' '), { rules: rulesFrom(guardConfig()) });
      return reply(plan ? `${plan.hits.map(h => h.res).join(' + ')}: ${plan.command}` : 'leave alone');
    }
    return reply(USAGE, 2);
  } catch (e) { return reply(`dibs guard: ${e.message}`, 1); }
}
