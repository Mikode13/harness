import { isAbortError } from '../../shared/domain/isAbortError.ts';
import { RecoverableError, UnrecoverableError } from './errors.ts';

/**
 * Turns anything a provider SDK throws into the classification the `Agent` contract
 * promises, and never returns.
 *
 * Two kinds of throw pass through untouched:
 *
 * - Cancellation. An `AbortError` is not a failure, and every consumer distinguishes it
 *   from one — `RetryingAgent` rethrows it rather than spending an attempt on it. Wrapping
 *   it would turn a deliberate stop into a retried error.
 * - An error the adapter already classified itself, from its own event handling. Rewrapping
 *   would discard a deliberate `UnrecoverableError` into a recoverable one.
 *
 * Everything else is unclassified, which in practice means a transport or SDK-internal
 * failure: a dropped connection, a rejected request, a malformed frame. Those are treated
 * as recoverable, because a retry is the response that helps and `RetryingAgent` converts
 * a persistent one into an `UnrecoverableError` on exhaustion anyway. The reverse default
 * would make every transient network blip fatal.
 */
export function classifyProviderFailure(error: unknown, context: string): never {
	if (isAbortError(error)) throw error;
	if (error instanceof RecoverableError || error instanceof UnrecoverableError) throw error;

	throw new RecoverableError(context, { cause: describeProviderFailure(error) });
}

/**
 * A short, stable description. Deliberately the message alone: a stack trace or a
 * serialized SDK object would leak provider internals into a cause that consumers log,
 * compare, and feed back into a retry prompt.
 */
export function describeProviderFailure(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === 'string' && error) return error;

	return 'The provider failed without a description.';
}
