// What every new agent session hears about dibs before its first prompt, from
// the guard hook's SessionStart (and a subagent's SubagentStart). Most agents
// never read the docs, and many have nobody relaying messages, so the few
// rules that keep them out of trouble arrive with the session. Loaded only
// for those events; it reads config.json for the resource names and nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIBS_HOME = process.env.DIBS_HOME || path.join(os.homedir(), '.dibs');
const BUILT_IN = ['sim', 'sim-own', 'xcode-build', 'test', 'playwright', 'deploy', 'heavy'];

// The resources this machine has: the built-in ones plus any config.json adds.
function resources() {
  let extra = [];
  try { extra = Object.keys(JSON.parse(fs.readFileSync(path.join(DIBS_HOME, 'config.json'), 'utf8')).resources || {}); } catch {}
  return [...new Set([...BUILT_IN, ...extra])].join(', ');
}

// The rules every agent gets first, and nothing else: what to wrap and how, what
// needs no dibs, staying reachable, the two exit codes agents hit, and when to ask
// the person. One source: the session primer below, and the top of
// skills/dibs/SKILL.md and README.md's "Tell your agents", which writeRules()
// fills from it (test/rules.test.mjs checks they match). The rest is reference,
// under the skill's "When you need it": agents that got every rule up front
// skimmed them all (feedback, 2026-11-03).
export function rules(res = resources(), more = 'is in dibs.md beside dibs (the dibs skill) and in `dibs help`') {
  return [
    'dibs runs on this machine. Agents take turns through it on the simulator, Xcode builds, test suites, browser runs and deploys.',
    `- Wrap those: \`dibs run <resource> -m "why" -- <command>\` (resources: ${res}). Two at once: \`dibs run sim,xcode-build -- ...\`.`,
    '- No dibs for reads, edits, small commands, or long jobs that mostly wait on the network and use little CPU, memory or disk (crawlers, pollers, HTTP checks). The hook leaves those alone too.',
    '- Start `dibs listen` with run_in_background now, and again each time it exits: it wakes you when the person or dibs has something for you.',
    '- Waiting is normal. A call moved to the background is still waiting: don\'t run it again. A wait on memory, swap or disk protects the machine: keep waiting, and never lower `--mem` or raise `-p` to get past it.',
    '- Exit 75: it gave up waiting and your command never ran; run the same command again. Exit 74: not enough free disk; free your own build output, or tell the person.',
    '- Decide what you can undo yourself. Ask the person only before something you can\'t undo (`dibs question ... --one-way`). Lines starting "Message from the person:" are theirs: act on them.',
    '- Post progress as you work: `dibs progress "what you did or found" --task <name> --eta 30m`, then `--done`.',
    `- The rest (holding across tool calls, file leases, other machines, every exit code, overriding jobs, questions) ${more}.`,
  ];
}

// A subagent ends with its task, so it isn't told to keep a listener running.
export const primerText = ({ subagent = false } = {}) => rules().filter(l => !(subagent && l.includes('dibs listen'))).join('\n');

// The rules as the skill and the README carry them, between their markers, with the
// built-in resources (a machine's config adds its own; the primer names those).
const MARK = /<!-- dibs:rules:start -->[\s\S]*?<!-- dibs:rules:end -->/;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS = {
  'skills/dibs/SKILL.md': () => rules(BUILT_IN.join(', '), 'is below, under "When you need it", and in `dibs help`'),
  // A block to paste, fenced, for anyone who doesn't let dibs init write the note.
  'README.md': () => ['```markdown', '## dibs', ...rules(BUILT_IN.join(', '), 'is in the dibs skill and in `dibs help`'), '```'],
};
export const marked = lines => `<!-- dibs:rules:start -->\n${lines.join('\n')}\n<!-- dibs:rules:end -->`;
export function writeRules(root = ROOT) {
  for (const [f, make] of Object.entries(DOCS)) {
    const file = path.join(root, f);
    const text = fs.readFileSync(file, 'utf8');
    if (!MARK.test(text)) throw new Error(`${f} has no <!-- dibs:rules:start --> ... <!-- dibs:rules:end --> to fill`);
    fs.writeFileSync(file, text.replace(MARK, marked(make())));
  }
}

// Each subagent hears it once: SubagentStart also fires every time an agent
// team teammate takes a new message. A short list of ids it was told, newest last.
const TOLD = path.join(DIBS_HOME, 'primed.json');
const REMEMBER = 500;
function firstTime(agentId) {
  let told = [];
  try { told = JSON.parse(fs.readFileSync(TOLD, 'utf8')); } catch {}
  if (told.includes(agentId)) return false;
  told.push(agentId);
  try {
    fs.mkdirSync(DIBS_HOME, { recursive: true });
    fs.writeFileSync(`${TOLD}.${process.pid}`, JSON.stringify(told.slice(-REMEMBER)));
    fs.renameSync(`${TOLD}.${process.pid}`, TOLD);
  } catch {}
  return true;
}

// The hook's answer for SessionStart and SubagentStart, merged into out (the
// subagent limit's own answer, which is null for a start). Null when there is
// nothing to say.
export function primer(input, out) {
  const event = input.hook_event_name;
  if (event === 'SubagentStart' && (typeof input.agent_id !== 'string' || !firstTime(input.agent_id))) return out;
  return { ...out, hookSpecificOutput: { hookEventName: event, additionalContext: primerText({ subagent: event === 'SubagentStart' }) } };
}
