// What every new agent session hears about dibs before its first prompt, from
// the guard hook's SessionStart (and a subagent's SubagentStart). Most agents
// never read the docs, and many have nobody relaying messages, so the few
// rules that keep them out of trouble arrive with the session. Loaded only
// for those events; it reads config.json for the resource names and nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIBS_HOME = process.env.DIBS_HOME || path.join(os.homedir(), '.dibs');
const BUILT_IN = ['sim', 'sim-own', 'xcode-build', 'test', 'playwright', 'deploy', 'heavy'];

// The resources this machine has: the built-in ones plus any config.json adds.
function resources() {
  let extra = [];
  try { extra = Object.keys(JSON.parse(fs.readFileSync(path.join(DIBS_HOME, 'config.json'), 'utf8')).resources || {}); } catch {}
  return [...new Set([...BUILT_IN, ...extra])].join(', ');
}

export function primerText() {
  return [
    'dibs runs on this machine: agents take turns through it on the simulator, builds, tests, browser runs and deploys.',
    `- Wrap those: dibs run <resource> -m "why" -- <command> (resources: ${resources()}). Across several tool calls: dibs hold sim --for 20m -m "why", `
      + 'keep wrapping each command (no wait under your hold), dibs release sim. Reads, edits and small commands need nothing.',
    '- Waiting is normal. A call moved to the background is still waiting: don\'t run it again. '
      + 'A memory, swap or disk wait protects the machine: keep waiting. Never lower --mem or raise -p for it.',
    '- Post progress as often as you commit: dibs progress "what you did or found" --task <name> --eta 30m, then --blocked or --done. The person reads it live.',
    '- Decide two-way doors yourself. Ask the person only what can\'t be undone: dibs question "..." --recommend X -m why --one-way "what is lost", '
      + 'keep working, then the same command plus --wait reads the answer. "Message from the person:" lines are theirs.',
    '- You may boost, pause or stop any job (--owner <session> if not yours); dibs logs who. A job "stopped by" someone was ended on purpose: find out why first.',
    '- Exit codes: 75 never ran (outside Claude Code; rerun within 2 min), 74 no disk, 76 lost before it started (send again), 77 lost after (check first), 70 dibs crashed. '
      + 'Quote file globs: dibs hold \'files:src/auth/**\'.',
    '- More: the dibs skill, dibs help. Something wrong with dibs: dibs ask "...".',
  ].join('\n');
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
  return { ...out, hookSpecificOutput: { hookEventName: event, additionalContext: primerText() } };
}
