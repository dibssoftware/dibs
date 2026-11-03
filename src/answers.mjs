// dibs ask, on a machine where nobody maintains dibs: the closest passages in
// the docs that ship with it, found by the words they share with the question.
// Plain keyword overlap is enough for "how do I ..." about a small tool, and
// needs no index or model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['skills/dibs/SKILL.md', 'README.md', ...['guard', 'files', 'questions', 'later', 'machines', 'simulators', 'scheduling', 'relay'].map(d => `docs/${d}.md`)];
export const ISSUES = 'https://github.com/dibssoftware/dibs/issues';
// Two passages answer most questions; more is reading the docs.
const SHOW = 2;
// A passage this long is a table or a wall of text: cut to its start.
const MAX_CHARS = 600;
const STOP = new Set(('the a an and or but to of in on for with is are was be it this that how do does i my me you your can why what when '
  + 'should would could not no if at as by from so get got use using run dibs it\'s don\'t doesn\'t there their they them about into just').split(' '));

const words = text => text.toLowerCase().match(/[a-z0-9][a-z0-9:_-]*/g)?.filter(w => (w.length > 2 || /^\d+$/.test(w)) && !STOP.has(w)) || [];

// A list or a table is one paragraph but many answers: shown whole and cut to its
// start, the item that matched was often past the cut. Each item and each table
// row is its own passage; a paragraph stays whole.
function pieces(block) {
  const lines = block.split('\n');
  if (lines.every(l => l.startsWith('|'))) return lines.filter(l => !/^\|[\s:|-]+\|$/.test(l)).slice(1);
  // The README's paste-in block for agents is one fence of bullets: each bullet answers on its own.
  if (lines[0] === '```markdown') return lines.filter(l => l.startsWith('- '));
  if (!/^(- |\d+\. )/.test(lines[0])) return [block];
  const items = [];
  for (const l of lines) if (/^(- |\d+\. )/.test(l) || !items.length) items.push(l); else items[items.length - 1] += `\n${l}`;
  return items;
}

// Every paragraph of the docs, with the heading it sits under.
function passages() {
  const out = [];
  for (const rel of DOCS) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
    let heading = '';
    for (const block of text.split(/\n\s*\n/)) {
      const b = block.trim();
      if (!b || b.startsWith('---')) continue;
      if (/^#+ /.test(b) && !b.includes('\n')) { heading = b.replace(/^#+ /, ''); continue; }
      for (const text of pieces(b)) out.push({ file: rel, heading, text });
    }
  }
  return out;
}

// The best passages for a question: each question word found counts once, a
// rare word more than a common one, and the heading counts like the text.
export function answer(question) {
  const want = [...new Set(words(question))];
  if (!want.length) return [];
  const all = passages();
  const has = all.map(p => new Set(words(`${p.heading} ${p.text}`)));
  const weight = new Map(want.map(w => [w, Math.log(1 + all.length / (1 + has.filter(s => s.has(w)).length))]));
  return all.map((p, i) => ({ ...p, score: want.reduce((n, w) => n + (has[i].has(w) ? weight.get(w) : 0), 0), hits: want.filter(w => has[i].has(w)).length }))
    .filter(p => p.hits >= Math.min(2, want.length))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHOW)
    .map(p => ({ where: `${p.file}${p.heading ? ` (${p.heading})` : ''}`, text: p.text.length > MAX_CHARS ? `${p.text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '')} ...` : p.text }));
}
