import type { Revision, RunRecord } from './recoveryStore.ts';

/** The runs to undo, newest first, then the runs to redo, oldest first. */
export interface Route {
	undo: string[];
	redo: string[];
}

/** A run named in the history is not kept any more, or never existed. */
export class UnknownRunError extends Error {
	constructor(readonly runId: string) {
		super(`Run ${runId} is not in the history of this workspace`);
		this.name = 'UnknownRunError';
	}
}

/**
 * The runs from `from` to `to` through their closest common ancestor. `undefined` is the start
 * of the history, before any run.
 */
export function route(runs: RunRecord[], from: string | undefined, to: string | undefined): Route {
	const byId = new Map(runs.map(run => [run.runId, run]));
	const back = ancestry(byId, from);
	const forward = ancestry(byId, to);
	// Both lines end at the start, so they share at least that much.
	const shared = forward.filter(runId => back.includes(runId));
	const meeting = shared[0];

	return {
		undo: until(back, meeting),
		redo: until(forward, meeting).reverse(),
	};
}

/**
 * The run `redo` goes to from `head`: the child of `head` towards the run the workspace was at
 * most recently, so going back and forward again returns where it was. Without one, the newest
 * child. `undefined` when `head` has no children.
 */
export function redoTarget(
	runs: RunRecord[],
	revisions: Revision[],
	head: string | undefined,
): string | undefined {
	const byId = new Map(runs.map(run => [run.runId, run]));
	const children = runs.filter(run => run.parentRunId === head).map(run => run.runId);
	if (children.length === 0) return undefined;

	for (const revision of [...revisions].reverse()) {
		for (const visited of [revision.from, revision.to]) {
			// Up from where the workspace was, until one of the children, if it is below `head`.
			for (let current = visited; current !== undefined; current = byId.get(current)?.parentRunId) {
				if (children.includes(current)) return current;
			}
		}
	}
	return children.sort().at(-1);
}

/**
 * `runId` and its ancestors, newest first. A parent that is not kept any more makes the line
 * unknown, because the workspace could not be moved across it.
 */
function ancestry(byId: Map<string, RunRecord>, runId: string | undefined): (string | undefined)[] {
	const line: (string | undefined)[] = [];
	for (let current = runId; current !== undefined;) {
		const run = byId.get(current);
		if (!run) throw new UnknownRunError(current);
		line.push(current);
		current = run.parentRunId;
	}
	line.push(undefined);
	return line;
}

/** The runs of `line` before `meeting`. */
function until(line: (string | undefined)[], meeting: string | undefined): string[] {
	const result: string[] = [];
	for (const runId of line) {
		if (runId === meeting || runId === undefined) break;
		result.push(runId);
	}
	return result;
}
