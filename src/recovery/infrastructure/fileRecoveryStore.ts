import type { Session } from '#src/shared/domain/session';
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
import { dirname, isAbsolute, join, sep } from 'node:path';
import type { ILogger } from '#src/shared/domain/logger';
import { FolderClaims } from './folderClaims.ts';
import {
	type BranchCommit,
	type BranchWarning,
	type CommitState,
	commitStates,
	redoCommits,
	undoCommits,
} from './gitCommits.ts';
import {
	classifyHostFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import { Logger } from '#src/shared/infrastructure/logger';
import { type FileChange, fileChanges, sameState } from '../domain/fileChanges.ts';
import {
	historyStart,
	type FileState,
	type JournalEntry,
	type Manifest,
	type BranchMove,
	type CommitsPolicy,
	type ObservationMeasure,
	type MoveConflict,
	type RecordedCommits,
	type MoveOptions,
	NothingToMoveError,
	type Revision,
	type RecoveryStore,
	type RunJournal,
	type RunRecord,
	type RunStatus,
	type UnrecordedChange,
	WorkspaceBusyError,
	WorkspaceMovedError,
} from '../domain/recoveryStore.ts';
import { chainEntries, nextPruneStep } from '../domain/retention.ts';
import {
	HistoryExpiredError,
	redoTarget,
	type Route,
	route,
	UnknownRunError,
} from '../domain/runTree.ts';
import {
	currentState,
	hasRealParents,
	removeEmptyFolders,
	removeFile,
	removeTemporary,
	temporaryPath,
	writeFileState,
} from './workspaceFiles.ts';

const appName = 'mikode-harness';
// The store holds source code the agent touched: only its owner may read it.
const privateDirectory = 0o700;
const privateFile = 0o600;

const firstJournal = 'journal.jsonl';

// A run is roughly one prompt: enough to go back through a working session, not a project's life.
const defaultKeepRuns = 25;

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

/**
 * The runs and moves this process holds a workspace lock for and has not ended. A lock naming
 * this process and none of these was left by one whose release failed: it is as stale as a dead
 * process's, which a process that lives on would otherwise keep until it exits.
 */
const heldHere = new Set<string>();

/** Whether the holder of a lock is still at work. */
function isLiveHolder(holder: { runId: string; pid?: number }): boolean {
	// A holder that cannot be named cannot be shown to be gone.
	if (holder.pid === undefined) return true;
	if (holder.pid === process.pid) return heldHere.has(holder.runId);
	return isAlive(holder.pid);
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

const commitsPolicies: readonly unknown[] = ['keep', 'revert', 'reset'] satisfies CommitsPolicy[];

/** A move not finished yet: the next move or run finishes it before anything else. */
interface PendingMove {
	revision: number;
	from?: string;
	to?: string;
	reason?: string;
	/** Found by the steps already taken. */
	conflicts: MoveConflict[];
	/** What undoing does with the commits of the runs it undoes. Absent for `keep`. */
	commits?: CommitsPolicy;
	/**
	 * What it did with commits before undoing the files, and before redoing them: `{}` once git
	 * began, and its reports once it finished. Begun and not finished, the process stopped while
	 * git ran, and finishing the move does not run it again.
	 */
	gitUndo?: { done?: BranchMove[] };
	gitRedo?: { done?: BranchMove[] };
	/**
	 * The temporary a file is being restored through, named before it is created, so finishing
	 * the move removes this one and no file of the user's.
	 */
	temporary?: string;
}

/** `head.json`: the run the workspace is at, the moves made so far, and one in progress. */
interface Head {
	runId?: string;
	revision: number;
	pending?: PendingMove;
}

type JournalLine =
	| ({ type: 'prepared'; sequence: number } & Omit<JournalEntry, 'sequence' | 'status'>)
	| { type: 'applied' | 'abandoned'; sequence: number }
	| { type: 'observing'; sequence: number; manifest: string; by: string }
	| { type: 'observed'; sequence: number; measure?: ObservationMeasure }
	| ({ type: 'unrecorded'; sequence: number } & UnrecordedChange)
	| ({ type: 'committed'; sequence: number } & RecordedCommits);

/** An observation a run began and never finished: what its command changed is not recorded yet. */
interface OpenObservation {
	sequence: number;
	manifest: string;
	by: string;
}

/**
 * Stores `content` under its hash, unless it is stored already, and returns the hash and whether
 * it was new. It returns only once the content is on disk.
 */
async function storeContent(
	contentDirectory: string,
	content: Buffer,
): Promise<{ hash: string; written: boolean }> {
	const hash = hashOf(content);
	const path = contentPath(contentDirectory, hash);
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
	return { hash, written: !stored };
}

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
	readonly workspaceId: string;
	readonly writeFolders: readonly string[];
	private readonly root: string;
	private readonly directory: string;
	private readonly keepRuns: number;
	private readonly logger: ILogger;
	private readonly claims: FolderClaims;
	// What releases the claim of each run or move holding the workspace.
	private readonly releases = new Map<string, () => Promise<void>>();

	private constructor(
		root: string,
		directory: string,
		keepRuns: number,
		logger: ILogger,
		workspaceId: string,
		{ claims, folders }: { claims: FolderClaims; folders: string[] },
	) {
		this.root = root;
		this.directory = directory;
		this.keepRuns = keepRuns;
		this.logger = logger;
		this.workspaceId = workspaceId;
		this.claims = claims;
		this.writeFolders = folders;
	}

	static async open({
		root,
		directory = defaultStateDirectory(),
		keepRuns = defaultKeepRuns,
		logger = new Logger(),
		writeRoots = [],
	}: {
		root: string;
		/** Defaults to the platform's state directory. */
		directory?: string;
		/**
		 * The most runs kept per workspace, the one being recorded included. Defaults to 25. At
		 * least 3: the run the workspace is at is never removed, and the last run of its line has
		 * no next run to be chained into, so pruning can leave two runs besides the new one.
		 */
		keepRuns?: number;
		/** Where it reports a failure it absorbs. Defaults to standard error. */
		logger?: ILogger;
		/**
		 * The folders besides `root` that its runs may write in, such as the other `write` roots,
		 * so no worktree they lie in is removed while a run writes there.
		 */
		writeRoots?: readonly string[];
	}): Promise<FileRecoveryStore> {
		if (!Number.isInteger(keepRuns) || keepRuns < 3) {
			throw new RangeError(`keepRuns must be an integer of at least 3; got ${String(keepRuns)}`);
		}
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

		const folders = [
			realRoot,
			...(await Promise.all(writeRoots.map(path => realpath(path).catch(() => path)))),
		];
		// Real, so a state directory reached through a link is the history it holds.
		return new FileRecoveryStore(realRoot, workspace, keepRuns, logger, await realpath(workspace), {
			claims: new FolderClaims(await realpath(directory)),
			folders,
		});
	}

	async startRun({ session }: { session?: Session } = {}): Promise<RunJournal> {
		const runId = newRunId();
		try {
			// Inside, because taking the lock can fail after publishing it. Unlocking removes only a
			// lock naming this run, never another run's.
			await this.lock(runId);
			await this.settleInterrupted(runId);
			// A run starts where the user last sent the workspace.
			await this.finishPendingMove();
			// Before the new run exists, so it is never pruned, and after the move, so no run on its
			// route is.
			await this.prune();
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
				...(session ? { session } : {}),
			};
			await writeDurably(join(runDirectory, 'run.json'), JSON.stringify(record));
			// After the record, so the head never names a run that does not exist.
			await this.writeHead({ runId, revision: head.revision });
			const journal = await open(join(runDirectory, firstJournal), 'a', privateFile);
			await syncDirectory(runDirectory);

			return new FileRunJournal({
				record,
				runDirectory,
				contentDirectory: join(this.directory, 'content'),
				journal,
				discard: () => this.discardRun(record),
				settle: finished => this.settleAtFinish(finished),
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
		// A run retention removed or chained into a later one, whose folder a crash left behind, is
		// not in the history.
		const gone = new Set([
			...runs.flatMap(run => run.absorbed ?? []),
			...(await this.listPruned()),
		]);
		// A dead run that changed nothing is not in the history either, though its removal did not
		// finish. No run follows it: the next run or move removes it before starting.
		for (const run of runs) {
			if (run.status !== 'interrupted') continue;
			// A journal it cannot read leaves the run listed: whether it changed anything is unknown.
			const journal = await this.readJournal(run.runId, run.journal).catch(() => undefined);
			if (journal && changedNothing(journal)) gone.add(run.runId);
		}
		const parents = new Map(runs.map(run => [run.runId, run.parentRunId]));
		let { runId: head } = await this.readHead();
		while (head !== undefined && gone.has(head)) head = parents.get(head);

		return { ...(head ? { head } : {}), runs: runs.filter(run => !gone.has(run.runId)) };
	}

	async readRun(runId: string): Promise<{
		record: RunRecord;
		entries: JournalEntry[];
		unrecorded: UnrecordedChange[];
		commits: RecordedCommits[];
	}> {
		// An id from outside is checked before it names a folder.
		if (!runIdPattern.test(runId)) throw new UnknownRunError(runId);
		// The lock first: a run that finishes between the two reads then shows as finished, not as
		// a `running` record nobody holds.
		const holder = await readLock(join(this.directory, 'lock'));
		// Before the record: a crash can leave the folder of a run retention already took.
		await this.assertNotAbsorbed(runId);
		const record = await this.readRecord(runId).catch(async (error: unknown) => {
			if (!isNotFound(error)) throw error;
			// Retention may have taken it since the check above.
			await this.assertNotAbsorbed(runId);
			throw new UnknownRunError(runId);
		});
		const { entries, unrecorded, commits } = await this.readJournal(runId, record.journal);
		return {
			record: withLiveStatus(record, holder),
			entries,
			unrecorded: unrecorded.map(({ path, by }) => ({ path, by })),
			commits,
		};
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

	goTo(target: string, options: MoveOptions = {}): Promise<Revision> {
		return this.move(() => (target === historyStart ? undefined : target), options);
	}

	undo(options: MoveOptions = {}): Promise<Revision> {
		return this.move(({ runs, head }) => {
			if (head === undefined) throw new NothingToMoveError('undo');
			return runs.find(run => run.runId === head)?.parentRunId;
		}, options);
	}

	redo(options: MoveOptions = {}): Promise<Revision> {
		return this.move(({ runs, head, revisions }) => {
			const target = redoTarget(runs, revisions, head);
			if (target === undefined) throw new NothingToMoveError('redo');
			return target;
		}, options);
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
		{ reason, from, commits = 'keep' }: MoveOptions,
	): Promise<Revision> {
		if (!commitsPolicies.includes(commits)) {
			throw new RangeError(`commits must be keep, revert or reset; got ${JSON.stringify(commits)}`);
		}
		const moveId = `move-${newRunId()}`;
		try {
			await this.lock(moveId);
			await this.settleInterrupted(moveId);
			await this.finishPendingMove();
			const head = await this.readHead();
			// Only now, under the lock and once nothing is left unsettled, is the head the one the
			// move would start from.
			const at = head.runId ?? historyStart;
			if (from !== undefined && from !== at) throw new WorkspaceMovedError(from, at);
			const { runs } = await this.listRuns();
			const to = resolve({ runs, head: head.runId, revisions: await this.listRevisions() });
			if (to !== undefined && !runs.some(run => run.runId === to)) {
				await this.assertNotAbsorbed(to);
			}

			return await this.takeSteps(head, runs, {
				revision: head.revision + 1,
				...(head.runId ? { from: head.runId } : {}),
				...(to ? { to } : {}),
				...(reason === undefined ? {} : { reason }),
				...(commits === 'keep' ? {} : { commits }),
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
		const release = await this.claimFiles([...undo, ...redo]);
		try {
			return await this.stepAlong(head, runs, pending, { undo, redo });
		} finally {
			await release();
		}
	}

	/**
	 * Claims each file the runs on a route changed outside the folders this store claims: a run
	 * may have written in a folder this store was not opened with, such as a second root a history
	 * reopened by its first root alone does not know. A worktree holding one is not removed while
	 * the move writes there.
	 */
	private async claimFiles(runIds: readonly string[]): Promise<() => Promise<void>> {
		const outside = new Set<string>();
		for (const runId of runIds) {
			const { entries } = await this.readRun(runId);
			for (const { path } of fileChanges(entries, true)) {
				if (!this.writeFolders.some(folder => within(path, folder))) outside.add(path);
			}
		}
		if (outside.size === 0) return () => Promise.resolve();
		return this.claims.claimWriting(`files-${newRunId()}`, [...outside]);
	}

	private async stepAlong(
		head: Head,
		runs: RunRecord[],
		pending: PendingMove,
		{ undo, redo }: Route,
	): Promise<Revision> {
		const parents = new Map(runs.map(run => [run.runId, run.parentRunId]));
		let reached = head.runId;
		const save = () =>
			this.writeHead({ ...(reached ? { runId: reached } : {}), revision: head.revision, pending });

		// What a write the crash interrupted left beside its file.
		if (pending.temporary) {
			await removeTemporary(pending.temporary);
			delete pending.temporary;
		}
		await save();
		const announce = async (temporary: string | undefined) => {
			if (temporary === undefined) delete pending.temporary;
			else pending.temporary = temporary;
			await save();
		};
		const states = commitStates(await this.listRevisions());
		const warn: BranchWarning = (repository, branch, error) => {
			treatErrors(
				() => {
					this.logger.warn(
						`The history could not tell which commits ${branch} in ${repository} still holds, and reports every commit the move went over: ${describeFailure(error)}`,
					);
				},
				classifyHostFailure,
				'Recovery store logger failed while reporting commits it could not check',
			);
		};
		// Git first, while the files still hold what its commits do: a revert, a reset or a
		// cherry-pick then leaves each file where the step leads, and the step finds it there.
		const gitPhase = async (
			phase: 'gitUndo' | 'gitRedo',
			act: (interrupted: boolean) => Promise<BranchMove[]>,
		) => {
			const begun = pending[phase];
			if (begun?.done) return;
			if (!begun) {
				pending[phase] = {};
				await save();
			}
			pending[phase] = { done: await act(begun !== undefined) };
			await save();
		};

		await gitPhase('gitUndo', async interrupted =>
			undoCommits(await this.commitsOver(undo, 'undo', states), pending.commits ?? 'keep', {
				interrupted,
				warn,
			}),
		);
		for (const runId of undo) {
			pending.conflicts.push(...(await this.step(runId, 'undo', announce)));
			reached = parents.get(runId);
			await save();
		}
		await gitPhase('gitRedo', async interrupted =>
			redoCommits(await this.commitsOver(redo, 'redo', states), { interrupted, warn }),
		);
		for (const runId of redo) {
			pending.conflicts.push(...(await this.step(runId, 'redo', announce)));
			reached = runId;
			await save();
		}

		// Every write that started has finished, so no temporary is left to name.
		delete pending.temporary;
		const { conflicts, gitUndo, gitRedo, ...rest } = pending;
		delete rest.commits;
		const git = [...(gitUndo?.done ?? []), ...(gitRedo?.done ?? [])];
		const revision: Revision = {
			...rest,
			at: new Date().toISOString(),
			complete: conflicts.length === 0,
			conflicts,
			...(git.length > 0 ? { git } : {}),
		};
		await this.appendRevision(revision);
		await this.writeHead({
			...(pending.to ? { runId: pending.to } : {}),
			revision: pending.revision,
		});
		return revision;
	}

	/**
	 * The commits the runs made, in the order a move goes over them, newest first when it undoes
	 * them, each where the moves so far left it.
	 */
	private async commitsOver(
		runIds: readonly string[],
		direction: 'undo' | 'redo',
		states: ReadonlyMap<string, CommitState>,
	): Promise<BranchCommit[]> {
		const over: BranchCommit[] = [];
		for (const runId of runIds) {
			const { commits } = await this.readRun(runId);
			const made = commits.flatMap(({ repository, branch, commits: run, runId: madeIn }) =>
				run.map(({ sha, subject }): BranchCommit => {
					const state = states.get(sha);
					return {
						repository,
						branch,
						sha: state?.sha ?? sha,
						...(state && state.sha !== sha ? { original: sha } : {}),
						subject,
						runId: madeIn ?? runId,
						direction,
						...(state?.taken ? { taken: state.taken } : {}),
					};
				}),
			);
			over.push(...(direction === 'undo' ? made.reverse() : made));
		}
		return over;
	}

	/** Takes one run's changes back to its parent, or forward again, file by file. */
	private async step(
		runId: string,
		direction: 'undo' | 'redo',
		announce: (temporary: string | undefined) => Promise<void>,
	): Promise<MoveConflict[]> {
		const { entries, unrecorded } = await this.readRun(runId);
		const changes = fileChanges(entries, true);
		// What the history could not copy is left as it is, in either direction.
		const conflicting = new Set(unrecorded.map(change => change.path));
		// Undone newest first, so a folder the run created is empty by the time its file goes.
		for (const change of direction === 'undo' ? changes.reverse() : changes) {
			if (!(await this.moveFile(change, direction, announce))) conflicting.add(change.path);
		}
		return [...conflicting].map((path): MoveConflict => ({ path, runId }));
	}

	/**
	 * Writes the state the step leads to, only if the file holds the state it leaves. A file
	 * already there is left alone, so taking a step again is safe. Returns whether the file
	 * ends where the step leads.
	 */
	private async moveFile(
		change: FileChange,
		direction: 'undo' | 'redo',
		announce: (temporary: string | undefined) => Promise<void>,
	): Promise<boolean> {
		const [source, destination] =
			direction === 'undo' ? [change.after, change.before] : [change.before, change.after];
		// First, so a file reached through a folder that became a link is never taken for the
		// destination, and nothing is read or removed through it.
		if (!(await hasRealParents(change.path))) return false;
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

		if (destination.exists) {
			const temporary = temporaryPath(change.path);
			await announce(temporary);
			await writeFileState(
				change.path,
				await this.readContent(destination.hash),
				destination.mode,
				temporary,
			);
			await announce(undefined);
		} else {
			await removeFile(change.path);
			if (direction === 'undo') await removeEmptyFolders(change.createdFolders);
		}
		return true;
	}

	/** Throws `HistoryExpiredError` if retention removed `runId` or chained it into a later run. */
	private async assertNotAbsorbed(runId: string): Promise<void> {
		const { runs } = await this.listRuns();
		const keptIn = runs.find(run => run.absorbed?.includes(runId));
		if (keptIn) throw new HistoryExpiredError(runId, keptIn.runId);
		if ((await this.listPruned()).includes(runId)) throw new HistoryExpiredError(runId);
	}

	private async listPruned(): Promise<string[]> {
		try {
			const text = await readFile(join(this.directory, 'pruned.jsonl'), 'utf8');
			return text.split('\n').flatMap(line => {
				try {
					return [JSON.parse(line) as string];
				} catch {
					// Half a line a crash left, whose removal never happened.
					return [];
				}
			});
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
	}

	/**
	 * Brings the history down to `keepRuns - 1`, so the run about to start makes `keepRuns`, then
	 * frees the contents no run kept refers to.
	 */
	private async prune(): Promise<void> {
		await this.finishChains();
		const revisions = await this.listRevisions();
		for (;;) {
			const { head, runs } = await this.listRuns();
			const step = nextPruneStep(runs, revisions, head, this.keepRuns - 1);
			if (!step) break;
			if (step.kind === 'remove') await this.removeRun(step.runId);
			else await this.chain(step.runId, step.into);
		}
		await this.collectContent();
	}

	/**
	 * Chains the changes of `older` into `newer`, its child: `newer` then hangs from `older`'s
	 * parent and goes back to where `older` started. The new record is the commit point. Before
	 * it, the history is as it was; after it, `finishChains` removes what is left of `older`.
	 */
	private async chain(older: string, newer: string): Promise<void> {
		const olderRecord = await this.readRecord(older);
		const newerRecord = await this.readRecord(newer);
		const olderJournal = await this.readJournal(older, olderRecord.journal);
		const newerJournal = await this.readJournal(newer, newerRecord.journal);
		const entries = chainEntries(olderJournal.entries, newerJournal.entries);
		const journal = `journal-${randomBytes(4).toString('hex')}.jsonl`;
		const lines = entries.flatMap(({ status, sequence, ...change }): JournalLine[] => [
			{ type: 'prepared', sequence, ...change },
			...(status === 'prepared' ? [] : [{ type: status, sequence } as const]),
		]);
		// What either run could not copy stays uncopied: undoing the chain cannot take it back.
		for (const [index, { path, by }] of [
			...olderJournal.unrecorded,
			...newerJournal.unrecorded,
		].entries()) {
			lines.push({ type: 'unrecorded', sequence: entries.length + index + 1, path, by });
		}
		// The commits of both, oldest first, each still naming the run that made it: going back past
		// the chain goes back past them all.
		const commits = [
			...olderJournal.commits.map(made => ({ ...made, runId: made.runId ?? older })),
			...newerJournal.commits,
		];
		for (const made of commits) {
			lines.push({ type: 'committed', sequence: lines.length + 1, ...made });
		}
		await writeDurably(
			join(this.runDirectory(newer), journal),
			lines.map(line => `${JSON.stringify(line)}\n`).join(''),
		);

		const record: RunRecord = {
			...newerRecord,
			absorbed: [...(olderRecord.absorbed ?? []), older, ...(newerRecord.absorbed ?? [])],
			journal,
		};
		// It now hangs where `older` did: from its parent, or from the start.
		if (olderRecord.parentRunId) record.parentRunId = olderRecord.parentRunId;
		else delete record.parentRunId;
		await writeDurably(join(this.runDirectory(newer), 'run.json'), JSON.stringify(record));
		await this.finishChains();
	}

	/**
	 * Removes what a chain or a removal a crash interrupted left behind: the folders of runs
	 * pruned or absorbed by a kept run, and journals a run no longer reads.
	 */
	private async finishChains(): Promise<void> {
		for (const runId of await this.listPruned()) {
			await rm(this.runDirectory(runId), { recursive: true, force: true });
		}
		const { runs } = await this.listRuns();
		for (const run of runs) {
			for (const absorbed of run.absorbed ?? []) {
				await rm(this.runDirectory(absorbed), { recursive: true, force: true });
			}
			const current = run.journal ?? firstJournal;
			for (const name of await readdir(this.runDirectory(run.runId))) {
				if (name.startsWith('journal') && name.endsWith('.jsonl') && name !== current) {
					await rm(join(this.runDirectory(run.runId), name), { force: true });
				}
			}
		}
	}

	/**
	 * Removes a run whole, recording its id first so a move to it reports an expired history.
	 * Its record goes next, so a crash halfway leaves no run behind.
	 */
	private async removeRun(runId: string): Promise<void> {
		await appendWhole(join(this.directory, 'pruned.jsonl'), [runId]);
		// The log may be new: its entry in the folder must last before the run it names goes.
		await syncDirectory(this.directory);
		await rm(join(this.runDirectory(runId), 'run.json'), { force: true });
		await syncDirectory(this.runDirectory(runId));
		await rm(this.runDirectory(runId), { recursive: true, force: true });
	}

	/**
	 * Takes a run that changed nothing out of the history, under the lock: the workspace goes back
	 * to its parent first, so the head never names a run that is gone. Until the run is removed,
	 * `listRuns` already hides it, and the next run or move finishes removing it. The contents it
	 * saved are freed by the next prune.
	 */
	private async discardRun(record: RunRecord): Promise<void> {
		const { runId: headRunId, ...head } = await this.readHead();
		if (headRunId === record.runId) {
			await this.writeHead({
				...head,
				...(record.parentRunId ? { runId: record.parentRunId } : {}),
			});
		}
		await rm(join(this.runDirectory(record.runId), 'run.json'), { force: true });
		await syncDirectory(this.runDirectory(record.runId));
		await rm(this.runDirectory(record.runId), { recursive: true, force: true });
	}

	/**
	 * Removes the stored contents no kept run refers to. An observation still open refers to its
	 * manifest and to every content in it, which settling it needs.
	 */
	private async collectContent(): Promise<void> {
		const referenced = new Set<string>();
		for (const run of (await this.listRuns()).runs) {
			const { entries, observations } = await this.readJournal(run.runId, run.journal);
			for (const entry of entries) {
				for (const state of [entry.before, entry.after]) {
					if (state.exists) referenced.add(state.hash);
				}
			}
			for (const observation of observations) {
				referenced.add(observation.manifest);
				const stored = await this.readContent(observation.manifest).catch((error: unknown) => {
					// Never stored whole: settling it will find nothing to compare.
					if (isNotFound(error)) return undefined;
					throw error;
				});
				if (!stored) continue;
				const manifest = JSON.parse(stored.toString('utf8')) as Manifest;
				for (const state of Object.values(manifest.files)) {
					if (state.exists) referenced.add(state.hash);
				}
			}
		}
		const contentDirectory = join(this.directory, 'content');
		for (const prefix of await readdir(contentDirectory)) {
			for (const hash of await readdir(join(contentDirectory, prefix))) {
				if (hashPattern.test(hash) && !referenced.has(hash)) {
					await rm(join(contentDirectory, prefix, hash), { force: true });
				}
			}
		}
	}

	private async appendRevision(revision: Revision): Promise<void> {
		await appendWhole(join(this.directory, 'revisions.jsonl'), [revision]);
		await syncDirectory(this.directory);
	}

	/**
	 * Settles every other run left unfinished: one still recorded as `running` is `interrupted`,
	 * since this run holds the lock and its process is gone, and one that finished `unsettled`
	 * keeps its status.
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
			if (record?.status === 'running' || record?.unsettled) await this.settleRun(record);
		}
	}

	/**
	 * Settles a run that finished with an observation open, under its own lock, before it releases
	 * the workspace. If that fails, its record stays `unsettled`, and the next run or move settles
	 * it, so the failure is reported and not thrown.
	 */
	private async settleAtFinish(record: RunRecord): Promise<boolean> {
		try {
			return await this.settleRun(record, { finishing: true });
		} catch (error) {
			treatErrors(
				() => {
					this.logger.warn(
						`The history could not settle what run ${record.runId} was observing when it finished; the next run or move settles it: ${describeFailure(error)}`,
					);
				},
				classifyHostFailure,
				'Recovery store logger failed while reporting an unsettled run',
			);
			return true;
		}
	}

	/**
	 * Settles what a run left unfinished. Each change it left `prepared` is settled from what its
	 * file holds now: its `after` means it was made, its `before` that it was not. A file that holds
	 * neither stays `prepared`, because nothing tells whether the change reached it. Each
	 * observation it left open is settled from its manifest. A run still `running` becomes
	 * `interrupted`; any other keeps its status. Whether the run is still in the history: one that
	 * changed nothing leaves it if it was still `running`, or if it is `finishing`, which unties
	 * its turns from it. One that finished is kept otherwise, since the turns of a conversation may
	 * name it.
	 */
	private async settleRun(
		record: RunRecord,
		{ finishing = false }: { finishing?: boolean } = {},
	): Promise<boolean> {
		const { runId } = record;
		const journal = await this.readJournal(runId, record.journal);
		const lines: JournalLine[] = [];
		for (const entry of journal.entries) {
			if (entry.status !== 'prepared' || !isAbsolute(entry.path)) continue;
			const state = await currentState(entry.path);
			if (state && sameState(state, entry.after)) {
				lines.push({ type: 'applied', sequence: entry.sequence });
			} else if (state && sameState(state, entry.before)) {
				lines.push({ type: 'abandoned', sequence: entry.sequence });
			}
		}
		let sequence = journal.lastSequence;
		for (const observation of journal.observations) {
			const observed = await this.settleObservation(observation, journal, sequence);
			sequence += observed.length;
			lines.push(...observed);
		}
		await appendWhole(join(this.runDirectory(runId), record.journal ?? firstJournal), lines);
		const leaves = finishing || record.status === 'running';
		if (leaves && changedNothing(await this.readJournal(runId, record.journal))) {
			await this.discardRun(record);
			return false;
		}
		const settled: RunRecord = {
			...record,
			status: record.status === 'running' ? 'interrupted' : record.status,
		};
		delete settled.unsettled;
		// Last, so a crash before it leaves a run that is settled again, and settling is idempotent.
		await writeDurably(join(this.runDirectory(runId), 'run.json'), JSON.stringify(settled));
		return true;
	}

	/**
	 * The lines that record what a command an interrupted run was observing changed: every file of
	 * its manifest that holds something else now, as changed by that command, and then the end of
	 * the observation. A file recorded after the observation began is left alone: the run
	 * recorded it itself. One that is now a folder, a link or too large to record, or that was one
	 * and is no longer, or that cannot be read, is recorded as a change the history could not copy.
	 */
	private async settleObservation(
		observation: OpenObservation,
		{
			entries,
			unrecorded: uncopied,
		}: { entries: JournalEntry[]; unrecorded: { sequence: number; path: string }[] },
		lastSequence: number,
	): Promise<JournalLine[]> {
		const stored = await this.readContent(observation.manifest).catch((error: unknown) => {
			if (isNotFound(error)) return undefined;
			throw error;
		});
		// Its manifest was never stored whole: the command it was saved for never started.
		if (!stored) return [{ type: 'observed', sequence: observation.sequence }];
		const manifest = JSON.parse(stored.toString('utf8')) as Manifest;
		// What the run recorded itself after the observation began, its changes and those it could
		// not copy, such as when a command could not be confirmed stopped.
		const recorded = new Set(
			[...entries, ...uncopied]
				.filter(line => line.sequence > observation.sequence)
				.map(line => line.path),
		);
		const lines: JournalLine[] = [];
		let sequence = lastSequence;
		const unrecorded = (path: string): JournalLine => ({
			type: 'unrecorded',
			sequence: ++sequence,
			path,
			by: observation.by,
		});
		for (const [path, before] of Object.entries(manifest.files)) {
			if (!isAbsolute(path) || recorded.has(path)) continue;
			const after = await this.saveState(path);
			if (after === undefined || after === 'unreadable') {
				lines.push(unrecorded(path));
				continue;
			}
			if (sameState(after, before)) continue;
			sequence++;
			lines.push(
				{ type: 'prepared', sequence, path, before, after, observedBy: observation.by },
				{ type: 'applied', sequence },
			);
		}
		// What it held before is unknown, so only a path that is no longer uncopyable has changed.
		for (const path of manifest.uncopyable ?? []) {
			if (!isAbsolute(path) || recorded.has(path)) continue;
			const now = await currentState(path).catch((error: unknown) => {
				this.warnUnreadable(path, error);
				return 'unreadable' as const;
			});
			if (now !== undefined) lines.push(unrecorded(path));
		}
		lines.push({ type: 'observed', sequence: observation.sequence });
		return lines;
	}

	private warnUnreadable(path: string, error: unknown): void {
		treatErrors(
			() => {
				this.logger.warn(
					`The history could not read ${path} to settle what a command changed, and records it as a change undo cannot take back: ${describeFailure(error)}`,
				);
			},
			classifyHostFailure,
			'Recovery store logger failed while reporting an unreadable file',
		);
	}

	/**
	 * What `path` holds now, with its content stored, or `undefined` for what no entry records.
	 * A file it cannot read is `unreadable`, and reported: it cannot be undone either, and settling
	 * never waits on it, or every later run would fail to start. A failure to store its content is
	 * thrown, so the observation stays open and settling it is tried again.
	 */
	private async saveState(path: string): Promise<FileState | undefined | 'unreadable'> {
		let state: FileState | undefined;
		let content: Buffer | undefined;
		try {
			state = await currentState(path);
			if (!state?.exists) return state;
			content = await readFile(path).catch((error: unknown) => {
				if (isNotFound(error)) return undefined;
				throw error;
			});
		} catch (error) {
			this.warnUnreadable(path, error);
			return 'unreadable';
		}
		if (!content) return { exists: false };
		const { hash } = await storeContent(join(this.directory, 'content'), content);
		// Read again: the file may have changed between hashing it and storing it.
		return hash === state.hash ? state : this.saveState(path);
	}

	private async readEntries(runId: string, journal = firstJournal): Promise<JournalEntry[]> {
		return (await this.readJournal(runId, journal)).entries;
	}

	/**
	 * A run's changes, the observations it began and never finished, and the highest sequence
	 * number its journal uses, which the next line it gets must exceed.
	 */
	private async readJournal(
		runId: string,
		journal = firstJournal,
	): Promise<{
		entries: JournalEntry[];
		observations: OpenObservation[];
		/** With the sequence of its line, which `readRun` leaves out. */
		unrecorded: (UnrecordedChange & { sequence: number })[];
		commits: RecordedCommits[];
		lastSequence: number;
	}> {
		let text: string;
		try {
			text = await readFile(join(this.runDirectory(runId), journal), 'utf8');
		} catch (error) {
			// A run that stopped before opening its journal never changed anything.
			if (isNotFound(error)) {
				return { entries: [], observations: [], unrecorded: [], commits: [], lastSequence: 0 };
			}
			throw error;
		}
		const lines = text.split('\n');

		const entries = new Map<number, JournalEntry>();
		const observations = new Map<number, OpenObservation>();
		const unrecorded: (UnrecordedChange & { sequence: number })[] = [];
		const commits: RecordedCommits[] = [];
		let lastSequence = 0;
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
			lastSequence = Math.max(lastSequence, line.sequence);
			if (line.type === 'prepared') {
				const { sequence, path, before, after, createdFolders, observedBy } = line;
				entries.set(sequence, {
					sequence,
					path,
					before,
					after,
					...(createdFolders ? { createdFolders } : {}),
					...(observedBy === undefined ? {} : { observedBy }),
					status: 'prepared',
				});
				return;
			}
			if (line.type === 'observing') {
				const { sequence, manifest, by } = line;
				observations.set(sequence, { sequence, manifest, by });
				return;
			}
			if (line.type === 'observed') {
				observations.delete(line.sequence);
				return;
			}
			if (line.type === 'unrecorded') {
				unrecorded.push({ sequence: line.sequence, path: line.path, by: line.by });
				return;
			}
			if (line.type === 'committed') {
				const { repository, branch, commits: made, by, runId: madeIn } = line;
				commits.push({
					repository,
					branch,
					commits: made,
					by,
					...(madeIn ? { runId: madeIn } : {}),
				});
				return;
			}
			const entry = entries.get(line.sequence);
			if (entry) entry.status = line.type;
		});

		return {
			entries: [...entries.values()],
			observations: [...observations.values()],
			unrecorded,
			commits,
			lastSequence,
		};
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
				heldHere.add(runId);
				// Under the lock: a removal of a worktree this run may write in keeps it out. The
				// caller unlocks when this throws.
				this.releases.set(runId, await this.claims.claimWriting(runId, this.writeFolders));
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}

			const holder = await readLock(path);
			// Released meanwhile: try again.
			if (!holder) continue;
			if (isLiveHolder(holder)) throw new WorkspaceBusyError(holder.runId);
			// Its process died, or its run ended, without releasing it. Read again just before
			// removing, so a lock another run has just taken is left alone.
			const again = await readLock(path);
			if (again !== undefined && again.pid === holder.pid && again.runId === holder.runId) {
				await unlink(path).catch((error: unknown) => {
					if (!isNotFound(error)) throw error;
				});
			}
		}

		throw new WorkspaceBusyError((await readLock(path))?.runId ?? 'unknown');
	}

	private async unlock(runId: string): Promise<void> {
		// First: the run has ended even if removing its lock fails, so that lock is stale.
		heldHere.delete(runId);
		const release = this.releases.get(runId);
		this.releases.delete(runId);
		await release?.();
		const path = join(this.directory, 'lock');
		// Only its own lock: one cleared as stale and taken by another run is not this run's.
		if ((await readLock(path))?.runId === runId) await unlink(path);
	}
}

/**
 * No change it recorded may have reached a file: it recorded none, or abandoned each one, none
 * it could not copy, and no commit.
 */
function changedNothing({
	entries,
	unrecorded,
	commits,
}: {
	entries: JournalEntry[];
	unrecorded: UnrecordedChange[];
	commits: RecordedCommits[];
}): boolean {
	return (
		unrecorded.length === 0 &&
		commits.length === 0 &&
		entries.every(entry => entry.status === 'abandoned')
	);
}

/**
 * A run recorded as `running` only runs while it holds the lock, its process lives, and, in this
 * process, it has not ended. Any other is reported as `interrupted`, before the next run settles
 * it.
 */
function withLiveStatus(
	record: RunRecord,
	holder: { runId: string; pid?: number } | undefined,
): RunRecord {
	if (record.status !== 'running') return record;
	const live = holder?.runId === record.runId && holder.pid !== undefined && isLiveHolder(holder);
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

function within(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}${sep}`);
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
	private readonly discard: () => Promise<void>;
	private readonly settle: (record: RunRecord) => Promise<boolean>;
	private readonly release: () => Promise<void>;
	private sequence = 0;
	private stored = 0;
	// For the content state: what each change will leave, what each file held before the run first
	// changed it, and what it holds since its last applied change.
	private readonly pendingStates = new Map<number, { path: string; after: FileState }>();
	private readonly firstStates = new Map<string, FileState>();
	private readonly currentStates = new Map<string, FileState>();
	private readonly appliedInOrder: string[] = [];
	private state: { applied: number; hash: string } | undefined;
	// The changes recorded as prepared and not abandoned: those that may have reached a file. One
	// whose `prepared` line failed is not here, since nothing writes a file before that line.
	private readonly effects = new Set<number>();
	// The observations begun and not yet observed: what they saw is not all recorded.
	private readonly observing = new Set<number>();
	// A change it could not copy reached a file, and stays in the history.
	private lost = false;
	// A command it ran made a commit, which a move over it names.
	private committedAny = false;
	// Settling what it left open as it finished found that it changed nothing.
	private settledEmpty = false;
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
		discard,
		settle,
		release,
	}: {
		record: RunRecord;
		runDirectory: string;
		contentDirectory: string;
		journal: FileHandle;
		discard: () => Promise<void>;
		/**
		 * Settles the run's open observations, once its record names it `unsettled`, and tells
		 * whether the run is still in the history.
		 */
		settle: (record: RunRecord) => Promise<boolean>;
		release: () => Promise<void>;
	}) {
		this.runId = record.runId;
		this.record = record;
		this.runDirectory = runDirectory;
		this.contentDirectory = contentDirectory;
		this.journal = journal;
		this.discard = discard;
		this.settle = settle;
		this.release = release;
	}

	async saveContent(content: Buffer): Promise<string> {
		this.assertOpen();
		const { hash, written } = await storeContent(this.contentDirectory, content);
		if (written) this.stored += content.length;
		return hash;
	}

	async prepare(change: Omit<JournalEntry, 'sequence' | 'status'>): Promise<number> {
		this.assertOpen();
		const sequence = ++this.sequence;
		await this.append({ type: 'prepared', sequence, ...change });
		this.effects.add(sequence);
		this.pendingStates.set(sequence, { path: change.path, after: change.after });
		if (!this.firstStates.has(change.path)) this.firstStates.set(change.path, change.before);
		return sequence;
	}

	async applied(sequence: number): Promise<void> {
		this.assertOpen();
		await this.append({ type: 'applied', sequence });
		const change = this.pendingStates.get(sequence);
		if (!change) return;
		this.pendingStates.delete(sequence);
		this.currentStates.set(change.path, change.after);
		this.appliedInOrder.push(change.path);
	}

	async abandoned(sequence: number): Promise<void> {
		this.assertOpen();
		await this.append({ type: 'abandoned', sequence });
		// Only once recorded: a change whose abandonment was not may still count as made.
		this.effects.delete(sequence);
		this.pendingStates.delete(sequence);
	}

	async observe(manifest: string, by: string): Promise<number> {
		this.assertOpen();
		const sequence = ++this.sequence;
		await this.append({ type: 'observing', sequence, manifest, by });
		// Until it is observed, whatever ran may have changed a file.
		this.effects.add(sequence);
		this.observing.add(sequence);
		return sequence;
	}

	async observed(sequence: number, measure?: ObservationMeasure): Promise<void> {
		this.assertOpen();
		await this.append({ type: 'observed', sequence, ...(measure ? { measure } : {}) });
		// Its changes, if any, are entries of their own now.
		this.effects.delete(sequence);
		this.observing.delete(sequence);
	}

	async unrecorded(path: string, by: string): Promise<void> {
		this.assertOpen();
		await this.append({ type: 'unrecorded', sequence: ++this.sequence, path, by });
		this.lost = true;
	}

	async committed(commits: RecordedCommits): Promise<void> {
		this.assertOpen();
		await this.append({ type: 'committed', sequence: ++this.sequence, ...commits });
		this.committedAny = true;
	}

	get storedBytes(): number {
		return this.stored;
	}

	get appliedPaths(): readonly string[] {
		return this.appliedInOrder;
	}

	// Computed again only after a change was applied.
	contentState(): string {
		if (this.state?.applied !== this.appliedInOrder.length) {
			const changed = [...this.currentStates]
				.filter(([path, current]) => {
					const first = this.firstStates.get(path);
					return !first || !sameState(first, current);
				})
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			this.state = {
				applied: this.appliedInOrder.length,
				hash: hashOf(Buffer.from(JSON.stringify(changed))),
			};
		}
		return this.state.hash;
	}

	get changed(): boolean {
		return !this.settledEmpty && (this.lost || this.committedAny || this.effects.size > 0);
	}

	async finish(status: Exclude<RunStatus, 'running' | 'interrupted'>): Promise<void> {
		this.assertOpen();
		this.finished = true;
		try {
			await this.pending;
			await this.journal.close();
			// Its record is left `running`: if removing it fails, readers already take it as gone.
			if (!this.changed) {
				await this.discard();
				return;
			}
			const unsettled = this.observing.size > 0;
			const record: RunRecord = {
				...this.record,
				status,
				finishedAt: new Date().toISOString(),
				...(unsettled ? { unsettled } : {}),
			};
			await writeDurably(join(this.runDirectory, 'run.json'), JSON.stringify(record));
			// Recorded first as unsettled, so a failure or a crash here leaves it to the next run.
			if (unsettled) this.settledEmpty = !(await this.settle(record));
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
