// Who is calling, for the record. Agents may do everything the person can
// (answer questions, set hours, change the group of machines, override any
// job), so nothing here refuses anyone. What it does is name the caller in the
// event log and on the board, so the person can see which agent did what.
import { identity } from './proc.mjs';
import { event } from './events.mjs';

// Set in the environment of an agent's tool calls: Claude Code, Codex, Cursor,
// Gemini CLI, opencode, and the AI_AGENT convention several of them share.
export const AGENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'AI_AGENT',
  'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI', 'OPENCODE'];

// The caller: { name, agent, via }. An agent goes by its session name (the one the
// board and SendMessage use); anyone else is the person. DIBS_VIA names the paired
// browser a page action came through (src/web.mjs sets it for relay calls), so the
// record says "the person via Safari on iPhone (remote ...)". An agent can't borrow it.
export function actor(env = process.env) {
  const id = identity();
  const agent = AGENT_ENV.some(k => env[k]) || !!id.spid;
  const via = !agent && typeof env.DIBS_VIA === 'string' && env.DIBS_VIA ? env.DIBS_VIA : null;
  return { agent, name: agent ? id.agent || id.who : via ? `the person via ${via}` : 'the person', ...(via && { via }) };
}

// One line in the event log for a change to the person's settings or the
// group of machines, naming who made it. Overrides of jobs log their own
// (src/override.mjs), with the job.
export function logChange(act, extra = {}) {
  const who = actor();
  event({ kind: 'override', act, ...extra, by: who.name, byAgent: who.agent, ...(who.via && { via: who.via }) });
}
