// Reference script — NOT part of the harness. Run with: node examples/claude-example.ts
//
// Demonstrates the raw shape of @anthropic-ai/claude-agent-sdk, so we can
// design our own wrapper against real behaviour instead of guesses. Source:
// docs.claude.com Agent SDK TypeScript reference.

import { query } from "@anthropic-ai/claude-agent-sdk";

// Unlike Codex's Thread.run(), query() does NOT buffer — it always returns a
// Query, which IS an AsyncGenerator<SDKMessage>. There is no separate
// "buffered" vs "streamed" mode; if you only want the final answer, you
// still have to iterate the generator yourself and pick out the last
// assistant message.
const controller = new AbortController();

const stream = query({
	prompt: "Reply with exactly the word: pong",
	options: {
		cwd: process.cwd(),
		maxTurns: 1,
		abortController: controller,
	},
});

for await (const message of stream) {
	// SDKMessage is a union: text/thinking blocks, tool_use requests and
	// results, task progress, hook lifecycle events, control/init responses,
	// and SDKErrorMessage for runtime errors. Logging the raw shape here is
	// how we find out, concretely, which union member carries the "final
	// answer" — rather than assuming.
	console.log(message);
}

// Cancellation: pass { abortController } in options (as above) and call
// controller.abort() from elsewhere — same AbortController pattern as Codex,
// just handed in pre-built instead of as a bare AbortSignal.

// Errors: two channels, not one —
//  1. Exceptions thrown while iterating the generator, or from Query methods
//     like interrupt()/setModel().
//  2. An SDKErrorMessage yielded IN the stream for runtime errors during the
//     run — this does NOT throw, so a try/catch alone won't catch it; you
//     must check each message's type as you iterate.
