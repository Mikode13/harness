import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
	FileState,
	RecoveryStore,
	RunJournal,
} from '../../src/recovery/domain/recoveryStore.ts';

/** A change a run makes: the file's new content, or `undefined` to delete it. */
export type Edit = [name: string, content: string | undefined, mode?: number];

async function stateOnDisk(journal: RunJournal, path: string): Promise<FileState> {
	if (!existsSync(path)) return { exists: false };
	return {
		exists: true,
		hash: await journal.saveContent(readFileSync(path)),
		mode: statSync(path).mode & 0o7777,
	};
}

/** Folders missing above `path`, outermost first, as the editor records them. */
function missingFolders(path: string): string[] {
	const folders: string[] = [];
	for (let folder = dirname(path); !existsSync(folder); folder = dirname(folder)) {
		folders.unshift(folder);
	}
	return folders;
}

/**
 * Records and makes each edit under `root` as a writing run would, then finishes the run and
 * returns its id.
 */
export async function recordRun(
	store: RecoveryStore,
	root: string,
	edits: Edit[],
): Promise<string> {
	const journal = await store.startRun();
	for (const [name, content, mode = 0o644] of edits) {
		const path = join(root, name);
		const before = await stateOnDisk(journal, path);
		const after: FileState =
			content === undefined
				? { exists: false }
				: { exists: true, hash: await journal.saveContent(Buffer.from(content)), mode };
		const createdFolders = content === undefined ? [] : missingFolders(path);
		const sequence = await journal.prepare({
			path,
			before,
			after,
			...(createdFolders.length > 0 ? { createdFolders } : {}),
		});
		if (content === undefined) {
			rmSync(path);
		} else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			chmodSync(path, mode);
		}
		await journal.applied(sequence);
	}
	await journal.finish('completed');
	return journal.runId;
}

/** The content of `name` under `root`, or `undefined` when it does not exist. */
export function readUnder(root: string, name: string): string | undefined {
	const path = join(root, name);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
