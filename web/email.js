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
  let token = null, widget = null, sending = false, wanted = false;
  // The relay's settings, asked for at once beside Turnstile's script rather than after it.
  const config = root.fetch('/email/config').then(r => r.json()).catch(() => ({}));
  // How long a check may take after the click before the page says something more.
  const SLOW = 12e3;
  let slow = 0;

  // The button always works: clicked before Turnstile has a token, the click waits for it and
  // says so. It's still the person's click that sends, never the page by itself.
  async function send() {
    if (sending) return;
    wanted = true;
    if (!token) {
      say('Checking you’re a person…', 'busy');
      clearTimeout(slow);
      slow = setTimeout(() => { if (!token) say('The check that you’re a person is taking a while. If nothing changes, reload the page.', 'busy'); }, SLOW);
      return;
    }
    const page = (await config).page;
    if (!page) return say('Email sign-in isn’t set up here. Sign in with a passkey instead.', 'error');
    sending = true;
    $('send').disabled = true;
    say('Sending your code…', 'busy');
    try {
      const r = await root.fetch('/email/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, token }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `the relay answered ${r.status}`);
      root.location.replace(`${page}/account#code=${j.rid}&to=${encodeURIComponent($('email').value)}&exp=${j.expires}`);
    } catch (x) {
      say(x.message, 'error');
      // A token works once: another try needs a new check.
      token = null;
      wanted = false;
      sending = false;
      $('send').disabled = false;
      root.turnstile.reset(widget);
    }
  }

  // Turnstile's script calls this once it loads (async, render=explicit). The widget is
  // invisible: it runs at once, in the background, and only the send waits on its token.
  root.dibsHuman = async () => {
    const c = await config;
    if (!c.sitekey) return say('Email sign-in isn’t set up here. Sign in with a passkey instead.', 'error');
    widget = root.turnstile.render('#human', {
      sitekey: c.sitekey, action: 'account-link',
      callback: t => { token = t; clearTimeout(slow); if (wanted) send(); },
      'expired-callback': () => { token = null; },
      'error-callback': () => { clearTimeout(slow); say('The check that you’re a person didn’t work in this browser. Reload the page, or sign in with a passkey.', 'error'); },
    });
  };
  if (given) $('lede').textContent = `We'll email a 6-digit code to ${given}.`;
  $('email-form').addEventListener('submit', e => { e.preventDefault(); send(); });
  $('send').focus();
})(globalThis);
