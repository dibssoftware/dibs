// ~/boat/checker.mjs (the boat idle checker, outside this repo) imports
// notify() and noteAs() from src/talk.mjs by path and calls them as below.
// A rename or a changed signature breaks it silently, so this fails first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './helpers.mjs';

const TALK = new URL('../src/talk.mjs', import.meta.url).href;

test("notify({ who }, once, text) and noteAs({ who, label }, text) work as the boat checker calls them", async () => {
  const { notify } = await import(TALK);
  const { noteAs } = await import(TALK);
  assert.equal(notify({ who: 'alex-zz' }, 'boat:bx_1:stopped', 'your VM bx_1 was stopped after 3 idle minutes'), true);
  assert.equal(notify({ who: 'alex-zz' }, 'boat:bx_1:stopped', 'the same notice again'), false, 'once means once');
  noteAs({ who: 'boat-checker', label: 'boat checker' }, 'stopped bx_1 (idle 3 min)');
  const s = JSON.parse(fs.readFileSync(path.join(HOME, 'messages.json'), 'utf8'));
  assert.ok(s.messages.some(m => m.kind === 'notice' && m.to === 'alex-zz' && /bx_1 was stopped/.test(m.text)));
  assert.ok(s.messages.some(m => m.kind === 'note' && /stopped bx_1/.test(m.text)));
  assert.ok(s.threads.some(th => th.who === 'boat-checker' && th.label === 'boat checker'));
});
