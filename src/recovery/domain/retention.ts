import { sameState } from './fileChanges.ts';
import type { JournalEntry, Revision, RunRecord } from './recoveryStore.ts';
import { redoTarget } from './runTree.ts';

/** One step towards keeping at most a given number of runs. */
export type PruneStep =
	/** An abandoned run nothing depends on: it goes whole. */
	| { kind: 'remove'; runId: string }
	/** A run on the current line: its changes are chained into `into`, its child on that line. */
	| { kind: 'chain'; runId: string; into: string };

/**
 * The line the user works along: from the first run after the start to the run the workspace is
 * at, then on through the runs `redo` would take, so what can be redone is kept too.
 */
export function currentLine(
	runs: RunRecord[],
	revisions: Revision[],
	head: string | undefined,
): string[] {
	const byId = new Map(runs.map(run => [run.runId, run]));
	const line: string[] = [];
	for (let runId = head; runId !== undefined; runId = byId.get(runId)?.parentRunId) {
		line.unshift(runId);
	}
	for (let next = redoTarget(runs, revisions, head); next !== undefined;) {
		line.push(next);
		next = redoTarget(runs, revisions, next);
	}
	return line;
}

/**
 * The next step that brings the history down to `keep` runs, or `undefined` once it is there or
 * nothing more can go. Abandoned branches go first, a leaf at a time, oldest first. Then the
 * oldest run on the current line other than the one the workspace is at is chained into the
 * next one, so the start of the history, before any run, always stays reachable.
 */
export function nextPruneStep(
	runs: RunRecord[],
	revisions: Revision[],
	head: string | undefined,
	keep: number,
): PruneStep | undefined {
	if (runs.length <= keep) return undefined;
	const line = currentLine(runs, revisions, head);

	const parents = new Set(runs.map(run => run.parentRunId));
	const leaf = runs
		.map(run => run.runId)
		.filter(runId => !line.includes(runId) && !parents.has(runId))
		.sort()[0];
	if (leaf) return { kind: 'remove', runId: leaf };

	for (let index = 0; index + 1 < line.length; index++) {
		const runId = line[index];
		const into = line[index + 1];
		if (runId !== undefined && into !== undefined && runId !== head) {
			return { kind: 'chain', runId, into };
		}
	}
	return undefined;
}

/**
 * The changes of `older` followed by those of `newer`, as one run's: each file's chain reduced to
 * its net, from before its first change to after its last, so the contents in between are no
 * longer referenced. A break in a chain, where someone wrote to the file between two changes,
 * is kept as a second change, so undoing still leaves that work alone.
 */
export function chainEntries(older: JournalEntry[], newer: JournalEntry[]): JournalEntry[] {
	const byPath = new Map<string, JournalEntry[][]>();
	for (const entry of [...older, ...newer]) {
		if (entry.status === 'abandoned') continue;
		const segments = byPath.get(entry.path) ?? [];
		const last = segments.at(-1);
		const previous = last?.at(-1);
		if (last && previous && sameState(previous.after, entry.before)) last.push(entry);
		else segments.push([entry]);
		byPath.set(entry.path, segments);
	}

	const chained: JournalEntry[] = [];
	for (const [path, segments] of byPath) {
		for (const segment of segments) {
			const first = segment[0];
			const last = segment.at(-1);
			if (!first || !last) continue;
			const createdFolders = [...new Set(segment.flatMap(entry => entry.createdFolders ?? []))];
			chained.push({
				sequence: chained.length + 1,
				path,
				before: first.before,
				after: last.after,
				...(createdFolders.length > 0 ? { createdFolders } : {}),
				// One change nobody could settle leaves the whole chain unsettled.
				status: segment.some(entry => entry.status === 'prepared') ? 'prepared' : 'applied',
			});
		}
	}
	return chained;
}
