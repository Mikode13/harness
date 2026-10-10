import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TextMatch } from '../../src/tools/domain/workspace.ts';
import { BoundedWorkspace } from '../../src/tools/infrastructure/boundedWorkspace.ts';

function untilAborted(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal.addEventListener('abort', () => {
			reject(new DOMException('The operation was aborted', 'AbortError'));
		});
	});
}

/** A program that never answers until it is stopped, as a runaway search would. */
class HangingWorkspace extends BoundedWorkspace {
	protected listUnignored(signal: AbortSignal): Promise<string[]> {
		return untilAborted(signal);
	}

	protected findMatches(
		_pattern: string,
		_ignoreCase: boolean,
		signal: AbortSignal,
	): Promise<void> {
		return untilAborted(signal);
	}
}

/** A program that prints far more matches outside `src/` than any search may hold. */
class NoisyWorkspace extends BoundedWorkspace {
	protected listUnignored(): Promise<string[]> {
		return Promise.resolve(['dist/bundle.js', 'src/agent.ts']);
	}

	protected findMatches(
		_pattern: string,
		_ignoreCase: boolean,
		_signal: AbortSignal,
		keep: (match: TextMatch) => void,
	): Promise<void> {
		for (let line = 1; line <= 60_000; line++) {
			keep({ path: 'dist/bundle.js', line, text: 'needle' });
		}
		keep({ path: 'src/agent.ts', line: 1, text: 'x'.repeat(5_000) });
		return Promise.resolve();
	}
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
	const signal = new AbortController().signal;

	// A timeout is the model's to fix, so it must not pass for the run being cancelled.
	it.each(operations)(
		'%s stops at its time limit with an error that asks for a narrower query',
		async (_, operation) => {
			const workspace = new HangingWorkspace({ root: '/repository', timeoutMs: 20 });

			const failure = await operation(workspace, signal).then(
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

	describe('a search whose program prints more than it may hold', () => {
		let root: string;

		beforeAll(() => {
			root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-noisy-')));
			for (const path of ['dist/bundle.js', 'src/agent.ts']) {
				mkdirSync(join(root, path, '..'), { recursive: true });
				writeFileSync(join(root, path), '');
			}
		});

		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		// Narrowing has to make a search lighter, or the advice to narrow it is a lie.
		it('succeeds once narrowed, because matches outside the scope are never stored', async () => {
			const { matches, total } = await new NoisyWorkspace({ root }).searchText(
				{ pattern: 'x', ignoreCase: false, path: 'src', limit: 10 },
				signal,
			);

			expect(total).toBe(1);
			expect(matches[0]?.path).toBe('src/agent.ts');
		});

		it('fails unnarrowed, asking for a narrower query', async () => {
			await expect(
				new NoisyWorkspace({ root }).searchText(
					{ pattern: 'x', ignoreCase: false, limit: 10 },
					signal,
				),
			).rejects.toThrow(/narrow/);
		});

		// A minified file can hold a whole bundle on one line.
		it('stores a match’s text cut at 1,000 characters', async () => {
			const { matches } = await new NoisyWorkspace({ root }).searchText(
				{ pattern: 'x', ignoreCase: false, path: 'src', limit: 10 },
				signal,
			);

			expect(matches[0]?.text).toHaveLength(1_000);
		});
	});
});
