# dibs from anywhere: the encrypted relay

`dibs pair --remote` pairs a phone or any browser with this Mac. The browser then opens https://app.dibs.cc and sees the same page `dibs web` serves at 127.0.0.1:7421, carried end to end encrypted through a relay that only forwards opaque frames. The relay (a Cloudflare Worker, `relay/` in this repo) never holds a key, a pairing secret or a byte of the board.

Turn it on:

```bash
dibs service install relay     # keeps the outbound connection up, with backoff; off until you do this
dibs pair --remote             # prints a one-time link and a QR code; open it on the phone. That browser can only look
dibs pair --remote --allow-actions   # the same, and that browser may also boost, pause, resume and stop jobs, cap an agent, set the pace and cancel scheduled runs
dibs pair --list               # local sign-ins and remote devices
dibs pair --revoke <id|all>    # a revoked device's open session ends within 25 seconds
dibs service status relay      # connected or not, since when, how many devices
```

## Keys

| key | where | what it does |
|---|---|---|
| Mac identity, Ed25519 | `~/.dibs/relay-keys.json` (0600), never sent | signs every pairing answer and session handshake; browsers pin its fingerprint |
| Mac relay key, Ed25519 | same file | proves to the relay that this Mac owns its machine id; opens no session, decrypts nothing |
| device key, Ed25519 | the browser's IndexedDB, made with `extractable: false` | signs the device's half of each handshake; page script can use it but never read it |
| session keys, AES-256-GCM | memory only, per connection | one per direction, from a fresh X25519 exchange |

Machine id `mid` = first 16 bytes of SHA-256("dibs-mid-v1\0" ‖ relay public key), base64url (22 characters). Fingerprint `fp` = SHA-256("dibs-fp-v1\0" ‖ identity public key), base64url (43 characters).

## Encoding

`tx(label, f1, f2, ...)` is every item as a 4-byte big-endian length followed by its bytes, so two different transcripts never encode the same. All binary fields travel as base64url and are checked for exact length. Messages between the page and the Mac are binary WebSocket messages: `0x01` followed by UTF-8 JSON for handshake messages, `0x02` followed by an encrypted frame.

## Pairing

`dibs pair --remote` makes a 32-byte random `secret` and prints

```
https://app.dibs.cc/#p=<mid>.<secret>.<fp>
```

The fragment never goes in a request, and the page removes it from the address bar (`history.replaceState`) before any other code runs. The Mac keeps only what's derived from the secret, for ten minutes: `pid` = HKDF(secret, info "dibs-relay-v1 pair id", 16 bytes), the HMAC key `kp` (info "... pair key"), the name key `kn` (info "... pair name"), and the hash of the pairing ticket `pt` (info "... pair ticket", 32 bytes), which it registers with the relay. The page sends `pt` to the relay to get into the pairing pool; the relay can't derive anything else from it.

1. **pair1**, browser to Mac: `{t, pid, d, nb, name, sig, mac}`. `d` is the new device public key, `nb` 32 random bytes, `name` is the device's name ("Safari on iPhone") padded to 64 bytes, followed by the device's 32-byte random relay token `rt`, sealed together with AES-GCM under `kn` (random nonce), so the relay learns neither the name, its length, nor the token. `T1 = tx("dibs-pair1-v1", mid, pid, d, nb, name)`, `sig = Sign_d(T1)`, `mac = HMAC(kp, T1 ‖ sig)`.
   The Mac finds the pending link by `pid` (gone or expired: `pair-expired`), checks `mac` in constant time (three failures burn the link), checks `sig`, decrypts the name, and only then, under one lock, deletes the link and stores the device `{pub: d, name, rth, created}` under a random 16-byte id `did`, where `rth` is the first 16 bytes of SHA-256("dibs-relay-token-v1\0" ‖ rt). It sends the relay the new list of token hashes, then `{t: "admit", ch, h: rth}` for the pairing tab.
2. **pair2**, Mac to browser: `{t, m, nm, did, sig, mac}`. `m` is the Mac's identity key, `nm` 32 random bytes. `T2 = tx("dibs-pair2-v1", mid, pid, d, nb, name, m, nm, did)`, `sig = Sign_M(T2)`, `mac = HMAC(kp, T2 ‖ sig)`.
   The browser requires `fingerprint(m) == fp` from the link, then the HMAC, then the signature, and only then stores `{mid, m, fp, did, device key pair}`.

So pairing needs the secret (256 bits, one use, ten minutes; there's nothing to brute force), and a relay that swaps either key is caught: the device key by the HMAC and the device's own signature, the Mac's key by the fingerprint and the HMAC.

## A session

Every connection, including the first right after pairing:

1. **hello1**, browser: `{t, did, eb, nb}`: a fresh X25519 public key `eb` and 32 random bytes.
   The Mac refuses an unknown `did` (`unpaired`). Otherwise it makes its own X25519 pair `em`, 32 random bytes `nm`, and `TH = tx("dibs-hs-v1", mid, did, D, eb, nb, M, em, nm)` where `D` is the stored device key and `M` its identity key. It rejects an all-zero shared secret.
2. **hello2**, Mac: `{t, em, nm, sig}`, `sig = Sign_M(tx("dibs-hs2-v1", TH))`. The browser builds `TH` from its own view (the `M` it pinned at pairing) and verifies, so a relay answering with its own keys is caught here, before the browser has sent anything but a public key.
3. **hello3**, browser: `{t, sig}`, `sig = Sign_D(tx("dibs-hs3-v1", TH, sigM))`. The Mac verifies it against `D` and checks the device is still paired.

Keys: `salt = SHA-256(tx("dibs-hs-keys-v1", TH, sigM, sigD))`; from the X25519 shared secret, HKDF-SHA-256 with that salt gives `k_b2m` (info "dibs-relay-v1 key b2m"), `k_m2b` ("... key m2b") and the session id `sid` ("... sid"). Both ephemeral private keys are dropped after the exchange, so a later theft of the long-term keys reveals no recorded session (forward secrecy). Both sides signed the same transcript (mutual authentication); a replayed hello3 fails because the Mac's `em` and `nm` are new every time.

4. **ready**: the Mac's first encrypted frame. The page sends no call before it decrypts this (key confirmation).

## Frames

```
0x02 | seq (8 bytes, big-endian) | AES-256-GCM ciphertext | tag (16)
nonce = 4 zero bytes | seq
AAD   = "dibs-frame-v1" | sid | direction (1 = browser to Mac, 2 = Mac to browser) | the 9 header bytes
```

Each side's `seq` starts at 0, and the receiver accepts only exactly the next one. A replayed, dropped, reordered, altered or cross-session frame fails, and any failure closes the session (the page reconnects with new keys). Plaintext is a 4-byte length, the JSON, and zeros up to the next bucket of 1, 4, 16, 64, 256 KiB, 1 or 4 MiB; requests are capped at 64 KiB. Messages: `{t: "req", id, method, path, body}` from the page, `{t: "res", id, status, json}` from the Mac. The Mac runs a request only after it decrypts, only for `/api/...` paths, only if the device is still in `relay.json` at that moment, and only if the device may. Remote calls go through an allow-list, checked in the relay connector and again in `api()`, on the path as `api()` parses it (so `/api/x/../hook` is `/api/hook`):

- any paired device: GET `/api/board` (with `?posts=0` the day's posts stay apart, for `/api/posts`), `/api/posts`, `/api/questions`, `/api/threads`, `/api/later`, `/api/history`, `/api/stats`, `/api/settings`;
- a device paired with `--allow-actions`, also: POST `/api/jobs/<id>/boost|pause|resume|stop`, `/api/cap`, `/api/pace`, `/api/later/<id>/cancel`;
- everything else is 403, a route added later included, so new routes are local-only until someone decides otherwise. That covers messaging an agent, marking a thread read, answering or dismissing an agent's question (all of which reach agents as "Message from the person", which agents act on, shell commands included), installing the hook (it edits `~/.claude/settings.json`) and setting the hours (they decide when the person gets asked).

A reason sent with a remote action is dropped: the action runs, but no words from a paired browser reach an agent as the person's. A remote action runs the CLI with `DIBS_VIA`, so the record names the device: the job's `by` (a stop's `stopBy`, a pause's `by`, which the job's agent is told), the override event and `logChange` all read "the person via Safari on iPhone (remote 1a2b3c4d)": a label from the page's fixed vocabulary (browser and system, or "a browser" for any name the page wouldn't have made, since the device chooses its own name and this text reaches agents), and the start of its id, the one `dibs pair --revoke` takes. The device's own name appears only in `dibs pair --list`. `dibs pair --list` shows each device as "can act" or "look only", and every `dibs pair --remote` is logged with whether it allowed actions. Sessions end after 12 hours; the page reconnects.

Errors before a session exists (`{t: "err", code}`) are unauthenticated, so the relay could write them. The page believes only four codes (`unpaired`, `pair-expired`, `bad-pair`, `bad-hello`), shows only its own fixed sentence for each, and never deletes keys because of one. Nothing else the relay sends reaches the page as words either: WebSocket close reasons are ignored, and every message the page shows about the connection is one of its own.

## The relay

| path | who | what the relay does |
|---|---|---|
| `wss://app.dibs.cc/ws/m/<mid>` | the Mac (also sends `{t: "tokens", h, p}`: the hashes of its paired browsers' relay tokens and of its open links' pairing tickets, within a second of any change in `relay.json`) | sends a 32-byte challenge; the Mac answers with its relay public key and `Sign_R(tx("dibs-relay-auth-v1", mid, challenge, host))`. The relay checks that the key hashes to `<mid>` and the signature; then routes. The newest authenticated connection replaces the old one |
| `wss://app.dibs.cc/ws/b/<mid>` | a browser tab | only from the page's own Origin. A tab gets a slot only by proving it's paired: its first message is `{t: "hello", rt}`, and the relay admits it if the hash of `rt` is one the Mac registered (compared in constant time), or `{t: "pair", ticket}` with a ticket whose hash the Mac registered for an open link, into a pool of 2 with a 30 s deadline that ends when the Mac admits it. A wrong ticket and no open link get the same answer, so the relay's answers say nothing about whether a link is open, and nobody without the link can take the pairing pool. Anything else (a byte, a made-up token, silence for 5 s) closes it. An admitted tab gets a random channel id; its binary messages go to the Mac prefixed with the id, and the Mac's go back by id. Text from the relay: `{t: "mac", up}`, and `{t: "refused", why: "unpaired" or "no-pairing"}`, which the page turns into its own words |
| `https://app.dibs.cc/` | anyone | the page, with the headers below |
| `https://dibs.cc/app`, `https://dibs.cc/app/*` | anyone | a 301 to `https://app.dibs.cc/`, which keeps the fragment. Exactly these two route patterns, so `/apple-touch-icon.png` and the like stay the waitlist's |

Limits: 20 connections a minute per address and role (Workers rate limiting), and 30 new tabs a minute per address in the machine's Durable Object. At most 8 paired tabs per machine and 4 per address; at most 6 tabs waiting to prove themselves, 3 per address, and past 6 the oldest waiting goes, never the newcomer. A Mac socket has 10 seconds to authenticate, on its own timer; at most 8 wait at once, and past that the oldest waiting one is closed rather than the newcomer refused, so silent sockets can't lock the real Mac out. When the Mac goes offline every tab hears so and is closed 5 seconds later, whatever it sends meanwhile; a tab that arrives while it's offline is turned away at once. When the Mac reconnects, every admitted tab is closed so it proves itself to the new connection. A revoke reaches the relay within a second, and that device's open tabs are closed. Also 64 KiB per browser frame and 4 MiB per Mac frame, token buckets of 20 frames a second (burst 60) per tab and 200 (burst 400) for the Mac, tabs closed after 10 idle minutes, a Mac closed after 90 seconds without a ping. One Durable Object per machine id, nothing in its storage, observability and logpush off, and nothing about a frame is logged.

## The page

- Its own origin, `app.dibs.cc`, not `dibs.cc/app`: the device key lives in that origin's IndexedDB, and anything else on the same origin (the waitlist page, a future blog) could use it. Keeping the origin to this one page keeps that surface to this one page.
- `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src wss://app.dibs.cc; ... base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`. No inline script, no third-party anything, no DOM HTML sinks.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, COOP/COEP/CORP same-origin, a Permissions-Policy denying every device API.
- Subresource Integrity (SHA-384) on every script and stylesheet, and `hashes.txt` listing the hash of every file, the page itself included, so anyone can check what app.dibs.cc serves:

```bash
curl -s https://app.dibs.cc/ | openssl dgst -sha384 -binary | base64     # compare with relay/public/hashes.txt for /
```

## Remote MCP (mcp.dibs.cc)

`dibs relay mcp on` lets an MCP client somewhere else, such as a claude.ai connector on another Claude account, reach this Mac's MCP. The URL to give it is `https://mcp.dibs.cc/mcp`; `https://mcp.dibs.cc/<machine id>/mcp` works too. It's off until the person turns it on (`dibs relay mcp off` turns it off at once; `dibs service status relay` and `dibs pair --list` show which).

This part is **not end-to-end encrypted**. MCP clients speak HTTPS, and TLS ends at Cloudflare, so the relay carries these requests and answers in the clear on their way through. It stores none of it and logs no bodies.

### Sign-in codes

While remote MCP is on, `dibs pair` prints 12-character codes (60 bits, `XXXX-XXXX-XXXX`), good for sign-in here and through the relay; with it off they're 8 characters and local only. A code through the relay must be a long one. One use, ten minutes, as always.

### The bare host, https://mcp.dibs.cc/mcp

With no machine id in the URL, the relay finds the Mac three ways, and none of them lets it pretend to be one:

- **Discovery and registration** are answered by the relay itself, storing nothing. The issuer and resource are `https://mcp.dibs.cc`. A client id is `b.<payload>.<mac>`: the payload is the client's name and redirect URIs, and the mac is an HMAC under `REG_SECRET`, the one secret the relay holds. It signs registrations and nothing else; no Mac knows it, and it opens nothing on any Mac. The relay refuses an edited or unsigned client id at `/oauth/client`, `/oauth/authorize` and `/oauth/token`, and the Mac still checks the redirect exactly against the payload at sign-in and at token exchange.
- **Sign-in is routed by the code.** While remote MCP is on, the Mac lists the index hash of each live long code, SHA-256("dibs-mcp-code-v1\0" ‖ normalized code), with the relay over its authenticated socket. The relay keeps them in one code index (a Durable Object): hash to machine id, for the code's ten minutes at most, replaced whenever the Mac's list changes (a spent or revoked code drops out within a second; an accepted one is dropped at once), at most 10 per machine, and a machine can only replace its own entries. The sign-in page at `https://mcp.dibs.cc/authorize` sends the code; the relay hashes it, finds the machine, and forwards the request to that Mac, which checks the code itself. A malformed, unknown, expired or spent code gets exactly the answer a Mac gives a wrong code: the same 401, the same words, the same 800 ms.
- **Everything after is routed by tag.** The authorization code, access token and refresh token a Mac issues through the bare host start with `<machine id>.`; the relay routes `/oauth/token` and `/mcp` by it. The Mac checks the whole string by hash, so a token re-tagged for another machine, with a made-up tag, or made up whole is 401 (with `resource_metadata` for the bare host). The tag is a machine id, which isn't a secret: it's in every grant and token, so it reaches the MCP client and may end up in its logs or a browser's history. On its own it opens nothing. It doesn't sign anyone in (that takes the person's code), doesn't make a token (each is 32 random bytes the Mac checks by hash), and can't spend the signed-in client's budget (only tokens the Mac accepts count against that). The most it does is aim unauthenticated requests at one machine, which the per-machine and per-address limits below already cap.

Lookups at the index are limited: 10 a minute per address, and 300 a minute in total for an address's second and later tries. An address's first try in a minute always gets an answer, so a flood from many addresses can't lock out a person typing their code once.

### What's forwarded

Only `GET|POST /mcp`, `POST /oauth/register`, `GET /oauth/client`, `POST /oauth/authorize`, `POST /oauth/token` and the three `/.well-known` metadata documents, at the bare host or under `/<machine id>/` (metadata also at `/.well-known/<kind>/<machine id>`, the RFC 8414 form). Everything else on mcp.dibs.cc is 404 at the relay, and the Mac refuses anything else again: never the page, never `/api/*`, never the relay's own messages. Requests carry only `Content-Type`, `Authorization`, `Origin`, `Accept` and `Mcp-Protocol-Version` (at most 64 KiB of body) and the connecting address; answers carry only `Content-Type`, `WWW-Authenticate` and `Allow`. The relay sends each as a `{t: "http", id, ...}` message over the Mac's authenticated WebSocket and waits up to 25 s for `{t: "http-res", id, ...}`. The Mac answers 502 instead of any `http-res` over 3.5 MiB once serialized, so a big answer fails one request and never closes the connection.

### The sign-in page

The relay's own copy of `web/authorize.html`, with SRI and the same strict CSP as the page. It shows first, and largest, the address that will receive the token (the redirect's host, then the full address); the client's name comes after, marked as its own description, since anyone can register any name.

### Limits and separation

- **Wrong codes** through the relay are counted apart from local ones, per address and per client: 10 wrong in 10 minutes from one address, or for one client, and that address or client waits the window out, right code or not. Past 100 wrong from all addresses together in 10 minutes (a real flood), every remote try waits. Sign-in on the Mac itself is never affected.
- **Registrations** through the relay (at `/<machine id>/`) are limited to 10 in 10 minutes per address, 100 in all. At most 200 remote clients are kept; when full, the oldest one that never signed in is dropped, and a client that has signed in is never dropped (with none to drop, registration waits). Local clients are never touched.
- **Per machine,** requests with a token the Mac accepts have their own budget (120 a minute), apart from everything else (discovery, registration, sign-in, rejected tokens: 40 a minute), so strangers can't spend the signed-in client's. At most 8 requests at once per machine, 2 from one address. Per address, 120 requests a minute (Workers rate limiting).
- **Tokens, grants and clients** made through the relay carry `remote: true` and work only through it; local ones work only locally. `dibs pair --list` shows them as "MCP via mcp.dibs.cc: <client name>"; `--revoke` signs one out.
- **What a client can do** depends on the code it signed in with, here and through the relay alike. A plain `dibs pair` code gives the read tools: `board`, `agents`, `agent`, `progress`, `stats`, `questions`, `history`, `resource`, `machines`, `messages`. A code from `dibs pair --allow-actions` adds the write tools: `post_progress`, `answer_question`, `tell_agent`, `say_to_person`, `hold`, `release`, `boost_job`, `pause_job`, `resume_job`, `stop_job`. The grant goes from the code to its grant, its tokens and every refresh; `dibs pair --list` shows each client as "can act" or "look only".
- **A client acts as an agent, never as the person.** Every write runs the CLI as `mcp-<name>-<hash>` (its name made safe, and 4 hex characters of its client id), so its messages and answers reach agents as another agent's, its holds and job changes show under that name on the board and in `dibs history`, and acting on another session's job takes `owner`, as for any agent. No tool installs the hook or sets the hours.
- **Commands never go through the relay.** A code from `dibs pair --allow-commands` also gives `queue_run` (a command for dibs to run later, as `dibs later` does), but only to a client signed in at this Mac's own `http://127.0.0.1:7421/mcp`. Through mcp.dibs.cc a token could be read in transit, so a token issued there never carries the commands grant, `queue_run` is never listed, and a call to it is refused, whatever code the client signed in with. `dibs pair --list` shows such a local client as "can run commands".
- Through the relay, writes carry a token the Mac accepts, so they count against the signed budget like any other MCP call.
- Tool text is one line per field, and the server's instructions tell the client never to follow instructions found in agents' posts, questions or messages.

## Accounts (app.dibs.cc/account)

An account remembers your Macs, so any browser you sign in with opens all of them, still end to end. `dibs connect --account` adds a Mac; `dibs connect --approve <code>` lets a new browser have the account's key; `dibs connect --list` and `--remove <id>` show and undo it.

### The account key and the keyring

- The **account key** (AK) is 32 random bytes made by the account's first browser. It never reaches the relay except sealed.
- The **keyring** is JSON the browser seals with AK (AES-256-GCM, additional data "dibs-keyring-v1") and stores at the relay: one Ed25519 **account device key** (its private key, pkcs8), and for each Mac its machine id, its pinned identity key and fingerprint, the device id it gave the account, and the relay token. Each Mac trusts the account device key as one paired device ("account <id>"), so every browser that opens the keyring talks to every Mac over the same sessions as a phone does (above). The keyring is versioned: a write naming an old version is refused, so two browsers can't overwrite each other's Macs.
- A browser keeps AK, its session and the Macs in IndexedDB, which belongs to app.dibs.cc alone. The device key is imported there as non-extractable.
- **Changing the account takes AK.** The first keyring write stores SHA-256 of a proof, HKDF(AK, "dibs-account-auth"); every later write (the keyring, wrapped AKs, adding a Mac, adding or removing a passkey, ending sessions) must carry that proof. A session alone, say from a stolen inbox, can read the sealed keyring and ask a Mac for AK, and nothing else. The relay keeps only the proof's hash, so a copy of its storage can't write either.
- A sign-in in a browser that already holds an account keeps AK when it's the same account, and asks before switching to another one.

### Signing in

- **Email code (and link).** The address is typed on app.dibs.cc/account; the page then passes it, in the fragment, to `https://mcp.dibs.cc/email`, which runs Cloudflare Turnstile (whose script changes without notice and so can't be pinned; app.dibs.cc runs no script it didn't ship, since AK is in its storage) and comes straight back. The relay checks the Turnstile token with Cloudflare (for that host and action, once) before it sends anything. It keeps HMAC-SHA-256 under `ACCOUNT_SECRET` of the trimmed, lowercased address (so it can find the account an address signs in to, and can't list addresses), and mails, through Cloudflare Email Sending from no-reply@mail.dibs.cc, a 6-digit code (never in the subject, which lock screens show) and a link, `https://app.dibs.cc/account#signin=<token>`, saying which browser asked and roughly where (Cloudflare's city and country for the request). The page that asked gets a request id (16 random bytes) and the person types the code there; the link is for another device. Either one, once, within 10 minutes, spends both. The code is uniform over 000000 to 999999, stored only as HMAC-SHA-256 under `ACCOUNT_SECRET` with its request id, compared in constant time, and gone after 5 wrong tries (a 1 in 200,000 chance per request, each request behind Turnstile, a click on the person check page, and the limits below). The token is 32 random bytes in the fragment, so no request line, log or mail scanner's prefetch carries it; the relay stores only its SHA-256. For a mail wrapper that drops fragments, the page also takes `?signin=<token>`: loading it spends nothing (the page is served `no-store`, sends no referrer, takes the token out of the address bar at once and redeems it from script, which a scanner's prefetch doesn't run). Guesses at one code are checked one at a time, each against the tries the last one left, and an address takes at most 10 wrong codes a day across its requests; after that only its links sign in. The answer is the same whether or not the address has an account. A first sign-in makes the account, and the page then asks to add a passkey (skipping takes a second click that says what it costs).
- **Passkey.** WebAuthn, checked by hand in the Worker (relay/src/webauthn.js): CBOR, COSE ES256 and EdDSA, attestation "none", the challenge, origin, relying party (app.dibs.cc), user presence, and a sign count that must go up (a copy of a passkey with an older count is refused as a possible clone). User verification (a PIN or biometrics) is required to add one, and a sign-in without it gets a session but not the wrapped AK. Challenges are stateless: the time, 16 random bytes and an HMAC under `ACCOUNT_SECRET` over them, the kind and the account, good for 5 minutes; the relay stores one only once it's been used, so asking for challenges costs it nothing. It stores each passkey's id and public key. The account page lists them and removes one.
- **PRF.** When the browser supports the WebAuthn PRF extension, adding a passkey wraps AK under HKDF of its PRF output (AES-256-GCM, "dibs-ak-v1"), and the relay stores the wrapped AK. Signing in with that passkey anywhere it's synced opens AK there and then. The relay never sees the PRF output.
- **A session** is 32 random bytes the browser sends as a bearer header (never a cookie, so a WebSocket upgrade doesn't carry it and the relay can't tie a session to the Macs it opens), good for 30 days; the relay stores its SHA-256, and drops it the first time it's shown for an account that's gone. "Sign out everywhere else" ends every session made before it (the relay stores the time) and gives the asking browser a new one.
- **Passkeys only.** With a passkey on the account, the account key's proof can switch email sign-in off: an email code or link then gives a recovery session, which reads nothing (not even the sealed keyring) and can only ask a Mac for AK. Once a Mac approves it (`dibs connect --approve`), the browser holds AK and proves it like any other. That's the way back for someone who lost every passkey.
- **Passkey first.** A browser that signed in with or added a passkey leads with "Sign in with passkey" next time; the email field also offers this site's passkeys in its autofill (WebAuthn conditional mediation).
- **Limits:** sign-in codes and links 3 an hour per address from one IP, 20 an hour per address from anywhere (so strangers can't lock a person out), 10 an hour per IP and 300 an hour in all, every request counting toward all four, behind Turnstile, and counted in the object's storage by the clock hour (keyed by the address's and IP's keyed hashes), so an eviction doesn't reset them; sign-in attempts 10 in 10 minutes per IP; 30 account requests a minute per IP (Workers rate limiting); 10 passkeys and 50 Macs per account (a 51st is refused; a Mac joining again replaces its own entry). Expired entries are swept by the object's alarm, 128 keys per kind at a time, never during a request.

### A new browser without the key

A browser signed in by email (or with a passkey without PRF) has a session but not AK. It asks a Mac of the account, which holds AK (given when it joined, sealed in the pairing's own session, kept in `~/.dibs/relay.json` at 0600). The relay is only a mailbox, and the four steps make it unable to slip in a key of its own:

1. The browser posts a commitment: SHA-256("dibs-approve-commit-v1\0" || its ephemeral X25519 key || 32 random bytes).
2. A member Mac (one that shows the relay the account secret it was given when it joined; the relay keeps the secret's hash) posts its own ephemeral X25519 key.
3. The browser reveals its key and the random bytes; the Mac checks them against the commitment.
4. Both derive the same keys: HKDF of the shared secret, salted with the account, the request and both keys, gives an AES key and two 6-digit codes. The browser shows the first; the person types it on the Mac (`dibs connect --approve <code>`); only then does the Mac post AK sealed with that AES key, and print the second code.
5. The person types the second code into the browser, which opens the sealed AK only if it matches its own. A relay that answers the browser itself, posing as a Mac, knows the browser's codes, but the person has no code from a Mac to type, so its key is never used. Three wrong tries and the browser drops it.

Everything the relay lists is its word, so the Mac pins what it saw in step 2: the commitment, the label, and its own 10-minute deadline (it ignores the relay's). A list that later changes the commitment is refused, and a request never gets a second key from the Mac, even after the relay drops the Mac's socket: the ids it has answered stay in `relay.json` until their deadline, and an approval records the keys its codes came from, so the account key is sealed only to those (a relay that reconnected the Mac and replayed an approved id with keys of its own would otherwise be sealed to). A request caught by a reconnect can't be sealed any more: `dibs connect --approve` says so, refuses it so the browser hears no, and the person asks again. A browser reloaded mid-request carries on with the same one (its ephemeral key is kept in IndexedDB as a CryptoKey, which can't be read out); otherwise a relay could see the Mac's key, then grind keys of its own (1.65 million tries, about a minute on one core) until the Mac's code matched the one the person was about to type. With the commitment fixed before the Mac's key is out, a go-between has to choose blind, and its codes match one time in a million. A Mac answers at most 5 waiting browsers per account at once, and the relay keeps at most 5 open requests per account and 2 per session, so one stolen session can't crowd out the person's browsers. A wrong code approves nothing; a code that two waiting browsers show approves neither (both are refused).

### What the relay sees and keeps, for accounts

- **Keeps:** the email hash, the account id, the hash of AK's proof, passkey ids and public keys and sign counts, AK wrapped under each PRF passkey, the sealed keyring and its version, the hashes of member Macs' account secrets and their machine ids, when sessions were last ended, whether email may sign in, and for 10 minutes, 30 days, 5 minutes and 10 minutes the hashes of link tokens and codes (with their request ids' hashes), sessions, used challenges and approval requests.
- **Sees in transit:** the email address while it sends the link (TLS ends at Cloudflare), the link and session tokens, the public keys and commitments of approvals, IPs and times, and the size of the keyring.
- **Never sees:** AK, a PRF output, the keyring's contents (which Macs, their keys, the device key), or any frame between a browser and a Mac.
- **Can infer:** which Macs a signed-in browser then opens, from timing and IP, since those WebSockets carry no session.

## What this doesn't protect against

- **Whoever controls app.dibs.cc can serve different JavaScript.** That's the Cloudflare account, anyone holding a deploy token, or Cloudflare itself. A changed page could use the device key (it can't export it) and read the board while the tab is open. SRI doesn't help here: the same party serves the HTML that carries the hashes. Mitigations: the local page at http://127.0.0.1:7421 (`dibs web`) never touches the network; `hashes.txt` and this repo let anyone compare what's served against the source; `dibs pair --list` shows when each device last connected, and `--revoke` cuts one off. A stronger fix would be a page installed on the device (a signed app or extension) instead of one loaded from a server.
- **The code index is one place every bare-host sign-in goes through.** It holds only code hashes and machine ids, and only for ten minutes, but it's a single object: a big enough flood can slow it, and while the global budget is spent, a person who mistypes their code has to wait a minute to try again (their first try always gets through). The per-machine URL, `https://mcp.dibs.cc/<machine id>/mcp`, doesn't use the index at all.
- **The relay holds one secret, `REG_SECRET`.** It signs bare-host client ids and nothing else. Whoever has it can mint a client id with any redirect, which is no more than anyone can do by registering; it can't sign anyone in, since that still takes the person's code.
- **An account is as safe as its key.** Whoever holds AK opens every Mac of the account (as the account device). It's in each signed-in browser's IndexedDB, on each member Mac, and wrapped under each PRF passkey. A stolen synced passkey with PRF, or a browser profile, gives it; so does a person approving the wrong browser at a Mac (the code is there to stop that). `dibs connect --remove <id>` takes a Mac off the account (its account device and key go); signing out clears a browser. There is no way yet to change AK without starting a new account.
- **Email is only as safe as the inbox.** A sign-in code or link gives a session, not AK, so a stolen inbox alone opens no Mac and changes nothing on the account; it can still ask a Mac for approval, which is why both codes must match.
- **Turnstile runs Cloudflare's script on mcp.dibs.cc/email.** It sees the address typed there and could, if changed, send it elsewhere or ask for links; it can't reach app.dibs.cc's storage or AK, and mcp.dibs.cc keeps nothing in the browser.
- **The account's first write sets its proof.** Whoever writes the keyring first sets it. That's the browser that made the account, at once; an attacker would need the account's first sign-in link before the person used it. An account that got a keyring before proofs existed (2026-11-02, before the accounts CLI shipped, so with no Mac on it) takes no first proof from anyone and can't be changed.
- **The relay sees remote MCP traffic in transit.** With `dibs relay mcp on`, whatever an MCP client reads (the board, agents' posts and tasks, stats) passes through Cloudflare decrypted, as do the sign-in codes and OAuth tokens on their way. It's never stored, but whoever controls the relay could read or change it, or keep a token and use it until it expires (access tokens last a day) or is revoked. Changing it can't do more than that client's code allowed: read, or with `dibs pair --allow-actions`, act as its `mcp-` agent. `queue_run` never goes through the relay. The page's own channel isn't affected. Leave remote MCP off unless a client elsewhere needs it.
- **The relay sees each tab's relay token.** A tab presents it so the relay can admit it; the relay keeps only hashes (in the Mac socket's state, gone when it disconnects). The token grants a tab slot and nothing else: it opens no session and decrypts nothing. Someone who steals it from the browser can occupy one of that device's slots until it's revoked.
- **The relay sees metadata**: which machine id is online and when, how many tabs, the time and padded size of each frame, IP addresses, and the public keys exchanged in pairing and handshakes. It can drop or delay anything (denial of service), but can't read, forge, replay or reorder a frame without the session closing.
- **The link is the key to pairing.** Anyone who sees it within ten minutes and opens it first pairs instead of the person (the person's own browser then gets "already used", and `dibs pair --list` shows the extra device to revoke). Don't paste it into a chat; scan the QR code with the phone's camera.
- **The link can reach synced browser history.** The page removes the fragment from the address bar as soon as its script runs, but a browser may record the full URL in its history first, and history syncs (iCloud, a Google or Firefox account). The link is dead after one use and after ten minutes either way, so a synced copy is only a risk in that window, and only before the person's own browser uses it. Scanning the QR code on the phone that will use it keeps it off the Mac's browser history altogether.
- **A compromised Mac or browser** is out of scope: malware in the person's account can read `~/.dibs`, and a browser extension with access to app.dibs.cc can drive the page.
- **A device paired with `--allow-actions`** can boost, pause, resume and stop any job, cap an agent, set the pace and cancel scheduled runs, as the person (the record names the device, and no reason text goes with it). It can't message agents, answer their questions, or change the hook or the hours. A lost phone that isn't revoked, or a changed page at app.dibs.cc while that device has it open, can do the same: stopping every job is the worst of it. Pair with actions only the devices that need them, and revoke a lost one at once. Look-only devices, the default, can read the board and nothing else.
- A pairing whose answer never reaches the browser (the connection dropped between pair1 and pair2) leaves a device on the Mac that no browser holds the key for. It can't be used; `dibs pair --list` shows it and `--revoke` removes it.
