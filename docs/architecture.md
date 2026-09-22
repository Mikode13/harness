# @mikode13/harness architecture

This document describes the current architecture of `@mikode13/harness`. Why a decision was
taken belongs in [`decisions.md`](decisions.md); cross-project policy belongs in
[`Mikode13/engineering`](https://github.com/Mikode13/engineering). Anything not implemented
yet is named as such below.

## Purpose and scope

The package is a provider-agnostic seam for driving coding agents. It owns one contract,
`Agent`, two provider adapters behind it, a retry policy, a planner → executor → reviewer
workflow, and the classification that keeps every failure crossing the seam legible to its
consumers. It does not own terminal or network I/O, prompt composition for a consumer's own
use case, tool definitions, memory, or scheduling.

This document covers the published package under `src/`. The `cli/` workspace project in the
same repository is a development-only consumer and is not part of the published artifact.

## Architectural shape

`src/` uses one folder per bounded module, each split into `domain` and `infrastructure`:

```text
src/agent/          the seam: Agent, ProgressEvent, errors, provider-failure classification
src/engines/*/      one provider adapter each, infrastructure only
src/factory/        createAgent and createOrchestrator, the only public way to build agents
src/orchestration/  planner -> executor -> reviewer, with a validated reviewer decision
src/retry/          the retry decorator
src/shared/         ports and helpers used across modules
```

The split is deliberately shallow. `domain` holds what does not know a provider exists —
the `Agent` contract, the error types, the classification helpers, the orchestrator and the
retry decorator. `infrastructure` holds what binds to something concrete: a provider SDK, a
Zod schema, `process.stderr`. A module has only the halves it needs, which is why
`src/engines/` is infrastructure only and `src/retry/` is domain only.

## Responsibilities and boundaries

| Module               | Owns                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/agent/`         | `Agent`, `AgentResponse`, `ProgressEvent`, the error types, and the functions that classify a failure          |
| `src/engines/`       | One adapter per provider: SDK calls, session or thread continuity, and SDK events mapped to `ProgressEvent`    |
| `src/factory/`       | Provider selection, default model and reasoning effort per role, and composition with the retry decorator      |
| `src/orchestration/` | The three role prompts, the attempt loop, per-run usage totals, and the validated reviewer decision            |
| `src/retry/`         | The decision to call an inner agent again, and the prompt that carries the previous failure into the next call |
| `src/shared/`        | `ILogger` and its stderr implementation, `isAbortError`, `isOneOf`                                             |

Two boundaries carry most of the design:

**Everything is an `Agent`.** `ClaudeAgent`, `CodexAgent`, `RetryingAgent` and
`OrchestratorAgent` all implement `run(prompt, signal, callback)`. A decorator and a whole
multi-agent workflow are therefore substitutable for a bare engine anywhere, and a consumer's
loop cannot tell which it is driving.

**Nothing escapes an `Agent` unclassified.** Every consumer branches on `RecoverableError`
versus `UnrecoverableError`, so an unclassified error bypasses that decision entirely: it is
retried when it should be fatal, or it ends a run a retry would have recovered. The
classifiers in `src/agent/domain/providerFailure.ts` are the only way a failure crosses the
seam:

| Helper                     | Applies to                             | Produces                                |
| -------------------------- | -------------------------------------- | --------------------------------------- |
| `classifyProviderFailure`  | One call into a provider SDK           | `RecoverableError` by default           |
| `classifiedProviderStream` | The async iteration of an SDK stream   | `RecoverableError` by default           |
| `classifyHostFailure`      | A logger or consumer callback          | `UnrecoverableError`                    |
| `classifyLocalFailure`     | The engine's own event mapping         | `UnrecoverableError`                    |
| `treatErrors`              | Wrapping host code in one of the above | Whatever the chosen classifier produces |

A provider failure defaults to recoverable because unclassified failures at that boundary are
transport-shaped, and `RetryingAgent` converts a persistent one into an `UnrecoverableError`
on exhaustion. A host failure cannot be replayed safely, because the provider turn it
interrupted may already have written files or run commands.

The provider and host boundaries stay narrow on purpose. Item mapping, logging and the
consumer callback sit outside `classifyProviderFailure` and outside the `for await` of
`classifiedProviderStream`; a host failure caught inside either would be reported as a
retryable provider failure.

Cancellation is the single deliberate exception. An `AbortError` propagates unchanged through
every layer, because a deliberate stop is not a failure and every consumer checks for it
before either error type.

## Dependencies and contracts

Dependencies point inward. `src/engines/` and `src/factory/` depend on `src/agent/`;
`src/agent/` depends on nothing but `src/shared/`. No module imports `src/factory/`, which is
why it is the only place that knows every provider.

`src/index.ts` is the public API: `createAgent`, `createOrchestrator`, the `Agent`,
`AgentResponse`, `Callback` and `ProgressEvent` types, the three error types, `isAbortError`,
`isAgentProvider`, `agentProviders`, and the option and model types. `RetryingAgent`,
`OrchestratorAgent` and both engines are internal — the factories apply retry and the role
defaults so a consumer never composes them, and a class that is not exported can change shape
without a major release.

Two contracts have version rules of their own:

- **`ProgressEvent` grows in minor releases.** Consumers are told to render the types they
  know and ignore the rest, so a new type must never carry information a consumer needs to be
  correct. The result of a run travels in `AgentResponse`; progress is narration.
- **A model or reasoning effort is the engine's to accept.** Each engine constructor rejects
  what its provider does not support with `InvalidAgentConfigError`, while the agent is being
  built. The factory does not validate them, so adding a model is a change in one file.

External integrations are `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`, each
reached only from its own adapter, and `zod`, used only by
`ReviewerDecisionValidator` behind the `Validator<T>` interface. `ILogger` is the one outbound
port: the factories default it to a stderr logger, and nothing in `src/` writes to stdout,
which belongs to the consumer.

Conversation continuity is the engines' own responsibility and is not modelled at the seam.
`CodexAgent` keeps one SDK `Thread` across turns; `ClaudeAgent` captures a `session_id` from
the first turn and resumes with it. Either way the provider keeps the context server-side.

## Important flows

**A single turn.** `createAgent` returns a `RetryingAgent` wrapping the engine. The engine
calls its SDK inside `classifyProviderFailure`, then iterates the response stream through
`classifiedProviderStream`, mapping each SDK event to a `ProgressEvent` and handing it to the
consumer's callback. On a `RecoverableError` the decorator calls the engine again, with the
previous failure appended to the original prompt — an attempt that failed before the provider
registered the turn left no session that remembers it. On exhaustion it throws
`UnrecoverableError`.

**A workflow turn.** `OrchestratorAgent.run` loops up to `maxAttempts` rounds of planner →
executor → reviewer. The reviewer is asked for JSON and its answer goes through
`ReviewerDecisionValidator`, so a decision is `{ decision: 'approved' }` or
`{ decision: 'rejected', feedback }` and never free text. An unusable reviewer answer retries
only the reviewer call, with the parse failure fed back — a malformed decision is not evidence
that the plan or the implementation were wrong. A rejection starts another round with the
feedback carried into the planner prompt. All three roles receive the same `AbortSignal` and
the same callback, so one cancellation stops the whole workflow and progress from every role
reaches the consumer through one stream.

**Usage accounting belongs to a `run()`, not to an instance.** The totals are created inside
`run()` and passed down. A consumer that keeps one orchestrator for a whole session would
otherwise see every previous run's tokens reported again, and two concurrent runs would report
each other's.

## Constraints and trade-offs

- **Retry wraps an agent, not a workflow.** A transient failure in one role is absorbed where
  it happened, without redoing another role's successful work. The cost is that a workflow has
  no single retry budget: each role carries its own.
- **The orchestrator's prompts are fixed.** The three role prompts live in
  `src/orchestration/domain/model/orchestratorAgent.ts` and are not configurable. Nothing has
  needed to vary them yet, and a configuration seam added before a second caller would be an
  abstraction without a consumer.
- **The mandatory test suite never contacts a provider.** Both engines are exercised through
  offline fakes of their SDK surfaces. Provider-boundary correctness — authentication, request
  shape, model availability — is not covered by an automated suite and surfaces through real
  usage instead. `pnpm run dev` is how that boundary gets exercised before a release.
- **`cli/` is the repository's own consumer, not a published one.** It exists so a change to
  the seam can be driven against real providers by hand, which the offline suite cannot do. It
  stays out of `src/` deliberately: it encodes a blocking, turn-by-turn loop, and a REST or
  WebSocket consumer would call `Agent.run()` per request and want none of it. It stays out of
  the tarball too — `files` lists `dist` only, and `scripts/pack-check.mjs` fails on anything
  else reaching it.
- **The seam has no tool, memory or routing model.** MCP, long-term memory, graph execution
  and file-based agent registries are deliberately absent; each waits for a real consumer.
