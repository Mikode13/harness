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
 * The harness's compactor without Jev: once the context passes `at`, before the next call, the
 * agent's own model summarizes it, and the run's prompt and the last `keptSteps` answers of the
 * model, each with its tool results, are kept word for word after the summary.
 */
export interface RecentCompactor {
	readonly by: 'harness';
	/** As `ProviderCompactor.at`. */
	readonly at: number | undefined;
	readonly keptSteps: number;
}

export type Compactor = ProviderCompactor | RecentCompactor;

/** The provider's compactor, off: only a context that no longer fits is compacted. */
export const compactionOff: Compactor = { by: 'provider', at: undefined };

/** How many answers of the model, with their tool results, the recent compactor keeps. */
export const recentKeptSteps = 10;
