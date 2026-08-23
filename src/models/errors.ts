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

export function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}
