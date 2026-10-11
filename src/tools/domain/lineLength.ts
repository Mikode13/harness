// Code is where one line can be a whole minified bundle, larger than everything else the model
// reads; a line of hand-written code fits well within this.
const codeLineLength = 300;
// Prose keeps a paragraph, or a table row, on one line. Cut, such a line cannot be copied into
// an edit's context, so it is shown whole up to this, which also bounds a generated one.
const proseLineLength = 5000;
const proseExtensions = new Set(['.md', '.markdown', '.mdx', '.txt']);

/**
 * How long a line of `path` may be before the model sees it cut: long for Markdown and plain
 * text, short for everything else. See "Prose files show their long lines whole" in decisions.md.
 */
export function maxLineLength(path: string): number {
	return proseExtensions.has(extensionOf(path)) ? proseLineLength : codeLineLength;
}

/** The extension of the file's own name, lower case: `.md` for `docs/A.MD`, none for `.md`. */
function extensionOf(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** `text` as the model reads it from `path`: cut, with a mark, when longer than the file's limit. */
export function cutLine(path: string, text: string): string {
	const max = maxLineLength(path);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
