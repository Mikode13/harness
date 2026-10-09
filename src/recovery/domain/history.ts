import { changedFiles, displayPath, showChanges } from './runChanges.ts';
import type { RecoveryStore, Revision, RunStatus } from './recoveryStore.ts';
import { HistoryExpiredError } from './runTree.ts';

/** One run that wrote to the workspace. */
export interface HistoryRun {
	runId: string;
	/** The run the workspace was at when this one started; absent when it started at the start. */
	parentRunId?: string;
	/**
	 * Runs whose changes retention chained into this one, oldest first: going back past this run
	 * goes back past them too. An id an earlier `AgentResponse` gave may be found here.
	 */
	absorbed?: string[];
	status: RunStatus;
	startedAt: string;
	finishedAt?: string;
	/**
	 * The files it changed, in the order it first touched each one: relative to the root, or the
	 * real path of a file outside it. A host decides whether to show them.
	 */
	files: string[];
}

/** One move of the workspace through its history. */
export interface Move {
	/** The run the workspace was at; absent for the start of the history. */
	from?: string;
	/** The run the workspace is at now; absent for the start of the history. */
	to?: string;
	at: string;
	reason?: string;
	/** Every file reached the state the history expected. Otherwise `conflicts` names those left. */
	complete: boolean;
	/**
	 * The files left as they were because they did not hold what the history expected, such as
	 * one the user edited since, and the run whose change could not be undone or redone.
	 */
	conflicts: { path: string; runId: string }[];
}

/**
 * The history of the runs that wrote to one workspace: what each run changed, and moving the
 * workspace back and forward through them. Runs form a tree: going back and writing again
 * starts a new branch, and the earlier one stays reachable with `goTo`.
 */
export interface History {
	/**
	 * Every run kept, oldest first, and the run the workspace is at (`head`), absent at the start
	 * of the history. A run whose process died while writing is `interrupted`.
	 */
	list(): Promise<{ head?: string; runs: HistoryRun[] }>;
	/**
	 * What a run changed, as a git-style diff per file. What does not fit in `maxLines`, 1000 by
	 * default, is named instead.
	 *
	 * @throws {UnknownRunError} when `runId` was never a run of this workspace.
	 * @throws {HistoryExpiredError} when retention removed it or chained it into a later run.
	 */
	changes(runId: string, options?: { maxLines?: number }): Promise<string>;
	/**
	 * Moves the workspace to the state right after `target`, or to how it was before any run with
	 * `historyStart`. A file that does not hold what the history expects is left as it is, and the
	 * move is then not `complete`.
	 *
	 * @throws {WorkspaceBusyError} when a run or another move holds the workspace.
	 * @throws {UnknownRunError} when `target` is not in the history.
	 * @throws {HistoryExpiredError} when retention chained `target` into a later run.
	 */
	goTo(target: string, options?: { reason?: string }): Promise<Move>;
	/**
	 * Moves the workspace to the run before the one it is at.
	 *
	 * @throws {NothingToMoveError} at the start of the history.
	 * @throws {WorkspaceBusyError} when a run or another move holds the workspace.
	 */
	undo(options?: { reason?: string }): Promise<Move>;
	/**
	 * Moves the workspace to the next run: towards where it was most recently, or else the newest
	 * branch.
	 *
	 * @throws {NothingToMoveError} when no run follows the one it is at.
	 * @throws {WorkspaceBusyError} when a run or another move holds the workspace.
	 */
	redo(options?: { reason?: string }): Promise<Move>;
}

/** `History` over a recovery store, with paths shown relative to the workspace's real root. */
export class StoreHistory implements History {
	private readonly store: RecoveryStore;
	private readonly root: string;

	constructor({ store, root }: { store: RecoveryStore; root: string }) {
		this.store = store;
		this.root = root;
	}

	async list(): Promise<{ head?: string; runs: HistoryRun[] }> {
		const { head, runs } = await this.store.listRuns();
		const listed: HistoryRun[] = [];
		for (const run of runs) {
			const read = await this.store.readRun(run.runId).catch((error: unknown) => {
				// Retention took it since it was listed: it is no longer in the history.
				if (error instanceof HistoryExpiredError) return undefined;
				throw error;
			});
			if (!read) continue;
			const { record, entries } = read;
			listed.push({
				runId: record.runId,
				...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
				...(record.absorbed ? { absorbed: [...record.absorbed] } : {}),
				status: record.status,
				startedAt: record.startedAt,
				...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
				files: changedFiles(record, entries).map(change => displayPath(record.root, change.path)),
			});
		}
		return { ...(head ? { head } : {}), runs: listed };
	}

	changes(runId: string, options: { maxLines?: number } = {}): Promise<string> {
		return showChanges(this.store, runId, options);
	}

	async goTo(target: string, options: { reason?: string } = {}): Promise<Move> {
		return this.moveOf(await this.store.goTo(target, options));
	}

	async undo(options: { reason?: string } = {}): Promise<Move> {
		return this.moveOf(await this.store.undo(options));
	}

	async redo(options: { reason?: string } = {}): Promise<Move> {
		return this.moveOf(await this.store.redo(options));
	}

	private moveOf(revision: Revision): Move {
		return {
			...(revision.from ? { from: revision.from } : {}),
			...(revision.to ? { to: revision.to } : {}),
			at: revision.at,
			...(revision.reason ? { reason: revision.reason } : {}),
			complete: revision.complete,
			conflicts: revision.conflicts.map(({ path, runId }) => ({
				path: displayPath(this.root, path),
				runId,
			})),
		};
	}
}
