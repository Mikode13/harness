// Reference only — NOT part of the harness, not meant to run. Side-by-side
// comparison of what "one turn/response" actually looks like from each SDK,
// to design AgentResult/Action against real shapes instead of guesses.
// Types re-imported (not hand-copied) so this breaks loudly if an SDK changes.

import type { RunResult, ThreadItem, Usage as CodexUsage } from '@openai/codex-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Codex: thread.run() BUFFERS a whole turn and hands you exactly one object.
// ---------------------------------------------------------------------------
//
// type Turn = {
//   items: ThreadItem[];        // everything that happened, in order —
//                                // agent_message, reasoning, command_execution,
//                                // file_change, mcp_tool_call, web_search,
//                                // todo_list, error (see loopImpl.ts describeItem)
//   finalResponse: string;      // last agent_message's text only — can be ''
//   usage: Usage | null;        // token counts for this turn, or null
// };
type _CodexTurnShape = RunResult;
type _CodexItemShape = ThreadItem;
type _CodexUsageShape = CodexUsage;

// ---------------------------------------------------------------------------
// Claude: query() NEVER buffers — it's always an AsyncGenerator<SDKMessage>.
// SDKMessage is a huge union (dozens of variants: assistant text/thinking,
// tool_use, hook lifecycle, control responses, rate-limit events, ...).
// There is no single "Turn" object handed to you — YOU iterate the stream
// and decide what to keep. The one message shaped like a turn summary is
// SDKResultMessage, always the LAST message the generator yields:
//
// type SDKResultSuccess = {
//   type: 'result'; subtype: 'success';
//   result: string;              // the closest equivalent to Codex's finalResponse
//   is_error: boolean;
//   usage: NonNullableUsage;     // token counts — always present, unlike Codex's `| null`
//   total_cost_usd: number;      // Codex's Turn has no cost field at all
//   duration_ms: number; duration_api_ms: number; num_turns: number;
//   // ...plus permission_denials, session_id, uuid, etc.
// };
// type SDKResultError = { type: 'result'; subtype: 'error_...'; is_error: true; ...same usage/cost fields, no `result` string };
type _ClaudeResultShape = SDKResultMessage;

// ---------------------------------------------------------------------------
// What this means for AgentResult/Action:
//
// - `text`: Codex gives it pre-computed (`finalResponse`, but only the LAST
//   agent_message — we already chose to reconstruct it ourselves instead, see
//   describeItem). Claude gives it as `result` on the final stream message —
//   same "only the end result, nothing per-step" limitation.
// - `actions`: Codex gives you the full `items` array for free. Claude gives
//   you NOTHING structured — every non-final SDKMessage (tool_use, thinking,
//   hook events...) would have to be collected by hand while iterating the
//   stream, if you want an Action[] equivalent to what Codex's items give you.
// - `usage`: Codex's is `Usage | null` (can be missing). Claude's is always
//   present but a different shape, and Claude also gives you `total_cost_usd`
//   which Codex doesn't expose at all.
// ---------------------------------------------------------------------------
