import { unifiedDiff } from '#src/diff/domain/unifiedDiff';
import { type FileChange, fileChanges, sameState } from './fileChanges.ts';
import type { JournalEntry, RecoveryStore, RunRecord } from './recoveryStore.ts';

const binaryProbeBytes = 8000;

export interface ShowChangesOptions {
	/**
	 * The most lines of diff shown. What does not fit is named instead, in at most two more lines.
	 */
	maxLines?: number;
}

/**
 * What a run changed, as a git-style diff per file, in the order the run first touched each one.
 * It shows each file from before the run's first change to after its last, so a file the run
 * created and then deleted does not appear. A change a live run has prepared but not made yet
 * is named, not shown. It reports the run's recorded effects, not a comparison of the whole
 * repository.
 */
export async function showChanges(
	store: RecoveryStore,
	runId: string,
	{ maxLines = 1000 }: ShowChangesOptions = {},
): Promise<string> {
	const { record, entries } = await store.readRun(runId);
	const changes = changedFiles(record, entries);
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

/**
 * The files a run changed, in the order it first touched each one. A file left as it was, such
 * as one the run created and then deleted, is not a change; one it may or may not have changed,
 * or is changing now, is.
 */
export function changedFiles(record: RunRecord, entries: JournalEntry[]): FileChange[] {
	return fileChanges(entries, record.status !== 'running').filter(
		change => change.uncertain || change.pending || !sameState(change.before, change.after),
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
	if (change.pending) {
		lines.push(`# ${name}: the run is changing this file now; that change is not shown`);
		if (sameState(before, after)) return lines;
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

	if (!isText(oldContent) || !isText(newContent)) {
		lines.push(`Binary files ${oldName} and ${newName} differ`);
		return lines;
	}
	const hunks = unifiedDiff(oldContent.toString('utf8'), newContent.toString('utf8'));
	// An empty file created or deleted has no hunks, as in git.
	if (hunks !== '') lines.push(`--- ${oldName}`, `+++ ${newName}`, ...hunks.split('\n'));
	return lines;
}

/**
 * Git's test, a NUL byte near the start, plus content that is not valid UTF-8: decoding would
 * replace its bytes, and two different files could then show no difference.
 */
function isText(content: Buffer): boolean {
	if (content.subarray(0, binaryProbeBytes).includes(0)) return false;
	return Buffer.from(content.toString('utf8'), 'utf8').equals(content);
}

/** A regular file's mode as git writes it, such as `100644`. */
function gitMode(mode: number): string {
	return (0o100000 | mode).toString(8);
}

/**
 * Relative to the run's root when inside it; a file in another root keeps its real path. Both
 * are real absolute paths, with `/` as the separator on every supported platform.
 */
export function displayPath(root: string, path: string): string {
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
