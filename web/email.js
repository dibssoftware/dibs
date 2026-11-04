'use strict';
// The person check before a sign-in code is sent (web/email.html, served at mcp.dibs.cc/email).
// The account page sends the address here in the fragment (#e=<address>), which never reaches a
// server. The person clicks Send code once Turnstile is happy: never sent by itself, or any site
// could open this page for its visitors and spend their checks mailing codes to addresses it
// picks (relayreview, 2026-11-03). The relay checks the token with Cloudflare and sends the code,
// and this page goes back to the account page with the request's id (#code=<id>) for the code
// to be typed there.
(function (root) {
  const $ = id => root.document.getElementById(id);
  const say = (text, cls = '') => { const p = $('status'); p.textContent = text; p.className = `status ${cls}`; };
  const m = /^#e=(.+)$/.exec(root.location.hash);
  if (root.location.hash) root.history.replaceState(null, '', root.location.pathname);
  let given = '';
  if (m) { try { given = decodeURIComponent(m[1]); } catch {} }
  $('email').value = given;
  let token = null, widget = null, page = null, sending = false;

  async function send() {
    if (!token || sending) return;
    sending = true;
    $('send').disabled = true;
    say('Sending your code…');
    try {
      const r = await root.fetch('/email/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `the relay answered ${r.status}`);
      root.location.replace(`${page}/account#code=${j.rid}&to=${encodeURIComponent($('email').value)}&exp=${j.expires}`);
    } catch (x) {
      say(x.message, 'error');
      // A token works once: another try needs a new check.
      token = null;
      sending = false;
      root.turnstile.reset(widget);
    }
  }

  root.dibsHuman = async () => {
    let c = {};
    try { c = await (await root.fetch('/email/config')).json(); } catch {}
    if (!c.sitekey || !c.page) return say('Email sign-in isn\'t set up here. Sign in with a passkey instead.', 'error');
    page = c.page;
    if (given) $('lede').textContent = `A quick check that you're a person, then send a 6-digit code to ${given}.`;
    widget = root.turnstile.render('#human', {
      sitekey: c.sitekey, action: 'account-link',
      callback: t => { token = t; $('send').disabled = false; say(''); $('send').focus(); },
      'expired-callback': () => { token = null; $('send').disabled = true; },
      'error-callback': () => say('The check that you\'re a person couldn\'t load. Reload the page.', 'error'),
    });
  };

  $('email-form').addEventListener('submit', e => { e.preventDefault(); send(); });
})(globalThis);
