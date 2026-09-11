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

	return new RecoverableError(context, { cause: describeFailure(error) });
}

/** A host failure cannot be retried safely because the provider turn may already have side effects. */
export function classifyHostFailure(error: unknown, context: string): Error {
	if (isAbortError(error)) return error;
	if (error instanceof UnrecoverableError) return error;

	return new UnrecoverableError(context, { cause: describeFailure(error) });
}

/**
 * Runs host code — a logger, for example — and classifies whatever it throws with the
 * classifier the caller chooses. The host code stays unaware of classification, and the
 * failure cannot escape the `Agent` unclassified.
 */
export function treatErrors<T>(
	operation: () => T,
	classify: (error: unknown, context: string) => Error,
	context: string,
): T {
	try {
		return operation();
	} catch (error) {
		throw classify(error, context);
	}
}

/** Preserves deliberate domain errors while making unexpected local failures fatal. */
export function classifyLocalFailure(error: unknown, context: string): Error {
	if (isAbortError(error)) return error;
	if (error instanceof RecoverableError || error instanceof UnrecoverableError) return error;

	return new UnrecoverableError(context, { cause: describeFailure(error) });
}

/** The message alone: a stack or serialized object could expose unstable implementation details. */
export function describeFailure(error: unknown): string {
	if (error instanceof RecoverableError || error instanceof UnrecoverableError) return error.cause;
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
	let events: AsyncIterator<T>;

	try {
		events = stream[Symbol.asyncIterator]();
	} catch (error) {
		throw classifyProviderFailure(error, context);
	}

	let completed = false;

	try {
		for (;;) {
			let next: IteratorResult<T>;

			try {
				next = await events.next();
			} catch (error) {
				throw classifyProviderFailure(error, context);
			}

			if (next.done) {
				completed = true;
				return;
			}

			yield next.value;
		}
	} finally {
		if (!completed) {
			try {
				await events.return?.();
			} catch {
				// Cleanup is secondary to the failure that interrupted consumption. It must
				// never replace a classified provider error or an unrecoverable host error.
			}
		}
	}
}
