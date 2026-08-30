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
multi-agent workflow, chosen entirely by what gets wired up in `index.ts`; the
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

Remaining work (see `tasks.txt` for the actionable, dated list):

- Live streaming already ships; still open: type-while-thinking (respond to
  new input without blocking on the current agent call), session persistence
  across process restarts, and structured per-turn usage/duration logging.
- Terminal UX polish (bordered chat box, markdown rendering, user-friendly
  error messages) — explicitly deferred until the above is solid.
- Dynamic routing (deciding which flow/agent a request needs, instead of
  always running the fixed plan → execute → review workflow) — deliberately
  built _after_ that fixed flow, not alongside it, so the routing decision
  reuses a technique already proven on a simpler problem.

Deliberately out of scope for now: MCP, long-term memory, graph execution, and
file-based agent registries — each waits for a real need.

## Adding an engine

A new provider only needs one thing to compose safely into everything above:
**it must only ever reject with `RecoverableError` or `UnrecoverableError`**
(`src/models/errors.ts`), never a raw SDK error. `RetryingAgent` and
`OrchestratorAgent` both decide what to do next by `instanceof`-checking
against those two types; anything else leaking through bypasses that decision
entirely — it gets retried when it shouldn't be, or takes down a whole run
that a retry would have recovered. Wrap every call into the underlying SDK,
including failures the SDK itself doesn't model as a domain error (network
errors, malformed responses). See the doc comment on `Agent` in
`src/models/agent.ts`.

## Install

```sh
pnpm add @mikode13/harness
```

## Tests

The default test command runs the unit tests and the local integration workflow;
both use deterministic fakes and do not contact a provider. The provider boundary
tests are intentionally separate:

```sh
pnpm run test:integration:external
```

That command runs one small, read-only prompt against each SDK. It requires
`CODEX_API_KEY` and `ANTHROPIC_API_KEY` in the environment and fails closed when
either is missing. For an intentional local opt-out, use
`EXTERNAL_TESTS=skip pnpm run test:integration:external`; this must not be used
by the scheduled workflow. A real run incurs the normal provider API cost; the
exact cost depends on the models and provider pricing. The external suite is
never part of `pnpm test`, `pnpm run check`, or required CI.

GitHub runs it manually or every Monday through
[the external integration workflow](./.github/workflows/external-integration.yml).
The repository maintainer owns failures caused by this package; authentication,
quota, provider availability, pricing, and model retirement or renaming failures
belong to the relevant provider account and should be diagnosed before changing
harness code. Never commit either credential.

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
