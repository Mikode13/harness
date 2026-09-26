/**
 * Token counts split by how each is billed, so a consumer can price a run by multiplying
 * each field by its own rate. The fields never overlap: the prompt the model read is
 * `inputTokens + readCacheTokens + writtenCacheTokens`. Each engine converts its
 * provider's counters to this meaning, because providers disagree on whether cached
 * tokens are part of their own input count.
 */
export interface Tokens {
	/** Prompt tokens billed at the full input rate: neither read from nor written to the cache. */
	inputTokens: number;
	/** Prompt tokens read from the provider's prompt cache, billed at a discount. */
	readCacheTokens: number;
	/** Prompt tokens written to the prompt cache by this call. */
	writtenCacheTokens: number;
	/** Every generated token, reasoning included. */
	outputTokens: number;
}
