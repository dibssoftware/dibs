// Cloudflare Turnstile in front of sign-in codes: the person check at human.dibs.cc (index.js
// humanPage) gets a token from the widget, and this asks Cloudflare whether it's good. A token
// works once, only for that host and for this action.
export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const ACTION = 'account-link';

export async function human(env, token, ip, fetcher = fetch) {
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > 2048) return false;
  let j = {};
  try {
    const r = await fetcher(SITEVERIFY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, ...(ip && ip !== 'local' && { remoteip: ip }) }) });
    j = await r.json();
  } catch { return false; }
  return j.success === true && j.hostname === env.HUMAN_HOST && j.action === ACTION;
}
