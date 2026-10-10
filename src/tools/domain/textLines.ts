/**
 * A text as lines, with what it takes to write it back the same way: an edit keeps a file's CRLF
 * endings, and its final newline or lack of one.
 */
export interface Lines {
	lines: string[];
	eol: '\n' | '\r\n';
	finalNewline: boolean;
}

export function splitLines(text: string): Lines {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	if (text === '') return { lines: [], eol, finalNewline: false };
	const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
	const finalNewline = lines.at(-1) === '';
	if (finalNewline) lines.pop();
	return { lines, eol, finalNewline };
}

export function joinLines({ lines, eol, finalNewline }: Lines): string {
	if (lines.length === 0) return '';
	return lines.join(eol) + (finalNewline ? eol : '');
}
