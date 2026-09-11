import type { Agent } from '../../agent/domain/agent.ts';
import { InvalidAgentConfigError } from '../../agent/domain/errors.ts';
import {
	ClaudeAgent,
	type ClaudeModel,
	type ClaudeReasoningEffort,
} from '../../engines/claude/infrastructure/model/claudeAgent.ts';
import {
	CodexAgent,
	type CodexModel,
	type CodexReasoningEffort,
} from '../../engines/codex/infrastructure/model/codexAgent.ts';
import { OrchestratorAgent } from '../../orchestration/domain/model/orchestratorAgent.ts';
import { ReviewerDecisionValidator } from '../../orchestration/infrastructure/model/reviewerDecisionValidator.ts';
import { RetryingAgent } from '../../retry/domain/model/retryingAgent.ts';
import { isOneOf } from '../../shared/domain/isOneOf.ts';
import type { ILogger } from '../../shared/domain/logger.ts';
import { Logger } from '../../shared/infrastructure/logger.ts';

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
