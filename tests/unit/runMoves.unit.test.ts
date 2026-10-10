import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type FileState,
	historyStart,
	NothingToMoveError,
	WorkspaceBusyError,
} from '../../src/recovery/domain/recoveryStore.ts';
import { UnknownRunError } from '../../src/recovery/domain/runTree.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { type Edit, readUnder, recordRun } from '../support/recordedRuns.ts';

let parent: string;
let root: string;
let store: FileRecoveryStore;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-moves-')));
	root = join(parent, 'repository');
	mkdirSync(root);
	store = await FileRecoveryStore.open({ root, directory: join(parent, 'state') });
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(parent, { recursive: true, force: true });
});

function workspaceFolder(): string {
	const workspaces = join(parent, 'state', 'workspaces');
	return join(workspaces, readdirSync(workspaces)[0] ?? '');
}

function read(name: string): string | undefined {
	return readUnder(root, name);
}

/** Records and makes each edit as a writing run would, then finishes the run. */
function run(...edits: Edit[]): Promise<string> {
	return recordRun(store, root, edits);
}

describe('moving through the history of runs', () => {
	it('takes a run back, and forward again', async () => {
		writeFileSync(join(root, 'kept.txt'), 'one');
		writeFileSync(join(root, 'gone.txt'), 'old');
		const first = await run(['kept.txt', 'two'], ['new.txt', 'hello'], ['gone.txt', undefined]);

		const undone = await store.undo();

		expect([read('kept.txt'), read('new.txt'), read('gone.txt')]).toEqual([
			'one',
			undefined,
			'old',
		]);
		expect(undone).toMatchObject({ revision: 1, from: first, complete: true, conflicts: [] });
		expect(undone).not.toHaveProperty('to');
		await expect(store.listRuns()).resolves.not.toHaveProperty('head');

		const redone = await store.redo();

		expect([read('kept.txt'), read('new.txt'), read('gone.txt')]).toEqual([
			'two',
			'hello',
			undefined,
		]);
		expect(redone).toMatchObject({ revision: 2, to: first, complete: true });
	});

	it('goes to the start and to any run, one run at a time', async () => {
		const first = await run(['a.txt', '1']);
		const second = await run(['a.txt', '2']);
		await run(['a.txt', '3'], ['b.txt', 'x']);

		await store.goTo(historyStart);
		expect([read('a.txt'), read('b.txt')]).toEqual([undefined, undefined]);

		await store.goTo(second);
		expect([read('a.txt'), read('b.txt')]).toEqual(['2', undefined]);
		await expect(store.listRuns()).resolves.toMatchObject({ head: second });

		await store.goTo(first);
		expect(read('a.txt')).toBe('1');
	});

	it('starts a branch when a run follows a move back, and redo returns where it was', async () => {
		const first = await run(['a.txt', '1']);
		const second = await run(['a.txt', '2']);
		const third = await run(['a.txt', '3']);
		await store.goTo(first);
		const branch = await run(['a.txt', 'other'], ['b.txt', 'branch only']);

		await expect(store.listRuns()).resolves.toMatchObject({
			runs: [{ runId: first }, { runId: second }, { runId: third }, { parentRunId: first }],
		});
		await expect(store.redo()).rejects.toBeInstanceOf(NothingToMoveError);

		await store.undo();
		await store.redo();
		expect([read('a.txt'), read('b.txt')]).toEqual(['other', 'branch only']);

		await store.goTo(third);
		expect([read('a.txt'), read('b.txt')]).toEqual(['3', undefined]);
		await store.undo();
		await store.undo();
		await store.redo();
		await expect(store.listRuns()).resolves.toMatchObject({ head: second });
		expect(branch).not.toBe(second);
	});

	it('leaves a file edited by hand as it is, and reports the move as partial', async () => {
		const first = await run(['a.txt', 'agent'], ['b.txt', 'agent']);
		writeFileSync(join(root, 'a.txt'), 'edited by hand');

		const revision = await store.undo();

		expect([read('a.txt'), read('b.txt')]).toEqual(['edited by hand', undefined]);
		expect(revision).toMatchObject({
			complete: false,
			conflicts: [{ path: join(root, 'a.txt'), runId: first }],
		});
		await expect(store.listRevisions()).resolves.toMatchObject([{ complete: false }]);
	});

	it('does not undo a file someone wrote between two of the run changes', async () => {
		writeFileSync(join(root, 'a.txt'), 'one');
		const journal = await store.startRun();
		const state = async (content: string): Promise<FileState> => ({
			exists: true,
			hash: await journal.saveContent(Buffer.from(content)),
			mode: statSync(join(root, 'a.txt')).mode & 0o7777,
		});
		const path = join(root, 'a.txt');
		for (const [before, after] of [
			['one', 'two'],
			['edited by hand', 'three'],
		] as const) {
			const sequence = await journal.prepare({
				path,
				before: await state(before),
				after: await state(after),
			});
			await journal.applied(sequence);
		}
		writeFileSync(path, 'three');
		await journal.finish('completed');

		await expect(store.undo()).resolves.toMatchObject({ complete: false });
		expect(read('a.txt')).toBe('three');
	});

	it('removes the folders a run created only while they are empty, and makes them again', async () => {
		await run(['deep/inner/a.txt', 'a']);
		writeFileSync(join(root, 'deep', 'mine.txt'), 'the user added this');

		await store.undo();

		expect(existsSync(join(root, 'deep', 'inner'))).toBe(false);
		expect(read('deep/mine.txt')).toBe('the user added this');

		await store.redo();
		expect(read('deep/inner/a.txt')).toBe('a');
	});

	it('restores the mode a run changed', async () => {
		writeFileSync(join(root, 'run.sh'), 'echo');
		chmodSync(join(root, 'run.sh'), 0o644);
		await run(['run.sh', 'echo', 0o755]);

		await store.undo();

		expect(statSync(join(root, 'run.sh')).mode & 0o7777).toBe(0o644);
	});

	it('does not write through a folder that became a link', async () => {
		await run(['sub/f.txt', 'agent']);
		const outside = join(parent, 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'f.txt'), 'agent');
		rmSync(join(root, 'sub'), { recursive: true });
		symlinkSync(outside, join(root, 'sub'));

		await expect(store.undo()).resolves.toMatchObject({ complete: false });
		expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('agent');
	});

	it('does not take a file behind a folder that became a link for one already moved', async () => {
		await run(['sub/f.txt', 'old']);
		await run(['sub/f.txt', 'new']);
		// What undoing the second run leads to, but outside the workspace.
		const outside = join(parent, 'outside');
		mkdirSync(outside);
		writeFileSync(join(outside, 'f.txt'), 'old');
		rmSync(join(root, 'sub'), { recursive: true });
		symlinkSync(outside, join(root, 'sub'));

		await expect(store.undo()).resolves.toMatchObject({
			complete: false,
			conflicts: [{ path: join(root, 'sub', 'f.txt') }],
		});
	});

	it('builds a restored file in a temporary only its owner can read', async () => {
		writeFileSync(join(root, 'secret.txt'), 'token');
		chmodSync(join(root, 'secret.txt'), 0o600);
		await run(['secret.txt', 'changed', 0o600]);
		const probe = await open(join(parent, 'probe'), 'w');
		await probe.close();
		const prototype = Object.getPrototypeOf(probe) as FileHandle;
		const writeFile = Reflect.get(prototype, 'writeFile');
		const modes: number[] = [];
		vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
			this: FileHandle,
			...args: Parameters<FileHandle['writeFile']>
		) {
			modes.push((await this.stat()).mode & 0o777);
			await Reflect.apply(writeFile, this, args);
		});

		await store.undo();

		// The store's own files are private too, so every file written to must be.
		expect(new Set(modes)).toEqual(new Set([0o600]));
		expect(read('secret.txt')).toBe('token');
	});

	it('removes the temporary a crash left when it finishes the move, even for a file it leaves', async () => {
		await run(['a.txt', '1']);
		const second = await run(['a.txt', '2']);
		// The process died going back, while it was writing the first run's content, and the
		// user edited the file before the move was finished: nothing writes it again.
		const temporary = join(root, '.a.txt.0123456789ab.mikode-harness-tmp');
		writeFileSync(temporary, '1');
		writeFileSync(join(root, 'a.txt'), 'edited by hand');
		writeFileSync(
			join(workspaceFolder(), 'head.json'),
			JSON.stringify({
				runId: second,
				revision: 0,
				pending: {
					revision: 1,
					from: second,
					to: (await store.listRuns()).runs[0]?.runId,
					conflicts: [],
					temporary,
				},
			}),
		);

		const next = await store.startRun();
		await next.finish('completed');

		expect(existsSync(temporary)).toBe(false);
		expect(read('a.txt')).toBe('edited by hand');
	});

	it('leaves alone a file of the user that looks like a temporary', async () => {
		await run(['a.txt', '1']);
		for (const name of ['.a.txt.mikode-harness-tmp', '.a.txt.0123456789ab.mikode-harness-tmp']) {
			writeFileSync(join(root, name), 'the user wrote this');
		}

		await expect(store.undo()).resolves.toMatchObject({ complete: true });

		expect(read('.a.txt.mikode-harness-tmp')).toBe('the user wrote this');
		expect(read('.a.txt.0123456789ab.mikode-harness-tmp')).toBe('the user wrote this');
	});

	it('records each move with the reason the host gave', async () => {
		await run(['a.txt', '1']);

		await store.goTo(historyStart, { reason: 'the approach was wrong' });
		await store.redo();

		await expect(store.listRevisions()).resolves.toMatchObject([
			{ revision: 1, reason: 'the approach was wrong' },
			{ revision: 2 },
		]);
		expect((await store.listRevisions())[1]).not.toHaveProperty('reason');
	});

	it('finishes a move its process left halfway before the next run starts', async () => {
		await run(['a.txt', '1']);
		const second = await run(['a.txt', '2'], ['b.txt', 'x']);
		// The process died going to the start, after removing one file of the second run.
		writeFileSync(
			join(workspaceFolder(), 'head.json'),
			JSON.stringify({
				runId: second,
				revision: 0,
				pending: { revision: 1, from: second, conflicts: [] },
			}),
		);
		rmSync(join(root, 'b.txt'));

		const next = await run(['c.txt', 'new']);

		expect([read('a.txt'), read('b.txt')]).toEqual([undefined, undefined]);
		await expect(store.listRevisions()).resolves.toMatchObject([{ revision: 1, complete: true }]);
		const { runs } = await store.listRuns();
		expect(runs.at(-1)?.runId).toBe(next);
		expect(runs.at(-1)).not.toHaveProperty('parentRunId');
	});

	it('records a finished move once, when only clearing it from the head was left', async () => {
		await run(['a.txt', '1']);
		const revision = await store.goTo(historyStart);
		writeFileSync(
			join(workspaceFolder(), 'head.json'),
			JSON.stringify({ revision: 0, pending: { ...revision, conflicts: [] } }),
		);
		// Half a line a later crash left, which the next append must not join.
		writeFileSync(join(workspaceFolder(), 'revisions.jsonl'), '{"revis', { flag: 'a' });

		await store.redo();

		await expect(store.listRevisions()).resolves.toMatchObject([{ revision: 1 }, { revision: 2 }]);
	});

	it('turns a move away while a run writes', async () => {
		const journal = await store.startRun();

		await expect(store.goTo(historyStart)).rejects.toBeInstanceOf(WorkspaceBusyError);
		await journal.finish('completed');
	});

	it('says when there is nothing to undo or redo, or no such run', async () => {
		await expect(store.undo()).rejects.toBeInstanceOf(NothingToMoveError);
		await run(['a.txt', '1']);
		await expect(store.redo()).rejects.toBeInstanceOf(NothingToMoveError);
		await expect(store.goTo('20260101T000000000Z-000000')).rejects.toBeInstanceOf(UnknownRunError);
	});
});
