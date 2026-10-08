import { createHash, randomBytes } from 'node:crypto';
import {
	link,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	truncate,
	unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { type FileChange, fileChanges, sameState } from '../domain/fileChanges.ts';
import {
	historyStart,
	type JournalEntry,
	type MoveConflict,
	NothingToMoveError,
	type Revision,
	type RecoveryStore,
	type RunJournal,
	type RunRecord,
	type RunStatus,
	WorkspaceBusyError,
} from '../domain/recoveryStore.ts';
import { redoTarget, route } from '../domain/runTree.ts';
import {
	currentState,
	hasRealParents,
	removeEmptyFolders,
	removeFile,
	writeFileState,
} from './workspaceFiles.ts';

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

/** A move not finished yet: the next move or run finishes it before anything else. */
interface PendingMove {
	revision: number;
	from?: string;
	to?: string;
	reason?: string;
	/** Found by the steps already taken. */
	conflicts: MoveConflict[];
}

/** `head.json`: the run the workspace is at, the moves made so far, and one in progress. */
interface Head {
	runId?: string;
	revision: number;
	pending?: PendingMove;
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
 *   head.json                 the run the workspace is at, and a move in progress
 *   revisions.jsonl           every move of the workspace through its history
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
		try {
			// Inside, because taking the lock can fail after publishing it. Unlocking removes only a
			// lock naming this run, never another run's.
			await this.lock(runId);
			await this.settleInterrupted(runId);
			// A run starts where the user last sent the workspace.
			await this.finishPendingMove();
			const head = await this.readHead();
			const parentRunId = head.runId;
			const runDirectory = join(this.directory, 'runs', runId);
			await makeDirectory(runDirectory);
			const record: RunRecord = {
				runId,
				root: this.root,
				...(parentRunId ? { parentRunId } : {}),
				startedAt: new Date().toISOString(),
				status: 'running',
				pid: process.pid,
			};
			await writeDurably(join(runDirectory, 'run.json'), JSON.stringify(record));
			// After the record, so the head never names a run that does not exist.
			await this.writeHead({ runId, revision: head.revision });
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

	async listRuns(): Promise<{ head?: string; runs: RunRecord[] }> {
		const ids = (await readdir(join(this.directory, 'runs'))).filter(id => runIdPattern.test(id));
		const holder = await readLock(join(this.directory, 'lock'));
		const runs: RunRecord[] = [];
		for (const runId of ids.sort()) {
			const record = await this.readRecord(runId).catch((error: unknown) => {
				// A crash between creating a run's folder and writing its record leaves the folder
				// empty: that run never changed anything.
				if (isNotFound(error)) return undefined;
				throw error;
			});
			if (record) runs.push(withLiveStatus(record, holder));
		}
		const { runId: head } = await this.readHead();

		return { ...(head ? { head } : {}), runs };
	}

	async readRun(runId: string): Promise<{ record: RunRecord; entries: JournalEntry[] }> {
		// The lock first: a run that finishes between the two reads then shows as finished, not as
		// a `running` record nobody holds.
		const holder = await readLock(join(this.directory, 'lock'));
		const record = withLiveStatus(await this.readRecord(runId), holder);
		return { record, entries: await this.readEntries(runId) };
	}

	private async readRecord(runId: string): Promise<RunRecord> {
		return JSON.parse(
			await readFile(join(this.runDirectory(runId), 'run.json'), 'utf8'),
		) as RunRecord;
	}

	private runDirectory(runId: string): string {
		// The id names a folder, so it must never be a path of its own.
		if (!runIdPattern.test(runId)) throw new Error(`Not a run id: ${runId}`);
		return join(this.directory, 'runs', runId);
	}

	private async readHead(): Promise<Head> {
		try {
			const head = JSON.parse(
				await readFile(join(this.directory, 'head.json'), 'utf8'),
			) as Partial<Head>;
			return { ...head, revision: head.revision ?? 0 };
		} catch (error) {
			if (isNotFound(error)) return { revision: 0 };
			throw error;
		}
	}

	private async writeHead(head: Head): Promise<void> {
		await writeDurably(join(this.directory, 'head.json'), JSON.stringify(head));
	}

	goTo(target: string, { reason }: { reason?: string } = {}): Promise<Revision> {
		return this.move(() => (target === historyStart ? undefined : target), reason);
	}

	undo({ reason }: { reason?: string } = {}): Promise<Revision> {
		return this.move(({ runs, head }) => {
			if (head === undefined) throw new NothingToMoveError('undo');
			return runs.find(run => run.runId === head)?.parentRunId;
		}, reason);
	}

	redo({ reason }: { reason?: string } = {}): Promise<Revision> {
		return this.move(({ runs, head, revisions }) => {
			const target = redoTarget(runs, revisions, head);
			if (target === undefined) throw new NothingToMoveError('redo');
			return target;
		}, reason);
	}

	async listRevisions(): Promise<Revision[]> {
		let text: string;
		try {
			text = await readFile(join(this.directory, 'revisions.jsonl'), 'utf8');
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const lines = text.split('\n');
		return lines.flatMap((line, index) => {
			if (line === '') return [];
			try {
				return [JSON.parse(line) as Revision];
			} catch (error) {
				// A crash in the middle of an append leaves half a line, always the last one. Its
				// move is still pending, and finishing it records it again.
				if (index === lines.length - 1) return [];
				throw new Error(`The history of this workspace is corrupt at line ${String(index + 1)}`, {
					cause: error,
				});
			}
		});
	}

	/** Holds the workspace like a run does, then moves it to the run `resolve` picks. */
	private async move(
		resolve: (history: {
			runs: RunRecord[];
			head: string | undefined;
			revisions: Revision[];
		}) => string | undefined,
		reason: string | undefined,
	): Promise<Revision> {
		const moveId = `move-${newRunId()}`;
		try {
			await this.lock(moveId);
			await this.settleInterrupted(moveId);
			await this.finishPendingMove();
			const head = await this.readHead();
			const { runs } = await this.listRuns();
			const to = resolve({ runs, head: head.runId, revisions: await this.listRevisions() });

			return await this.takeSteps(head, runs, {
				revision: head.revision + 1,
				...(head.runId ? { from: head.runId } : {}),
				...(to ? { to } : {}),
				...(reason === undefined ? {} : { reason }),
				conflicts: [],
			});
		} finally {
			await this.unlock(moveId);
		}
	}

	/** Finishes a move whose process stopped halfway, from the run its last step reached. */
	private async finishPendingMove(): Promise<void> {
		const head = await this.readHead();
		const { pending } = head;
		if (!pending) return;
		// It was recorded, and only clearing it from the head was missing.
		if ((await this.listRevisions()).some(revision => revision.revision === pending.revision)) {
			await this.writeHead({
				...(pending.to ? { runId: pending.to } : {}),
				revision: pending.revision,
			});
			return;
		}
		await this.takeSteps(head, (await this.listRuns()).runs, pending);
	}

	/**
	 * Undoes, then redoes, one run at a time from where the head is to `pending.to`. After each
	 * step the head names the run reached, with the move still pending, so a crash loses at
	 * most the step in progress, and that step is safe to take again.
	 */
	private async takeSteps(head: Head, runs: RunRecord[], pending: PendingMove): Promise<Revision> {
		const { undo, redo } = route(runs, head.runId, pending.to);
		const parents = new Map(runs.map(run => [run.runId, run.parentRunId]));
		let reached = head.runId;
		const save = () =>
			this.writeHead({ ...(reached ? { runId: reached } : {}), revision: head.revision, pending });

		await save();
		for (const runId of undo) {
			pending.conflicts.push(...(await this.step(runId, 'undo')));
			reached = parents.get(runId);
			await save();
		}
		for (const runId of redo) {
			pending.conflicts.push(...(await this.step(runId, 'redo')));
			reached = runId;
			await save();
		}

		const { conflicts, ...rest } = pending;
		const revision: Revision = {
			...rest,
			at: new Date().toISOString(),
			complete: conflicts.length === 0,
			conflicts,
		};
		await this.appendRevision(revision);
		await this.writeHead({
			...(pending.to ? { runId: pending.to } : {}),
			revision: pending.revision,
		});
		return revision;
	}

	/** Takes one run's changes back to its parent, or forward again, file by file. */
	private async step(runId: string, direction: 'undo' | 'redo'): Promise<MoveConflict[]> {
		const { entries } = await this.readRun(runId);
		const changes = fileChanges(entries, true);
		const conflicts: MoveConflict[] = [];
		// Undone newest first, so a folder the run created is empty by the time its file goes.
		for (const change of direction === 'undo' ? changes.reverse() : changes) {
			if (!(await this.moveFile(change, direction))) conflicts.push({ path: change.path, runId });
		}
		return conflicts;
	}

	/**
	 * Writes the state the step leads to, only if the file holds the state it leaves. A file
	 * already there is left alone, so taking a step again is safe. Returns whether the file
	 * ends where the step leads.
	 */
	private async moveFile(change: FileChange, direction: 'undo' | 'redo'): Promise<boolean> {
		const [source, destination] =
			direction === 'undo' ? [change.after, change.before] : [change.before, change.after];
		const current = await currentState(change.path);

		if (current && sameState(current, destination)) {
			if (direction === 'undo' && !destination.exists) {
				await removeEmptyFolders(change.createdFolders);
			}
			return true;
		}
		if (!current || !sameState(current, source)) return false;
		// Someone wrote to the file between two of the run's changes, and going back to before
		// the first would discard that.
		if (direction === 'undo' && !change.continuous) return false;
		if (!(await hasRealParents(change.path))) return false;

		if (destination.exists) {
			await writeFileState(change.path, await this.readContent(destination.hash), destination.mode);
		} else {
			await removeFile(change.path);
			if (direction === 'undo') await removeEmptyFolders(change.createdFolders);
		}
		return true;
	}

	private async appendRevision(revision: Revision): Promise<void> {
		await appendWhole(join(this.directory, 'revisions.jsonl'), [revision]);
		await syncDirectory(this.directory);
	}

	/**
	 * Marks every other run still recorded as `running` as `interrupted`: this run holds the lock,
	 * so their processes are gone. Each change one left `prepared` is settled from what its file
	 * holds now: its `after` means it was made, its `before` that it was not. A file that holds
	 * neither stays `prepared`, because nothing tells whether the change reached it.
	 */
	private async settleInterrupted(ownRunId: string): Promise<void> {
		const ids = (await readdir(join(this.directory, 'runs'))).filter(
			id => runIdPattern.test(id) && id !== ownRunId,
		);
		for (const runId of ids) {
			const record = await this.readRecord(runId).catch((error: unknown) => {
				if (isNotFound(error)) return undefined;
				throw error;
			});
			if (record?.status !== 'running') continue;

			const settled: JournalLine[] = [];
			for (const entry of await this.readEntries(runId)) {
				if (entry.status !== 'prepared' || !isAbsolute(entry.path)) continue;
				const state = await currentState(entry.path);
				if (state && sameState(state, entry.after)) {
					settled.push({ type: 'applied', sequence: entry.sequence });
				} else if (state && sameState(state, entry.before)) {
					settled.push({ type: 'abandoned', sequence: entry.sequence });
				}
			}
			await appendWhole(join(this.runDirectory(runId), 'journal.jsonl'), settled);
			// Last, so a crash before it leaves a run that is settled again, and settling is idempotent.
			await writeDurably(
				join(this.runDirectory(runId), 'run.json'),
				JSON.stringify({ ...record, status: 'interrupted' } satisfies RunRecord),
			);
		}
	}

	private async readEntries(runId: string): Promise<JournalEntry[]> {
		let text: string;
		try {
			text = await readFile(join(this.runDirectory(runId), 'journal.jsonl'), 'utf8');
		} catch (error) {
			// A run that stopped before opening its journal never changed anything.
			if (isNotFound(error)) return [];
			throw error;
		}
		const lines = text.split('\n');

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
				const { sequence, path, before, after, createdFolders } = line;
				entries.set(sequence, {
					sequence,
					path,
					before,
					after,
					...(createdFolders ? { createdFolders } : {}),
					status: 'prepared',
				});
				return;
			}
			const entry = entries.get(line.sequence);
			if (entry) entry.status = line.type;
		});

		return [...entries.values()];
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
 * A run recorded as `running` only runs while it holds the lock and its process lives. Any
 * other is reported as `interrupted`, before the next run settles it.
 */
function withLiveStatus(
	record: RunRecord,
	holder: { runId: string; pid?: number } | undefined,
): RunRecord {
	if (record.status !== 'running') return record;
	const live = holder?.runId === record.runId && holder.pid !== undefined && isAlive(holder.pid);
	return live ? record : { ...record, status: 'interrupted' };
}

/**
 * Appends `lines`, as JSON, to a file of one line each, created private if missing. A crash may
 * have left its last line without a newline. A whole line, which the readers already count, is
 * kept and ended. Half a line would join the first new line, so it is cut off: whatever was
 * writing it never returned.
 */
async function appendWhole(path: string, lines: unknown[]): Promise<void> {
	if (lines.length === 0) return;
	let text = '';
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	const last = text.slice(text.lastIndexOf('\n') + 1);
	let separator = '';
	if (last !== '') {
		if (isWholeLine(last)) separator = '\n';
		else await truncate(path, Buffer.byteLength(text) - Buffer.byteLength(last));
	}
	const journal = await open(path, 'a', privateFile);
	try {
		await journal.appendFile(separator + lines.map(line => `${JSON.stringify(line)}\n`).join(''));
		await journal.sync();
	} finally {
		await journal.close();
	}
}

function isWholeLine(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
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

	async prepare(change: Omit<JournalEntry, 'sequence' | 'status'>): Promise<number> {
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

	async finish(status: Exclude<RunStatus, 'running' | 'interrupted'>): Promise<void> {
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
