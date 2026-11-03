# relay: app.dibs.cc

The Cloudflare Worker that serves the dibs page at https://app.dibs.cc and forwards encrypted frames between a person's Mac (`dibs relay`) and their paired browsers. The protocol and what it does and doesn't protect against: [docs/relay.md](../docs/relay.md).

It's the only part of the repo with a package.json, and only for wrangler (a dev dependency, exact pins, the same 91-package tree as the waitlist Worker, checked by integrity hash). The Worker itself has no dependencies. dibs never loads anything from here.

```bash
canister install                # never npm install directly
node build.mjs                  # public/ from ../web, with SRI, and public/hashes.txt
node --test test/config.test.mjs   # the routes in wrangler.jsonc
~/bin/dibs run playwright --port WEB -m "relay e2e" -- node test/e2e.mjs   # wrangler dev + headless Chromium, the whole path
```

## Deploying

In order:

1. `node build.mjs`, and keep the printed hashes: publish them (the release notes, or the repo) so anyone can compare them with what app.dibs.cc serves.
2. Check the config: `wrangler.jsonc` adds a Worker named `dibs-relay` with
   - a custom domain `app.dibs.cc` (Cloudflare creates the DNS record and certificate; there must be no existing `app` record in the dibs.cc zone),
   - two routes on zone dibs.cc, `dibs.cc/app` and `dibs.cc/app/*` (exactly these: `dibs.cc/app*` would also take `/apple-touch-icon.png` from the waitlist), which take precedence over the `dibs-waitlist` Worker's custom domain for those paths only and answer with a 301 to app.dibs.cc. The waitlist Worker, its domains and its D1 database aren't touched. Skip the route if the link should only ever be app.dibs.cc (`dibs pair --remote` prints app.dibs.cc anyway),
   - a custom domain `mcp.dibs.cc` for remote MCP (no existing `mcp` record in the zone either), with var `MCP_HOST`,
   - Durable Object classes `Machine` (SQLite-backed, migration `v1`; it stores nothing) and `CodeIndex` (migration `v2`; sign-in code hashes and machine ids, ten minutes at most),
   - rate limiting bindings, namespaces `7423` (connections) and `7424` (MCP requests); the waitlist uses `7422`,
   - `workers_dev` and preview URLs off, observability and logpush off.
3. Accounts need two more things before they work:
   - Email Sending: set up on 2026-11-02 as the sending subdomain mail.dibs.cc (`cf email-sending subdomains list --zone dibs.cc`), with its records under cf-bounce.mail.dibs.cc and _dmarc.mail.dibs.cc, so the apex's mail (Email Routing for hello@ and licensing@) is untouched. The `EMAIL` binding sends from no-reply@mail.dibs.cc, 200 a day on this account. If it's ever removed, asking for a sign-in link answers 500 and passkeys still work.
   - Turnstile in front of sign-in links: the widget "dibs account sign-in links" (site key `0x4AAAAAAFxfl4Oft0B4fWmc` in both configs, host mcp.dibs.cc, managed; `cf turnstile widgets list`). Its secret goes in as `TURNSTILE_SECRET` with a deploy, read from `cf turnstile widgets get` into the same kind of private file as below. Without it, asking for a link answers 503; passkeys still work.
   - The secret that keys email hashes, `ACCOUNT_SECRET`, set once with the deploy in step 5 (the `cf` CLI has no `secrets put`, and `--secrets-file` adds to the Worker's secrets without removing others). Without it the account routes answer 503. Never rotate it: every email hash, and so every account's email sign-in, depends on it (passkeys would still work).
   The deploy adds the `Accounts` Durable Object (migration `v3`) and the `RLA` rate limit (namespace `7425`).
4. Set the relay's other secret, which signs bare-host client ids (`https://mcp.dibs.cc/oauth/register`) and nothing else: `openssl rand -base64 32 | wrangler secret put REG_SECRET` (or the `cf` equivalent). Without it the bare host refuses registration (503); `/<machine id>/mcp` still works. Rotating it voids bare clients registered before, which simply register again.
5. Deploy with the token that can (wrangler's login on this Mac is read-only; the `cf` CLI's works, per the waitlist): `cf deploy` from this folder, through `dibs run deploy`. `cf deploy` reads `cloudflare.config.ts`, not `wrangler.jsonc` (which `wrangler dev` and the e2e read); `test/config.test.mjs` fails if the two disagree about production. It imports `cf/config`, so link the `cf` package in first: `ln -s "$(npm root -g)/cf" node_modules/cf`. `cf deploy --dry-run` lists the bindings it would upload.
   The first deploy that carries accounts also sets `ACCOUNT_SECRET`, generated straight into a private file that is gone the moment the deploy ends, so the value is stored nowhere but the Worker:
   ```bash
   d=$(mktemp -d) && (umask 077; printf '{"ACCOUNT_SECRET":"%s"}' "$(openssl rand -base64 32)" > "$d/s.json") && cf deploy --secrets-file "$d/s.json"; rm -rf "$d"
   cf workers secrets list --worker dibs-relay      # ACCOUNT_SECRET and REG_SECRET
   ```
   Later deploys are plain `cf deploy`.
6. Check it:
   ```bash
   curl -sI https://app.dibs.cc/ | grep -iE 'content-security|strict-transport|x-frame|referrer'
   curl -s https://app.dibs.cc/ | openssl dgst -sha384 -binary | base64      # matches "/" in public/hashes.txt
   curl -sI https://dibs.cc/app | grep -i location                          # https://app.dibs.cc/
   curl -sI https://dibs.cc/ | head -1                                      # still the waitlist
   ```
7. On the Mac, after the dibs release that carries `dibs relay`: `dibs service install relay`, `dibs service status relay` (connected), `dibs pair --remote`, open the link on a phone.
8. Optional, stronger: submit app.dibs.cc's parent for HSTS preload only once every dibs.cc subdomain is HTTPS-only (preload covers the whole registrable domain).
