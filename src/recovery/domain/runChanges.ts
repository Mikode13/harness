import { unifiedDiff } from '#src/diff/domain/unifiedDiff';
import type { FileState, JournalEntry, RecoveryStore } from './recoveryStore.ts';

// Git's test: a NUL byte near the start means the file is not text.
const binaryProbeBytes = 8000;

export interface ShowChangesOptions {
	/**
	 * The most lines of diff shown. What does not fit is named instead, in at most two more lines.
	 */
	maxLines?: number;
}

interface FileChange {
	path: string;
	before: FileState;
	after: FileState;
	/** The run died while changing this file, and the file held neither state afterwards. */
	uncertain: boolean;
}

/**
 * What a run changed, as a git-style diff per file, in the order the run first touched each one.
 * It shows each file from before the run's first change to after its last, so a file the run
 * created and then deleted does not appear. It reports the run's recorded effects, not a
 * comparison of the whole repository.
 */
export async function showChanges(
	store: RecoveryStore,
	runId: string,
	{ maxLines = 1000 }: ShowChangesOptions = {},
): Promise<string> {
	const { record, entries } = await store.readRun(runId);
	const changes = netChanges(entries, record.status !== 'running');
	const output: string[] = [];

	for (const [index, change] of changes.entries()) {
		const name = displayPath(record.root, change.path);
		const lines = await renderFile(store, name, change);
		const room = maxLines - output.length;
		if (lines.length <= room) {
			output.push(...lines);
			continue;
		}

		const rest = changes.slice(index + 1).map(next => displayPath(record.root, next.path));
		const shown = Math.max(0, room);
		output.push(...lines.slice(0, shown));
		output.push(`... ${String(lines.length - shown)} more lines of the diff of ${name} not shown`);
		if (rest.length > 0) {
			output.push(`... ${String(rest.length)} more changed files not shown: ${rest.join(', ')}`);
		}
		break;
	}

	return output.join('\n');
}

/** One change per path: from the first recorded change's before to the last one's after. */
function netChanges(entries: JournalEntry[], stopped: boolean): FileChange[] {
	const byPath = new Map<string, FileChange>();
	for (const entry of entries) {
		// Never made, so not a change.
		if (entry.status === 'abandoned') continue;
		const uncertain = stopped && entry.status === 'prepared';
		const known = byPath.get(entry.path);
		if (known) {
			known.after = entry.after;
			known.uncertain ||= uncertain;
		} else {
			byPath.set(entry.path, {
				path: entry.path,
				before: entry.before,
				after: entry.after,
				uncertain,
			});
		}
	}

	return [...byPath.values()].filter(
		change => change.uncertain || !sameState(change.before, change.after),
	);
}

async function renderFile(
	store: RecoveryStore,
	name: string,
	change: FileChange,
): Promise<string[]> {
	const { before, after } = change;
	const lines: string[] = [];
	if (change.uncertain) {
		lines.push(`# ${name}: the run stopped while changing this file; it may not hold this change`);
	}
	lines.push(`diff --git a/${name} b/${name}`);
	if (!before.exists && after.exists) lines.push(`new file mode ${gitMode(after.mode)}`);
	if (before.exists && !after.exists) lines.push(`deleted file mode ${gitMode(before.mode)}`);
	if (before.exists && after.exists && before.mode !== after.mode) {
		lines.push(`old mode ${gitMode(before.mode)}`, `new mode ${gitMode(after.mode)}`);
	}
	if (before.exists && after.exists && before.hash === after.hash) return lines;

	const oldContent = before.exists ? await store.readContent(before.hash) : Buffer.alloc(0);
	const newContent = after.exists ? await store.readContent(after.hash) : Buffer.alloc(0);
	const oldName = before.exists ? `a/${name}` : '/dev/null';
	const newName = after.exists ? `b/${name}` : '/dev/null';

	if (isBinary(oldContent) || isBinary(newContent)) {
		lines.push(`Binary files ${oldName} and ${newName} differ`);
		return lines;
	}
	const hunks = unifiedDiff(oldContent.toString('utf8'), newContent.toString('utf8'));
	// An empty file created or deleted has no hunks, as in git.
	if (hunks !== '') lines.push(`--- ${oldName}`, `+++ ${newName}`, ...hunks.split('\n'));
	return lines;
}

function sameState(a: FileState, b: FileState): boolean {
	if (!a.exists || !b.exists) return a.exists === b.exists;
	return a.hash === b.hash && a.mode === b.mode;
}

function isBinary(content: Buffer): boolean {
	return content.subarray(0, binaryProbeBytes).includes(0);
}

/** A regular file's mode as git writes it, such as `100644`. */
function gitMode(mode: number): string {
	return (0o100000 | mode).toString(8);
}

/**
 * Relative to the run's root when inside it; a file in another root keeps its real path. Both
 * are real absolute paths, with `/` as the separator on every supported platform.
 */
function displayPath(root: string, path: string): string {
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
