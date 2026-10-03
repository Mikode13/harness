import type { Agent } from '#src/agent/domain/agent';
import { InvalidAgentConfigError } from '#src/agent/domain/errors';
import { LLMAgent } from '#src/engines/domain/model/llmAgent';
import type { LLMClient } from '#src/llm/domain/llm';
import { ClaudeLLMClient } from '#src/llm/infrastructure/claudeLLMClient';
import { OpenAILLMClient } from '#src/llm/infrastructure/openAILLMClient';
import { InstructedAgent } from '#src/orchestration/domain/model/instructedAgent';
import {
	executorInstructions,
	OrchestratorAgent,
	plannerInstructions,
	reviewerInstructions,
} from '#src/orchestration/domain/model/orchestratorAgent';
import { ReviewerDecisionValidator } from '#src/orchestration/infrastructure/model/reviewerDecisionValidator';
import { RetryingAgent } from '#src/retry/domain/model/retryingAgent';
import type { ILogger } from '#src/shared/domain/logger';
import { Logger } from '#src/shared/infrastructure/logger';
import type { Tool } from '#src/tools/domain/tool';
import { createWorkspace } from '#src/tools/infrastructure/createWorkspace';
import { createWorkspaceTools } from '#src/tools/infrastructure/workspaceTools';
import { createAgent, orchestratorRolesFor, type Role } from './agentFactory.ts';
import {
	agentProviders,
	type AgentModel,
	type AgentProvider,
	type CreateOrchestratorOptions,
	type ReasoningEffort,
} from './types.ts';

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
	/** The tools the model may call. Defaults to none. */
	tools?: Tool[];
	/**
	 * Runs every tool call without asking, `destructive` ones included, for CI where no one can
	 * answer. Without it, a `destructive` call goes to the run's `approve`, or is denied.
	 */
	autoApprove?: boolean;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}

const defaultLLMAgentModels = {
	anthropic: 'sonnet',
	openai: 'gpt-5.6-luna',
} as const satisfies Record<AgentProvider, AgentModel>;

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
		tools,
		autoApprove,
		logger = new Logger(),
	}: CreateLLMAgentOptions,
): Agent {
	let llmClient: LLMClient;

	switch (provider) {
		case 'anthropic':
			llmClient = new ClaudeLLMClient({
				model: model ?? defaultLLMAgentModels.anthropic,
				reasoningEffort,
				systemPrompt,
				logger,
			});
			break;
		case 'openai':
			llmClient = new OpenAILLMClient({
				model: model ?? defaultLLMAgentModels.openai,
				reasoningEffort,
				systemPrompt,
				logger,
			});
			break;
		default: {
			// Reachable from untyped input.
			const unknownProvider: never = provider;
			throw new InvalidAgentConfigError(
				`"${String(unknownProvider)}" is not an agent provider; expected one of: ${agentProviders.join(', ')}`,
			);
		}
	}

	// LLMAgent records nothing from a failed call, so the original prompt is the whole story.
	return new RetryingAgent({
		inner: new LLMAgent({ llmClient, tools, autoApprove }),
		logger,
		noteFailures: false,
	});
}

// Sent on every call after the role's instructions, so it stays short: it only says how to find
// one's way around the repository without reading all of it.
const repositoryGuidance =
	'Paths are relative to the repository root. Start with AGENTS.md and the architecture document it links to learn where things live, then read only the files your task needs.';

/**
 * Builds the planner → executor → reviewer workflow with the planner and reviewer on the model
 * APIs, from `createLLMAgent`, each holding its role's instructions, or `systemPrompts`, as its
 * system prompt, with the read-only repository tools for the current working directory. The
 * executor stays on its Agent SDK, from `createAgent`, until an agent of ours can change files;
 * `autoApprove` reaches only it. Asynchronous because finding the program that reads the
 * repository is.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider.
 * @throws {UnrecoverableError} when a role cannot be set up, for example because
 * `OPENAI_API_KEY` or the Codex CLI binary is missing, or when no program can read the
 * repository.
 */
export async function createLLMOrchestrator({
	provider,
	autoApprove,
	systemPrompts = {},
	logger = new Logger(),
}: CreateOrchestratorOptions = {}): Promise<Agent> {
	const roles = orchestratorRolesFor(provider);
	const tools = createWorkspaceTools(await createWorkspace({ root: process.cwd(), logger }));
	const llmAgentFor = ({ provider, model, reasoningEffort }: Role, systemPrompt: string) =>
		createLLMAgent(provider, { model, reasoningEffort, systemPrompt, tools, logger });
	// A caller's own prompt replaces the whole of ours, guidance included.
	const withGuidance = (instructions: string) => `${instructions}\n\n${repositoryGuidance}`;

	return new OrchestratorAgent({
		plannerAgent: llmAgentFor(
			roles.planner,
			systemPrompts.planner ?? withGuidance(plannerInstructions),
		),
		executorAgent: new InstructedAgent({
			inner: createAgent(roles.executor.provider, {
				model: roles.executor.model,
				reasoningEffort: roles.executor.reasoningEffort,
				autoApprove,
				logger,
			}),
			instructions: systemPrompts.executor ?? executorInstructions,
		}),
		reviewerAgent: llmAgentFor(
			roles.reviewer,
			systemPrompts.reviewer ?? withGuidance(reviewerInstructions),
		),
		reviewerDecisionValidator: new ReviewerDecisionValidator(),
		logger,
	});
}
