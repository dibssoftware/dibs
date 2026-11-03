// What changed in dibs, for the agents using it: the CHANGELOG's sections, which version each
// agent last heard about (seen.json, shared with bin/dibs.mjs's what's-new line), the version on
// disk now (an update lands while a long dibs listen is running), and whether dibs.cc has a
// newer release (asked at most every 6 hours per machine, never for a git checkout).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, paths, loadConfig } from './config.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// DIBS_VERSION_FILE stands in for it in tests, which can't bump the real one.
const VERSION_FILE = process.env.DIBS_VERSION_FILE || path.join(ROOT, 'src', 'version.mjs');
// The newest release, as the Mac app reads it. DIBS_UPDATE_URL points a test at its own.
const LATEST = process.env.DIBS_UPDATE_URL || 'https://dibs.cc/mac/latest.json';
// How often one machine asks dibs.cc, whoever asks: a release a few hours old can wait.
export const CHECK_EVERY = 6 * 36e5;
// An answer slower than this is no answer: the check never holds anything up.
const CHECK_TIMEOUT = 3000;
const CHECKED = path.join(HOME, 'update-check.json');
export const UPGRADE = 'curl -fsSL https://dibs.cc/install.sh | sh';

// "0.0.178" against "0.0.99": by number, part by part.
export function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// The changelog's sections, newest first: [{ version, body }].
export function changelog() {
  try {
    return fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').split(/^## /m).slice(1)
      .map(sec => ({ version: sec.split(/\s/)[0], body: sec.slice(sec.indexOf('\n') + 1).trim() }));
  } catch { return []; }
}

// The sections after from, up to and including to, oldest first.
export const since = (from, to) => changelog().filter(c => /^\d/.test(c.version) && newer(c.version, from) && !newer(c.version, to)).reverse();

const readSeen = () => { try { return JSON.parse(fs.readFileSync(paths.seen, 'utf8')); } catch { return {}; } };
export const seenBy = key => readSeen()[key] || null;
export function markSeen(key, version) {
  const seen = readSeen();
  seen[key] = version;
  try {
    fs.writeFileSync(`${paths.seen}.${process.pid}`, JSON.stringify(seen));
    fs.renameSync(`${paths.seen}.${process.pid}`, paths.seen);
  } catch {}
}

// The version on disk, which is what the next dibs command runs: read again only when the file
// changed, so a listener can look every few seconds for nothing.
let onDisk = { mtime: 0, version: null };
export function diskVersion() {
  try {
    const m = fs.statSync(VERSION_FILE).mtimeMs;
    if (m !== onDisk.mtime) onDisk = { mtime: m, version: /VERSION = '([^']+)'/.exec(fs.readFileSync(VERSION_FILE, 'utf8'))?.[1] || null };
  } catch {}
  return onDisk.version;
}

// A git checkout (this repo, linked from ~/bin) updates by git, not by the install script.
const checkout = () => !process.env.DIBS_UPDATE_URL && fs.existsSync(path.join(ROOT, '.git'));
const readChecked = () => { try { return JSON.parse(fs.readFileSync(CHECKED, 'utf8')); } catch { return {}; } };
function writeChecked(c) {
  try {
    fs.writeFileSync(`${CHECKED}.${process.pid}`, JSON.stringify(c));
    fs.renameSync(`${CHECKED}.${process.pid}`, CHECKED);
  } catch {}
}

// The newest release dibs.cc knows of, as last asked, asking again (in the background) when
// the machine's last ask is older than CHECK_EVERY. Off with config updateCheck: false.
export function latest(t = Date.now()) {
  let off = false;
  try { off = loadConfig().updateCheck === false; } catch {}
  if (off || checkout()) return null;
  const c = readChecked();
  if (!(t - (c.at || 0) < CHECK_EVERY)) {
    // Claimed before asking, so a dozen listeners waking together ask once.
    writeChecked({ ...c, at: t });
    fetch(LATEST, { signal: AbortSignal.timeout(CHECK_TIMEOUT) }).then(r => (r.ok ? r.json() : null))
      .then(j => { if (typeof j?.version === 'string' && /^\d+(\.\d+)*$/.test(j.version)) writeChecked({ ...readChecked(), latest: j.version }); })
      .catch(() => {});
  }
  return c.latest || null;
}

// Each thread hears about a release once.
export const toldOf = key => readChecked().told?.[key] || null;
// Threads remembered: plenty for a machine's sessions over the weeks between releases.
const TOLD_KEEP = 500;
export function tell(key, version) {
  const c = readChecked();
  const told = { ...(c.told || {}) };
  delete told[key];
  told[key] = version;
  const keys = Object.keys(told);
  for (const k of keys.slice(0, Math.max(0, keys.length - TOLD_KEEP))) delete told[k];
  writeChecked({ ...c, told });
}
