import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
	type FileState,
	type JournalEntry,
	type RecoveryStore,
	type RunJournal,
	type RunRecord,
	type RunStatus,
	WorkspaceBusyError,
} from '../domain/recoveryStore.ts';

const appName = 'mikode-harness';
// The store holds source code the agent touched: only its owner may read it.
const privateDirectory = 0o700;
const privateFile = 0o600;

const runIdPattern = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/;
const hashPattern = /^[0-9a-f]{64}$/;

/** Where an application keeps state that is neither configuration nor cache, per platform. */
export function defaultStateDirectory(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string {
	// The XDG spec says to ignore a relative path, which here could land inside the repository.
	const xdg = env.XDG_STATE_HOME;
	if (xdg && isAbsolute(xdg)) return join(xdg, appName);
	if (platform === 'darwin') return join(home, 'Library', 'Application Support', appName);
	return join(home, '.local', 'state', appName);
}

/** Sorts by start time as text, so the latest run is the last one listed. */
function newRunId(): string {
	return `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
}

function hashOf(content: Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
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

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/**
 * Creates a private folder and any missing parents. A new folder only survives a crash once
 * its parent's entry for it is synced too, so each parent that gained one is.
 */
async function makeDirectory(path: string): Promise<void> {
	const first = await mkdir(path, { recursive: true, mode: privateDirectory });
	if (first === undefined) return;
	for (let created = path; ; created = dirname(created)) {
		await syncDirectory(dirname(created));
		if (created === first) return;
	}
}

/**
 * Puts `content` at `path` all at once: a crash leaves either the old file or the new one, never
 * half of the new one. It returns only once the new file is on disk. With `exclusive`, it fails
 * with `EEXIST` instead of replacing a file already there.
 */
async function writeDurably(
	path: string,
	content: string | Buffer,
	{ exclusive = false }: { exclusive?: boolean } = {},
): Promise<void> {
	const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		const handle = await open(temporary, 'wx', privateFile);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		// A link fails if the path is taken; a rename would replace it.
		await (exclusive ? link : rename)(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
	await syncDirectory(dirname(path));
}

type JournalLine =
	| ({ type: 'prepared'; sequence: number } & Omit<JournalEntry, 'sequence' | 'status'>)
	| { type: 'applied' | 'abandoned'; sequence: number };

/**
 * The recovery store on disk, in a private directory per workspace under the platform's state
 * directory:
 *
 * ```text
 * <directory>/workspaces/<hash of the root>/
 *   workspace.json            the root it belongs to
 *   lock                      the run writing now, if any
 *   content/<ab>/<hash>       file contents, named by their SHA-256
 *   runs/<runId>/run.json     the run's record
 *   runs/<runId>/journal.jsonl  its changes, one line per step, appended and synced
 * ```
 *
 * The lock only keeps a second run of this harness from writing at the same time. It does not
 * stop an editor or another program, and two processes taking over a dead run's lock in the
 * same instant could both believe they hold it.
 */
export class FileRecoveryStore implements RecoveryStore {
	private constructor(
		private readonly root: string,
		private readonly directory: string,
	) {}

	static async open({
		root,
		directory = defaultStateDirectory(),
	}: {
		root: string;
		/** Defaults to the platform's state directory. */
		directory?: string;
	}): Promise<FileRecoveryStore> {
		// Two spellings of one folder, such as a symlinked path, are one workspace.
		const realRoot = await realpath(root);
		const workspace = join(
			directory,
			'workspaces',
			createHash('sha256').update(realRoot).digest('hex').slice(0, 16),
		);
		await makeDirectory(join(workspace, 'runs'));
		await makeDirectory(join(workspace, 'content'));
		await writeDurably(join(workspace, 'workspace.json'), JSON.stringify({ root: realRoot }));

		return new FileRecoveryStore(realRoot, workspace);
	}

	async startRun(): Promise<RunJournal> {
		const runId = newRunId();
		await this.lock(runId);
		try {
			const runDirectory = join(this.directory, 'runs', runId);
			await makeDirectory(runDirectory);
			const record: RunRecord = {
				runId,
				root: this.root,
				startedAt: new Date().toISOString(),
				status: 'running',
				pid: process.pid,
			};
			await writeDurably(join(runDirectory, 'run.json'), JSON.stringify(record));
			const journal = await open(join(runDirectory, 'journal.jsonl'), 'a', privateFile);
			await syncDirectory(runDirectory);

			return new FileRunJournal({
				record,
				runDirectory,
				contentDirectory: join(this.directory, 'content'),
				journal,
				release: () => this.unlock(runId),
			});
		} catch (error) {
			await this.unlock(runId);
			throw error;
		}
	}

	async readRun(runId: string): Promise<{ record: RunRecord; entries: JournalEntry[] }> {
		// The id names a folder, so it must never be a path of its own.
		if (!runIdPattern.test(runId)) throw new Error(`Not a run id: ${runId}`);
		const runDirectory = join(this.directory, 'runs', runId);
		const record = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8')) as RunRecord;
		const lines = (await readFile(join(runDirectory, 'journal.jsonl'), 'utf8')).split('\n');

		const entries = new Map<number, JournalEntry>();
		lines.forEach((text, index) => {
			if (text === '') return;
			let line: JournalLine;
			try {
				line = JSON.parse(text) as JournalLine;
			} catch (error) {
				// A crash in the middle of an append leaves half a line, always the last one. Its
				// step never returned, so no change was made after it.
				if (index === lines.length - 1) return;
				throw new Error(`The journal of run ${runId} is corrupt at line ${String(index + 1)}`, {
					cause: error,
				});
			}
			if (line.type === 'prepared') {
				const { sequence, path, before, after } = line;
				entries.set(sequence, { sequence, path, before, after, status: 'prepared' });
				return;
			}
			const entry = entries.get(line.sequence);
			if (entry) entry.status = line.type;
		});

		return { record, entries: [...entries.values()] };
	}

	async readContent(hash: string): Promise<Buffer> {
		if (!hashPattern.test(hash)) throw new Error(`Not a content hash: ${hash}`);
		return readFile(contentPath(join(this.directory, 'content'), hash));
	}

	private async lock(runId: string): Promise<void> {
		const path = join(this.directory, 'lock');
		// Twice at most: once as it is, and once more after clearing a dead run's lock.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				// Written whole before it appears, so a lock that exists always names its holder.
				await writeDurably(path, JSON.stringify({ runId, pid: process.pid }), { exclusive: true });
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}

			const holder = await readLock(path);
			// Released meanwhile: try again.
			if (!holder) continue;
			// A holder that cannot be named cannot be shown to be dead.
			if (holder.pid === undefined || isAlive(holder.pid)) {
				throw new WorkspaceBusyError(holder.runId);
			}
			// Its process died without releasing it. Read again just before removing, so a lock
			// another process has just taken is left alone.
			const again = await readLock(path);
			if (again?.pid === holder.pid && again.runId === holder.runId) {
				await unlink(path).catch((error: unknown) => {
					if (!isNotFound(error)) throw error;
				});
			}
		}

		throw new WorkspaceBusyError((await readLock(path))?.runId ?? 'unknown');
	}

	private async unlock(runId: string): Promise<void> {
		const path = join(this.directory, 'lock');
		// Only its own lock: one cleared as stale and taken by another run is not this run's.
		if ((await readLock(path))?.runId === runId) await unlink(path);
	}
}

/**
 * Who holds the lock, or `undefined` when nobody does. A lock this store did not write whole
 * has no `pid`, so it is never taken for a dead run's.
 */
async function readLock(path: string): Promise<{ runId: string; pid?: number } | undefined> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
	try {
		const { runId, pid } = JSON.parse(text) as { runId?: unknown; pid?: unknown };
		if (typeof runId === 'string' && Number.isInteger(pid)) return { runId, pid: pid as number };
	} catch {
		// Not JSON: named below as unknown.
	}
	return { runId: 'unknown' };
}

function contentPath(contentDirectory: string, hash: string): string {
	// Two levels, so no folder holds every file a workspace ever stored.
	return join(contentDirectory, hash.slice(0, 2), hash);
}

class FileRunJournal implements RunJournal {
	readonly runId: string;
	private readonly record: RunRecord;
	private readonly runDirectory: string;
	private readonly contentDirectory: string;
	private readonly journal: FileHandle;
	private readonly release: () => Promise<void>;
	private sequence = 0;
	// Appends run one after another, so the lines never interleave.
	private pending: Promise<unknown> = Promise.resolve();
	private finished = false;
	// Set when an append fails: it may have left part of a line, and anything after it would be
	// joined to that part and unreadable.
	private broken: unknown;

	constructor({
		record,
		runDirectory,
		contentDirectory,
		journal,
		release,
	}: {
		record: RunRecord;
		runDirectory: string;
		contentDirectory: string;
		journal: FileHandle;
		release: () => Promise<void>;
	}) {
		this.runId = record.runId;
		this.record = record;
		this.runDirectory = runDirectory;
		this.contentDirectory = contentDirectory;
		this.journal = journal;
		this.release = release;
	}

	async saveContent(content: Buffer): Promise<string> {
		this.assertOpen();
		const hash = hashOf(content);
		const path = contentPath(this.contentDirectory, hash);
		const stored = await stat(path).then(
			() => true,
			(error: unknown) => {
				if (isNotFound(error)) return false;
				throw error;
			},
		);
		if (!stored) {
			await makeDirectory(dirname(path));
			await writeDurably(path, content);
		}

		return hash;
	}

	async prepare(change: { path: string; before: FileState; after: FileState }): Promise<number> {
		this.assertOpen();
		const sequence = ++this.sequence;
		await this.append({ type: 'prepared', sequence, ...change });
		return sequence;
	}

	applied(sequence: number): Promise<void> {
		this.assertOpen();
		return this.append({ type: 'applied', sequence });
	}

	abandoned(sequence: number): Promise<void> {
		this.assertOpen();
		return this.append({ type: 'abandoned', sequence });
	}

	async finish(status: Exclude<RunStatus, 'running'>): Promise<void> {
		this.assertOpen();
		this.finished = true;
		try {
			await this.pending;
			await this.journal.close();
			const record: RunRecord = { ...this.record, status, finishedAt: new Date().toISOString() };
			await writeDurably(join(this.runDirectory, 'run.json'), JSON.stringify(record));
		} finally {
			await this.release();
		}
	}

	private append(line: JournalLine): Promise<void> {
		const write = this.pending.then(async () => {
			if (this.broken !== undefined) {
				throw new Error(`The journal of run ${this.runId} stopped after a failed write`, {
					cause: this.broken,
				});
			}
			try {
				await this.journal.appendFile(`${JSON.stringify(line)}\n`);
				await this.journal.sync();
			} catch (error) {
				this.broken = error ?? new Error('Unknown write failure');
				throw error;
			}
		});
		// The chain goes on, so each later append reports the broken journal to its own caller.
		this.pending = write.catch(() => undefined);
		return write;
	}

	private assertOpen(): void {
		if (this.finished) throw new Error(`Run ${this.runId} has already finished`);
	}
}
