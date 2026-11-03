// dibs service: keep the coordinator, the worker and the throttle watcher
// running across logins and reboots. launchd on macOS, systemd --user on
// Linux, Task Scheduler on Windows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.mjs';
import { OS } from './platform.mjs';
import { makeAlive } from './proc.mjs';
import { die, sleepSync } from './util.mjs';
import { logChange } from './owner.mjs';
import { unpatched } from './nodecheck.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dibs.mjs');
const KINDS = {
  serve:    { args: ['serve'],               what: 'the coordinator for your machines' },
  worker:   { args: ['worker'],              what: 'takes jobs from the coordinator' },
  throttle: { args: ['throttle', '--watch'], what: 'moves hot work outside dibs to background priority' },
  web:      { args: ['web'],                 what: 'the page and MCP server showing your agents\' work' },
  relay:    { args: ['relay'],               what: 'reach the page from any browser through the encrypted relay (dibs pair --remote)' },
};
// Things started by hand before the service existed; stopped so the service can take over.
const PIDFILES = { worker: 'worker.pid', throttle: 'cool.pid' };

const label = k => `dev.dibs.${k}`;
// DIBS_LAUNCH_AGENTS and DIBS_LAUNCHCTL stand in for ~/Library/LaunchAgents and launchctl in tests.
const plist = k => path.join(process.env.DIBS_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents'), `${label(k)}.plist`);
const LAUNCHCTL = process.env.DIBS_LAUNCHCTL || 'launchctl';
const unit = k => path.join(process.env.DIBS_LAUNCH_AGENTS || path.join(os.homedir(), '.config', 'systemd', 'user'), `dibs-${k}.service`);
const logFile = k => path.join(HOME, `${k}.log`);
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return e.stdout || ''; } };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uid = () => process.getuid?.() ?? 0;

function env() {
  const e = { PATH: process.env.PATH, HOME: os.homedir() };
  if (process.env.DIBS_HOME) e.DIBS_HOME = process.env.DIBS_HOME;
  return e;
}

function stopManual(k) {
  try {
    const pid = Number(fs.readFileSync(path.join(HOME, PIDFILES[k]), 'utf8'));
    if (pid && makeAlive([pid])(pid)) { process.kill(pid, 'SIGTERM'); console.log(`  stopped the ${k} started by hand (pid ${pid})`); }
  } catch {}
}

// The Node a service should start by: a link that follows upgrades, not the
// versioned folder this Node runs from. On 2026-10-21 `brew upgrade` replaced
// Cellar/node/25.9.0_2 with 26.12.0, and at the next release all three services
// failed to start again (EX_CONFIG). Homebrew's opt/node link, then the bin link, when
// either is this same Node; any other Node as it is.
const LINKS = ['/opt/homebrew/opt/node/bin/node', '/opt/homebrew/bin/node', '/usr/local/opt/node/bin/node', '/usr/local/bin/node'];
export function stableNode(exec = process.execPath, links = LINKS) {
  if (!/\/Cellar\//.test(exec)) return exec;
  let real = exec;
  try { real = fs.realpathSync(exec); } catch {}
  for (const l of links) { try { if (fs.realpathSync(l) === real) return l; } catch {} }
  return exec;
}

// launchctl bootout returns before the service is gone, and a bootstrap then
// fails with "5: Input/output error": on 2026-10-22 reinstalling the services
// left the worker and the throttle down. So wait for it to go (UNLOAD_WAIT at
// most), and try the bootstrap again a few times.
const UNLOAD_WAIT = 10e3, BOOT_TRIES = 5;
const loaded = k => { try { execFileSync(LAUNCHCTL, ['print', `gui/${uid()}/${label(k)}`], { stdio: 'ignore' }); return true; } catch { return false; } };
function unload(k) {
  if (!loaded(k)) return;
  sh(LAUNCHCTL, ['bootout', `gui/${uid()}/${label(k)}`]);
  for (const t0 = Date.now(); loaded(k) && Date.now() - t0 < UNLOAD_WAIT;) sleepSync(200);
}
function bootstrap(k) {
  for (let i = 1; ; i++) {
    try { execFileSync(LAUNCHCTL, ['bootstrap', `gui/${uid()}`, plist(k)], { stdio: ['ignore', 'pipe', 'pipe'] }); return; }
    catch (e) { if (i >= BOOT_TRIES) die(`launchctl couldn't load ${label(k)}: ${String(e.stderr || e.message).trim()}. Try again: dibs service install ${k}`); }
    sleepSync(1000);
  }
}

function install(k) {
  const argv = [stableNode(), BIN, ...KINDS[k].args];
  fs.mkdirSync(HOME, { recursive: true });
  // Out of launchd first, so the pidfile's process (if any is left) was started by hand.
  if (OS === 'macos') unload(k);
  if (PIDFILES[k]) stopManual(k);
  if (OS === 'macos') {
    // Jobs a worker runs inherit its scheduling class, so it can't be Background.
    const type = { serve: 'Standard', worker: 'Interactive', throttle: 'Background', web: 'Standard', relay: 'Standard' }[k];
    fs.mkdirSync(path.dirname(plist(k)), { recursive: true });
    fs.writeFileSync(plist(k), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(k)}</string>
  <key>ProgramArguments</key>
  <array>${argv.map(a => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env()).map(([a, b]) => `<key>${esc(a)}</key><string>${esc(b)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>${type}</string>
  <key>StandardOutPath</key><string>${esc(logFile(k))}</string>
  <key>StandardErrorPath</key><string>${esc(logFile(k))}</string>
</dict>
</plist>
`);
    bootstrap(k);
  } else if (OS === 'linux') {
    fs.mkdirSync(path.dirname(unit(k)), { recursive: true });
    const q = a => `"${String(a).replace(/(["\\$`])/g, '\\$1')}"`;
    fs.writeFileSync(unit(k), `[Unit]
Description=dibs ${k}: ${KINDS[k].what}

[Service]
ExecStart=${argv.map(q).join(' ')}
${Object.entries(env()).map(([a, b]) => `Environment=${q(`${a}=${b}`)}`).join('\n')}
Restart=always
RestartSec=10
StandardOutput=append:${logFile(k)}
StandardError=append:${logFile(k)}

[Install]
WantedBy=default.target
`);
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `dibs-${k}.service`], { stdio: 'inherit' });
    console.log(`  to keep it running while you're logged out: loginctl enable-linger ${os.userInfo().username}`);
  } else {
    const cmd = `cmd /c ""${argv[0]}" "${argv[1]}" ${KINDS[k].args.join(' ')} >> "${logFile(k)}" 2>&1"`;
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', `dibs ${k}`, '/TR', cmd], { stdio: 'inherit' });
    execFileSync('schtasks', ['/Run', '/TN', `dibs ${k}`], { stdio: 'inherit' });
  }
  console.log(`installed dibs ${k}: ${KINDS[k].what}. Log: ${logFile(k)}`);
}

function remove(k) {
  let had = false;
  if (OS === 'macos') {
    sh(LAUNCHCTL, ['bootout', `gui/${uid()}/${label(k)}`]);
    if (fs.existsSync(plist(k))) { fs.rmSync(plist(k)); had = true; }
  } else if (OS === 'linux') {
    sh('systemctl', ['--user', 'disable', '--now', `dibs-${k}.service`]);
    if (fs.existsSync(unit(k))) { fs.rmSync(unit(k)); had = true; sh('systemctl', ['--user', 'daemon-reload']); }
  } else {
    sh('schtasks', ['/End', '/TN', `dibs ${k}`]);
    had = sh('schtasks', ['/Delete', '/F', '/TN', `dibs ${k}`]).length > 0;
  }
  console.log(had ? `removed dibs ${k}` : `dibs ${k} wasn't installed`);
}

// Out of launchd or systemd, and one started by hand stopped too (dibs leave). One that
// isn't installed is left alone: nothing to take out, and nothing touched that dibs didn't put there.
export function removeService(k) {
  if (PIDFILES[k]) stopManual(k);
  if (state(k) !== 'not installed') remove(k);
}

function state(k) {
  if (OS === 'macos') {
    if (!fs.existsSync(plist(k))) return 'not installed';
    const out = sh(LAUNCHCTL, ['print', `gui/${uid()}/${label(k)}`]);
    const pid = out.match(/\bpid = (\d+)/)?.[1];
    return pid ? `running (pid ${pid})` : `installed, not running${out.match(/last exit code = (.*)/) ? ` (last exit ${out.match(/last exit code = (.*)/)[1].trim()})` : ''}`;
  }
  if (OS === 'linux') {
    if (!fs.existsSync(unit(k))) return 'not installed';
    return sh('systemctl', ['--user', 'is-active', `dibs-${k}.service`]).trim() || 'unknown';
  }
  const out = sh('schtasks', ['/Query', '/TN', `dibs ${k}`, '/FO', 'LIST']);
  return out ? (out.match(/Status:\s*(.*)/)?.[1]?.trim() || 'installed') : 'not installed';
}

const relayStatus = async () => { try { return (await import('./relay.mjs')).statusLine(); } catch { return null; } };

// dibs service install|remove|status [serve] [worker] [throttle] [web] [relay]
// What dibs service status says, as data, for dibs web.
export function servicesJson() {
  return Object.entries(KINDS).map(([name, k]) => ({ name, state: state(name), what: k.what }));
}

export async function service(args) {
  const [action = 'status', ...rest] = args.filter(a => !a.startsWith('-'));
  const kinds = rest.length ? rest : action === 'status' ? Object.keys(KINDS) : [];
  for (const k of kinds) if (!KINDS[k]) die(`no service called ${k}. Services: ${Object.keys(KINDS).join(', ')}`);
  if (action === 'status') {
    for (const k of kinds) console.log(`${k.padEnd(9)} ${state(k).padEnd(28)} ${KINDS[k].what}`);
    // The relay's own view: connected or not, since when, how many devices.
    if (kinds.includes('relay')) { const s = await relayStatus(); if (s) console.log(`          relay: ${s}`); }
    return;
  }
  if (!kinds.length) die(`which? dibs service ${action} serve|worker|throttle|web|relay   (several at once is fine)`);
  // A service runs for weeks and listens on the network: not on a Node with a known hole.
  const hole = action === 'install' && !process.env.DIBS_ALLOW_UNPATCHED && unpatched();
  if (hole) die(`${hole}. The service would run on that Node (${process.execPath}): put a fixed one first on your PATH and run this again.`);
  if (action === 'install' || action === 'remove') logChange(`service ${action}`, { services: kinds });
  if (action === 'install') kinds.forEach(install);
  else if (action === 'remove') kinds.forEach(remove);
  else die('dibs service install|remove|status [serve] [worker] [throttle] [web] [relay]');
}
