import { z } from 'zod';
import type { RecoveryStore } from '../../src/recovery/domain/recoveryStore.ts';
import { EditRefusedError } from '../../src/tools/domain/fileEdits.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { definePreparingTool } from '../../src/tools/infrastructure/defineTool.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import { RootsAccessPolicy } from '../../src/tools/infrastructure/rootsAccessPolicy.ts';
import { createTrackedReadFile } from '../../src/tools/infrastructure/trackedReadFile.ts';
import { prepareTrackedEdit } from '../../src/tools/infrastructure/trackedEdits.ts';
import { WorkspaceWrites } from '../../src/tools/infrastructure/workspaceWrites.ts';

/**
 * The tracked `readFile` and a minimal edit format over the real engine, for tests: `edit`
 * creates, deletes, or replaces one exact text once. The provider formats arrive later.
 */
export async function trackedToolsOver(
	root: string,
	store: RecoveryStore,
): Promise<{ readFile: PreparingTool; edit: PreparingTool }> {
	const policy = await RootsAccessPolicy.create({
		roots: [{ path: root, access: 'write' }],
		ignoreRules: new GitIgnoreRules(),
	});
	const writes = new WorkspaceWrites({ policy, store });
	return {
		readFile: createTrackedReadFile(policy),
		edit: definePreparingTool({
			name: 'edit',
			description: 'Creates, changes or deletes a file',
			input: z.object({
				op: z.enum(['create', 'modify', 'delete']),
				path: z.string(),
				text: z.string().nullable(),
				replacement: z.string().nullable(),
			}),
			prepare: ({ op, path, text, replacement }, signal, call) => {
				if (op === 'create') {
					return prepareTrackedEdit(
						writes,
						{ kind: 'create', path, content: Buffer.from(text ?? '') },
						signal,
						call,
					);
				}
				if (op === 'delete') {
					return prepareTrackedEdit(writes, { kind: 'delete', path }, signal, call);
				}
				return prepareTrackedEdit(
					writes,
					{
						kind: 'modify',
						path,
						change: current => {
							const source = current.toString('utf8');
							const find = text ?? '';
							const count = source.split(find).length - 1;
							if (count !== 1) {
								throw new EditRefusedError(
									`The text appears ${String(count)} times in "${path}"; it must appear once`,
								);
							}
							return Buffer.from(source.replace(find, replacement ?? ''));
						},
					},
					signal,
					call,
				);
			},
		}),
	};
}
