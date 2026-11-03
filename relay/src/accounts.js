// dibs accounts on app.dibs.cc: the routes under /account/, and the Durable Object that keeps
// them (one for everyone, SQLite-backed). The bookkeeping is accountbook.js; this file is HTTP,
// email and the Mac's side of approvals. Nothing here can read a keyring: browsers seal it with
// the account key before it arrives, and open it after it leaves.
import { DurableObject } from 'cloudflare:workers';
import { AccountBook } from './accountbook.js';

const MAX_BODY = 80 * 1024;
// How often the alarm sweeps when there's nothing left over from the last batch, and how soon
// when there is.
const SWEEP_EVERY = 10 * 60e3, SWEEP_AGAIN = 1000;
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers } });
const bearer = req => /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '')?.[1] || null;

// The sign-in link: the token rides in the fragment, which browsers never send to a server, so
// it doesn't land in any log or referrer on the way back.
function linkMail(origin, token) {
  const url = `${origin}/account#signin=${token}`;
  return {
    subject: 'Sign in to dibs',
    text: `Open this link to sign in to dibs:\n\n${url}\n\nIt works once, for the next 15 minutes. If you didn't ask for it, ignore this email: nobody can sign in without the link.\n`,
  };
}

// The page's account routes. Every POST must come from the page itself. human: the request
// passed Turnstile (index.js emailPage), which a sign-in link needs wherever a site key is set.
export async function accountRoute(req, env, url, { human = false, origin = url.origin } = {}) {
  if (req.method !== 'GET' && req.headers.get('Origin') !== url.origin) return json(403, { error: 'cross-site request refused' });
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json(413, { error: 'too big' });
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  if (env.RLA) {
    const { success } = await env.RLA.limit({ key: `acct:${ip}` });
    if (!success) return json(429, { error: 'Too many requests from here. Try again in a minute.' });
  }
  const body = req.method === 'GET' ? null : await req.text();
  if (body && body.length > MAX_BODY) return json(413, { error: 'too big' });
  const r = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts')).fetch('https://accounts.internal/route', {
    method: 'POST', body: JSON.stringify({ method: req.method, path: url.pathname, body, session: bearer(req), ip, origin, human }),
  });
  return json(r.status, await r.json());
}

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const rpId = env.PAGE_HOST || 'localhost';
    this.book = new AccountBook(ctx.storage, { secret: env.ACCOUNT_SECRET, rpId, origin: null });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const j = await req.json();
    try {
      if (url.pathname === '/route') return json(200, await this.route(j));
      // From a Machine object, for a Mac that showed it holds the account key.
      if (url.pathname === '/pending') return json(200, { pending: await this.book.pending(j.aid, j.secret) });
      if (url.pathname === '/answer') return json(200, await this.book.answer(j.aid, j.secret, j.id, j.step));
      return json(404, { error: 'not here' });
    } catch (e) {
      if (e.status) return json(e.status, { error: e.message });
      if (e.webauthn) return json(400, { error: e.message });
      throw e;
    } finally {
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY);
    }
  }

  async route({ method, path, body, session, ip, origin, human }) {
    if (!this.env.ACCOUNT_SECRET) throw Object.assign(new Error('accounts are not set up on this relay'), { status: 503 });
    // The relying party is the page's own host: passkeys made here only ever work here.
    this.book.rp = { rpId: new URL(origin).hostname, origin };
    let b = {};
    if (body) { try { b = JSON.parse(body); } catch { throw Object.assign(new Error('not JSON'), { status: 400 }); } }
    const book = this.book;
    const emailPage = this.env.TURNSTILE_SITEKEY && this.env.MCP_HOST ? `https://${this.env.MCP_HOST}/email` : null;
    if (method === 'GET' && path === '/account/config') return { emailPage };
    if (method === 'POST' && path === '/account/link') {
      if (this.env.TURNSTILE_SITEKEY && !human) throw Object.assign(new Error(`Ask for a sign-in link at ${emailPage}`), { status: 403 });
      const token = await book.requestLink(b.email, ip);
      const mail = linkMail(origin, token);
      if (!this.env.EMAIL) throw Object.assign(new Error('email is not set up on this relay'), { status: 503 });
      await this.env.EMAIL.send({ to: String(b.email).trim(), from: { email: this.env.MAIL_FROM || 'no-reply@mail.dibs.cc', name: 'dibs' }, subject: mail.subject, text: mail.text });
      return { sent: true };
    }
    if (method === 'POST' && path === '/account/link/redeem') return book.redeemLink(b.token, ip);
    if (method === 'POST' && path === '/account/passkey/begin') return book.passkeyBegin(session, b.proof);
    if (method === 'POST' && path === '/account/passkey/finish') return book.passkeyFinish(session, b.proof, b.challenge, b.response, b.label);
    if (method === 'POST' && path === '/account/passkey/remove') return book.removePasskey(session, b.proof, b.id);
    if (method === 'POST' && path === '/account/sessions/end') return book.endSessions(session, b.proof);
    if (method === 'POST' && path === '/account/signin/begin') return book.signInBegin();
    if (method === 'POST' && path === '/account/signin/finish') return book.signInFinish(b.challenge, b.id, b.response, ip);
    if (method === 'GET' && path === '/account/keyring') return book.keyring(session);
    if (method === 'POST' && path === '/account/keyring') return book.putKeyring(session, b);
    if (method === 'POST' && path === '/account/members') return book.addMember(session, b.proof, b.member, b.mid);
    if (method === 'POST' && path === '/account/approval') return book.askApproval(session, b.commit, b.label);
    if (method === 'POST' && path === '/account/approval/reveal') return book.reveal(session, b.id, b.pub, b.nonce);
    if (method === 'POST' && path === '/account/approval/poll') return book.poll(session, b.id);
    if (method === 'POST' && path === '/account/signout') { await book.signOut(session); return { ok: true }; }
    throw Object.assign(new Error('not here'), { status: 404 });
  }

  async alarm() {
    const more = await this.book.sweep();
    await this.ctx.storage.setAlarm(Date.now() + (more ? SWEEP_AGAIN : SWEEP_EVERY));
  }
}
