// The Worker's routes, from wrangler.jsonc: app.dibs.cc is the page's own origin, and on
// dibs.cc only /app and /app/... come here. A wider pattern (dibs.cc/app*) would take
// /apple-touch-icon.png and anything else starting "app" away from the waitlist.
//   node --test test/config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(fs.readFileSync(path.join(HERE, 'wrangler.jsonc'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'));
const patterns = conf.routes.map(r => r.pattern);

// Cloudflare route matching: * matches anything, the rest literally (scheme left off).
const matches = (pattern, url) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url);
const routed = url => patterns.some(p => !conf.routes.find(r => r.pattern === p).custom_domain && matches(p, url));

test('dibs.cc/app and dibs.cc/app/... go to the relay; nothing else on dibs.cc does', () => {
  assert.ok(routed('dibs.cc/app'));
  assert.ok(routed('dibs.cc/app/'));
  assert.ok(routed('dibs.cc/app/anything'));
  for (const u of ['dibs.cc/apple-touch-icon.png', 'dibs.cc/application', 'dibs.cc/', 'dibs.cc/apps', 'www.dibs.cc/app']) assert.ok(!routed(u), u);
});

test('the page and remote MCP each have their own origin, and the Worker leaves workers.dev, previews and logs off', () => {
  assert.ok(conf.routes.some(r => r.pattern === 'app.dibs.cc' && r.custom_domain === true));
  assert.ok(conf.routes.some(r => r.pattern === 'mcp.dibs.cc' && r.custom_domain === true));
  assert.deepEqual(conf.routes.filter(r => r.custom_domain).map(r => r.pattern).sort(), ['app.dibs.cc', 'mcp.dibs.cc']);
  assert.equal(conf.vars.MCP_HOST, 'mcp.dibs.cc');
  assert.ok(conf.ratelimits.some(r => r.name === 'RLM' && r.simple.limit === 120));
  // The code index: its own class, added in its own migration, nothing else stored.
  assert.deepEqual(conf.durable_objects.bindings.map(b => b.class_name).sort(), ['Accounts', 'CodeIndex', 'Machine']);
  assert.deepEqual(conf.migrations.map(m => [m.tag, m.new_sqlite_classes]), [['v1', ['Machine']], ['v2', ['CodeIndex']], ['v3', ['Accounts']]]);
  assert.deepEqual(conf.send_email, [{ name: 'EMAIL', allowed_sender_addresses: [conf.vars.MAIL_FROM] }]);
  assert.ok(conf.ratelimits.some(r => r.name === 'RLA' && r.simple.limit === 30));
  assert.equal(conf.workers_dev, false);
  assert.equal(conf.preview_urls, false);
  assert.equal(conf.observability.enabled, false);
  assert.equal(conf.logpush, false);
  assert.equal(conf.vars.PAGE_HOST, 'app.dibs.cc');
  // Sign-in links only past Turnstile in production; the local env has no site key, so e2e asks directly.
  assert.match(conf.vars.TURNSTILE_SITEKEY, /^0x4/);
  assert.equal(conf.env.local.vars.TURNSTILE_SITEKEY, undefined);
});

// cf deploy reads cloudflare.config.ts, not wrangler.jsonc (wrangler dev and the e2e read that),
// so the two must say the same thing about production. The import is stubbed: each helper
// returns its own name and options, which is all the comparison needs.
test('cloudflare.config.ts, which cf deploy reads, matches wrangler.jsonc for production', async () => {
  const src = fs.readFileSync(path.join(HERE, 'cloudflare.config.ts'), 'utf8').replace(/^import .* from "cf\/config";$/m, `
    const helper = type => new Proxy({}, { get: (_, name) => opts => ({ type: name, ...(typeof opts === 'object' ? opts : { value: opts }) }) });
    const bindings = helper(), triggers = helper(), defineConfig = f => f;`);
  const { default: config } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const w = config({ mode: 'production' }).worker;
  assert.equal(w.name, conf.name);
  assert.equal(w.entrypoint, conf.main);
  assert.equal(w.compatibilityDate, conf.compatibility_date);
  assert.deepEqual([w.workersDev, w.previewUrls, w.logpush, w.observability.enabled], [false, false, false, false]);
  assert.deepEqual(w.domains.sort(), conf.routes.filter(r => r.custom_domain).map(r => r.pattern).sort());
  assert.deepEqual(w.triggers.map(t => t.pattern).sort(), conf.routes.filter(r => !r.custom_domain).map(r => r.pattern).sort());
  assert.deepEqual(Object.keys(w.exports).sort(), conf.migrations.flatMap(m => m.new_sqlite_classes).sort());
  for (const e of Object.values(w.exports)) assert.equal(e.storage, 'sqlite');
  for (const [k, v] of Object.entries(conf.vars)) assert.equal(w.env[k]?.value, v, k);
  for (const b of conf.durable_objects.bindings) assert.equal(w.env[b.name]?.exportName, b.class_name, b.name);
  for (const r of conf.ratelimits) assert.deepEqual([w.env[r.name]?.namespace, w.env[r.name]?.simple], [r.namespace_id, r.simple], r.name);
  for (const m of conf.send_email) assert.deepEqual(w.env[m.name]?.allowedSenderAddresses, m.allowed_sender_addresses, m.name);
  const kinds = { text: 1, durableObject: 1, rateLimit: 1, sendEmail: 1, assets: 1 };
  for (const [k, v] of Object.entries(w.env)) assert.ok(kinds[v.type], `${k} is a ${v.type} binding wrangler.jsonc does not have`);
  assert.equal(Object.keys(w.env).length, Object.keys(conf.vars).length + conf.durable_objects.bindings.length + conf.ratelimits.length + conf.send_email.length + 1);
});
