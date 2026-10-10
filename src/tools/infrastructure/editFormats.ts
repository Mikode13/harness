import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { asNative, type NativeTool } from '#src/llm/domain/tool';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import { EditRefusedError } from '../domain/fileEdits.ts';
import type { PreparedCall, PreparingTool } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';
import { addedLine, joinLines, type Line, splitLines, textsOf } from '../domain/textLines.ts';
import { applyUpdate, createdContent } from '../domain/v4aPatch.ts';
import type { Workspace } from '../domain/workspace.ts';
import { definePreparingTool } from './defineTool.ts';
import { prepareTrackedEdit } from './trackedEdits.ts';
import { readTracked } from './trackedReadFile.ts';
import { readRange } from './workspaceTools.ts';
import type { WorkspaceWrites } from './workspaceWrites.ts';

// A folder the editor views is listed, as its reference implementation does, up to this many.
const maxListedFiles = 200;

/**
 * A native tool: its provider gives the model the schema, so the one here only says what the
 * calls hold, and each call is checked against `input` before anything is prepared.
 */
function nativeTool<Schema extends z.ZodType>({
	name,
	description,
	native,
	input,
	prepare,
}: {
	name: string;
	description: string;
	native: NativeTool;
	input: Schema;
	prepare: (
		input: z.infer<Schema>,
		signal: AbortSignal,
		call: ToolCallContext,
	) => Promise<PreparedCall>;
}): PreparingTool {
	return asNative(
		{
			name,
			description,
			inputSchema: { type: 'object' },
			prepare: (raw: unknown, signal: AbortSignal, call: ToolCallContext) => {
				const parsed = input.safeParse(raw);
				if (!parsed.success) return Promise.reject(new Error(z.prettifyError(parsed.error)));
				return prepare(parsed.data, signal, call);
			},
		},
		native,
	);
}

const patchOperation = z.discriminatedUnion('type', [
	z.object({ type: z.literal('create_file'), path: z.string(), diff: z.string() }),
	z.object({ type: z.literal('update_file'), path: z.string(), diff: z.string() }),
	z.object({ type: z.literal('delete_file'), path: z.string() }),
]);

/**
 * OpenAI's native `apply_patch`: each call is one operation on one file, `create_file` and
 * `update_file` with a V4A diff. It cannot read, so the agent also has `readFile`.
 */
export function createApplyPatchTool(writes: WorkspaceWrites): PreparingTool {
	return nativeTool({
		name: 'apply_patch',
		description: 'Creates, changes or deletes a file with a V4A patch.',
		native: 'applyPatch',
		input: patchOperation,
		prepare: (operation, signal, call) => {
			const { path } = operation;
			switch (operation.type) {
				case 'create_file':
					return prepareTrackedEdit(
						writes,
						{ kind: 'create', path, content: Buffer.from(createdContent(operation.diff, path)) },
						signal,
						call,
					);
				case 'update_file':
					return prepareTrackedEdit(
						writes,
						{
							kind: 'modify',
							path,
							change: current =>
								Buffer.from(applyUpdate(current.toString('utf8'), operation.diff, path)),
						},
						signal,
						call,
					);
				case 'delete_file':
					return prepareTrackedEdit(writes, { kind: 'delete', path }, signal, call);
			}
		},
	});
}

const editorCommand = z.discriminatedUnion('command', [
	z.object({
		command: z.literal('view'),
		path: z.string(),
		view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
	}),
	z.object({
		command: z.literal('str_replace'),
		path: z.string(),
		old_str: z.string(),
		new_str: z.string().optional(),
	}),
	z.object({ command: z.literal('create'), path: z.string(), file_text: z.string() }),
	z.object({
		command: z.literal('insert'),
		path: z.string(),
		insert_line: z.number().int(),
		insert_text: z.string(),
	}),
]);

/** How many times `text` appears in `source`, without overlaps. */
function occurrences(source: string, text: string): number {
	return source.split(text).length - 1;
}

/**
 * Replaces the one place `oldText` appears. The model writes `\n`: when the text as sent is not
 * in the file, it is tried with CRLF too, so a CRLF file can be edited, and written with CRLF.
 */
function replaceOnce(source: string, oldText: string, newText: string, path: string): string {
	if (oldText === '') {
		throw new EditRefusedError(`old_str is empty; copy the text to replace from "${path}"`);
	}
	let [from, to] = [oldText, newText];
	let count = occurrences(source, from);
	if (count === 0 && !oldText.includes('\r\n') && oldText.includes('\n')) {
		[from, to] = [oldText.replaceAll('\n', '\r\n'), newText.replaceAll('\n', '\r\n')];
		count = occurrences(source, from);
	}
	if (count === 0) {
		throw new EditRefusedError(
			`old_str is not in "${path}"; view the file and copy the text exactly, whitespace included`,
		);
	}
	if (count > 1) {
		throw new EditRefusedError(
			`old_str appears ${String(count)} times in "${path}"; include more of the lines around it so it appears once`,
		);
	}
	// A function, so `$&` and the like in the new text are written as they are.
	return source.replace(from, () => to);
}

/**
 * Puts `text` after line `after` of `source`, 0 being before the first. The lines inserted end
 * like the line before them, and every other line is written back as it was.
 */
function insertAfter(source: string, after: number, text: string, path: string): string {
	const file = splitLines(source);
	if (after < 0 || after > file.lines.length) {
		throw new EditRefusedError(
			`insert_line must be between 0 and ${String(file.lines.length)}, the number of lines in "${path}"`,
		);
	}
	const texts = textsOf(splitLines(text).lines);
	const inserted: Line[] = [];
	for (const line of texts.length > 0 ? texts : ['']) {
		inserted.push(addedLine(line, inserted.at(-1) ?? file.lines[after - 1], file.eol));
	}
	const lines = [...file.lines];
	lines.splice(after, 0, ...inserted);
	return joinLines({ ...file, lines, finalNewline: file.finalNewline || file.lines.length === 0 });
}

/** The files under a folder, as the editor shows a folder it views. */
async function listFolder(
	workspace: Workspace,
	path: string,
	signal: AbortSignal,
): Promise<string> {
	const { files, total, truncated } = await workspace.listFiles(
		{ path, limit: maxListedFiles },
		signal,
	);
	if (files.length === 0) return 'No files.';
	const notice = truncated
		? `\n[Showing ${String(files.length)} of ${String(total)} files. View a folder inside it to see the rest.]`
		: '';
	return files.join('\n') + notice;
}

/**
 * Claude's native text editor, `str_replace_based_edit_tool`. `view` reads through the access
 * policy and counts as a read, so it replaces `readFile`; on a folder it lists the files in it.
 * `create` makes only a file that does not exist, and the editor has no command to delete:
 * Claude gets `delete_file` for that.
 */
export function createTextEditorTool({
	writes,
	policy,
	workspace,
}: {
	writes: WorkspaceWrites;
	policy: AccessPolicy;
	workspace: Workspace;
}): PreparingTool {
	return nativeTool({
		name: 'str_replace_based_edit_tool',
		description: 'Views, creates and changes files.',
		native: 'textEditor',
		input: editorCommand,
		prepare: async (command, signal, call) => {
			const { path } = command;
			switch (command.command) {
				case 'view': {
					const [start, end] = command.view_range ?? [1, -1];
					if (start < 1) {
						throw new Error(`view_range starts at line ${String(start)}; lines count from 1`);
					}
					if (end !== -1 && end < start) {
						throw new Error(`view_range ends before it starts: [${String(start)}, ${String(end)}]`);
					}
					const { from, count } = readRange({
						fromLine: start,
						lineCount: end === -1 ? null : end - start + 1,
					});
					const target = await policy.check(path, 'read', signal);
					const isFolder = await lstat(target.absolute).then(
						stats => stats.isDirectory(),
						() => false,
					);
					return {
						risk: 'safe',
						run: runSignal =>
							isFolder
								? listFolder(workspace, path, runSignal)
								: readTracked({ target, path, from, count, reads: call.reads, signal: runSignal }),
					};
				}
				case 'str_replace':
					return prepareTrackedEdit(
						writes,
						{
							kind: 'modify',
							path,
							change: current =>
								Buffer.from(
									replaceOnce(
										current.toString('utf8'),
										command.old_str,
										command.new_str ?? '',
										path,
									),
								),
						},
						signal,
						call,
					);
				case 'create':
					return prepareTrackedEdit(
						writes,
						{ kind: 'create', path, content: Buffer.from(command.file_text) },
						signal,
						call,
					);
				case 'insert':
					return prepareTrackedEdit(
						writes,
						{
							kind: 'modify',
							path,
							change: current =>
								Buffer.from(
									insertAfter(
										current.toString('utf8'),
										command.insert_line,
										command.insert_text,
										path,
									),
								),
						},
						signal,
						call,
					);
			}
		},
	});
}

/** The delete Claude's text editor has no command for. */
export function createDeleteFileTool(writes: WorkspaceWrites): PreparingTool {
	return definePreparingTool({
		name: 'delete_file',
		description: 'Deletes a file. Read it first.',
		input: z.object({ path: z.string().describe('The file, relative to the root.') }),
		prepare: ({ path }, signal, call) =>
			prepareTrackedEdit(writes, { kind: 'delete', path }, signal, call),
	});
}
