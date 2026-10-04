import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceBusyError } from '../../src/recovery/domain/recoveryStore.ts';
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
	rmSync(parent, { recursive: true, force: true });
});

const absent = { exists: false } as const;

/** The one folder the store keeps for `root`. */
function workspaceFolder(): string {
	const [folder] = readdirSync(join(directory, 'workspaces'));
	return join(directory, 'workspaces', folder ?? '');
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

	it('refuses a journal damaged before its last line', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
		await run.finish('failed');
		writeFileSync(join(workspaceFolder(), 'runs', run.runId, 'journal.jsonl'), 'garbage\n{}\n');

		await expect(store.readRun(run.runId)).rejects.toThrow(/corrupt at line 1/);
	});

	it('marks a finished run with its status and end time', async () => {
		const store = await FileRecoveryStore.open({ root, directory });
		const run = await store.startRun();
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

		await expect(store.readRun(runId)).rejects.toThrow(/Not a run id/);
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
