import { createHash } from 'node:crypto';
import {
	describeCreation,
	describeDeletion,
	describeModification,
	editDiff,
} from '../domain/editResponse.ts';
import { EditRefusedError } from '../domain/fileEdits.ts';
import type { PreparedCall } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';
import { editRisk } from './fileEditor.ts';
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
 * Prepares an edit from the version of the file this conversation read, and only from it:
 *
 * - a file it never read is `READ_REQUIRED`;
 * - a file changed since it read it is `STALE_FILE`;
 * - a new file needs a path that does not exist.
 *
 * Once applied, the conversation knows the file as the edit left it, so it can edit it again
 * without reading it. What it returns to the model is short: the lines around a change, or a
 * confirmation.
 */
export async function prepareTrackedEdit(
	writes: WorkspaceWrites,
	request: EditRequest,
	signal: AbortSignal,
	{ run, reads }: ToolCallContext,
): Promise<PreparedCall> {
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
				// It wrote the content itself, so it has seen it.
				reads.record(prepared.target.absolute, hashOf(request.content));
				return describeCreation(path, request.content);
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
			reads.record(target.absolute, hashOf(next));
			return describeModification(path, content.toString('utf8'), next.toString('utf8'));
		},
	};
}
