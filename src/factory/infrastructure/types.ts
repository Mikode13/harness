import type {
	ClaudeModel,
	ClaudeReasoningEffort,
} from '#src/engines/claude/infrastructure/model/claudeAgent';
import type {
	CodexModel,
	CodexReasoningEffort,
} from '#src/engines/codex/infrastructure/model/codexAgent';
import type { ILogger } from '#src/shared/domain/logger';

/** Named after the company, not the product: one provider can be reached by an SDK or an API. */
export const agentProviders = ['anthropic', 'openai'] as const;
export type AgentProvider = (typeof agentProviders)[number];

/** Any provider's model. The agent the provider selects rejects one it does not support. */
export type AgentModel = ClaudeModel | CodexModel;
/** Any provider's reasoning effort. The agent the provider selects rejects one it does not support. */
export type ReasoningEffort = ClaudeReasoningEffort | CodexReasoningEffort;

export interface CreateOrchestratorOptions {
	/**
	 * Runs every role on one provider, for example when the other one is out of quota. By
	 * default OpenAI plans and executes, and Anthropic reviews.
	 */
	provider?: AgentProvider;
	/** Maps to each provider's permission-bypass mode. Defaults to `false`. */
	autoApprove?: boolean;
	/** Defaults to warnings on stderr. */
	logger?: ILogger;
}
