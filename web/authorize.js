'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  const form = document.getElementById('authorize-form');
  const err = document.getElementById('error');
  const id = q.get('client_id');

  // The name is whatever the client registered itself as, so the page says so, and
  // shows exactly where the sign-in goes: that address is what a fake would give away.
  fetch(`oauth/client?client_id=${encodeURIComponent(id || '')}`).then(r => (r.ok ? r.json() : null)).then(c => {
    if (c) document.getElementById('client').textContent = `"${c.name}"`;
    else err.textContent = 'This client is not registered with dibs. Remove it and add it again.';
  });
  // Where the token goes is the one fact a fake can't hide, so it comes first and largest; the
  // name is whatever the client registered itself as.
  const back = q.get('redirect_uri') || '';
  let host = '(nowhere)';
  try { host = new URL(back).host || host; } catch {}
  document.getElementById('dest-host').textContent = host;
  document.getElementById('dest').textContent = `Full address: ${back || '(none)'}`;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Checking';
    const pick = k => q.get(k);
    try {
      const r = await fetch('oauth/authorize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: form.code.value, client_id: id, redirect_uri: pick('redirect_uri'), response_type: pick('response_type'),
          code_challenge: pick('code_challenge'), code_challenge_method: pick('code_challenge_method'), state: pick('state') }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'That did not work.');
      btn.textContent = 'Connected';
      location.assign(j.redirect);
    } catch (x) {
      err.textContent = x.message;
      btn.disabled = false;
      btn.textContent = 'Connect';
      form.code.select();
    }
  });
})();
