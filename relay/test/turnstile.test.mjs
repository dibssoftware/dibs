// src/turnstile.js: what the relay accepts from Cloudflare's siteverify before it sends a link.
//   node --test test/turnstile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { human, SITEVERIFY, ACTION } from '../src/turnstile.js';

const env = { TURNSTILE_SECRET: 'sec', MCP_HOST: 'mcp.dibs.cc' };
const answers = j => { const sent = []; return { sent, fetcher: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { json: async () => j }; } }; };

test('a token passes only when Cloudflare says so, for the email page\'s host and action', async () => {
  const ok = answers({ success: true, hostname: 'mcp.dibs.cc', action: ACTION });
  assert.equal(await human(env, 'tok', '1.2.3.4', ok.fetcher), true);
  assert.deepEqual(ok.sent, [{ url: SITEVERIFY, body: { secret: 'sec', response: 'tok', remoteip: '1.2.3.4' } }]);
  for (const j of [{ success: false, hostname: 'mcp.dibs.cc', action: ACTION }, { success: true, hostname: 'evil.example', action: ACTION }, { success: true, hostname: 'mcp.dibs.cc', action: 'other' }]) {
    assert.equal(await human(env, 'tok', 'ip', answers(j).fetcher), false, JSON.stringify(j));
  }
});

test('no secret, no token or a broken answer: no link', async () => {
  const ok = answers({ success: true, hostname: 'mcp.dibs.cc', action: ACTION });
  assert.equal(await human({ MCP_HOST: 'mcp.dibs.cc' }, 'tok', 'ip', ok.fetcher), false);
  assert.equal(await human(env, '', 'ip', ok.fetcher), false);
  assert.equal(await human(env, 'x'.repeat(3000), 'ip', ok.fetcher), false);
  assert.equal(ok.sent.length, 0, 'nothing asked of Cloudflare for those');
  assert.equal(await human(env, 'tok', 'ip', async () => { throw new Error('offline'); }), false);
});
