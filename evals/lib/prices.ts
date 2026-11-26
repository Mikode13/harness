import type { Tokens } from '../../src/index.ts';

/**
 * List prices in USD per million tokens, standard tier, as the providers published them on
 * 2026-11-26:
 *
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing. A five-minute cache write
 *   is the `write` price; a cache hit is `cachedInput`. Haiku 5.5 costs more past 100,000 tokens
 *   of prompt, counting cache reads and writes.
 * - OpenAI: https://developers.openai.com/api/docs/pricing. `write` is the 30-minute cache write.
 *   GPT-5.6 Sol's price is promotional until 2026-11-30.
 *
 * A comparison is only fair at the same prices, so each result keeps its tokens by model, and
 * `compare.ts` prices both sides with this table as it is when it compares.
 */
export interface Price {
	input: number;
	cachedInput: number;
	write: number;
	output: number;
	/** Prices past `above` tokens of prompt, for a model that has them. */
	long?: { above: number; input: number; cachedInput: number; write: number; output: number };
}

export const prices: Record<string, Price> = {
	opus: { input: 4, cachedInput: 0.2, write: 5, output: 20 },
	sonnet: { input: 2, cachedInput: 0.1, write: 2.5, output: 10 },
	haiku: {
		input: 0.1,
		cachedInput: 0.01,
		write: 0.125,
		output: 0.5,
		long: { above: 100_000, input: 0.5, cachedInput: 0.05, write: 0.625, output: 2.5 },
	},
	fable: { input: 10, cachedInput: 0.25, write: 12.5, output: 50 },
	'gpt-6-astra': { input: 10, cachedInput: 1, write: 12.5, output: 50 },
	'gpt-5.6-sol': { input: 4, cachedInput: 0.4, write: 5, output: 20 },
	// Its cached price is the 90% discount OpenAI gives GPT-5.6's other models.
	'gpt-5.6-terra': { input: 2, cachedInput: 0.2, write: 2.5, output: 12 },
	'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, write: 0.25, output: 1.2 },
};

const longSuffix = '@long';

/**
 * The key one call's tokens are kept under: its model, or `model@long` for a call priced at the
 * model's long-prompt rates, so tokens summed over many calls can still be priced.
 */
export function priceKey(model: string, tokens: Tokens): string {
	const long = prices[model]?.long;
	const prompt = tokens.inputTokens + tokens.readCacheTokens + tokens.writtenCacheTokens;
	return long && prompt > long.above ? `${model}${longSuffix}` : model;
}

/** What `tokens` kept under `key` cost, or `undefined` for a model the table lacks. */
export function costOfKey(key: string, tokens: Tokens): number | undefined {
	const long = key.endsWith(longSuffix);
	const price = prices[long ? key.slice(0, -longSuffix.length) : key];
	if (price === undefined) return undefined;
	const rate = long ? (price.long ?? price) : price;
	return (
		(tokens.inputTokens * rate.input +
			tokens.readCacheTokens * rate.cachedInput +
			tokens.writtenCacheTokens * rate.write +
			tokens.outputTokens * rate.output) /
		1_000_000
	);
}

/** What tokens kept by key cost in all, or `undefined` when one key's model has no price. */
export function costOfKeys(byKey: Readonly<Record<string, Tokens>>): number | undefined {
	let total = 0;
	for (const [key, tokens] of Object.entries(byKey)) {
		const cost = costOfKey(key, tokens);
		if (cost === undefined) return undefined;
		total += cost;
	}
	return total;
}

/** What `tokens` of one call to `model` cost, or `undefined` for a model the table lacks. */
export function costOf(model: string, tokens: Tokens): number | undefined {
	const price = prices[model];
	if (price === undefined) return undefined;
	const prompt = tokens.inputTokens + tokens.readCacheTokens + tokens.writtenCacheTokens;
	const rate = price.long && prompt > price.long.above ? price.long : price;
	return (
		(tokens.inputTokens * rate.input +
			tokens.readCacheTokens * rate.cachedInput +
			tokens.writtenCacheTokens * rate.write +
			tokens.outputTokens * rate.output) /
		1_000_000
	);
}
