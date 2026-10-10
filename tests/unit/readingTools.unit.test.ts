import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunContext } from '../../src/agent/domain/runContext.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import { openWorkspace } from '../../src/tools/infrastructure/fileTools.ts';
import { RootsAccessPolicy } from '../../src/tools/infrastructure/rootsAccessPolicy.ts';
import { createShowChangesTool } from '../../src/tools/infrastructure/showChangesTool.ts';
import { recordRun } from '../support/recordedRuns.ts';

const signal = new AbortController().signal;

let parent: string;
let root: string;
let policy: RootsAccessPolicy;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-reading-')));
	root = join(parent, 'repo');
	mkdirSync(join(root, 'src'), { recursive: true });
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	// Not in .gitignore: only the policy keeps it closed.
	writeFileSync(join(root, '.envrc'), 'export TOKEN=secret\n');
	writeFileSync(join(root, 'src', 'a.ts'), 'export const token = process.env.TOKEN;\n');
	policy = await RootsAccessPolicy.create({
		roots: [{ path: root, access: 'write' }],
		ignoreRules: new GitIgnoreRules(),
	});
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

/** The read side of the file tools over the test root, as `openWorkspace` builds it. */
async function workspace() {
	const { read } = await openWorkspace(
		{ roots: [{ path: root, access: 'write' }], stateDirectory: join(parent, 'state') },
		{ warn: () => undefined },
	);
	return read;
}

describe('the read workspace under the access policy', () => {
	it('neither lists, searches nor reads a secret .gitignore lets through, nor counts it', async () => {
		const read = await workspace();

		await expect(read.listFiles({ limit: 50 }, signal)).resolves.toEqual({
			files: ['src/a.ts'],
			total: 1,
			truncated: false,
		});
		const { matches, total } = await read.searchText(
			{ pattern: 'TOKEN', ignoreCase: false, limit: 50 },
			signal,
		);
		expect(matches.map(match => match.path)).toEqual(['src/a.ts']);
		expect(total).toBe(1);
		await expect(
			read.readFile({ path: '.envrc', fromLine: 1, lineCount: 10 }, signal),
		).rejects.toThrow(/may hold secrets/);
	});
});

describe('the read workspace under the access policy, past one page', () => {
	it('gives the same total for a right and a wrong guess at a secret', async () => {
		writeFileSync(join(root, '.envrc'), 'TOKEN=hunter2\n');
		// Sorts before the secret, and fills the first page.
		writeFileSync(join(root, '.cfg'), 'x\n'.repeat(100));
		const read = await workspace();
		const total = async (pattern: string) =>
			(await read.searchText({ pattern, ignoreCase: false, limit: 100 }, signal)).total;

		await expect(total('^x$|TOKEN=hun')).resolves.toBe(100);
		await expect(total('^x$|TOKEN=zzz')).resolves.toBe(100);
		const { matches, truncated } = await read.searchText(
			{ pattern: '^x$|TOKEN', ignoreCase: false, limit: 100 },
			signal,
		);
		expect(matches.every(match => match.path !== '.envrc')).toBe(true);
		expect(truncated).toBe(true);
	});
});

describe('the read side of an opened workspace, at the stored-match limit', () => {
	it('answers a right and a wrong guess at a secret the same way', async () => {
		writeFileSync(join(root, '.envrc'), 'TOKEN=hunter2\n');
		// Exactly the most matches a search stores: one more would fail the search.
		writeFileSync(join(root, 'decoy.txt'), 'x\n'.repeat(50_000));
		const read = await workspace();
		const answer = (pattern: string) =>
			read
				.searchText({ pattern, ignoreCase: false, glob: '{decoy.txt,.envrc}', limit: 100 }, signal)
				.then(
					({ total }) => `total ${String(total)}`,
					(error: unknown) => (error as Error).message,
				);

		await expect(answer('^x$|TOKEN=hun')).resolves.toBe('total 50000');
		await expect(answer('^x$|TOKEN=zzz')).resolves.toBe('total 50000');
	});
});

describe('the cost of a listing', () => {
	it('runs no per-path policy check for what it lists or finds, and one for what it reads', async () => {
		for (let index = 0; index < 300; index++) {
			writeFileSync(join(root, 'src', `file-${String(index)}.ts`), 'export {};\n');
		}
		const read = await workspace();
		const check = vi.spyOn(RootsAccessPolicy.prototype, 'check');

		await read.listFiles({ limit: 1000 }, signal);
		await read.searchText({ pattern: 'export', ignoreCase: false, limit: 1000 }, signal);
		expect(check).not.toHaveBeenCalled();

		await read.readFile({ path: 'src/a.ts', fromLine: 1, lineCount: 1 }, signal);
		expect(check).toHaveBeenCalledOnce();
		check.mockRestore();
	});
});

describe('the history of an opened workspace', () => {
	it.each([
		[
			'given through a link',
			() => {
				symlinkSync(root, join(parent, 'link'));
				return join(parent, 'link', 'state');
			},
		],
		['given relative to the working directory', () => relative(process.cwd(), join(root, 'state'))],
	])('stays closed to every tool when it lies in a root, %s', async (_, stateDirectory) => {
		const opened = await openWorkspace(
			{ roots: [{ path: root, access: 'write' }], stateDirectory: stateDirectory() },
			{ warn: () => undefined },
		);

		for (const access of ['read', 'write'] as const) {
			await expect(opened.policy.check('state/workspaces', access, signal)).rejects.toThrow(
				/protected by the harness/,
			);
		}
	});
});

describe('showChanges for the planner and the reviewer', () => {
	async function showChanges(context: RunContext): Promise<string> {
		const store = await FileRecoveryStore.open({ root, directory: join(parent, 'state') });
		const tool = createShowChangesTool({ store, policy });
		const prepared = await tool.prepare({}, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
		});
		return prepared.run(signal);
	}

	it('says when the task has changed nothing yet', async () => {
		await expect(showChanges(new RunContext())).resolves.toBe(
			'Nothing has been changed in this task yet.',
		);
	});

	it("shows the current run's changes it may read, and only counts the others", async () => {
		const store = await FileRecoveryStore.open({ root, directory: join(parent, 'state') });
		const context = new RunContext();
		context.historyRun.runId = await recordRun(store, root, [
			['src/a.ts', 'export const token = "changed";\n'],
			['.envrc', 'export TOKEN=leaked\n'],
		]);

		const shown = await showChanges(context);

		expect(shown).toContain('# 1 changed file is not shown: you may not read it');
		expect(shown).toContain('+export const token = "changed";');
		expect(shown).not.toContain('.envrc');
		expect(shown).not.toContain('leaked');
	});

	it.each([
		['a cancellation', new DOMException('The operation was aborted', 'AbortError')],
		['an operational policy failure', new Error('git failed')],
	])('propagates %s while deciding which changes may be shown', async (_, failure) => {
		const store = await FileRecoveryStore.open({ root, directory: join(parent, 'state') });
		const context = new RunContext();
		context.historyRun.runId = await recordRun(store, root, [
			['src/a.ts', 'export const token = "changed";\n'],
		]);
		vi.spyOn(policy, 'check').mockRejectedValueOnce(failure);

		await expect(showChanges(context)).rejects.toBe(failure);
	});
});
