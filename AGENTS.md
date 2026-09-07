# AGENTS.md

## What this repository is

`@mikode13/harness` is a provider-agnostic seam for driving coding agents. It publishes
`Agent` and its implementations — `ClaudeAgent`, `CodexAgent`, `RetryingAgent`,
`OrchestratorAgent` — plus the error types and the `ILogger` port those depend on.

`cli/` is a separate workspace project, not part of the published package. It is one
interactive consumer of the seam, kept out of `src/` deliberately: a REST or WebSocket
consumer would call `Agent.run()` per request and would never want a blocking turn loop.
See [`docs/decisions.md`](docs/decisions.md).

## Constraint specific to this repository

**Nothing may escape an `Agent` unclassified.** Every consumer — `RetryingAgent`'s retry
decision, `OrchestratorAgent`'s failure handling — branches on `RecoverableError` versus
`UnrecoverableError`. An unclassified error bypasses that decision entirely: it gets
retried when it should be fatal, or it kills a run a retry would have recovered. Every
call into a provider SDK, including the async iteration of a stream, goes through
`classifyProviderFailure` in `src/agent/domain/providerFailure.ts`.

Cancellation is the one deliberate exception: an `AbortError` propagates unchanged,
because a deliberate stop is not a failure and consumers check for it first.

**Usage accounting belongs to a `run()`, not to an instance.** The CLI keeps one
orchestrator for a whole session, so instance-level counters report every previous run's
tokens again — and two concurrent runs report each other's. Anything that accumulates
per turn is created inside `run()` and passed down.

## Architecture

Screaming architecture: one folder per bounded module under `src/`, each split into
`domain` and `infrastructure`.

```
src/agent/          the seam: Agent, ProgressEvent, errors, provider-failure classification
src/engines/*/      one provider adapter each, infrastructure only
src/orchestration/  planner -> executor -> reviewer, with a validated reviewer decision
src/retry/          the retry decorator
src/shared/         ports and helpers used across modules (ILogger, isAbortError)
```

A new engine implements `Agent`, routes each SDK call through `classifyProviderFailure` and
each SDK stream through `classifiedProviderStream`, and is exported from `src/index.ts`. It
needs no other change. Keep both boundaries around the SDK operation alone: item mapping,
logging, and the consumer callback belong outside, or a host failure is misreported as a
retryable provider failure.

## Local validation

```sh
pnpm install --frozen-lockfile
pnpm run check       # prettier --check, eslint --max-warnings 0, tsc --noEmit (src, tests, cli)
pnpm test            # the offline unit suite, core and cli
pnpm run pack:check  # builds and asserts the exact published file set
pnpm run dev         # the interactive CLI, against real providers
```

`pre-push` runs `pnpm run check && pnpm test`. CI repeats both and adds `build` and
`pack:check`.

### Hazards

- The tests never contact a provider. Both engines are exercised through offline fakes of
  their SDK surfaces; keep it that way, and add a fake rather than a live call.
- `cli/` must stay out of the published package. `files` lists `dist` only, and
  `scripts/pack-check.mjs` fails on anything else appearing in the tarball — which is what
  catches a `files` entry added by mistake.
- `tsc` never empties `outDir`. `build` runs `mikode-scripts clean dist` first; without it,
  output from a renamed or deleted source file survives and ships.
- Never add a package-manager guard to a lifecycle script. `preinstall` ran for every
  consumer, and `prepare` would break `npm pack` and `npm publish`.

## Engineering standards

This repository follows the active standards in
[`Mikode13/engineering`](https://github.com/Mikode13/engineering/blob/main/standards/README.md).
Do not duplicate their content here; read them there when a change touches package
management, TypeScript, code quality, formatting, git workflow, testing, or CI.
