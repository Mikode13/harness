import type { FileState, JournalEntry } from './recoveryStore.ts';

/** What one run did to one file, from before its first change to after its last. */
export interface FileChange {
	path: string;
	before: FileState;
	after: FileState;
	/**
	 * Each change started from the state the previous one left. When it did not, someone else
	 * wrote to the file between two of the run's changes, and going back to `before` would
	 * discard that work.
	 */
	continuous: boolean;
	/** The run stopped while changing this file, and the file held neither state afterwards. */
	uncertain: boolean;
	/**
	 * The run is changing this file now: that change is recorded but may still be abandoned, so
	 * `after` leaves it out.
	 */
	pending: boolean;
	/** Folders the run created for this file, outermost first. */
	createdFolders: string[];
}

export function sameState(a: FileState, b: FileState): boolean {
	if (!a.exists || !b.exists) return a.exists === b.exists;
	return a.hash === b.hash && a.mode === b.mode;
}

/**
 * One change per path, in the order the run first touched each one. Abandoned changes were
 * never made, so they are left out. `stopped` says the run is over, so a change still
 * `prepared` is one nobody could settle.
 */
export function fileChanges(entries: JournalEntry[], stopped: boolean): FileChange[] {
	const byPath = new Map<string, FileChange>();
	for (const entry of entries) {
		if (entry.status === 'abandoned') continue;
		const uncertain = stopped && entry.status === 'prepared';
		const pending = !stopped && entry.status === 'prepared';
		const folders = entry.createdFolders ?? [];
		const known = byPath.get(entry.path);
		if (known) {
			if (pending) {
				known.pending = true;
				continue;
			}
			known.continuous &&= sameState(known.after, entry.before);
			known.after = entry.after;
			known.uncertain ||= uncertain;
			known.createdFolders.push(
				...folders.filter(folder => !known.createdFolders.includes(folder)),
			);
		} else {
			byPath.set(entry.path, {
				path: entry.path,
				before: entry.before,
				after: pending ? entry.before : entry.after,
				continuous: true,
				uncertain,
				pending,
				createdFolders: [...folders],
			});
		}
	}
	return [...byPath.values()];
}
