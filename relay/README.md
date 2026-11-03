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

Nothing here has been deployed. In order:

1. `node build.mjs`, and keep the printed hashes: publish them (the release notes, or the repo) so anyone can compare them with what app.dibs.cc serves.
2. Check the config: `wrangler.jsonc` adds a Worker named `dibs-relay` with
   - a custom domain `app.dibs.cc` (Cloudflare creates the DNS record and certificate; there must be no existing `app` record in the dibs.cc zone),
   - two routes on zone dibs.cc, `dibs.cc/app` and `dibs.cc/app/*` (exactly these: `dibs.cc/app*` would also take `/apple-touch-icon.png` from the waitlist), which take precedence over the `dibs-waitlist` Worker's custom domain for those paths only and answer with a 301 to app.dibs.cc. The waitlist Worker, its domains and its D1 database aren't touched. Skip the route if the link should only ever be app.dibs.cc (`dibs pair --remote` prints app.dibs.cc anyway),
   - a custom domain `mcp.dibs.cc` for remote MCP (no existing `mcp` record in the zone either), with var `MCP_HOST`,
   - Durable Object classes `Machine` (SQLite-backed, migration `v1`; it stores nothing) and `CodeIndex` (migration `v2`; sign-in code hashes and machine ids, ten minutes at most),
   - rate limiting bindings, namespaces `7423` (connections) and `7424` (MCP requests); the waitlist uses `7422`,
   - `workers_dev` and preview URLs off, observability and logpush off.
3. Set the relay's one secret, which signs bare-host client ids (`https://mcp.dibs.cc/oauth/register`) and nothing else: `openssl rand -base64 32 | wrangler secret put REG_SECRET` (or the `cf` equivalent). Without it the bare host refuses registration (503); `/<machine id>/mcp` still works. Rotating it voids bare clients registered before, which simply register again.
4. Deploy with the token that can (wrangler's login on this Mac is read-only; the `cf` CLI's works, per the waitlist): `cf deploy` from this folder after checking it reads `wrangler.jsonc`, or `wrangler deploy` with a token holding Workers Scripts, Workers Routes and DNS edit on dibs.cc.
5. Check it:
   ```bash
   curl -sI https://app.dibs.cc/ | grep -iE 'content-security|strict-transport|x-frame|referrer'
   curl -s https://app.dibs.cc/ | openssl dgst -sha384 -binary | base64      # matches "/" in public/hashes.txt
   curl -sI https://dibs.cc/app | grep -i location                          # https://app.dibs.cc/
   curl -sI https://dibs.cc/ | head -1                                      # still the waitlist
   ```
6. On the Mac, after the dibs release that carries `dibs relay`: `dibs service install relay`, `dibs service status relay` (connected), `dibs pair --remote`, open the link on a phone.
7. Optional, stronger: submit app.dibs.cc's parent for HSTS preload only once every dibs.cc subdomain is HTTPS-only (preload covers the whole registrable domain).
