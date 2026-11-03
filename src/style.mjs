// How output looks to a person at a terminal: color, and lines that fit.
// Color only when the stream is a terminal and NO_COLOR isn't set, so agents'
// logs and anything piped stay plain text. FORCE_COLOR turns it on anyway.
const colored = stream => !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || (!!stream?.isTTY && process.env.TERM !== 'dumb'));
const paint = (open, close) => (s, stream = process.stdout) => (colored(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const bold = paint(1, 22);
export const dim = paint(2, 22);
// Amber is for what needs you or comes next; red only for real errors.
export const amber = paint(33, 39);
export const red = paint(31, 39);

// Nothing wider than this, even on a wide terminal: long lines are hard to read.
const MAX_WIDTH = 100;
export const width = (stream = process.stdout) => Math.min(MAX_WIDTH, stream?.columns || MAX_WIDTH);
const shown = s => s.replace(/\x1b\[\d+m/g, '').length;

// Word-wrap text to the width, keeping its own leading spaces, with `indent`
// before every line after the first.
export function wrap(text, indent = '', w = width()) {
  const lead = String(text).match(/^ */)[0];
  const out = [];
  let line = lead;
  for (const word of String(text).slice(lead.length).split(' ')) {
    if (line.trim() && shown(line) + 1 + shown(word) > w) { out.push(line); line = indent + word; }
    else line = line.trim() ? `${line} ${word}` : line + word;
  }
  out.push(line);
  return out.join('\n');
}

// Two columns: a label, then lines of text that wrap under themselves. A label
// too long for the column gets a line of its own.
export function columns(rows, w = width(), most = 18) {
  const col = Math.min(most, Math.max(0, ...rows.map(([k]) => shown(k)))) + 3;
  const pad = ' '.repeat(col);
  return rows.flatMap(([k, ...lines]) => {
    const body = lines.filter(Boolean).flatMap(l => wrap(l, '', w - col).split('\n'));
    if (shown(k) + 3 > col) return [k, ...body.map(b => pad + b)];
    return body.map((b, i) => (i ? pad : k + ' '.repeat(col - shown(k))) + b);
  });
}

// A command as someone could paste it back into a shell.
export const quoted = args => args.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
