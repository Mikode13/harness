import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileState, RunJournal } from '../../src/recovery/domain/recoveryStore.ts';
import { showChanges } from '../../src/recovery/domain/runChanges.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';

let parent: string;
let root: string;
let store: FileRecoveryStore;
let run: RunJournal;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-changes-')));
	root = join(parent, 'repository');
	mkdirSync(root);
	store = await FileRecoveryStore.open({ root, directory: join(parent, 'state') });
	run = await store.startRun();
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

async function state(content: string | Buffer | undefined, mode = 0o644): Promise<FileState> {
	if (content === undefined) return { exists: false };
	return { exists: true, hash: await run.saveContent(Buffer.from(content)), mode };
}

/** Records one change to `name`, by default as made. */
async function change(
	name: string,
	before: FileState,
	after: FileState,
	outcome: 'applied' | 'abandoned' | 'prepared' = 'applied',
): Promise<void> {
	const sequence = await run.prepare({ path: join(root, name), before, after });
	if (outcome === 'applied') await run.applied(sequence);
	if (outcome === 'abandoned') await run.abandoned(sequence);
}

describe('showChanges', () => {
	it('shows a changed file as git does, by its path in the root', async () => {
		await change('src/app.ts', await state('a\nb\nc\n'), await state('a\nB\nc\n'));

		await expect(showChanges(store, run.runId)).resolves.toBe(
			[
				'diff --git a/src/app.ts b/src/app.ts',
				'--- a/src/app.ts',
				'+++ b/src/app.ts',
				'@@ -1,3 +1,3 @@',
				' a',
				'-b',
				'+B',
				' c',
			].join('\n'),
		);
		await run.finish('completed');
	});

	it('shows a created file and a deleted one against /dev/null', async () => {
		await change('new.txt', await state(undefined), await state('hello\n', 0o755));
		await change('old.txt', await state('bye\n'), await state(undefined));

		await expect(showChanges(store, run.runId)).resolves.toBe(
			[
				'diff --git a/new.txt b/new.txt',
				'new file mode 100755',
				'--- /dev/null',
				'+++ b/new.txt',
				'@@ -0,0 +1 @@',
				'+hello',
				'diff --git a/old.txt b/old.txt',
				'deleted file mode 100644',
				'--- a/old.txt',
				'+++ /dev/null',
				'@@ -1 +0,0 @@',
				'-bye',
			].join('\n'),
		);
		await run.finish('completed');
	});

	it('shows a change of mode alone, and a binary file without its bytes', async () => {
		await change('run.sh', await state('echo\n', 0o644), await state('echo\n', 0o755));
		await change('logo.png', await state(Buffer.from([1, 0, 2])), await state(Buffer.from([3, 0])));

		await expect(showChanges(store, run.runId)).resolves.toBe(
			[
				'diff --git a/run.sh b/run.sh',
				'old mode 100644',
				'new mode 100755',
				'diff --git a/logo.png b/logo.png',
				'Binary files a/logo.png and b/logo.png differ',
			].join('\n'),
		);
		await run.finish('completed');
	});

	it('shows content that is not UTF-8 as binary, so a change in it never vanishes', async () => {
		await change(
			'latin1.txt',
			await state(Buffer.from([0xff, 0x0a])),
			await state(Buffer.from([0xfe, 0x0a])),
		);

		await expect(showChanges(store, run.runId)).resolves.toBe(
			[
				'diff --git a/latin1.txt b/latin1.txt',
				'Binary files a/latin1.txt and b/latin1.txt differ',
			].join('\n'),
		);
		await run.finish('completed');
	});

	it('does not show a change a live run has prepared but not made', async () => {
		await change('a.txt', await state('1\n'), await state('2\n'));
		await change('a.txt', await state('2\n'), await state('3\n'), 'prepared');
		await change('b.txt', await state(undefined), await state('maybe\n'), 'prepared');

		await expect(showChanges(store, run.runId)).resolves.toBe(
			[
				'# a.txt: the run is changing this file now; that change is not shown',
				'diff --git a/a.txt b/a.txt',
				'--- a/a.txt',
				'+++ b/a.txt',
				'@@ -1 +1 @@',
				'-1',
				'+2',
				'# b.txt: the run is changing this file now; that change is not shown',
			].join('\n'),
		);
		await run.finish('completed');
	});

	it('shows each file once, from before its first change to after its last', async () => {
		await change('a.txt', await state('1\n'), await state('2\n'));
		await change('a.txt', await state('2\n'), await state('3\n'));
		await change('a.txt', await state('3\n'), await state('never\n'), 'abandoned');
		// Created and deleted within the run: nothing to show.
		await change('tmp.txt', await state(undefined), await state('x\n'));
		await change('tmp.txt', await state('x\n'), await state(undefined));

		await expect(showChanges(store, run.runId)).resolves.toBe(
			['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-1', '+3'].join(
				'\n',
			),
		);
		await run.finish('completed');
	});

	it('keeps the real path of a file outside the run root', async () => {
		const other = join(parent, 'standards', 'notes.md');
		const sequence = await run.prepare({
			path: other,
			before: await state(undefined),
			after: await state('x\n'),
		});
		await run.applied(sequence);

		await expect(showChanges(store, run.runId)).resolves.toContain(
			`diff --git a/${other} b/${other}`,
		);
		await run.finish('completed');
	});

	it('names what does not fit instead of showing it', async () => {
		const many = Array.from({ length: 20 }, (_, index) => `${String(index)}\n`).join('');
		await change('big.txt', await state(undefined), await state(many));
		await change('second.txt', await state(undefined), await state('a\n'));
		await change('third.txt', await state(undefined), await state('b\n'));

		const result = (await showChanges(store, run.runId, { maxLines: 10 })).split('\n');

		expect(result).toHaveLength(12);
		expect(result.slice(-2)).toEqual([
			'... 15 more lines of the diff of big.txt not shown',
			'... 2 more changed files not shown: second.txt, third.txt',
		]);
		await run.finish('completed');
	});

	it('warns that a file an interrupted run was changing may not hold the change', async () => {
		writeFileSync(join(root, 'a.txt'), 'edited by hand\n');
		await change('a.txt', await state('1\n'), await state('2\n'), 'prepared');
		// Its process died while the file held neither state.
		const workspaces = join(parent, 'state', 'workspaces');
		const deadPid = Number(
			execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']),
		);
		writeFileSync(
			join(workspaces, readdirSync(workspaces)[0] ?? '', 'lock'),
			JSON.stringify({ runId: run.runId, pid: deadPid }),
		);

		await expect(showChanges(store, run.runId)).resolves.toMatch(
			/^# a\.txt: the run stopped while changing this file; it may not hold this change\n/,
		);
	});
});
