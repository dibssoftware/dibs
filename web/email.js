'use strict';
// Asking for a sign-in link (web/email.html, served at mcp.dibs.cc/email). Turnstile's widget
// gives a token; the relay checks it with Cloudflare before it sends anything. The address
// can come in the fragment from the account page (#e=<address>), which never reaches a server.
(function (root) {
  const $ = id => root.document.getElementById(id);
  const say = (text, cls = '') => { const p = $('status'); p.textContent = text; p.className = `status ${cls}`; };
  const m = /^#e=(.+)$/.exec(root.location.hash);
  if (root.location.hash) root.history.replaceState(null, '', root.location.pathname);
  if (m) { try { $('email').value = decodeURIComponent(m[1]); } catch {} }
  let token = null, widget = null;

  root.dibsHuman = async () => {
    let c = {};
    try { c = await (await root.fetch('/email/config')).json(); } catch {}
    if (!c.sitekey) return say('Sign-in links aren\'t set up here. Sign in with a passkey instead.', 'error');
    if (c.page) $('back').href = `${c.page}/account`;
    widget = root.turnstile.render('#human', {
      sitekey: c.sitekey, action: 'account-link',
      callback: t => { token = t; $('send').disabled = false; },
      'expired-callback': () => { token = null; $('send').disabled = true; },
      'error-callback': () => say('The check that you\'re a person couldn\'t load. Reload the page.', 'error'),
    });
  };

  $('email-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!token) return;
    $('send').disabled = true;
    try {
      const r = await root.fetch('/email/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `the relay answered ${r.status}`);
      say('If that address can sign in, a link is on its way to it. Open it on the device you want to sign in on.');
    } catch (x) { say(x.message, 'error'); }
    // A token works once: a second link needs a new check.
    token = null;
    root.turnstile.reset(widget);
  });
})(globalThis);
