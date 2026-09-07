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
