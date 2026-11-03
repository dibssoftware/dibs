import test from 'node:test';
import assert from 'node:assert/strict';
import { unpatched } from '../src/nodecheck.mjs';
import { NODE } from '../src/ondemand.mjs';

test('Node versions with the Brotli hole are named; fixed ones pass', () => {
  for (const v of ['22.20.0', '22.23.3', 'v24.22.0', '26.12.0', '20.19.0', '25.9.0', '23.11.1', '18.0.0']) {
    assert.match(unpatched(v), /CVE-2026-111497/, v);
  }
  for (const v of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', 'v26.12.1', '26.13.0', '27.0.0']) {
    assert.equal(unpatched(v), null, v);
  }
  assert.match(unpatched('25.9.0'), /gets no fix/);
  assert.match(unpatched('22.23.3'), /Upgrade to 22\.23\.4/);
});

test('the Node pinned for boat VMs is a fixed one', () => {
  assert.equal(unpatched(NODE.version), null);
  assert.equal(NODE.file, `node-${NODE.version}-linux-x64.tar.xz`);
});
