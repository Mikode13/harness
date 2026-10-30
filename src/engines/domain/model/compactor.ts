import type { ContextTriage } from '#src/llm/domain/contextTriage';

/**
 * How an `LLMAgent` keeps its context within the model: the conversation always keeps every part,
 * and only the context sent to the model is compacted. Internal: the harness's compactors are the
 * only ones.
 *
 * The provider's compactor hands its threshold to the client, and the provider compacts inside
 * the call that passes it, answering with its own summary first.
 */
export interface ProviderCompactor {
	readonly by: 'provider';
	/**
	 * The tokens of context at which the provider compacts it, or `undefined` when compaction is
	 * off. A context that no longer fits the model is compacted once all the same.
	 */
	readonly at: number | undefined;
}

/**
 * The harness's compactor: once the context passes `at`, before the next call, the agent's own
 * model summarizes it, and what is kept follows the summary word for word. Without a `triage`,
 * the recent compactor keeps the run's prompt and the run's last `keptSteps` answers of the
 * model, each with its tool results.
 */
export interface RecentCompactor {
	readonly by: 'harness';
	/** As `ProviderCompactor.at`. */
	readonly at: number | undefined;
	readonly keptSteps: number;
	/**
	 * Jev's: it keeps the run's prompt, the model's last answer with its tool results, and each
	 * earlier tool result the triage scores `keptScore` or more, with its call. When the triage
	 * fails, the recent compactor chooses instead.
	 */
	readonly triage?: ContextTriage;
}

export type Compactor = ProviderCompactor | RecentCompactor;

/** The provider's compactor, off: only a context that no longer fits is compacted. */
export const compactionOff: Compactor = { by: 'provider', at: undefined };

/** How many answers of the model, with their tool results, the recent compactor keeps. */
export const recentKeptSteps = 10;
