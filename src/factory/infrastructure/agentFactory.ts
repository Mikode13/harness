import type { Agent } from '#src/agent/domain/agent';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import {
	ClaudeAgent,
	claudeModels,
	claudeReasoningEfforts,
} from '#src/engines/claude/infrastructure/model/claudeAgent';
import {
	CodexAgent,
	codexModels,
	codexReasoningEfforts,
} from '#src/engines/codex/infrastructure/model/codexAgent';
import { InstructedAgent } from '#src/orchestration/domain/model/instructedAgent';
import {
	executorInstructions,
	OrchestratorAgent,
	plannerInstructions,
	reviewerInstructions,
} from '#src/orchestration/domain/model/orchestratorAgent';
import { ReviewerDecisionValidator } from '#src/orchestration/infrastructure/model/reviewerDecisionValidator';
import { RetryingAgent } from '#src/retry/domain/model/retryingAgent';
import { isOneOf } from '#src/shared/domain/isOneOf';
import type { ILogger } from '#src/shared/domain/logger';
import { Logger } from '#src/shared/infrastructure/logger';
import {
	agentProviders,
	type AgentModel,
	type AgentProvider,
	type CreateOrchestratorOptions,
	type ReasoningEffort,
} from './types.ts';

export function isAgentProvider(value: string): value is AgentProvider {
	return isOneOf(agentProviders, value);
}

/** The models each provider's Agent SDK accepts. */
export const agentModels = {
	anthropic: claudeModels,
	openai: codexModels,
} as const satisfies Readonly<Record<AgentProvider, readonly AgentModel[]>>;

/** The reasoning efforts each provider's Agent SDK accepts. */
export const agentReasoningEfforts = {
	anthropic: claudeReasoningEfforts,
	openai: codexReasoningEfforts,
} as const satisfies Readonly<Record<AgentProvider, readonly ReasoningEffort[]>>;

/** Narrows a model to one accepted by the selected provider's Agent SDK. */
export function isModelOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is (typeof agentModels)[Provider][number] {
	return isOneOf(agentModels[provider], value);
}

/** Narrows a reasoning effort to one accepted by the selected provider's Agent SDK. */
export function isReasoningEffortOf<Provider extends AgentProvider>(
	provider: Provider,
	value: string,
): value is (typeof agentReasoningEfforts)[Provider][number] {
	return isOneOf(agentReasoningEfforts[provider], value);
}

export interface CreateAgentOptions {
	/** Defaults to `'opus'` on Anthropic and `'gpt-5.6-sol'` on OpenAI. */
	model?: AgentModel;
	/** Defaults to `'high'`. */
	reasoningEffort?: ReasoningEffort;
	/** Maps to the provider's permission-bypass mode. Defaults to `false`. */
	autoApprove?: boolean;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}

const defaultModels = {
	anthropic: 'opus',
	openai: 'gpt-5.6-sol',
} as const satisfies Record<AgentProvider, AgentModel>;

/**
 * Builds the agent for a provider on its Agent SDK — Claude Code for Anthropic, Codex for
 * OpenAI — already wrapped in the harness's retry policy.
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
		case 'anthropic':
			engine = new ClaudeAgent({
				model: model ?? defaultModels.anthropic,
				reasoningEffort,
				autoApprove,
				logger,
			});
			break;
		case 'openai':
			engine = new CodexAgent({
				model: model ?? defaultModels.openai,
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

export interface Role {
	provider: AgentProvider;
	model: AgentModel;
	reasoningEffort: ReasoningEffort;
}

// A stronger model plans and a cheaper one executes the plan, at a higher effort; on Anthropic a
// third model, between the two, reviews it. Every model and effort here is one both the Agent
// SDKs and the model APIs accept, so either path can run a role.
const orchestratorRoles = {
	default: {
		planner: { provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
		executor: { provider: 'openai', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
		reviewer: { provider: 'anthropic', model: 'opus', reasoningEffort: 'high' },
	},
	anthropic: {
		planner: { provider: 'anthropic', model: 'opus', reasoningEffort: 'high' },
		executor: { provider: 'anthropic', model: 'haiku', reasoningEffort: 'xhigh' },
		reviewer: { provider: 'anthropic', model: 'sonnet', reasoningEffort: 'high' },
	},
	openai: {
		planner: { provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
		executor: { provider: 'openai', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
		reviewer: { provider: 'openai', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
	},
} as const satisfies Record<
	AgentProvider | 'default',
	Record<'planner' | 'executor' | 'reviewer', Role>
>;

/**
 * The roles for `provider`, or the default mix without one.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider.
 */
export function orchestratorRolesFor(
	provider: AgentProvider | undefined,
): Record<'planner' | 'executor' | 'reviewer', Role> {
	if (provider !== undefined && !isAgentProvider(provider)) {
		throw new InvalidAgentConfigError(
			`"${String(provider)}" is not an agent provider; expected one of: ${agentProviders.join(', ')}`,
		);
	}

	return orchestratorRoles[provider ?? 'default'];
}

/**
 * Builds the planner → executor → reviewer workflow, each role an agent from `createAgent`.
 *
 * @throws {InvalidAgentConfigError} for an unknown provider.
 * @throws {UnrecoverableError} when an OpenAI role cannot be set up, for example because the
 * Codex CLI binary is missing.
 */
export function createOrchestrator({
	provider,
	autoApprove,
	systemPrompts = {},
	logger = new Logger(),
}: CreateOrchestratorOptions = {}): Agent {
	const roles = orchestratorRolesFor(provider);
	const agentFor = ({ provider, model, reasoningEffort }: Role, instructions: string) =>
		new InstructedAgent({
			inner: createAgent(provider, { model, reasoningEffort, autoApprove, logger }),
			instructions,
		});

	return new OrchestratorAgent({
		plannerAgent: agentFor(roles.planner, systemPrompts.planner ?? plannerInstructions),
		executorAgent: agentFor(roles.executor, systemPrompts.executor ?? executorInstructions),
		reviewerAgent: agentFor(roles.reviewer, systemPrompts.reviewer ?? reviewerInstructions),
		reviewerDecisionValidator: new ReviewerDecisionValidator(),
		logger,
	});
}
