/** Narrows untyped input, such as a CLI flag, to one of a fixed set of string literals. */
export function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
	return (values as readonly string[]).includes(value);
}
