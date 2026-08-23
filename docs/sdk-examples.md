# SDK reference notes

Not executable, not part of the harness. These are notes on the raw shape of each
agent SDK, kept from the investigation that led to the `Agent` interface
(`src/models/agent.ts`) and its `CodexAgent`/`ClaudeAgent` implementations. Useful
context for anyone extending those wrappers or adding a third engine.

## Codex SDK (`@openai/codex-sdk`)

Source: `openai/codex` README (`sdk/typescript/README.md`) + `sdk/typescript/src/thread.ts`.

A `Thread` is a conversation; `run()` is one turn in it. `run()` **buffers** all
events and resolves once the turn finishes (success or failure):

```ts
import { Codex } from '@openai/codex-sdk';

const codex = new Codex();
const thread = codex.startThread();

const turn = await thread.run('Reply with exactly the word: pong');

// Turn shape: { items: ThreadItem[], finalResponse: string, usage: Usage | null }
console.log('finalResponse:', turn.finalResponse);
console.log('usage:', turn.usage);
console.log('item count:', turn.items.length);
```

- If the turn fails internally (event `turn.failed`), `run()` **throws** an `Error`
  built from that event's message — it does not return a `success: false` result. A
  `try/catch` around `run()` is how you observe engine failure here.
- `runStreamed()` is the alternative: instead of buffering, it gives you an async
  generator of raw `ThreadEvent` objects as they happen (`item.completed`,
  `turn.completed`, `turn.failed`, ...). This is what `CodexAgent` actually uses.
- Cancellation: `run()`/`runStreamed()` accept `{ signal: AbortSignal }` as a second
  argument — the same `AbortController`/`AbortSignal` pattern from Node's own APIs,
  nothing custom.

## Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

Source: docs.claude.com Agent SDK TypeScript reference.

Unlike Codex's `Thread.run()`, `query()` does **not** buffer — it always returns a
`Query`, which IS an `AsyncGenerator<SDKMessage>`. There is no separate "buffered" vs
"streamed" mode; if you only want the final answer, you still have to iterate the
generator yourself and pick out the last assistant message.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const controller = new AbortController();

const stream = query({
	prompt: 'Reply with exactly the word: pong',
	options: {
		cwd: process.cwd(),
		maxTurns: 1,
		abortController: controller,
	},
});

for await (const message of stream) {
	console.log(message);
}
```

- `SDKMessage` is a union: text/thinking blocks, tool_use requests and results, task
  progress, hook lifecycle events, control/init responses, and `SDKErrorMessage` for
  runtime errors.
- Cancellation: pass `{ abortController }` in `options` (as above) and call
  `controller.abort()` from elsewhere — same `AbortController` pattern as Codex, just
  handed in pre-built instead of as a bare `AbortSignal`.
- Errors have two channels, not one:
  1. Exceptions thrown while iterating the generator, or from `Query` methods like
     `interrupt()`/`setModel()`.
  2. An `SDKErrorMessage` yielded IN the stream for runtime errors during the run —
     this does NOT throw, so a `try/catch` alone won't catch it; each message's type
     must be checked while iterating.

## Response shape comparison

Side-by-side of what "one turn/response" looks like from each SDK, used to design
`AgentResponse` against real shapes instead of guesses.

**Codex** (`thread.run()` return value, `RunResult`):

```ts
type Turn = {
	items: ThreadItem[]; // everything that happened, in order — agent_message,
	// reasoning, command_execution, file_change, mcp_tool_call,
	// web_search, todo_list, error (see codexAgent.ts describeItem)
	finalResponse: string; // last agent_message's text only — can be ''
	usage: Usage | null; // token counts for this turn, or null
};
```

**Claude** (last message of the `query()` stream, `SDKResultMessage`):

```ts
type SDKResultSuccess = {
	type: 'result';
	subtype: 'success';
	result: string; // the closest equivalent to Codex's finalResponse
	is_error: boolean;
	usage: NonNullableUsage; // token counts — always present, unlike Codex's `| null`
	total_cost_usd: number; // Codex's Turn has no cost field at all
	duration_ms: number;
	duration_api_ms: number;
	num_turns: number;
	// ...plus permission_denials, session_id, uuid, etc.
};
// type SDKResultError = { type: 'result'; subtype: 'error_...'; is_error: true; ...same usage/cost fields, no `result` string };
```

What this meant for `AgentResponse`:

- **text**: Codex gives it pre-computed (`finalResponse`, but only the LAST
  agent_message — the harness reconstructs it itself instead, see `describeItem`).
  Claude gives it as `result` on the final stream message — same "only the end
  result, nothing per-step" limitation.
- **actions**: Codex gives you the full `items` array for free. Claude gives you
  nothing structured — every non-final `SDKMessage` (tool_use, thinking, hook
  events...) has to be collected by hand while iterating the stream.
- **usage**: Codex's is `Usage | null` (can be missing). Claude's is always present
  but a different shape, and Claude also gives `total_cost_usd`, which Codex doesn't
  expose at all — this is why `AgentResponse` dropped cost (see `models/agent.ts`).
