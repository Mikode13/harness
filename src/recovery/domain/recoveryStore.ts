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
	/**
	 * The command whose run the change was seen around, for a change no tool of the harness made
	 * itself. It was found by comparing the file before and after, not journaled before it was made.
	 */
	observedBy?: string;
	status: 'prepared' | 'applied' | 'abandoned';
}

/**
 * What a group of files held right before something outside the journal ran, such as a
 * command: the content of each, by its real path, absolute. It is stored as content, and the
 * journal names its hash before the command starts.
 */
export interface Manifest {
	files: Record<string, FileState>;
	/**
	 * Covered paths it could not copy, such as a folder, a link or a file too large: what they
	 * held is unknown, so a change to one can be named but not undone.
	 */
	uncopyable?: string[];
}

/**
 * A path a command changed into, or from, something the history cannot copy, such as a file
 * over the size limit: what it held before or after is unknown. Undo and redo leave it as it is,
 * and report it as a conflict.
 */
export interface UnrecordedChange {
	/** The real path, absolute. */
	path: string;
	/** The command it was seen around. */
	by: string;
}

/** What one observation cost: before and after together. */
export interface ObservationMeasure {
	/** Files captured before, and compared after. */
	files: number;
	bytesRead: number;
	/** New content stored, which the store did not hold already. */
	bytesStored: number;
	/** Spent capturing and comparing, not running what was observed. */
	durationMs: number;
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
	/**
	 * It finished with an observation still open, such as a command whose changes could not be
	 * compared after it ran: its journal may not hold all it changed yet. The next run or move
	 * settles it, as for an interrupted run, and keeps its status.
	 */
	unsettled?: true;
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
	 * Records that `by`, such as a command, is about to change files the journal cannot see it
	 * change, and that the stored `manifest` holds what they hold now. Each change it makes is
	 * then recorded as its own entry, prepared and applied at once, before `observed`. If the run
	 * stops first, the next run settles it: every file of the manifest that changed since is
	 * recorded as changed by `by`. A file it created is not in the manifest, and is then missed.
	 */
	observe(manifest: string, by: string): Promise<number>;
	/**
	 * Every change the observation found is recorded. `measure`, what capturing and comparing the
	 * files cost, is kept with it.
	 */
	observed(sequence: number, measure?: ObservationMeasure): Promise<void>;
	/**
	 * Records that `by` changed `path` into, or from, something the history cannot copy. A move
	 * over the run leaves it as it is, and is not complete.
	 */
	unrecorded(path: string, by: string): Promise<void>;
	/** How many bytes of content this run stored that the store did not hold yet. */
	readonly storedBytes: number;
	/** The path of every change it recorded as applied, in order: each one reached a file. */
	readonly appliedPaths: readonly string[];
	/**
	 * What the files this run changed hold now, as one hash of their paths and states. A file back
	 * to what it held before the run's first change to it counts as unchanged, so a change undone
	 * gives the state from before it.
	 */
	contentState(): string;
	/**
	 * Whether a change it recorded may have reached a file: one prepared and not abandoned, or one
	 * it could not copy. It holds whatever happens to the record afterwards, except once `finish`
	 * settled an observation the run left open and found that the run changed nothing: the run
	 * left the history, so it is `false`.
	 */
	readonly changed: boolean;
	/**
	 * Ends the run and releases the workspace for the next writer. A run that `changed` nothing
	 * leaves the history, and the workspace is back at the run before it. If removing it fails,
	 * the store still treats it as gone, and the next run or move finishes removing it. A run that
	 * ends with an observation open is settled from its manifest now, or by the next run or move
	 * if that fails.
	 */
	finish(status: Exclude<RunStatus, 'running' | 'interrupted'>): Promise<void>;
}

/** The point before any run: going there takes the workspace back to how it was. */
export const historyStart = 'start';

/**
 * A file a move left as it was: it did not hold what the history expected there, or a command
 * changed it into, or from, something the history cannot copy.
 */
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

export interface MoveOptions {
	/** Why the user is moving the workspace, recorded with the move. */
	reason?: string;
	/**
	 * Where the workspace must be for the move to happen: a run, or `historyStart`. Checked under
	 * the workspace lock, so a move confirmed against one state never runs from another.
	 */
	from?: string;
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
	 * The history on disk this store keeps, from the real paths of its root and its state
	 * directory: two stores opened over one history, under any spelling of those paths, have the
	 * same one.
	 */
	readonly workspaceId: string;
	/**
	 * What its runs may write in, as real paths: its root and the other folders it was opened
	 * with. A run claims them while it holds the workspace, so no worktree they lie in is removed
	 * meanwhile.
	 */
	readonly writeFolders: readonly string[];
	/**
	 * Starts recording a run and holds the workspace for it until `finish`. The new run's parent
	 * is the run the workspace is at, and the workspace is at the new run from then on. Runs a
	 * dead process left `running` are settled first.
	 *
	 * @throws {WorkspaceBusyError} when another live run is writing to the workspace, or a
	 * worktree it may write in is being removed.
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
	 * @throws {WorkspaceMovedError} when `from` was given and the workspace is elsewhere.
	 * @throws {UnknownRunError} when `target` is not in the history.
	 * @throws {HistoryExpiredError} when retention chained `target` into a later run.
	 */
	goTo(target: string, options?: MoveOptions): Promise<Revision>;
	/**
	 * Moves the workspace to the run before the one it is at.
	 *
	 * @throws {NothingToMoveError} at the start of the history.
	 */
	undo(options?: MoveOptions): Promise<Revision>;
	/**
	 * Moves the workspace to the next run: towards where it was most recently, or the newest
	 * branch.
	 *
	 * @throws {NothingToMoveError} when no run follows the one it is at.
	 */
	redo(options?: MoveOptions): Promise<Revision>;
	/** Every move of the workspace, oldest first. */
	listRevisions(): Promise<Revision[]>;
	/**
	 * A run's record, its changes, in the order they were prepared, and the changes it could not
	 * copy.
	 *
	 * @throws {UnknownRunError} when `runId` was never a run of this workspace.
	 * @throws {HistoryExpiredError} when retention removed `runId` or chained it into a later run.
	 */
	readRun(
		runId: string,
	): Promise<{ record: RunRecord; entries: JournalEntry[]; unrecorded: UnrecordedChange[] }>;
	/** The bytes a hash names. */
	readContent(hash: string): Promise<Buffer>;
}

/** A move was asked from one point of the history, and the workspace is at another. */
export class WorkspaceMovedError extends Error {
	/** Where the move expected the workspace: a run, or `historyStart`. */
	readonly expected: string;
	/** Where the workspace is: a run, or `historyStart`. */
	readonly actual: string;

	constructor(expected: string, actual: string) {
		const name = (point: string) => (point === historyStart ? 'the start' : `run ${point}`);
		super(`The workspace is no longer at ${name(expected)}: it is at ${name(actual)}`);
		this.name = 'WorkspaceMovedError';
		this.expected = expected;
		this.actual = actual;
	}
}

export class WorkspaceBusyError extends Error {
	readonly runId: string;

	constructor(runId: string) {
		super(`The workspace is busy: ${runId} is writing to it`);
		this.name = 'WorkspaceBusyError';
		this.runId = runId;
	}
}
