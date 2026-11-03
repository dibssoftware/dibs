// Node versions with a known hole dibs shouldn't run its long-lived parts on.
// CVE-2026-111497 ("Node2Shell", 2026-10-21): an out-of-bounds write in the
// Brotli decoder, reachable through any br-encoded body. Fixed in 22.23.4,
// 24.22.1 and 26.12.1; other lines older than 27 get no fix.
const FIXED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
const FIRST_SAFE_MAJOR = 27;

// null when this Node is fine, else a sentence saying why it isn't.
export function unpatched(version = process.versions.node) {
  const v = String(version).replace(/^v/, '').split('.').map(Number);
  const fix = FIXED[v[0]];
  const why = `Node ${v.join('.')} has the Brotli hole CVE-2026-111497`;
  if (v[0] >= FIRST_SAFE_MAJOR) return null;
  if (!fix) return `${why}, and Node ${v[0]} gets no fix. Use Node 22.23.4, 24.22.1, 26.12.1 or newer`;
  for (let i = 1; i < 3; i++) if (v[i] !== fix[i]) return v[i] > fix[i] ? null : `${why}. Upgrade to ${fix.join('.')} or newer`;
  return null;
}
