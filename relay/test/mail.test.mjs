// src/mail.js: what the sign-in email says.
//   node --test test/mail.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { signinMail, deviceOf } from '../src/mail.js';

test('the sign-in email leads with the code, then the link, and says where the request came from', () => {
  const m = signinMail('https://app.dibs.cc', { token: 'T'.repeat(43), code: '042917' }, { device: 'Safari on iPhone', city: 'Austin', country: 'US' }, Date.UTC(2026, 10, 3, 15, 4));
  assert.equal(m.subject, 'Your dibs sign-in code: 042 917');
  assert.match(m.text, /^Your dibs sign-in code:\n\n {4}042 917\n/);
  assert.ok(m.text.indexOf('042 917') < m.text.indexOf('https://app.dibs.cc/account#signin='), 'code first');
  assert.match(m.text, /Asked from Safari on iPhone near Austin, US at 15:04 UTC\./);
  assert.match(m.text, /If this wasn't you, ignore this email/);
  assert.doesNotMatch(m.text, /\u2014/);
  assert.match(signinMail('o', { token: 't', code: '123456' }, null).text, /Asked from a browser at \d\d:\d\d UTC/);
});

test('the browser is named in the page\'s own words, from the User-Agent', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'), 'Chrome on Mac');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
  assert.equal(deviceOf(''), 'A browser');
});
