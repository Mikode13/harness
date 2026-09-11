export class RecoverableError extends Error {
	override cause: string;

	constructor(message: string, options: { cause: string }) {
		super(message, options);
		this.cause = options.cause;
	}
}
export class UnrecoverableError extends Error {
	override cause: string;

	constructor(message: string, options: { cause: string }) {
		super(message, options);
		this.cause = options.cause;
	}
}

/**
 * An agent was requested with something its provider does not support, such as another
 * provider's model. Thrown while the agent is built, never by `run()`.
 */
export class InvalidAgentConfigError extends Error {}
