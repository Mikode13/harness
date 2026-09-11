# @mikode13/harness

A small, hand-built agent harness in TypeScript. It coordinates OpenAI Codex and
Claude Agent SDK instances — as a single terminal chat, or as a multi-agent
plan → execute → review workflow — and is growing into the runtime that
coordinates specialized agents across MiKode projects.

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

An interactive terminal chat, backed by one `Agent` — a single engine, or a full
multi-agent workflow, chosen entirely by what gets wired up in `cli/cli.ts`; the
chat loop itself never knows the difference.

- **A provider-agnostic `Agent` contract** (`run(prompt, signal, callback)`) with
  two real implementations, `CodexAgent` and `ClaudeAgent` — swapping one for the
  other, anywhere in the composition, changes nothing else.
- **Conversation continuity for free** in both engines: Codex reuses one `Thread`
  across turns; Claude resumes via a captured `session_id` — the engine keeps
  context server-side either way.
- **`OrchestratorAgent`**: coordinates a planner, an executor, and a reviewer
  (each an injected `Agent`) in a plan → execute → review loop. The reviewer's
  decision is a Zod-validated structured `{decision, feedback}`, not free text —
  a rejected or malformed decision retries with the reason fed back, bounded by
  `maxAttempts`, converting to `UnrecoverableError` only once exhausted. A
  malformed reviewer response retries only the reviewer call, not the whole
  cycle. Because it implements `Agent` itself, the chat loop drives it exactly
  like it drives a bare engine.
- **Live progress streaming**: every engine reports ongoing activity (tool
  calls, searches, file changes, reasoning) through a typed `ProgressEvent`
  callback, separate from the final response — so an agent's own words never
  get mixed with narration of what it did to produce them, and a caller (the
  CLI today, a future web UI) decides how to render it.
- **Retry policy** (`RetryingAgent`) wraps individual agents, not whole
  workflows — a transient failure in one sub-agent is absorbed locally, without
  redoing another sub-agent's already-successful work.
- Cancellation with `AbortController`/`AbortSignal`, shared between the prompt
  and every agent call, all the way down through the orchestrator.

## Where it is going

Open work is tracked in GitHub issues:

- [#16](https://github.com/Mikode13/harness/issues/16): declare the public API
  stable and publish `1.0.0` through automated publication.
- [#17](https://github.com/Mikode13/harness/issues/17): dynamic routing —
  deciding which flow or agent a request needs, instead of always running the
  fixed plan → execute → review workflow. It comes after `1.0.0` and reuses the
  structured-decision technique already proven on the reviewer.

Deliberately out of scope for now: MCP, long-term memory, graph execution, and
file-based agent registries — each waits for a real need.

## Adding an engine

A new provider only needs one thing to compose safely into everything above:
**it must only ever reject with `RecoverableError` or `UnrecoverableError`**
(`src/agent/domain/errors.ts`), never a raw SDK error. `RetryingAgent` and
`OrchestratorAgent` both decide what to do next by `instanceof`-checking
against those two types; anything else leaking through is treated as
unrecoverable and ends the run, because nothing above the adapter can tell
whether replaying it is safe. Wrap every call into the underlying SDK,
including failures the SDK itself doesn't model as a domain error (network
errors, malformed responses): `classifyProviderFailure` covers a single call,
`classifiedProviderStream` covers an SDK stream. Both are deliberately narrow —
the classification must not span your own item mapping, logging, or the
consumer callback, or a failure in the host is reported as a provider failure
and gets retried. Those host failures are instead classified as unrecoverable,
because the provider turn may already have produced side effects. See the doc
comment on `Agent` in `src/agent/domain/agent.ts`.

## Install

```sh
pnpm add @mikode13/harness
```

An agent is built by a factory, then driven. The only output the package produces
on its own is diagnostic warnings on stderr, from a default logger that both
factories let you replace through their `logger` option:

```ts
import { createAgent, UnrecoverableError, type ProgressEvent } from '@mikode13/harness';

const agent = createAgent('claude', { model: 'sonnet' });
const controller = new AbortController();

const render = (event: ProgressEvent) => {
	if (event.type === 'agentMessage') process.stdout.write(event.message);
};

try {
	const result = await agent.run('Summarize this repository.', controller.signal, render);
	console.log(result?.duration, result?.inputTokens, result?.outputTokens);
} catch (error) {
	if (error instanceof UnrecoverableError) console.error(error.message, error.cause);
}
```

`ProgressEvent` is the public seam for live activity; rendering it is the
consumer's decision, not the harness's. `cli/progressEventFormatter.ts` is one
terminal-shaped implementation to copy from. Swapping the agent for
`createAgent('codex')`, or for `createOrchestrator()` and its planner → executor →
reviewer workflow, changes nothing else in the snippet above.
`createOrchestrator({ provider: 'claude' })` runs every role on one provider, for
example when the other one is out of quota.

Every agent a factory returns already retries recoverable failures. A model or
reasoning effort the chosen provider does not support throws
`InvalidAgentConfigError` when the agent is built. Building a Codex agent throws
`UnrecoverableError` if the Codex CLI binary cannot be found, which happens when
optional dependencies were skipped at install time.

## Tests

`pnpm test` runs the unit suite against deterministic fakes; it never contacts a
real provider. Provider-boundary correctness (SDK auth, request shape, model
availability) is not covered by an automated suite here — it surfaces through
actual usage and monitoring, not by scheduling calls to a live SDK on a timer.

## Local development smoke test

`cli/` is a separate, unpublished workspace project — a development-only harness
runner (own `package.json`, not part of the `@mikode13/harness` package) that
exists solely to exercise the library manually while working in this repository:

```sh
pnpm run dev
```

Type your prompt at `>`. Press Ctrl+C while idle at the prompt to exit; pressing
it while an agent is running cancels only that turn and returns to the prompt.

`cli/cli.ts` currently enables `autoApprove` for its trusted backend agents.
This maps to each provider's permission-bypass mode and grants those processes
unrestricted command access. Keep it disabled when the host may receive untrusted
prompts, or provide an approval workflow from the entry point.

Real consumers (a future REST/WebSocket server, a chatbot UI) build agents
through `createAgent` and `createOrchestrator` and bring their own I/O, and
optionally their own `ILogger` adapter. `ConversationLoop`/`IPromptEmitter` are not
part of the published package — they encode one specific interactive,
turn-by-turn consumption pattern (see `cli/`), not the harness seam itself; a
consumer that wants that same loop can use `cli/`'s implementation as a
reference rather than depend on it as a library.

## License

This project is source-available under the MIT License with the
[Commons Clause License Condition v1.0](https://commonsclause.com/). See
[LICENSE](./LICENSE) for the complete text. It is not OSI open source: the Commons
Clause restricts selling the software or a service whose value derives substantially
from it.
