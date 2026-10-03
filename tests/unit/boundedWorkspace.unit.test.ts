import { describe, expect, it } from 'vitest';
import type { TextMatch } from '../../src/tools/domain/workspace.ts';
import { BoundedWorkspace } from '../../src/tools/infrastructure/boundedWorkspace.ts';

/** A program that never answers until it is stopped, as a runaway search would. */
class HangingWorkspace extends BoundedWorkspace {
	protected listCandidates(signal: AbortSignal): Promise<string[]> {
		return untilAborted(signal);
	}

	protected findMatches(
		_pattern: string,
		_ignoreCase: boolean,
		signal: AbortSignal,
	): Promise<TextMatch[]> {
		return untilAborted(signal);
	}
}

function untilAborted<Result>(signal: AbortSignal): Promise<Result> {
	return new Promise((_, reject) => {
		signal.addEventListener('abort', () => {
			reject(new DOMException('The operation was aborted', 'AbortError'));
		});
	});
}

const operations = [
	[
		'listFiles',
		(workspace: BoundedWorkspace, signal: AbortSignal) =>
			workspace.listFiles({ limit: 10 }, signal),
	],
	[
		'searchText',
		(workspace: BoundedWorkspace, signal: AbortSignal) =>
			workspace.searchText({ pattern: 'x', ignoreCase: false, limit: 10 }, signal),
	],
	[
		'readFile',
		(workspace: BoundedWorkspace, signal: AbortSignal) =>
			workspace.readFile({ path: 'a.ts', fromLine: 1, lineCount: 10 }, signal),
	],
] as const;

describe('BoundedWorkspace', () => {
	// A timeout is the model's to fix, so it must not pass for the run being cancelled.
	it.each(operations)(
		'%s stops at its time limit with an error that asks for a narrower query',
		async (_, operation) => {
			const workspace = new HangingWorkspace({ root: '/repository', timeoutMs: 20 });

			const failure = await operation(workspace, new AbortController().signal).then(
				() => undefined,
				(error: unknown) => error as Error,
			);

			expect(failure).toBeInstanceOf(Error);
			expect(failure?.name).not.toBe('AbortError');
			expect(failure?.message).toMatch(/narrow/);
		},
	);

	it.each(operations)('%s still lets the run’s own cancellation through', async (_, operation) => {
		const workspace = new HangingWorkspace({ root: '/repository', timeoutMs: 60_000 });
		const controller = new AbortController();

		const pending = operation(workspace, controller.signal);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});
