// Builds public/ for the Worker from the dibs page in ../web: the same files dibs web
// serves at 127.0.0.1, with Subresource Integrity on every script and stylesheet,
// and public/hashes.txt listing the SHA-384 of each file so anyone can check the
// page app.dibs.cc serves against this repo (curl it, hash it, compare).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
const OUT = path.join(HERE, 'public');
const FILES = ['app.css', 'app.js', 'transport.js', 'dither.js', 'authorize.js', 'logo.png', 'SchibstedGrotesk.woff2'];

const sri = b => `sha384-${crypto.createHash('sha384').update(b).digest('base64')}`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'web'), { recursive: true });
const hashes = {};
for (const f of FILES) {
  const b = fs.readFileSync(path.join(WEB, f));
  fs.writeFileSync(path.join(OUT, 'web', f), b);
  hashes[`/web/${f}`] = sri(b);
}
// The page, and the MCP sign-in page mcp.dibs.cc serves at /<machine>/authorize.
function page(name, transport) {
  let html = fs.readFileSync(path.join(WEB, name), 'utf8');
  html = html.replace(/<script src="(\/web\/[^"]+)"><\/script>/g, (m, src) => {
    if (!hashes[src]) throw new Error(`${name} loads ${src}, which build.mjs doesn't copy`);
    return `<script src="${src}" integrity="${hashes[src]}"></script>`;
  });
  html = html.replace(/<link rel="stylesheet" href="(\/web\/[^"]+)">/g, (m, href) => `<link rel="stylesheet" href="${href}" integrity="${hashes[href]}">`);
  // transport.js reads this to talk through the relay instead of fetching from 127.0.0.1.
  if (transport) html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="dibs-transport" content="relay">');
  if (/<script(?![^>]*\bsrc=)/.test(html) || /\son[a-z]+=/i.test(html)) throw new Error(`${name} has inline script, which the page's CSP forbids`);
  fs.writeFileSync(path.join(OUT, name), html);
  return sri(html);
}
hashes['/'] = page('index.html', true);
hashes['/<machine>/authorize'] = page('authorize.html', false);
const list = Object.entries(hashes).map(([p, h]) => `${h}  ${p}`).join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'hashes.txt'), list);
process.stdout.write(list);
