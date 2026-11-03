// dibs init: dibs.md beside the install, and a marked note pointing at it in
// the agents' instruction files. Every test runs the real CLI with HOME, DIBS_HOME
// and the working folder all in temp folders, never this machine's own files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, sync, gitProject, BIN } from './helpers.mjs';

const ROOT = path.join(path.dirname(BIN), '..');
const MD = path.join(ROOT, 'dibs.md');
const read = f => fs.readFileSync(f, 'utf8');
const blocks = s => (s.match(/<!-- dibs:start -->/g) || []).length;

// A home with Claude Code (and, if asked, Codex) set up, and a repo to run in.
function place(t, { codex = false, claude = '# my rules\nbe terse\n' } = {}) {
  const home = tmp(t, 'home');
  fs.mkdirSync(path.join(home, '.claude'));
  if (claude != null) fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), claude);
  if (codex) fs.mkdirSync(path.join(home, '.codex'));
  // git names the repo by its real path (/private/var/... on macOS), and so does dibs.
  const repo = fs.realpathSync(gitProject(t, { 'CLAUDE.md': '# repo rules\n' }));
  // dibs.md goes beside the checkout these tests run from; each test takes it back out.
  t.after(() => fs.rmSync(MD, { force: true }));
  const init = (args = [], env = {}) => sync(home, ['init', ...args], { cwd: repo, env: { HOME: home, ...env } });
  return { home, repo, init, claude: path.join(home, '.claude', 'CLAUDE.md'), codex: path.join(home, '.codex', 'AGENTS.md') };
}

test('dibs init writes dibs.md from the skill and adds one note to CLAUDE.md, Codex\'s AGENTS.md and the repo\'s own files', t => {
  const p = place(t, { codex: true });
  const r = p.init();
  assert.equal(r.code, 0, r.err);
  for (const f of [MD, p.claude, p.codex, path.join(p.repo, 'CLAUDE.md')]) assert.match(r.out, new RegExp(`wrote ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(read(MD), /^# dibs: instructions for coding agents/);
  assert.match(read(MD), /## The five you need/, 'the skill\'s own text');
  assert.doesNotMatch(read(MD), /^name: dibs/m, 'without its front matter');
  assert.ok(read(p.claude).startsWith('# my rules\nbe terse\n\n<!-- dibs:start -->\n## dibs\n'));
  assert.match(read(p.claude), new RegExp(`Read ${MD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} before running builds`));
  assert.match(read(p.claude), /Docs: https:\/\/dibs\.cc\n<!-- dibs:end -->\n$/);
  assert.equal(blocks(read(p.codex)), 1, 'made when ~/.codex exists');
  assert.equal(fs.existsSync(path.join(p.repo, 'AGENTS.md')), false, 'a repo file is never made without --repo');

  const before = [p.claude, p.codex, path.join(p.repo, 'CLAUDE.md'), MD].map(read);
  const again = p.init();
  assert.match(again.out, /Nothing to change/);
  assert.deepEqual([p.claude, p.codex, path.join(p.repo, 'CLAUDE.md'), MD].map(read), before, 'a second run changes nothing');
});

test('dibs init: no ~/.codex, no Codex file; --repo makes the repo\'s CLAUDE.md when it has none', t => {
  const p = place(t);
  fs.rmSync(path.join(p.repo, 'CLAUDE.md'));
  assert.equal(p.init().code, 0);
  assert.equal(fs.existsSync(path.join(p.home, '.codex')), false);
  assert.equal(fs.existsSync(path.join(p.repo, 'CLAUDE.md')), false);
  assert.equal(p.init(['--repo']).code, 0);
  assert.equal(blocks(read(path.join(p.repo, 'CLAUDE.md'))), 1);
});

test('an upgrade replaces the old note where it is, never adds a second, and leaves every other line alone', t => {
  const old = '# my rules\n\n<!-- dibs:start -->\n## dibs\nRead /old/place/dibs.md first.\n<!-- dibs:end -->\n\n## after\nmore of mine\n';
  const p = place(t, { claude: old });
  assert.equal(p.init().code, 0);
  const now = read(p.claude);
  assert.equal(blocks(now), 1);
  assert.doesNotMatch(now, /\/old\/place/);
  assert.ok(now.startsWith('# my rules\n\n<!-- dibs:start -->\n'));
  assert.ok(now.endsWith('<!-- dibs:end -->\n\n## after\nmore of mine\n'), now);
});

test('a CRLF file keeps its line endings, inside the note too', t => {
  const p = place(t, { claude: '# mine\r\nkeep this\r\n' });
  assert.equal(p.init().code, 0);
  const s = read(p.claude);
  assert.ok(s.startsWith('# mine\r\nkeep this\r\n\r\n<!-- dibs:start -->\r\n## dibs\r\n'));
  assert.doesNotMatch(s.replace(/\r\n/g, ''), /\n/, 'no bare LF anywhere');
  assert.equal(p.init(['--remove']).code, 0);
  assert.equal(read(p.claude), '# mine\r\nkeep this\r\n');
});

test('DIBS_NO_AGENT_NOTES=1 writes nothing', t => {
  const p = place(t, { codex: true });
  const r = p.init([], { DIBS_NO_AGENT_NOTES: '1' });
  assert.equal(r.code, 0);
  assert.match(r.out, /DIBS_NO_AGENT_NOTES is set/);
  assert.equal(read(p.claude), '# my rules\nbe terse\n');
  assert.equal(fs.existsSync(p.codex), false);
  assert.equal(fs.existsSync(MD), false);
});

test('dibs init --remove takes out dibs.md and every note, and puts each file back as it was', t => {
  const p = place(t, { codex: true });
  assert.equal(p.init().code, 0);
  const r = p.init(['--remove']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /cleaned .*dibs\.md/);
  assert.equal(read(p.claude), '# my rules\nbe terse\n');
  assert.equal(read(path.join(p.repo, 'CLAUDE.md')), '# repo rules\n');
  assert.equal(blocks(read(p.codex)), 0);
  assert.equal(fs.existsSync(MD), false);
});

test('writes keep the file\'s mode and its symlink, leave no temp file, and a write that fails leaves the file whole', t => {
  const p = place(t);
  const real = path.join(tmp(t, 'dotfiles'), 'CLAUDE.md');
  fs.writeFileSync(real, '# shared from my dotfiles\n', { mode: 0o600 });
  fs.chmodSync(real, 0o600);
  fs.rmSync(p.claude);
  fs.symlinkSync(real, p.claude);
  assert.equal(p.init().code, 0);
  assert.ok(fs.lstatSync(p.claude).isSymbolicLink(), 'still a link');
  assert.equal(blocks(read(real)), 1);
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ['CLAUDE.md'], 'no temp file left beside it');

  // A folder it can't write in: the temp file can't be made, so the file keeps every byte.
  fs.writeFileSync(real, '# shared from my dotfiles\n');
  fs.chmodSync(path.dirname(real), 0o555);
  let r;
  try { r = p.init(); } finally { fs.chmodSync(path.dirname(real), 0o755); }
  assert.notEqual(r.code, 0);
  assert.equal(read(real), '# shared from my dotfiles\n');
});

test('an npm install writes dibs.md and the notes on its first command after an install or upgrade, once', t => {
  const home = tmp(t, 'home');
  fs.mkdirSync(path.join(home, '.claude'));
  const pkg = path.join(tmp(t, 'npm'), 'lib', 'node_modules', '@dibssoftware', 'dibs');
  // test/fake-simctl.mjs too: the test environment points dibs at it.
  for (const f of ['bin', 'src', 'skills', 'README.md', 'CHANGELOG.md', 'test/fake-simctl.mjs']) fs.cpSync(path.join(ROOT, f), path.join(pkg, f), { recursive: true });
  const cwd = tmp(t, 'somewhere');
  const run = () => sync(home, ['mine'], { cwd, env: { HOME: home }, bin: path.join(pkg, 'bin', 'dibs.mjs') });
  const first = run();
  assert.match(first.err, /wrote .*node_modules\/@dibssoftware\/dibs\/dibs\.md/);
  assert.match(read(path.join(home, '.claude', 'CLAUDE.md')), /node_modules\/@dibssoftware\/dibs\/dibs\.md before running builds/);
  assert.doesNotMatch(run().err, /wrote/, 'the next command writes nothing');
  // The checkout these tests run from isn't an npm install: it never writes on its own.
  assert.doesNotMatch(sync(tmp(t, 'home2'), ['mine'], { cwd, env: { HOME: home } }).err, /wrote/);
});
