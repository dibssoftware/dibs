'use strict';
// A dibs account in the browser: signing in (an email link or a passkey), the account key that
// opens the keyring, the keyring itself (sealed here, stored sealed by the relay), adding a Mac
// to the account, and getting the account key from a Mac for a new browser. WebCrypto only.
// docs/relay.md says what the relay holds; nothing here sends it a key or a keyring in the clear.
//
// The page is /account (web/account.html). Loaded after transport.js, whose protocol it reuses.
(function (root) {
  const subtle = root.crypto.subtle;
  const T = root.dibsTransport?._internals;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const { b64u, unb64u, tx } = T || {};
  const random = n => root.crypto.getRandomValues(new Uint8Array(n));
  const sha = async b => new Uint8Array(await subtle.digest('SHA-256', b));
  const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const fail = (code, msg) => Object.assign(new Error(msg), { code });
  const hkdfKey = ikm => subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const hk = (salt, info) => ({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) });
  // How long a browser waits for a Mac to approve it: the relay keeps the request 10 minutes.
  const APPROVAL_WAIT = 10 * 60e3;
  const POLL = 2000;

  // The keyring: sealed with the account key (AES-256-GCM), as base64url of iv then ciphertext.
  async function aesKey(ak) { return subtle.importKey('raw', ak, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async function sealRing(ak, ring) {
    const iv = random(12);
    const c = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('dibs-keyring-v1') }, await aesKey(ak), enc.encode(JSON.stringify(ring))));
    return b64u(cat(iv, c));
  }
  async function openRing(ak, blob) {
    const b = unb64u(blob);
    if (!b || b.length < 29) throw fail('keyring', 'the keyring is damaged');
    try {
      const p = await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode('dibs-keyring-v1') }, await aesKey(ak), b.subarray(12));
      return JSON.parse(dec.decode(p));
    } catch { throw fail('keyring', 'this account key doesn\'t open the keyring'); }
  }
  // A new keyring: one device key for the whole account, the one each of its Macs trusts.
  async function newRing() {
    const kp = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return { v: 1, device: { pkcs8: b64u(await subtle.exportKey('pkcs8', kp.privateKey)), pub: b64u(await subtle.exportKey('raw', kp.publicKey)) }, machines: [] };
  }
  // The account's device key as WebCrypto keys this page can sign with but not read back.
  async function deviceKeys(ring) {
    const privateKey = await subtle.importKey('pkcs8', unb64u(ring.device.pkcs8), { name: 'Ed25519' }, false, ['sign']);
    const publicKey = await subtle.importKey('raw', unb64u(ring.device.pub), { name: 'Ed25519' }, true, ['verify']);
    return { privateKey, publicKey };
  }

  // The account key wrapped under a passkey's PRF output, so signing in with that passkey anywhere
  // opens everything. The relay stores the wrapped key and never sees the PRF output.
  const PRF_SALT = enc.encode('dibs-prf-salt-v1');
  async function prfKey(prf) { return subtle.deriveKey(hk(new Uint8Array(0), 'dibs-prf-wrap-v1'), await hkdfKey(prf), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  async function wrapAk(prf, ak) {
    const iv = random(12);
    return b64u(cat(iv, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('dibs-ak-v1') }, await prfKey(prf), ak))));
  }
  async function unwrapAk(prf, w) {
    const b = unb64u(w);
    try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode('dibs-ak-v1') }, await prfKey(prf), b.subarray(12))); }
    catch { throw fail('prf', 'this passkey doesn\'t open the account key'); }
  }

  // Getting the account key from a Mac, the browser's half (the Mac's is src/relay.mjs
  // approvalStep). Commit to an ephemeral key, see the Mac's, reveal, then both show a code.
  async function approvalStart() {
    const eph = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const B = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
    const n = random(32);
    const commit = b64u(await sha(cat(enc.encode('dibs-approve-commit-v1\0'), B, n)));
    return { eph, B, n, commit };
  }
  async function approvalKeys(eph, aid, id, B, M) {
    const peer = await subtle.importKey('raw', M, { name: 'X25519' }, false, []);
    const ss = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: peer }, eph.privateKey, 256));
    if (ss.every(x => x === 0)) throw fail('impostor', 'the Mac\'s key is unusable');
    const salt = await sha(tx('dibs-approve-v1', aid, id, B, M));
    const ikm = await hkdfKey(ss);
    const key = await subtle.deriveKey(hk(salt, 'dibs-approve-v1 key'), ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const six = async info => String(new DataView((await subtle.deriveBits(hk(salt, info), ikm, 32)).slice(0)).getUint32(0) % 1e6).padStart(6, '0');
    return { key, sas: await six('dibs-approve-v1 sas'), confirm: await six('dibs-approve-v1 confirm') };
  }
  async function openSealed(key, aid, id, sealed) {
    const b = unb64u(sealed);
    try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: enc.encode(`dibs-approve-v1 ${aid}.${id}`) }, key, b.subarray(12))); }
    catch { throw fail('impostor', 'the key the Mac sent doesn\'t open: something in between changed it'); }
  }
  // The sealed key opens only with the code the Mac printed when the person approved: whoever
  // sealed it without that Mac (the relay, say) knows this browser's code but not what the
  // Mac showed the person, so nobody's key gets in without their typing it.
  async function acceptSealed(keys, aid, id, sealed, typed) {
    if (String(typed || '').replace(/\D/g, '') !== keys.confirm) throw fail('confirm', 'That isn\'t the code your Mac printed after dibs connect --approve. Check it and type it again.');
    return openSealed(keys.key, aid, id, sealed);
  }

  // What proves to the relay that this browser holds the account key, for every change to the
  // account. The relay keeps only its hash.
  async function authProof(ak) {
    return b64u(new Uint8Array(await subtle.deriveBits(hk(new Uint8Array(0), 'dibs-account-auth'), await hkdfKey(ak), 256)));
  }

  // A sign-in (email link or passkey) arriving in a browser that may already hold an account:
  // 'keep' the same account's key, 'ask' before switching to another account, or start 'fresh'.
  function afterSignin(old, res) {
    if (!old?.session) return 'fresh';
    return old.aid === res.aid ? 'keep' : 'ask';
  }

  const internals = { sealRing, openRing, newRing, deviceKeys, wrapAk, unwrapAk, approvalStart, approvalKeys, openSealed, acceptSealed, authProof, afterSignin, PRF_SALT };

  // ---- The page: only on /account, and only in a browser. ----
  if (!root.document || !root.document.getElementById('account')) { root.dibsAccount = { _internals: internals }; return; }
  const $ = id => root.document.getElementById(id);
  const el = (tag, text, cls) => { const e = root.document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const api = async (method, path, body, session, extra = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(session && { Authorization: `Bearer ${session}` }) };
    for (const [k, v] of Object.entries(extra)) if (v) headers[k] = v;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(fail(r.status, j?.error || `the relay answered ${r.status}`), { left: j?.left, expired: !!j?.expired });
    return j;
  };

  // This browser's account: the session, and the account key once it has it. In IndexedDB, which
  // belongs to this origin alone; the account key never goes to the relay except sealed.
  const db = new Promise((resolve, reject) => {
    const r = root.indexedDB.open('dibs-account', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('me');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const idb = (mode, fn) => db.then(d => new Promise((resolve, reject) => { const t = d.transaction('me', mode), q = fn(t.objectStore('me')); t.oncomplete = () => resolve(q.result); t.onerror = () => reject(t.error); }));
  const store = key => ({ get: () => idb('readonly', s => s.get(key)), put: v => idb('readwrite', s => s.put(v, key)), clear: () => idb('readwrite', s => s.delete(key)) });
  const me = store('me');
  // A code on its way: { rid, to, exp }, so a reload (or another tab) still shows where to type it.
  const pending = store('pending');
  // This browser signed in with or added a passkey before: the passkey goes first next time.
  const hint = store('hint');
  const macs = T.idbStore();

  const say = (text, cls = '') => { const p = $('status'); p.textContent = text; p.className = `status ${cls}`; };
  const show = id => { for (const s of root.document.querySelectorAll('[data-view]')) s.hidden = s.dataset.view !== id; };

  // Fragments, taken out of the address bar at once: #signin=<token> from the email, #code=<id>
  // from the person check on mcp.dibs.cc (the code to type is in the email), and
  // #join=<machine>.<secret>.<fingerprint> from dibs connect --account. Read on load and on every
  // change after: a link pasted into a tab already on this page changes only the fragment, and a
  // page brought back from the back-forward cache runs no script again.
  // The emailed link carries its token in the fragment (#signin=); ?signin= is taken too, for a
  // mail wrapper that drops fragments, and loading it spends nothing: it's redeemed from here.
  function takeFragment() {
    const frag = root.location.hash, query = root.location.search;
    if (!frag && !query) return null;
    root.history.replaceState(null, '', root.location.pathname);
    const signin = /^\?signin=([A-Za-z0-9_-]{43})$/.exec(query)?.[1] || /^#signin=([A-Za-z0-9_-]{43})$/.exec(frag)?.[1];
    if (signin) return { signin };
    const code = /^#code=([A-Za-z0-9_-]{22})&to=([^&]*)&exp=(\d+)$/.exec(frag);
    if (code) { let to = ''; try { to = decodeURIComponent(code[2]); } catch {} return { code: { rid: code[1], to, exp: Number(code[3]) } }; }
    if (/^#join=/.test(frag)) return { join: T.parseLink(`#p=${frag.slice(6)}`) };
    return null;
  }

  async function loadRing(m) {
    // The proof rides along for a recovery session (an account that requires a passkey, signed in
    // by email), which reads the keyring only once a Mac gave it the key.
    const k = await api('GET', '/account/keyring', null, m.session, { 'X-Dibs-Proof': await proofOf(m) });
    return { ring: k.keyring ? await openRing(unb64u(m.ak), k.keyring) : null, version: k.version, passkeys: k.passkeys, passkeyOnly: k.passkeyOnly };
  }
  const proofOf = m => (m.ak ? authProof(unb64u(m.ak)) : null);
  async function saveRing(m, ring, version, wrapped) {
    return api('POST', '/account/keyring', { keyring: await sealRing(unb64u(m.ak), ring), version, proof: await proofOf(m), ...(wrapped && { wrapped }) }, m.session);
  }
  // Every Mac in the keyring, put where transport.js looks, under the account's device key.
  async function install(ring) {
    const keys = await deviceKeys(ring);
    for (const x of ring.machines) await macs.put({ mid: x.mid, m: x.m, fp: x.fp, did: x.did, keys, rt: x.rt, name: x.name || 'a Mac', paired: x.added || Date.now(), account: true });
  }

  async function render() {
    const m = await me.get();
    if (!m?.session) {
      const p = await pending.get();
      if (p && p.exp > Date.now()) return showCode(p);
      return signedOut();
    }
    if (!m.ak) {
      $('need-key-lede').textContent = m.recovery
        ? 'This account signs in with a passkey. Without yours, one of your Macs can let this browser in: ask here, then run the command this page shows on that Mac.'
        : 'You\'re signed in, but this browser doesn\'t have your account\'s key yet. One of your Macs can give it: ask here, then run the command this page shows on that Mac.';
      show('need-key');
      // A request this browser made before a reload: carry on with it.
      if (m.asking && Date.now() - m.asking.t0 < APPROVAL_WAIT) askMac(m);
      return;
    }
    let r;
    try { r = await loadRing(m); } catch (e) {
      if (e.code === 401) { await me.clear(); return render(); }
      return say(e.message, 'error');
    }
    if (!r.ring) { r = { ...r, ring: await newRing() }; await saveRing(m, r.ring, r.version); r.version++; }
    await install(r.ring);
    show('signed-in');
    const list = $('machines');
    list.replaceChildren(...(r.ring.machines.length ? r.ring.machines.map(x => {
      const li = el('li');
      const a = el('a', x.name || x.mid.slice(0, 8));
      a.href = `/?m=${encodeURIComponent(x.mid)}`;
      li.append(a, el('span', ` fingerprint ${x.fp.slice(0, 12)}...`, 'sub'));
      return li;
    }) : [el('li', 'No Macs yet. On a Mac, run dibs connect --account and open its link here.', 'sub')]));
    const only = $('passkey-only');
    $('passkey-only-row').hidden = !r.passkeys.length;
    only.dataset.on = String(!!r.passkeyOnly);
    only.textContent = r.passkeyOnly ? 'Let email codes sign in again' : 'Require a passkey';
    $('passkey-only-text').textContent = r.passkeyOnly
      ? 'This account signs in with a passkey only. Lost them all? Sign in by email, then approve that browser from one of your Macs (dibs connect --approve).'
      : 'Email codes can sign in to this account. Require a passkey and email alone gets nowhere: a lost passkey is replaced by approving the browser from one of your Macs.';
    $('passkeys').replaceChildren(...r.passkeys.map(p => {
      const li = el('li', `${p.label}${p.prf ? ' (opens everything)' : ' (signs in; a Mac approves the key)'} `);
      const rm = el('button', 'Remove', 'link');
      rm.type = 'button';
      rm.addEventListener('click', async () => {
        if (!root.confirm(`Remove the passkey "${p.label}"? It won't sign in to this account any more.`)) return;
        try { await api('POST', '/account/passkey/remove', { id: p.id, proof: await proofOf(m) }, m.session); say('Passkey removed.'); }
        catch (x) { say(x.message, 'error'); }
        render();
      });
      li.append(rm);
      return li;
    }));
    return r;
  }

  // A sign-in's session lands here. The account key stays when it's the same account, and is
  // never dropped for another account without asking; a new account gets a new key.
  async function signedIn(res, ak = null) {
    const old = await me.get();
    const how = afterSignin(old, res);
    if (how === 'ask' && !root.confirm(`That sign-in is for a different dibs account than the one open here. Switch to it?${old.ak ? ' This browser forgets the other account\'s key; a passkey that holds it, or one of its Macs, can give it back.' : ''}`)) {
      try { await api('POST', '/account/signout', {}, res.session); } catch {}
      return say('Kept the account that was open here.');
    }
    if (how === 'keep') ak = ak || old.ak;
    if (how !== 'keep') for (const r of await macs.all()) if (r.account) await macs.remove(r.mid);
    await me.put({ session: res.session, aid: res.aid, ak: ak || (res.created ? b64u(random(32)) : null), ...(res.recovery && { recovery: true }) });
  }

  // Email: a 6-digit code, typed here. The person check (Turnstile) runs on mcp.dibs.cc, never
  // here (relay/src/index.js emailPage): the page goes there with the address and comes back with
  // the request's id. A relay without it (the local e2e) takes the address here.
  const emailPage = api('GET', '/account/config').then(c => c.emailPage, () => null);
  // How soon another code may be asked for from the code screen: the email takes a few seconds,
  // and every code counts toward the address's hourly limit.
  const RESEND_AFTER = 30e3;
  async function askCode(to) {
    const page = await emailPage;
    say(page ? 'Opening the email step…' : 'Sending your code…', 'busy');
    if (page) return root.location.assign(`${page}#e=${encodeURIComponent(to)}`);
    const r = await api('POST', '/account/link', { email: to });
    const p = { rid: r.rid, to, exp: r.expires, sent: Date.now() };
    await pending.put(p);
    showCode(p);
  }
  $('email-form').addEventListener('submit', async e => {
    e.preventDefault();
    const b = $('email-form').querySelector('button');
    b.disabled = true;
    try { await askCode($('email').value.trim()); } catch (x) { say(x.message, 'error'); }
    finally { b.disabled = false; }
  });

  let resendTimer = 0;
  function showCode(p) {
    abortConditional();
    show('code');
    say('');
    $('code-to').textContent = p.to ? `We sent a 6-digit code to ${p.to}. It works once, for 10 minutes.` : 'We sent a 6-digit code to your email. It works once, for 10 minutes.';
    codeState('');
    const input = $('code-input');
    input.value = '';
    input.disabled = false;
    $('code-submit').disabled = false;
    input.focus();
    clearInterval(resendTimer);
    const sent = p.sent || Date.now();
    const tick = () => {
      const left = Math.ceil((sent + RESEND_AFTER - Date.now()) / 1000);
      const b = $('code-resend');
      b.disabled = left > 0;
      b.textContent = left > 0 ? `Resend in 0:${String(left).padStart(2, '0')}` : 'Resend the code';
      if (left <= 0) clearInterval(resendTimer);
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }
  const codeState = (text, cls = '') => { const e = $('code-state'); e.textContent = text; e.className = `status ${cls}`; };
  let redeeming = false;
  async function redeem() {
    const input = $('code-input');
    const code = input.value.replace(/\D/g, '');
    if (code.length !== 6 || redeeming) return;
    const p = await pending.get();
    if (!p) return signedOut();
    redeeming = true;
    $('code-submit').disabled = true;
    codeState('Signing in…', 'busy');
    try {
      const res = await api('POST', '/account/code', { rid: p.rid, code });
      await pending.clear();
      clearInterval(resendTimer);
      await afterEmail(res);
    } catch (x) {
      if (x.expired) {
        await pending.clear();
        codeState(`${x.message}`, 'error');
        input.disabled = true;
        $('code-resend').disabled = false;
        $('code-resend').textContent = 'Send a new code';
      } else {
        codeState(x.message, 'error');
        input.value = '';
        input.focus();
      }
    } finally {
      redeeming = false;
      if (!input.disabled) $('code-submit').disabled = false;
    }
  }
  $('code-form').addEventListener('submit', e => { e.preventDefault(); redeem(); });
  // Six digits typed or pasted: no button to find on a phone.
  $('code-input').addEventListener('input', () => { if ($('code-input').value.replace(/\D/g, '').length === 6) redeem(); });
  $('code-resend').addEventListener('click', async () => {
    const p = await pending.get();
    const to = p?.to || $('email').value.trim();
    if (!to) return signedOut();
    $('code-resend').disabled = true;
    try { await askCode(to); } catch (x) { codeState(x.message, 'error'); $('code-resend').disabled = false; }
  });
  $('code-back').addEventListener('click', async () => { await pending.clear(); clearInterval(resendTimer); signedOut(); });

  // Signed in by email (code or link): a first sign-in, or an account with no passkey yet, is
  // offered one at once, and skipping takes a second click that says what it costs.
  async function afterEmail(res) {
    await signedIn(res);
    const supported = !!root.PublicKeyCredential;
    if (!res.passkeys && supported && (await me.get())?.ak) return offerPasskey();
    render();
  }
  function offerPasskey() {
    $('offer-sure').hidden = true;
    $('offer-skip').hidden = false;
    show('passkey-offer');
    say('');
    $('offer-add').focus();
  }
  $('offer-add').addEventListener('click', async () => { if (await addPasskey()) render(); });
  $('offer-skip').addEventListener('click', () => { $('offer-skip').hidden = true; $('offer-sure').hidden = false; $('offer-skip-sure').focus(); });
  $('offer-skip-sure').addEventListener('click', () => render());

  // Passkeys: navigator.credentials with the PRF extension, so the same passkey opens the account key.
  const rpId = root.location.hostname;
  const bytes = b => new Uint8Array(b);
  const prfOf = cred => { const r = cred.getClientExtensionResults?.().prf?.results?.first; return r ? bytes(r) : null; };
  // One passkey sign-in at a time: autofill's and the button's can both be on their way.
  let signingIn = false;
  async function passkeySignIn(cred, challenge) {
    if (signingIn) return;
    signingIn = true;
    try { await finishPasskey(cred, challenge); } finally { signingIn = false; }
  }
  async function finishPasskey(cred, challenge) {
    const r = cred.response;
    const res = await api('POST', '/account/signin/finish', { challenge, id: b64u(cred.rawId), response: { clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) } });
    const prf = prfOf(cred);
    // A passkey that can't open the wrapped key (a copy that kept no PRF secret) still signs
    // in: the account key then comes from a Mac, as after an email code.
    const ak = res.wrapped && prf ? await unwrapAk(prf, res.wrapped).then(b64u, () => null) : null;
    await signedIn(res, ak);
    await hint.put({ passkey: true });
    render();
  }
  const getOptions = challenge => ({ challenge: unb64u(challenge), rpId, userVerification: 'required', extensions: { prf: { eval: { first: PRF_SALT } } } });
  // Autofill: the browser offers this site's passkeys in the email field's suggestions, while the
  // page waits for an email. Only one passkey request may be open, so the button cancels it first.
  let conditional = null;
  const abortConditional = () => { conditional?.abort(); conditional = null; };
  async function offerAutofill() {
    if (conditional || !(await root.PublicKeyCredential?.isConditionalMediationAvailable?.().catch(() => false))) return;
    const ctl = new AbortController();
    conditional = ctl;
    let cred = null, challenge = null;
    try {
      ({ challenge } = await api('POST', '/account/signin/begin', {}));
      cred = await root.navigator.credentials.get({ mediation: 'conditional', signal: ctl.signal, publicKey: getOptions(challenge) });
    } catch {
      // Autofill is a quiet extra: a browser that can't do it, or a request it dropped, says nothing.
    } finally { if (conditional === ctl) conditional = null; }
    if (!cred) return;
    try { await passkeySignIn(cred, challenge); } catch (x) { say(x.message || 'That passkey didn\'t work.', 'error'); }
  }
  $('passkey-signin').addEventListener('click', async () => {
    if (signingIn) return;
    abortConditional();
    say('Waiting for your passkey…', 'busy');
    try {
      const { challenge } = await api('POST', '/account/signin/begin', {});
      const cred = await root.navigator.credentials.get({ publicKey: getOptions(challenge) });
      say('Signing in…', 'busy');
      await passkeySignIn(cred, challenge);
    } catch (x) { say(x.name === 'NotAllowedError' ? 'No passkey was used.' : x.message || 'That passkey didn\'t work.', 'error'); offerAutofill(); }
  });

  // Signed out: a browser that used a passkey here before leads with it; one that never did leads
  // with email, the passkey a quieter second way in.
  async function signedOut() {
    const h = await hint.get().catch(() => null);
    $('account').classList.toggle('passkey-first', !!h?.passkey);
    show('signed-out');
    if (!h?.passkey) $('email').focus();
    offerAutofill();
  }

  // Returns whether one was added.
  async function addPasskey() {
    const m = await me.get();
    try {
      const proof = await proofOf(m);
      const b = await api('POST', '/account/passkey/begin', { proof }, m.session);
      const cred = await root.navigator.credentials.create({ publicKey: {
        challenge: unb64u(b.challenge), rp: { id: rpId, name: 'dibs' }, user: { id: enc.encode(b.user), name: 'dibs account', displayName: 'dibs account' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }], attestation: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: b.exclude.map(id => ({ type: 'public-key', id: unb64u(id) })),
        extensions: { prf: { eval: { first: PRF_SALT } } } } });
      const r = cred.response;
      const { id } = await api('POST', '/account/passkey/finish', { proof, challenge: b.challenge, label: T.deviceName(), response: { clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject) } }, m.session);
      // Some browsers give the PRF output only when the passkey is used, not when it's made.
      let prf = prfOf(cred);
      if (!prf) {
        const { challenge } = await api('POST', '/account/signin/begin', {});
        const g = await root.navigator.credentials.get({ publicKey: { challenge: unb64u(challenge), rpId, userVerification: 'required', allowCredentials: [{ type: 'public-key', id: unb64u(id) }], extensions: { prf: { eval: { first: PRF_SALT } } } } });
        prf = prfOf(g);
      }
      if (prf) {
        const cur = await loadRing(m);
        await saveRing(m, cur.ring || await newRing(), cur.version, { [id]: await wrapAk(prf, unb64u(m.ak)) });
      }
      await hint.put({ passkey: true });
      render().then(() => say(prf ? 'Passkey added. Signing in with it anywhere opens your Macs at once.'
        : 'Passkey added. This browser can\'t keep the account key in it, so a new browser that signs in with it still needs a Mac to approve it.'));
      return true;
    } catch (x) { say(x.name === 'NotAllowedError' ? 'No passkey was added.' : x.message || 'No passkey was added.', 'error'); return false; }
  }
  $('passkey-add').addEventListener('click', () => addPasskey());
  // Passkeys only: email alone then signs in to nothing but asking a Mac (the way back in for
  // someone who lost every passkey).
  $('passkey-only').addEventListener('click', async () => {
    const m = await me.get();
    const on = $('passkey-only').dataset.on !== 'true';
    if (on && !root.confirm('Require a passkey to sign in? Email alone will no longer get into this account. If you lose your passkeys, sign in by email and approve the browser from one of your Macs with dibs connect --approve.')) return;
    try {
      await api('POST', '/account/passkey-only', { on, proof: await proofOf(m) }, m.session);
      await render();
      say(on ? 'Done: this account now needs a passkey to sign in.' : 'Email codes sign in to this account again.');
    } catch (x) { say(x.message, 'error'); }
  });
  $('signout-all').addEventListener('click', async () => {
    const m = await me.get();
    if (!root.confirm('Sign out every browser signed in to this account, this one included? This browser signs straight back in; the others need a passkey or an email link.')) return;
    try {
      const res = await api('POST', '/account/sessions/end', { proof: await proofOf(m) }, m.session);
      await me.put({ ...m, session: res.session });
      say('Every other browser is signed out.');
    } catch (x) { say(x.message, 'error'); }
  });
  $('signout').addEventListener('click', async () => {
    const m = await me.get();
    try { await api('POST', '/account/signout', {}, m?.session); } catch {}
    await me.clear();
    for (const r of await macs.all()) if (r.account) await macs.remove(r.mid);
    render();
  });

  // No account key in this browser yet: ask a Mac of the account, and show the code to type there.
  // The request in flight is kept with the session in IndexedDB (the ephemeral key as the
  // CryptoKey itself, which can't be read out), so a reload carries on with it instead of
  // leaving it to hold one of the account's places for ten minutes.
  const keep = async (m, a) => { const next = { ...m, asking: a }; await me.put(next); return next; };
  const showSas = keys => {
    $('code').textContent = keys.sas.replace(/(\d{3})(\d{3})/, '$1 $2');
    show('approve');
    say(`On one of your Macs, run: dibs connect --approve ${keys.sas}`);
  };
  let polling = false;
  async function askMac(m) {
    if (polling) return;
    polling = true;
    let a = m.asking && Date.now() - m.asking.t0 < APPROVAL_WAIT ? m.asking : null;
    try {
      if (!a) {
        const st = await approvalStart();
        const { id } = await api('POST', '/account/approval', { commit: st.commit, label: T.deviceName() }, m.session);
        m = await keep(m, a = { id, eph: st.eph, B: st.B, n: st.n, t0: Date.now() });
      }
      say('Waiting for one of your Macs to see this request...');
      let keys = a.mac ? await approvalKeys(a.eph, m.aid, a.id, a.B, unb64u(a.mac)) : null;
      if (keys) showSas(keys);
      if (keys && a.sealed) return confirmKey(m, keys, a.id, a.sealed);
      while (Date.now() - a.t0 < APPROVAL_WAIT) {
        await new Promise(r => setTimeout(r, POLL));
        const p = await api('POST', '/account/approval/poll', { id: a.id }, m.session);
        if (p.refused) throw fail('refused', 'The Mac refused this browser, or restarted before it could send the key. Ask again.');
        if (p.mac && !a.revealed) {
          // A reload between revealing and saving that it did: the relay already has it.
          await api('POST', '/account/approval/reveal', { id: a.id, pub: b64u(a.B), nonce: b64u(a.n) }, m.session).catch(e => { if (e.code !== 409) throw e; });
          m = await keep(m, a = { ...a, mac: p.mac, revealed: true });
          keys = await approvalKeys(a.eph, m.aid, a.id, a.B, unb64u(p.mac));
          showSas(keys);
        }
        if (p.sealed && keys) {
          m = await keep(m, a = { ...a, sealed: p.sealed });
          return confirmKey(m, keys, a.id, p.sealed);
        }
      }
      throw fail('timeout', 'No Mac approved this browser in 10 minutes. Ask again.');
    } catch (x) {
      await me.put({ ...m, asking: null });
      say(x.message, 'error');
      show('need-key');
    } finally { polling = false; }
  }
  $('ask-key').addEventListener('click', async () => askMac(await me.get()));
  // The second code: what the Mac printed after --approve, typed here. Three tries.
  const CONFIRM_TRIES = 3;
  function confirmKey(m, keys, id, sealed) {
    show('confirm');
    say('Your Mac approved this browser. Type the code it printed.');
    let tries = 0;
    const form = $('confirm-form');
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        const ak = await acceptSealed(keys, m.aid, id, sealed, $('confirm').value);
        form.onsubmit = null;
        await me.put({ ...m, ak: b64u(ak), asking: null });
        say('Approved. This browser now opens your Macs.');
        render();
      } catch (x) {
        if (++tries < CONFIRM_TRIES && x.code === 'confirm') return say(x.message, 'error');
        form.onsubmit = null;
        await me.put({ ...m, asking: null });
        say(x.code === 'confirm' ? 'That code didn\'t match three times, so this browser won\'t use the key it was sent. Ask again.' : x.message, 'error');
        show('need-key');
      }
    };
  }

  // A link from dibs connect --account: pair that Mac with the account's device key, give it the
  // account key (sealed in the pairing's own session), and add it to the keyring.
  async function joinMac(link) {
    const m = await me.get();
    if (!m?.ak) return say('Sign in to your dibs account here first, then open the link from dibs connect --account again.', 'error');
    const r = await loadRing(m);
    const ring = r.ring || await newRing();
    const keys = await deviceKeys(ring);
    const url = `${root.location.protocol === 'https:' ? 'wss' : 'ws'}://${root.location.host}/ws/b/${link.mid}`;
    const ticket = await T.pairTicket(link);
    say('Adding this Mac to your account...');
    // The relay hears of a new link within a second or so of dibs connect --account; opened
    // sooner, it's turned away and tried again (as transport.js does for a phone).
    let chan;
    for (let i = 0; ; i++) {
      chan = T.socketChan(url, root.WebSocket, () => {}, { t: 'pair', ticket });
      try { await chan.macUp; break; } catch (e) {
        if (!(e.relay && e.code === 'pair-expired') || i >= 3) return say(e.relay ? 'That link was already used or has expired. Run dibs connect --account for a new one.' : 'Couldn\'t reach the Mac. Is dibs relay running on it? (dibs service status)', 'error');
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
    try {
      const rec = await T.pair(chan, link, `account ${m.aid.slice(0, 8)}`, { put: async () => {} }, keys);
      const s = await T.open(chan, rec);
      const secret = b64u(random(32));
      const j = await s.request('POST', '/api/account/join', { aid: m.aid, secret, ak: m.ak, label: T.deviceName() });
      if (j.status !== 200) throw fail('join', j.json?.error || 'the Mac refused to join');
      await api('POST', '/account/members', { member: b64u(await sha(enc.encode(`dibs-member-v1\0${secret}`))), mid: link.mid, proof: await proofOf(m) }, m.session);
      ring.machines = [...ring.machines.filter(x => x.mid !== link.mid), { mid: link.mid, m: rec.m, fp: rec.fp, did: rec.did, rt: rec.rt, name: `Mac ${link.mid.slice(0, 6)}`, added: Date.now() }];
      await saveRing(m, ring, r.version);
      s.close();
      say('Added. Every browser you sign in with now opens this Mac.');
    } catch (x) {
      chan.close(x.message);
      say(x.code === 'pair-expired' ? 'That link was already used or has expired. Run dibs connect --account for a new one.' : x.message, 'error');
    }
    render();
  }

  async function arrive() {
    const f = takeFragment();
    if (f?.signin) {
      try { await pending.clear(); return await afterEmail(await api('POST', '/account/link/redeem', { token: f.signin })); }
      catch (x) { await render(); return say(x.message, 'error'); }
    }
    if (f?.code) {
      await pending.put({ ...f.code, sent: Date.now() });
      return showCode(f.code);
    }
    await render();
    if (f?.join) joinMac(f.join);
  }
  root.addEventListener('hashchange', arrive);
  root.addEventListener('pageshow', e => { if (e.persisted) arrive(); });
  arrive();
  root.dibsAccount = { _internals: internals };
})(globalThis);
