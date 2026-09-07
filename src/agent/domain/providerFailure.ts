import { isAbortError } from '../../shared/domain/isAbortError.ts';
import { RecoverableError, UnrecoverableError } from './errors.ts';

/**
 * Unclassified failures are transport-shaped, so recoverable is the useful default:
 * `RetryingAgent` turns a persistent one into an `UnrecoverableError` on exhaustion, while
 * the opposite default would make every transient blip fatal.
 */
export function classifyProviderFailure(error: unknown, context: string): Error {
	if (isAbortError(error)) return error;
	if (error instanceof RecoverableError || error instanceof UnrecoverableError) return error;

	return new RecoverableError(context, { cause: describeProviderFailure(error) });
}

/** The message alone: a stack or a serialized SDK object would leak provider internals. */
export function describeProviderFailure(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === 'string' && error) return error;

	return 'The provider failed without a description.';
}

/**
 * Classifies the stream itself and nothing else. Consuming an SDK stream inside a
 * `try/catch` puts the loop body — item mapping, logging, the consumer callback — inside
 * the provider boundary too, so a host failure gets reported as a recoverable provider
 * failure and `RetryingAgent` replays a turn that already ran its side effects.
 */
export async function* classifiedProviderStream<T>(
	stream: AsyncIterable<T>,
	context: string,
): AsyncGenerator<T> {
	const events = stream[Symbol.asyncIterator]();

	try {
		for (;;) {
			let next: IteratorResult<T>;

			try {
				next = await events.next();
			} catch (error) {
				throw classifyProviderFailure(error, context);
			}

			if (next.done) return;

			yield next.value;
		}
	} finally {
		// The consumer left the loop early — a `break`, or a throw from its own body.
		await events.return?.();
	}
}
