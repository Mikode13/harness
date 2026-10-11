import { resolve } from 'node:path';
import type { Agent } from '#src/agent/domain/agent';
import type { HistoryReader } from '#src/engines/domain/model/historyFollower';
import { LLMAgent } from '#src/engines/domain/model/llmAgent';
import type { LLMClient } from '#src/llm/domain/llm';
import {
	ClaudeLLMClient,
	claudeLLMModels,
	claudeLLMReasoningEfforts,
} from '#src/llm/infrastructure/claudeLLMClient';
import {
	OpenAILLMClient,
	openAIModels,
	openAIReasoningEfforts,
} from '#src/llm/infrastructure/openAILLMClient';
import {
	executorInstructions,
	OrchestratorAgent,
	plannerInstructions,
	reviewerInstructions,
} from '#src/orchestration/domain/model/orchestratorAgent';
import { ReviewerDecisionValidator } from '#src/orchestration/infrastructure/model/reviewerDecisionValidator';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import { RetryingAgent } from '#src/retry/domain/model/retryingAgent';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import { isOneOf } from '#src/shared/domain/isOneOf';
import type { ILogger } from '#src/shared/domain/logger';
import { Logger } from '#src/shared/infrastructure/logger';
import type { WorkspaceRoot } from '#src/tools/domain/accessPolicy';
import {
	type CommandRole,
	type Commands,
	commandsFor,
	validateCommands,
} from '#src/tools/domain/commands';
import type { AgentTool } from '#src/tools/domain/preparedCall';
import type { Tool } from '#src/tools/domain/tool';
import {
	commandToolFor,
	type FileTool,
	fileToolsFor,
	type OpenedWorkspace,
	openStore,
	openWorkspace,
	stateDirectoryOf,
	type WorkspaceOptions,
} from '#src/tools/infrastructure/fileTools';
import { createShowChangesTool } from '#src/tools/infrastructure/showChangesTool';
import { createTrackedReadFile } from '#src/tools/infrastructure/trackedReadFile';
import { createWorkspaceTools } from '#src/tools/infrastructure/workspaceTools';
import { isAgentProvider, orchestratorRolesFor, type Role } from './agentFactory.ts';
import {
	agentProviders,
	type AgentModel,
	type AgentProvider,
	type CreateOrchestratorOptions,
	type ReasoningEffort,
} from './types.ts';

/** The models each provider's model API accepts. */
export const llmModels = {
	anthropic: claudeLLMModels,
	openai: openAIModels,
} as const satisfies Record<AgentProvider, readonly string[]>;

/** The reasoning efforts each provider's model API accepts. */
export const llmReasoningEfforts = {
	anthropic: claudeLLMReasoningEfforts,
	openai: openAIReasoningEfforts,
} as const satisfies Record<AgentProvider, readonly string[]>;

/** Narrows a model to one accepted by the selected provider's model API. */
export function isLLMModelOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is (typeof llmModels)[Provider][number] {
	return isOneOf(llmModels[provider], value);
}

/** Narrows a reasoning effort to one accepted by the selected provider's model API. */
export function isLLMReasoningEffortOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is (typeof llmReasoningEfforts)[Provider][number] {
	return isOneOf(llmReasoningEfforts[provider], value);
}

export interface CreateLLMAgentOptions {
	/**
	 * Defaults to `'sonnet'` on Anthropic and `'gpt-5.6-luna'` on OpenAI. The provider's client
	 * rejects a model it does not support.
	 */
	model?: AgentModel;
	/** Defaults to `'high'`. The provider's client rejects an effort it does not support. */
	reasoningEffort?: ReasoningEffort;
	/** Sent as the model's instructions on every call. */
	systemPrompt: string;
	/** The tools the model may call: the consumer's own, and those of `createFileTools`. Defaults to none. */
	tools?: (Tool | FileTool)[];
	/**
	 * The folders the agent works on, the same as given to `createFileTools`. With it, the agent
	 * follows the workspace's history: after the user undoes runs, its next run starts from the
	 * conversation as it was, and is told what was undone. The system prompt is followed by the
	 * roots and how to name a file in them.
	 */
	workspace?: WorkspaceOptions;
	/**
	 * With `workspace`, a summary of what was undone, from the provider's cheap model, in place
	 * of the undone prompts. That is Claude Haiku without thinking, or `gpt-5.6-luna` at high
	 * effort, and the call is billed with the run's tokens. Defaults to `true`.
	 */
	summarizeUndone?: boolean;
	/**
	 * How many calls to the model one run may make before it fails. Defaults to 65, with no upper
	 * bound. A run that asks for exactly the same tool calls 5 times in a row fails before that.
	 */
	maxSteps?: number;
	/**
	 * Runs every tool call without asking, `destructive` ones included, for CI where no one can
	 * answer. Without it, a `destructive` call goes to the run's `approve`, or is denied.
	 */
	autoApprove?: boolean;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}

/** A limit per role of `createLLMOrchestrator`; a role left out keeps its default. */
export type RoleSteps = Partial<Record<OrchestratorRole, number>>;

// The same three roles a command can be given to.
type OrchestratorRole = CommandRole;

// The executor reads, edits and checks, so it needs more calls than the roles that only read.
const defaultRoleSteps: Record<OrchestratorRole, number> = {
	planner: 65,
	executor: 80,
	reviewer: 65,
};

/**
 * Each role's step limit, from one number for all of them or a number per role.
 *
 * @throws {InvalidAgentConfigError} for a role that does not exist, which is a typo that would
 * otherwise leave that role on its default without a word.
 */
function stepsPerRole(maxSteps: number | RoleSteps | undefined): Record<OrchestratorRole, number> {
	if (maxSteps === undefined) return defaultRoleSteps;
	if (typeof maxSteps === 'number') {
		return { planner: maxSteps, executor: maxSteps, reviewer: maxSteps };
	}
	const unknown = Object.keys(maxSteps).filter(role => !(role in defaultRoleSteps));
	if (unknown.length > 0) {
		throw new InvalidAgentConfigError(
			`maxSteps names roles that do not exist: ${unknown.join(', ')}; expected planner, executor or reviewer`,
		);
	}
	// A role given as `undefined`, which untyped input can do, keeps its default.
	const given = Object.entries(maxSteps as Record<string, unknown>).filter(
		([, steps]) => steps !== undefined,
	);
	return { ...defaultRoleSteps, ...Object.fromEntries(given) };
}

export interface CreateLLMOrchestratorOptions extends CreateOrchestratorOptions {
	/**
	 * The folders the agents work on. The executor changes files only in a `write` root, every
	 * change recorded in the workspace's history. Defaults to the current working directory,
	 * read only.
	 */
	workspace?: WorkspaceOptions;
	/**
	 * How many calls to the model one run of each role may make: one number for every role, or a
	 * number per role. Defaults to 80 for the executor and 65 for the planner and the reviewer,
	 * with no upper bound. A run that asks for exactly the same tool calls 5 times in a row fails
	 * before its limit.
	 */
	maxSteps?: number | RoleSteps;
	/**
	 * Commands the roles may run, such as the project's tests, through `runCommand`. Each goes to
	 * the roles its `roles` names, the executor by default. See `createFileTools`. Each needs a
	 * `write` root to run in.
	 */
	commands?: Commands;
	/**
	 * A summary of what the user undid, from the planner's provider's cheap model, for every
	 * role. See `CreateLLMAgentOptions.summarizeUndone`. Defaults to `true`.
	 */
	summarizeUndone?: boolean;
}

const defaultLLMAgentModels = {
	anthropic: 'sonnet',
	openai: 'gpt-5.6-luna',
} as const satisfies Record<AgentProvider, AgentModel>;

function unknownProvider(provider: never): InvalidAgentConfigError {
	return new InvalidAgentConfigError(
		`"${String(provider)}" is not an agent provider; expected one of: ${agentProviders.join(', ')}`,
	);
}

function llmClientFor(
	provider: AgentProvider,
	{
		model,
		reasoningEffort,
		systemPrompt,
		logger,
	}: {
		model?: AgentModel;
		reasoningEffort?: ReasoningEffort;
		systemPrompt: string;
		logger: ILogger;
	},
): LLMClient {
	switch (provider) {
		case 'anthropic':
			return new ClaudeLLMClient({
				model: model ?? defaultLLMAgentModels.anthropic,
				reasoningEffort,
				systemPrompt,
				logger,
			});
		case 'openai':
			return new OpenAILLMClient({
				model: model ?? defaultLLMAgentModels.openai,
				reasoningEffort,
				systemPrompt,
				logger,
			});
		default:
			// Reachable from untyped input.
			throw unknownProvider(provider);
	}
}

/** The provider's cheap model, for the summary of what was undone. */
function summarizerFor(provider: AgentProvider, logger: ILogger): LLMClient {
	return provider === 'anthropic'
		? new ClaudeLLMClient({ model: 'haiku', systemPrompt: '', logger })
		: new OpenAILLMClient({
				model: 'gpt-5.6-luna',
				reasoningEffort: 'high',
				systemPrompt: '',
				logger,
			});
}

/**
 * The workspace's history, opened on first use, so a factory that builds an agent stays
 * synchronous. Every agent and every file tool of one workspace reads the same files on disk.
 */
function historyOf(workspace: WorkspaceOptions): HistoryReader {
	// Checked now: an agent with no root to follow is a setup error, not a first-run one.
	if (workspace.roots.length === 0) {
		throw new InvalidAgentConfigError('A workspace needs at least one root');
	}
	let store: Promise<RecoveryStore> | undefined;
	const open = () => {
		store ??= stateDirectoryOf(workspace)
			.then(directory => openStore(workspace, directory))
			.catch((error: unknown) => {
				// Not kept: the next run tries again, as one whose disk was full for a moment.
				store = undefined;
				throw error;
			});
		return store;
	};
	return {
		listRuns: async () => (await open()).listRuns(),
		listRevisions: async () => (await open()).listRevisions(),
		readRun: async runId => (await open()).readRun(runId),
	};
}

/**
 * What the model is told about the workspace after its instructions: the roots, which it may
 * change, and how to name a file. A host path in an error sends the model looking for it, so
 * the real root is given here once.
 */
function workspaceGuidance(roots: WorkspaceRoot[]): string {
	const [first, ...others] = roots.map(root => ({ ...root, path: resolve(root.path) }));
	if (!first) return '';
	const described = [first, ...others].map(
		({ path, access }) => `- ${path}${access === 'write' ? '' : ' (read only)'}`,
	);
	return [
		'The workspace:',
		...described,
		`Name a file by its path relative to ${first.path}, such as src/index.ts, and a file in another folder of the workspace by its full path. Read a file before you change it.`,
	].join('\n');
}

function withGuidance(systemPrompt: string, guidance: string): string {
	return guidance === '' ? systemPrompt : `${systemPrompt}\n\n${guidance}`;
}

/** An `LLMAgent` on `provider`, wrapped in the harness's retry policy. */
function buildLLMAgent(
	provider: AgentProvider,
	{
		model,
		reasoningEffort,
		systemPrompt,
		tools,
		history,
		summarizer,
		maxSteps,
		autoApprove,
		logger,
	}: {
		model?: AgentModel;
		reasoningEffort?: ReasoningEffort;
		systemPrompt: string;
		tools: AgentTool[];
		history?: HistoryReader;
		summarizer?: LLMClient;
		maxSteps?: number;
		autoApprove?: boolean;
		logger: ILogger;
	},
): Agent {
	const llmClient = llmClientFor(provider, { model, reasoningEffort, systemPrompt, logger });
	// LLMAgent records nothing from a failed call, so the original prompt is the whole story.
	return new RetryingAgent({
		inner: new LLMAgent({
			llmClient,
			tools,
			autoApprove,
			logger,
			...(history ? { history } : {}),
			...(summarizer ? { summarizer } : {}),
			...(maxSteps === undefined ? {} : { maxSteps }),
		}),
		logger,
		noteFailures: false,
	});
}

/**
 * Builds an agent whose conversation MiKode owns, on a provider's model API, already wrapped in
 * the harness's retry policy. It needs the provider's API key and bills per token, where
 * `createAgent` uses the Agent SDK's login. Each tool judges the risk of each call; a
 * `destructive` one runs only when the run's `approve` allows it, or with `autoApprove`.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider, a model or reasoning effort its
 * client does not support, or two tools that share a name.
 * @throws {UnrecoverableError} when the client cannot be set up, for example because
 * `OPENAI_API_KEY` is missing. The Anthropic SDK resolves credentials lazily, so a missing
 * `ANTHROPIC_API_KEY` fails the first run instead, with an `UnrecoverableError`.
 */
export function createLLMAgent(
	provider: AgentProvider,
	{
		model,
		reasoningEffort,
		systemPrompt,
		tools = [],
		workspace,
		summarizeUndone = true,
		maxSteps,
		autoApprove,
		logger = new Logger(),
	}: CreateLLMAgentOptions,
): Agent {
	return buildLLMAgent(provider, {
		model,
		reasoningEffort,
		systemPrompt: workspace
			? withGuidance(systemPrompt, workspaceGuidance(workspace.roots))
			: systemPrompt,
		// A file tool is a harness tool under its public name.
		tools: tools as AgentTool[],
		...(workspace ? { history: historyOf(workspace) } : {}),
		...(workspace && summarizeUndone ? { summarizer: summarizerFor(provider, logger) } : {}),
		maxSteps,
		autoApprove,
		logger,
	});
}

/**
 * The file tools for an agent from `createLLMAgent` on `provider`, over `workspace`, in the
 * provider's own format:
 *
 * - OpenAI: `listFiles`, `searchText`, `readFile` and its native `apply_patch`;
 * - Anthropic: `listFiles`, `searchText`, its native text editor, whose `view` reads, and
 *   `delete_file`.
 *
 * Every one goes through the workspace's access policy: a path outside the roots, a secret,
 * a file `.gitignore` excludes or the harness protects is refused. A change is made only in a
 * `write` root, only from a version the agent read, and is recorded in the workspace's history,
 * so it can be undone. Without a `write` root the tools only read. Give the agent the same
 * `workspace`, so it follows what the history undoes.
 *
 * With `commands`, they include `runCommand`, which runs one of them by name, with only the
 * parameters it declares and never through a shell. Each run asks the approver, showing the
 * program exactly as it will run, and gets a small environment without the provider keys. The
 * files of the `write` roots are captured before it and compared after, so what it changed is
 * in the history too. It is trusted execution, not a sandbox: a command can reach whatever
 * this user can. Not supported on Windows yet.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider, a workspace with no root, or an
 * invalid command, including one whose `cwd` is not in a `write` root, or any on Windows.
 * @throws {UnrecoverableError} when no program can read the first root.
 */
export async function createFileTools(
	provider: AgentProvider,
	workspace: WorkspaceOptions,
	{ logger = new Logger(), commands }: { logger?: ILogger; commands?: Commands } = {},
): Promise<FileTool[]> {
	// Reachable from untyped input.
	if (!isAgentProvider(provider)) throw unknownProvider(provider);
	if (commands !== undefined) validateCommands(commands);
	const opened = await openWorkspace(workspace, logger);
	return (await executorTools(provider, opened, commands)) as unknown as FileTool[];
}

/** The executor's file tools, and `runCommand` when there are commands. */
async function executorTools(
	provider: AgentProvider,
	workspace: OpenedWorkspace,
	commands: Commands | undefined,
): Promise<AgentTool[]> {
	const tools = fileToolsFor(provider, workspace);
	// Every command may belong to other roles, leaving none for this one.
	if (commands === undefined || Object.keys(commands).length === 0) return tools;
	return [...tools, await commandToolFor(workspace, commands)];
}

/**
 * What the planner and the reviewer read with: no edits, the current task's changes, and the
 * commands given to their role.
 */
async function readingTools(
	workspace: OpenedWorkspace,
	role: CommandRole,
	commands: Commands | undefined,
): Promise<AgentTool[]> {
	const { read, policy, store } = workspace;
	const finding = createWorkspaceTools(read).filter(tool => tool.name !== 'readFile');
	const tools = [
		...finding,
		createTrackedReadFile(policy),
		createShowChangesTool({ store, policy }),
	];
	const own = commands && commandsFor(commands, role);
	if (!own || Object.keys(own).length === 0) return tools;
	return [...tools, await commandToolFor(workspace, own)];
}

// Sent after the workspace's roots, so it stays short: it only says how to find one's way
// around the repository without reading all of it.
const repositoryGuidance =
	'Start with AGENTS.md and the architecture document it links to learn where things live, then read only the files your task needs. When you know you need several files, or several searches, ask for all of them in one answer rather than one at a time: each answer is a step, and steps are limited.';

/**
 * Builds the planner → executor → reviewer workflow with every role on the model APIs, each
 * holding its role's instructions, or `systemPrompts`, as its system prompt, followed by the
 * workspace's roots.
 *
 * - The planner and the reviewer read: `listFiles`, `searchText`, `readFile`, and
 *   `showChanges`, the current task's changes as far as each may read them.
 * - The executor gets its provider's file tools (see `createFileTools`), and changes files only
 *   in a `write` root; `autoApprove` reaches only it.
 * - Each role has its own step limit: `maxSteps`, 80 for the executor and 65 for the others by
 *   default.
 * - Each role gets `runCommand` with the `commands` whose `roles` name it, the executor by
 *   default. A command asks the approver in any role, and its files are captured around it.
 *
 * One run of the orchestrator is one run of the workspace's history, every round and retry
 * included, and its `AgentResponse` names it. Every role follows what the user undoes.
 * Asynchronous because opening the workspace is.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider, or a workspace with no root.
 * @throws {UnrecoverableError} when a role cannot be set up, for example because
 * `OPENAI_API_KEY` is missing, or when no program can read the repository.
 */
export async function createLLMOrchestrator({
	provider,
	autoApprove,
	systemPrompts = {},
	workspace = { roots: [{ path: process.cwd(), access: 'read' }] },
	maxSteps,
	commands,
	summarizeUndone = true,
	logger = new Logger(),
}: CreateLLMOrchestratorOptions = {}): Promise<Agent> {
	const roles = orchestratorRolesFor(provider);
	const steps = stepsPerRole(maxSteps);
	const opened = await openWorkspace(workspace, logger);
	const guidance = workspaceGuidance(workspace.roots);
	const summarizer = summarizeUndone ? summarizerFor(roles.planner.provider, logger) : undefined;
	const shared = { history: opened.store, ...(summarizer ? { summarizer } : {}), logger };
	// A caller's own prompt replaces our instructions and guidance, not the workspace: the model
	// needs the roots to name a file, as `createLLMAgent` gives them.
	const prompt = (own: string | undefined, instructions: string) =>
		own === undefined
			? withGuidance(instructions, `${guidance}\n${repositoryGuidance}`)
			: withGuidance(own, guidance);
	// Every command, checked once, before any role takes its share.
	if (commands !== undefined) validateCommands(commands);
	const reader = async (
		{ provider, model, reasoningEffort }: Role,
		role: CommandRole,
		systemPrompt: string,
	) =>
		buildLLMAgent(provider, {
			model,
			reasoningEffort,
			systemPrompt,
			tools: await readingTools(opened, role, commands),
			maxSteps: steps[role],
			...shared,
		});
	const { executor } = roles;

	return new OrchestratorAgent({
		plannerAgent: await reader(
			roles.planner,
			'planner',
			prompt(systemPrompts.planner, plannerInstructions),
		),
		executorAgent: buildLLMAgent(executor.provider, {
			model: executor.model,
			reasoningEffort: executor.reasoningEffort,
			systemPrompt: prompt(systemPrompts.executor, executorInstructions),
			tools: await executorTools(
				executor.provider,
				opened,
				commands && commandsFor(commands, 'executor'),
			),
			maxSteps: steps.executor,
			autoApprove,
			...shared,
		}),
		reviewerAgent: await reader(
			roles.reviewer,
			'reviewer',
			prompt(systemPrompts.reviewer, reviewerInstructions),
		),
		reviewerDecisionValidator: new ReviewerDecisionValidator(),
		logger,
	});
}
