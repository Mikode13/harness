export interface TextMatch {
	path: string;
	line: number;
	text: string;
}

/**
 * The folder an agent works on, read-only. Every path is relative to its root, written with
 * `/`, and results come sorted. A file `.gitignore` ignores, or a path outside the root, does
 * not exist here: it is never listed, searched or read, whatever scope a query asks for.
 *
 * A binary file is listed, but never searched or read. Every operation stops after a time
 * limit and fails with an error that asks for a narrower query.
 *
 * `total` counts everything the query matched and `truncated` says whether `limit` cut it.
 */
export interface Workspace {
	listFiles(
		query: { path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ files: string[]; total: number; truncated: boolean }>;

	/** `pattern` is a regular expression. A match's `text` is at most 1,000 characters. */
	searchText(
		query: { pattern: string; ignoreCase: boolean; path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ matches: TextMatch[]; total: number; truncated: boolean }>;

	/** `fromLine` starts at 1. */
	readFile(
		query: { path: string; fromLine: number; lineCount: number },
		signal: AbortSignal,
	): Promise<{ lines: string[]; totalLines: number; truncated: boolean }>;
}
