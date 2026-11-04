'use strict';
// The person check (web/human.html at human.dibs.cc), framed out of sight by the account page on
// app.dibs.cc: Cloudflare Turnstile's script runs on this origin of its own, never beside the
// account key or the MCP sign-in.
// The widget is invisible and starts at once; its token goes to the account page by postMessage,
// to that origin only. It sends nothing itself: the account page sends the token with the address
// only when the person clicks Send code. The page asks for a fresh check with { dibs: 'again' }.
(function (root) {
  const config = root.fetch('/config').then(r => r.json()).catch(() => ({}));
  let widget = null;
  const tell = async msg => { const c = await config; if (c.page) root.parent.postMessage({ dibs: 'human', ...msg }, c.page); };
  root.dibsHuman = async () => {
    const c = await config;
    if (!c.sitekey) return tell({ error: 'no-sitekey' });
    widget = root.turnstile.render('#human', {
      sitekey: c.sitekey, action: 'account-link',
      callback: token => tell({ token }),
      'expired-callback': () => tell({ expired: true }),
      'error-callback': code => tell({ error: String(code || 'failed') }),
    });
  };
  root.addEventListener('message', async e => {
    const c = await config;
    if (e.origin !== c.page || e.data?.dibs !== 'again' || widget == null) return;
    root.turnstile.reset(widget);
  });
})(globalThis);
