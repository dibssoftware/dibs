// File leases: which paths overlap, which shell commands write, and the hook
// and the line, run for real against throwaway homes and projects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { HOME, HOOK, tmp, sync, bg, until, gitProject, track, board, flat, posixOnly, realPath, sysPath, CLAUDE_UID } from './helpers.mjs';
import { overlap, clash, bashWrites, fileRes, dibsCalls } from '../src/files.mjs';
import { split, respond } from '../src/guard.mjs';

// [a, b, could one path match both]
const OVERLAP = [
  ['/r/src/a.js', '/r/src/a.js', true],
  ['/r/src/a.js', '/r/src/b.js', false],
  ['/r/src', '/r/src/a.js', true],
  ['/r/src/a.js', '/r/src', true],
  ['/r/src', '/r/srcx/a.js', false],
  ['/r/src/a.js', '/r/src/a.js.bak', false],
  ['/r/src/*.js', '/r/src/a.js', true],
  ['/r/src/*.js', '/r/src/a.ts', false],
  ['/r/src/*.js', '/r/src/sub/a.js', false],
  ['/r/src/*', '/r/src/sub/a.js', true],
  ['/r/src/**', '/r/src/sub/deep/a.js', true],
  ['/r/**/test.js', '/r/a/b/test.js', true],
  ['/r/**/*.test.js', '/r/src/**', true],
  ['/r/**', '/r', true],
  ['/r/src/*.js', '/r/src/*.ts', false],
  ['/r/src/a*', '/r/src/*b', true],
  ['/r/src/a*.js', '/r/src/b*.js', false],
  ['/r/a/*/c', '/r/a/b/*', true],
  ['/r/docs/**', '/r/src/**', false],
  ['/r/src/?.js', '/r/src/a.js', true],
  ['/r/src/?.js', '/r/src/ab.js', false],
  ['/r/app/[id]/page.tsx', '/r/app/[id]/page.tsx', true],
  ['/r/app/[id]/page.tsx', '/r/app/x/page.tsx', false],
  ['/r/**', '/other/x', false],
  ['/r', '/r2/x', false],
  ['files:/r/a', 'files:/r/a/b', true],
];

test('two file leases conflict when any path could match both: same file, a folder and what is under it, overlapping globs', () => {
  for (const [a, b, want] of OVERLAP) {
    assert.equal(overlap(a, b), want, `${a} vs ${b}`);
    assert.equal(overlap(b, a), want, `${b} vs ${a}`);
  }
  assert.equal(clash('test', 'test'), true);
  assert.equal(clash('test', 'sim'), false);
  assert.equal(clash('files:/r', 'test'), false);
  assert.equal(clash('files:/r/src/**', 'files:/r/src/a.js'), true);
});

test("braces in a file lease name each file, as the shell would, and their commas don't split the list", t => {
  // 2026-10-15: 'files:src/blocks/{catalog.ts,__tests__/catalog.test.ts}' became files:src/blocks/{catalog.ts and a
  // resource called __tests__/catalog.test.ts}, which waited on the machine like a job and leased nothing.
  const proj = gitProject(t, { 'src/blocks/catalog.ts': '' });
  const root = realPath(proj);
  const held = sync(HOME, ['hold', 'files:src/blocks/{catalog.ts,__tests__/catalog.test.ts},test', '--for', '5m', '-m', 'catalog'], { cwd: proj, agent: 'a' });
  t.after(() => sync(HOME, ['release'], { cwd: proj, agent: 'a' }));
  assert.equal(held.code, 0, held.err);
  assert.deepEqual(board(HOME).held.find(l => l.who === 'a').res,
    [`files:${root}/src/blocks/catalog.ts`, `files:${root}/src/blocks/__tests__/catalog.test.ts`, 'test']);
  // Another agent's lease on the second file has to wait.
  assert.equal(sync(HOME, ['hold', 'files:src/blocks/__tests__/catalog.test.ts', '--no-wait'], { cwd: proj, agent: 'b' }).code, 75);
  // The guard reads the same list.
  assert.deepEqual(dibsCalls("dibs hold 'files:src/{a,b/c}.ts' -m x", split, proj)[0].res, [`files:${root}/src/a.ts`, `files:${root}/src/b/c.ts`]);
});

test('files: paths are taken from the git root, wherever in the project you are', t => {
  const proj = gitProject(t, { 'src/a.js': '', 'docs/x.md': '' });
  const root = realPath(proj);
  assert.equal(fileRes('files:src/a.js', path.join(proj, 'docs')), `files:${root}/src/a.js`);
  assert.equal(fileRes('files:src/**', proj), `files:${root}/src/**`);
  assert.equal(fileRes('files:/abs/x/', proj), `files:${sysPath(path.resolve(proj, '/abs/x'))}`);
  assert.equal(fileRes('files:~/notes', proj), `files:${sysPath(os.homedir())}/notes`);
  assert.equal(fileRes('files:', proj), null);
  assert.equal(fileRes('test', proj), 'test');
});

// [command, paths it writes, from /w]
const WRITES = [
  ['echo hi > out.txt', ['/w/out.txt']],
  ['echo hi >> logs/a.log', ['/w/logs/a.log']],
  ['echo x >| f', ['/w/f']],
  ['make &> build.log', ['/w/build.log']],
  ['cat <<EOF > notes.md\nhello\nEOF', ['/w/notes.md']],
  ['npm test 2>&1 | tee test.log', ['/w/test.log']],
  ['rm -rf build dist', ['/w/build', '/w/dist']],
  ['rm src/*.js', ['/w/src/*.js']],
  ['rm -- -weird', ['/w/-weird']],
  ['mv a.txt b.txt', ['/w/a.txt', '/w/b.txt']],
  ['cp -r src/ /tmp/copy', ['/tmp/copy']],
  ['cp -t dest a b', ['/w/dest/a', '/w/dest/b']],
  ['mv new.ts src/', ['/w/new.ts', '/w/src/new.ts']],
  ['ln -s ../x.ts src/', ['/w/src/x.ts']],
  ['cp -R lib/ src/', ['/w/src']],
  ['ln -s target link', ['/w/link']],
  ["sed -i '' 's/a/b/' src/x.js", ['/w/src/x.js']],
  ["sed -i 's/a/b/' x.js y.js", ['/w/x.js', '/w/y.js']],
  ["sed -i.bak -e 's/a/b/' x.js", ['/w/x.js']],
  ["sed -Ei 's/a/b/' x.js", ['/w/x.js']],
  ["perl -pi -e 's/a/b/' x.pl", ['/w/x.pl']],
  ['touch new.txt', ['/w/new.txt']],
  ['truncate -s 0 big.log', ['/w/big.log']],
  ['dd if=/dev/zero of=disk.img bs=1m count=1', ['/w/disk.img']],
  ['cd sub && rm x', ['/w/sub/x']],
  ['cd /abs && rm x', ['/abs/x']],
  ['cd $DIR && rm /abs/x', ['/abs/x']],
  ['git checkout -- src/a.js', ['/w/src/a.js']],
  ['git rm old.js', ['/w/old.js']],
  ['git mv a.js b.js', ['/w/a.js', '/w/b.js']],
  ['git restore --staged --worktree x.js', ['/w/x.js']],
  ['git restore .', ['/w']],
  ['git checkout -f', ['/w']],
  ['git checkout -f main', ['/w']],
  ['git switch -f main', ['/w']],
  ['git switch --discard-changes main', ['/w']],
  ['git pull --rebase --autostash', ['/w']],
  ['git rebase --autostash origin/main', ['/w']],
  ['rm ~/notes.txt', [`${os.homedir()}/notes.txt`]],
  ['sudo rm /etc/x', ['/etc/x']],
  ['FOO=1 rm x', ['/w/x']],
  ['if true; then rm x; fi', ['/w/x']],
  ['git pull && echo done > status.txt', ['/w/status.txt']],
  ['git -C proj checkout -- src/a.js', ['/w/proj/src/a.js']],
  ['git -C /abs rm x', ['/abs/x']],
  ['git stash', ['/w']],
  ['git stash pop', ['/w']],
  ['git reset --hard origin/main', ['/w']],
  ['git apply fix.diff', ['/w']],
  ['git apply -', ['/w']],
  ['find build -name "*.o" -delete', ['/w/build']],
  ['find logs -mmin +60 | xargs rm', ['/w/logs']],
  ['S=/abs/out; rm -rf $S/x "${S}/y"', ['/abs/out/x', '/abs/out/y']],
  ['export D=/abs && rm $D/z', ['/abs/z']],
  ['find -type f -exec rm -f {} +', ['/w']],
  ['find /abs logs -mtime +3 -execdir rm {} ;', ['/abs', '/w/logs']],
  ['rsync -a --delete src/ dest/', ['/w/dest']],
  ['cat fix.diff | git apply', ['/w']],
  ['git am --continue', ['/w']],
  ['git clean -fd', ['/w']],
  ['patch -p1 < fix.diff', ['/w']],
  ['cat fix.diff | patch -p1', ['/w']],
  ['patch -p1 x.c fix.diff', ['/w/x.c']],
  ['patch -p1 -o out.c < fix.diff', ['/w/out.c']],
  ['(cd sub && ls); echo x > a', ['/w/a']],
  ['(cd src && ls) && echo x > a.ts', ['/w/a.ts']],
  ['cd src; cd -; echo x > src/a.ts', ['/w/src/a.ts']],
  ['pushd sub; rm x; popd; rm y', ['/w/sub/x', '/w/y']],
  ["timeout 5 sed -i '' s/a/b/ src/a.ts", ['/w/src/a.ts']],
  ['gtimeout -s KILL 5 rm x', ['/w/x']],
  ['caffeinate -i rm x', ['/w/x']],
  ["echo src/a.ts | xargs sed -i '' s/a/b/", ['/w/src/a.ts']],
  ['npx prettier --write src', ['/w/src']],
  ['pnpm exec eslint --fix a.ts', ['/w/a.ts']],
  ['eslint --fix', ['/w']],
  ['swiftformat Sources', ['/w/Sources']],
  ['gofmt -w x.go', ['/w/x.go']],
  ['ruff format', ['/w']],
];

const NO_WRITES = [
  'cat a.txt',
  'grep -rn foo src',
  'ls > /dev/null',
  'npm test 2>&1',
  'cmd 2>/dev/null',
  'echo oops >&2',
  'sort < in.txt',
  'cat <<< "hi"',
  'sed s/a/b/ x.js',
  'sed -n p x.js',
  'echo "rm -rf src"',
  'git checkout main',
  'git status',
  'rm $FILE',
  'rm "$(ls)"',
  'cd $DIR && rm x',
  'echo $(rm x)',
  'cp onlyone',
  'node --test test/*.test.mjs',
  'echo "unterminated',
  'git stash list',
  'find . -name x',
  'find . -type f -exec grep -l x {} +',
  'git restore --staged x.js',
  'git switch main',
  'git pull --rebase',
  'git rebase origin/main',
  'git reset HEAD~1',
  'git apply --check fix.diff',
  'git clean -n',
  'patch --dry-run -p1 < fix.diff',
  'prettier --check src',
  'eslint src',
  'swiftformat --lint .',
  'gofmt -l x.go',
  'ruff check',
  'cd -; rm x',
];

test('Bash commands that obviously write a file are caught, and reads are left alone', () => {
  const paths = cmd => bashWrites(cmd, split, '/w').map(x => x.path);
  for (const [cmd, want] of WRITES) assert.deepEqual(paths(cmd), want.map(sysPath), cmd);
  for (const cmd of NO_WRITES) assert.deepEqual(paths(cmd), [], cmd);
});

// The hook binary, as Claude Code runs it, as agent `agent` (none: no name).
function hook(home, input, agent) {
  const env = { ...process.env, DIBS_HOME: home, DIBS_AGENT: agent };
  if (!agent) delete env.DIBS_AGENT;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return { decision: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null, ms: Date.now() - t0 };
}
const edit = (cwd, file, tool = 'Edit') =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, cwd, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } });
const bash = (cwd, command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, permission_mode: 'default', tool_input: { command } });

test("an edit under another session's file lease is denied, naming the holder; the holder's own edits and unleased paths go through", t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '', 'README.md': '' });
  const h = sync(home, ['hold', 'files:src/**', '-m', 'auth refactor'], { agent: 'bob', cwd: path.join(proj, 'src') });
  assert.equal(h.code, 0, h.err);
  assert.match(h.out, /^Reserved for you until .*: files in src\.[\s\S]*\n  Other agents' edits there are turned away/);
  assert.match(h.out, /More time: dibs hold 'files:src\/\*\*' --for 20m {4}Done: dibs release 'files:src\/\*\*'/);

  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const { decision } = hook(home, edit(proj, path.join(proj, 'src', 'a.js'), tool), 'alice');
    assert.equal(decision?.permissionDecision, 'deny', tool);
    const why = decision.permissionDecisionReason;
    assert.match(why, /src\/a\.js is leased to bob for "auth refactor"/);
    assert.match(why, /held \d+s, until /);
    assert.match(why, /dibs when 'files:src\/\*\*'/, 'quoted, so zsh leaves the glob alone');
  }
  assert.equal(hook(home, edit(proj, path.join(proj, 'src', 'a.js')), 'bob').decision, null, "bob's own edit");
  assert.equal(hook(home, edit(proj, path.join(proj, 'README.md')), 'alice').decision, null, 'outside the lease');
  assert.equal(hook(home, { tool_name: 'Read', cwd: proj, tool_input: { file_path: path.join(proj, 'src', 'a.js') } }, 'alice').decision, null, 'reads');
  // A relative path and the folder itself are under the lease too.
  assert.equal(hook(home, edit(proj, 'src/new.js', 'Write'), 'alice').decision?.permissionDecision, 'deny');
  assert.equal(hook(home, bash(proj, 'rm -rf src'), 'alice').decision?.permissionDecision, 'deny');
  assert.equal(hook(home, bash(path.join(proj, 'src'), "sed -i '' s/a/b/ a.js"), 'alice').decision?.permissionDecision, 'deny');
  assert.equal(hook(home, bash(proj, 'cat src/a.js > /dev/null && echo ok > README.md'), 'alice').decision, null);

  assert.equal(sync(home, ['release', 'files:src/**'], { agent: 'bob', cwd: proj }).code, 0);
  assert.equal(hook(home, edit(proj, path.join(proj, 'src', 'a.js')), 'alice').decision, null, 'after release');
});

// A state file with one file lease, as dibs writes it.
function lease(home, file, fields) {
  const t = Date.now();
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ seq: 1, queue: [],
    leases: [{ id: 1, res: [`files:${file}`], kind: 'hold', who: 'other', agent: 'other', purpose: 'x', start: t, expires: t + 6e5, ...fields }] }));
}

test("leases belong to the agent session: the session running the hook may edit, another live session may not, a dead or expired one doesn't count", t => {
  const home = tmp(t), dir = realPath(tmp(t, 'src'));
  const file = path.join(dir, 'a.js');
  // This test process is an ancestor of the hook, as Claude Code is of its hooks.
  lease(home, dir, { pid: process.pid, spid: process.pid });
  assert.equal(hook(home, edit(dir, file)).decision, null);
  const other = track(t, spawn('sleep', ['60'], { stdio: 'ignore' }));
  lease(home, dir, { pid: other.pid, spid: other.pid });
  assert.equal(hook(home, edit(dir, file)).decision?.permissionDecision, 'deny');
  other.kill('SIGKILL');
  lease(home, dir, { pid: 999999, spid: 999999 });
  assert.equal(hook(home, edit(dir, file)).decision, null, 'holder gone');
  lease(home, dir, { pid: null, expires: Date.now() - 1000 });
  assert.equal(hook(home, edit(dir, file)).decision, null, 'hold expired');
});

test('the hook reads leases without the state lock, and stays fast', async t => {
  const home = tmp(t), dir = realPath(tmp(t, 'src'));
  lease(home, dir, { pid: null });
  // A live process holding the lock: anything that waited for it would hang for 30s.
  fs.mkdirSync(path.join(home, 'lock'));
  fs.writeFileSync(path.join(home, 'lock', 'pid'), String(process.pid));
  const r = hook(home, edit(dir, path.join(dir, 'a.js')));
  assert.equal(r.decision?.permissionDecision, 'deny');
  assert.ok(r.ms < 2000, `hook took ${r.ms} ms`);

  // In-process, past Node's start: the hook's own work on each tool call.
  lease(HOME, dir, { pid: null });
  t.after(() => fs.rmSync(path.join(HOME, 'state.json'), { force: true }));
  const N = 200, t0 = performance.now();
  for (let i = 0; i < N; i++) assert.equal(respond(edit(dir, path.join(dir, 'a.js'))).hookSpecificOutput.permissionDecision, 'deny');
  for (let i = 0; i < N; i++) assert.equal(respond(bash(dir, 'echo hi > /tmp/elsewhere.txt')), null);
  const each = (performance.now() - t0) / (2 * N);
  assert.ok(each < 5, `${each.toFixed(2)} ms per call`);
});

test('a broken state file lets the edit through and leaves a line in guard.log', t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'state.json'), '{ half');
  assert.equal(hook(home, edit(home, path.join(home, 'a.js'))).decision, null);
  assert.match(fs.readFileSync(path.join(home, 'guard.log'), 'utf8'), /JSON/);
});

test('file leases queue like holds: overlapping paths wait, separate ones and your own go straight through, and the board shows them', t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '', 'docs/x.md': '' });
  const as = (agent, ...args) => sync(home, args, { agent, cwd: proj });
  assert.equal(as('bob', 'hold', 'files:src/**', '-m', 'refactor').code, 0);

  const blocked = as('alice', 'hold', 'files:src/a.js', '--no-wait');
  assert.equal(blocked.code, 75);
  assert.match(blocked.err, /not free yet\. Waiting for bob to finish with the files in src, which include src\/a\.js \(up to \d+ min left\)\. --no-wait doesn't wait/);
  assert.equal(as('alice', 'hold', 'files:docs/x.md', '--no-wait').code, 0, 'a path nobody holds');
  assert.equal(as('bob', 'hold', 'files:src/a.js', '--no-wait').code, 0, 'inside your own lease');

  const who = as('carol', 'who', 'files:src/a.js');
  assert.match(who.out, /^Files in src\/a\.js {3}bob has reserved them, up to \d+ min left\n +Nobody waiting\n +bob: "refactor", reserved, started (just now|.* ago) \(src\/\*\*, src\/a\.js\)\n$/);
  assert.match(flat(as('carol', 'when', 'files:src/a.js').out), /^You'd be next in the queue for files in src\/a\.js, as soon as bob finishes\. You'd wait for bob to finish with the files in src, which include src\/a\.js/);
  assert.match(as('carol', 'when', 'files:README.md').out, /^Free now: files in README\.md\. Take it: dibs run files:README\.md -- <command>\n$/);
  const root = realPath(proj);
  const b = board(home, { cwd: proj });
  assert.deepEqual(b.held.map(l => [l.who, l.res]), [['bob', [`files:${root}/src/**`]], ['alice', [`files:${root}/docs/x.md`]], ['bob', [`files:${root}/src/a.js`]]]);
  assert.equal(b.machine.memHandedOut, 0, 'file leases take no memory from the budget');
  assert.match(as('carol', '--detail').out, /HELD\n {2}files:src\/\*\* +bob .*"refactor"/);

  assert.equal(as('bob', 'release').code, 0);
  assert.equal(as('alice', 'hold', 'files:src/a.js', '--no-wait').code, 0);
  assert.equal(as('alice', 'run', 'files:src/a.js,test', '--', 'true').code, 0, 'a run covered by your own file lease');
  assert.equal(as('alice', 'run', 'files:src/a.js', '--anywhere', '--', 'true').code, 2, "file leases stay on this machine");
});

test("a waiter's board row names the file lease it's waiting on", async t => {
  const home = tmp(t), proj = gitProject(t, { 'src/auth/login.ts': '' });
  assert.equal(sync(home, ['hold', 'files:src/auth/**', '-m', 'auth'], { agent: 'bob', cwd: proj }).code, 0);
  bg(t, home, ['hold', 'files:src/auth/login.ts', '--max-wait', '30s'], { agent: 'alice', cwd: proj });
  await until(() => board(home, { cwd: proj }).waiting.length === 1);
  assert.match(sync(home, ['--detail'], { agent: 'carol', cwd: proj }).out, /files:src\/auth\/login\.ts +alice .*\[blocked by files: src\/auth\/\*\*\]/);
});

// A tool call from one agent of a session: a subagent's id, or none for the main thread.
const from = (input, session, agent) => ({ ...input, session_id: session, ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}) });

test('the guard sees which dibs calls in a Bash command take file leases, named as dibs will name them', t => {
  const proj = gitProject(t, { 'src/a.js': '' });
  const root = realPath(proj);
  const calls = cmd => dibsCalls(cmd, split, path.join(proj, 'src'));
  const key = (verb, ...words) => `${verb}|${words.join('\0')}`;
  assert.deepEqual(calls('dibs hold files:src/** -m "auth"'), [{ verb: 'hold', res: [`files:${root}/src/**`], key: key('hold', 'files:src/**', '-m', 'auth') }]);
  assert.deepEqual(calls('cd .. && ~/bin/dibs run files:a.js,files:b.js,test -- npm test'),
    [{ verb: 'run', res: [`files:${root}/a.js`, `files:${root}/b.js`], key: key('run', 'files:a.js,files:b.js,test', '--', 'npm', 'test') }]);
  assert.deepEqual(calls('dibs files:x -- make'), [{ verb: 'run', res: [`files:${root}/x`], key: key('run', 'files:x', '--', 'make') }]);
  assert.deepEqual(calls('dibs release'), [{ verb: 'release', res: [], key: key('release') }]);
  // Every lease and look at the queue is noted, so dibs can tell a session's subagents apart.
  assert.deepEqual(calls('dibs sim -- make'), [{ verb: 'run', res: [], key: key('run', 'sim', '--', 'make') }]);
  assert.deepEqual(calls('dibs renew sim --for 20m'), [{ verb: 'hold', res: [], key: key('hold', 'sim', '--for', '20m') }]);
  assert.deepEqual(calls('dibs why && dibs --json'), [{ verb: 'why', res: [], key: key('why') }, { verb: 'status', res: [], key: key('status', '--json') }]);
  assert.deepEqual(calls('dibs run test -- npm test $X'), [{ verb: 'run', res: [], key: key('run', 'test', '--', 'npm', 'test', '\u0001') }], "a word the hook can't read");
  for (const cmd of ['echo dibs hold files:x', 'git commit -m "dibs hold files:x"', 'dibs sims', 'dibs help'])
    assert.deepEqual(calls(cmd), [], cmd);
});

test('subagents of one session are separate agents: the one that took a lease may edit, its siblings and the main thread may not', t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '', 'src/b.js': '', 'docs/x.md': '' });
  const S = 'session-1', file = path.join(proj, 'src', 'a.js');
  // What Claude Code does: the hook sees the Bash call, then the command runs in the same session.
  const take = (agent, ...args) => {
    hook(home, from(bash(proj, `dibs ${args.join(' ')}`), S, agent));
    return sync(home, args, { agent: 'pm', cwd: proj, env: { CLAUDE_CODE_SESSION_ID: S } });
  };
  const h = take('sub-a', 'hold', 'files:src/**', '-m', 'payments');
  assert.equal(h.code, 0, h.err);
  assert.match(flat(h.out), /\(held as pm \(general-purpose\)\)/);

  assert.equal(hook(home, from(edit(proj, file), S, 'sub-a')).decision, null, 'the subagent that holds it');
  const sibling = hook(home, from(edit(proj, file), S, 'sub-b')).decision;
  assert.equal(sibling?.permissionDecision, 'deny');
  assert.match(sibling.permissionDecisionReason, /leased to pm's subagent sub-a \(general-purpose\) for "payments"/);
  assert.match(sibling.permissionDecisionReason, /Another agent of your own session holds it/);
  assert.equal(hook(home, from(edit(proj, file), S)).decision?.permissionDecision, 'deny', 'the main thread is an agent too');
  assert.equal(hook(home, from(edit(proj, file), 'session-2', 'sub-a')).decision?.permissionDecision, 'deny', 'same agent id, other session');
  assert.equal(hook(home, from(bash(proj, 'rm src/b.js'), S, 'sub-b')).decision?.permissionDecision, 'deny');

  // In line: the sibling waits, the holder doesn't, and nobody releases someone else's lease.
  const waits = take('sub-b', 'hold', 'files:src/b.js', '--no-wait');
  assert.equal(waits.code, 75);
  assert.match(waits.err, /Waiting for pm\/"payments" to finish with the files in src, which include src\/b\.js/, 'a general-purpose sibling goes by its -m reason, not the session it shares');
  assert.equal(take('sub-b', 'hold', 'files:docs/x.md', '--no-wait').code, 0);
  assert.equal(take('sub-a', 'hold', 'files:src/b.js', '--no-wait').code, 0, 'inside its own lease');
  assert.equal(take('sub-b', 'release', 'files:src/**').code, 1, "a sibling can't release it");
  assert.equal(take(null, 'run', 'files:src/a.js', '--no-wait', '--', 'true').code, 75, 'nor can the main thread run under it');
  assert.equal(take('sub-a', 'release').code, 0);
  assert.equal(hook(home, from(edit(proj, file), S, 'sub-b')).decision, null, 'free once released');
  assert.equal(hook(home, from(edit(proj, path.join(proj, 'docs', 'x.md')), S, 'sub-a')).decision?.permissionDecision, 'deny', "sub-b's lease still stands");
});

test("a lease the main thread took covers its own subagents, but a subagent's lease keeps the main thread out", t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '', 'docs/x.md': '' });
  const S = 'session-1', file = path.join(proj, 'src', 'a.js');
  const take = (agent, ...args) => {
    hook(home, from(bash(proj, `dibs ${args.join(' ')}`), S, agent));
    return sync(home, args, { agent: 'pm', cwd: proj, env: { CLAUDE_CODE_SESSION_ID: S } });
  };
  assert.equal(take(null, 'hold', 'files:src/**', '-m', 'payments').code, 0);
  for (const agent of [null, 'sub-a', 'sub-b']) assert.equal(hook(home, from(edit(proj, file), S, agent)).decision, null, String(agent));
  assert.equal(hook(home, from(edit(proj, file), 'session-2', 'sub-a')).decision?.permissionDecision, 'deny', 'another session');
  assert.equal(take('sub-a', 'hold', 'files:src/a.js', '--no-wait').code, 0, "a subagent doesn't wait on its lead's lease");
  assert.equal(take('sub-b', 'release', 'files:src/**').code, 1, "but can't release it");

  assert.equal(take('sub-b', 'hold', 'files:docs/**').code, 0);
  const lead = hook(home, from(edit(proj, path.join(proj, 'docs', 'x.md')), S)).decision;
  assert.equal(lead?.permissionDecision, 'deny');
  assert.match(lead.permissionDecisionReason, /Your own subagent sub-b holds it: wait for it to finish, or have it run dibs release/);
});

test('on macOS a path in another letter case is the same file, for edits and for leases', { skip: process.platform !== 'darwin' && "macOS's disks ignore case; Linux's don't" }, t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '', 'README.md': '' });
  assert.equal(sync(home, ['hold', 'files:src/a.js,files:README.md'], { agent: 'bob', cwd: proj }).code, 0);
  for (const input of [edit(proj, path.join(proj, 'SRC', 'A.js')), edit(proj, path.join(proj, 'readme.md'), 'Write'), bash(proj, 'echo x > SRC/a.js')])
    assert.equal(hook(home, input, 'alice').decision?.permissionDecision, 'deny', JSON.stringify(input.tool_input));
  assert.equal(sync(home, ['hold', 'files:SRC/A.js', '--no-wait'], { agent: 'carol', cwd: proj }).code, 75);
  assert.equal(overlap('/r/SRC/new.ts', '/r/src/new.ts'), true, "a file that doesn't exist yet");
});

test('writes through git -C, git checkout ., stash, formatters, prefixes, xargs and subshells are turned away; copies into a leased folder under a new name go through', t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '', 'docs/x.md': '', 'new.js': '' });
  assert.equal(sync(home, ['hold', 'files:src/a.js'], { agent: 'bob', cwd: proj }).code, 0);
  const deny = cmd => hook(home, bash(proj, cmd), 'alice').decision?.permissionDecision;
  for (const cmd of ['git checkout .', 'git checkout src/a.js', 'git stash', 'git reset --hard', 'npx prettier --write src', 'eslint --fix',
    "timeout 5 sed -i '' s/a/b/ src/a.js", 'echo src/a.js | xargs rm', '(cd docs && ls); echo x > src/a.js', 'cp -R docs/ src/'])
    assert.equal(deny(cmd), 'deny', cmd);
  assert.equal(hook(home, bash(path.dirname(proj), `git -C ${path.basename(proj)} checkout -- src/a.js`), 'alice').decision?.permissionDecision, 'deny', 'git -C');
  for (const cmd of ['mv new.js src/', 'cp new.js src', 'ln -s ../new.js src/', 'git checkout main', '(cd src && ls) && echo x > a.js', 'prettier --check src'])
    assert.equal(deny(cmd), undefined, cmd);
});

test('a lease taken without the guard seeing it belongs to the whole session, and old notes are not used', t => {
  const home = tmp(t), proj = gitProject(t, { 'src/a.js': '' });
  const S = 'session-1', file = path.join(proj, 'src', 'a.js');
  // A note older than its life, from a call that never ran.
  fs.mkdirSync(path.join(home, 'agents'));
  const old = path.join(home, 'agents', '1000-1-x.json');
  fs.writeFileSync(old, JSON.stringify({ at: Date.now() - 11 * 6e4, session: S, agent: 'sub-a', type: null, key: `hold|files:${realPath(proj)}/src/**` }));
  assert.equal(sync(home, ['hold', 'files:src/**'], { agent: 'pm', cwd: proj, env: { CLAUDE_CODE_SESSION_ID: S } }).code, 0);
  assert.ok(!fs.existsSync(old), 'pruned');
  for (const agent of ['sub-a', 'sub-b', null]) assert.equal(hook(home, from(edit(proj, file), S, agent)).decision, null, String(agent));
  assert.equal(hook(home, from(edit(proj, file), 'session-2', 'sub-a')).decision?.permissionDecision, 'deny');
});

// ----- other sessions' temp folders -----

test("deletes and writes in another Claude Code session's temp folder are turned away; the session's own folder and reads are not", t => {
  // Paths only: nothing is created under the real temp folder.
  const root = `${process.platform === 'win32' ? sysPath('/tmp') : realPath('/tmp')}/claude-${CLAUDE_UID}`, me = 'sess-mine', proj = '-Users-x-proj';
  const mine = `${root}/${proj}/${me}`, theirs = `${root}/${proj}/sess-theirs`;
  const home = tmp(t);
  const as = input => hook(home, { ...input, session_id: me }).decision;
  const deny = input => {
    const d = as(input);
    assert.equal(d?.permissionDecision, 'deny', JSON.stringify(input.tool_input));
    return d.permissionDecisionReason;
  };
  const why = deny(bash('/', `rm -rf ${theirs}`));
  assert.match(why, new RegExp(`^dibs: ${theirs} is in another Claude Code session's scratch folder, so rm can't delete or write there\\. The person's rule: never delete or overwrite anything under ${root} except in your own session's folder \\(${me}\\)\\.`));
  assert.match(why, /Ask the person, or that session, instead\. Reading them is fine\.$/);
  for (const cmd of [`rm -r ${theirs}/live-smoke`, `find ${theirs} -name '*.log' -delete`, `find ${root}/${proj} -mtime +1 -exec rm -rf {} +`,
    `rm -rf /tmp/claude-${CLAUDE_UID}/${proj}/sess-theirs/tester.log`, `rm -rf ${root}/*`, `rm -rf ${root}/${proj}/*`, `rm -rf ${root}`, `rm -rf ${root}/${proj}`,
    `echo x > ${theirs}/out.txt`, `truncate -s 0 ${theirs}/tester.log`, `mv ${theirs}/a ${mine}/a`, `rsync -a --delete ${mine}/ ${theirs}/`,
    `ls ${theirs} | xargs rm`, `cd ${theirs} && rm -rf build`, `rm -rf "${theirs}/$NAME"`])
    deny(bash('/', cmd));
  deny(edit('/', `${theirs}/notes.md`, 'Write'));
  deny(edit(theirs, 'notes.md'));
  for (const cmd of [`rm -rf ${mine}/scratchpad/x`, `find ${mine}/scratchpad/x -delete`, `echo x > ${mine}/out.txt`, `rm ${mine}/out.txt`, `cp ${theirs}/a ${mine}/a`,
    `cat ${theirs}/tester.log`, `ls -la ${root}/${proj}`, `rm -rf "${root}/${proj}/$SESSION"`, 'rm -rf "$TMPDIR/x"', 'rm -rf build'])
    assert.equal(as(bash('/', cmd)), null, cmd);
  assert.equal(as(edit('/', `${mine}/notes.md`, 'Write')), null);
});

// These paths go into shell commands, so they're written with / on Windows too, as Claude Code's
// Git Bash commands write them (realPath gives the root that way).
test("any agent of a session may delete anything in its own scratchpad, however old and whoever made it; the scratchpad itself and the session folder stay whole", t => {
  const base = tmp(t, 'claude-tmp'), home = tmp(t), S = 'sess-1';
  const folder = path.posix.join(realPath(base), `claude-${CLAUDE_UID}`, '-Users-x-proj', S), pad = path.posix.join(folder, 'scratchpad');
  const fill = (dir, n) => { fs.mkdirSync(dir, { recursive: true }); for (let i = 0; i < n; i++) fs.writeFileSync(path.posix.join(dir, `f${i}`), ''); };
  // 2e on 2026-11-04: six browser profiles a teammate made before dibs's record, 850 MB at 4.9 GB free.
  for (let i = 1; i <= 6; i++) fill(path.posix.join(pad, `r7-profile-${i}`, 'Default'), 30);
  fill(path.posix.join(pad, 'old'), 25);
  // The hook as Claude Code runs it, for one agent of the session (none: the main thread).
  const call = (agent, input) => {
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: { ...process.env, DIBS_HOME: home, DIBS_CLAUDE_TMP: base },
      input: JSON.stringify({ ...input, session_id: S, ...(agent ? { agent_id: agent, agent_type: `${agent}-worker` } : {}) }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  assert.equal(call(null, bash(pad, `rm -rf ${pad}/r7-profile-1`)), null, 'the main thread, a folder older than the record');
  assert.equal(call('a-lead', bash(pad, 'rm -rf old && find r7-profile-2 -name "*.log" -delete')), null);
  assert.equal(call('a-lead', bash(pad, 'rm -rf r7-profile-*')), null, 'a teammate, a glob of them');

  assert.equal(call('a-smoke', bash(pad, 'mkdir -p live-smoke && echo ok > live-smoke/run.log')), null);
  fill(path.posix.join(pad, 'live-smoke'), 25);
  assert.equal(JSON.parse(fs.readFileSync(path.posix.join(home, 'scratch', S, 'live-smoke'), 'utf8')).agent, 'a-smoke', 'the disk watcher still learns who made it');
  for (const cmd of [`rm -rf ${pad}/live-smoke`, 'find live-smoke -delete', 'rm -r ./live-smoke', 'rsync -a --delete empty/ live-smoke/', 'rm -rf live-smoke/*'])
    assert.equal(call('a-tester', bash(pad, cmd)), null, `a sibling's folder: ${cmd}`);

  for (const cmd of [`rm -rf ${pad}`, `rm -rf ${folder}`, 'rm -rf ../scratchpad', `find ${pad} -delete`, `rm -rf ${pad}/*`, `rm -rf ${pad}/.*`]) {
    const d = call('a-smoke', bash(pad, cmd));
    assert.equal(d?.permissionDecision, 'deny', cmd);
    assert.match(d.permissionDecisionReason, /every agent of your session keeps its scratch files in, so (rm|find) can't delete all of it\.\nDelete the folders in it you are done with instead/, cmd);
  }
  // interop's sweeps on 2026-10-16: filters don't make a sweep of the scratchpad safe, and a variable dibs can't see is refused.
  const sweep = "find $S -mindepth 1 -maxdepth 1 -mmin +180 ! -name '*.patch' -exec rm -rf {} +";
  for (const cmd of [`S=${pad}; ${sweep}`, `export S=${pad} && ${sweep}`, `find ${pad} -mindepth 1 -type d -mmin +600 -exec rm -rf {} +`,
    `find ${pad} -mindepth 1 -type d -mmin +600 | xargs rm -rf`, `find ${pad} -mindepth 1 -maxdepth 1 -delete`]) {
    const d = call('a-smoke', bash('/', cmd));
    assert.match(d?.permissionDecisionReason ?? '', /is your session's scratchpad, which every agent of your session keeps its scratch files in/, cmd);
  }
  for (const cmd of [sweep, 'rm -rf $S', 'rm -rf "$S"/*', 'rm -rf "${S}/"', 'rm -rf "$(pwd)"']) {
    const d = call('a-smoke', bash(pad, cmd));
    assert.equal(d?.permissionDecision, 'deny', cmd);
    assert.match(d.permissionDecisionReason, /named only by a variable dibs can't see the value of[\s\S]*Write the path out/, cmd);
  }
  assert.equal(call('a-smoke', bash(pad, 'rm -rf "$S/build"')), null, 'a variable with a literal end');

  // Another session's scratchpad stays off limits, however small the folder.
  const theirs = path.posix.join(path.dirname(folder), 'sess-other', 'scratchpad', 'chrome');
  fill(theirs, 1);
  assert.equal(call(null, bash(pad, `rm -rf ${theirs}`))?.permissionDecision, 'deny', "another session's folder");

  // Records go with the session's folder.
  fs.rmSync(folder, { recursive: true });
  fs.mkdirSync(path.posix.join(path.dirname(folder), 'sess-2', 'scratchpad'), { recursive: true });
  const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: { ...process.env, DIBS_HOME: home, DIBS_CLAUDE_TMP: base },
    input: JSON.stringify({ ...bash('/', `mkdir ${path.posix.join(path.dirname(folder), 'sess-2', 'scratchpad', 'x')}`), session_id: 'sess-2' }) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.posix.join(home, 'scratch')), ['sess-2']);
});

test('a folder a program made in the scratchpad is recorded as made by the agent whose command named it, so the disk watcher can name it', t => {
  const base = tmp(t, 'claude-tmp'), home = tmp(t), S = 'sess-1';
  const folder = path.posix.join(realPath(base), `claude-${CLAUDE_UID}`, '-Users-x-proj', S), pad = path.posix.join(folder, 'scratchpad');
  fs.mkdirSync(pad, { recursive: true });
  const call = (agent, input) => {
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: { ...process.env, DIBS_HOME: home, DIBS_CLAUDE_TMP: base },
      input: JSON.stringify({ ...input, session_id: S, ...(agent ? { agent_id: agent, agent_type: agent.replace(/^a|-\d+$/g, '') } : {}) }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const made = name => { try { return JSON.parse(fs.readFileSync(path.posix.join(home, 'scratch', S, encodeURIComponent(name)), 'utf8')); } catch { return null; } };
  const fill = (dir, n) => { fs.mkdirSync(dir, { recursive: true }); for (let i = 0; i < n; i++) fs.writeFileSync(path.posix.join(dir, `f${i}`), ''); };
  // fix-app's build on 2026-10-18: xcodebuild, not a write dibs can see, made 0.5 GB under scratchpad/dd-flip.
  const dd = path.posix.join(pad, 'dd-flip');
  assert.equal(call('afix-app-12345', bash('/Users/x/app', `~/bin/dibs run xcode-build -m "flip build" -- xcodebuild -project App.xcodeproj -scheme App -derivedDataPath ${dd} build`)), null);
  fill(path.posix.join(dd, 'Build', 'Products'), 30);
  assert.deepEqual([made('dd-flip')?.agent, made('dd-flip')?.type], ['afix-app-12345', 'fix-app']);

  // Other ways a command names a folder before a program makes it: --flag=<path>, -o, relative to a scratchpad cwd.
  call('afix-app-12345', bash(pad, `node gen.mjs --out=${pad}/gen-out && tool -o shots`));
  // 2026-10-20: the path inside a script handed to sh -c, the way dibs run usually wraps a build,
  // and inside that, a variable set in the script and a cd.
  call('afix-app-12345', bash('/Users/x', `cd app && ~/bin/dibs run xcode-build -m "app tests" -- sh -c 'xcodegen generate >/dev/null && xcodebuild -scheme App -derivedDataPath ${pad}/dd-test test 2>&1 | grep -E "Executed|error:" | tail -15'`));
  call('afix-app-12345', bash('/Users/x', `dibs run test -- bash -c "S=${pad}; tool --out \$S/var-out && cd ${pad} && tool -o rel-out"`));
  for (const name of ['gen-out', 'shots', 'dd-test', 'var-out', 'rel-out']) assert.equal(made(name)?.agent, 'afix-app-12345', name);

  // A folder that already exists isn't claimed by naming it.
  fill(path.posix.join(pad, 'old-run'), 25);
  call('atester-67890', bash(pad, `ls ${pad}/old-run`));
  assert.equal(made('old-run'), null);

  // A deleted folder's record goes with it: the next one is whoever makes it.
  assert.equal(call('atester-67890', bash(pad, `rm -rf ${dd}`)), null, "a sibling may delete fix-app's derived data");
  fs.rmSync(dd, { recursive: true, force: true });
  assert.equal(made('dd-flip'), null);
  assert.equal(call('atester-67890', bash(pad, `mkdir ${dd}`)), null);
  assert.equal(made('dd-flip')?.agent, 'atester-67890');
});

// ----- worktrees -----

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A repo with a commit, checked out in its main folder and in two worktrees
// next to it, as Atlas's are: { main, a, b }, real paths.
function worktrees(t, files = { 'format/SPEC.md': 'spec\n', 'README.md': 'hi\n' }) {
  const main = gitProject(t, files);
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'first');
  const dirs = { main: realPath(main) };
  for (const name of ['a', 'b']) {
    const d = path.posix.join(tmp(t, 'wts'), `wt-${name}`);
    git(main, 'worktree', 'add', '-q', d);
    dirs[name] = realPath(d);
  }
  return dirs;
}

test('every worktree of a repo leases a file under one name: the same file, or a glob in one and a file in another, collide', t => {
  const home = tmp(t), w = worktrees(t);
  for (const d of [w.main, w.a, w.b, path.join(w.b, 'format')])
    assert.equal(fileRes('files:format/SPEC.md', d), `files:${w.main}/format/SPEC.md`, d);
  assert.equal(fileRes('files:format/**', w.a), `files:${w.main}/format/**`);
  assert.equal(fileRes(`files:${w.b}/format`, w.main), `files:${w.main}/format`);

  const as = (agent, cwd, ...args) => sync(home, args, { agent, cwd });
  assert.equal(as('bob', w.a, 'hold', 'files:format/SPEC.md', '-m', 'spec').code, 0);
  const same = as('alice', w.b, 'hold', 'files:format/SPEC.md', '--no-wait');
  assert.equal(same.code, 75);
  assert.match(flat(same.err), /Waiting for bob in another copy of this repo \(wt-a\) to finish with the files in format\/SPEC\.md/);
  assert.equal(as('alice', w.b, 'hold', 'files:format/**', '--no-wait').code, 75, 'a glob in another worktree');
  assert.equal(as('carol', w.main, 'hold', 'files:format', '--no-wait').code, 75, 'the folder, from the main worktree');
  assert.equal(as('alice', w.b, 'hold', 'files:README.md', '--no-wait').code, 0, 'another file');
  assert.match(as('carol', w.b, 'who', 'files:format/SPEC.md').out, /^Files in format\/SPEC\.md\s+bob has reserved them/);

  assert.equal(as('bob', w.a, 'release', 'files:format/SPEC.md').code, 0);
  assert.equal(as('dave', w.b, 'hold', 'files:format/**', '--no-wait').code, 0);
  assert.equal(as('bob', w.a, 'hold', 'files:format/SPEC.md', '--no-wait').code, 75, 'and the other way round');
});

test('the guard turns away an edit to a file leased from another worktree, and says where the holder is', t => {
  const home = tmp(t), w = worktrees(t);
  assert.equal(sync(home, ['hold', 'files:format/**', '-m', 'spec'], { agent: 'bob', cwd: w.a }).code, 0);
  for (const [cwd, file] of [[w.b, path.join(w.b, 'format', 'SPEC.md')], [w.b, 'format/SPEC.md'], [w.main, path.join(w.main, 'format', 'new.md')]]) {
    const d = hook(home, edit(cwd, file, 'Write'), 'alice').decision;
    assert.equal(d?.permissionDecision, 'deny', `${cwd} ${file}`);
    assert.match(d.permissionDecisionReason, new RegExp(`^dibs: format/(SPEC|new)\\.md is leased to bob in another copy of this repo \\(wt-a\\) for "spec"`));
    assert.match(d.permissionDecisionReason, /dibs when 'files:format\/\*\*'/);
  }
  assert.equal(hook(home, bash(w.b, 'echo x > format/SPEC.md'), 'alice').decision?.permissionDecision, 'deny', 'a shell write');
  assert.equal(hook(home, edit(w.a, path.join(w.a, 'format', 'SPEC.md')), 'bob').decision, null, "bob's own edit");
  assert.equal(hook(home, edit(w.b, path.join(w.b, 'README.md')), 'alice').decision, null, 'outside the lease');

  // In-process, the hook's own work per call with worktree paths to map.
  lease(HOME, `${w.main}/format/**`, { pid: null, cwd: w.a });
  t.after(() => fs.rmSync(path.join(HOME, 'state.json'), { force: true }));
  const N = 200, t0 = performance.now();
  for (let i = 0; i < N; i++) assert.equal(respond(edit(w.b, path.join(w.b, 'format', 'SPEC.md'))).hookSpecificOutput.permissionDecision, 'deny');
  for (let i = 0; i < N; i++) assert.equal(respond(bash(w.b, 'echo hi > README.md')), null);
  const each = (performance.now() - t0) / (2 * N);
  assert.ok(each < 5, `${each.toFixed(2)} ms per call`);
});

test("git's whole-tree writes in one worktree pass a lease taken from another; the same lease still stops them in its own worktree, and edits to the file anywhere", t => {
  const home = tmp(t), w = worktrees(t);
  assert.equal(sync(home, ['hold', 'files:README.md', '-m', 'readme'], { agent: 'bob', cwd: w.b }).code, 0);
  const whole = ['git stash', 'git stash pop', 'git reset --hard origin/main', 'git checkout .', 'git checkout -f main', 'git switch --discard-changes main',
    'git restore .', 'git clean -fd', 'git pull --autostash', 'git checkout -- README.md'];
  for (const cmd of whole) {
    assert.equal(hook(home, bash(w.a, cmd), 'alice').decision, null, `${cmd} in wt-a`);
    assert.equal(hook(home, bash(w.main, cmd), 'alice').decision, null, `${cmd} in the main worktree`);
    const d = hook(home, bash(w.b, cmd), 'alice').decision;
    assert.equal(d?.permissionDecision, 'deny', `${cmd} in wt-b, where the lease was taken`);
    assert.match(d.permissionDecisionReason, /is leased to bob for "readme"/);
  }
  assert.equal(hook(home, bash(w.a, `git -C ${w.b} stash`), 'alice').decision?.permissionDecision, 'deny', 'git -C into wt-b');
  assert.equal(hook(home, bash(w.a, 'echo x > README.md'), 'alice').decision?.permissionDecision, 'deny', 'a shell write to the file in wt-a');
  const d = hook(home, edit(w.a, path.join(w.a, 'README.md')), 'alice').decision;
  assert.equal(d?.permissionDecision, 'deny', 'an edit to the file in wt-a');
  assert.match(d.permissionDecisionReason, /in another copy of this repo \(wt-b\)/);
  assert.equal(hook(home, bash(w.a, 'git rm README.md'), 'alice').decision?.permissionDecision, 'deny', 'git rm of the file in wt-a');

  // A lease from a dibs that didn't record where it was taken still stops them everywhere.
  const old = tmp(t);
  lease(old, `${w.main}/README.md`, { pid: null });
  for (const cwd of [w.a, w.b]) assert.equal(hook(old, bash(cwd, 'git stash'), 'alice').decision?.permissionDecision, 'deny', cwd);
});

test('git apply and git am count as edits to each file their patch names, checked across worktrees; a patch dibs cannot read counts as the whole repo', t => {
  const home = tmp(t), w = worktrees(t), dir = tmp(t, 'patches');
  // Forward slashes, as an agent types a path into Git Bash on Windows.
  const write = (name, body) => { fs.writeFileSync(path.join(dir, name), body); return sysPath(path.join(dir, name)); };
  const gitDiff = file => `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n--- a removed line, not a file\n+new\n`;
  const readme = write('readme.diff', gitDiff('README.md'));
  const spec = write('spec.diff', gitDiff('format/SPEC.md'));
  const plain = write('plain.diff', '--- README.md.orig\t2026-10-16 10:00:00\n+++ README.md\t2026-10-16 10:01:00\n@@ -1 +1 @@\n-hi\n+ho\n');
  const rename = write('rename.diff', 'diff --git a/format/SPEC.md b/format/NEW.md\nsimilarity index 100%\nrename from format/SPEC.md\nrename to format/NEW.md\n');
  const mbox = write('0001.patch', `From 123 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] readme\n\n---\n README.md | 2 +-\n\n${gitDiff('README.md')}--\n2.40.0\n`);
  const tricky = write('quoted.diff', 'diff --git "a/odd name.md" "b/odd name.md"\n--- "a/odd name.md"\n+++ "b/odd name.md"\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepEqual(bashWrites(`git apply ${spec}`, split, w.a).map(x => x.path), [`${w.a}/format/SPEC.md`]);
  assert.deepEqual(bashWrites(`git apply --directory=format -p1 ${readme}`, split, w.a).map(x => x.path), [`${w.a}/format/README.md`]);
  assert.deepEqual(bashWrites(`git apply ${rename}`, split, w.a).map(x => x.path).sort(), [`${w.a}/format/NEW.md`, `${w.a}/format/SPEC.md`]);
  assert.deepEqual(bashWrites(`git apply -p0 ${plain}`, split, w.a).map(x => x.path), [`${w.a}/README.md.orig`, `${w.a}/README.md`]);

  assert.equal(sync(home, ['hold', 'files:README.md', '-m', 'readme'], { agent: 'bob', cwd: w.b }).code, 0);
  for (const cmd of [`git apply ${readme}`, `git apply -R ${readme}`, `git am ${mbox}`, `git apply -p0 ${plain}`, `cd format && git apply ${readme}`]) {
    const d = hook(home, bash(w.a, cmd), 'alice').decision;
    assert.equal(d?.permissionDecision, 'deny', cmd);
    assert.match(d.permissionDecisionReason, /^dibs: README\.md is leased to bob in another copy of this repo \(wt-b\)/, cmd);
  }
  for (const cmd of [`git apply ${spec}`, `git apply ${rename}`, `git am ${spec}`, `git apply < ${spec}`])
    assert.equal(hook(home, bash(w.a, cmd), 'alice').decision, null, `${cmd} touches only files nobody holds`);
  for (const cmd of ['git apply -', `cat ${spec} | git apply`, 'git apply missing.diff', `git apply ${tricky}`, 'git am --continue', 'git apply $PATCH'])
    assert.equal(hook(home, bash(w.a, cmd), 'alice').decision?.permissionDecision, 'deny', `${cmd}: unreadable, so the whole repo`);
});

test('patch -p1 < file counts as edits to the files its patch names, checked across worktrees, as interop ran it in wt-docxfonts', t => {
  const home = tmp(t), dir = tmp(t, 'patches');
  const w = worktrees(t, { 'apps/web/tests/helpers.ts': 'h\n', 'apps/web/src/sheet.tsx': 's\n', 'apps/web/src/docx.ts': 'd\n', 'README.md': 'hi\n' });
  const diff = (name, ...files) => {
    fs.writeFileSync(path.join(dir, name), files.map(f => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y\n`).join(''));
    return sysPath(path.join(dir, name));
  };
  const docx = diff('docx.diff', 'apps/web/src/docx.ts'), helpers = diff('helpers.diff', 'apps/web/src/docx.ts', 'apps/web/tests/helpers.ts');
  const sheet = diff('sheet.diff', 'apps/web/src/sheet.tsx');
  assert.equal(sync(home, ['hold', 'files:apps/web/tests/helpers.ts', '-m', 'menus'], { agent: 'menus', cwd: w.b }).code, 0);
  assert.equal(sync(home, ['hold', 'files:apps/web/src/sheet.tsx', '-m', 'sheet'], { agent: 'sheets', cwd: w.main }).code, 0);

  for (const cmd of [`patch -p1 < ${docx}`, `patch -p1 -i ${docx}`, `cd apps && patch -p2 < ${docx}`, `patch -d apps/web -p3 < ${docx}`,
    `git -C ${w.a} checkout -q -b x origin/main && git -C ${w.a} apply ${docx}`])
    assert.equal(hook(home, bash(w.a, cmd), 'interop').decision, null, `${cmd} touches only a file nobody holds`);
  for (const [cmd, holder, where] of [[`patch -p1 < ${helpers}`, 'menus', 'wt-b'], [`patch -p1 < ${sheet}`, 'sheets', path.basename(w.main)],
    [`git -C ${w.a} apply ${helpers}`, 'menus', 'wt-b']]) {
    const d = hook(home, bash(w.a, cmd), 'interop').decision;
    assert.equal(d?.permissionDecision, 'deny', cmd);
    assert.match(d.permissionDecisionReason, new RegExp(`is leased to ${holder} in another copy of this repo \\(${where}\\)`), cmd);
  }
  for (const cmd of [`cat ${docx} | patch -p1`, `patch < ${docx}`, 'patch -p1 < missing.diff'])
    assert.equal(hook(home, bash(w.a, cmd), 'interop').decision?.permissionDecision, 'deny', `${cmd}: unreadable, so the whole folder`);
});

test('a lease an older dibs took under a worktree path still collides with the same file from another worktree', t => {
  const home = tmp(t), w = worktrees(t);
  lease(home, `${w.a}/format/SPEC.md`, { pid: null, who: 'bob', agent: 'bob', cwd: w.a });
  const d = hook(home, edit(w.b, path.join(w.b, 'format', 'SPEC.md')), 'alice').decision;
  assert.equal(d?.permissionDecision, 'deny');
  assert.match(d.permissionDecisionReason, /in another copy of this repo \(wt-a\)/);
  assert.equal(sync(home, ['hold', 'files:format/**', '--no-wait'], { agent: 'alice', cwd: w.main }).code, 75);
  assert.equal(sync(home, ['release', 'files:format/SPEC.md'], { agent: 'bob', cwd: w.a }).code, 0, 'its holder can give it back');
  assert.equal(sync(home, ['hold', 'files:format/**', '--no-wait'], { agent: 'alice', cwd: w.main }).code, 0);
});

test('paths outside git, submodules and broken .git files keep their own names', t => {
  const plain = realPath(tmp(t, 'plain'));
  assert.equal(fileRes('files:notes/x.md', plain), `files:${plain}/notes/x.md`, 'outside git');

  // A submodule is its own repo: its files aren't its parent's. Its own worktrees share its names.
  const sub = gitProject(t, { 'a.txt': 'sub\n' });
  git(sub, 'add', '-A');
  git(sub, 'commit', '-qm', 'sub');
  const w = worktrees(t);
  git(w.main, 'submodule', '-q', 'add', sub, 'lib');
  const lib = sysPath(path.join(w.main, 'lib'));
  assert.equal(fileRes('files:a.txt', lib), `files:${lib}/a.txt`);
  assert.equal(overlap(fileRes('files:**', w.main), fileRes('files:a.txt', lib)), true, "the parent's glob still covers the folder");
  assert.equal(overlap(fileRes('files:a.txt', lib), fileRes('files:a.txt', w.main)), false, "the parent's a.txt is another file");
  const libWt = path.join(realPath(tmp(t, 'libwt')), 'lib-wt');
  git(lib, 'worktree', 'add', '-q', libWt);
  assert.equal(fileRes('files:a.txt', libWt), `files:${lib}/a.txt`, "the submodule's own worktree");

  // .git files that point nowhere, say nothing or can't be read: the folder is its own root, and nothing throws.
  const broken = realPath(tmp(t, 'broken'));
  for (const body of ['gitdir: /nowhere/.git/worktrees/x\n', 'garbage\n', 'gitdir: ../missing\n', null]) {
    fs.rmSync(path.join(broken, '.git'), { recursive: true, force: true });
    if (body === null) fs.mkdirSync(path.join(broken, '.git', 'x'), { recursive: true });
    else fs.writeFileSync(path.join(broken, '.git'), body);
    assert.equal(fileRes('files:a.md', path.join(broken)), `files:${broken}/a.md`, String(body));
  }
  fs.rmSync(path.join(broken, '.git'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: x\n');
  fs.chmodSync(path.join(broken, '.git'), 0);
  assert.equal(fileRes('files:a.md', broken), `files:${broken}/a.md`, 'unreadable');
  const home = tmp(t);
  lease(home, `${broken}/a.md`, { pid: null });
  assert.equal(hook(home, edit(broken, path.join(broken, 'a.md')), 'alice').decision?.permissionDecision, 'deny');
});
