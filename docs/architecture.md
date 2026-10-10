# @mikode13/harness architecture

This document describes the current architecture of `@mikode13/harness`. Why a decision was
taken belongs in [`decisions.md`](decisions.md); cross-project policy belongs in
[`Mikode13/engineering`](https://github.com/Mikode13/engineering). Anything not implemented
yet is named as such below.

## Purpose and scope

The package is a provider-agnostic seam for driving coding agents. It owns one contract,
`Agent`, two provider adapters behind it, a model-backed agent that owns its conversation, a retry policy, a planner → executor → reviewer
workflow, and the classification that keeps every failure crossing the seam legible to its
consumers. It does not own terminal or network I/O, prompt composition for a consumer's own
use case, tools that change files, memory, or scheduling.

This document covers the published package under `src/`. The `cli/` workspace project in the
same repository is a development-only consumer and is not part of the published artifact.

## Architectural shape

`src/` uses one folder per bounded module, each split into `domain` and `infrastructure`:

```text
src/agent/          the seam: Agent, RunOptions, ProgressEvent, the approval contract
src/diff/           line diffs in the unified format, self-contained
src/engines/*/      one provider adapter each, infrastructure only
src/engines/domain/ LLMAgent, the agent that owns its conversation and calls an LLMClient
src/llm/            the stateless model boundary: LLMClient, Message, Conversation, ToolDefinition
src/tools/          what an agent can run: Tool, defineTool, and the read-only repository tools over Workspace
src/factory/        createAgent, createOrchestrator and their model-API pair, the only public way to build agents
src/orchestration/  planner -> executor -> reviewer, with a validated reviewer decision
src/recovery/       what a writing run changed, recorded outside the repository so it can be undone
src/retry/          the retry decorator
src/shared/         ports, helpers and the failure contract used across modules
```

The split is deliberately shallow. `domain` holds what does not know a provider exists —
the `Agent` contract, the error types, the classification helpers, the orchestrator and the
retry decorator. `infrastructure` holds what binds to something concrete: a provider SDK, a
Zod schema, `process.stderr`. A module has only the halves it needs, which is why
each provider engine is infrastructure only and `src/retry/` is domain only. `LLMAgent` sits in `src/engines/domain/` because it knows no
provider: it drives whatever `LLMClient` it is given.

## Responsibilities and boundaries

| Module               | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/`         | `Agent`, `RunOptions`, `AgentResponse`, `ProgressEvent`, the approval contract (`ToolRisk`, `Approver`, and `rememberApprovals`, which remembers what an approver allowed); `RunContext`, what one top-level run shares with every agent and tool inside it, carried in `RunOptions` under a private symbol (internal). The approval types live here, not in `src/tools`, because `RunOptions` carries the approver and this module depends on nothing but `src/shared`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/diff/`          | `unifiedDiff`, the hunks that turn one text into another, found with Myers' algorithm. It imports nothing, so it can move to a package of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/engines/`       | One adapter per provider: SDK calls, session or thread continuity, and SDK events mapped to `ProgressEvent`; `LLMAgent`, which drives an `LLMClient` and runs the tools it is given, preparing each call before it is approved and running only what was prepared; given the workspace's history, it first follows the moves the user made through it, taking the conversation back with the workspace and telling the model what was undone, with a summary from a cheap model when it has one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/llm/`           | `LLMClient`, the stateless model port; `Message` and its parts, including opaque `providerData`; `Conversation`, a tree of turns whose context is the path to one of them, each turn tied to the history run it belongs to; the `ToolDefinition` a client describes to the model; `MaxContextError`; `OpenAILLMClient`; `ClaudeLLMClient`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/tools/`         | `Tool`, a `ToolDefinition` plus the `execute` the agent runs; `defineTool`, which builds one from a Zod schema and rejects a schema strict mode would refuse (an optional field, a numeric or length bound, an object open to any key); `Workspace`, the read-only port to the folder an agent works on, and `createWorkspaceTools`, the `listFiles`, `searchText` and `readFile` tools over it; `createWorkspace`, which picks `RipgrepWorkspace` or falls back to `GitWorkspace`, both enforcing the boundary through `BoundedWorkspace`; `AccessPolicy`, the one decision on whether a tool may read or write a path, implemented by `RootsAccessPolicy` over declared `read` and `write` roots, git's protected files, the default secrets list and `.gitignore` (internal, not yet used by any tool); `FileEditor`, which prepares a create, replace or delete and applies it under that policy and the run's recovery journal, and `WriteSession`, everything one top-level run writes; `PreparingTool` and `prepareCall`, which bring a harness-built tool and a consumer's `Tool` into one lifecycle; `WorkspaceWrites`, which gives each run's context its own `WriteSession` (all internal too). It depends on `src/recovery/` for the journal, on `src/llm/` for the definition and on `src/agent/` for `ToolRisk`; `src/llm/` does not know it exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/factory/`       | Provider selection, default model and reasoning effort per role, and composition with the retry decorator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/orchestration/` | Each role's default instructions and the data each round sends, `InstructedAgent`, the attempt loop, per-run usage totals, and the validated reviewer decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/recovery/`      | The recovery store: `RecoveryStore`, the `RunJournal` of one writing run, and `FileRecoveryStore`, which keeps them in a private directory per workspace under the platform's state directory, outside the repository. A change is recorded as prepared, with the content it replaces, before it is made. One run writes to a workspace at a time. Runs form a tree: each records the run the workspace was at when it started, and the store records the run it is at now. A run whose process died is listed as `interrupted`, and the next run settles the changes it left prepared. `goTo`, `undo` and `redo` move the workspace through that tree, one run at a time, writing each file only if it holds the state the history expects; a file that does not is left as it is and the move is reported as partial. Each move is recorded as a `Revision`, with the reason the host gave, and a move the process did not finish is finished by the next move or run. Moves and runs share the workspace lock. A run that changed nothing, because it prepared no change or abandoned every one, is discarded when it finishes, and the workspace goes back to its parent. That is read from its journal: a dead run that changed nothing is hidden at once, and the next run or move removes it. Retention keeps 25 runs per workspace, the new one included: before a run starts, abandoned branches are removed whole, then the oldest run on the current line is chained into the next, so the start of the history always stays reachable; contents no kept run refers to are freed. `showChanges` renders a run's recorded effects as a git-style diff per file. `History` is the public view of all this, built by `createHistory` over its own `FileRecoveryStore` and implemented by `StoreHistory`: it lists the runs with the files each changed, shows a run's diff, and moves the workspace, with paths relative to the root; the store, the journal and `Revision` stay internal. It depends on Node and on `src/diff/` |
| `src/retry/`         | The decision to call an inner agent again, and the prompt that carries the previous failure into the next call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/shared/`        | `ILogger` and its stderr implementation, `isAbortError`, `isOneOf`, `Tokens`, the error types and the functions that classify a failure. The failure contract lives here because the model clients use it as much as the agents do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Two boundaries carry most of the design:

**Everything is an `Agent`.** `ClaudeAgent`, `CodexAgent`, `LLMAgent`, `RetryingAgent` and
`OrchestratorAgent` all implement `run(prompt, options)`, where `options` holds the run's
`signal`, its optional `onProgress`, and its optional `approve`, asked before a model-backed
agent runs a `destructive` tool call. A decorator and a whole multi-agent workflow are
therefore substitutable for a bare engine anywhere, and a consumer's loop cannot tell which it
is driving. A decorator passes `options` on whole, never rebuilt, so a field added to it
reaches every agent without each decorator learning about it. The same holds for the internal `RunContext`
an outer agent adds under a private symbol: every agent the run reaches sees it, and no
consumer can.

**Nothing escapes an `Agent` unclassified.** Every consumer branches on `RecoverableError`
versus `UnrecoverableError`, so an unclassified error bypasses that decision entirely: it is
retried when it should be fatal, or it ends a run a retry would have recovered. The
classifiers in `src/shared/domain/providerFailure.ts` are the only way a failure crosses the
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
`src/agent/` depends on nothing but `src/shared/`. `src/llm/` depends only on `src/shared/`,
for the failure contract and `Tokens`; only its `infrastructure` imports an SDK. `LLMAgent` depends on
`src/llm/`, and `src/llm/` knows nothing about agents. `LLMAgent` also reads the workspace's
history through the `src/recovery/` domain; the conversation itself knows only an opaque run id. No module imports `src/factory/`, which is
why it is the only place that knows every provider.

`src/index.ts` is the public API: `createAgent`, `createOrchestrator`, `createLLMAgent`,
`createLLMOrchestrator`, the `Agent`, `RunOptions`, `AgentResponse`, `Callback`, `ProgressEvent`
and `Tokens` types, the approval contract (`rememberApprovals` and the `Approver`,
`ApprovalRequest`, `ApprovalDecision`, `RememberableDecision` and `ToolRisk` types), the three
failure types an agent rejects with, `isAbortError`, `isAgentProvider`, `agentProviders`, and the
option and model types. For the model-backed agent's tools it also exports the `Tool`,
`ToolDefinition`, `JSONSchema`, `Workspace` and `TextMatch` types, `defineTool`,
`createWorkspace` and `createWorkspaceTools`. For the history of what those runs wrote it
exports `createHistory`, the `History`, `HistoryRun`, `Move`, `MoveOptions` and `RunStatus` types,
`historyStart`, and the `WorkspaceBusyError`, `WorkspaceMovedError`, `NothingToMoveError`,
`UnknownRunError` and `HistoryExpiredError` errors; `AgentResponse.runId` names the run a writing run recorded. `defineTool` takes a Zod 4 schema, so Zod's major
version is part of the contract, and `zod` is a peer dependency, so the consumer's schemas and
the harness share one copy. `RetryingAgent`,
`OrchestratorAgent`, `LLMAgent` and both engines are internal — the factories apply retry and the role
defaults so a consumer never composes them, and a class that is not exported can change shape
without a major release.

Four contracts have rules of their own:

- **`Tokens` is split into the categories providers bill separately.** `inputTokens`,
  `readCacheTokens`, `writtenCacheTokens` and `outputTokens` never overlap. They are counts,
  not a cost: pricing is out of scope, because a run's tokens are not attributed to the
  model that spent them. Providers disagree on whether cached tokens are part of
  their input count, so each engine converts to this meaning: Codex subtracts both cache
  counters from its `input_tokens`, while Claude already reports them apart.
- **Every token a run spends travels with its end.** `run()` always resolves to an
  `AgentResponse`, whose `response` is empty when the run produced no text, or rejects with a
  `RecoverableError` or `UnrecoverableError` whose `tokens` hold what the run spent before
  failing. `RetryingAgent` adds failed attempts to whichever ends the run, and
  `OrchestratorAgent` adds every earlier role. `tokens` is missing, not zero, when any response
  in the run came without usage: its call was billed, so a partial sum would look complete.
  A failure tells the two cases apart. The engine sets `usageUnreported` when the provider
  answered without usage before the run failed, which makes every total that includes it
  unknown. A failure that never got an answer, such as a dropped connection, adds nothing. A
  cancellation carries no tokens: an `AbortError` must propagate unchanged. `duration` is each
  layer's own wall clock, so a retried run or a whole workflow reports what the consumer waited.

- **`ProgressEvent` grows in minor releases.** Consumers are told to render the types they
  know and ignore the rest, so a new type must never carry information a consumer needs to be
  correct. The result of a run travels in `AgentResponse`; progress is narration.
- **A model or reasoning effort is the engine's to accept.** Each engine constructor rejects
  what its provider does not support with `InvalidAgentConfigError`, while the agent is being
  built. The factory does not validate them, so adding a model is a change in one file.

External integrations are `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`, each
reached only from its own engine, `openai` and `@anthropic-ai/sdk`, each reached only from its own `LLMClient`, and `zod`, used by
`ReviewerDecisionValidator` behind the `Validator<T>` interface and by `defineTool`. `ILogger` is the one outbound
port: the factories default it to a stderr logger, and nothing in `src/` writes to stdout,
which belongs to the consumer.

Conversation continuity is each agent's own responsibility and is not modelled at the
`Agent` seam. `CodexAgent` keeps one SDK `Thread` across turns; `ClaudeAgent` captures a
`session_id` from the first turn and resumes with it. Either way the provider keeps the
context server-side. `LLMAgent` is the exception: it keeps its own
`Conversation` in process and sends the whole context on every call, so the model behind it
holds no state. Its adapters are `OpenAILLMClient`, on the OpenAI Responses API with
`store: false`, and `ClaudeLLMClient`, on the Anthropic Messages API. `createLLMAgent` builds one of them and the agent together for a provider, wrapped in retry
like every other agent, with the tools it is given. `createLLMOrchestrator` runs
the planner and reviewer on it, each with its role's instructions, or the caller's, as the system prompt and the
read-only repository tools, and keeps the executor on its Agent SDK, because an agent of ours
cannot change files yet. `OrchestratorAgent` sends each role only the round's data; an agent
without a system prompt gets its instructions at the head of every prompt from `InstructedAgent`. The Agent SDK path stays the default: `createAgent`
and `createOrchestrator` use the provider's own login, while the model API path needs
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and bills per token. Both paths name a provider by its company, `'anthropic'` or `'openai'`, and
take the same model and effort names, so one role table serves both.

## Important flows

**A single turn.** `createAgent` returns a `RetryingAgent` wrapping the engine. The engine
calls its SDK inside `classifyProviderFailure`, then iterates the response stream through
`classifiedProviderStream`, mapping each SDK event to a `ProgressEvent` and handing it to the
consumer's `onProgress`. On a `RecoverableError` the decorator calls the engine again, with the
previous failure appended to the original prompt — an attempt that failed before the provider
registered the turn left no session that remembers it. On exhaustion it throws
`UnrecoverableError`.

**A workflow turn.** `OrchestratorAgent.run` loops up to `maxAttempts` rounds of planner →
executor → reviewer. The reviewer is asked for JSON and its answer goes through
`ReviewerDecisionValidator`, so a decision is `{ decision: 'approved' }` or
`{ decision: 'rejected', feedback }` and never free text. An unusable reviewer answer retries
only the reviewer call, with the parse failure fed back — a malformed decision is not evidence
that the plan or the implementation were wrong. A rejection starts another round with the
feedback carried into the planner prompt. All three roles receive the same run options, so one
cancellation stops the whole workflow and progress from every role reaches the consumer
through one stream.

**A model-backed turn.** `LLMAgent.run` sends the stored context, the new prompt and the
definitions of its tools to its `LLMClient`, inside `classifyProviderFailure`; the client
never receives a tool's `execute`. When the answer calls tools, the agent runs them one at a
time, in order, and calls the model again with the calls and a `tool` message holding their
results. The run ends when an answer calls no tool. After `maxSteps` calls to the model it
fails with `UnrecoverableError` instead, without running the last step's calls, because no
call is left to send their results to. A missing tool, or a tool that throws, becomes an
error result the model can correct itself from; only a cancellation escapes, whatever error
the tool turned it into, and a cancelled run neither starts nor announces another tool. A
call is announced as `in_progress` only once it is about to run, after its approval, so a
call to a missing tool, a call whose risk could not be judged, or a denied call is reported
only by how it ended.
Before a call runs, its tool judges its risk. Unless the agent was built with `autoApprove`, a
`destructive` call goes to the run's `approve`, or is denied when the run has none. A denial
is an error result, narrated with `status: 'denied'`, and the run carries on; a throwing
approver ends the run, as any host callback does. A
`refused` or `truncated` stop ends the run with `UnrecoverableError`. Each client maps the
parts to its provider's shapes and back: Claude's `tool_use` and `tool_result`, with every
result in one user turn, and OpenAI's `function_call` and `function_call_output`, paired by
`call_id`, where a failed result is marked in the text sent, since OpenAI has no error flag.

Nothing is recorded until the run completes. Then the prompt, every answer and every tool
result enter the conversation together, so a failed run leaves it untouched, no tool call is
kept without its result, and a retry of the same prompt cannot appear twice. Once a call has
reached an existing tool, a recoverable failure becomes `UnrecoverableError`: `RetryingAgent`
would run the prompt again and repeat the tool's effects. A call to a missing tool, or a denied
one, does not count, because nothing ran. Text and reasoning are narrated as each answer arrives, as
`agentMessage` and `reasoning`; `providerData` is never narrated. A tool call is narrated as a `tool` event only when it starts,
and again when it ends, so a call the run never starts is never shown as running. All of it
goes through `classifyHostFailure`; the response carries the text of the final answer alone. Tokens are
summed over every call of the run: one call without usage leaves the total unknown, and a
failure carries what the earlier calls spent. The agent emits no `turnStarted` or
`turnEnded`: like the other engines, it leaves turn boundaries to the consumer.

**Usage accounting belongs to a `run()`, not to an instance.** The totals are created inside
`run()` and passed down. A consumer that keeps one orchestrator for a whole session would
otherwise see every previous run's tokens reported again, and two concurrent runs would report
each other's.

## Constraints and trade-offs

- **Retry wraps an agent, not a workflow.** A transient failure in one role is absorbed where
  it happened, without redoing another role's successful work. The cost is that a workflow has
  no single retry budget: each role carries its own.
- **Each role's instructions are a default a caller can replace.** The harness's own live in
  `src/orchestration/domain/model/orchestratorAgent.ts`, apart from the data each round sends.
  Both orchestrator factories take `systemPrompts`, per role, and use a replacement word for
  word; a role left out keeps the default. The reviewer's JSON decision is the one part the
  workflow depends on, so a replaced reviewer prompt must still ask for it.
- **The mandatory test suite never contacts a provider.** Both engines and `LLMAgent` with
  both `LLMClient`s are exercised through offline fakes of their SDK surfaces. Provider-boundary correctness — authentication, request
  shape, model availability — is not covered by an automated suite and surfaces through real
  usage instead. `pnpm run dev` is how that boundary gets exercised before a release.
- **`cli/` is the repository's own consumer, not a published one.** It exists so a change to
  the seam can be driven against real providers by hand, which the offline suite cannot do. It
  stays out of `src/` deliberately: it encodes a blocking, turn-by-turn loop, and a REST or
  WebSocket consumer would call `Agent.run()` per request and want none of it. It stays out of
  the tarball too — `files` lists `dist` only, and `scripts/pack-check.mjs` fails on anything
  else reaching it.
- **The harness's own tools only read, and only a destructive call is held back.**
  `createLLMOrchestrator` gives its planner and reviewer the repository tools of #25, so nothing
  a model runs there can change a file. Each tool judges each call `safe`, `mutating` or
  `destructive`; `LLMAgent` asks the run's `approve` only about a `destructive` one, and denies
  it when there is none. A `mutating` call runs unasked, because git can undo it, so a tool
  that changes something git does not track must count as `destructive`.
- **An API key in the environment can move the Claude executor off the subscription.** The
  Claude Agent SDK authenticates with `ANTHROPIC_API_KEY` when it is set, and the harness does
  not remove it from the environment it inherits. With `provider: 'anthropic'`,
  `createLLMOrchestrator` needs that key for its planner and reviewer, and it also bills
  the executor.
- **An agent reads only what `.gitignore` does not ignore, inside one root.** Ignored files,
  tracked files `.gitignore` names, `.git`, files ripgrep's own `.ignore` would un-ignore, symlinks and paths outside the root do not exist
  for the repository tools, so a secret that is not ignored is visible. A line longer than 300
  characters reaches the model cut, and the result says so. The scope a model asks for is applied to the output
  of a search over the whole root as it arrives, before anything is stored, and never passed to ripgrep, which stops honouring
  `.gitignore` for a path it is given explicitly. ripgrep ships with the package
  (`@vscode/ripgrep`); git is the fallback, and with neither the workspace cannot be built.
  Every operation stops after 30 seconds with an error that asks the model for a narrower
  query; it is not a cancellation of the run.
- **Tool schemas must fit strict mode.** Both clients offer every tool with `strict: true`, so
  the model's input always parses and matches the schema. The price is the providers' subset
  of JSON Schema: `additionalProperties: false` on every object, every property in
  `required` (an optional one is a union with `null`), no numeric or length bounds, and at
  most 20 tools per request on Claude. A schema outside it fails every request with a 400,
  which is `UnrecoverableError`.
- **Tools run one at a time.** Independent calls in one answer would finish sooner in
  parallel, but running them in order keeps their effects and narration deterministic, and
  asking a human to approve a call (#43) needs one call at a time.
- **The seam has no memory or routing model.** MCP, long-term memory, graph execution and
  file-based agent registries are deliberately absent; each waits for a real consumer.
  `LLMAgent`'s `Conversation` lives only as long as the agent: persisting it waits for the
  session manager (#29).
- **Reasoning is replayed only to the provider that produced it.** Each client keeps its
  signed or encrypted reasoning as a `providerData` part labelled with its own `source`, and
  sends back only its own. A conversation handed to the other provider keeps its text, tool
  calls and results, and loses the private reasoning.
- **`LLMClient` does not stream.** A call returns the whole answer, so an `LLMAgent`
  narrates it only once it is complete. The CLI shows a spinner and then the message, which
  is all it needs; streaming would be a separate method when a consumer needs text as it is
  generated.
