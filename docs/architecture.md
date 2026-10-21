# @mikode13/harness architecture

This document describes the current architecture of `@mikode13/harness`. Why a decision was
taken belongs in [`decisions.md`](decisions.md); cross-project policy belongs in
[`Mikode13/engineering`](https://github.com/Mikode13/engineering). Anything not implemented
yet is named as such below.

## Purpose and scope

The package is a provider-agnostic seam for driving coding agents. It owns one contract,
`Agent`, two provider adapters behind it, a model-backed agent that owns its conversation, a retry policy, a planner → executor → reviewer
workflow, the repository tools a model-backed agent reads, changes and checks a repository with,
together with the access policy they share and the history that undoes their writes, and the
classification that keeps every failure crossing the seam legible to its consumers. It does not
own terminal or network I/O, prompt composition for a consumer's own use case, memory, or
scheduling.

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
src/tools/          what an agent can run: Tool, defineTool, the repository tools, and the file tools that change files
src/factory/        createAgent, createOrchestrator and their model-API pair, the only public way to build agents
src/orchestration/  planner -> executor -> reviewer, with a validated reviewer decision
src/workflow/       stages of the consumer's agents, each answer validated before its transition
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

| Module               | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agent/`         | `Agent`, `RunOptions`, `AgentResponse`, `ProgressEvent`, the approval contract (`ToolRisk`, `Approver`, and `rememberApprovals`, which remembers what an approver allowed); `RunContext`, what one top-level run shares with every agent and tool inside it, carried in `RunOptions` under a private symbol (internal). The approval types live here, not in `src/tools`, because `RunOptions` carries the approver and this module depends on nothing but `src/shared`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/diff/`          | `unifiedDiff`, the hunks that turn one text into another, found with Myers' algorithm. It imports nothing, so it can move to a package of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/engines/`       | One adapter per provider: SDK calls, session or thread continuity, and SDK events mapped to `ProgressEvent`; `LLMAgent`, which drives an `LLMClient` and runs the tools it is given, preparing each call before it is approved and running only what was prepared; given the workspace's history, it first follows the moves the user made through it, taking the conversation back with the workspace and telling the model what was undone, with a summary from a cheap model when it has one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/llm/`           | `LLMClient`, the stateless model port; `Message` and its parts, including opaque `providerData`; `Conversation`, a tree of turns whose context is the path to one of them, each turn tied to the history run it belongs to; the `ToolDefinition` a client describes to the model, and the internal mark (`asNative`, `nativeOf`) that declares one as a provider's native tool, `applyPatch` or `textEditor`, which a client declares its provider's way when it `supportsNative` it: `OpenAILLMClient` maps OpenAI's `apply_patch` calls and outputs to tool calls and results, and `ClaudeLLMClient` declares Claude's text editor; `MaxContextError`; `OpenAILLMClient`; `ClaudeLLMClient`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/tools/`         | `Tool`, a `ToolDefinition` plus the `execute` the agent runs; `defineTool`, which builds one from a Zod schema and rejects a schema strict mode would refuse (an optional field, a numeric or length bound, an object open to any key); `Workspace`, the read-only port to the folder an agent works on, and `createWorkspaceTools`, the `listFiles`, `searchText`, `readFile` and `readFiles` tools over it, `readFiles` reading up to 10 files or ranges and reporting one it cannot read in its place; `createWorkspace`, which picks `RipgrepWorkspace` or falls back to `GitWorkspace`, both enforcing the boundary through `BoundedWorkspace`; `AccessPolicy`, the one decision on whether a tool may read or write a path, implemented by `RootsAccessPolicy` over declared `read` and `write` roots, git's protected files, the default secrets list and `.gitignore` (internal; the file tools and `runCommand` decide through it); `FileEditor`, which prepares a create, replace or delete and applies it under that policy and the run's recovery journal, and `WriteSession`, everything one top-level run writes; `PreparingTool` and `prepareCall`, which bring a harness-built tool and a consumer's `Tool` into one lifecycle; `WorkspaceWrites`, which gives each run's context its own `WriteSession`; `ReadRegistry`, what one conversation has seen of each file, and `prepareTrackedEdit`, which makes an edit only from that version (`READ_REQUIRED`, `STALE_FILE`) and returns the lines around it, with `createTrackedReadFile` and `createTrackedReadFiles`, the `readFile` and `readFiles` that record it; the native edit formats on that core (`editFormats.ts`): `createApplyPatchTool` for OpenAI's V4A patches, applied by our own `applyUpdate` in `v4aPatch.ts`, and `createTextEditorTool` and `createDeleteFileTool` for Claude; `PolicyWorkspace`, the read `Workspace` of the file tools: it lists and searches through a `BoundedWorkspace` built with `hidden` (`chooseWorkspace`), which leaves out what the access policy `hidesFromReading` by name before it counts or stores a match, so a secret `.gitignore` lets through stays closed, and it reads only what the whole policy allows; `createShowChangesTool`, the current run's changes for the planner and the reviewer, as far as each may read them; `createExploreTool`, the `explore` of the planner and the reviewer, which runs one new read-only explorer per question, all at once, and returns their reports; the configured commands: `Commands`, each a `CommandDefinition` with typed `CommandParameter`s (`paths`, `choice`, `text`), checked by `validateCommands` and turned into arguments by `buildArguments`; `runCommandProcess`, which runs one in a process group of its own and stops the whole group, confirming it gone; `CommandCheckpoint`, which captures the covered files before a command and records what changed after it, as changes `observedBy` that command; and `createCommandTool`, the `runCommand` tool over them; `FileFormatter`, which runs the consumer's `Formatter` on each file an edit creates or changes, capturing only that file the same way, and which `WorkspaceWrites` holds for `prepareTrackedEdit`; and `fileTools.ts`, which opens a workspace (`WorkspaceOptions`) and gives each provider its file tools, the public `FileTool`, plus `runCommand` with commands (all internal but `FileTool`, `WorkspaceOptions`, the command types and `Formatter`). A harness tool's `prepare` receives a `ToolCallContext`: the run's context, shared by every role, the reads of the conversation that made the call, the call's id, and the run's narration and usage, which never throw, for a call that works on the model itself. It depends on `src/recovery/` for the journal, on `src/diff/` for the lines an edit returns, on `src/llm/` for the definition and on `src/agent/` for `ToolRisk`, and for the `Agent` an explorer is; `src/llm/` does not know it exists |
| `src/factory/`       | Provider selection, default model and reasoning effort per role, and composition with the retry decorator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/orchestration/` | Each role's default instructions and the data each round sends, `InstructedAgent`, the attempt loop, per-run usage totals, and the validated reviewer decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/workflow/`      | `WorkflowTransition`, whose `go` is typed against the workflow's map of stage inputs; `WorkflowStage` and `defineWorkflowStages`, which binds stages to that map; `WorkflowResult`; and `WorkflowRunner` (internal), which runs one stage at a time with an agent each stage creates once per run, asks again when an answer is not JSON or its `Validator` rejects it, and passes only the transition's `input` to the next stage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/recovery/`      | The recovery store: `RecoveryStore`, the `RunJournal` of one writing run, and `FileRecoveryStore`, which keeps them in a private directory per workspace under the platform's state directory, outside the repository. A change is recorded as prepared, with the content it replaces, before it is made. One run writes to a workspace at a time. Runs form a tree: each records the run the workspace was at when it started, and the store records the run it is at now. A run whose process died is listed as `interrupted`, and the next run settles the changes it left prepared. The journal also records an observation around something that changes files outside it, such as a command: it names a stored manifest of the files before, and the changes found after are recorded as its own entries, each `observedBy` it; an observation a dead run left open is settled from its manifest. `goTo`, `undo` and `redo` move the workspace through that tree, one run at a time, writing each file only if it holds the state the history expects; a file that does not is left as it is and the move is reported as partial. Each move is recorded as a `Revision`, with the reason the host gave, and a move the process did not finish is finished by the next move or run. Moves and runs share the workspace lock. A run that changed nothing, because it prepared no change or abandoned every one, is discarded when it finishes, and the workspace goes back to its parent. That is read from its journal: a dead run that changed nothing is hidden at once, and the next run or move removes it. Retention keeps 25 runs per workspace, the new one included: before a run starts, abandoned branches are removed whole, then the oldest run on the current line is chained into the next, so the start of the history always stays reachable; contents no kept run refers to are freed. `showChanges` renders a run's recorded effects as a git-style diff per file. `History` is the public view of all this, built by `createHistory` over its own `FileRecoveryStore` and implemented by `StoreHistory`: it lists the runs with the files each changed, shows a run's diff, and moves the workspace, with paths relative to the root; the store, the journal and `Revision` stay internal. It depends on Node and on `src/diff/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/retry/`         | The decision to call an inner agent again, and the prompt that carries the previous failure into the next call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/shared/`        | `ILogger` and its stderr implementation, `isAbortError`, `isOneOf`, `Tokens`, `Validator`, the error types and the functions that classify a failure. The failure contract lives here because the model clients use it as much as the agents do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The factory also owns the provider-indexed model and reasoning-effort catalogs and their
path-specific narrowers: `agentModels` and `agentReasoningEfforts` for the Agent SDKs, and
`llmModels` and `llmReasoningEfforts` for the model APIs. The catalogs are derived from the
provider adapters and preserve their literal tuples.

Two boundaries carry most of the design:

**Everything is an `Agent`.** `ClaudeAgent`, `CodexAgent`, `LLMAgent`, `RetryingAgent` and
`OrchestratorAgent` all implement `run(prompt, options)`, where `options` holds the run's
`signal`, its optional `onProgress`, its optional `approve`, asked before a model-backed
agent runs a `destructive` tool call, and its optional `ask`, which answers what a model-backed
agent asks its user. A decorator and a whole multi-agent workflow are
therefore substitutable for a bare engine anywhere, and a consumer's loop cannot tell which it
is driving. A decorator such as `InstructedAgent` passes `options` on whole, never rebuilt, so
a field added to it reaches every agent without each decorator learning about it. Two copy it
instead, both with object spread, so a field must be an own enumerable one to survive them:
`RetryingAgent`, for a run with `ask`, replaces only `ask` with one that remembers the answers
across attempts, and `OrchestratorAgent` makes one shallow copy per role with object
spread, carrying the own enumerable string- and symbol-keyed fields, including the internal
`RunContext`, and replaces only `onProgress` with a wrapper that makes the role attribution
authoritative. The same context therefore reaches every agent the run reaches, and no consumer can
see or set it.

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

One host callback is absorbed instead: `onTranscript`, which receives what the model saw once a
run of `LLMAgent` ended. It runs after the run's outcome is decided, and a failure in it is logged
through `ILogger.warn`, since a debugging aid must not change the run it observes. A
`Transcript`'s `outcome` and `agent` are contract; its `content` is plain JSON with no stable shape.

The provider and host boundaries stay narrow on purpose. Item mapping, logging and the
consumer callback sit outside `classifyProviderFailure` and outside the `for await` of
`classifiedProviderStream`; a host failure caught inside either would be reported as a
retryable provider failure.

Cancellation is the single deliberate exception. An `AbortError`, or the `TimeoutError` of
`AbortSignal.timeout`, propagates unchanged through every layer, because a deliberate stop is
not a failure and every consumer checks for it before either error type.

## Dependencies and contracts

Dependencies point inward. `src/engines/` and `src/factory/` depend on `src/agent/`;
`src/agent/` depends on nothing but `src/shared/`. `src/llm/` depends only on `src/shared/`,
for the failure contract and `Tokens`; only its `infrastructure` imports an SDK. `LLMAgent` depends on
`src/llm/`, and `src/llm/` knows nothing about agents. `ClaudeAgent` imports `claudeModelIds`
from `src/llm/infrastructure/`, the one table of the model each Claude alias names, so both
Claude paths run the same model for the same name. `LLMAgent` also reads the workspace's
history through the `src/recovery/` domain; the conversation itself knows only an opaque run id. `src/workflow/` depends only on `src/agent/` and
`src/shared/`: a stage creates an `Agent`, whatever builds it. No module imports `src/factory/`, which is
why it is the only place that knows every provider.

`src/index.ts` is the public API: `createAgent`, `createOrchestrator`, `createLLMAgent`,
`createLLMOrchestrator`, the `Agent`, `RunOptions`, `AgentResponse`, `Callback`, `ProgressEvent`,
`ProgressAgent`, `StepContext` and `Tokens` types, the `Transcript` and `TranscriptCallback` types
of `onTranscript`, the `Asker`, `UserQuestion` and `QuestionOption` types of `RunOptions.ask`, the approval contract (`rememberApprovals` and the `Approver`,
`ApprovalRequest`, `ApprovalDecision`, `RememberableDecision`, `ToolRisk` and `CommandLine` types), the three
failure types an agent rejects with, `isAbortError`, `isAgentProvider`, `agentProviders`, the
provider-indexed `agentModels` and `agentReasoningEfforts` catalogs with their `isModelOf` and
`isReasoningEffortOf` narrowers, and the model-API `llmModels` and `llmReasoningEfforts` catalogs
with `isLLMModelOf` and `isLLMReasoningEffortOf`. It also exports the option and model types. For
the model-backed agent's tools it also exports the `Tool`, `ToolSummarizer`,
`ToolDefinition`, `JSONSchema`, `Workspace` and `TextMatch` types, `defineTool`,
`createWorkspace` and `createWorkspaceTools`. For agents that change files it exports
`createFileTools` and the `FileTool`, `WorkspaceOptions`, `WorkspaceRoot`, `SecretRules`,
`CreateLLMOrchestratorOptions`, `RoleSteps` and `RoleTokens` types, and for the commands they run the
`Commands`, `CommandDefinition`, `CommandArgument`, `CommandParameter` and `CommandRole` types, and `Formatter` for the formatter their edits run. For the history of what those runs wrote it exports `createHistory`, the `History`, `HistoryRun`, `Move`, `MoveOptions` and `RunStatus` types,
`historyStart`, and the `WorkspaceBusyError`, `WorkspaceMovedError`, `NothingToMoveError`,
`UnknownRunError` and `HistoryExpiredError` errors; `AgentResponse.runId` names the run a writing run recorded. For workflows it exports `createWorkflow`, `defineWorkflowStages`, the `Workflow`,
`WorkflowStage`, `WorkflowStageDefinition`, `WorkflowStageName`, `WorkflowTransition`,
`WorkflowResult`, `WorkflowStageReport` and `CreateWorkflowOptions` types, and `Validator`. `defineTool` takes a Zod 4 schema, so Zod's major
version is part of the contract, and `zod` is a peer dependency, so the consumer's schemas and
the harness share one copy. `RetryingAgent`,
`OrchestratorAgent`, `WorkflowRunner`, `LLMAgent` and both engines are internal — the factories apply retry and the role
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
  unknown. A failure that never got an answer, such as a connection lost before the provider
  responded, adds nothing. A Claude stream that breaks off once the provider began to answer
  sets `usageUnreported`, because part of the answer may be billed and its count never
  arrives. A cancellation carries no tokens: the signal's reason must propagate unchanged, an
  `AbortError` or the `TimeoutError` of `AbortSignal.timeout`, both of which `isAbortError`
  recognizes. `duration` is each layer's own wall clock, so a retried run or a whole workflow
  reports what the consumer waited.

- **`ProgressEvent` grows in minor releases.** Consumers are told to render the types they
  know and ignore the rest, so a new type must never carry information a consumer needs to be
  correct. The result of a run travels in `AgentResponse`; progress is narration. Existing event
  shapes remain valid because `agent` is optional on every event and `summary`, `exitCode` and
  `error` are optional on `tool` events. `OrchestratorAgent` supplies
  `agent: 'planner' | 'executor' | 'reviewer'` for every event received from a role, including
  retries and later rounds, and overwrites an inner value rather than trusting it. A
  `tool.summary` is owned by the tool and is only a short description of the model-supplied call;
  `tool.exitCode` narrates the exit code of a configured command that failed, and `tool.error`
  what the model was told about a call that failed. None of them replaces the tool result, diff
  or `AgentResponse`. A workflow emits `workflowStage` before each answer it
  asks for and `workflowTransition` after each transition, and passes its agents' events on
  unchanged. Stages run one at a time, so the events between two workflow events are one stage's;
  a workflow that ran stages at once would need an origin on every event. The stages, their
  transitions and their usage travel in `WorkflowResult`. The subagents one tool call runs at
  once, such as the explorers of an `explore` call, have each event wrapped in a `subagent`
  event, with the call's id, the subagent's number and its task, so their events stay apart;
  `OrchestratorAgent` stamps the wrapper with the role that made the call.
- **`Tool` narration stays outside the provider definition.** A tool may provide
  `summarize(input)`, but `ToolDefinition` sent to an `LLMClient` contains only `name`,
  `description` and `inputSchema`. `defineTool` validates the model input and passes that
  validated value to `summarize`; `LLMAgent` calls it once, before preparation or effects, and
  reuses the value on the `in_progress`, `completed`, `error` or `denied` events. A missing
  summarizer emits no summary. A consumer summarizer that throws is host code and becomes an
  `UnrecoverableError`, before a call can prepare or run; schema rejection remains an error
  result the model can correct.
- **A model or reasoning effort is the engine or client's to accept.** The factory publishes
  provider-indexed catalogs and path-specific narrowers: `agentModels` and
  `agentReasoningEfforts` for the Agent SDKs, and `llmModels` and `llmReasoningEfforts` for the
  model APIs. Each engine or client constructor still rejects what its provider does not support
  with `InvalidAgentConfigError`, while the agent is being built. The catalogs do not encode
  model-specific constraints, so constructor validation remains the final boundary and the factory does not otherwise validate the values.

External integrations are `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`, each
reached only from its own engine, `openai` and `@anthropic-ai/sdk`, each reached only from its own `LLMClient`, and `zod`, used by
`ReviewerDecisionValidator` behind the `Validator<T>` interface of `src/shared/`, by `defineTool`, and by a consumer's own workflow validators. `ILogger` is the one outbound
port: the factories default it to a stderr logger, and nothing in `src/` writes to stdout,
which belongs to the consumer.

Conversation continuity is each agent's own responsibility and is not modelled at the
`Agent` seam. `CodexAgent` keeps one SDK `Thread` across turns; `ClaudeAgent` captures a
`session_id` from the first turn and resumes with it. Either way the provider keeps the
context server-side. `LLMAgent` is the exception: it keeps its own
`Conversation` in process and sends the whole context on every call, so the model behind it
holds no state. Its adapters are `OpenAILLMClient`, on the OpenAI Responses API with
`store: false`, and `ClaudeLLMClient`, on the Anthropic Messages API. `createLLMAgent` builds one of them and the agent together for a provider, wrapped in retry
like every other agent, with the tools it is given. With a `workspace` it also follows the
workspace's history, with a summary of what was undone from the provider's cheap model, and its
system prompt is followed by the roots. `createFileTools` builds the file tools of a provider
over a workspace (`openWorkspace`, then `fileToolsFor`): one access policy, one recovery store
and one record of writes. `createLLMOrchestrator` runs all three roles on the model APIs over one
opened workspace, each with its role's instructions, or the caller's, then the workspace, as the
system prompt. The planner and reviewer read, with `showChanges` and `explore`, whose explorers
are new agents on their provider's cheaper model with only `listFiles`, `searchText`, `readFile`
and `readFiles`, in the role's run, their usage counted in it. An explorer reports where the
answer is, and the role reads it; the executor gets
`fileToolsFor` its provider. Each role gets `runCommand` with the `commands` whose `roles` name
it, the executor by default. `OrchestratorAgent` creates one `RunContext` for a whole run, so the
executor's writes are one run of the history, and names it in its response. It sends each role only the round's data; an agent
without a system prompt gets its instructions at the head of every prompt from `InstructedAgent`. The Agent SDK path stays the default: `createAgent`
and `createOrchestrator` use the provider's own login, while the model API path needs
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and bills per token. Both paths name a provider by its company, `'anthropic'` or `'openai'`, and
take mostly the same model and effort names, but support is path-specific: for example, the Agent
SDK's OpenAI catalog accepts `ultra` while the OpenAI model API's catalog does not. Each path has
its own catalogs and narrowers.

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
feedback carried into the planner prompt. Each role receives its own shallow copy of the run
options, carrying the own enumerable fields such as `signal`, `approve` and the shared
`RunContext`; only `onProgress` is replaced with the role's authoritative wrapper. The shared signal
therefore lets one cancellation stop the whole workflow, and every wrapper forwards progress to the
consumer through one stream.

**A workflow of the consumer's stages.** The consumer declares a map from each stage's name to
what it receives. `defineWorkflowStages` binds stages to that map, so a `go` to a stage that does
not exist, or with an input that stage does not take, does not compile, and `createWorkflow`
requires every stage under its own name; it checks the same at runtime for JavaScript callers.
`WorkflowRunner.run` creates a stage's agent, with an empty context, the first time the stage runs
in that run, and keeps it for the run: a stage the run comes back to goes on with its conversation,
and the next run, or one running at the same time, creates its own. It builds the stage's prompt
from its input alone, runs the agent with the run's own options, and parses the answer as JSON,
stripping a code fence. The stage's `Validator` turns it into the stage's output, or `undefined`;
an answer that is not JSON or not valid is asked for again with the reason appended, as the
orchestrator does for the reviewer, up to the stage's `maxAttempts`. The valid output and the
stage's input go to `transition`. Only its `input` reaches the next stage, and only `stop` and
`complete` end the run, `stop` with status `'stopped'`; a failure always rejects.
`maxTransitions` ends a loop of stages. `WorkflowResult.stages` records each stage run's input,
output, attempts, usage and transition. Every stage shares one `RunContext`, and the runner checks
the signal before each stage and answer and after each agent call, so a cancellation or timeout
stops the work after it. An agent's classified failure propagates with the usage of every earlier
answer added; an unclassified one, a throwing agent factory, prompt, validator, transition,
progress callback or logger, an invalid transition or an unknown stage is an `UnrecoverableError`.

**A model-backed turn.** `LLMAgent.run` sends the stored context, the new prompt and the
definitions of its tools to its `LLMClient`, inside `classifyProviderFailure`; the client
never receives a tool's `execute`. When the answer calls tools, the agent runs them one at a
time, in order, and calls the model again with the calls and a `tool` message holding their
results. The run ends when an answer calls no tool. After `maxSteps` calls to the model, 65 by
default (80 for the orchestrator's executor), it fails with `UnrecoverableError` instead, without running the last step's calls,
because no call is left to send their results to. It fails the same way, before running them,
when five answers in a row ask for exactly the same calls, by tool and input. It also fails once a
configured command, by its input, has ended five times in a row with the same outcome and the same
output, whatever other calls came between; it stops on the fifth, after narrating its result and
before any later call of that answer. A client built with
`compactAt` has its provider compact the context inside the call that passes it; the summary is a
`compaction` part of the answer, unless the compaction failed and Claude returned no summary, which
the client leaves out with a warning. That client sends the context from its latest compaction on,
while the conversation keeps every turn and any other client sends them all. A missing tool, or a tool that throws, becomes an
error result the model can correct itself from; only a cancellation escapes, whatever error
the tool turned it into, and a cancelled run neither starts nor announces another tool. A
call is announced as `in_progress` only once it is about to run, after its approval, so a
call to a missing tool, a call whose risk could not be judged, or a denied call is reported
only by how it ended.
Before a call runs, its tool judges its risk. Unless the agent was built with `autoApprove`, a
`destructive` call goes to the run's `approve`, or is denied when the run has none. A denial
is an error result, narrated with `status: 'denied'`, and the run carries on; a throwing
approver ends the run, as any host callback does. A run given `ask` also offers the agent's own
`askUser` tool, which skips preparation and approval: its questions are checked, invalid ones
go back to the model, and the rest go to `ask`, whose answers the model reads; an asker that
throws or answers wrongly ends the run as host code. `RetryingAgent` wraps `ask` with
`rememberAnswers` for the whole run, so a retry tells the model what the user already answered
and never asks the same question twice. A
`refused` or `truncated` stop ends the run with `UnrecoverableError`. Claude may write 128,000
output tokens in one answer. Each client maps the
parts to its provider's shapes and back: Claude's `tool_use` and `tool_result`, with every
result in one user turn, and OpenAI's `function_call` and `function_call_output`, paired by
`call_id`, where a failed result is marked in the text sent, since OpenAI has no error flag.

Nothing is recorded until the run completes. Then the prompt, every answer and every tool
result enter the conversation together, so a failed run leaves it untouched, no tool call is
kept without its result, and a retry of the same prompt cannot appear twice. A run cut by the
output limit is the one failed run recorded: the answer that was cut keeps its text and
reasoning, without its tool calls or provider data, and its reads are kept, so the next run can
take it up. Once a call has
reached an existing tool, a recoverable failure becomes `UnrecoverableError`: `RetryingAgent`
would run the prompt again and repeat the tool's effects. A call to a missing tool, or a denied
one, does not count, because nothing ran. Text and reasoning are narrated as each answer arrives, as
`agentMessage` and `reasoning`; `providerData` is never narrated. A tool call is narrated as a `tool` event only when it starts,
and again when it ends, so a call the run never starts is never shown as running. All of it
goes through `classifyHostFailure`; the response carries the text of the final answer alone. Tokens are
summed over every call of the run: one call without usage leaves the total unknown, and a
failure carries what the earlier calls spent. The agent emits no `turnStarted` or
`turnEnded`: like the other engines, it leaves turn boundaries to the consumer. The tool-to-consumer
narration path is `Tool.summarize` → `LLMAgent`'s optional `tool.summary` events →
`OrchestratorAgent`'s authoritative role label → the consumer's progress callback. No stage makes
the summary part of the model context or the run result. After each call to the model, once its
tokens are counted, `LLMAgent` emits a `step` event: the call's tokens and a `StepContext`, the
characters it sent by origin (system prompt, tool definitions, text, reasoning, tool calls, each
tool's results, and the five largest results named by the summary their call got when it ran).
`measureContext` in `src/engines/domain/model/stepContext.ts` computes it; it is an estimate for
finding what fills a context, not a token count, and never calls a summarizer again.

**A configured command.** `runCommand` is prepared like any harness tool: the command's
parameters are checked, each path through the access policy, and the program, its arguments
and its `cwd` are fixed as a `CommandLine`, which the approver sees in `ApprovalRequest.command`.
Every call is `destructive`. Once allowed, the run's `WriteSession` starts its journal, and
`CommandCheckpoint` stores every covered file and a manifest of them, then records the
observation; if that fails, the command does not run. `runCommandProcess` starts it without a
shell, in its own process group and with a small environment, and returns once the group is
confirmed gone: after it ends, after a timeout, or after a cancellation. The checkpoint then
records each covered file that changed as a change `observedBy` the command, and closes the
observation. A non-zero exit code is an error result for the model, but the command's output and
recorded changes are retained; its progress event may carry that `exitCode`. A timeout fails
the call and a cancellation ends the run, both after the changes are recorded. A group that
cannot be confirmed gone leaves the observation open and stops writing for the run. See "The executor runs configured commands by name" and "Configured
commands are trusted, not sandboxed" in [`decisions.md`](decisions.md).

**An edit with a formatter.** When the workspace was opened with a `Formatter`, a create or a
change applies the model's content first. Then `FileFormatter` captures that one file, runs the
formatter on it as `runCommandProcess` runs a command, with the path as its last argument, and
records what changed as a change `observedBy` the formatter. The edit reads the file again,
records that version as the conversation's, and returns its lines. A formatter that fails
leaves the file as written and adds why to the result; one whose changes cannot be recorded,
or that cannot be confirmed stopped, fails the edit and stops writing for the run. See "The
edits run the consumer's formatter on each file they write" in [`decisions.md`](decisions.md).

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
- **Only the executor edits files, and only a destructive call is held back.**
  `createLLMOrchestrator` gives its planner and reviewer reading tools only, so they edit nothing
  through a file tool; the executor changes files only in a `write` root, each change recorded
  before it is made. A command given to the planner's or the reviewer's role can still change
  files, like any command: its checkpoint captures them into the run's history, and every call
  asks the approver. Each tool judges each call `safe`, `mutating` or
  `destructive`; `LLMAgent` asks the run's `approve` only about a `destructive` one, and denies
  it when there is none. A `mutating` call runs unasked, because git can undo it, so a tool
  that changes something git does not track must count as `destructive`.
- **An API key in the environment can move an Agent SDK Claude agent off the subscription.**
  The Claude Agent SDK authenticates with `ANTHROPIC_API_KEY` when it is set, and the harness
  does not remove it from the environment it inherits, so a Claude agent from `createAgent` or
  `createOrchestrator` bills that key instead of the subscription. `createLLMOrchestrator`
  needs the key anyway: all three of its roles, the executor included, are `LLMAgent`s on the
  model APIs and bill per token.
- **An agent reads only what `.gitignore` does not ignore, inside its roots.** For
  `createWorkspaceTools`, ignored files, tracked files `.gitignore` names, `.git`, files
  ripgrep's own `.ignore` would un-ignore, symlinks and paths outside its one root do not
  exist. The file tools of `createFileTools` and `createLLMOrchestrator` take several roots and
  also decide through `RootsAccessPolicy`, which follows a symlink and judges it by where it
  leads: one inside the roots, such as `CLAUDE.md → AGENTS.md`, works, and one out of them is
  refused. Either way, a secret that is not ignored is visible. A line reaches the model
  cut past 300 characters, or past 5,000 in a prose file (`.md`, `.markdown`, `.mdx`, `.txt`),
  where a cut line could not be copied into an edit; the result says so. One read or one search
  returns at most 16 KB, whole lines only, and says where to continue or to narrow the search.
  The bound is per read, so one `readFiles` call, up to 10 reads, can return up to 160 KB. The scope a model asks for is applied to the output
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
  narrates it only once it is complete. The Claude client streams its request inside the call,
  only so a long answer is not bound by the SDK's timeout. The CLI shows a spinner and then the message, which
  is all it needs; streaming would be a separate method when a consumer needs text as it is
  generated.
