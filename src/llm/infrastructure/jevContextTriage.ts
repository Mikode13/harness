import { score, TypeSafeClient, type TypeSafeClientConfig } from '@typesafe-ai/sdk';
import type { ContextTriage, TriagedResult } from '#src/llm/domain/contextTriage';
import { UnrecoverableError } from '#src/shared/domain/errors';
import { classifyProviderFailure, describeFailure } from '#src/shared/domain/providerFailure';

/** Pinned, so a new Jev release does not change what the compactor keeps unannounced. */
const jevModel = 'jev-1.14.0';

// Each question is judged with the state alone, which Jev bounds at 32k tokens without its
// slower, less accurate long context: a result is cut well within it.
const outputCharacters = 60_000;
const textCharacters = 8_000;
const inputCharacters = 4_000;

// The public endpoint limits the rate: a context of hundreds of results is triaged a few at once.
const concurrency = 8;

const instructions =
	'An agent works on the task. Its context is being compacted. How much does it need this tool result word for word to go on from its latest answer?';
const criteria = [
	'Not needed again: the work has moved past it.',
	'Its gist is enough: a short summary keeps what matters.',
	'Some exact details matter: names, numbers, paths or lines the agent will reuse.',
	'Needed word for word: the agent is still working on exactly this content.',
] as const;

/**
 * Jev's triage of the context, one request per tool result. The client is created on the first
 * triage, so a missing `TYPESAFE_API_KEY` fails that triage, never the agent's construction.
 */
export class JevContextTriage implements ContextTriage {
	private client: TypeSafeClient | undefined;
	private readonly config: Pick<TypeSafeClientConfig, 'apiKey' | 'fetch' | 'retry' | 'compression'>;

	/** @param config for the tests: the SDK's `apiKey`, `fetch`, `retry` and `compression`. */
	constructor(
		config: Pick<TypeSafeClientConfig, 'apiKey' | 'fetch' | 'retry' | 'compression'> = {},
	) {
		this.config = config;
	}

	async score(
		{
			task,
			latestAnswer,
			results,
		}: { task: string; latestAnswer: string; results: TriagedResult[] },
		signal: AbortSignal,
	): Promise<number[]> {
		const client = this.connect();
		// The first failure stops the requests still to go: the whole triage has failed.
		const failed = new AbortController();
		const requestSignal = AbortSignal.any([signal, failed.signal]);
		const request = async (result: TriagedResult) => {
			try {
				return await client.systemOne(
					{
						model: jevModel,
						state: {
							task: shorten(task, textCharacters),
							latestAnswer: shorten(latestAnswer, textCharacters),
							toolCall: {
								tool: result.tool,
								input: shorten(JSON.stringify(result.input), inputCharacters),
							},
							result: shorten(result.output, outputCharacters),
						},
						questions: { needed: score(instructions, criteria) },
					},
					{ signal: requestSignal },
				);
			} catch (error) {
				failed.abort();
				// The SDK's abort error is not named 'AbortError', so it would pass for a provider failure.
				signal.throwIfAborted();
				throw classifyProviderFailure(error, 'Jev could not triage the context');
			}
		};
		return inPool(results, concurrency, async result => {
			const response = await request(result);
			return response.answers.needed.score;
		});
	}

	private connect(): TypeSafeClient {
		try {
			// Its logger writes to the console, which belongs to the consumer.
			this.client ??= new TypeSafeClient({ ...this.config, logLevel: 'off' });
		} catch (error) {
			throw new UnrecoverableError('Jev is not configured', { cause: describeFailure(error) });
		}
		return this.client;
	}
}

/** `map` over `items`, at most `limit` at once, the results in their order. */
async function inPool<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const worker = async () => {
		for (let index = next++; index < items.length; index = next++) {
			const item = items[index];
			if (item !== undefined) results[index] = await map(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function shorten(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
