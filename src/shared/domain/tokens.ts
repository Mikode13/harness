/**
 * Token counts split into the categories providers bill separately. The fields never
 * overlap: the prompt the model read is `inputTokens + readCacheTokens + writtenCacheTokens`.
 * Each engine converts its provider's counters to this meaning, because providers disagree
 * on whether cached tokens are part of their own input count.
 *
 * These are counts, not a cost. Pricing is out of scope: a run's tokens are not attributed
 * to the model that spent them, and cache writes with different lifetimes share one field.
 */
export interface Tokens {
	/** Prompt tokens neither read from nor written to the cache. */
	inputTokens: number;
	/** Prompt tokens read from the provider's prompt cache. */
	readCacheTokens: number;
	/** Prompt tokens written to the prompt cache by this call. */
	writtenCacheTokens: number;
	/** Every generated token, reasoning included. */
	outputTokens: number;
}
