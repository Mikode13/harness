import type { RecoveryStore } from '../../src/recovery/domain/recoveryStore.ts';
import type { PreparedCall, PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import { RootsAccessPolicy } from '../../src/tools/infrastructure/rootsAccessPolicy.ts';
import { WorkspaceWrites } from '../../src/tools/infrastructure/workspaceWrites.ts';

const schema = { type: 'object' as const, properties: {}, required: [] };

/** A minimal write tool on the real engine: replaces a whole file. The real ones arrive later. */
export function replaceTool(
	writes: WorkspaceWrites,
	risk: PreparedCall['risk'] = 'mutating',
): PreparingTool {
	return {
		name: 'replace',
		description: 'Replaces a file',
		inputSchema: schema,
		prepare: async (input, prepareSignal, { run }) => {
			const { path, content } = input as { path: string; content: string };
			const editor = writes.editorFor(run);
			const edit = await editor.prepare(
				{ kind: 'replace', path, content: Buffer.from(content) },
				prepareSignal,
			);
			return {
				risk,
				run: async runSignal => {
					await editor.apply(edit, runSignal);
					return `Changed ${path}`;
				},
			};
		},
	};
}

/** The writing side of `root`, declared as one `write` root, recorded in `store`. */
export async function writesOver(root: string, store: RecoveryStore): Promise<WorkspaceWrites> {
	return new WorkspaceWrites({
		policy: await RootsAccessPolicy.create({
			roots: [{ path: root, access: 'write' }],
			ignoreRules: new GitIgnoreRules(),
		}),
		store,
	});
}
