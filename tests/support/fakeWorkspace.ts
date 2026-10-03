import type { TextMatch, Workspace } from '../../src/tools/domain/workspace.ts';

type Query<Operation extends keyof Workspace> = Parameters<Workspace[Operation]>[0];

/**
 * An offline `Workspace` that answers from what it was given and records every query, so a
 * test can check what a tool asked for without running any program.
 */
export class FakeWorkspace implements Workspace {
	readonly listed: Query<'listFiles'>[] = [];
	readonly searched: Query<'searchText'>[] = [];
	readonly read: Query<'readFile'>[] = [];
	readonly signals: AbortSignal[] = [];

	files: { files: string[]; total: number; truncated: boolean } = {
		files: [],
		total: 0,
		truncated: false,
	};
	matches: { matches: TextMatch[]; total: number; truncated: boolean } = {
		matches: [],
		total: 0,
		truncated: false,
	};
	content: { lines: string[]; totalLines: number; truncated: boolean } = {
		lines: [],
		totalLines: 0,
		truncated: false,
	};
	failure: Error | undefined;

	listFiles(query: Query<'listFiles'>, signal: AbortSignal) {
		this.listed.push(query);
		return this.answer(this.files, signal);
	}

	searchText(query: Query<'searchText'>, signal: AbortSignal) {
		this.searched.push(query);
		return this.answer(this.matches, signal);
	}

	readFile(query: Query<'readFile'>, signal: AbortSignal) {
		this.read.push(query);
		return this.answer(this.content, signal);
	}

	private answer<Result>(result: Result, signal: AbortSignal): Promise<Result> {
		this.signals.push(signal);
		return this.failure ? Promise.reject(this.failure) : Promise.resolve(result);
	}
}
