import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { historyStart } from '../../src/recovery/domain/recoveryStore.ts';
import { HistoryExpiredError } from '../../src/recovery/domain/runTree.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { type Edit, readUnder, recordRun } from '../support/recordedRuns.ts';

let parent: string;
let root: string;
let store: FileRecoveryStore;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-retention-')));
	root = join(parent, 'repository');
	mkdirSync(root);
	store = await FileRecoveryStore.open({ root, directory: join(parent, 'state'), keepRuns: 3 });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

function workspaceFolder(): string {
	const workspaces = join(parent, 'state', 'workspaces');
	return join(workspaces, readdirSync(workspaces)[0] ?? '');
}

function run(...edits: Edit[]): Promise<string> {
	return recordRun(store, root, edits);
}

function read(name: string): string | undefined {
	return readUnder(root, name);
}

/** Whether the store still holds `content`. */
function stored(content: string): boolean {
	const hash = createHash('sha256').update(content).digest('hex');
	return existsSync(join(workspaceFolder(), 'content', hash.slice(0, 2), hash));
}

async function runIds(): Promise<string[]> {
	return (await store.listRuns()).runs.map(record => record.runId);
}

describe('keeping a bounded history of runs', () => {
	it('keeps as many runs as it was told to, the newest one included', async () => {
		const ids: string[] = [];
		for (const content of ['1', '2', '3', '4', '5']) ids.push(await run(['a.txt', content]));

		await expect(runIds()).resolves.toEqual(ids.slice(2));
		const { runs } = await store.listRuns();
		expect(runs[0]).toMatchObject({ absorbed: ids.slice(0, 2) });
		expect(runs[0]).not.toHaveProperty('parentRunId');
	});

	it('still goes back to how the workspace was before the first run, and forward again', async () => {
		writeFileSync(join(root, 'kept.txt'), 'original');
		await run(['kept.txt', 'one'], ['new.txt', 'created']);
		await run(['kept.txt', 'two']);
		await run(['other.txt', 'x']);
		const last = await run(['kept.txt', 'three'], ['new.txt', undefined]);

		await expect(store.goTo(historyStart)).resolves.toMatchObject({ complete: true });
		expect([read('kept.txt'), read('new.txt'), read('other.txt')]).toEqual([
			'original',
			undefined,
			undefined,
		]);

		await store.goTo(last);
		expect([read('kept.txt'), read('new.txt'), read('other.txt')]).toEqual([
			'three',
			undefined,
			'x',
		]);
	});

	it('frees the contents only the chained-away states referred to', async () => {
		writeFileSync(join(root, 'a.txt'), 'original');
		for (const content of ['1', '2', '3', '4']) await run(['a.txt', content]);

		expect([stored('original'), stored('1'), stored('2'), stored('3'), stored('4')]).toEqual([
			true,
			false,
			true,
			true,
			true,
		]);
	});

	it('reports an expired history for a run it chained away or removed', async () => {
		const first = await run(['a.txt', '1']);
		const abandoned = await run(['a.txt', '2']);
		await store.goTo(first);
		await run(['a.txt', 'branch']);
		await run(['a.txt', 'branch again']);
		await run(['a.txt', 'and again']);

		const { runs } = await store.listRuns();
		const keptIn = runs.find(record => record.absorbed?.includes(first))?.runId;
		expect(keptIn).toBeDefined();
		await expect(store.goTo(first)).rejects.toBeInstanceOf(HistoryExpiredError);
		await expect(store.goTo(first)).rejects.toMatchObject({ runId: first, keptIn });
		await expect(store.readRun(first)).rejects.toBeInstanceOf(HistoryExpiredError);
		await expect(store.goTo(abandoned)).rejects.toMatchObject({
			name: 'HistoryExpiredError',
			runId: abandoned,
			keptIn: undefined,
		});
	});

	it('removes abandoned branches whole before shortening the current line', async () => {
		const first = await run(['a.txt', '1']);
		const abandoned = await run(['a.txt', '2']);
		await store.goTo(first);
		const branch = await run(['b.txt', 'branch']);

		const next = await run(['c.txt', 'next']);

		await expect(runIds()).resolves.toEqual([first, branch, next]);
		expect(abandoned).not.toBe(branch);
		expect((await store.listRuns()).runs[0]).not.toHaveProperty('absorbed');
	});

	it('never removes the run the workspace is at, and keeps what can be redone', async () => {
		writeFileSync(join(root, 'a.txt'), 'original');
		await run(['a.txt', '1']);
		const second = await run(['a.txt', '2']);
		await run(['a.txt', '3']);
		const fourth = await run(['a.txt', '4']);
		await store.goTo(second);

		const fifth = await run(['b.txt', 'from the second']);

		const ids = await runIds();
		expect(ids).toEqual([second, fourth, fifth]);
		await store.goTo(fourth);
		expect([read('a.txt'), read('b.txt')]).toEqual(['4', undefined]);
		await store.goTo(historyStart);
		expect(read('a.txt')).toBe('original');
	});

	it('leaves alone a file someone wrote to between two chained runs', async () => {
		await run(['a.txt', 'agent'], ['b.txt', 'agent']);
		writeFileSync(join(root, 'a.txt'), 'edited by hand');
		await run(['a.txt', 'agent again']);
		await run(['c.txt', 'x']);
		await run(['d.txt', 'y']);

		const revision = await store.goTo(historyStart);

		expect(revision.complete).toBe(false);
		expect(revision.conflicts.map(conflict => conflict.path)).toEqual([join(root, 'a.txt')]);
		expect([read('a.txt'), read('b.txt')]).toEqual(['agent again', undefined]);
	});

	it('finishes a chain a crash interrupted, before anything else', async () => {
		const first = await run(['a.txt', '1']);
		await run(['a.txt', '2']);
		await run(['a.txt', '3']);
		const keeper = await run(['a.txt', '4']);
		// The process died after recording the chain, before removing what it replaced.
		const runs = join(workspaceFolder(), 'runs');
		mkdirSync(join(runs, first));
		writeFileSync(
			join(runs, first, 'run.json'),
			JSON.stringify({ runId: first, root, startedAt: '', status: 'completed', pid: 1 }),
		);
		writeFileSync(join(runs, keeper, 'journal-deadbeef.jsonl'), '');

		expect(await runIds()).not.toContain(first);
		const next = await store.startRun();
		await next.finish('completed');

		expect(existsSync(join(runs, first))).toBe(false);
		expect(existsSync(join(runs, keeper, 'journal-deadbeef.jsonl'))).toBe(false);
	});

	it('does not read a run retention took, even when a crash left its folder', async () => {
		const first = await run(['a.txt', '1']);
		const abandoned = await run(['a.txt', '2']);
		await store.goTo(first);
		await run(['a.txt', 'branch']);
		await run(['a.txt', 'branch again']);
		await run(['a.txt', 'and again']);
		// The process died after recording each removal, before the folders went.
		const runs = join(workspaceFolder(), 'runs');
		for (const runId of [first, abandoned]) {
			mkdirSync(join(runs, runId));
			writeFileSync(
				join(runs, runId, 'run.json'),
				JSON.stringify({ runId, root, startedAt: '', status: 'completed', pid: 1 }),
			);
		}

		await expect(store.readRun(first)).rejects.toBeInstanceOf(HistoryExpiredError);
		await expect(store.readRun(abandoned)).rejects.toBeInstanceOf(HistoryExpiredError);
		expect(await runIds()).not.toContain(abandoned);

		const next = await store.startRun();
		await next.finish('completed');
		expect([existsSync(join(runs, first)), existsSync(join(runs, abandoned))]).toEqual([
			false,
			false,
		]);
	});

	it('refuses a limit it could not keep', async () => {
		for (const keepRuns of [0, 2, 3.5]) {
			await expect(
				FileRecoveryStore.open({ root, directory: join(parent, 'state'), keepRuns }),
			).rejects.toBeInstanceOf(RangeError);
		}
	});
});
