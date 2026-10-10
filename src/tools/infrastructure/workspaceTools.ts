import { z } from 'zod';
import type { Tool } from '../domain/tool.ts';
import type { Workspace } from '../domain/workspace.ts';
import { defineTool } from './defineTool.ts';

// What one call may return. The model can ask for fewer lines, never for more.
const maxFiles = 200;
const maxMatches = 100;
const maxLines = 200;
// One minified line can be larger than everything else the model has read.
const maxLineLength = 300;

// Strict mode has no optional fields: an argument the model may leave out is nullable.
const scope = {
	path: z.string().nullable().describe('A folder or file to stay inside, relative to the root.'),
	glob: z.string().nullable().describe('Only paths matching this glob, such as "**/*.ts".'),
};

/** One line as the model reads it: a minified bundle on a single line would flood its context. */
function cutLine(text: string): string {
	return text.length > maxLineLength ? `${text.slice(0, maxLineLength)}…` : text;
}

/**
 * Lines of a file as the model reads them: each numbered, a line too long cut, and a notice for
 * what was cut or lies beyond.
 */
export function renderLines({
	lines,
	from,
	totalLines,
	truncated,
}: {
	lines: string[];
	from: number;
	totalLines: number;
	truncated: boolean;
}): string {
	// The file's length tells the model where its range went wrong.
	if (lines.length === 0) {
		return `No lines from ${String(from)}: the file has ${String(totalLines)} lines.`;
	}

	const numbered = lines.map((text, index) => `${String(from + index)}: ${cutLine(text)}`);
	const cut = lines.filter(text => text.length > maxLineLength).length;
	const notices = [
		...(cut > 0
			? [
					`[${String(cut)} lines were longer than ${String(maxLineLength)} characters and were cut.]`,
				]
			: []),
		...(truncated
			? [
					`[The file has ${String(totalLines)} lines. Read from line ${String(from + lines.length)} to continue.]`,
				]
			: []),
	];
	return [...numbered, ...notices].join('\n');
}

/** What `readFile` takes, shared with the harness's own version of it. */
export const readFileDescription = 'Reads lines of a file, each prefixed with its number.';
export const readFileInput = z.object({
	path: z.string().describe('The file, relative to the root.'),
	fromLine: z.number().nullable().describe('The first line to read, from 1. Defaults to 1.'),
	lineCount: z
		.number()
		.nullable()
		.describe(
			`How many lines to read, at most ${String(maxLines)}. Defaults to ${String(maxLines)}.`,
		),
});

/** The range a `readFile` call asks for, checked: strict mode allows the schema no minimum. */
export function readRange({
	fromLine,
	lineCount,
}: {
	fromLine: number | null;
	lineCount: number | null;
}): { from: number; count: number } {
	const from = fromLine ?? 1;
	const requested = lineCount ?? maxLines;
	assertPositiveInteger('fromLine', from);
	assertPositiveInteger('lineCount', requested);
	return { from, count: Math.min(requested, maxLines) };
}

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a whole number of at least 1; got ${String(value)}`);
	}
}

/** The three read-only tools an agent explores a repository with. */
export function createWorkspaceTools(workspace: Workspace): Tool[] {
	return [
		defineTool({
			name: 'listFiles',
			description:
				'Lists the files of the repository, sorted. Ignored files such as dependencies are left out.',
			risk: 'safe',
			input: z.object(scope),
			execute: async ({ path, glob }, signal) => {
				// The port takes "no scope" as a missing field.
				const { files, total, truncated } = await workspace.listFiles(
					{ path: path ?? undefined, glob: glob ?? undefined, limit: maxFiles },
					signal,
				);

				// Nothing found is an answer too, not an empty string.
				if (files.length === 0) {
					return 'No files.';
				}

				const notice = truncated
					? `\n[Showing ${String(files.length)} of ${String(total)} files. Narrow the path or glob to see the rest.]`
					: '';
				return files.join('\n') + notice;
			},
		}),

		defineTool({
			name: 'searchText',
			description:
				'Searches the repository for a regular expression and returns each matching line as path:line: text.',
			risk: 'safe',
			input: z.object({
				pattern: z.string().describe('A regular expression.'),
				ignoreCase: z.boolean().nullable().describe('Match regardless of case. Defaults to false.'),
				...scope,
			}),
			execute: async ({ path, glob, ignoreCase, pattern }, signal) => {
				const { matches, total, truncated } = await workspace.searchText(
					{
						path: path ?? undefined,
						glob: glob ?? undefined,
						ignoreCase: ignoreCase ?? false,
						pattern,
						limit: maxMatches,
					},
					signal,
				);

				if (matches.length === 0) {
					return 'No matches.';
				}

				const results = matches.map(
					match => `${match.path}:${String(match.line)}: ${cutLine(match.text)}`,
				);

				const notice = truncated
					? `\n[Showing ${String(results.length)} of ${String(total)} matches. Narrow the path or glob to see the rest.]`
					: '';
				return results.join('\n') + notice;
			},
		}),

		defineTool({
			name: 'readFile',
			description: readFileDescription,
			risk: 'safe',
			input: readFileInput,
			execute: async ({ fromLine, lineCount, path }, signal) => {
				// Checked before reading.
				const { from, count } = readRange({ fromLine, lineCount });
				const { lines, totalLines, truncated } = await workspace.readFile(
					{ path, fromLine: from, lineCount: count },
					signal,
				);
				return renderLines({ lines, from, totalLines, truncated });
			},
		}),
	];
}
