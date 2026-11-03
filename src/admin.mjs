// dibs invite, kick and limit: run on the coordinator's machine, which is the
// only one whose token may change who is in the group. An invited machine
// runs commands for every other one, so each change is logged with who made it.
import { remoteConf, call, LOST } from './remote.mjs';
import { logChange } from './owner.mjs';
import { NAME } from './trust.mjs';
import { die, dur, now } from './util.mjs';

// ok: whether the reply is what a dibs coordinator sends. Anything else on the
// port (another program, an older dibs) is said plainly, not printed as "undefined".
async function admin(route, body, ok) {
  const rc = remoteConf();
  if (!rc) die('this machine runs no coordinator. Run this on the machine that does (dibs service install serve)');
  let r;
  try { r = await call(rc, 'POST', route, body, { timeout: 8000 }); }
  catch (e) { die(e.status ? e.message : `can't reach the coordinator at ${rc.url} (${e.message}). Is it running? dibs service status`, e.status ? 2 : LOST); }
  if (!r || typeof r !== 'object' || !ok(r)) die(`${rc.url} answered, but not as a dibs coordinator of this version would. Is the coordinator running there, and up to date? dibs service status`, LOST);
  return r;
}

// dibs invite <name>
export async function invite(o) {
  const [name] = o.res;
  if (!name || o.res.length > 1) die('dibs invite <name>   (the name the machine will go by)');
  const r = await admin('/admin/invite', { name }, r => typeof r.token === 'string' && r.token.length > 0);
  logChange('invite', { machine: name });
  if (r.replaced) console.log(`${name} had a token already. That one stopped working now${r.lost ? `, and ${r.lost} job${r.lost > 1 ? 's' : ''} running there ${r.lost > 1 ? 'were' : 'was'} stopped` : ''}.`);
  console.log(`On ${name}, run:\n\n  dibs join ${r.url || remoteConf().url} ${r.token} --name ${name}\n  dibs service install worker\n`);
  if (!r.url) console.log(`This coordinator has no Tailscale address yet, so swap ${remoteConf().url} for an address ${name} can reach.`);
  console.log(`Anyone with that line can run commands on your machines as you. Send it only to ${name}. dibs kick ${name} takes it back.`);
}

// dibs kick <name>
export async function kick(o) {
  const [name] = o.res;
  if (!name || o.res.length > 1) die('dibs kick <name>   (dibs machines lists them)');
  const r = await admin('/admin/kick', { name }, r => Number.isInteger(r.lost) && Number.isInteger(r.cancelled));
  logChange('kick', { machine: name });
  const n = (k, what) => `${k} job${k === 1 ? '' : 's'} ${what}`;
  console.log(`removed ${name}: its token no longer works. ${n(r.lost, 'running there')} reported lost to the sender, ${n(r.cancelled, 'it sent')} stopped.`);
}

// dibs limit <name> --only test,heavy | --sends test|none | --any
export async function limit(o) {
  const [name] = o.res;
  const set = o.only || o.sends;
  if (!name || o.res.length > 1 || (!set === !o.any)) die('dibs limit <machine> --only test,heavy (what it takes) and/or --sends test|none (what it may send)   (or --any to lift both)');
  const body = o.any ? { name, only: null, sends: null } : { name, ...(o.only && { only: o.only }), ...(o.sends && { sends: o.sends }) };
  // An older coordinator ignores sends; its reply has no sends field to show it.
  const r = await admin('/admin/limit', body, r => r.name === name && (!('sends' in body) || 'sends' in r));
  logChange('limit', { machine: name, only: r.only || null, sends: r.sends || null });
  if (!r.only && !r.sends) return console.log(`${name} takes any job again, and may send any job`);
  const takes = r.only ? `only takes ${r.only.join(', ')} jobs from other machines` : 'takes any job from other machines';
  const sends = !r.sends ? 'may send any job' : r.sends.length ? `may only send ${r.sends.join(', ')} jobs to other machines` : 'may send no jobs to other machines';
  console.log(`${name} now ${takes}, and ${sends}`);
}

// dibs pair --machine [--name <name>] [--json]: a one-time code a new machine joins with,
// in one step on that machine: dibs join <code>.
export async function pairMachine(args) {
  let name = null, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') name = args[++i] ?? die('--name needs the name the machine will go by');
    else if (args[i] === '--json') json = true;
    else die(`unknown ${args[i]}. dibs pair --machine [--name <name>]`);
  }
  if (name != null && !NAME.test(name)) die('a machine name is letters, digits, dots, dashes and underscores');
  const r = await admin('/admin/pair', { name }, r => typeof r.code === 'string' && Array.isArray(r.urls));
  logChange('pair machine', { code: r.id, ...(name && { machine: name }) });   // never the code itself
  if (json) return console.log(JSON.stringify(r));
  const out = [r.code, '', `On the new machine${name ? ` (it joins as ${name})` : ''}:`, '', `  dibs join ${r.code}`, '  dibs service install worker', '',
    `One use, good for ${Math.round((r.exp - now()) / 6e4)} minutes. dibs join finds this coordinator on the same network or through Tailscale${r.urls.length ? ` (${r.urls.join(', ')})` : ''};`
    + ' if it can\'t, add --at <this machine\'s address>.'];
  if (!r.urls.length) out.push('This coordinator listens only on this machine for now, so no other machine can reach it. Bring Tailscale up here (it starts listening on it within 30 seconds),'
    + ' or run the coordinator on this machine\'s network address: dibs serve --bind <address>.');
  out.push(`Whoever joins with it can run commands on every machine in the group. dibs pair --list shows it; dibs pair --revoke ${name || '<machine>'} removes a machine that joined.`);
  console.log(out.join('\n'));
}

// The coordinator's open machine codes and its machines, for dibs pair --list and
// --revoke. null when this machine runs no coordinator; { error } when it can't be reached.
export async function machinePairs() {
  const rc = remoteConf(() => null);
  if (!rc || !/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(rc.url)) return null;
  try { return await call(rc, 'GET', '/admin/pairs', undefined, { timeout: 3000 }); }
  catch (e) { return { error: e.status ? e.message : `the coordinator at ${rc.url} isn't answering (${e.message})` }; }
}
export function pairLines(p) {
  if (!p) return [];
  if (p.error) return [`Machines: ${p.error}`];
  const t = p.now;
  return [
    ...p.codes.map(c => `${c.id}  machine code${c.name ? ` for ${c.name}` : ''}, open ${dur(c.exp - t)} more`),
    ...p.machines.map(m => `${m.name.padEnd(8)}  machine${m.online ? ', taking jobs' : ''}, ${m.paired ? `joined with a code ${new Date(m.paired).toLocaleString()}` : `invited ${new Date(m.invited).toLocaleString()}`}`),
  ];
}
// --revoke <which>: an open code by id, or a machine by name (kicked). all voids every open code
// and leaves machines in the group: removing them all at once is dibs kick, one by one.
export async function unpairMachine(which, p) {
  if (!p || p.error) return 0;
  if (which === 'all') return p.codes.length ? (await admin('/admin/unpair', { id: 'all' }, r => Number.isInteger(r.removed))).removed : 0;
  const c = p.codes.find(x => x.id.startsWith(which));
  if (c) return (await admin('/admin/unpair', { id: c.id }, r => Number.isInteger(r.removed))).removed;
  if (p.machines.some(m => m.name === which)) { await kick({ res: [which] }); return 1; }
  return 0;
}
