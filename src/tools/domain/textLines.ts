/** One line of a text, and the ending it had: a file may mix `\n` and `\r\n`. */
export interface Line {
	text: string;
	end: '' | '\n' | '\r\n';
}

/**
 * A text as lines, each with its own ending, so an edit writes back every line it did not touch
 * exactly as it was. `eol` is the ending most lines have, for lines that have none of their own.
 */
export interface TextLines {
	lines: Line[];
	eol: '\n' | '\r\n';
	finalNewline: boolean;
}

export function splitLines(text: string): TextLines {
	const lines: Line[] = [];
	let crlf = 0;
	let lf = 0;
	let start = 0;
	for (const match of text.matchAll(/\r?\n/g)) {
		const end = match[0] as '\n' | '\r\n';
		if (end === '\r\n') crlf++;
		else lf++;
		lines.push({ text: text.slice(start, match.index), end });
		start = match.index + end.length;
	}
	if (start < text.length) lines.push({ text: text.slice(start), end: '' });
	return { lines, eol: crlf > lf ? '\r\n' : '\n', finalNewline: text.endsWith('\n') };
}

export function textsOf(lines: Line[]): string[] {
	return lines.map(line => line.text);
}

/**
 * A line an edit adds, with the ending of the line before it, so it reads like its neighbours;
 * the text's usual ending when there is none.
 */
export function addedLine(text: string, before: Line | undefined, eol: TextLines['eol']): Line {
	// A line with no ending, the last one, lends none.
	const end = before?.end ?? '';
	return { text, end: end === '' ? eol : end };
}

/**
 * The text again. A line that gained a line after it gets an ending if it had none; the last line
 * ends as the text's last line did, with a newline or without.
 */
export function joinLines({ lines, eol, finalNewline }: TextLines): string {
	return lines
		.map((line, index) => {
			if (index < lines.length - 1) return line.text + (line.end || eol);
			return line.text + (finalNewline ? line.end || eol : '');
		})
		.join('');
}
