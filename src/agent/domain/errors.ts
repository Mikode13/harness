import { addTokens, type Tokens } from '#src/shared/domain/tokens';

interface ClassifiedErrorOptions {
	cause: string;
	/** What the run spent before it failed, as far as it was reported. */
	tokens?: Tokens | undefined;
	/**
	 * A provider answered at least one call of the run without reporting its usage, so
	 * `tokens` would be a subtotal. A failure that never got an answer, such as a dropped
	 * connection, leaves it unset: it adds nothing that could be missing.
	 */
	usageUnreported?: boolean | undefined;
}

export class RecoverableError extends Error {
	override cause: string;
	/** Missing when nothing was reported, and always missing when `usageUnreported` is set. */
	readonly tokens: Tokens | undefined;
	readonly usageUnreported: boolean;

	constructor(message: string, options: ClassifiedErrorOptions) {
		super(message, options);
		this.cause = options.cause;
		this.usageUnreported = options.usageUnreported ?? false;
		// A subtotal must not pass for the run's total.
		this.tokens = this.usageUnreported ? undefined : options.tokens;
	}
}
export class UnrecoverableError extends Error {
	override cause: string;
	/** Missing when nothing was reported, and always missing when `usageUnreported` is set. */
	readonly tokens: Tokens | undefined;
	readonly usageUnreported: boolean;

	constructor(message: string, options: ClassifiedErrorOptions) {
		super(message, options);
		this.cause = options.cause;
		this.usageUnreported = options.usageUnreported ?? false;
		// A subtotal must not pass for the run's total.
		this.tokens = this.usageUnreported ? undefined : options.tokens;
	}
}

/**
 * The same failure, also carrying what an outer layer spent before the failure reached it,
 * such as earlier attempts or earlier roles, or the call the failure came from. `unreported`
 * says that some of it was answered without usage. It is a new instance of the same class, so
 * a subclass such as `MaxContextError` keeps its meaning. A cancellation or an unclassified
 * failure is returned unchanged: neither can carry tokens.
 */
export function withSpentTokens(
	error: unknown,
	spent: Tokens | undefined,
	unreported = false,
): unknown {
	if (!(error instanceof RecoverableError || error instanceof UnrecoverableError)) return error;
	if (!spent && !unreported) return error;

	const ErrorClass = error.constructor as new (
		message: string,
		options: ClassifiedErrorOptions,
	) => RecoverableError | UnrecoverableError;
	const copy = new ErrorClass(error.message, {
		cause: error.cause,
		tokens: addTokens(error.tokens, spent),
		usageUnreported: error.usageUnreported || unreported,
	});
	// The trace should point at where the failure happened, not at the layer that counted it.
	copy.stack = error.stack;
	return copy;
}

/**
 * An agent was requested with something its provider does not support, such as another
 * provider's model. Thrown while the agent is built, never by `run()`.
 */
export class InvalidAgentConfigError extends Error {}
