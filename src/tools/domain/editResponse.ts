import { unifiedDiff } from '#src/diff/domain/unifiedDiff';
import { cutLine } from './lineLength.ts';

// Enough to place a change without reading the file again.
const contextLines = 2;
// What one response may show: a large rewrite is named, not repeated.
const maxShownLines = 60;
/** A line of `path` as the model reads it: without the `\r` of a CRLF ending, and not too long. */
function shownLine(path: string, text: string): string {
	return cutLine(path, text.endsWith('\r') ? text.slice(0, -1) : text);
}

function lineCount(text: string): number {
	if (text === '') return 0;
	const lines = text.split('\n');
	return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/**
 * The lines around each change from `before` to `after`, as `after` reads them, numbered, with
 * two lines of context. What does not fit is counted, not shown.
 */
function changedLines(path: string, before: string, after: string): string[] {
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
		if (shown.length < maxShownLines) {
			shown.push(`${String(line)}: ${shownLine(path, text.slice(1))}`);
		} else hidden++;
		line++;
	}
	if (hidden > 0) {
		shown.push(
			`[${String(hidden)} more lines of the change are not shown. Read the file to see them.]`,
		);
	}
	return shown;
}

/**
 * What a modification returns: its path, then the lines around each change as the file now
 * reads them. The model can check its edit without reading the file again.
 */
export function describeModification(path: string, before: string, after: string): string {
	if (after === '') return `Changed ${path}. The file is now empty.`;
	return [
		`Changed ${path}. It now reads, around the change:`,
		...changedLines(path, before, after),
	].join('\n');
}

/**
 * What an edit adds to its response when the formatter rewrote what the model sent: that the file
 * must be read again, and those lines as it now reads them. Nothing when the formatter left the
 * file as written.
 */
export function describeFormatting(path: string, written: string, formatted: string): string {
	if (written === formatted || formatted === '') return '';
	return [
		'',
		'The formatter rewrote some of what you sent, so read the file again before you edit it. Those lines now read:',
		...changedLines(path, written, formatted),
	].join('\n');
}

// What one edit's diff may hold for the person watching; the history keeps the whole change.
const maxDiffLines = 400;

/**
 * An edit as a git-style unified diff, for the person watching it happen. A missing side is a
 * file that did not exist, or no longer does. Too long a diff is cut, and says so.
 */
export function editDiff(
	path: string,
	before: string | undefined,
	after: string | undefined,
): string {
	const lines = [
		`--- ${before === undefined ? '/dev/null' : `a/${path}`}`,
		`+++ ${after === undefined ? '/dev/null' : `b/${path}`}`,
		...unifiedDiff(before ?? '', after ?? '', { context: contextLines }).split('\n'),
	];
	if (lines.length <= maxDiffLines) return lines.join('\n');
	return [
		...lines.slice(0, maxDiffLines),
		`... ${String(lines.length - maxDiffLines)} more lines of the diff not shown`,
	].join('\n');
}

/** What a creation returns: a confirmation and the size, not the content the model just sent. */
export function describeCreation(path: string, content: Buffer): string {
	const lines = lineCount(content.toString('utf8'));
	return `Created ${path} (${String(lines)} ${lines === 1 ? 'line' : 'lines'}, ${String(content.length)} bytes).`;
}

export function describeDeletion(path: string): string {
	return `Deleted ${path}.`;
}
