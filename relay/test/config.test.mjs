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
  assert.deepEqual(conf.durable_objects.bindings.map(b => b.class_name).sort(), ['CodeIndex', 'Machine']);
  assert.deepEqual(conf.migrations.map(m => [m.tag, m.new_sqlite_classes]), [['v1', ['Machine']], ['v2', ['CodeIndex']]]);
  assert.equal(conf.workers_dev, false);
  assert.equal(conf.preview_urls, false);
  assert.equal(conf.observability.enabled, false);
  assert.equal(conf.logpush, false);
  assert.equal(conf.vars.PAGE_HOST, 'app.dibs.cc');
});
