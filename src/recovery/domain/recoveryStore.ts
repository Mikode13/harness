/**
 * What one path held at one moment: nothing, or a regular file with this content and mode.
 * `hash` names the content in the store, so the bytes themselves never travel in a record.
 */
export type FileState = { exists: false } | { exists: true; hash: string; mode: number };

/**
 * One change to one file. It is recorded as `prepared` before the file is touched, and only
 * then applied, so a run that stops halfway always leaves a record of what it may have done.
 * `abandoned` means the change was prepared but never happened.
 */
export interface JournalEntry {
	sequence: number;
	/** The file's real path, absolute: a run may write to more than one root of its workspace. */
	path: string;
	before: FileState;
	after: FileState;
	/** Folders the change creates for a new file, outermost first: undo removes them if empty. */
	createdFolders?: string[];
	status: 'prepared' | 'applied' | 'abandoned';
}

/**
 * `interrupted` is a run whose process died while it was writing. The next run to take the
 * workspace settles each change it left `prepared`, from what the file holds now.
 */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunRecord {
	runId: string;
	/** The real path of the workspace root the run wrote to. */
	root: string;
	/**
	 * The run the workspace was at when this one started, so runs form a tree: going back to an
	 * earlier run and writing again starts a new branch. Absent for the first run.
	 */
	parentRunId?: string;
	/**
	 * Runs whose changes retention chained into this one, oldest first. They are no longer in
	 * the history: this run now goes back to where the oldest of them started.
	 */
	absorbed?: string[];
	/** The journal file that holds the run's changes. Absent while it is the first one written. */
	journal?: string;
	startedAt: string;
	finishedAt?: string;
	status: RunStatus;
	/** The process that ran it, so a run whose process died can be told from a live one. */
	pid: number;
}

/**
 * The recovery record of one run that writes. Every method returns only once what it records
 * is on disk: a change is never made before the record that would undo it exists. Once a step
 * fails to reach the journal, the journal refuses every later step, because a line written
 * after a broken one could not be read back.
 */
export interface RunJournal {
	readonly runId: string;
	/** Stores `content` and returns the hash that names it. Content stored before is reused. */
	saveContent(content: Buffer): Promise<string>;
	/** Records a change about to be made, and returns its sequence number. */
	prepare(change: Omit<JournalEntry, 'sequence' | 'status'>): Promise<number>;
	/** The change was made. */
	applied(sequence: number): Promise<void>;
	/** The change was not made, and the file still holds its `before`. */
	abandoned(sequence: number): Promise<void>;
	/**
	 * Whether a change it recorded may have reached a file: one prepared and not abandoned. It
	 * holds whatever happens to the record afterwards.
	 */
	readonly changed: boolean;
	/**
	 * Ends the run and releases the workspace for the next writer. A run that `changed` nothing
	 * leaves the history, and the workspace is back at the run before it. If removing it fails,
	 * the store still treats it as gone, and the next run or move finishes removing it.
	 */
	finish(status: Exclude<RunStatus, 'running' | 'interrupted'>): Promise<void>;
}

/** The point before any run: going there takes the workspace back to how it was. */
export const historyStart = 'start';

/** A file a move left as it was, because it did not hold what the history expected there. */
export interface MoveConflict {
	path: string;
	/** The run whose change could not be undone or redone. */
	runId: string;
}

/**
 * One move of the workspace through its history, kept so an agent that runs next can tell
 * that its conversation is about a state the workspace has left.
 */
export interface Revision {
	/** Counts the moves of this workspace, from 1. */
	revision: number;
	/** The run the workspace was at; absent for the start of the history. */
	from?: string;
	/** The run the workspace is at now; absent for the start of the history. */
	to?: string;
	at: string;
	/** Why the user went there, when the host asked. */
	reason?: string;
	/** Every file reached the state the history expected. Otherwise `conflicts` names those that did not. */
	complete: boolean;
	conflicts: MoveConflict[];
}

/** There is nothing to undo at the start of the history, or nothing to redo at its tip. */
export class NothingToMoveError extends Error {
	constructor(direction: 'undo' | 'redo') {
		super(direction === 'undo' ? 'There is no run to undo' : 'There is no run to redo');
		this.name = 'NothingToMoveError';
	}
}

/**
 * Where the runs that write to one workspace keep what is needed to undo them, outside the
 * workspace itself. Only one run writes to a workspace at a time.
 */
export interface RecoveryStore {
	/**
	 * Starts recording a run and holds the workspace for it until `finish`. The new run's parent
	 * is the run the workspace is at, and the workspace is at the new run from then on. Runs a
	 * dead process left `running` are settled first.
	 *
	 * @throws {WorkspaceBusyError} when another live run is writing to the workspace.
	 */
	startRun(): Promise<RunJournal>;
	/**
	 * Every run, oldest first, and the run the workspace is at (`head`), absent before the first.
	 * A run still recorded as `running` whose process is gone is listed as `interrupted`.
	 */
	listRuns(): Promise<{ head?: string; runs: RunRecord[] }>;
	/**
	 * Moves the workspace to the state right after `target`, or to how it was before any run
	 * with `historyStart`. It undoes runs one by one back to the closest common ancestor, then
	 * redoes runs one by one forward to `target`. Each file is written only if it holds the
	 * state the history expects there; one that does not is left as it is and reported, and the
	 * move is then not `complete`. A move the process did not finish is finished by the next
	 * move or run.
	 *
	 * @throws {WorkspaceBusyError} when a run or another move holds the workspace.
	 * @throws {UnknownRunError} when `target` is not in the history.
	 * @throws {HistoryExpiredError} when retention chained `target` into a later run.
	 */
	goTo(target: string, options?: { reason?: string }): Promise<Revision>;
	/**
	 * Moves the workspace to the run before the one it is at.
	 *
	 * @throws {NothingToMoveError} at the start of the history.
	 */
	undo(options?: { reason?: string }): Promise<Revision>;
	/**
	 * Moves the workspace to the next run: towards where it was most recently, or the newest
	 * branch.
	 *
	 * @throws {NothingToMoveError} when no run follows the one it is at.
	 */
	redo(options?: { reason?: string }): Promise<Revision>;
	/** Every move of the workspace, oldest first. */
	listRevisions(): Promise<Revision[]>;
	/**
	 * A run's record and its changes, in the order they were prepared.
	 *
	 * @throws {UnknownRunError} when `runId` was never a run of this workspace.
	 * @throws {HistoryExpiredError} when retention removed `runId` or chained it into a later run.
	 */
	readRun(runId: string): Promise<{ record: RunRecord; entries: JournalEntry[] }>;
	/** The bytes a hash names. */
	readContent(hash: string): Promise<Buffer>;
}

export class WorkspaceBusyError extends Error {
	readonly runId: string;

	constructor(runId: string) {
		super(`The workspace is busy: ${runId} is writing to it`);
		this.name = 'WorkspaceBusyError';
		this.runId = runId;
	}
}
