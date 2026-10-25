import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { WorkspaceBusyError } from '#src/recovery/domain/recoveryStore';

/** One claim on disk: who made it, and the folders it covers, as real paths. */
interface Claim {
	pid: number;
	folders: string[];
}

// The claims this process holds, so one left by a run of this process that ended is seen as gone.
const claimedHere = new Set<string>();

/** A claim as read from disk. Throws for one that is not a claim: it may still be live. */
function parseClaim(name: string, text: string): Claim {
	try {
		const { pid, folders } = JSON.parse(text) as { pid?: unknown; folders?: unknown };
		if (
			Number.isInteger(pid) &&
			Array.isArray(folders) &&
			folders.every(folder => typeof folder === 'string')
		) {
			return { pid: pid as number, folders };
		}
	} catch {
		// Not JSON: refused below like any other unreadable claim.
	}
	throw new Error(`The claim ${name} cannot be read, so whether it is live cannot be told`);
}

function overlap(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

/** Whether a process still exists. One we may not signal exists too. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Who works in which folders, across every history kept in one state directory, so a folder is
 * removed only while no run writes in it, and no run starts writing in a folder being removed.
 * A run, or a move, claims the folders it may write while it holds its workspace; a removal
 * claims the folder while it removes it. Each writes its own claim before it reads the others',
 * so of two that start at once at least one sees the other, and gives way.
 */
export class FolderClaims {
	private readonly directory: string;

	/** `stateDirectory` is the real path of the state directory. */
	constructor(stateDirectory: string) {
		this.directory = join(stateDirectory, 'claims');
	}

	/**
	 * Claims `folders` for writing, and returns what releases the claim.
	 *
	 * @throws {WorkspaceBusyError} when a removal in progress covers one of them.
	 */
	claimWriting(id: string, folders: readonly string[]): Promise<() => Promise<void>> {
		return this.claim('writing', id, folders, 'removal');
	}

	/**
	 * Claims `folder` for its removal, and returns what releases the claim.
	 *
	 * @throws {WorkspaceBusyError} when a run, or a move, may write in it.
	 */
	claimRemoval(folder: string): Promise<() => Promise<void>> {
		return this.claim('removal', `removal-${randomBytes(6).toString('hex')}`, [folder], 'writing');
	}

	private async claim(
		kind: 'writing' | 'removal',
		id: string,
		folders: readonly string[],
		against: 'writing' | 'removal',
	): Promise<() => Promise<void>> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const name = `${kind}-${id}.json`;
		const path = join(this.directory, name);
		const claim: Claim = { pid: process.pid, folders: [...folders] };
		// Whole before it appears, so a claim another process reads is never half written.
		const written = `${path}.${randomBytes(4).toString('hex')}.tmp`;
		await writeFile(written, JSON.stringify(claim), { mode: 0o600 });
		claimedHere.add(name);
		await rename(written, path);
		const release = async () => {
			claimedHere.delete(name);
			await unlink(path).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			});
		};

		let holder: string | undefined;
		try {
			holder = await this.liveHolder(against, folders);
		} catch (error) {
			// Published, so it must go however reading the others failed, or it would hold the folders
			// until this process ends. The failure is what the caller needs to see.
			await release().catch(() => undefined);
			throw error;
		}
		if (holder !== undefined) {
			await release();
			throw new WorkspaceBusyError(holder);
		}
		return release;
	}

	/** A live claim of `kind` covering one of `folders`, by its name, if any. */
	private async liveHolder(
		kind: 'writing' | 'removal',
		folders: readonly string[],
	): Promise<string | undefined> {
		for (const name of await readdir(this.directory)) {
			if (!name.startsWith(`${kind}-`) || !name.endsWith('.json')) continue;
			const text = await readFile(join(this.directory, name), 'utf8').catch((error: unknown) => {
				// Released meanwhile. Any other failure leaves a claim unread, which may be live.
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
				throw error;
			});
			if (text === undefined) continue;
			const claim = parseClaim(name, text);
			const live = claim.pid === process.pid ? claimedHere.has(name) : isAlive(claim.pid);
			if (!live) {
				// Left by a run whose process died, or that ended without releasing it.
				await unlink(join(this.directory, name)).catch(() => undefined);
				continue;
			}
			if (claim.folders.some(claimed => folders.some(folder => overlap(claimed, folder)))) {
				return name.slice(0, -'.json'.length);
			}
		}
		return undefined;
	}
}
