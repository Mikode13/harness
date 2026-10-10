import { EditRefusedError } from './fileEdits.ts';
import { joinLines, splitLines } from './textLines.ts';

// A patch is a few changes, not a file: one far larger is more likely a mistake.
const maxDiffBytes = 512 * 1024;
const maxHunks = 500;
// What an error quotes of a hunk or of the file, to fix the call without flooding the context.
const quotedLines = 8;

/** One line of a hunk: kept as the file has it, removed, or added. */
interface Step {
	kind: 'keep' | 'remove' | 'add';
	text: string;
}

/** One change of a V4A diff: the lines it expects, and the lines it puts in their place. */
interface Hunk {
	/** The text after `@@`, such as a function's first line, found before the change. */
	anchor: string | undefined;
	steps: Step[];
	/** `*** End of File`: the change is at the end of the file. */
	atEnd: boolean;
}

/** The lines a hunk expects in the file: the ones it keeps and the ones it removes. */
function expected(hunk: Hunk): string[] {
	return hunk.steps.filter(step => step.kind !== 'add').map(step => step.text);
}

function changes(hunk: Hunk): boolean {
	return hunk.steps.some(step => step.kind !== 'keep');
}

function checkSize(diff: string, path: string): void {
	if (Buffer.byteLength(diff) > maxDiffBytes) {
		throw new EditRefusedError(
			`The patch for "${path}" is larger than ${String(maxDiffBytes / 1024)} KB; send smaller patches`,
		);
	}
}

/** The diff's lines, without the newline that ends the last one. */
function diffLines(diff: string): string[] {
	const lines = diff.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
	if (lines.at(-1) === '') lines.pop();
	return lines;
}

function parseHunks(diff: string, path: string): Hunk[] {
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;
	for (const [index, line] of diffLines(diff).entries()) {
		if (line.startsWith('@@')) {
			const anchor = line.slice(2).trim();
			// Two `@@` lines in a row name an anchor and then one inside it.
			if (current?.steps.length === 0 && !current.atEnd) {
				current.anchor = [current.anchor, anchor].filter(Boolean).join('\n') || undefined;
				continue;
			}
			current = { anchor: anchor || undefined, steps: [], atEnd: false };
			hunks.push(current);
			continue;
		}
		if (line === '*** End of File') {
			if (current) current.atEnd = true;
			continue;
		}
		// A diff may open with its first change, without `@@`.
		if (!current) {
			current = { anchor: undefined, steps: [], atEnd: false };
			hunks.push(current);
		}
		const marker = line[0];
		const text = line.slice(1);
		// An empty line is an empty context line whose space was trimmed.
		if (line === '' || marker === ' ') {
			current.steps.push({ kind: 'keep', text });
		} else if (marker === '-') {
			current.steps.push({ kind: 'remove', text });
		} else if (marker === '+') {
			current.steps.push({ kind: 'add', text });
		} else {
			throw new EditRefusedError(
				`Line ${String(index + 1)} of the patch for "${path}" starts with "${marker ?? ''}"; each line of a hunk starts with " ", "-" or "+"`,
			);
		}
	}
	const changing = hunks.filter(changes);
	if (changing.length === 0) {
		throw new EditRefusedError(`The patch for "${path}" changes nothing`);
	}
	if (changing.length > maxHunks) {
		throw new EditRefusedError(
			`The patch for "${path}" has more than ${String(maxHunks)} hunks; send smaller patches`,
		);
	}
	return changing;
}

// Each pass forgives a little more: the model may copy a line with its trailing spaces lost.
const passes: ((line: string) => string)[] = [
	line => line,
	line => line.trimEnd(),
	line => line.trim(),
];

/**
 * Where `pattern` starts in `lines`, at or after `from`, by the first pass that finds it. `null`
 * when no pass does, and the number of places when the first pass that matches finds several.
 */
function seek(
	lines: string[],
	pattern: string[],
	from: number,
	atEnd: boolean,
): number | null | { places: number } {
	const last = lines.length - pattern.length;
	for (const normalize of passes) {
		const wanted = pattern.map(normalize);
		const matchesAt = (start: number) =>
			wanted.every((line, offset) => normalize(lines[start + offset] ?? '') === line);
		if (atEnd) {
			if (last >= from && matchesAt(last)) return last;
			continue;
		}
		const found: number[] = [];
		for (let start = from; start <= last; start++) if (matchesAt(start)) found.push(start);
		if (found.length === 1) return found[0] ?? null;
		if (found.length > 1) return { places: found.length };
	}
	return null;
}

function quote(lines: string[]): string {
	const shown = lines.slice(0, quotedLines).map(line => `  ${line}`);
	if (lines.length > quotedLines) shown.push(`  … ${String(lines.length - quotedLines)} more`);
	return shown.join('\n');
}

/** The real lines near where a hunk's first line appears, so the model can copy them. */
function near(lines: string[], hunk: Hunk): string {
	const first = expected(hunk)
		.find(line => line.trim() !== '')
		?.trim();
	const at = first === undefined ? -1 : lines.findIndex(line => line.trim() === first);
	if (at === -1) return '';
	const from = Math.max(0, at - 1);
	const shown = lines
		.slice(from, from + quotedLines)
		.map((line, offset) => `  ${String(from + offset + 1)}: ${line}`);
	return `\nThe file has, near line ${String(at + 1)}:\n${shown.join('\n')}`;
}

/** Where a hunk's anchor lines are, one after another, so its change is found after them. */
function seekAnchor(lines: string[], hunk: Hunk, from: number, path: string, n: number): number {
	let cursor = from;
	for (const anchor of hunk.anchor?.split('\n') ?? []) {
		const at = seek(lines, [anchor], cursor, false);
		if (typeof at !== 'number') {
			throw new EditRefusedError(
				at === null
					? `Hunk ${String(n)} of the patch for "${path}" names "@@ ${anchor}", which is not in the file after the hunks before it`
					: `Hunk ${String(n)} of the patch for "${path}" names "@@ ${anchor}", which appears ${String(at.places)} times; name a line that appears once`,
			);
		}
		cursor = at + 1;
	}
	return cursor;
}

/**
 * Applies the hunks of a V4A `update_file` diff to `content`, in order, each after the one before
 * it. Each hunk's expected lines must appear exactly once in the part of the file it searches,
 * or nothing is changed: a hunk is never applied where the model did not mean it. The text keeps
 * its line endings and its final newline, or lack of one.
 *
 * @throws {EditRefusedError} naming the hunk, what it expected and what the file has near it.
 */
export function applyUpdate(content: string, diff: string, path: string): string {
	checkSize(diff, path);
	const text = splitLines(content);
	const lines = [...text.lines];
	let cursor = 0;
	for (const [index, hunk] of parseHunks(diff, path).entries()) {
		const n = index + 1;
		const from = seekAnchor(lines, hunk, cursor, path, n);
		const old = expected(hunk);
		const added = hunk.steps.filter(step => step.kind === 'add').map(step => step.text);
		if (old.length === 0) {
			// Only added lines: after the anchor, or at the end.
			const at = hunk.anchor === undefined || hunk.atEnd ? lines.length : from;
			lines.splice(at, 0, ...added);
			cursor = at + added.length;
			continue;
		}
		const at = seek(lines, old, from, hunk.atEnd);
		if (typeof at !== 'number') {
			throw new EditRefusedError(
				at === null
					? `Hunk ${String(n)} of the patch for "${path}" does not match the file. It expected:\n${quote(old)}${near(lines, hunk)}`
					: `Hunk ${String(n)} of the patch for "${path}" matches ${String(at.places)} places; add an "@@" line naming the function or more context`,
			);
		}
		// A kept line stays as the file has it, even where the patch copied it with a space lost.
		const replacement: string[] = [];
		let offset = 0;
		for (const step of hunk.steps) {
			if (step.kind === 'add') replacement.push(step.text);
			else if (step.kind === 'keep') replacement.push(lines[at + offset++] ?? step.text);
			else offset++;
		}
		lines.splice(at, old.length, ...replacement);
		cursor = at + replacement.length;
	}
	return joinLines({ ...text, lines, finalNewline: text.finalNewline || text.lines.length === 0 });
}

/**
 * The content of a file a V4A `create_file` diff makes: every line starts with `+`. It ends with
 * a newline, as a text file does.
 *
 * @throws {EditRefusedError} when a line is not an added one.
 */
export function createdContent(diff: string, path: string): string {
	checkSize(diff, path);
	const lines = diffLines(diff).filter(line => line !== '*** End of File');
	for (const [index, line] of lines.entries()) {
		if (!line.startsWith('+')) {
			throw new EditRefusedError(
				`Line ${String(index + 1)} of the patch creating "${path}" does not start with "+"; every line of a new file does`,
			);
		}
	}
	return joinLines({ lines: lines.map(line => line.slice(1)), eol: '\n', finalNewline: true });
}
