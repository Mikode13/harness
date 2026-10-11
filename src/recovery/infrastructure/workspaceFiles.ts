import { createHash, randomBytes } from 'node:crypto';
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { FileState } from '../domain/recoveryStore.ts';

// Far above the largest file the editor changes, so the history never reads a file whole only
// to find it differs.
const maxRecordedBytes = 64 * 1024 * 1024;

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/**
 * What `path` holds now, or `undefined` when it is something no recorded change leaves: a
 * folder, a link, or a file larger than any change records, which is not read.
 */
export async function currentState(path: string): Promise<FileState | undefined> {
	let stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if (code(error) === 'ENOENT') return { exists: false };
		throw error;
	}
	if (!stats.isFile() || stats.size > maxRecordedBytes) return undefined;
	const hash = createHash('sha256')
		.update(await readFile(path))
		.digest('hex');
	return { exists: true, hash, mode: stats.mode & 0o7777 };
}

/**
 * Whether every existing folder above `path` is where its name says. A folder replaced by a
 * link since the run would send a write somewhere the run never wrote, maybe outside the
 * workspace, so such a path is not written.
 */
export async function hasRealParents(path: string): Promise<boolean> {
	for (let folder = dirname(path); ; folder = dirname(folder)) {
		try {
			return (await realpath(folder)) === folder;
		} catch (error) {
			if (code(error) !== 'ENOENT') throw error;
		}
		if (dirname(folder) === folder) return true;
	}
}

/**
 * Puts `content` at `path` with `mode`, all at once: a crash leaves the old file or the new one.
 * Missing folders above it are created.
 */
export async function writeFileState(
	path: string,
	content: Buffer,
	mode: number,
	temporary: string,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	try {
		// Private while it holds content of a file that may be private too; the file's own mode
		// is set only once it is whole.
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(content);
			// Set on the open file, so the umask does not change it.
			await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
	await syncFolder(dirname(path));
}

/**
 * A new, hidden name beside `path` to build its content in. It is random, so it never names a
 * file of the user's, and the caller records it before the write so a crash can be cleaned up.
 */
export function temporaryPath(path: string): string {
	return join(
		dirname(path),
		`.${basename(path)}.${randomBytes(6).toString('hex')}.mikode-harness-tmp`,
	);
}

/**
 * Removes a temporary `temporaryPath` named, which a write a crash interrupted left behind.
 * Nothing is removed through a folder that became a link.
 */
export async function removeTemporary(temporary: string): Promise<void> {
	if (await hasRealParents(temporary)) await rm(temporary, { force: true });
}

export async function removeFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (code(error) !== 'ENOENT') throw error;
	}
	await syncFolder(dirname(path));
}

/** Removes `folders`, innermost first, each only while it is empty. */
export async function removeEmptyFolders(folders: string[]): Promise<void> {
	for (const folder of [...folders].reverse()) {
		try {
			await rmdir(folder);
		} catch (error) {
			if (code(error) === 'ENOENT') continue;
			// Something else is in it now, so it and every folder above it stay.
			if (code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST' || code(error) === 'ENOTDIR')
				return;
			throw error;
		}
	}
}

async function syncFolder(path: string): Promise<void> {
	const folder = await open(path, 'r');
	try {
		await folder.sync();
	} finally {
		await folder.close();
	}
}
