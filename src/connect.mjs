// dibs connect: one front door for everything that connects to dibs on this Mac. With no
// arguments it explains the choices (and on a terminal, asks which); each choice runs the flow
// that already exists for it. dibs pair stays as it was, an alias for the code flows.
import readline from 'node:readline';
import { die } from './util.mjs';

const CHOICES = [
  ['browser', 'this browser', 'a one-time code for the page at http://127.0.0.1:7421', 'dibs connect --browser'],
  ['phone', 'a phone or another browser', 'a link and QR code, end-to-end encrypted through the relay', 'dibs connect --phone [--allow-actions]'],
  ['account', 'your dibs account', 'every browser you sign in with at app.dibs.cc opens this Mac', 'dibs connect --account [--allow-actions]'],
  ['mcp', 'another Claude account', 'its connector reads dibs (or acts) over MCP at mcp.dibs.cc', 'dibs connect --mcp [--allow-actions]'],
  ['machine', 'another machine', 'it takes jobs from this one and sends its own', 'dibs connect --machine [--name <name>]'],
];

function menu() {
  console.log('Connect something to dibs on this Mac:\n');
  CHOICES.forEach(([, what, why, cmd], i) => console.log(`  ${i + 1}  ${what.padEnd(27)} ${why}\n     ${cmd}\n`));
  console.log('dibs connect --list shows everything connected, dibs connect --remove <id> disconnects one,');
  console.log('and dibs connect --approve <code> lets a new browser of your account in.');
}

const clockOf = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const ask = q => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); resolve(a.trim()); });
});

// The accounts this Mac is on and the browsers waiting on it, for the Mac app and the page.
// Never the codes: the person reads those off the browser, which is the point of them.
export async function accountsJson() {
  const r = await import('./relay.mjs');
  return {
    accounts: Object.entries(r.load().accounts).map(([aid, a]) => ({ id: aid.slice(0, 8), label: a.label || null, joined: a.joined })),
    waiting: r.waitingApprovals().map(a => ({ id: a.id, account: a.aid.slice(0, 8), label: a.label, expires: a.exp })),
  };
}

export async function connect(args) {
  const [first, ...rest] = args;
  const web = () => import('./web.mjs');
  const relay = () => import('./relay.mjs');
  const flags = rest.filter(a => a.startsWith('--'));
  if (!first) {
    menu();
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    const a = await ask('\nWhich one? (1-5, or Enter to stop) ');
    const pick = CHOICES[Number(a) - 1];
    if (!pick) return;
    console.log('');
    return connect([`--${pick[0]}`]);
  }
  if (first === '--browser') return (await web()).pair([]);
  if (first === '--phone') return (await web()).pair(['--remote', ...flags]);
  if (first === '--account') {
    if (rest.some(a => a !== '--allow-actions')) die('dibs connect --account [--allow-actions]');
    return (await relay()).pairAccount({ act: rest.includes('--allow-actions') });
  }
  if (first === '--mcp') {
    const r = await relay();
    if (!r.load().mcp) await r.relay(['mcp', 'on']);
    console.log('');
    return (await web()).pair(flags);
  }
  if (first === '--machine') return (await web()).pair(['--machine', ...rest]);
  if (first === '--list') return (await web()).pair(['--list']);
  if (first === '--remove') {
    const which = rest[0] || die('remove which? dibs connect --list shows them, or --remove all');
    const n = (await relay()).removeAccount(which);
    if (n) console.log(`Took this Mac off ${n === 1 ? 'that dibs account' : `${n} dibs accounts`}: its browsers no longer reach it, and it can't approve new ones.`);
    return (await web()).pair(['--revoke', which]);
  }
  if (first === '--accounts') {
    const { accounts, waiting } = await accountsJson();
    if (rest.includes('--json')) return console.log(JSON.stringify({ accounts, waiting }));
    if (!accounts.length) return console.log('This Mac isn\'t on a dibs account. dibs connect --account adds it.');
    for (const a of accounts) console.log(`${a.id}  dibs account, joined ${new Date(a.joined).toLocaleString()}`);
    for (const a of waiting) console.log(`${a.id}  ${a.label} is waiting, until ${clockOf(a.expires)}`);
    return;
  }
  if (first === '--refuse') {
    const hit = (await relay()).refuseApproval(rest[0] || die('refuse which? dibs connect --accounts lists the waiting browsers'));
    if (!hit) die('No browser with that id is waiting. dibs connect --accounts lists them.', 1);
    return console.log(`Refused ${hit.label}. It hears so within a few seconds.`);
  }
  if (first === '--approve') {
    const r = await relay();
    const json = rest.includes('--json');
    const code = (rest.find(a => a !== '--json') || '').replace(/\D/g, '');
    if (!code) {
      const w = r.waitingApprovals();
      if (!w.length) return console.log('No browser is waiting for approval. A browser signed in to your dibs account by email shows a 6-digit code when it asks.');
      for (const a of w) console.log(`${a.label} is waiting, until ${clockOf(a.exp)}.`);
      return console.log('\nType the 6-digit code that browser shows: dibs connect --approve <code>. A code that doesn\'t match lets nothing in.');
    }
    if (code.length !== 6) die('the code is the 6 digits the browser shows: dibs connect --approve 123456');
    const hit = r.approve(code);
    if (!hit) die('No waiting browser shows that code. Check the digits on the browser, or ask again from it: codes last 10 minutes.', 1);
    if (hit.stale) die(`That's ${hit.label}'s code, but this Mac's relay connection restarted since it asked, and the key it would send went with it. Ask again from that browser.`, 1);
    if (hit.ambiguous) die(`${hit.ambiguous} waiting browsers show that code, which almost never happens by chance: something between your browser and this Mac may be guessing. Refused them all. Ask again from your browser.`, 1);
    if (json) return console.log(JSON.stringify({ approved: { id: hit.id, label: hit.label, confirm: hit.confirm } }));
    console.log(`Approved ${hit.label}. Now type this code into that browser:\n\n    ${hit.confirm.replace(/(\d{3})(\d{3})/, '$1 $2')}\n`);
    return console.log('It opens your account\'s key only with this code, so a key that didn\'t come from this Mac is never used.');
  }
  die(`unknown ${first}. dibs connect, or: ${CHOICES.map(c => `--${c[0]}`).join(', ')}, --list, --remove <id>, --accounts, --approve <code>, --refuse <id>`);
}
