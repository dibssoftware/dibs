// install.sh against a release host on 127.0.0.1: the tarball's sum is always
// checked, a wrong one installs nothing, and a script cut off mid-download runs
// nothing. Release tarballs are built the way release.sh builds them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import { VERSION } from '../src/version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `v${VERSION}`;

// A release tarball of this checkout: the folders install.sh copies, under one top folder.
function tarball(dir) {
  const top = path.join(dir, 'stage', `dibs-${TAG}`);
  fs.mkdirSync(top, { recursive: true });
  for (const f of ['bin', 'src', 'LICENSE', 'README.md', 'CHANGELOG.md']) fs.cpSync(path.join(ROOT, f), path.join(top, f), { recursive: true });
  const file = path.join(dir, 'www', `dibs-${TAG}.tar.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('tar', ['-czf', file, '-C', path.join(dir, 'stage'), `dibs-${TAG}`]);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sum}  dibs-${TAG}.tar.gz\n`);
  return { file, sum };
}

async function host(t, dir) {
  const server = http.createServer((req, res) => {
    const f = path.join(dir, 'www', path.basename(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200).end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const install = (dir, env, script = path.join(ROOT, 'install.sh')) => new Promise(resolve => {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  execFile('sh', [script], {
    env: { PATH: process.env.PATH, HOME: home, DIBS_PREFIX: path.join(home, '.dibs-cli'), DIBS_BIN_DIR: path.join(home, 'bin'), DIBS_VERSION: TAG, ...env },
  }, (err, out, errOut) => resolve({ code: err ? err.code : 0, out: out + errOut, home }));
});

test('install.sh from a release host checks the .sha256 beside the tarball and installs', async t => {
  const dir = tmp(t, 'install');
  const { sum } = tarball(dir);
  const r = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`checksum ok: ${sum}`));
  assert.ok(fs.existsSync(path.join(r.home, '.dibs-cli', 'bin', 'dibs.mjs')));
  assert.equal(fs.readlinkSync(path.join(r.home, 'bin', 'dibs')), path.join(r.home, '.dibs-cli', 'bin', 'dibs.mjs'));
});

test('install.sh: a tarball that doesn\'t match its sum installs nothing', async t => {
  const dir = tmp(t, 'install');
  const { file } = tarball(dir);
  fs.appendFileSync(file, 'tampered');
  const r = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(r.home, '.dibs-cli')), false);
  assert.equal(fs.existsSync(path.join(r.home, 'bin', 'dibs')), false);
});

test('install.sh: no sum to check against installs nothing', async t => {
  const dir = tmp(t, 'install');
  const { file } = tarball(dir);
  fs.rmSync(`${file}.sha256`);
  const r = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /couldn't get the checksum/);
  assert.equal(fs.existsSync(path.join(r.home, '.dibs-cli')), false);
});

test('install.sh cut off mid-download, as curl | sh would run it, does nothing', async t => {
  const dir = tmp(t, 'install');
  const text = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const half = path.join(dir, 'half.sh');
  fs.writeFileSync(half, text.slice(0, Math.floor(text.length * 0.6)));
  const r = await install(dir, { DIBS_BASE: 'http://127.0.0.1:9' }, half);
  assert.equal(fs.existsSync(path.join(r.home, '.dibs-cli')), false);
  assert.doesNotMatch(r.out, /downloading/);
});
