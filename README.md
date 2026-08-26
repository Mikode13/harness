# @mikode13/harness

A small, hand-built agent harness in TypeScript. It runs coding agents (currently
OpenAI Codex, Claude next) behind a single terminal chat, and will grow into the
runtime that coordinates specialized agents across MiKode projects.

## Motivation

This project exists for three reasons, in this order:

1. **Learning.** Understand how agent SDKs work internally — the agent loop,
   messages, tool calls, cancellation, context continuity, and multi-agent
   coordination — by building the fundamental parts personally instead of
   consuming a framework. No LangGraph, no OpenAI Agents SDK as the engine;
   those come later as comparison points, not as foundations.
2. **A reusable base.** The harness is the substrate for a future chatbot and
   for MiKode tooling: routing, typed tools, specialized agents, memory, and
   validation layers will be added on top of it once real consumers need them.
3. **Defining how AI works inside MiKode.** Standards, explicit per-agent
   responsibilities and tools, traceability, and reproducible runs — following
   the conventions of the `mikode-engineering` repository.

The project advances in small vertical slices: each abstraction must be justified
by a real problem before it is introduced, and no public API is stabilized until
there is at least one real consumer.

## What it does today

An interactive terminal chat backed by the OpenAI Codex SDK:

- Prompt loop built on `node:readline/promises`, with a single active question at
  a time (a design that removes a whole class of concurrency bugs).
- Clean exit via `exit` or Ctrl+C, both going through the same confirmation flow.
- Cancellation with `AbortController`/`AbortSignal`, shared between the prompt
  and the agent call.
- Conversation continuity for free: one Codex `Thread` is reused across turns,
  so the engine keeps the context server-side.
- Model pinned by the harness (currently `gpt-5.6-sol`) — the user of the chat
  never chooses, or sees, which model runs behind it.

## Where it is going

The agreed sequence (see `tasks.txt` for the actionable list):

1. A user-owned `Agent` interface with a normalized `AgentResult`, so the loop
   depends on a contract instead of a concrete SDK.
2. A second implementation (Claude Agent SDK) to prove the abstraction.
3. Minimal traceability: per-turn usage, duration, retries.
4. A first workflow as a plain function: **plan (sol) → execute (terra) →
   review (opus)**, looping until the reviewer approves.

Deliberately out of scope for now: MCP, dynamic routing, long-term memory, graph
execution, and file-based agent registries — each waits for a real need.

## Install

```sh
pnpm add @mikode13/harness
```

## Usage

Run the chat from the repository (Node 24+, TypeScript executed natively):

```sh
node src/index.ts
```

Type your prompt at `>`; type `exit` or press Ctrl+C to leave (with confirmation).

`src/index.ts` currently enables `autoApprove` for its trusted backend agents. This
maps to each provider's permission-bypass mode and grants those processes
unrestricted command access. Keep it disabled when the host may receive untrusted
prompts, or provide an approval workflow from the entry point.

## License

This project is source-available under the MIT License with the
[Commons Clause License Condition v1.0](https://commonsclause.com/). See
[LICENSE](./LICENSE) for the complete text. It is not OSI open source: the Commons
Clause restricts selling the software or a service whose value derives substantially
from it.
