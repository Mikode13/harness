export class RecoverableError extends Error {}
export class UnrecoverableError extends Error {}

export function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}
