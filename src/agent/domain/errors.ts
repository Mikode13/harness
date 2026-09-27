import { addTokens, type Tokens } from '../../shared/domain/tokens.ts';

interface ClassifiedErrorOptions {
	cause: string;
	/** What the run spent before it failed, when anything was reported. */
	tokens?: Tokens | undefined;
}

export class RecoverableError extends Error {
	override cause: string;
	readonly tokens: Tokens | undefined;

	constructor(message: string, options: ClassifiedErrorOptions) {
		super(message, options);
		this.cause = options.cause;
		this.tokens = options.tokens;
	}
}
export class UnrecoverableError extends Error {
	override cause: string;
	readonly tokens: Tokens | undefined;

	constructor(message: string, options: ClassifiedErrorOptions) {
		super(message, options);
		this.cause = options.cause;
		this.tokens = options.tokens;
	}
}

/**
 * The same failure, also carrying `spent`: what an outer layer spent before the failure
 * reached it, such as earlier attempts or earlier roles. A cancellation or an unclassified
 * failure is returned unchanged: neither can carry tokens.
 */
export function withSpentTokens(error: unknown, spent: Tokens | undefined): unknown {
	if (!spent || !(error instanceof RecoverableError || error instanceof UnrecoverableError)) {
		return error;
	}

	return withTokens(error, addTokens(error.tokens, spent));
}

/**
 * The same failure with its tokens replaced, for example by `undefined` once the run's total
 * is unknown. It is a new instance of the same class, so a subclass such as `MaxContextError`
 * keeps its meaning. A cancellation or an unclassified failure is returned unchanged.
 */
export function withTokens(error: unknown, tokens: Tokens | undefined): unknown {
	if (!(error instanceof RecoverableError || error instanceof UnrecoverableError)) return error;

	const ErrorClass = error.constructor as new (
		message: string,
		options: ClassifiedErrorOptions,
	) => RecoverableError | UnrecoverableError;
	const copy = new ErrorClass(error.message, { cause: error.cause, tokens });
	// The trace should point at where the failure happened, not at the layer that counted it.
	copy.stack = error.stack;
	return copy;
}

/**
 * An agent was requested with something its provider does not support, such as another
 * provider's model. Thrown while the agent is built, never by `run()`.
 */
export class InvalidAgentConfigError extends Error {}
