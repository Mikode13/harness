import { realpath } from 'node:fs/promises';
import { type History, StoreHistory } from '../domain/history.ts';
import { FileRecoveryStore } from './fileRecoveryStore.ts';

/**
 * The history of the runs that wrote to `root`, kept outside it under the platform's state
 * directory. Only runs of a model-backed agent with write tools are recorded: the Agent SDK
 * engines change files through their own tools, and their changes are not in it.
 */
export async function createHistory({
	root,
	stateDirectory,
}: {
	root: string;
	/** Where the history is kept. Defaults to the platform's state directory. */
	stateDirectory?: string;
}): Promise<History> {
	const store = await FileRecoveryStore.open({
		root,
		...(stateDirectory === undefined ? {} : { directory: stateDirectory }),
	});
	// The store keys the workspace by its real path, and records real paths.
	return new StoreHistory({ store, root: await realpath(root) });
}
