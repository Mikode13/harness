import type { Agent } from '#src/agent/domain/agent';
import { InvalidAgentConfigError } from '#src/agent/domain/errors';
import {
	ClaudeAgent,
	type ClaudeModel,
	type ClaudeReasoningEffort,
} from '#src/engines/claude/infrastructure/model/claudeAgent';
import {
	CodexAgent,
	type CodexModel,
	type CodexReasoningEffort,
} from '#src/engines/codex/infrastructure/model/codexAgent';
import { LLMAgent } from '#src/engines/domain/model/llmAgent';
import type { LLMClient } from '#src/llm/domain/llm';
import { ClaudeLLMClient, type ClaudeLLMModel } from '#src/llm/infrastructure/claudeLLMClient';
import { OpenAILLMClient, type OpenAIModel } from '#src/llm/infrastructure/openAILLMClient';
import { OrchestratorAgent } from '#src/orchestration/domain/model/orchestratorAgent';
import { ReviewerDecisionValidator } from '#src/orchestration/infrastructure/model/reviewerDecisionValidator';
import { RetryingAgent } from '#src/retry/domain/model/retryingAgent';
import { isOneOf } from '#src/shared/domain/isOneOf';
import type { ILogger } from '#src/shared/domain/logger';
import { Logger } from '#src/shared/infrastructure/logger';

export const agentProviders = ['claude', 'codex'] as const;
export type AgentProvider = (typeof agentProviders)[number];

/** Any provider's model. The engine the provider selects rejects one it does not support. */
export type AgentModel = ClaudeModel | CodexModel;
/** Any provider's reasoning effort. The engine the provider selects rejects one it does not support. */
export type ReasoningEffort = ClaudeReasoningEffort | CodexReasoningEffort;

export function isAgentProvider(value: string): value is AgentProvider {
	return isOneOf(agentProviders, value);
}

export interface CreateAgentOptions {
	/** Defaults to `'opus'` on Claude and `'gpt-5.6-sol'` on Codex. */
	model?: AgentModel;
	/** Defaults to `'high'`. */
	reasoningEffort?: ReasoningEffort;
	/** Maps to the provider's permission-bypass mode. Defaults to `false`. */
	autoApprove?: boolean;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}

const defaultModels = {
	claude: 'opus',
	codex: 'gpt-5.6-sol',
} as const satisfies Record<AgentProvider, AgentModel>;

/**
 * Builds the agent for a provider, already wrapped in the harness's retry policy.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider, or a model or reasoning effort
 * the provider does not support.
 * @throws {UnrecoverableError} when Codex cannot be set up, for example because its CLI binary
 * is missing.
 */
export function createAgent(
	provider: AgentProvider,
	{ model, reasoningEffort, autoApprove, logger = new Logger() }: CreateAgentOptions = {},
): Agent {
	let engine: Agent;

	switch (provider) {
		case 'claude':
			engine = new ClaudeAgent({
				model: model ?? defaultModels.claude,
				reasoningEffort,
				autoApprove,
				logger,
			});
			break;
		case 'codex':
			engine = new CodexAgent({
				model: model ?? defaultModels.codex,
				reasoningEffort,
				autoApprove,
				logger,
			});
			break;
		default: {
			// Reachable from untyped input that skipped `isAgentProvider`.
			const unknownProvider: never = provider;
			throw new InvalidAgentConfigError(
				`"${String(unknownProvider)}" is not an agent provider; expected one of: ${agentProviders.join(', ')}`,
			);
		}
	}

	return new RetryingAgent({ inner: engine, logger });
}

export interface CreateOrchestratorOptions {
	/**
	 * Runs every role on one provider, for example when the other one is out of quota. By
	 * default Codex plans and executes, and Claude reviews.
	 */
	provider?: AgentProvider;
	/** Maps to each provider's permission-bypass mode. Defaults to `false`. */
	autoApprove?: boolean;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}

interface Role {
	provider: AgentProvider;
	model: AgentModel;
	reasoningEffort: ReasoningEffort;
}

// A stronger model plans and reviews; a cheaper one executes the plan.
const orchestratorRoles = {
	default: {
		planner: { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
		executor: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
		reviewer: { provider: 'claude', model: 'opus', reasoningEffort: 'high' },
	},
	claude: {
		planner: { provider: 'claude', model: 'opus', reasoningEffort: 'high' },
		executor: { provider: 'claude', model: 'sonnet', reasoningEffort: 'xhigh' },
		reviewer: { provider: 'claude', model: 'opus', reasoningEffort: 'high' },
	},
	codex: {
		planner: { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
		executor: { provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
		reviewer: { provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
	},
} as const satisfies Record<
	AgentProvider | 'default',
	Record<'planner' | 'executor' | 'reviewer', Role>
>;

/**
 * Builds the planner → executor → reviewer workflow, each role an agent from `createAgent`.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider.
 * @throws {UnrecoverableError} when a Codex role cannot be set up, for example because its CLI
 * binary is missing.
 */
export function createOrchestrator({
	provider,
	autoApprove,
	logger = new Logger(),
}: CreateOrchestratorOptions = {}): Agent {
	if (provider !== undefined && !isAgentProvider(provider)) {
		throw new InvalidAgentConfigError(
			`"${String(provider)}" is not an agent provider; expected one of: ${agentProviders.join(', ')}`,
		);
	}

	const roles = orchestratorRoles[provider ?? 'default'];
	const agentFor = ({ provider, model, reasoningEffort }: Role) =>
		createAgent(provider, { model, reasoningEffort, autoApprove, logger });

	return new OrchestratorAgent({
		plannerAgent: agentFor(roles.planner),
		executorAgent: agentFor(roles.executor),
		reviewerAgent: agentFor(roles.reviewer),
		reviewerDecisionValidator: new ReviewerDecisionValidator(),
		logger,
	});
}

export const llmProviders = ['claude', 'openai'] as const;
export type LLMProvider = (typeof llmProviders)[number];

export interface CreateLLMAgentOptions {
	/**
	 * Defaults to `'claude-sonnet-5'` on Claude and `'gpt-5.6-luna'` on OpenAI. The provider's
	 * client rejects a model it does not support.
	 */
	model?: string;
	/** Sent as the model's instructions on every call. */
	systemPrompt: string;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}

const defaultLLMAgentModels = {
	claude: 'claude-sonnet-5' satisfies ClaudeLLMModel,
	openai: 'gpt-5.6-luna' satisfies OpenAIModel,
} as const satisfies Record<LLMProvider, string>;

/**
 * Builds an agent whose conversation MiKode owns, on a provider's model API, already wrapped in
 * the harness's retry policy. Internal while #23 reaches parity with the Agent SDK engines: it
 * is not exported from `src/index.ts`. It runs no tools, so it has no `autoApprove`.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider, or a model its client does not
 * support.
 * @throws {UnrecoverableError} when the client cannot be set up, for example because
 * `OPENAI_API_KEY` is missing. The Anthropic SDK resolves credentials lazily, so a missing
 * `ANTHROPIC_API_KEY` fails the first run instead, with an `UnrecoverableError`.
 */
export function createLLMAgent(
	provider: LLMProvider,
	{ model, systemPrompt, logger = new Logger() }: CreateLLMAgentOptions,
): Agent {
	let llmClient: LLMClient;

	switch (provider) {
		case 'claude':
			llmClient = new ClaudeLLMClient({
				model: model ?? defaultLLMAgentModels.claude,
				systemPrompt,
				logger,
			});
			break;
		case 'openai':
			llmClient = new OpenAILLMClient({
				model: model ?? defaultLLMAgentModels.openai,
				systemPrompt,
				logger,
			});
			break;
		default: {
			// Reachable from untyped input.
			const unknownProvider: never = provider;
			throw new InvalidAgentConfigError(
				`"${String(unknownProvider)}" is not an LLM provider; expected one of: ${llmProviders.join(', ')}`,
			);
		}
	}

	// LLMAgent records nothing from a failed call, so the original prompt is the whole story.
	return new RetryingAgent({ inner: new LLMAgent({ llmClient }), logger, noteFailures: false });
}
