/** Turns a model's parsed answer into the typed value a caller needs, or `undefined` when it does not fit. */
export interface Validator<T> {
	validate(input: unknown): T | undefined;
}
