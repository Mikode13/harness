import { createHash } from 'node:crypto';
import {
	describeCreation,
	describeDeletion,
	describeFormatting,
	describeModification,
	editDiff,
} from '../domain/editResponse.ts';
import { EditRefusedError } from '../domain/fileEdits.ts';
import type { PreparedCall } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';
import { editRisk, type FileEditor } from './fileEditor.ts';
import type { WorkspaceWrites } from './workspaceWrites.ts';

/**
 * One edit, as an edit format asks for it, with the path as the model wrote it. A modification
 * works its new content out from what the file holds now, the version the model read; it throws
 * `EditRefusedError` with what the model needs to fix the call, such as a text that matched
 * twice.
 */
export type EditRequest =
	| { kind: 'create'; path: string; content: Buffer }
	| { kind: 'modify'; path: string; change: (current: Buffer) => Buffer }
	| { kind: 'delete'; path: string };

function hashOf(content: Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * What the file holds once the formatter, if there is one, ran on what the edit wrote, and what
 * the model needs to know when it may not be formatted. The conversation knows the file as it is
 * now, so it can edit it again without reading it.
 */
async function afterFormatting(
	writes: WorkspaceWrites,
	editor: FileEditor,
	{ path, absolute, written }: { path: string; absolute: string; written: Buffer },
	{ run, reads }: ToolCallContext,
	signal: AbortSignal,
): Promise<{ content: Buffer | undefined; note: string }> {
	const { formatter } = writes;
	if (!formatter) {
		// It wrote the content itself, so it has seen it.
		reads.record(absolute, hashOf(written));
		return { content: written, note: '' };
	}
	const failure = await formatter.format(absolute, writes.sessionFor(run), signal);
	const { content } = await editor.current(path, signal);
	if (content === undefined) reads.forget(absolute);
	else reads.record(absolute, hashOf(content));
	return { content, note: failure === undefined ? '' : `\n${failure}` };
}

/**
 * Prepares an edit from the version of the file this conversation read, and only from it:
 *
 * - a file it never read is `READ_REQUIRED`;
 * - a file changed since it read it is `STALE_FILE`;
 * - a new file needs a path that does not exist.
 *
 * Once applied, and formatted when the workspace has a formatter, the conversation knows the
 * file as it is then, so it can edit it again without reading it. What it returns to the model
 * is short: the lines around a change, or a confirmation.
 */
export async function prepareTrackedEdit(
	writes: WorkspaceWrites,
	request: EditRequest,
	signal: AbortSignal,
	call: ToolCallContext,
): Promise<PreparedCall> {
	const { run, reads } = call;
	const editor = writes.editorFor(run);
	const { path } = request;

	if (request.kind === 'create') {
		const prepared = await editor.prepare(
			{ kind: 'create', path, content: request.content },
			signal,
		);
		return {
			risk: editRisk(prepared),
			diff: editDiff(path, undefined, request.content.toString('utf8')),
			run: async runSignal => {
				await editor.apply(prepared, runSignal);
				const { content, note } = await afterFormatting(
					writes,
					editor,
					{ path, absolute: prepared.target.absolute, written: request.content },
					call,
					runSignal,
				);
				return content === undefined
					? `${goneAfterFormatting(path)}${note}`
					: `${describeCreation(path, content)}${describeFormatting(path, request.content.toString('utf8'), content.toString('utf8'))}${note}`;
			},
		};
	}

	const { target, state, content } = await editor.current(path, signal);
	if (!state.exists || content === undefined) {
		throw new EditRefusedError(`"${path}" does not exist`);
	}
	const seen = reads.versionOf(target.absolute);
	if (seen === undefined) {
		throw new EditRefusedError(`READ_REQUIRED: read "${path}" before changing it`);
	}
	if (seen !== state.hash) {
		throw new EditRefusedError(`STALE_FILE: "${path}" changed since you read it; read it again`);
	}

	if (request.kind === 'delete') {
		const prepared = await editor.prepare({ kind: 'delete', path, expected: seen }, signal);
		return {
			risk: editRisk(prepared),
			diff: editDiff(path, content.toString('utf8'), undefined),
			run: async runSignal => {
				await editor.apply(prepared, runSignal);
				reads.forget(target.absolute);
				return describeDeletion(path);
			},
		};
	}

	const next = request.change(content);
	const prepared = await editor.prepare(
		{ kind: 'replace', path, content: next, expected: seen },
		signal,
	);
	return {
		risk: editRisk(prepared),
		diff: editDiff(path, content.toString('utf8'), next.toString('utf8')),
		run: async runSignal => {
			await editor.apply(prepared, runSignal);
			const { content: now, note } = await afterFormatting(
				writes,
				editor,
				{ path, absolute: target.absolute, written: next },
				call,
				runSignal,
			);
			if (now === undefined) return `${goneAfterFormatting(path)}${note}`;
			const formatted = now.toString('utf8');
			return `${describeModification(path, content.toString('utf8'), formatted)}${describeFormatting(path, next.toString('utf8'), formatted)}${note}`;
		},
	};
}

function goneAfterFormatting(path: string): string {
	return `Changed ${path}, but it no longer exists once the formatter ran.`;
}
