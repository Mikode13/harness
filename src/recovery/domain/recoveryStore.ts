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

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
	runId: string;
	/** The real path of the workspace root the run wrote to. */
	root: string;
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
	/** Ends the run and releases the workspace for the next writer. */
	finish(status: Exclude<RunStatus, 'running'>): Promise<void>;
}

/**
 * Where the runs that write to one workspace keep what is needed to undo them, outside the
 * workspace itself. Only one run writes to a workspace at a time.
 */
export interface RecoveryStore {
	/**
	 * Starts recording a run and holds the workspace for it until `finish`.
	 *
	 * @throws {WorkspaceBusyError} when another live run is writing to the workspace.
	 */
	startRun(): Promise<RunJournal>;
	/** A run's record and its changes, in the order they were prepared. */
	readRun(runId: string): Promise<{ record: RunRecord; entries: JournalEntry[] }>;
	/** The bytes a hash names. */
	readContent(hash: string): Promise<Buffer>;
}

export class WorkspaceBusyError extends Error {
	constructor(readonly runId: string) {
		super(`Another run (${runId}) is writing to this workspace`);
		this.name = 'WorkspaceBusyError';
	}
}
