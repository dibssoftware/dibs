// Every place a release writes its version agrees with src/version.mjs. Three
// releases in a row (0.0.96 to 0.0.98) left the README install link or the
// Mac app's version behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const found = (re, text) => text.match(re)?.[1] ?? null;

test('the version is the same in every file a release bumps, and the CHANGELOG starts with it', () => {
  const places = {
    '.claude-plugin/plugin.json version': JSON.parse(read('.claude-plugin/plugin.json')).version,
    'package.json version': JSON.parse(read('package.json')).version,
    'install.sh DEFAULT_VERSION': found(/^DEFAULT_VERSION="v([\d.]+)"/m, read('install.sh')),
    'README.md install link': found(/raw\.githubusercontent\.com\/[^/]+\/dibs\/v([\d.]+)\/install\.sh/, read('README.md')),
    'app/project.yml MARKETING_VERSION': found(/MARKETING_VERSION: "([\d.]+)"/, read('app/project.yml')),
    'CHANGELOG.md top section': found(/^## ([\d.]+)$/m, read('CHANGELOG.md')),
  };
  // The generated project must match project.yml: run xcodegen after the bump.
  const pbx = [...read('app/Dibs.xcodeproj/project.pbxproj').matchAll(/MARKETING_VERSION = ([\d.]+);/g)].map(m => m[1]);
  assert.ok(pbx.length, 'no MARKETING_VERSION in app/Dibs.xcodeproj/project.pbxproj');
  for (const [i, v] of pbx.entries()) places[`app/Dibs.xcodeproj/project.pbxproj MARKETING_VERSION #${i + 1} (run xcodegen in app/)`] = v;
  const wrong = Object.entries(places).filter(([, v]) => v !== VERSION).map(([where, v]) => `${where}: ${v ?? 'not found'}`);
  assert.deepEqual(wrong, [], `src/version.mjs says ${VERSION}, but:\n  ${wrong.join('\n  ')}`);
});


// package.json exists only so npm i -g @dibssoftware/dibs works: nothing to install and
// nothing that runs on the installing machine.
test('package.json has no dependencies and no scripts, and ships the folders install.sh ships', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'scripts']) assert.equal(pkg[k], undefined, `package.json has ${k}`);
  assert.equal(pkg.bin.dibs, 'bin/dibs.mjs');
  for (const f of ['bin/', 'src/', 'LICENSE']) assert.ok(pkg.files.includes(f), `package.json files lacks ${f}`);
});
