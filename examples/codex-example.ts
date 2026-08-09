// Reference script — NOT part of the harness. Run with: node examples/codex-example.ts
//
// Demonstrates the raw shape of @openai/codex-sdk, so we can design our own
// wrapper against real behaviour instead of guesses. Source: openai/codex
// README (sdk/typescript/README.md) + sdk/typescript/src/thread.ts.

import { Codex } from "@openai/codex-sdk";

const codex = new Codex();

// A Thread is a conversation; run() is one turn in it. run() BUFFERS all
// events and resolves once the turn finishes (success or failure).
const thread = codex.startThread();

const turn = await thread.run("Reply with exactly the word: pong");

// Turn shape (see thread.ts): { items: ThreadItem[], finalResponse: string, usage: Usage | null }
console.log("finalResponse:", turn.finalResponse);
console.log("usage:", turn.usage);
console.log("item count:", turn.items.length);

// If the turn fails internally (event "turn.failed"), run() THROWS an Error
// built from that event's message — it does not return a "success: false"
// result. A try/catch around run() is how you observe engine failure here.

// runStreamed() is the alternative: instead of buffering, it gives you an
// async generator of raw ThreadEvent objects as they happen (item.completed,
// turn.completed, turn.failed, ...). Useful once we care about live
// progress; not needed for a first "call once, get final answer" wrapper.
//
// const { events } = await thread.runStreamed("...");
// for await (const event of events) { ... }

// Cancellation: run()/runStreamed() accept { signal: AbortSignal } as a
// second argument (see TurnOptions in turnOptions.ts) — the same
// AbortController/AbortSignal pattern from Node's own APIs, nothing custom.
//
// const controller = new AbortController();
// await thread.run("...", { signal: controller.signal });
// controller.abort(); // from elsewhere, to cancel
