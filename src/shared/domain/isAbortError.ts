/** A deliberate stop: an `AbortError`, or the `TimeoutError` that `AbortSignal.timeout` aborts with. */
export function isAbortError(e: unknown): e is Error {
	return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}
