// The rules every agent gets first come from one place, src/primer.mjs: the
// session primer, the top of the dibs skill and docs/reference.md's "Tell your agents" carry
// the same words. If this fails, run: node -e "import('./src/primer.mjs').then(m => m.writeRules())"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './helpers.mjs';
import { DOCS, marked } from '../src/primer.mjs';
import { dibsMd } from '../src/notes.mjs';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');

test('the skill and docs/reference.md carry the primer\'s rules word for word', () => {
  for (const [f, make] of Object.entries(DOCS)) assert.ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes(marked(make())), `${f} is out of date with src/primer.mjs`);
});

test('the skill opens with the rules, and everything else is reference below them', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'dibs', 'SKILL.md'), 'utf8');
  const fold = skill.indexOf('## When you need it');
  assert.ok(fold > 0);
  assert.equal(skill.slice(0, fold).match(/^## /gm)?.length || 0, 0, 'no section above the fold');
  for (const later of ['dibs later', 'dibs pair', '--one-way "', '| 76 |']) assert.ok(skill.indexOf(later) > fold, later);
  assert.doesNotMatch(dibsMd(ROOT), /dibs:rules/, 'dibs.md has no markers in it');
});
