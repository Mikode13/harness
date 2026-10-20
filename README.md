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

- **A provider-agnostic `Agent` contract** (`run(prompt, { signal, onProgress })`) with
  two paths to each provider — swapping one agent for another, anywhere in the
  composition, changes nothing else.
- **The Agent SDK path, the default**: `CodexAgent` and `ClaudeAgent` drive Codex
  and Claude Code. Codex reuses one `Thread` across turns and Claude resumes via a
  captured `session_id`, so the provider keeps the context.
- **The model API path**: `LLMAgent` calls the OpenAI Responses API or the
  Anthropic Messages API and keeps the conversation itself, in a form that can move
  between providers. It runs its own tool loop over the tools it is given. The
  harness ships tools that read the repository (list, search, read), bounded by
  `.gitignore`, and `createFileTools`, which also change files in each provider's
  native format, every change recorded so it can be undone, and run the commands you
  configure, such as the tests, recording what each one changed too.
- **`OrchestratorAgent`**: coordinates a planner, an executor, and a reviewer
  (each an injected `Agent`) in a plan → execute → review loop. The reviewer's
  decision is a Zod-validated structured `{decision, feedback}`, not free text —
  a rejected or malformed decision retries with the reason fed back, bounded by
  `maxAttempts`, converting to `UnrecoverableError` only once exhausted. A
  malformed reviewer response retries only the reviewer call, not the whole
  cycle. Because it implements `Agent` itself, the chat loop drives it exactly
  like it drives a bare engine.
- **Workflows** (`createWorkflow`): stages you define, each with an agent and a context
  of its own. A stage's JSON answer is validated before its transition picks the next
  stage, stops the run on purpose, or completes it. Only the data a transition hands
  over crosses to the next stage, and the types check it against what that stage takes.
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

## Architecture

[`docs/architecture.md`](docs/architecture.md) is the current source for the module
boundaries, the dependency direction, the public contract, and the failure classification
every engine goes through. [`docs/decisions.md`](docs/decisions.md) keeps why each of them
was chosen.

## Where it is going

Open work is tracked in GitHub issues:

- [#17](https://github.com/Mikode13/harness/issues/17): dynamic routing —
  deciding which flow or agent a request needs, instead of always running the
  fixed plan → execute → review workflow. It reuses the structured-decision
  technique already proven on the reviewer.

Deliberately out of scope for now: MCP, long-term memory, graph execution, and
file-based agent registries — each waits for a real need.

## Adding an engine

A new provider only needs one thing to compose safely into everything above:
**it must only ever reject with `RecoverableError` or `UnrecoverableError`**
(`src/shared/domain/errors.ts`), never a raw SDK error. `RetryingAgent` and
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
pnpm add @mikode13/harness zod
```

`zod` 4 is a peer dependency: `defineTool` takes your Zod schemas, so the harness uses
your copy rather than bundling its own.

The package is ESM only and runs on Node.js 22 (22.13 or later) or 24. Its type declarations resolve
internal modules through the `imports` field of its `package.json`, so a TypeScript consumer
needs `moduleResolution` set to `node16`, `nodenext` or `bundler`; the legacy `node10`
resolution cannot read that field.

It supports macOS and Linux. Windows is not supported for now: the tools that write files,
undo a run and run commands are built and tested on macOS and Linux only.

An agent is built by a factory, then driven. The only output the package produces
on its own is diagnostic warnings on stderr, from a default logger that both
factories let you replace through their `logger` option:

```ts
import { createAgent, UnrecoverableError, type ProgressEvent } from '@mikode13/harness';

const agent = createAgent('anthropic', { model: 'sonnet' });
const controller = new AbortController();

const render = (event: ProgressEvent) => {
	if (event.type === 'agentMessage') process.stdout.write(event.message);
};

try {
	const result = await agent.run('Summarize this repository.', {
		signal: controller.signal,
		onProgress: render,
	});
	// `response` is empty when the run produced no text; `tokens` is missing when the provider
	// reported no usage.
	console.log(result.duration, result.tokens);
} catch (error) {
	// A failed run reports what it spent before failing.
	if (error instanceof UnrecoverableError) console.error(error.message, error.cause, error.tokens);
}
```

`ProgressEvent` is the public seam for live activity; rendering it is the
consumer's decision, not the harness's. `cli/progressEventFormatter.ts` is one
terminal-shaped implementation to copy from. New event types can arrive in minor
releases, so render the ones you know and ignore the rest. Swapping the agent for
`createAgent('openai')`, or for `createOrchestrator()` and its planner → executor →
reviewer workflow, changes nothing else in the snippet above.
`createOrchestrator({ provider: 'anthropic' })` runs every role on one provider, for
example when the other one is out of quota.

The optional `agent` field on an event identifies the orchestrator role that produced
it (`planner`, `executor`, or `reviewer`). The optional `summary` on a `tool` event
is narration only: it describes the model's call and is not the tool result. A failed
configured command may also carry its optional `exitCode`, and a failed call on the
model APIs its optional `error`: what the model was told went wrong, such as a patch
that did not apply. Both are narration; the command's output and changes still
arrive in the tool result. A role label is applied by the orchestrator,
including retries and later rounds, so a nested agent cannot accidentally attribute
its events to another role. Consumers should continue to handle events without these
optional fields.
`systemPrompts: { planner, executor, reviewer }` replaces a role's instructions;
a role left out keeps the harness's own, and the reviewer must still answer with
the JSON decision described on the option.

### Composing agents into a workflow

`createWorkflow` runs stages you define, each with an agent of its own, so each can use a
different provider, model and instructions. It works like a middleware chain: a stage's agent
starts with an empty context, builds its prompt from what the previous stage handed it, and
answers in JSON. The stage's `validator` turns the answer into a typed value, and its
`transition` picks what happens next. A stage's conversation stays with it; only the
transition's `input` reaches the next stage.

You declare once what each stage receives, and every transition is checked against it: a `go`
to a stage that does not exist, or with the wrong input, does not compile, and neither does a
workflow that leaves a stage out.

```ts
import { z } from 'zod';
import { createLLMAgent, createWorkflow, defineWorkflowStages } from '@mikode13/harness';

const Triage = z.object({ worthAnswering: z.boolean(), topic: z.string() });
const Draft = z.object({ text: z.string() });
const Review = z.object({ approved: z.boolean(), feedback: z.string() });

/** What each stage receives. */
interface Inputs {
	triage: string;
	draft: { topic: string; feedback: string };
	review: { topic: string; text: string };
}
const stage = defineWorkflowStages<Inputs, string>();

const workflow = createWorkflow({
	initialStage: 'triage',
	stages: {
		triage: stage('triage', {
			agent: () =>
				createLLMAgent('openai', {
					model: 'gpt-5.6-luna',
					systemPrompt:
						'Decide whether a question deserves an answer. JSON {worthAnswering, topic}.',
				}),
			prompt: question => question,
			validator: { validate: value => Triage.safeParse(value).data },
			transition: ({ worthAnswering, topic }) =>
				worthAnswering
					? { type: 'go', stage: 'draft', input: { topic, feedback: '' } }
					: { type: 'stop', result: 'Not worth an answer.' },
		}),
		draft: stage('draft', {
			agent: () =>
				createLLMAgent('anthropic', {
					systemPrompt: 'Write a short, accurate answer. JSON {text}.',
				}),
			prompt: ({ topic, feedback }) => (feedback ? `Revise it: ${feedback}` : `Topic: ${topic}`),
			validator: { validate: value => Draft.safeParse(value).data },
			// The stage's own input is the second argument, so the topic need not go through the model.
			transition: ({ text }, { topic }) => ({
				type: 'go',
				stage: 'review',
				input: { topic, text },
			}),
		}),
		review: stage('review', {
			agent: () =>
				createLLMAgent('openai', { systemPrompt: 'Review an answer. JSON {approved, feedback}.' }),
			prompt: ({ text }) => text,
			validator: { validate: value => Review.safeParse(value).data },
			transition: ({ approved, feedback }, { topic, text }) =>
				approved
					? { type: 'complete', result: text }
					: { type: 'go', stage: 'draft', input: { topic, feedback } },
		}),
	},
});

const result = await workflow.run('Why is the sky blue?', {
	signal: AbortSignal.timeout(10 * 60_000),
});
// 'completed' or 'stopped', and what each stage received, answered and chose.
console.log(result.status, result.result, result.stages, result.tokens);
```

- **Agents:** `agent` creates the stage's agent the first time the stage runs in a run.
  When the run comes back to a stage, as `draft` does after a rejected review, the same
  agent goes on with its conversation, so it remembers its first draft. The next run
  creates new agents, so two runs, even at once, never see each other's conversations.
  `agent` may return a promise, so a stage can create an agent that is built async, such as
  one from `createLLMOrchestrator`.
- **Transitions:**
  - `go` runs the stage it names, with `input`.
  - `complete` ends the run finished.
  - `stop` ends it early on purpose, and the result's `status` is then `'stopped'`.
  - A failure rejects the run, so a stop is never mistaken for one.
- **An unusable answer:** an answer that is not JSON, or that the validator rejects with
  `undefined`, is asked for again with the reason. The stage's agent answers at most
  `maxAttempts` times, 3 by default and settable per stage. Then the run fails with an
  `UnrecoverableError` carrying every answer's usage.
- **What the run knows:** `result.stages` records, for each stage run in order, its input,
  its validated output, its attempts, usage and duration, and the transition it chose.
- **Bounds:** `maxTransitions`, 100 by default, ends a loop of stages. Without the types, from
  JavaScript, `createWorkflow` checks the stage names and the initial stage; a `go` to a stage
  that does not exist fails the run when it is taken.
- **Narration:** `onProgress` receives a `workflowStage` event before each answer and a
  `workflowTransition` event after each choice. Stages run one at a time, so the agent
  events between them belong to that stage.
- **Cancelling and timing out:** the signal cancels the whole run. `AbortSignal.timeout`
  times it out, and `isAbortError` recognizes both.
- **Routing stays outside:** a workflow runs the flow you picked for a request. Choosing
  that flow is [#17](https://github.com/Mikode13/harness/issues/17).

### Validating factory options

The provider-aware guards validate command-line strings before a factory is built. Use the
catalog for help text rather than copying the accepted values; choose the catalog and guards for
the path you are using:

```ts
import {
	agentModels,
	agentReasoningEfforts,
	createAgent,
	createLLMAgent,
	isAgentProvider,
	isLLMModelOf,
	isLLMReasoningEffortOf,
	isModelOf,
	isReasoningEffortOf,
	llmModels,
	llmReasoningEfforts,
} from '@mikode13/harness';

const providerInput: string = process.argv[2] ?? '';
const modelInput: string = process.argv[3] ?? '';
const effortInput: string = process.argv[4] ?? '';
const useModelApi = false;

if (!isAgentProvider(providerInput)) throw new Error('Unknown provider');

if (useModelApi) {
	if (
		!isLLMModelOf(providerInput, modelInput) ||
		!isLLMReasoningEffortOf(providerInput, effortInput)
	) {
		throw new Error(
			`Expected model ${llmModels[providerInput].join(', ')} and effort ${llmReasoningEfforts[providerInput].join(', ')}`,
		);
	}
	createLLMAgent(providerInput, {
		model: modelInput,
		reasoningEffort: effortInput,
		systemPrompt: 'Be concise.',
	});
} else {
	if (!isModelOf(providerInput, modelInput) || !isReasoningEffortOf(providerInput, effortInput)) {
		throw new Error(
			`Expected model ${agentModels[providerInput].join(', ')} and effort ${agentReasoningEfforts[providerInput].join(', ')}`,
		);
	}
	createAgent(providerInput, { model: modelInput, reasoningEffort: effortInput });
}
```

These guards describe the provider-wide catalogs. A client can still impose a model-specific
constraint, such as Claude Haiku accepting no reasoning effort, and the factory's client or
engine validation remains the final boundary for values that bypass the guards.

Every agent a factory returns already retries recoverable failures. A model or
reasoning effort the chosen provider does not support throws
`InvalidAgentConfigError` when the agent is built. Building a Codex agent throws
`UnrecoverableError` if the Codex CLI binary cannot be found, which happens when
optional dependencies were skipped at install time.

### Authentication

The two paths authenticate differently:

- `createAgent` and `createOrchestrator` use the Agent SDKs, which use the login of
  the Codex CLI and of Claude Code, so a run counts against that subscription.
- `createLLMAgent` and every role of `createLLMOrchestrator`, the executor included, call
  the model APIs, which bill per token and need the key of each provider they use in
  the environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or both for the
  orchestrator's default roles. A missing OpenAI key fails when the agent is built; a missing
  Anthropic key fails its first run.

The Claude Agent SDK
[authenticates with `ANTHROPIC_API_KEY`](https://code.claude.com/docs/en/agent-sdk) whenever
it is set, so with that key in the environment a Claude agent from `createAgent` or `createOrchestrator`
bills the key instead of the subscription.

### Agents that own their conversation

`createLLMAgent` takes a system prompt and the tools the model may call, and
returns the same `Agent`. `defineTool` builds a tool from a Zod 4 schema; a field the
model may leave out is `.nullable()`, not optional, because both APIs call tools in
strict mode. An optional `summarize` function receives the same input after Zod
validation and supplies the tool's short progress narration. It is called once per
model call; its output is never sent to the provider, and a throwing summarizer
ends the run as an `UnrecoverableError` before the tool is prepared or executed:

```ts
import {
	createLLMAgent,
	createWorkspace,
	createWorkspaceTools,
	defineTool,
} from '@mikode13/harness';
import { z } from 'zod';

const now = defineTool({
	name: 'now',
	description: 'The current time, in ISO 8601.',
	input: z.object({}),
	risk: 'safe',
	summarize: () => 'current time',
	execute: async () => new Date().toISOString(),
});

const workspace = await createWorkspace({ root: process.cwd() });
const agent = createLLMAgent('openai', {
	systemPrompt: 'You answer questions about this repository.',
	tools: [...createWorkspaceTools(workspace), now],
});
```

Each tool judges the `risk` of each call: `safe` (a read), `mutating` (a change git
can undo) or `destructive` (one that loses something), as a fixed level or as a
function of the validated input. Only a `destructive` call is held back. It runs
when the run's `approve` allows it, or always when the agent was built with
`autoApprove`, which is meant for CI where nobody can answer:

```ts
// `ask` stands for however your app asks its user.
await agent.run('Tidy the docs folder.', {
	signal: controller.signal,
	approve: async ({ tool, input }) =>
		(await ask(tool, input)) ? { approved: true } : { approved: false, reason: 'keep it' },
});
```

With no `approve`, a `destructive` call is denied. A denial is not a failure: the
model receives it, with the reason when there is one, and carries on. Progress
reports the call with `status: 'denied'`. An approver that throws, or answers
anything but a boolean `approved`, ends the run with an `UnrecoverableError`, unless
the run was cancelled, and the call never runs.

The harness keeps no state between runs, so "don't ask again" belongs to your
approver. `rememberApprovals(ask)` builds one: when `ask` answers
`{ approved: true, remember: true }`, later calls to that tool are allowed without
asking. An answer whose `approved` or `remember` is not a boolean throws, so it is
neither run nor remembered. Its `key` option decides what counts as the same call,
such as the tool and its path. The memory lives as long as the approver you created,
so create one per session, per user or per run.

A run given `ask` also lets the agent ask its user, through its own `askUser` tool,
what is theirs to decide: the shape of a public API, a new dependency, behaviour the
request does not ask for, or a choice with real trade-offs. The model sends one to
four questions, each with two to four options, and `ask` answers each one in order,
with the label of an option or with the user's own words:

```ts
await agent.run('Add a cache to the client.', {
	signal: controller.signal,
	ask: async questions => Promise.all(questions.map(question => askYourUser(question))),
});
```

Without `ask` the agent has no such tool, and neither does an agent given a tool of its own named `askUser`, which keeps it. Questions the model wrote wrong go back to
it to correct. An asker that throws, or does not answer each question with some text,
ends the run with an `UnrecoverableError`. The Agent SDK engines ignore `ask`, and
`createLLMOrchestrator` passes it to every role.

### Agents that change files

`createFileTools` gives an agent the file tools of its provider, over the folders you
declare, each `read` or `write`:

- **OpenAI** gets `listFiles`, `searchText`, `readFile` and its native `apply_patch`.
- **Anthropic** gets `listFiles`, `searchText`, its native text editor (whose `view`
  reads) and `delete_file`.

Give the agent the same `workspace`, so it follows what the history undoes:

```ts
import { createFileTools, createLLMAgent, type WorkspaceOptions } from '@mikode13/harness';

const workspace: WorkspaceOptions = {
	roots: [
		{ path: process.cwd(), access: 'write' },
		{ path: '/srv/standards', access: 'read' },
	],
};
const agent = createLLMAgent('openai', {
	systemPrompt: 'You fix bugs, with a test for each.',
	tools: await createFileTools('openai', workspace),
	workspace,
});
```

Every tool goes through one access policy:

- it refuses a path outside the roots;
- it refuses a file `.gitignore` excludes;
- it refuses git's metadata, the history itself, and a secret such as `.env`. Add more
  secrets with `secrets.protect`, or open exact files with `secrets.allow`.

A change happens only in a `write` root, and only from a version of the file the agent
read: editing a file it never read is `READ_REQUIRED`, and editing one that changed since
is `STALE_FILE`. Every change is recorded before it is made, so the history can undo the
run.

With `workspace`, the agent's system prompt is followed by the roots and how to name a file
in them. After the user undoes runs, the agent's next run starts from its conversation as it
was then, with a note on what was undone and why. By default that note carries a summary
from the provider's cheap model, Claude Haiku or `gpt-5.6-luna`, billed with the run;
`summarizeUndone: false` keeps to the undone prompts. A run that changed a file names its
run in `AgentResponse.runId`. Progress reports each change as a unified `diff` on the tool's
`completed` event.

For debugging, `onTranscript` receives what the model saw in each run once the run ended,
completed, failed or cancelled. A `Transcript` has the run's `outcome`, the role it was of in
`createLLMOrchestrator`, or `explorer`, and a `content` of plain JSON: the instructions, the tool
definitions, the run's messages with what the tools returned, and the error a run that did not
complete ended with. `content` has no stable shape; read it, but do not build on it. A callback
that fails is logged, and the run stays as it ended.

`createLLMOrchestrator()` takes the options of `createOrchestrator()` plus `workspace`,
`maxSteps`, `compactAt`, `commands`, `formatter`, `summarizeUndone` and `onTranscript`, and returns a promise. Every role runs on the
model APIs:

- the planner and the reviewer read, with a `showChanges` tool that gives the current task's
  changes as far as each may read them, and an `explore` tool that sends up to 4 read-only
  explorers at once, one per question, on the role's provider's cheaper model: Claude Haiku
  4.5, or `gpt-5.6-luna` at `medium`. Each starts from its question alone and reports what it
  found, so the role reads the reports instead of filling its own context with files. Their
  usage counts in the run's, and their narration arrives as `subagent` events;
- the executor gets its provider's file tools. `autoApprove` reaches only the executor;
- each role gets the commands whose `roles` name it; a command names only the executor unless
  it says otherwise.

Each role's run stops after a number of calls to the model: 80 for the executor and 65 for
the planner and the reviewer by default. `maxSteps` changes it, as one number for every role
or per role, with no upper bound:

```ts
createLLMOrchestrator({ workspace, maxSteps: { executor: 120 } });
```

A run also stops sooner when the model is stuck: when five answers in a row ask for exactly
the same tool calls, or when one command, with the same input, ends the same way with exactly
the same output five times in a row, whatever the model did between them. `createLLMAgent`
takes one number, 65 by default.

No conversation is compacted unless you ask. `compactAt` is the number of input tokens at
which the provider compacts it on its side, replacing the turns before that call with its own
summary, which only its model reads back; the conversation keeps every original turn. The
call that compacts can lose its cache, as it did on OpenAI, so set it well above what a task
needs. Like
`maxSteps`, it is one number for every role or per role, and `createLLMAgent` takes one. On
Anthropic it must be at least 50,000, and Claude Haiku cannot compact:

```ts
createLLMOrchestrator({ workspace, compactAt: { executor: 200_000 } });
```

Without `workspace` it works on the current directory, read only. One run of the
orchestrator is one run of the history, every round included.

### Running the project's commands

With `commands`, `createFileTools` and `createLLMOrchestrator` add `runCommand`, which runs
one of the commands you configure, by name. Nothing goes through a shell, and the model
fills only the parameters a command declares:

```ts
const tools = await createFileTools('openai', workspace, {
	commands: {
		test: {
			description: 'Runs the tests. Give the test files to run only those.',
			executable: 'pnpm',
			args: ['vitest', 'run', '--', { type: 'paths', name: 'files', description: 'Test files' }],
		},
		format: { description: 'Formats the repository', executable: 'pnpm', args: ['format'] },
	},
});
```

- **Parameters:** `paths` inside the roots that the agent may read; a `choice` among the
  values you list; or `text` that matches your pattern and never starts with `-`.
- **Approval:** every call asks the approver, which sees the exact program, arguments and
  folder in `request.command`. `autoApprove` skips it.
- **Roles:** in `createLLMOrchestrator`, a command goes to the executor, or to the roles its
  `roles` lists, such as `['planner', 'executor']` for one that reads an issue. Whoever runs it,
  its files are captured around it. `createFileTools` offers every command.
- **Environment:** a command inherits only `PATH`, `HOME`, `TMPDIR`, `USER`, `SHELL`, `LANG`
  and `LC_*`, plus its own `env`. The provider keys never reach it.
- **Limits:** 10 minutes, then its whole process group is stopped (`timeoutMs`). The model
  reads the last 16 KB of its output (`outputBytes`).
- **History:** the files of the `write` roots are captured before each command and compared
  after it. What it changed is recorded in the history, so `undo` takes it back.
  - Not covered: what `.gitignore` excludes (`node_modules`, build output), secrets, files
    outside the roots, the network and remote services.
  - A timeout or a cancellation is never reported as a finished command.
- **Not on Windows yet.**

A command is trusted execution, not a sandbox. A test runs the repository's code, including
code the model just wrote, with everything your account can reach. The secret rules of the
file tools do not apply to it, so a command can print a secret into the model's context.
Configure only commands you would run yourself on that repository.

### Formatting what the agent writes

With `formatter`, `createFileTools` and `createLLMOrchestrator` run your formatter on every
file an edit creates or changes, right after writing it. The model reads the file as the
formatter left it, so no later edit fails because the formatter moved its lines:

```ts
const tools = await createFileTools('openai', workspace, {
	formatter: { executable: 'pnpm', args: ['exec', 'prettier', '--write', '--ignore-unknown'] },
});
```

- **Arguments:** the file's path is always the last one, relative to the formatter's `cwd`.
- **History:** what the formatter changes in that file is recorded, so `undo` takes it back with
  the edit. Changes it makes to other files are not.
- **Failures:** a formatter that fails, runs past its limit (1 minute, `timeoutMs`) or cannot
  start leaves the file as the model wrote it, and the model reads why.
- **Environment:** as a command's: no shell, and only the inherited few variables plus `env`.
- **Approval:** none, as for the edits themselves. A formatter that loads configuration from
  the repository, as prettier does, runs code the model can write there.
- **Not on Windows yet.**

### Going back through what an agent wrote

The harness's write tools record every run that changes files, outside the repository,
under the platform's state directory. `createHistory` reads that record and moves the
workspace through it:

```ts
import { createHistory, historyStart } from '@mikode13/harness';

const history = await createHistory({ root: process.cwd() });
const { runId } = await agent.run('Rename the helper.', { signal: controller.signal });

if (runId) console.log(await history.changes(runId)); // a git-style diff
await history.undo({ reason: 'keep the old name' });
await history.redo();
await history.goTo(historyStart); // as it was before the agent's first run
```

`list()` gives every run kept, oldest first, with its parent, status and the files it
changed, and the run the workspace is at (`head`), absent at the start. Runs form a tree:
going back and writing again starts a new branch, and `goTo` reaches the old one. `redo`
returns towards where the workspace was most recently. A run's `runId` is in its
`AgentResponse` when it changed a file, and a run that failed or was cancelled after
writing is still listed, with that status. A run that changed nothing is not kept.

A move writes a file only if it still holds what the history expects. A file you
changed since is left as it is and named in the move's `conflicts`, and the move is
then not `complete`. The reason is kept with the move.

A move can be tied to where the workspace is. Pass `from`, a run or `historyStart`, and
the move happens only if the workspace is still there; otherwise it fails with
`WorkspaceMovedError` and changes nothing. Pass it when you showed the user what a move
will do, so a run that ends while they answer cannot make it do something else:

```ts
const { head } = await history.list();
// … show the user what undoing `head` does, and wait for a yes …
await history.undo({ from: head ?? historyStart, reason });
```

A consumer branches on five errors: `WorkspaceBusyError` while a run or another move
holds the workspace, `WorkspaceMovedError` when it is not at `from`,
`NothingToMoveError` with nothing to undo or redo,
`UnknownRunError` for a run the workspace never had, and `HistoryExpiredError` for one
retention took. The history keeps 25 runs per workspace. Older runs are chained into
the next, so `historyStart` always restores the original state. For a chained run,
the error's `keptIn` names the run that now holds its changes, and that run's
`absorbed` in `list()` names it.

The history is not version control. It holds only what the harness's own tools wrote:
not your edits, not other programs', and not the Agent SDK engines' changes. The lock
keeps a second harness run out, but not an editor.

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

The agents work on the repository root, which is the directory the script runs in.
`pnpm run dev --llm` runs all three roles on the model APIs instead, through
`createLLMOrchestrator`, and needs the API keys in the environment (see
[Authentication](#authentication)).

Type your prompt at `>`. Press Ctrl+C while idle at the prompt to exit; pressing
it while an agent is running cancels only that turn and returns to the prompt.

A line that starts with `/` is a command for the CLI, not a prompt. Four commands
move through the [history of what the agents wrote](#going-back-through-what-an-agent-wrote),
without the model:

- `/history` shows the tree of runs and marks where the workspace is.
  `/history --files` adds the files each run changed.
- `/undo` goes back to the run before the current one.
- `/redo` goes forward again.
- `/goto <run | start>` goes to a run, named by its id or its last six characters, or
  to `start`, before any run.

Each move says what it will do and changes nothing until you answer `y`. It then
asks why, and records the reason, if you give one, with the move. A move that left
files as they were, because they changed since, names them. With `--llm` the executor
writes to the current directory through the harness's tools, so its runs are in that
history. The Agent SDK path changes files through its own tools, which the history does not
record.

The CLI asks in the terminal before a destructive tool call runs: yes, always for
that tool until the CLI exits, or no with an optional reason for the model. With
piped input nobody can answer, so such a call is denied: a line written for a later
question never approves one. Piped lines answer the prompt and the history commands in
order. With `--llm`, the executor asks before a destructive change, such as one that would
make `.gitignore` hide less. With `--llm`, any role can also ask you a question: the CLI
numbers its options, and you answer with a number, several separated by commas where it
allows more than one, or in your own words. With piped input nobody answers, and the model
is told to decide and say what it assumed.

With `--llm`, the agents can also [run commands](#running-the-projects-commands) you
configure for the repository, in `~/.config/mikode-harness/config.json` (or under
`$XDG_CONFIG_HOME`). The file maps each repository's real path to its `commands` and,
optionally, its `maxSteps`, `compactAt` and [`formatter`](#formatting-what-the-agent-writes). It lives outside every repository, so neither a cloned repository
nor the agent decides what runs, or for how long:

```json
{
	"/Users/me/code/app": {
		"commands": {
			"test": { "description": "Runs the tests", "executable": "pnpm", "args": ["test"] }
		},
		"maxSteps": { "executor": 120 }
	}
}
```

The CLI shows each command as the line it will run before asking, and "always" allows
that command again, not every command. Tool calls finish as one dimmed line with an
icon, role, tool name, summary and duration; a failed configured command includes
`exit N` beside its duration, while a command event also includes its exit code.
A denied call is marked `denied`. Messages remain normal text under a bold role
heading. Reasoning is dim italic and complete by default; pass
`--thinking-headings` to show only Markdown bold headings as `∴ …`. A tool start
updates the spinner rather than printing a second line, and cancelling a turn clears
its pending spinner state. Pass `--steps <file>` to append one JSON line per call to the
model to that file: the call's tokens and what its context held, by origin, for measuring
what a run spends. An explorer's call is written as the `subagent` event that carries it,
which names the role that sent the explorer and its number. Pass `--debug <folder>` to keep,
in a folder for the session under it, every progress event in `events.jsonl` and, with
`--llm`, the transcript of every run of every agent, one numbered file each, such as
`003-executor-failed.json`. A failed tool call's event says what the model was told, in
`error`. They hold what the model read and what the commands printed, so only your user can
read them.

`cli/cli.ts` currently enables `autoApprove` for its Agent SDK agents, not for `--llm`.
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

## Releases

Versions follow Semantic Versioning and are published to npm automatically from
`main`. npm, the `v<version>` Git tags, and GitHub Releases are the release
history; the `version` in this repository stays at `0.0.0-development`. New
`ProgressEvent` types, models, and reasoning efforts ship in minor releases;
removing any of them is a major release.

## License

This project is source-available under the MIT License with the
[Commons Clause License Condition v1.0](https://commonsclause.com/). See
[LICENSE](./LICENSE) for the complete text. It is not OSI open source: the Commons
Clause restricts selling the software or a service whose value derives substantially
from it.
