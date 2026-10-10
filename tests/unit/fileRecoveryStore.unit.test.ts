import { execFileSync } from 'node:child_process';
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
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunJournal, WorkspaceBusyError } from '../../src/recovery/domain/recoveryStore.ts';
import { UnknownRunError } from '../../src/recovery/domain/runTree.ts';
import {
	defaultStateDirectory,
	FileRecoveryStore,
} from '../../src/recovery/infrastructure/fileRecoveryStore.ts';

let parent: string;
let root: string;
let directory: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-recovery-')));
	root = join(parent, 'repository');
	directory = join(parent, 'state');
	mkdirSync(root);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(parent, { recursive: true, force: true });
});

const absent = { exists: false } as const;

/** Records one change made, so the run stays in the history when it finishes. */
async function change(run: RunJournal, path = 'a.txt'): Promise<void> {
	await run.applied(await run.prepare({ path, before: absent, after: absent }));
}

/** The one folder the store keeps for `root`. */
function workspaceFolder(): string {
	const [folder] = readdirSync(join(directory, 'workspaces'));
	return join(directory, 'workspaces', folder ?? '');
}

/** The prototype every `FileHandle` shares, to fail or pause one of its calls. */
async function fileHandlePrototype(): Promise<FileHandle> {
	const handle = await open(join(parent, 'probe'), 'w');
	await handle.close();
	return Object.getPrototypeOf(handle) as FileHandle;
}

/** The id of a process that has already exited. */
function deadPid(): number {
	const pid = Number(
		execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']),
	);
	return pid;
}

describe('FileRecoveryStore', () => {
	it('stores content once, under its hash, and reads it back', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();

		const hash = await run.saveContent(Buffer.from('hello\n'));
		const again = await run.saveContent(Buffer.from('hello\n'));

		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(again).toBe(hash);
		await expect(store.readContent(hash)).resolves.toEqual(Buffer.from('hello\n'));
		await run.finish('completed');
	});

	it('keeps what it stores private to its owner', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		const hash = await run.saveContent(Buffer.from('source'));
		await change(run);
		await run.finish('completed');

		const content = join(workspaceFolder(), 'content', hash.slice(0, 2), hash);
		expect(statSync(content).mode & 0o777).toBe(0o600);
		expect(statSync(workspaceFolder()).mode & 0o777).toBe(0o700);
		expect(statSync(join(workspaceFolder(), 'runs', run.runId, 'journal.jsonl')).mode & 0o777).toBe(
			0o600,
		);
	});

	it('records each change as prepared, then applied or abandoned, in order', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		const hash = await run.saveContent(Buffer.from('new'));
		const after = { exists: true, hash, mode: 0o644 } as const;

		const first = await run.prepare({ path: 'a.txt', before: absent, after });
		const second = await run.prepare({ path: 'b.txt', before: absent, after });
		const third = await run.prepare({ path: 'c.txt', before: absent, after });
		await run.applied(first);
		await run.abandoned(second);

		const { entries } = await store.readRun(run.runId);
		expect(entries).toEqual([
			{ sequence: first, path: 'a.txt', before: absent, after, status: 'applied' },
			{ sequence: second, path: 'b.txt', before: absent, after, status: 'abandoned' },
			{ sequence: third, path: 'c.txt', before: absent, after, status: 'prepared' },
		]);
		await run.finish('completed');
	});

	// What a crashed process left is what an undo after a restart reads.
	it('leaves every recorded change readable to a store opened later', async () => {
		const run = await (await FileRecoveryStore.open({ root, directory })).startRun();
		const sequence = await run.prepare({ path: 'a.txt', before: absent, after: absent });

		const { record, entries } = await (
			await FileRecoveryStore.open({ root, directory })
		).readRun(run.runId);

		expect(record).toMatchObject({ runId: run.runId, root, status: 'running', pid: process.pid });
		expect(entries).toEqual([
			{ sequence, path: 'a.txt', before: absent, after: absent, status: 'prepared' },
		]);
		await run.finish('failed');
	});

	it('ignores half a line a crash left at the end of the journal', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		await run.prepare({ path: 'a.txt', before: absent, after: absent });
		await run.finish('failed');
		writeFileSync(join(workspaceFolder(), 'runs', run.runId, 'journal.jsonl'), '{"type":"prep', {
			flag: 'a',
		});

		await expect(store.readRun(run.runId)).resolves.toMatchObject({
			entries: [{ path: 'a.txt', status: 'prepared' }],
		});
	});

	// A full disk can write part of a line and then fail: a line appended after it would be joined
	// to that part, and the record of a change made after it lost.
	it('refuses every step after one that failed to reach the journal', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		const first = await run.prepare({ path: 'a.txt', before: absent, after: absent });
		vi.spyOn(await fileHandlePrototype(), 'appendFile').mockImplementationOnce(async function (
			this: FileHandle,
			data,
		) {
			// The journal appends text.
			await this.write((data as string).slice(0, 15));
			throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
		});

		await expect(run.applied(first)).rejects.toThrow(/no space left/);
		await expect(run.prepare({ path: 'b.txt', before: absent, after: absent })).rejects.toThrow(
			/stopped after a failed write/,
		);
		await expect(run.abandoned(first)).rejects.toThrow(/stopped after a failed write/);
		await run.finish('failed');

		const { record, entries } = await store.readRun(run.runId);
		expect(record.status).toBe('failed');
		expect(entries).toEqual([
			{ sequence: first, path: 'a.txt', before: absent, after: absent, status: 'prepared' },
		]);
	});

	it('refuses a journal damaged before its last line', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		await change(run);
		await run.finish('failed');
		writeFileSync(join(workspaceFolder(), 'runs', run.runId, 'journal.jsonl'), 'garbage\n{}\n');

		await expect(store.readRun(run.runId)).rejects.toThrow(/corrupt at line 1/);
	});

	it('marks a finished run with its status and end time', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		await change(run);
		await run.finish('cancelled');

		const { record } = await store.readRun(run.runId);
		expect(record.status).toBe('cancelled');
		expect(record.finishedAt).toEqual(expect.any(String));
		await expect(run.prepare({ path: 'a', before: absent, after: absent })).rejects.toThrow(
			/already finished/,
		);
	});

	it('gives runs ids that sort by start time', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const ids: string[] = [];
		for (let index = 0; index < 3; index++) {
			const run = await store.startRun();
			ids.push(run.runId);
			await run.finish('completed');
			// Ids carry milliseconds: one apart is enough to order them.
			await new Promise(resolve => setTimeout(resolve, 2));
		}

		expect([...ids].sort()).toEqual(ids);
	});

	it.each(['../outside', 'runs/../../x', ''])('refuses %j as a run id', async runId => {
		const store = await FileRecoveryStore.open({ root, directory });

		await expect(store.readRun(runId)).rejects.toBeInstanceOf(UnknownRunError);
	});

	it('refuses to read content by anything but a hash', async () => {
		const store = await FileRecoveryStore.open({ root, directory });

		await expect(store.readContent('../../workspace.json')).rejects.toThrow(/Not a content hash/);
	});

	describe('one writer per workspace', () => {
		it('turns away a second run while the first one writes', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const first = await store.startRun();

			const second = (await FileRecoveryStore.open({ root, directory })).startRun();
			await expect(second).rejects.toBeInstanceOf(WorkspaceBusyError);
			await expect(second).rejects.toHaveProperty('runId', first.runId);

			await first.finish('completed');
			const third = await store.startRun();
			await third.finish('completed');
		});

		it('takes over the lock of a run whose process died', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			writeFileSync(
				join(workspaceFolder(), 'lock'),
				JSON.stringify({ runId: '20261004T000000000Z-000000', pid: deadPid() }),
			);

			const run = await store.startRun();
			await run.finish('completed');
		});

		it('lets only one of two runs starting at the same time write', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const prototype = await fileHandlePrototype();
			const writeFile = Reflect.get(prototype, 'writeFile');
			let resume = (): void => undefined;
			const paused = new Promise<void>(resolve => {
				resume = resolve;
			});
			let pausing: () => void = () => undefined;
			const reached = new Promise<void>(resolve => {
				pausing = resolve;
			});
			// The first run stops in the middle of writing its lock.
			vi.spyOn(prototype, 'writeFile').mockImplementationOnce(async function (
				this: FileHandle,
				...args: Parameters<FileHandle['writeFile']>
			) {
				pausing();
				await paused;
				await Reflect.apply(writeFile, this, args);
			});

			const first = store.startRun();
			await reached;
			const second = await Promise.allSettled([store.startRun()]);
			resume();
			const results = [...(await Promise.allSettled([first])), ...second];

			const started = results.filter(result => result.status === 'fulfilled');
			const refused = results.filter(result => result.status === 'rejected');
			expect(started).toHaveLength(1);
			expect(refused.map(result => result.reason as unknown)).toEqual([
				expect.any(WorkspaceBusyError),
			]);
			await started[0]?.value.finish('completed');
		});

		it('does not take a lock it cannot read for a dead run', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			writeFileSync(join(workspaceFolder(), 'lock'), '');

			await expect(store.startRun()).rejects.toBeInstanceOf(WorkspaceBusyError);
			expect(statSync(join(workspaceFolder(), 'lock')).size).toBe(0);
		});

		it('releases a lock it published when it could not make it durable', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const prototype = await fileHandlePrototype();
			const sync = Reflect.get(prototype, 'sync');
			// The lock's own content syncs; the folder it was linked into does not.
			vi.spyOn(prototype, 'sync')
				.mockImplementationOnce(async function (this: FileHandle) {
					await Reflect.apply(sync, this, []);
				})
				.mockRejectedValueOnce(Object.assign(new Error('input/output error'), { code: 'EIO' }));

			await expect(store.startRun()).rejects.toThrow(/input\/output error/);
			expect(existsSync(join(workspaceFolder(), 'lock'))).toBe(false);
			const run = await store.startRun();
			await run.finish('completed');
		});

		it('lets two workspaces write at the same time', async () => {
			const other = join(parent, 'other');
			mkdirSync(other);
			const first = await (await FileRecoveryStore.open({ root, directory })).startRun();

			const second = await (await FileRecoveryStore.open({ root: other, directory })).startRun();

			await first.finish('completed');
			await second.finish('completed');
		});
	});

	it('keeps one workspace under two spellings of its path', async () => {
		const link = join(parent, 'link');
		symlinkSync(root, link);
		const first = await (await FileRecoveryStore.open({ root, directory })).startRun();

		await expect(
			(await FileRecoveryStore.open({ root: link, directory })).startRun(),
		).rejects.toBeInstanceOf(WorkspaceBusyError);
		await first.finish('completed');
	});

	describe('history of runs', () => {
		const killed: RunJournal[] = [];

		/** Leaves `run` as a dead process would: still `running`, its lock naming a dead pid. */
		function kill(run: RunJournal): void {
			killed.push(run);
			writeFileSync(
				join(workspaceFolder(), 'lock'),
				JSON.stringify({ runId: run.runId, pid: deadPid() }),
			);
		}

		// A dead process's journal is never finished; this one's file is still open, so close it.
		afterEach(async () => {
			for (const run of killed.splice(0)) await run.finish('failed').catch(() => undefined);
		});

		it('records the run each run started from, and the run the workspace is at', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			await expect(store.listRuns()).resolves.toEqual({ runs: [] });

			const first = await store.startRun();
			await change(first);
			await first.finish('completed');
			const second = await store.startRun();
			await change(second);
			await second.finish('failed');

			const { head, runs } = await store.listRuns();
			expect(head).toBe(second.runId);
			expect(runs).toMatchObject([
				{ runId: first.runId, status: 'completed' },
				{ runId: second.runId, parentRunId: first.runId, status: 'failed' },
			]);
			expect(runs[0]).not.toHaveProperty('parentRunId');
		});

		it('takes a run that changed nothing out of the history, back to the run before it', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const kept = await store.startRun();
			await change(kept);
			expect(kept.changed).toBe(true);
			await kept.finish('completed');

			const abandoned = await store.startRun();
			const hash = await abandoned.saveContent(Buffer.from('never written'));
			await abandoned.abandoned(
				await abandoned.prepare({
					path: 'a.txt',
					before: absent,
					after: { exists: true, hash, mode: 0o644 },
				}),
			);
			expect(abandoned.changed).toBe(false);
			await abandoned.finish('failed');
			const empty = await store.startRun();
			await empty.finish('cancelled');

			await expect(store.listRuns()).resolves.toEqual({
				head: kept.runId,
				runs: [expect.objectContaining({ runId: kept.runId })],
			});
			for (const run of [abandoned, empty]) {
				expect(existsSync(join(workspaceFolder(), 'runs', run.runId))).toBe(false);
				await expect(store.readRun(run.runId)).rejects.toBeInstanceOf(UnknownRunError);
			}
			// The next run starts from the one kept, and the workspace is free.
			const next = await store.startRun();
			await change(next);
			await next.finish('completed');
			expect((await store.listRuns()).runs.at(-1)).toMatchObject({ parentRunId: kept.runId });
		});

		it('keeps a run whose change may have been made', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const run = await store.startRun();
			// Prepared, and neither applied nor abandoned: the file may hold it.
			await run.prepare({ path: 'a.txt', before: absent, after: absent });

			expect(run.changed).toBe(true);
			await run.finish('failed');
			await expect(store.listRuns()).resolves.toMatchObject({
				head: run.runId,
				runs: [{ runId: run.runId, status: 'failed' }],
			});
		});

		it('lists a run as running only while it holds the workspace and its process lives', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const run = await store.startRun();
			await change(run);
			await expect(store.listRuns()).resolves.toMatchObject({ runs: [{ status: 'running' }] });

			kill(run);

			await expect(store.listRuns()).resolves.toMatchObject({ runs: [{ status: 'interrupted' }] });
			await expect(store.readRun(run.runId)).resolves.toMatchObject({
				record: { status: 'interrupted' },
			});
		});

		it('settles what an interrupted run left prepared, from what each file holds now', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const dead = await store.startRun();
			const state = async (content: string) =>
				({
					exists: true,
					hash: await dead.saveContent(Buffer.from(content)),
					mode: 0o644,
				}) as const;
			const file = (name: string, content: string): string => {
				const path = join(root, name);
				writeFileSync(path, content);
				chmodSync(path, 0o644);
				return path;
			};
			const made = file('made.txt', 'new');
			const notMade = file('not-made.txt', 'old');
			const changedSince = file('changed-since.txt', 'edited by hand');
			for (const path of [made, notMade, changedSince]) {
				await dead.prepare({ path, before: await state('old'), after: await state('new') });
			}
			// The process died halfway through appending a line.
			const journal = join(workspaceFolder(), 'runs', dead.runId, 'journal.jsonl');
			writeFileSync(journal, '{"type":"appl', { flag: 'a' });
			kill(dead);

			const next = await store.startRun();

			const { record, entries } = await store.readRun(dead.runId);
			expect(record.status).toBe('interrupted');
			expect(
				JSON.parse(readFileSync(join(workspaceFolder(), 'runs', dead.runId, 'run.json'), 'utf8')),
			).toMatchObject({ status: 'interrupted' });
			expect(entries.map(({ path, status }) => [path, status])).toEqual([
				[made, 'applied'],
				[notMade, 'abandoned'],
				[changedSince, 'prepared'],
			]);
			await change(next);
			await next.finish('completed');
			await expect(store.listRuns()).resolves.toMatchObject({
				runs: [{ runId: dead.runId }, { runId: next.runId, parentRunId: dead.runId }],
			});
		});

		it('keeps a whole last line a crash left without its newline when it settles a run', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const dead = await store.startRun();
			const state = async (content: string) =>
				({
					exists: true,
					hash: await dead.saveContent(Buffer.from(content)),
					mode: 0o644,
				}) as const;
			const first = join(root, 'first.txt');
			const second = join(root, 'second.txt');
			const one = await dead.prepare({
				path: first,
				before: await state('old'),
				after: await state('new'),
			});
			await dead.prepare({ path: second, before: await state('old'), after: await state('new') });
			// `applied(1)` reached the disk, but its newline did not. The first file has changed
			// again since, so only the journal says the change was made.
			const journal = join(workspaceFolder(), 'runs', dead.runId, 'journal.jsonl');
			writeFileSync(journal, JSON.stringify({ type: 'applied', sequence: one }), { flag: 'a' });
			writeFileSync(first, 'edited by hand');
			chmodSync(first, 0o644);
			writeFileSync(second, 'new');
			chmodSync(second, 0o644);
			kill(dead);

			const next = await store.startRun();

			await expect(store.readRun(dead.runId)).resolves.toMatchObject({
				entries: [
					{ path: first, status: 'applied' },
					{ path: second, status: 'applied' },
				],
			});
			await next.finish('completed');
		});

		it('takes out a run that died before opening its journal, which changed nothing', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const dead = await store.startRun();
			rmSync(join(workspaceFolder(), 'runs', dead.runId, 'journal.jsonl'));
			kill(dead);

			const next = await store.startRun();
			await change(next);
			await next.finish('completed');

			await expect(store.readRun(dead.runId)).rejects.toBeInstanceOf(UnknownRunError);
			const { runs } = await store.listRuns();
			expect(runs).toEqual([expect.objectContaining({ runId: next.runId })]);
			expect(runs[0]).not.toHaveProperty('parentRunId');
		});

		it('hides a run that died having changed nothing at once, and the next run removes it', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const kept = await store.startRun();
			await change(kept);
			await kept.finish('completed');
			const dead = await store.startRun();
			await dead.abandoned(await dead.prepare({ path: 'a.txt', before: absent, after: absent }));
			// It died before finishing, so the head still names it.
			kill(dead);

			await expect(store.listRuns()).resolves.toEqual({
				head: kept.runId,
				runs: [expect.objectContaining({ runId: kept.runId })],
			});

			const next = await store.startRun();
			expect(existsSync(join(workspaceFolder(), 'runs', dead.runId))).toBe(false);
			await change(next);
			await next.finish('completed');
			expect((await store.listRuns()).runs.at(-1)).toMatchObject({ parentRunId: kept.runId });
		});

		it('hides a run that changed nothing when removing it and its lock both fail', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const run = await store.startRun();
			chmodSync(workspaceFolder(), 0o500);
			try {
				await expect(run.finish('completed')).rejects.toThrow();
			} finally {
				chmodSync(workspaceFolder(), 0o700);
			}
			// The lock still names this process, which lives on.
			expect(existsSync(join(workspaceFolder(), 'lock'))).toBe(true);

			await expect(store.listRuns()).resolves.toEqual({ runs: [] });
			// Its lock is stale: the next run takes the workspace and finishes the removal.
			const next = await store.startRun();
			expect(existsSync(join(workspaceFolder(), 'runs', run.runId))).toBe(false);
			await change(next);
			await next.finish('completed');
			expect((await store.listRuns()).runs).toEqual([
				expect.objectContaining({ runId: next.runId }),
			]);
		});

		it('takes over a lock this process left when releasing it failed', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const run = await store.startRun();
			await change(run);
			chmodSync(workspaceFolder(), 0o500);
			try {
				await expect(run.finish('completed')).rejects.toThrow();
			} finally {
				chmodSync(workspaceFolder(), 0o700);
			}

			// Its record was closed; only its lock was left, naming this process, which lives on.
			await expect(store.readRun(run.runId)).resolves.toMatchObject({
				record: { status: 'completed' },
			});
			const next = await store.startRun();
			await change(next);
			await next.finish('completed');
			expect((await store.listRuns()).runs.at(-1)).toMatchObject({ parentRunId: run.runId });
		});

		it('still lists a dead run whose journal it cannot read', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const dead = await store.startRun();
			kill(dead);
			writeFileSync(join(workspaceFolder(), 'runs', dead.runId, 'journal.jsonl'), 'garbage\n{}\n');

			await expect(store.listRuns()).resolves.toMatchObject({
				head: dead.runId,
				runs: [{ runId: dead.runId, status: 'interrupted' }],
			});
		});

		it('hides a run that changed nothing when removing it fails, and the next run removes it', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			const run = await store.startRun();
			const folder = join(workspaceFolder(), 'runs', run.runId);
			chmodSync(folder, 0o500);
			try {
				await expect(run.finish('completed')).rejects.toThrow();
			} finally {
				chmodSync(folder, 0o700);
			}

			await expect(store.listRuns()).resolves.toEqual({ runs: [] });
			// The workspace is free, and the next run finishes the removal.
			const next = await store.startRun();
			expect(existsSync(folder)).toBe(false);
			await change(next);
			await next.finish('completed');
		});

		it('leaves out a run whose process died before writing its record', async () => {
			const store = await FileRecoveryStore.open({ root, directory });
			mkdirSync(join(workspaceFolder(), 'runs', '20261004T000000000Z-000000'));

			await expect(store.listRuns()).resolves.toEqual({ runs: [] });
			const run = await store.startRun();
			await run.finish('completed');
		});
	});
});

describe('defaultStateDirectory', () => {
	it('uses XDG_STATE_HOME when it is set', () => {
		expect(defaultStateDirectory({ XDG_STATE_HOME: '/state' }, 'linux', '/home/me')).toBe(
			join('/state', 'mikode-harness'),
		);
	});

	it('ignores a relative XDG_STATE_HOME, as the XDG spec says', () => {
		expect(defaultStateDirectory({ XDG_STATE_HOME: 'state' }, 'linux', '/home/me')).toBe(
			join('/home/me', '.local', 'state', 'mikode-harness'),
		);
	});

	it("uses the user's Application Support on macOS", () => {
		expect(defaultStateDirectory({}, 'darwin', '/Users/me')).toBe(
			join('/Users/me', 'Library', 'Application Support', 'mikode-harness'),
		);
	});

	it('uses ~/.local/state elsewhere', () => {
		expect(defaultStateDirectory({}, 'linux', '/home/me')).toBe(
			join('/home/me', '.local', 'state', 'mikode-harness'),
		);
	});
});
