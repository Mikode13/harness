import { unifiedDiff } from '#src/diff/domain/unifiedDiff';

// Enough to place a change without reading the file again.
const contextLines = 2;
// What one response may show: a large rewrite is named, not repeated.
const maxShownLines = 60;
// One minified line can be larger than everything else the model reads.
const maxLineLength = 300;

function cutLine(text: string): string {
	return text.length > maxLineLength ? `${text.slice(0, maxLineLength)}…` : text;
}

function lineCount(text: string): number {
	if (text === '') return 0;
	const lines = text.split(/\r\n|\r|\n/);
	return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/**
 * What a modification returns: its path, then the lines around each change as the file now
 * reads them, numbered, with two lines of context. The model can check its edit without reading
 * the file again. What does not fit is counted, not shown.
 */
export function describeModification(path: string, before: string, after: string): string {
	const shown: string[] = [];
	let hidden = 0;
	let line = 0;
	for (const text of unifiedDiff(before, after, { context: contextLines }).split('\n')) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (hunk) {
			if (shown.length > 0 && shown.length < maxShownLines) shown.push('…');
			line = Number(hunk[1]);
			continue;
		}
		// Removed lines are gone from the file, and git's marker is not a line of it.
		if (!text.startsWith(' ') && !text.startsWith('+')) continue;
		if (shown.length < maxShownLines) shown.push(`${String(line)}: ${cutLine(text.slice(1))}`);
		else hidden++;
		line++;
	}

	const header = `Changed ${path}. It now reads, around the change:`;
	const notice =
		hidden > 0
			? [`[${String(hidden)} more lines of the change are not shown. Read the file to see them.]`]
			: [];
	return [header, ...shown, ...notice].join('\n');
}

/** What a creation returns: a confirmation and the size, not the content the model just sent. */
export function describeCreation(path: string, content: Buffer): string {
	const lines = lineCount(content.toString('utf8'));
	return `Created ${path} (${String(lines)} ${lines === 1 ? 'line' : 'lines'}, ${String(content.length)} bytes).`;
}

export function describeDeletion(path: string): string {
	return `Deleted ${path}.`;
}
