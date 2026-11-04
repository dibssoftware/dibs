// The dibs relay: serves the dibs page at app.dibs.cc and forwards opaque frames
// between a Mac and the browsers paired with it. It holds no keys and can't read
// or forge a frame: the page and the Mac encrypt and authenticate end to end
// (src/relay.mjs and web/transport.js in the dibs repo, docs/relay.md).
//
// One Durable Object per machine id. Nothing is written to storage, and nothing
// about a frame is logged: the only state is the open sockets and their counters.
//
//   /ws/m/<mid>   the Mac. It must sign a fresh challenge with the key whose hash
//                 is <mid> before anything is routed, so nobody else can stand in
//                 for that machine id. The key grants nothing beyond that. Once in,
//                 it tells the relay the hashes of its paired browsers' relay tokens
//                 and whether a pairing link is open.
//   /ws/b/<mid>   a browser tab. It gets a slot only by proving it's paired: its first
//                 message carries its relay token, and the relay admits it if the
//                 token's hash is one the Mac registered. A tab may instead ask to pair
//                 with the ticket the link derives, from a small pool with a deadline.
//                 Then binary messages go to the Mac tagged with the tab's channel id;
//                 the relay's own notes ({t:'mac', up}) are text.
import { DurableObject } from 'cloudflare:workers';
import { CodeBook, MAX_CODES } from './codebook.js';
import { accountRoute } from './accounts.js';
export { Accounts } from './accounts.js';

const MID = /^[A-Za-z0-9_-]{22}$/;
// Paired tabs per machine at once. A person has a few devices, each with a tab or two.
const MAX_BROWSERS = 8;
// Paired tabs from one address at once.
const MAX_TABS_PER_IP = 4;
// Tabs that haven't proved anything yet. Past the cap the oldest goes, never the newcomer.
const MAX_UNPROVEN = 6;
const MAX_UNPROVEN_PER_IP = 3;
// A new tab has this long to send its relay token, or ask to pair. The page sends it on open.
const PROVE_TIME = 5e3;
// Tabs pairing at once, only with a ticket from an open link, and for this long at most:
// the Mac's own handshake deadline is 20 s.
const MAX_PAIRING = 2;
const PAIR_TIME = 30e3;
// Registered token hashes the Mac may send (they live in its socket's attachment, 2 KB at most),
// and open links' ticket hashes (src/relay.mjs keeps at most 5 links).
const MAX_HASHES = 56;
const MAX_TICKETS = 5;
// Mac sockets waiting to authenticate at once. Past it the oldest waiting one goes, never the
// newcomer: refusing new ones would let a few silent sockets lock the real Mac out.
const MAX_PENDING_MACS = 8;
// Each one gets this long, on its own timer. Answering the challenge takes one round trip.
const AUTH_TIME = 10e3;
// While the Mac is offline no tab can do anything, so none keeps a slot past this.
const OFFLINE_GRACE = 5e3;
// Biggest frame either side may send. Requests are small; responses carry the board,
// padded to at most 4 MiB, plus the frame header, tag and channel id.
const MAX_FROM_BROWSER = 65536 + 64;
const MAX_FROM_MAC = 4 * 1024 * 1024 + 64;
// Token buckets: a page polls every few seconds; the Mac answers every tab.
const BROWSER_RATE = { per: 20, burst: 60 };
const MAC_RATE = { per: 200, burst: 400 };
// New tab connections per address per minute, here (the Worker also limits per address, per colo).
const OPENS_PER_MIN = 30;
// A tab silent this long is closed; its page reconnects when it needs to.
const BROWSER_IDLE = 10 * 60e3;
// The Mac pings every 25 s. Twice that and a bit with no ping means it's gone.
const MAC_IDLE = 90e3;
const SWEEP_EVERY = 60e3;


const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s, len) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  let bin;
  try { bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)); } catch { return null; }
  const b = Uint8Array.from(bin, c => c.charCodeAt(0));
  return b64u(b) === s && (len == null || b.length === len) ? b : null;
}
const enc = new TextEncoder();
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
function tx(label, ...fields) {
  const parts = [label, ...fields].flatMap(f => { const b = typeof f === 'string' ? enc.encode(f) : f; return [u32(b.length), b]; });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Same as src/relay.mjs tokenHash(): what the Mac registers for a paired browser's relay token.
const tokenHash = async rt => b64u((await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('dibs-relay-token-v1\0'), ...rt]))).slice(0, 16));
// Compares every registered hash in full, so the time taken says nothing about which or how much matched.
function registered(list, h) {
  const want = enc.encode(h);
  let found = 0;
  for (const x of list) {
    const got = enc.encode(x);
    let diff = got.length ^ want.length;
    for (let i = 0; i < want.length; i++) diff |= (got[i] ?? 0) ^ want[i];
    found |= diff === 0 ? 1 : 0;
  }
  return found === 1;
}
const machineId = async pub => b64u((await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode('dibs-mid-v1\0'), ...pub]))).slice(0, 16));

// Headers on everything the page origin serves. The page is the trust anchor for the
// browser side, so it gets the strictest policy the page can live with.
// frame: the one origin the page may embed (the account page's person check on mcp.dibs.cc), or none.
function pageHeaders(host, frame = null) {
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://${host}${host.startsWith('127.0.0.1:') || host.startsWith('localhost:') ? ` ws://${host}` : ''}; manifest-src 'none'; worker-src 'none'; frame-src ${frame || "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`,
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Not on a page that frames the person check: Cloudflare's own frame inside it sends no COEP.
    ...(!frame && { 'Cross-Origin-Embedder-Policy': 'require-corp' }),
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), clipboard-read=(), interest-cohort=()',
    // Revalidate every load, so a fixed page reaches everyone at once.
    'Cache-Control': 'no-cache',
  };
}
const plain = (status, text, host) => new Response(text, { status, headers: { ...pageHeaders(host), 'Content-Type': 'text/plain; charset=utf-8' } });

// mcp.dibs.cc: MCP and its OAuth sign-in for one machine, forwarded to that Mac over its
// authenticated socket as request/response messages. Unlike the page, this isn't end-to-end:
// MCP clients (Claude's servers) speak HTTPS, which ends here, so the relay carries these
// requests and answers in the clear. It forwards nothing else and keeps none of it.
const MCP_KINDS = 'oauth-protected-resource|oauth-authorization-server|openid-configuration';
// method:path the Mac may be asked, after /<mid>. Everything else is 404 here.
const MCP_ROUTES = new Set(['GET:/mcp', 'POST:/mcp', 'POST:/oauth/register', 'GET:/oauth/client', 'POST:/oauth/authorize', 'POST:/oauth/token',
  ...MCP_KINDS.split('|').map(k => `GET:/.well-known/${k}`)]);
// The sign-in page and what it loads, served from this Worker's own copy (relay/build.mjs).
const MCP_PAGE_FILES = new Set(['/web/app.css', '/web/dither.js', '/web/authorize.js', '/web/human.js', '/web/logo.png', '/web/SchibstedGrotesk.woff2']);
const MCP_IN = ['content-type', 'authorization', 'origin', 'accept', 'mcp-protocol-version'];
const MCP_BODY_MAX = 64 * 1024;
// How long the Mac gets to answer (its own CLI calls give up at 15 s).
const MCP_TIMEOUT = 25e3;
// Per machine: requests a minute (a client's session makes a few dozen) and at once.
const MCP_PER_MIN = 120;
// Requests without a token the Mac accepts, per address a minute: sign-in takes a handful.
const MCP_ANON_PER_MIN = 40;
// ... and from all addresses together, per machine: only a real flood reaches it.
const MCP_ANON_CEILING = 600;
// Refresh grants per address a minute: a client renews once a day.
const MCP_REFRESH_PER_MIN = 10;
// Per-address budgets kept in memory per machine; past this, full ones are dropped.
const BUCKETS_MAX = 10000;
const MCP_INFLIGHT = 8;
// At once from one address, under the machine's 8, so one address can't fill them all.
const MCP_INFLIGHT_PER_IP = 2;

const mcpHeaders = extra => ({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  ...extra });
const mcpJson = (status, error) => new Response(JSON.stringify({ error }), { status, headers: mcpHeaders({ 'Content-Type': 'application/json' }) });

// The person check, on this host and never on app.dibs.cc: Cloudflare Turnstile's script runs
// here, in a frame the account page embeds out of sight, so it never runs beside the account
// key in app.dibs.cc's storage. The frame hands its token to the account page by postMessage,
// and the account page sends it with the address (accounts.js accountRoute checks it).
// Only app.dibs.cc may frame it. Nothing is stored on this origin.
const TURNSTILE = 'https://challenges.cloudflare.com';
// The account page's origin, in this request's scheme (https, or http under wrangler dev).
const pageOrigin = (env, url) => `${url.protocol}//${env.PAGE_HOST}`;
function humanHeaders(env, url) {
  const h = mcpHeaders({ 'Content-Security-Policy': `default-src 'none'; script-src 'self' ${TURNSTILE}; frame-src ${TURNSTILE}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${pageOrigin(env, url)}` });
  delete h['X-Frame-Options'];
  return h;
}
async function humanPage(req, env, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return mcpJson(405, 'GET only');
  // The email step used to be a page here; it's on the account page now.
  if (url.pathname === '/email') return new Response(null, { status: 301, headers: { Location: `${pageOrigin(env, url)}/account`, 'Cache-Control': 'max-age=3600', 'Referrer-Policy': 'no-referrer' } });
  if (url.pathname === '/human/config') return json(200, { sitekey: env.TURNSTILE_SITEKEY || null, page: env.PAGE_HOST ? pageOrigin(env, url) : null });
  return withHeaders(await env.ASSETS.fetch(new Request(new URL('/human', url), req)), humanHeaders(env, url));
}

// https://mcp.dibs.cc/mcp with no machine id: discovery and registration answered here with
// nothing stored, sign-in routed by the code's hash through the code index, and everything
// after routed by the "<mid>." tag the Mac puts on its codes and tokens.
const BARE = new Set(['/mcp', '/authorize', '/oauth/register', '/oauth/client', '/oauth/authorize', '/oauth/token',
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']);
// The Mac's own answer to a wrong code (src/web.mjs spend()), word for word and as slow, so an
// unknown code looks the same as one its Mac turned down.
const WRONG_CODE = { status: 401, error: 'That code is wrong or used up. Run dibs pair for a new one.', delay: 800 };
const TAG = /^([A-Za-z0-9_-]{22})\./;
const goodRedirect = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };
// Same as src/web.mjs norm() and indexHash().
const norm = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const indexHash = async code => b64u(await crypto.subtle.digest('SHA-256', enc.encode(`dibs-mcp-code-v1\0${norm(code)}`)));
const json = (status, data, extra = {}) => new Response(JSON.stringify(data), { status, headers: mcpHeaders({ 'Content-Type': 'application/json', ...extra }) });

// ip goes to the Mac, which counts wrong codes and registrations per address (src/web.mjs).
async function forward(env, mid, req, path, body, bare) {
  const headers = {};
  for (const h of MCP_IN) { const v = req.headers.get(h); if (v != null) headers[h] = v; }
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const r = await env.MACHINE.get(env.MACHINE.idFromName(mid)).fetch('https://relay.internal/http', {
    method: 'POST', body: JSON.stringify({ method: req.method, path, headers, body, bare, ip }),
  });
  if (r.status !== 200) return { offline: true, status: r.status, text: await r.text() };
  return r.json();
}
// A request the relay couldn't hand to a Mac: too many (429) and too slow (504) say so;
// anything else (no such Mac connected) gets the route's own answer.
const notForwarded = (r, otherwise) => (r.status === 429 || r.status === 504 ? json(r.status, { error: r.text }) : otherwise);
const answer = a => {
  const out = {};
  for (const h of ['Content-Type', 'WWW-Authenticate', 'Allow']) if (typeof a.headers?.[h] === 'string') out[h] = a.headers[h];
  return new Response(a.status === 202 || a.status === 204 ? null : a.body, { status: a.status, headers: mcpHeaders(out) });
};

// A bare client id is "b.<payload>.<mac>": the payload (name and redirect URIs) is signed with
// REG_SECRET, the one secret this relay holds. It signs registrations and nothing else; no Mac
// knows it or needs it, and it opens nothing on any Mac (each still checks the code and the
// redirect itself). It keeps a client id from being edited to send a sign-in somewhere else.
const clientMac = async (env, payload) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.REG_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u((await crypto.subtle.sign('HMAC', key, enc.encode(`dibs-client-v1\0${payload}`))).slice(0, 16));
};
async function signedClient(env, id) {
  const m = typeof id === 'string' && id.length <= 2048 ? /^b\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/.exec(id) : null;
  if (!m || !env.REG_SECRET || !registered([await clientMac(env, m[1])], m[2])) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(unb64u(m[1])));
    return typeof j.n === 'string' && Array.isArray(j.r) ? j : null;
  } catch { return null; }
}

async function bare(req, env, url) {
  const base = `${url.protocol}//${env.MCP_HOST}`;
  const p = url.pathname, ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (req.method === 'GET' && p.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
  if (req.method === 'GET' && p.startsWith('/.well-known/')) {
    return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  }
  if (req.method === 'GET' && p === '/authorize') return withHeaders(await env.ASSETS.fetch(new Request(new URL('/authorize', url), req)), mcpHeaders());
  if (env.RLM) {
    const { success } = await env.RLM.limit({ key: `mcp:${ip}` });
    if (!success) return json(429, { error: 'too many requests from this address; try again in a minute' });
  }
  if (Number(req.headers.get('content-length') || 0) > MCP_BODY_MAX) return json(413, { error: 'too big' });
  const body = req.method === 'POST' ? await req.text() : '';
  if (body.length > MCP_BODY_MAX) return json(413, { error: 'too big' });
  const parse = () => { try { return /json/.test(req.headers.get('content-type') || '') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); } catch { return {}; } };

  // Registration keeps nothing: the client id is its name and redirect URIs. It grants nothing by
  // itself (registration is open to anyone anyway); the Mac checks the redirect against it at sign-in.
  if (req.method === 'POST' && p === '/oauth/register') {
    const r = parse();
    const uris = Array.isArray(r.redirect_uris) ? r.redirect_uris.filter(u => typeof u === 'string') : [];
    if (!uris.length || uris.length > 5 || !uris.every(u => u.length <= 512 && goodRedirect(u))) return json(400, { error: 'invalid_redirect_uri', error_description: 'redirect URIs must be https, or http on localhost' });
    const name = (typeof r.client_name === 'string' ? r.client_name : 'an MCP client').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 80);
    if (!env.REG_SECRET) return json(503, { error: 'registration is not set up on this relay' });
    const payload = b64u(enc.encode(JSON.stringify({ n: name, r: uris })));
    const id = `b.${payload}.${await clientMac(env, payload)}`;
    if (id.length > 2048) return json(400, { error: 'invalid_client_metadata', error_description: 'too long' });
    return json(201, { client_id: id, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  }
  if (req.method === 'GET' && p === '/oauth/client') {
    try {
      const j = await signedClient(env, url.searchParams.get('client_id'));
      if (j) return json(200, { name: j.n, redirect_uris: j.r });
    } catch {}
    return json(404, { error: 'unknown client' });
  }
  // Sign-in: the code's hash finds its Mac, which checks the code itself.
  if (req.method === 'POST' && p === '/oauth/authorize') {
    if (req.headers.get('Origin') !== url.origin) return json(403, { error: 'cross-site request refused' });
    const a = parse();
    if (!await signedClient(env, a.client_id)) return json(400, { error: 'This MCP client is not registered here. Remove it and add it again.' });
    const h = await indexHash(a.code);
    const index = env.INDEX.get(env.INDEX.idFromName('index'));
    const found = await index.fetch('https://index.internal/find', { method: 'POST', body: JSON.stringify({ h, ip }) }).then(r => r.json());
    if (found.limited) return json(429, { error: 'Too many sign-in attempts right now. Wait a minute and try again.' });
    if (!found.mid) { await new Promise(r => setTimeout(r, WRONG_CODE.delay)); return json(WRONG_CODE.status, { error: WRONG_CODE.error }); }
    const r = await forward(env, found.mid, req, '/oauth/authorize', body, true);
    if (r.status === 200) await index.fetch('https://index.internal/drop', { method: 'POST', body: JSON.stringify({ h, mid: found.mid }) });
    return r.offline ? notForwarded(r, json(r.status, { error: 'the Mac that code belongs to is offline' })) : answer(r);
  }
  // Token: routed by the tag on the authorization code or refresh token.
  if (req.method === 'POST' && p === '/oauth/token') {
    const f = parse();
    const mid = TAG.exec(String(f.grant_type === 'refresh_token' ? f.refresh_token : f.code || ''))?.[1];
    const bad = json(400, { error: 'invalid_grant', error_description: 'that code is wrong, used or expired' });
    if (!mid) return bad;
    // The code grant names its client; a refresh may leave it out (the Mac checks the token's own).
    if ((f.grant_type !== 'refresh_token' || f.client_id) && !await signedClient(env, f.client_id)) return json(400, { error: 'invalid_client', error_description: 'that client id was not issued here' });
    const r = await forward(env, mid, req, '/oauth/token', body, true);
    return r.offline ? notForwarded(r, bad) : answer(r);
  }
  if (p === '/mcp' && (req.method === 'POST' || req.method === 'GET')) {
    const unauthorized = json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
    const mid = TAG.exec((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''))?.[1];
    if (!mid) return unauthorized;
    const r = await forward(env, mid, req, '/mcp', body, true);
    return r.offline ? notForwarded(r, unauthorized) : answer(r);
  }
  return json(404, { error: 'not here' });
}

async function mcp(req, env, url) {
  if (req.method === 'GET' && MCP_PAGE_FILES.has(url.pathname)) return withHeaders(await env.ASSETS.fetch(req), mcpHeaders());
  if (/^\/(human(\/config)?|email)$/.test(url.pathname)) return humanPage(req, env, url);
  if (BARE.has(url.pathname)) return bare(req, env, url);
  // Clients find the metadata at /.well-known/<kind>/<mid>... (RFC 8414 and RFC 9728 path
  // insertion) or under /<mid>/.well-known/<kind>; both reach the same answer.
  const wk = new RegExp(`^/\\.well-known/(${MCP_KINDS})/([A-Za-z0-9_-]{22})(/.*)?$`).exec(url.pathname);
  const m = wk ? [null, wk[2], `/.well-known/${wk[1]}`] : /^\/([A-Za-z0-9_-]{22})(\/.*)$/.exec(url.pathname);
  if (!m) return mcpJson(404, 'not here');
  const [, mid, rest0] = m;
  const rest = rest0.replace(new RegExp(`^(/\\.well-known/(${MCP_KINDS}))/.*$`), '$1');
  if (req.method === 'GET' && rest === '/authorize') {
    const page = await env.ASSETS.fetch(new Request(new URL('/authorize', url), req));
    return withHeaders(page, mcpHeaders());
  }
  if (!MCP_ROUTES.has(`${req.method}:${rest}`)) return mcpJson(404, 'not here');
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (env.RLM) {
    const { success } = await env.RLM.limit({ key: `mcp:${ip}` });
    if (!success) return mcpJson(429, 'too many requests from this address; try again in a minute');
  }
  if (Number(req.headers.get('content-length') || 0) > MCP_BODY_MAX) return mcpJson(413, 'too big');
  const body = req.method === 'POST' ? await req.text() : '';
  if (body.length > MCP_BODY_MAX) return mcpJson(413, 'too big');
  const r = await forward(env, mid, req, rest + url.search, body, false);
  return r.offline ? mcpJson(r.status, r.text) : answer(r);
}

function withHeaders(res, extra) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.host;
    if (env.MCP_HOST && host === env.MCP_HOST) return mcp(req, env, url);
    // dibs.cc/app forwards here. A 3xx keeps the #fragment, so the pairing secret survives the hop
    // without ever being sent: browsers don't put fragments in requests.
    if (env.PAGE_HOST && host !== env.PAGE_HOST && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
      return new Response(null, { status: 301, headers: { Location: `https://${env.PAGE_HOST}/`, 'Cache-Control': 'max-age=3600', 'Referrer-Policy': 'no-referrer' } });
    }
    if (env.PAGE_HOST && host !== env.PAGE_HOST) return plain(404, 'not here', host);
    // The person check belongs to mcp.dibs.cc only (humanPage): never Turnstile's script here.
    if (/^\/(email|human)(\.html)?$/.test(url.pathname)) return plain(404, 'not here', host);

    const ws = /^\/ws\/(m|b)\/([^/]+)$/.exec(url.pathname);
    if (ws) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return plain(426, 'WebSocket only', host);
      if (!MID.test(ws[2])) return plain(404, 'no such machine', host);
      // Browsers only from the page itself; the Mac (no Origin) proves itself by signature.
      if (ws[1] === 'b' && req.headers.get('Origin') !== url.origin) return plain(403, 'cross-site connection refused', host);
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      if (env.RL) {
        const { success } = await env.RL.limit({ key: `${ws[1]}:${ip}` });
        if (!success) return plain(429, 'too many connections from this address; try again in a minute', host);
      }
      return env.MACHINE.get(env.MACHINE.idFromName(ws[2])).fetch(req);
    }

    if (url.pathname.startsWith('/account/')) {
      const r = await accountRoute(req, env, url);
      const headers = new Headers(r.headers);
      for (const [k, v] of Object.entries(pageHeaders(host))) headers.set(k, v);
      headers.set('Cache-Control', 'no-store');
      return new Response(r.body, { status: r.status, headers });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'GET only', host);
    const res = await env.ASSETS.fetch(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(pageHeaders(host))) headers.set(k, v);
    // The account page may carry a sign-in token in its query (?signin=, for mail wrappers that drop
    // fragments): never kept by a cache.
    if (url.pathname === '/account') {
      headers.set('Cache-Control', 'no-store');
      // The account page frames the person check on the MCP host, and only that.
      if (env.MCP_HOST && env.TURNSTILE_SITEKEY) {
        for (const [k, v] of Object.entries(pageHeaders(host, `${url.protocol}//${env.MCP_HOST}`))) headers.set(k, v);
        headers.delete('Cross-Origin-Embedder-Policy');
        headers.set('Cache-Control', 'no-store');
      }
    }
    return new Response(res.body, { status: res.status, headers });
  },
};

export class Machine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime without waking the object, so pings cost nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    // New tabs per address in the last minute. In memory only; lost on hibernation, which is fine.
    this.opens = new Map();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/http') return this.http(await req.json());
    const role = url.pathname.split('/')[2], mid = url.pathname.split('/')[3];
    const t = Date.now();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (role === 'm') {
      const pending = this.ctx.getWebSockets('mac').filter(w => !w.deserializeAttachment()?.authed).sort((a, b) => a.deserializeAttachment().at - b.deserializeAttachment().at);
      for (const old of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_MACS + 1))) old.close(4401, 'too many waiting to authenticate');
      const n = crypto.getRandomValues(new Uint8Array(32));
      this.ctx.acceptWebSocket(server, ['mac']);
      server.serializeAttachment({ role: 'm', mid, host: url.host, n: b64u(n), at: t, authed: false, bucket: MAC_RATE.burst, last: t, hashes: [], tickets: [] });
      server.send(JSON.stringify({ t: 'challenge', n: b64u(n) }));
      this.later(server, AUTH_TIME, a => !a.authed, 4401, 'authenticate first');
    } else {
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const mine = (this.opens.get(ip) || []).filter(x => t - x < 60e3);
      if (mine.length >= OPENS_PER_MIN) return new Response('too many new tabs from this address', { status: 429 });
      mine.push(t);
      this.opens.set(ip, mine);
      const unproven = this.tabs('new');
      if (unproven.filter(w => w.deserializeAttachment().ip === ip).length >= MAX_UNPROVEN_PER_IP) return new Response('too many tabs from this address', { status: 429 });
      for (const old of unproven.sort((a, b) => a.deserializeAttachment().at - b.deserializeAttachment().at).slice(0, Math.max(0, unproven.length - MAX_UNPROVEN + 1))) old.close(4403, 'too many unproven tabs');
      const ch = b64u(crypto.getRandomValues(new Uint8Array(16)));
      this.ctx.acceptWebSocket(server, ['b', `ch:${ch}`]);
      server.serializeAttachment({ role: 'b', st: 'new', ch, ip, at: t, bucket: BROWSER_RATE.burst, last: t, heard: t });
      this.later(server, PROVE_TIME, a => a.st === 'new', 4403, 'prove pairing first');
    }
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  // One MCP request for this machine's Mac: sent over its socket, answered by id. Only the
  // Worker's mcp() calls this (Durable Objects aren't reachable from outside).
  async http(r) {
    const mac = this.mac();
    if (!mac) return new Response('that Mac is offline or has no relay connection', { status: 503 });
    // Budgets, so that nobody spends someone else's, and a flood leaves no debt behind it:
    //   signed   requests with a token the Mac accepts, per machine
    //   anon     everything else (discovery, registration, sign-in, rejected tokens), per address,
    //            under a generous machine-wide ceiling
    //   refresh  refresh_token grants, per address, apart from anon, so a client can always renew
    // A token the Mac turns down (401) is refunded to signed and charged to that address's anon
    // budget, which never goes below -per: an attacker spends only their own, and owes at most a minute.
    // MCP_PER_MIN, MCP_ANON_PER_MIN and MCP_REFRESH_PER_MIN in the environment stand in for the defaults in the local test relay.
    const t = Date.now();
    const fill = b => { b.n = Math.min(b.per, b.n + ((t - b.at) / 60e3) * b.per); b.at = t; return b; };
    const ip = typeof r.ip === 'string' ? r.ip : 'local';
    const perIp = (name, per) => {
      const m = (this[name] ??= new Map());
      if (m.size > BUCKETS_MAX) for (const [k, b] of m) if (fill(b).n >= b.per) m.delete(k);
      if (!m.has(ip)) m.set(ip, { n: per, at: t, per });
      return fill(m.get(ip));
    };
    const signed = fill(this.mcpBucket ??= { n: 0, at: 0, per: Number(this.env.MCP_PER_MIN) || MCP_PER_MIN });
    const ceiling = fill(this.anonCeiling ??= { n: 0, at: 0, per: MCP_ANON_CEILING });
    const authed = typeof r.headers?.authorization === 'string';
    const refreshing = r.path === '/oauth/token' && /(^|&)grant_type=refresh_token(&|$)|"grant_type"\s*:\s*"refresh_token"/.test(r.body || '');
    const anon = perIp('anonByIp', Number(this.env.MCP_ANON_PER_MIN) || MCP_ANON_PER_MIN);
    const charge = authed ? [signed] : refreshing ? [perIp('refreshByIp', Number(this.env.MCP_REFRESH_PER_MIN) || MCP_REFRESH_PER_MIN)] : [anon, ceiling];
    this.waiting ??= new Map();
    this.inflight ??= new Map();
    // An address whose made-up tokens already cost it its anon budget can't keep sending them on the signed one.
    const busy = charge.some(b => b.n < 1) || (authed && anon.n < 1) || this.waiting.size >= MCP_INFLIGHT || (this.inflight.get(ip) || 0) >= MCP_INFLIGHT_PER_IP;
    if (busy) return new Response('too many requests for this machine; try again in a minute', { status: 429 });
    for (const b of charge) b.n--;
    this.inflight.set(ip, (this.inflight.get(ip) || 0) + 1);
    const id = b64u(crypto.getRandomValues(new Uint8Array(12)));
    const answer = new Promise(resolve => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, MCP_TIMEOUT);
      this.waiting.set(id, a => { clearTimeout(timer); this.waiting.delete(id); resolve(a); });
    });
    mac.send(JSON.stringify({ t: 'http', id, method: r.method, path: r.path, headers: r.headers, body: r.body, ip, ...(r.bare === true && { bare: true }) }));
    const a = await answer;
    const left = (this.inflight.get(ip) || 1) - 1;
    if (left) this.inflight.set(ip, left); else this.inflight.delete(ip);
    if (authed && a?.status === 401) { signed.n = Math.min(signed.per, signed.n + 1); anon.n = Math.max(-anon.per, anon.n - 1); }
    if (!a) return new Response('the Mac took too long to answer', { status: 504 });
    return new Response(JSON.stringify(a), { headers: { 'Content-Type': 'application/json' } });
  }

  // Closes ws after ms if still(attachment) holds then. Timers keep the object awake that long;
  // the alarm sweep is the backstop if it hibernates anyway.
  later(ws, ms, still, code, why) {
    setTimeout(() => {
      try { const a = ws.deserializeAttachment(); if (a && still(a)) ws.close(code, why); } catch {}
    }, ms);
  }

  tabs(st) { return this.ctx.getWebSockets('b').filter(w => w.deserializeAttachment()?.st === st); }

  // The authenticated Mac socket, if any (other than one that's closing).
  mac(except = null) { return this.ctx.getWebSockets('mac').find(w => w !== except && w.deserializeAttachment()?.authed) || null; }

  async schedule() {
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY);
  }

  // Each frame spends a token; tokens refill at `per` a second up to `burst`.
  spend(a, rate) {
    const t = Date.now();
    a.bucket = Math.min(rate.burst, a.bucket + ((t - a.last) / 1000) * rate.per);
    a.last = t;
    if (a.bucket < 1) return false;
    a.bucket--;
    return true;
  }

  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment();
    if (!a) return ws.close(1011, 'lost state');
    if (a.role === 'm') return this.fromMac(ws, a, msg);
    if (a.st === 'new') return this.prove(ws, a, msg);
    if (typeof msg === 'string') return ws.close(1003, 'binary only');
    if (msg.byteLength > MAX_FROM_BROWSER) return ws.close(1009, 'frame too big');
    if (!this.spend(a, BROWSER_RATE)) return ws.close(1008, 'too many frames');
    a.heard = Date.now();
    ws.serializeAttachment(a);
    const mac = this.mac();
    if (!mac) return;
    const out = new Uint8Array(16 + msg.byteLength);
    out.set(unb64u(a.ch, 16), 0);
    out.set(new Uint8Array(msg), 16);
    mac.send(out);
  }

  // A new tab's first message: its relay token, or a request to pair.
  async prove(ws, a, msg) {
    let m = null;
    if (typeof msg === 'string' && msg.length <= 256) { try { m = JSON.parse(msg); } catch {} }
    const mac = this.mac();
    if (!mac) { ws.send(JSON.stringify({ t: 'mac', up: false })); return ws.close(4408, 'mac offline'); }
    const ma = mac.deserializeAttachment();
    if (m?.t === 'hello') {
      const rt = unb64u(m.rt, 32);
      // The page shows its own words for these; they're hints, never a reason to forget keys.
      if (!rt || !registered(ma.hashes, await tokenHash(rt))) { ws.send(JSON.stringify({ t: 'refused', why: 'unpaired' })); return ws.close(4403, 'not paired'); }
      const ok = this.tabs('ok');
      if (ok.length >= MAX_BROWSERS || ok.filter(w => w.deserializeAttachment().ip === a.ip).length >= MAX_TABS_PER_IP) return ws.close(4429, 'too many tabs');
      Object.assign(a, { st: 'ok', h: await tokenHash(rt), heard: Date.now() });
    } else if (m?.t === 'pair') {
      // One answer for a wrong ticket and for no open link, so asking reveals nothing.
      const ticket = unb64u(m.ticket, 32);
      if (!ticket || !registered(ma.tickets, await tokenHash(ticket))) { ws.send(JSON.stringify({ t: 'refused', why: 'no-pairing' })); return ws.close(4403, 'no pairing'); }
      if (this.tabs('pairing').length >= MAX_PAIRING) return ws.close(4429, 'too many pairing at once');
      Object.assign(a, { st: 'pairing', pairAt: Date.now(), heard: Date.now() });
      this.later(ws, PAIR_TIME, x => x.st === 'pairing', 4403, 'pairing took too long');
    } else return ws.close(4403, 'prove pairing first');
    ws.serializeAttachment(a);
    ws.send(JSON.stringify({ t: 'mac', up: true }));
    mac.send(JSON.stringify({ t: 'open', ch: a.ch }));
  }

  async fromMac(ws, a, msg) {
    if (!a.authed) {
      if (typeof msg !== 'string' || msg.length > 1024) return ws.close(4401, 'authenticate first');
      let m;
      try { m = JSON.parse(msg); } catch { return ws.close(4401, 'authenticate first'); }
      const pub = unb64u(m?.pub, 32), sig = unb64u(m?.sig, 64);
      if (m?.t !== 'auth' || !pub || !sig || await machineId(pub) !== a.mid) return ws.close(4401, 'wrong key for this machine id');
      let ok = false;
      try {
        const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
        ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, tx('dibs-relay-auth-v1', a.mid, unb64u(a.n, 32), a.host));
      } catch {}
      if (!ok) return ws.close(4401, 'signature failed');
      // The newest authenticated connection wins: a Mac that reconnects replaces its old socket.
      const old = this.mac(ws);
      a.authed = true;
      if (old) { const oa = old.deserializeAttachment(); a.hashes = oa.hashes; a.tickets = oa.tickets; }
      ws.serializeAttachment(a);
      if (old) old.close(4409, 'replaced by a newer connection');
      ws.send(JSON.stringify({ t: 'ok' }));
      // Sessions with the old connection are gone with it: tabs start over and prove themselves again.
      for (const b of this.ctx.getWebSockets('b')) if (b.deserializeAttachment()?.st !== 'new') b.close(4409, 'the Mac reconnected');
      return;
    }
    if (typeof msg === 'string') {
      if (msg.length > MAX_FROM_MAC) return ws.close(1009, 'too big');
      let m;
      try { m = JSON.parse(msg); } catch { return; }
      // An MCP answer may be big (the board); everything else the Mac says is short.
      if (m?.t === 'http-res') {
        const done = typeof m.id === 'string' && this.waiting?.get(m.id);
        if (done && Number.isInteger(m.status) && m.status >= 100 && m.status < 600 && typeof m.body === 'string') done({ status: m.status, headers: m.headers || {}, body: m.body });
        return;
      }
      if (msg.length > 4096) return ws.close(1009, 'too big');
      // An account this Mac holds the key of: browsers waiting for it, and its sealed answer to one.
      if ((m?.t === 'acct-pending' || m?.t === 'acct-answer') && typeof m.aid === 'string' && typeof m.secret === 'string') {
        const r = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('accounts')).fetch(`https://accounts.internal/${m.t === 'acct-pending' ? 'pending' : 'answer'}`, {
          method: 'POST', body: JSON.stringify({ aid: m.aid, secret: m.secret, id: m.id, step: m.step }),
        });
        ws.send(JSON.stringify({ t: `${m.t}-res`, ref: typeof m.ref === 'string' ? m.ref.slice(0, 32) : null, status: r.status, ...(await r.json()) }));
        return;
      }
      if (m?.t === 'kick' && typeof m.ch === 'string') for (const b of this.ctx.getWebSockets(`ch:${m.ch}`)) b.close(4400, 'closed by the Mac');
      const hashList = x => Array.isArray(x) && x.every(y => typeof y === 'string' && unb64u(y, 16));
      if (m?.t === 'tokens' && hashList(m.h) && m.h.length <= MAX_HASHES && hashList(m.p) && m.p.length <= MAX_TICKETS) {
        a.hashes = m.h;
        a.tickets = m.p;
        ws.serializeAttachment(a);
        // A revoked device's tabs go now.
        for (const b of this.tabs('ok')) if (!registered(a.hashes, b.deserializeAttachment().h)) b.close(4403, 'not paired');
        // Live sign-in codes for https://mcp.dibs.cc, by hash, to the code index; an empty list clears this machine's.
        const codes = Array.isArray(m.c) ? m.c.filter(x => typeof x?.h === 'string' && unb64u(x.h, 32) && Number.isFinite(x.exp)).slice(0, MAX_CODES) : [];
        const key = JSON.stringify(codes);
        if (key !== this.sentCodes) {
          this.sentCodes = key;
          await this.env.INDEX.get(this.env.INDEX.idFromName('index')).fetch('https://index.internal/set', { method: 'POST', body: JSON.stringify({ mid: a.mid, codes }) });
        }
      }
      // A tab that just paired becomes a paired tab: the Mac saw its pairing succeed and registered its token.
      if (m?.t === 'admit' && typeof m.ch === 'string' && typeof m.h === 'string' && registered(a.hashes, m.h)) {
        for (const b of this.ctx.getWebSockets(`ch:${m.ch}`)) {
          const ba = b.deserializeAttachment();
          if (ba?.st === 'pairing') { Object.assign(ba, { st: 'ok', h: m.h }); b.serializeAttachment(ba); }
        }
      }
      return;
    }
    if (msg.byteLength > MAX_FROM_MAC || msg.byteLength < 17) return ws.close(1009, 'bad frame size');
    if (!this.spend(a, MAC_RATE)) return ws.close(1008, 'too many frames');
    ws.serializeAttachment(a);
    const ch = b64u(new Uint8Array(msg, 0, 16));
    for (const b of this.ctx.getWebSockets(`ch:${ch}`)) if (b.deserializeAttachment()?.st !== 'new') b.send(msg.slice(16));
  }

  async webSocketClose(ws) { this.closed(ws); }
  async webSocketError(ws) { this.closed(ws); }

  closed(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    if (a.role === 'b') {
      const mac = this.mac();
      if (mac && a.st !== 'new') { try { mac.send(JSON.stringify({ t: 'gone', ch: a.ch })); } catch {} }
    } else if (a.authed && !this.mac(ws)) {
      // With the Mac gone no tab can do anything: each hears so, and every one is closed after
      // the grace, whatever it sends meanwhile.
      for (const b of this.ctx.getWebSockets('b')) {
        try { b.send(JSON.stringify({ t: 'mac', up: false })); } catch {}
        setTimeout(() => { try { if (!this.mac()) b.close(4408, 'mac offline'); } catch {} }, OFFLINE_GRACE);
      }
    }
  }

  async alarm() {
    const t = Date.now();
    const mac = this.mac();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a) { ws.close(1011, 'lost state'); continue; }
      if (a.role === 'm' && !a.authed && t - a.at > AUTH_TIME) ws.close(4401, 'authenticate first');
      if (a.role === 'm' && a.authed) {
        const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || a.at;
        if (t - Math.max(pinged, a.last) > MAC_IDLE) ws.close(4408, 'no ping');
      }
      if (a.role === 'b') {
        if (a.st === 'new' && t - a.at > PROVE_TIME) ws.close(4403, 'prove pairing first');
        else if (a.st === 'pairing' && t - a.pairAt > PAIR_TIME) ws.close(4403, 'pairing took too long');
        else if (!mac) ws.close(4408, 'mac offline');
        // Pings alone don't keep a tab: a page that stopped calling lets go of its slot.
        else if (t - a.heard > BROWSER_IDLE) ws.close(4408, 'idle');
      }
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(t + SWEEP_EVERY);
  }
}

// The code index: one object for everyone, mapping the hash of a live sign-in code to the
// machine id it belongs to, so https://mcp.dibs.cc/authorize can send the code to that Mac.
// The bookkeeping (what's stored, for how long, the lookup limits) is codebook.js.
export class CodeIndex extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.book = new CodeBook(ctx.storage, { perIp: Number(env.LOOKUPS_PER_IP) || undefined, global: Number(env.LOOKUPS_GLOBAL) || undefined });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const j = await req.json();
    if (url.pathname === '/set') {
      const next = await this.book.set(j.mid, j.codes);
      if (next === null) return new Response('bad', { status: 400 });
      if (next && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(next);
      return new Response('ok');
    }
    if (url.pathname === '/find') return Response.json(await this.book.find(j.h, j.ip));
    if (url.pathname === '/drop') { await this.book.drop(j.h, j.mid); return new Response('ok'); }
    return new Response('not here', { status: 404 });
  }

  async alarm() {
    const next = await this.book.sweep();
    if (next) await this.ctx.storage.setAlarm(next);
  }
}
