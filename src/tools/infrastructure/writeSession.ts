import {
	type RecoveryStore,
	type RunJournal,
	type RunStatus,
	WorkspaceBusyError,
} from '#src/recovery/domain/recoveryStore';
import { EditRefusedError } from '../domain/fileEdits.ts';

// Far more than a task needs; a run past it is more likely looping than working.
const defaultMaxChanges = 500;

/**
 * Everything one top-level run writes, across all its roles and rounds. Its journal starts on
 * the first write, so a run that only reads never holds the workspace, and ends with the run.
 * Once a change could not be confirmed, the session refuses every further write: the record of
 * what the run did must stay complete.
 */
export class WriteSession {
	private readonly store: RecoveryStore;
	private readonly maxChanges: number;
	private readonly onStart: ((runId: string) => void) | undefined;
	private readonly onDiscard: (() => void) | undefined;
	private journal: Promise<RunJournal> | undefined;
	private changes = 0;
	private stopped: string | undefined;
	// The end of the last write waiting or running, which the next one starts after.
	private writing: Promise<unknown> = Promise.resolve();

	constructor({
		store,
		maxChanges = defaultMaxChanges,
		onStart,
		onDiscard,
	}: {
		store: RecoveryStore;
		maxChanges?: number;
		/** Told the run's id once its journal has started, before its first change is recorded. */
		onStart?: (runId: string) => void;
		/** Told when the run ended having changed nothing, so the history no longer has it. */
		onDiscard?: () => void;
	}) {
		this.store = store;
		this.maxChanges = maxChanges;
		this.onStart = onStart;
		this.onDiscard = onDiscard;
	}

	/** The journal for one more change, counted against the run's limit. */
	async journalForChange(): Promise<RunJournal> {
		if (this.stopped !== undefined) throw new EditRefusedError(this.stopped);
		if (this.changes >= this.maxChanges) {
			throw new EditRefusedError(
				`This run has made ${String(this.maxChanges)} changes, the most one run may make`,
			);
		}

		this.journal ??= this.store.startRun().then(started => {
			this.onStart?.(started.runId);
			return started;
		});
		let journal: RunJournal;
		try {
			journal = await this.journal;
		} catch (error) {
			// A failed start is not kept, so the next change tries again.
			this.journal = undefined;
			if (error instanceof WorkspaceBusyError) {
				throw new EditRefusedError(
					'Another run, a move through its history, or the removal of its worktree holds this workspace, so nothing was changed',
					{
						cause: error,
					},
				);
			}
			throw new EditRefusedError(
				'The harness could not start recording this run, so nothing was changed',
				{ cause: error },
			);
		}
		this.changes++;
		return journal;
	}

	/**
	 * Runs `write` once every write before it has ended, so agents of one run that work at once
	 * never change files together: each change is read, recorded and made alone, and a command
	 * runs with no other write while the files are captured around it. A cancellation stops the
	 * wait.
	 */
	async exclusive<Result>(write: () => Promise<Result>, signal: AbortSignal): Promise<Result> {
		const before = this.writing;
		let release!: () => void;
		this.writing = new Promise<void>(resolve => {
			release = resolve;
		});
		try {
			await untilAborted(before, signal);
			signal.throwIfAborted();
			return await write();
		} finally {
			// Released even when cancelled while waiting: the writes after it wait for those before.
			void before.then(release, release);
		}
	}

	/** Refuses every further write, for this reason. The first reason given is kept. */
	stop(reason: string): void {
		this.stopped ??= reason;
	}

	/** The run's id once it has written, which is what an undo needs. */
	async runId(): Promise<string | undefined> {
		const journal = await this.journal?.catch(() => undefined);
		return journal?.runId;
	}

	/**
	 * Ends the run's record and releases the workspace. A run that never wrote has nothing to end,
	 * and one whose every change was abandoned leaves the history.
	 */
	async finish(status: Exclude<RunStatus, 'running' | 'interrupted'>): Promise<void> {
		const journal = await this.journal?.catch(() => undefined);
		this.journal = undefined;
		if (!journal) return;
		try {
			await journal.finish(status);
		} finally {
			// Even when finishing failed: a run that changed nothing is out of the history either way.
			if (!journal.changed) this.onDiscard?.();
		}
	}
}

/** Waits for `promise`, settled either way, or until `signal` aborts, whichever comes first. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const done = () => {
			signal.removeEventListener('abort', done);
			resolve();
		};
		signal.addEventListener('abort', done, { once: true });
		promise.then(done, done);
	});
}
