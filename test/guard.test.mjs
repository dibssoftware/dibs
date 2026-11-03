// dibs guard: which commands get caught, how they're rewritten, and the
// settings.json install, all against throwaway files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { tmp, BIN, HOOK, env as cliEnv, PERSON, realPath } from './helpers.mjs';
import { check, respond, rulesFrom, install, remove, installed, MATCHER } from '../src/guard.mjs';

const w = (res, why, rest) => `dibs run ${res} -m '${why}' -- ${rest}`;

// [command, what it should become (null: left alone)]
const CAUGHT = [
  ['xcodebuild -scheme App build', w('xcode-build', 'guard: xcodebuild -scheme App', 'xcodebuild -scheme App build')],
  ['xcodebuild -scheme App build | xcpretty', w('xcode-build', 'guard: xcodebuild -scheme App', 'xcodebuild -scheme App build | xcpretty')],
  ['cd ios && xcodebuild build', `cd ios && ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  ['cd ios; xcodebuild build 2>&1 | tail -20', `cd ios; ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build 2>&1 | tail -20')}`],
  ['FOO=1 xcodebuild build', `FOO=1 ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  ['env FOO=1 xcodebuild build', w('xcode-build', 'guard: xcodebuild build', 'env FOO=1 xcodebuild build')],
  ['time xcodebuild build', `time ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  ['xcrun -sdk iphonesimulator xcodebuild build', w('xcode-build', 'guard: xcodebuild build', 'xcrun -sdk iphonesimulator xcodebuild build')],
  ['xcrun xcodebuild -scheme A build', w('xcode-build', 'guard: xcodebuild -scheme A', 'xcrun xcodebuild -scheme A build')],
  ['/usr/bin/xcodebuild build', w('xcode-build', 'guard: /usr/bin/xcodebuild build', '/usr/bin/xcodebuild build')],
  ['xcodebuild build > build.log', w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build > build.log')],
  ['xcodebuild test -scheme A -destination "platform=iOS Simulator,name=iPhone 16"',
    w('sim,xcode-build', 'guard: xcodebuild test -scheme', 'xcodebuild test -scheme A -destination "platform=iOS Simulator,name=iPhone 16"')],
  ['(cd app && xcodebuild build)', `(cd app && ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')})`],
  ['xcrun simctl boot "iPhone 16"', w('sim', 'guard: simctl boot iPhone 16', 'xcrun simctl boot "iPhone 16"')],
  ['xcrun simctl install booted build/App.app', w('sim', 'guard: simctl install booted', 'xcrun simctl install booted build/App.app')],
  ['xcrun simctl launch booted com.x.app', w('sim', 'guard: simctl launch booted', 'xcrun simctl launch booted com.x.app')],
  ['xcrun simctl io booted screenshot shot.png', w('sim', 'guard: simctl io booted', 'xcrun simctl io booted screenshot shot.png')],
  ['xcrun simctl ui booted appearance dark', w('sim', 'guard: simctl ui booted', 'xcrun simctl ui booted appearance dark')],
  ['xcrun simctl status_bar booted override --time 9:41', w('sim', 'guard: simctl status_bar booted', 'xcrun simctl status_bar booted override --time 9:41')],
  ['xcrun simctl launch booted list', w('sim', 'guard: simctl launch booted', 'xcrun simctl launch booted list')],
  ['xcrun simctl shutdown booted', w('sim', 'guard: simctl shutdown booted', 'xcrun simctl shutdown booted')],
  ['xcrun simctl bootstatus booted -b', w('sim', 'guard: simctl bootstatus booted', 'xcrun simctl bootstatus booted -b')],
  ['swift test', w('test', 'guard: swift test', 'swift test')],
  ['npx playwright test', w('playwright', 'guard: playwright test', 'npx playwright test')],
  ['npx -y playwright test --project chromium', w('playwright', 'guard: playwright test --project', 'npx -y playwright test --project chromium')],
  ['pnpm exec playwright test', w('playwright', 'guard: playwright test', 'pnpm exec playwright test')],
  ['playwright test e2e/', w('playwright', 'guard: playwright test e2e/', 'playwright test e2e/')],
  ['npx vitest run', w('test', 'guard: vitest run', 'npx vitest run')],
  ['vitest run src', w('test', 'guard: vitest run src', 'vitest run src')],
  ['npx jest --ci', w('test', 'guard: jest --ci', 'npx jest --ci')],
  ['npm test', w('test', 'guard: npm test', 'npm test')],
  ['npm run test:unit -- --reporter dot', w('test', 'guard: npm run test:unit', 'npm run test:unit -- --reporter dot')],
  ['npm --prefix web test', w('test', 'guard: npm test', 'npm --prefix web test')],
  ['yarn test', w('test', 'guard: yarn test', 'yarn test')],
  ['timeout 300 npx tsc --noEmit -p .', w('test', 'guard: tsc --noEmit -p', 'timeout 300 npx tsc --noEmit -p .')],
  ['npm exec tsc --noEmit -p test', w('test', 'guard: tsc --noEmit -p', 'npm exec tsc --noEmit -p test')],
  ['tsc -b', w('test', 'guard: tsc -b', 'tsc -b')],
  ['npm run typecheck', w('test', 'guard: npm run typecheck', 'npm run typecheck')],
  ['bun test', w('test', 'guard: bun test', 'bun test')],
  ['node --test test/*.test.mjs', w('test', 'guard: node --test test/.test.mjs', 'node --test test/*.test.mjs')],
  ['npx wrangler deploy', w('deploy', 'guard: wrangler deploy', 'npx wrangler deploy')],
  ['wrangler pages deploy dist', w('deploy', 'guard: wrangler pages deploy', 'wrangler pages deploy dist')],
  ['vercel deploy --prod', w('deploy', 'guard: vercel deploy --prod', 'vercel deploy --prod')],
  ['vercel --prod', w('deploy', 'guard: vercel --prod', 'vercel --prod')],
  ['./ship.sh', w('deploy', 'guard: ./ship.sh', './ship.sh')],
  ['bash scripts/deploy-web.sh', w('deploy', 'guard: scripts/deploy-web.sh', 'bash scripts/deploy-web.sh')],
  ['npm run deploy', w('deploy', 'guard: npm run deploy', 'npm run deploy')],
  ['git pull && npm test', `git pull && ${w('test', 'guard: npm test', 'npm test')}`],
  ['caffeinate -i xcodebuild build', w('xcode-build', 'guard: xcodebuild build', 'caffeinate -i xcodebuild build')],
  ['xcodebuild build && xcrun simctl install booted A.app',
    `${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')} && ${w('sim', 'guard: simctl install booted', 'xcrun simctl install booted A.app')}`],
  ['if true; then npm test; fi', `if true; then ${w('test', 'guard: npm test', 'npm test')}; fi`],
  ['for d in a b; do (cd $d && npm test); done', `for d in a b; do (cd $d && ${w('test', 'guard: npm test', 'npm test')}); done`],
  ['cat <<EOF > notes.txt\nhello\nEOF\nnpm test', `cat <<EOF > notes.txt\nhello\nEOF\n${w('test', 'guard: npm test', 'npm test')}`],
  // A dibs call elsewhere on the line doesn't cover a command it doesn't hold for.
  ['xcodebuild -scheme A build && dibs say "built"', `${w('xcode-build', 'guard: xcodebuild -scheme A', 'xcodebuild -scheme A build')} && dibs say "built"`],
  ['dibs release sim; xcodebuild build', `dibs release sim; ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  ['dibs who sim || npm test', `dibs who sim || ${w('test', 'guard: npm test', 'npm test')}`],
  ['dibs hold sim && xcodebuild build', `dibs hold sim && ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  // DIBS_GUARD=off counts only as an assignment in front of a command.
  ['git commit -m "doc DIBS_GUARD=off" && npm test', `git commit -m "doc DIBS_GUARD=off" && ${w('test', 'guard: npm test', 'npm test')}`],
  ["echo 'see DIBS_GUARD=off' && xcodebuild build", `echo 'see DIBS_GUARD=off' && ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  ['DIBS_GUARD=off xcodebuild build && npm test', `DIBS_GUARD=off xcodebuild build && ${w('test', 'guard: npm test', 'npm test')}`],
  ['xcodebuild test -scheme A -destination id=4F2C1A9E-0B7D-4E43-9C1B-2A6F3D5E8C10',
    w('sim,xcode-build', 'guard: xcodebuild test -scheme', 'xcodebuild test -scheme A -destination id=4F2C1A9E-0B7D-4E43-9C1B-2A6F3D5E8C10')],
  ['xcodebuild test -destination id=00008030-001A2C3E0E8B802E', w('xcode-build', 'guard: xcodebuild test -destination', 'xcodebuild test -destination id=00008030-001A2C3E0E8B802E')],
  ['/usr/bin/time -p xcodebuild build', w('xcode-build', 'guard: xcodebuild build', '/usr/bin/time -p xcodebuild build')],
  ['exec xcodebuild build', `exec ${w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build')}`],
  ['sudo -u ci xcodebuild build', w('xcode-build', 'guard: xcodebuild build', 'sudo -u ci xcodebuild build')],
  ['yarn workspace web test', w('test', 'guard: yarn test', 'yarn workspace web test')],
  ['bash -x ./deploy.sh', w('deploy', 'guard: ./deploy.sh', 'bash -x ./deploy.sh')],
];

const LEFT_ALONE = [
  'xcodebuild -version',
  'xcodebuild -showsdks',
  'xcodebuild -list -project App.xcodeproj',
  'xcodebuild -showBuildSettings -scheme App | grep PRODUCT',
  'xcrun simctl list devices',
  'xcrun simctl list -j runtimes',
  'xcrun simctl ui booted appearance',
  'xcrun simctl ui "iPhone 16" content_size',
  'xcrun simctl status_bar booted list',
  'xcrun simctl getenv booted HOME',
  'xcrun simctl listapps booted',
  'xcrun simctl appinfo booted com.x.app',
  'xcrun simctl get_app_container booted com.x.app data',
  'xcrun simctl io booted enumerate',
  'xcrun simctl pbpaste booted',
  'xcrun simctl bootstatus booted',
  'xcrun simctl runtime list',
  // Managing devices that aren't running: deleting simulators to free disk
  // must not wait on the shared sim's disk floor.
  'xcrun simctl delete 4F2C1A9E-0B7D-4E43-9C1B-2A6F3D5E8C10 AAAA-1111',
  'xcrun simctl delete unavailable',
  'xcrun simctl erase all',
  'xcrun simctl create "Test 16" "iPhone 16" com.apple.CoreSimulator.SimRuntime.iOS-26-0',
  'xcrun simctl runtime delete 23A343',
  'xcrun simctl --set /tmp/devs delete all',
  'xcrun simctl --set /tmp/devs list',
  'xcrun --find xcodebuild',
  'xcrun -sdk iphoneos --show-sdk-path',
  'which xcodebuild',
  'command -v xcodebuild',
  'grep -rn xcodebuild scripts/',
  'cat build-with-xcodebuild.sh',
  'echo "npm test"',
  'echo npm test',
  'git commit -m "wrap xcodebuild and npm test in dibs"',
  "git commit -m 'run vercel deploy'",
  'cat <<EOF > run.sh\nxcodebuild build\nnpm test\nEOF',
  'cat <<\'EOF\' | node -\nconsole.log("xcodebuild")\nEOF',
  'git commit -F - <<EOF\nxcodebuild: fix\nEOF',
  'dibs run xcode-build -- xcodebuild build',
  'dibs run test -m "suite" -- npm test',
  '~/bin/dibs run sim -- xcrun simctl boot X',
  'cd app && dibs run test -- npm test | tail',
  'time dibs run test -- node --test test/*.test.mjs',
  'dibs hold sim --for 20m && xcrun simctl boot X',
  'DIBS_GUARD=off xcodebuild build',
  'env DIBS_GUARD=off npm test',
  'export DIBS_GUARD=off; npm test',
  'npm install',
  'npm run build',
  'npx playwright install chromium',
  'npx vitest --version',
  'npx tsc --version',
  'tsc --watch -p .',
  'jest --listTests',
  'node script.mjs',
  'wrangler tail',
  'wrangler deploy --dry-run',
  'vercel ls',
  'vercel env pull',
  'swift build',
  'man xcodebuild',
  'ls ~/dibs',
  'echo $(xcodebuild -version)',
  'bash -c "xcodebuild build"',
  'bash -lc "npm test"',
  'ssh mini xcodebuild build',
  '$XCB build',
  'echo "unterminated',
  '# xcodebuild build',
  'echo done # then npm test',
];

test('a command in a { ...; } group is caught like any other, and the hook no longer overflows on the braces', () => {
  const out = respond({ tool_name: 'Bash', tool_input: { command: '{ npm test; } 2>&1 | tail -5' }, permission_mode: 'bypassPermissions' });
  assert.match(out.hookSpecificOutput.updatedInput.command, /^\{ dibs run test -m '[^']*' -- npm test; \} 2>&1 \| tail -5$/);
  assert.equal(respond({ tool_name: 'Bash', tool_input: { command: '{ ls; echo done; }' }, permission_mode: 'bypassPermissions' }), null, 'nothing heavy in it');
});

test('catches heavy commands and wraps exactly the command that needs the turn', () => {
  for (const [cmd, want] of CAUGHT) assert.equal(check(cmd)?.command, want, cmd);
});

test('leaves reads, mentions, heredocs and wrapped commands alone', () => {
  for (const cmd of LEFT_ALONE) assert.equal(check(cmd), null, cmd);
});

// What the rules tell agents needs no dibs: long jobs that mostly wait on the network (d7's crawlers, 2026-11-03).
test('long network-bound jobs (crawlers, pollers, HTTP checks) pass the hook untouched', () => {
  for (const cmd of ['nohup python3 crawl.py --forever > crawl.log 2>&1 &', 'node poll.mjs --every 60s', 'while true; do curl -fsS https://example.org/health; sleep 60; done',
    'python3 known_answers.py --prod', 'wget -r -np https://example.com/docs/', 'npx tsx scripts/scrape-listings.ts'])
    assert.equal(check(cmd), null, cmd);
});

test('config can add rules and switch built-ins off', () => {
  const rules = rulesFrom({ rules: { pytest: { match: ['pytest', 'python -m pytest'], res: 'test' }, vercel: false, npm: { match: 'cf deploy', res: 'deploy' } } });
  assert.equal(check('python -m pytest -x', { rules })?.command, w('test', 'guard: python -m pytest', 'python -m pytest -x'));
  assert.equal(check('cf deploy', { rules })?.command, w('deploy', 'guard: cf deploy', 'cf deploy'));
  assert.equal(check('vercel --prod', { rules }), null);
  assert.equal(check('xcodebuild build', { rules })?.command, w('xcode-build', 'guard: xcodebuild build', 'xcodebuild build'));
});

const input = (command, mode = 'default', extra = {}) =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', permission_mode: mode, tool_input: { command, description: 'd', ...extra } });
const decide = (...args) => respond(...args).hookSpecificOutput;

test('in a bypassPermissions session the command is rewritten to go through dibs', () => {
  const r = decide(input('npm test', 'bypassPermissions'));
  assert.equal(r.permissionDecision, 'allow');
  assert.equal(r.updatedInput.command, w('test', 'guard: npm test', 'npm test'));
  assert.equal(r.updatedInput.description, 'd');
  assert.match(r.additionalContext, /dibs run/);
});

test('in any other session the command is blocked, naming the exact command to run instead', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk']) {
    const d = decide(input('npm test', mode));
    assert.equal(d.permissionDecision, 'deny', mode);
    assert.equal(d.updatedInput, undefined, mode);
    assert.ok(d.permissionDecisionReason.includes(w('test', 'guard: npm test', 'npm test')), mode);
  }
});

test('guard.rewrite always or never overrides the session mode', () => {
  assert.equal(decide(input('npm test', 'default'), { rewrite: 'always' }).permissionDecision, 'allow');
  assert.equal(decide(input('npm test', 'bypassPermissions'), { rewrite: 'never' }).permissionDecision, 'deny');
});

test("a rewritten command keeps its own timeout: Claude Code moves a long wait to the background", () => {
  const timeout = extra => decide(input('npm test', 'bypassPermissions', extra)).updatedInput.timeout;
  assert.equal(timeout({}), undefined);
  assert.equal(timeout({ timeout: 30000 }), 30000);
});

test('a command that reads $SIM runs whole under sh -c, so $SIM is set when it runs', () => {
  assert.equal(check('xcrun simctl boot "$SIM" && xcrun simctl install "$SIM" A.app').command,
    `dibs run sim-own -m 'guard: simctl boot SIM' -- sh -c 'xcrun simctl boot "$SIM" && xcrun simctl install "$SIM" A.app'`);
  assert.equal(check(`cd ios && xcodebuild test -scheme A -destination "id=$SIM"`).command,
    `dibs run sim-own,xcode-build -m 'guard: xcodebuild test -scheme' -- sh -c 'cd ios && xcodebuild test -scheme A -destination "id=$SIM"'`);
});

test('nothing to catch, another tool, or the guard switched off: no answer at all', () => {
  assert.equal(respond(input('ls', 'bypassPermissions')), null);
  assert.equal(respond({ tool_name: 'Read', tool_input: { file_path: '/x' } }), null);
  assert.equal(respond(input('npm test'), false), null);
});

test('"guard": false stops the rewriting but not file-lease refusals; guard.files false stops those', t => {
  const home = tmp(t), dir = realPath(tmp(t, 'src'));
  const at = Date.now();
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ seq: 1, queue: [],
    leases: [{ id: 1, res: [`files:${dir}`], kind: 'hold', who: 'other', agent: 'other', sessionId: 'other', start: at, expires: at + 6e5 }] }));
  const run = (cfg, tool_input) => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ guard: cfg }));
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env: { ...process.env, DIBS_HOME: home },
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'me', cwd: dir, permission_mode: 'default', ...tool_input }) });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
  };
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.js') } };
  const test = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
  assert.equal(run(false, edit), 'deny');
  assert.equal(run(false, test), null);
  assert.equal(run({ files: false }, edit), null);
  assert.equal(run({ files: false }, test), 'deny');
  assert.equal(run({ commands: false, files: false }, edit), null);
  assert.equal(run({ commands: false, files: false }, test), null);
});

function hook(t, stdin, home = tmp(t)) {
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: { ...process.env, DIBS_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('the hook binary answers in Claude Code JSON', t => {
  const r = hook(t, JSON.stringify(input('xcodebuild build')));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.deepEqual(hook(t, JSON.stringify(input('git status'))), { code: 0, out: '', err: '' });
});

test('input the hook cannot read lets the command through silently', t => {
  for (const bad of ['', 'not json', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":{"command":42}}', 'null']) {
    const b = hook(t, bad);
    assert.deepEqual([b.code, b.out], [0, ''], bad);
  }
});

test('dibs guard with JSON piped in is the same hook, and a broken config.json does not stop it', t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
  const r = spawnSync(process.execPath, [BIN, 'guard'], { input: JSON.stringify(input('npm test', 'bypassPermissions')), encoding: 'utf8',
    env: { ...process.env, DIBS_HOME: home } });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(!fs.existsSync(path.join(home, 'seen.json')), "the hook shows no what's-new notice");
});

test('the hook reads guard rules from ~/.dibs/config.json', t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ guard: { rules: { pytest: { match: 'pytest', res: 'test' } } } }));
  assert.match(JSON.parse(hook(t, JSON.stringify(input('pytest -q')), home).out).hookSpecificOutput.permissionDecisionReason, /dibs(\.mjs)? run test/);   // the full path to dibs when it isn't on PATH, as on a fresh Linux VM
});

test('install and remove keep everything else in settings.json, with a backup', t => {
  const file = path.join(tmp(t), 'settings.json');
  const before = {
    model: 'opus',
    permissions: { allow: ['Bash(git:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/x/other-hook.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(before, null, 2));
  assert.equal(installed(file), null);

  assert.match(install(file, '/opt/dibs/bin/dibs-guard.mjs'), /installed in .*old file in .*dibs-backup/);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.dibs-backup`, 'utf8')), before);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, before.permissions);
  assert.deepEqual(after.hooks.Stop, [...before.hooks.Stop, { hooks: [{ type: 'command', command: '/opt/dibs/bin/dibs-guard.mjs', timeout: 5 }] }],
    "someone else's Stop hook stays first; ours hands over the person's messages");
  assert.deepEqual(after.hooks.PreToolUse[0], before.hooks.PreToolUse[0]);
  assert.deepEqual(after.hooks.PreToolUse[1], { matcher: MATCHER, hooks: [{ type: 'command', command: '/opt/dibs/bin/dibs-guard.mjs', timeout: 5 }] });

  assert.match(install(file, '/opt/dibs/bin/dibs-guard.mjs'), /already installed/);
  assert.match(install(file, '/new/dibs/bin/dibs-guard.mjs'), /updated/);
  const moved = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse;
  assert.equal(moved.length, 3, 'moving dibs updates the hook instead of adding a second one');
  assert.equal(installed(file).command, '/new/dibs/bin/dibs-guard.mjs');

  assert.match(remove(file), /removed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
  assert.equal(remove(file), null);
});

test('install over the old Bash-only entry also covers Edit, Write, MultiEdit and NotebookEdit, in one entry', t => {
  const file = path.join(tmp(t), 'settings.json');
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: '/x/other-hook.sh' }] };
  const old = { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/dibs/bin/dibs-guard.mjs', timeout: 5 }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [other, old] } }, null, 2));
  assert.match(install(file, '/opt/dibs/bin/dibs-guard.mjs'), /updated/);
  const groups = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse;
  assert.deepEqual(groups, [other, { ...old, matcher: MATCHER }, { ...old, matcher: 'Agent|Task' }]);
  for (const tool of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.match(tool, new RegExp(`^(${MATCHER})$`), tool);
  assert.doesNotMatch('Read', new RegExp(`^(${MATCHER})$`));
  assert.match(install(file, '/opt/dibs/bin/dibs-guard.mjs'), /already installed/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse.length, 3);
});

test('install on a missing or hook-less settings file, and refuses a broken one', t => {
  const dir = tmp(t);
  const file = path.join(dir, 'nested', 'settings.json');
  assert.match(install(file, 'dibs guard'), /installed/);
  assert.ok(!fs.existsSync(`${file}.dibs-backup`));
  assert.ok(installed(file));
  remove(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "model": ');
  assert.throws(() => install(broken), /isn't valid JSON/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ "model": ');
});

test('dibs guard install, status and remove from the command line', t => {
  const file = path.join(tmp(t), 'settings.json');
  // install and remove are the person's (DIBS_OWNER=1, as the Mac app runs them).
  const env = cliEnv(tmp(t), PERSON);
  const cli = (...args) => spawnSync(process.execPath, [BIN, 'guard', ...args], { encoding: 'utf8', env });
  assert.equal(cli('status', '--settings', file).status, 1);
  const i = cli('install', '--settings', file);
  assert.equal(i.status, 0, i.stderr);
  assert.ok(installed(file).command.endsWith('dibs-guard.mjs'));
  assert.match(cli('status', '--settings', file).stdout, /^dibs guard is on \(in .*settings\.json\)\.\n  Heavy commands an agent runs outside dibs: run through dibs/);
  assert.match(cli('remove', '--settings', file).stdout, /removed/);
  assert.match(cli('status', '--settings', file).stderr, /^dibs guard is off: it isn't in .*\. Turn it on: dibs guard install/);
  cli('install', '--settings', file);
  // The env override works the same as --settings.
  const s = spawnSync(process.execPath, [BIN, 'guard', 'status'], { encoding: 'utf8', env: { ...env, DIBS_CLAUDE_SETTINGS: file } });
  assert.equal(s.status, 0);
  assert.match(cli('check', 'cd x && npm test').stdout, /^test: cd x && dibs run test/);
  assert.match(cli('check', 'npm install').stdout, /leave alone/);
  assert.equal(cli('remove', '--settings', file).status, 0);
  assert.equal(cli('remove', '--settings', file).status, 1);
  assert.equal(cli('install', '--settings').status, 2);
});

test('dibs guard status --json says whether the hook is in, on which tools, and the subagent limit, exiting 0 either way', t => {
  const file = path.join(tmp(t), 'settings.json');
  const env = { ...process.env, DIBS_HOME: tmp(t) };
  const status = () => {
    const r = spawnSync(process.execPath, [BIN, 'guard', 'status', '--json', '--settings', file], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(status(), { installed: false, file, command: null, complete: false, matchers: [], rewrite: 'bypass', subagents: null });
  install(file);
  const j = status();
  assert.equal(j.installed, true);
  assert.equal(j.complete, true);
  assert.ok(j.command.endsWith('dibs-guard.mjs'));
  assert.deepEqual(j.matchers.map(m => `${m.event} ${m.matcher}`), [`PreToolUse ${MATCHER}`, 'PreToolUse Agent|Task', 'SubagentStart null', 'SubagentStop null', 'Stop null', 'SessionStart null']);
});

test('a simulator command aimed at a pool device queues for sim-own, not the shared sim', t => {
  assert.equal(check('xcrun simctl boot "$SIM"').hits[0].res, 'sim-own');
  assert.equal(check('xcrun simctl launch ${SIM} com.x').hits[0].res, 'sim-own');
  assert.equal(check('xcrun simctl io dibs-pool-2 screenshot a.png').hits[0].res, 'sim-own');
  assert.equal(check('xcodebuild test -scheme A -destination "id=$SIM"').hits[0].res, 'sim-own,xcode-build');
  assert.equal(check('xcrun simctl install booted a.app').hits[0].res, 'sim');
  assert.equal(check('xcodebuild test -destination "platform=iOS Simulator,name=iPhone 17"').hits[0].res, 'sim,xcode-build');
  assert.equal(check('xcodebuild test -destination id=00008110-0001').hits[0].res, 'xcode-build');   // a phone, not a simulator
  // A pool device named by its udid, as `dibs hold sim-own` prints it.
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({ pool: [{ name: 'dibs-pool-1', udid: 'AAAA-1111' }] }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ guard: { rewrite: 'always' } }));
  const r = hook(t, JSON.stringify(input('xcrun simctl install AAAA-1111 a.app')), home);
  assert.match(JSON.parse(r.out).hookSpecificOutput.updatedInput.command, / run sim-own -m /);
});

test('the hook leaves a line in guard.log when it fails, and still lets the command through', t => {
  const home = tmp(t);
  assert.deepEqual(hook(t, 'not json', home), { code: 0, out: '', err: '' });
  const log = fs.readFileSync(path.join(home, 'guard.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.match(log[0], /^\S+ .*JSON/);
});

test("the plugin's hooks.json hooks the same events and tools as dibs guard install", t => {
  const file = path.join(tmp(t), 'settings.json');
  install(file, 'dibs-guard');
  const pairs = hooks => Object.entries(hooks).flatMap(([ev, gs]) => gs.map(g => `${ev} ${g.matcher ?? ''}`)).sort();
  const plugin = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  assert.deepEqual(pairs(plugin), pairs(JSON.parse(fs.readFileSync(file, 'utf8')).hooks));
});

// Every module the hook loads, by a resolve hook that prints them. Resolve hooks
// run on their own thread, whose process.stderr is relayed through the main
// one and lost when the hook exits right after its last import; writeSync
// to fd 2 reaches the pipe before resolve returns.
const TRACE = `data:text/javascript,${encodeURIComponent(`import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent('import { writeSync } from "node:fs"; export async function resolve(s, c, next) { const r = await next(s, c); if (r.url.startsWith("file:")) writeSync(2, "LOADED " + r.url + "\\\\n"); return r; }'));`)}`;
function loads(home, input) {
  const r = spawnSync(process.execPath, ['--import', TRACE, HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, DIBS_HOME: home } });
  return { out: r.stdout, mods: [...new Set([...r.stderr.matchAll(/^LOADED .*\/(src|bin)\/([\w-]+)\.mjs$/gm)].map(m => m[2]))].sort() };
}

test('with nothing queued, the hook loads only the guard and file leases, plus the subagent limit on subagent events', t => {
  const home = tmp(t);
  const bash = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: home };
  assert.deepEqual(loads(home, bash).mods, ['dibs-guard', 'files', 'guard', 'util']);
  assert.deepEqual(loads(home, { hook_event_name: 'Stop', session_id: 's1' }).mods, ['dibs-guard', 'files', 'guard', 'util']);
  const stop = { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' };
  const sub = loads(home, stop).mods;
  assert.ok(sub.includes('agents'));
  assert.ok(!sub.includes('talk'), `a subagent that never talked doesn't load talk.mjs: ${sub}`);
  // Another subagent's thread doesn't count; its own does, so its thread can be marked ended.
  fs.writeFileSync(path.join(home, 'messages.json'), JSON.stringify({ seq: 1, threads: [{ key: 's1|a2', agentId: 'a2' }], messages: [] }));
  assert.ok(!loads(home, stop).mods.includes('talk'));
  assert.ok(loads(home, { ...stop, agent_id: 'a2' }).mods.includes('talk'));
});

test('a new session starts with the rules in a few lines, and each subagent hears them once', t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ resources: { 'playwright:web': { slots: 1 } } }));
  const start = loads(home, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd: home });
  const out = JSON.parse(start.out).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  const lines = out.additionalContext.split('\n');
  // The rules that change what an agent does, and nothing else (feedback, 2026-11-03: the long version went unread).
  assert.ok(lines.length >= 5 && lines.length <= 9, `${lines.length} lines`);
  assert.ok(out.additionalContext.length < 1600, `short enough to read: ${out.additionalContext.length}`);
  assert.match(out.additionalContext, /dibs run <resource> -m "why" -- <command>` \(resources: sim, .*heavy, playwright:web\)/);
  assert.match(out.additionalContext, /No dibs for .*long jobs that mostly wait on the network .*crawlers, pollers, HTTP checks/);
  assert.match(out.additionalContext, /dibs listen` with run_in_background/);
  assert.match(out.additionalContext, /keep waiting, and never lower `--mem` or raise `-p`/);
  assert.match(out.additionalContext, /Exit 75: .*Exit 74: /);
  assert.doesNotMatch(out.additionalContext, /\b7[067]\b/, 'the other exit codes are reference');
  assert.match(out.additionalContext, /Ask the person only before something you can't undo/);
  assert.match(out.additionalContext, /dibs progress /);
  assert.doesNotMatch(out.additionalContext, /dibs later|quota|dibs pair|MCP/, 'what nobody used stays out of the first read');
  assert.ok(!start.mods.includes('talk') && !start.mods.includes('commands'), `the primer loads no more of dibs: ${start.mods}`);

  const sub = { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' };
  const subText = JSON.parse(loads(home, sub).out).hookSpecificOutput.additionalContext;
  assert.match(subText, /^dibs runs on this machine/);
  assert.doesNotMatch(subText, /dibs listen/, 'a subagent ends with its task: no listener');
  assert.equal(loads(home, sub).out, '', 'a teammate taking its next message is not told again');
  assert.equal(JSON.parse(loads(home, { ...sub, agent_id: 'a2' }).out).hookSpecificOutput.hookEventName, 'SubagentStart');
  // A broken config still starts the session, with the rules.
  fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
  assert.match(JSON.parse(loads(home, { hook_event_name: 'SessionStart', session_id: 's2', source: 'compact' }).out).hookSpecificOutput.additionalContext, /resources: sim,/);
});

test('dibs guard status calls a 0.0.74 install, which had no Stop hook, older, and install finishes it', t => {
  const file = path.join(tmp(t), 'settings.json');
  const g = matcher => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: '/opt/dibs/bin/dibs-guard.mjs', timeout: 5 }] });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [g(MATCHER), g('Agent|Task')], SubagentStart: [g()], SubagentStop: [g()] } }));
  const env = { ...process.env, DIBS_HOME: tmp(t) };
  const cli = (...args) => spawnSync(process.execPath, [BIN, 'guard', ...args, '--settings', file], { encoding: 'utf8', env });
  assert.equal(JSON.parse(cli('status', '--json').stdout).complete, false);
  assert.match(cli('status').stdout, /older install without .*messages from the person or the new-session primer\. Add them: dibs guard install/);
  assert.match(install(file, '/opt/dibs/bin/dibs-guard.mjs'), /updated/);
  assert.equal(JSON.parse(cli('status', '--json').stdout).complete, true);
  assert.doesNotMatch(cli('status').stdout, /older install/);
});
