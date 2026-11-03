// install.ps1 against a release host on 127.0.0.1, on Windows: the tarball's sum
// is always checked, a wrong one installs nothing, a script cut off mid-download
// runs nothing, and both launchers it makes start dibs. install.test.mjs does the
// same for install.sh.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import { VERSION } from '../src/version.mjs';

const WIN = process.platform === 'win32';
const test = (name, fn) => nodeTest(name, { skip: !WIN && 'install.ps1 is for native Windows; install.test.mjs covers install.sh' }, fn);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `v${VERSION}`;
// Windows' own tar: Git Bash's GNU tar, first on a runner's PATH, reads C: as a host name.
const TAR = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// A release tarball of this checkout, built the way release.sh builds it.
function tarball(dir) {
  const top = path.join(dir, 'stage', `dibs-${TAG}`);
  fs.mkdirSync(top, { recursive: true });
  for (const f of ['bin', 'src', 'LICENSE', 'README.md', 'CHANGELOG.md']) fs.cpSync(path.join(ROOT, f), path.join(top, f), { recursive: true });
  const file = path.join(dir, 'www', `dibs-${TAG}.tar.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(TAR, ['-czf', file, '-C', path.join(dir, 'stage'), `dibs-${TAG}`]);
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

// The whole environment, Windows needs most of it, with every DIBS_ setting this run doesn't name cleared.
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DIBS_')));
const install = (dir, env, script = path.join(ROOT, 'install.ps1')) => new Promise(resolve => {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...clean(), DIBS_PREFIX: path.join(home, '.dibs-cli'), DIBS_BIN_DIR: path.join(home, 'bin'), DIBS_VERSION: TAG, ...env },
    windowsHide: true,
  }, (err, out, errOut) => resolve({ code: err ? err.code : 0, out: out + errOut, home }));
});

test('install.ps1 from a release host checks the .sha256 beside the tarball, installs, and both launchers start dibs', async t => {
  const dir = tmp(t, 'install');
  const { sum } = tarball(dir);
  const r = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`checksum ok: ${sum}`));
  assert.ok(fs.existsSync(path.join(r.home, '.dibs-cli', 'bin', 'dibs.mjs')));
  // As a person's terminal would run them, but with a home of their own: none of this suite's DIBS_ seams (its fake simctl isn't installed).
  const bin = path.join(r.home, 'bin'), env = { ...clean(), DIBS_HOME: path.join(r.home, '.dibs') };
  assert.equal(execFileSync('cmd.exe', ['/d', '/c', path.join(bin, 'dibs.cmd'), '--version'], { encoding: 'utf8', env }).trim(), VERSION);
  assert.equal(execFileSync('sh', [path.join(bin, 'dibs').replace(/\\/g, '/'), '--version'], { encoding: 'utf8', env }).trim(), VERSION, 'the Git Bash launcher');

  const again = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, new RegExp(`dibs ${TAG} is already in`));
});

test("install.ps1: a tarball that doesn't match its sum installs nothing", async t => {
  const dir = tmp(t, 'install');
  const { file } = tarball(dir);
  fs.appendFileSync(file, 'tampered');
  const r = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /checksum mismatch/);
  assert.equal(fs.existsSync(path.join(r.home, '.dibs-cli')), false);
  assert.equal(fs.existsSync(path.join(r.home, 'bin', 'dibs.cmd')), false);
});

test('install.ps1: no sum to check against installs nothing', async t => {
  const dir = tmp(t, 'install');
  const { file } = tarball(dir);
  fs.rmSync(`${file}.sha256`);
  const r = await install(dir, { DIBS_BASE: await host(t, dir) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /couldn't get the checksum/);
  assert.equal(fs.existsSync(path.join(r.home, '.dibs-cli')), false);
});

test("install.ps1 leaves a dibs.cmd it didn't make, unless told to replace it", async t => {
  const dir = tmp(t, 'install');
  fs.mkdirSync(path.join(dir, 'home', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'home', 'bin', 'dibs.cmd'), '@echo someone else\r\n');
  const r = await install(dir, { DIBS_SOURCE: ROOT });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /dibs\.cmd already exists and this script didn't make it/);
  const forced = await install(dir, { DIBS_SOURCE: ROOT, DIBS_FORCE: '1' });
  assert.equal(forced.code, 0, forced.out);
  assert.match(fs.readFileSync(path.join(dir, 'home', 'bin', 'dibs.cmd'), 'utf8'), /made by dibs install\.ps1/);
});

test('install.ps1 cut off mid-download, as irm | iex would run it, does nothing', async t => {
  const dir = tmp(t, 'install');
  const text = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  const half = path.join(dir, 'half.ps1');
  fs.writeFileSync(half, text.slice(0, Math.floor(text.length * 0.6)));
  const r = await install(dir, { DIBS_BASE: 'http://127.0.0.1:9' }, half);
  assert.equal(fs.existsSync(path.join(r.home, '.dibs-cli')), false);
  assert.doesNotMatch(r.out, /downloading/);
});
