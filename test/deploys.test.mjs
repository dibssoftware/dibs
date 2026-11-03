// Deploys are one at a time per project, not per machine (exclusiveBy: "repo"): a deploy of
// another project starts beside one running, up to 3 projects at once. On 2026-11-03 a
// 6-second web deploy waited behind another project's TestFlight upload in the one deploy
// slot, and the person had to tell its agent to go around dibs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// helpers first: it points DIBS_HOME at a temp folder before any src module loads.
import { G, MACHINE, tmp, sync, bg, until, board, gitProject } from './helpers.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { verdict } from '../src/schedule.mjs';
import { projectKey } from '../src/files.mjs';

const WIN = process.platform === 'win32';
const T = Date.now();
const cfg = (o = {}) => ({ ...DEFAULT_CONFIG, budget: '11G', cores: 10, ...o, resources: { ...DEFAULT_CONFIG.resources, ...o.resources } });
let n = 0;
const lease = repo => ({ id: ++n, kind: 'run', res: ['deploy'], who: `l${n}`, mem: 0.5 * G, cpu: 1, start: T - 60e3, pid: 1, key: 'deploy|ship.sh', repo, cwd: `/src/${repo}` });
const waiter = repo => ({ id: ++n, res: ['deploy'], who: 'me', mem: 0.5 * G, cpu: 1, disk: 0, pid: 1, enq: T, key: 'deploy|bump.sh', kind: 'run', repo, cwd: `/src/${repo}` });
function judge(s, me, c = cfg()) {
  const was = process.env.DIBS_FAKE_MACHINE;
  process.env.DIBS_FAKE_MACHINE = JSON.stringify({ ...MACHINE, memFree: 67, cores: 10 });
  try { return verdict(s, me, c, [], T); } finally { process.env.DIBS_FAKE_MACHINE = was; }
}

test('a deploy of another project starts beside a running one; one of the same project waits its turn', () => {
  const ios = lease('git@github.com:me/ios.git');
  const web = waiter('git@github.com:me/web.git');
  assert.equal(judge({ leases: [ios], queue: [web] }, web).ok, true);
  const again = waiter('git@github.com:me/ios.git');
  const v = judge({ leases: [ios], queue: [again] }, again);
  assert.equal(v.rule, 'slot');
  assert.equal(v.why, 'deploy is in use for this project');
  // A waiter of another project ahead doesn't hold it back: the cap has room for both.
  const ahead = { ...waiter('git@github.com:me/api.git'), enq: T - 6e5 };
  assert.equal(judge({ leases: [ios], queue: [ahead, web] }, web).ok, true);
});

test('at most 3 projects deploy at once', () => {
  const three = ['a', 'b', 'c'].map(lease);
  const fourth = waiter('d');
  const v = judge({ leases: three, queue: [fourth] }, fourth);
  assert.equal(v.rule, 'slot');
  assert.equal(v.why, 'deploy is in use by 3 projects at once, the most at a time');
  assert.equal(judge({ leases: three.slice(0, 2), queue: [fourth] }, fourth).ok, true);
});

test('a config that says deploy: {slots: 1} still goes per project, and exclusiveBy null puts it back to one for the machine', () => {
  const own = cfg({ resources: { deploy: { ...DEFAULT_CONFIG.resources.deploy, slots: 1 } } });
  const web = waiter('web');
  assert.equal(judge({ leases: [lease('ios')], queue: [web] }, web, own).ok, true);
  const machineWide = cfg({ resources: { deploy: { ...DEFAULT_CONFIG.resources.deploy, exclusiveBy: null } } });
  assert.equal(judge({ leases: [lease('ios')], queue: [web] }, web, machineWide).rule, 'slot');
  // An older dibs's lease has no project: its folder stands in.
  const old = { ...lease('x'), repo: undefined, cwd: '/src/web' };
  assert.equal(judge({ leases: [old], queue: [{ ...web, repo: undefined }] }, { ...web, repo: undefined }).rule, 'slot');
});

test("a folder's project: its repo's origin URL, else the repo, else the folder itself", t => {
  const plain = tmp(t, 'plain');
  assert.equal(projectKey(plain), plain);
  const repo = gitProject(t);
  assert.equal(projectKey(path.join(repo)), fs.realpathSync(repo));
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:me/web.git'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.equal(projectKey(path.join(repo, 'sub')), 'git@github.com:me/web.git');
});

test('real deploys: another project starts beside a running one, the same project waits, and a job sent from another machine goes by its origin', { skip: WIN }, async t => {
  const h = tmp(t);
  // This Mac's own config says only slots: 1, and still gets one deploy per project.
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ resources: { deploy: { slots: 1 } } }));
  const ios = gitProject(t), web = gitProject(t), loose = tmp(t, 'loose');
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:me/ios.git'], { cwd: ios });
  const gate = path.join(h, 'gate');
  const upload = bg(t, h, ['run', 'deploy', '-m', 'TestFlight upload', '--', 'sh', '-c', `while [ ! -f '${gate}' ]; do sleep 0.1; done`], { agent: 'ios', cwd: ios });
  await until(() => board(h).held.length === 1);
  const quick = sync(h, ['run', 'deploy', '--max-wait', '30s', '--', 'echo', 'shipped web'], { agent: 'web', cwd: web });
  assert.equal(quick.code, 0, quick.err);
  assert.match(quick.out, /shipped web/);
  assert.equal(sync(h, ['run', 'deploy', '--max-wait', '1s', '--', 'true'], { agent: 'ios2', cwd: ios }).code, 75, 'the same project waits');
  // Sent from another machine, its copy has no .git: it goes by the origin its sender said.
  assert.equal(sync(h, ['run', 'deploy', '--max-wait', '1s', '--', 'true'], { agent: 'sent', cwd: loose, env: { DIBS_REPO: 'git@github.com:me/ios.git' } }).code, 75);
  assert.equal(sync(h, ['run', 'deploy', '--max-wait', '30s', '--', 'true'], { agent: 'loose', cwd: loose }).code, 0, 'a folder outside git is its own project');
  assert.match(sync(h, [], { agent: 'viewer' }).out, /deploying \(one per project, up to 3 at once\)|Deploys/);
  fs.writeFileSync(gate, '');
  assert.equal(await upload.done, 0);
});
