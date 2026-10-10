import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistory, type History } from '../../../src/index.ts';
import { FileRecoveryStore } from '../../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { readUnder, recordRun } from '../../../tests/support/recordedRuns.ts';
import { HistoryCommands } from '../../historyCommands.ts';

const signal = new AbortController().signal;

let parent: string;
let root: string;
// Records runs as the write tools would: they are not public yet.
let store: FileRecoveryStore;
let history: History;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-history-')));
	root = join(parent, 'repo');
	mkdirSync(root);
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	const stateDirectory = join(parent, 'state');
	store = await FileRecoveryStore.open({ root, directory: stateDirectory });
	history = await createHistory({ root, stateDirectory });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

/**
 * The commands over the test history, answering each question with the next reply: a text, or
 * something that happens while the user answers and then gives the text.
 */
function commands(...replies: (string | (() => Promise<string>))[]) {
	const printed: string[] = [];
	const questions: string[] = [];
	const promptEmitter = {
		emit: vi.fn((question: string) => {
			questions.push(question);
			const reply = replies.shift();
			if (reply === undefined) return Promise.reject(new Error(`Nothing to answer "${question}"`));
			return typeof reply === 'string' ? Promise.resolve(reply) : reply();
		}),
		close: vi.fn(),
	};
	const output = {
		print: vi.fn((message: string) => printed.push(message)),
		printError: vi.fn(),
	};
	return {
		run: (line: string) => new HistoryCommands(history, promptEmitter, output).run(line, signal),
		printed,
		questions,
	};
}

const short = (runId: string) => runId.slice(-6);

describe('the history commands', () => {
	it('says when no run has written yet', async () => {
		const cli = commands();

		await cli.run('/history');

		expect(cli.printed).toEqual(['No run has written to this workspace yet.']);
	});

	it('shows the tree of runs, where the workspace is, and the files when asked', async () => {
		const first = await recordRun(store, root, [['a.txt', 'one']]);
		const abandoned = await recordRun(store, root, [['a.txt', 'two']]);
		await store.undo();
		const current = await recordRun(store, root, [
			['b.txt', 'b'],
			['c.txt', 'c'],
		]);
		const cli = commands();

		await cli.run('/history --files');

		expect(cli.printed).toEqual([
			'start, before any run',
			expect.stringMatching(new RegExp(`^└─ run ${short(first)} \\(.+, 1 file\\)$`)),
			'     · a.txt',
			expect.stringMatching(new RegExp(`^   ├─ run ${short(abandoned)} \\(.+, 1 file\\)$`)),
			'   │    · a.txt',
			expect.stringMatching(
				new RegExp(`^   └─ run ${short(current)} \\(.+, 2 files\\)  <- you are here$`),
			),
			'        · b.txt',
			'        · c.txt',
		]);
	});

	it('undoes the run the workspace is at once the user agrees, and records why', async () => {
		writeFileSync(join(root, 'a.txt'), 'original');
		const runId = await recordRun(store, root, [['a.txt', 'changed']]);
		const cli = commands('y', 'it broke the build');

		await cli.run('/undo');

		expect(cli.printed[0]).toMatch(
			new RegExp(
				`^This undoes run ${short(runId)} .*, taking the workspace back to how it was before any run\\.$`,
			),
		);
		expect(cli.questions).toEqual(['Go ahead? [y/N]: ', 'Why are you going back? (optional): ']);
		expect(cli.printed.at(-1)).toBe('The workspace is now at how it was before any run.');
		expect(readUnder(root, 'a.txt')).toBe('original');
		await expect(store.listRevisions()).resolves.toMatchObject([
			{ from: runId, reason: 'it broke the build', complete: true },
		]);
	});

	it.each(['', 'n', 'no thanks'])('changes nothing when the answer is %j', async answer => {
		writeFileSync(join(root, 'a.txt'), 'original');
		await recordRun(store, root, [['a.txt', 'changed']]);
		const cli = commands(answer);

		await cli.run('/undo');

		expect(cli.printed.at(-1)).toBe('Nothing was changed.');
		expect(cli.questions).toEqual(['Go ahead? [y/N]: ']);
		expect(readUnder(root, 'a.txt')).toBe('changed');
		await expect(store.listRevisions()).resolves.toEqual([]);
	});

	it('records no reason when none is given', async () => {
		await recordRun(store, root, [['a.txt', 'one']]);
		const cli = commands('yes', '  ');

		await cli.run('/undo');

		const [revision] = await store.listRevisions();
		expect(revision).not.toHaveProperty('reason');
	});

	it('redoes the run it went back from, naming it when it is the only one', async () => {
		const runId = await recordRun(store, root, [['a.txt', 'one']]);
		await store.undo();
		const cli = commands('y', 'it was fine after all');

		await cli.run('/redo');

		expect(cli.printed[0]).toMatch(new RegExp(`^This redoes run ${short(runId)} `));
		expect(cli.questions[1]).toBe('Why? (optional): ');
		expect(cli.printed.at(-1)).toBe(`The workspace is now at run ${short(runId)}.`);
		expect(readUnder(root, 'a.txt')).toBe('one');
	});

	it('goes to a run named by the end of its id, or to the start', async () => {
		const first = await recordRun(store, root, [['a.txt', 'one']]);
		await recordRun(store, root, [['a.txt', 'two']]);

		const back = commands('y', 'the second run was wrong');
		await back.run(`/goto ${short(first)}`);
		expect(back.questions[1]).toBe('Why are you going back? (optional): ');
		expect(readUnder(root, 'a.txt')).toBe('one');

		const start = commands('y', '');
		await start.run('/goto start');
		expect(start.printed[0]).toBe('This moves the workspace to how it was before any run.');
		expect(readUnder(root, 'a.txt')).toBeUndefined();
		await expect(store.listRevisions()).resolves.toMatchObject([
			{ to: first, reason: 'the second run was wrong' },
			{ from: first },
		]);
	});

	it.each([
		['/undo', ['y', 'never recorded']],
		['/redo', ['y', '']],
		['/goto start', ['y', '']],
	])(
		'%s changes nothing when a run ends while the user answers',
		async (command, [answer, reason]) => {
			const first = await recordRun(store, root, [['a.txt', 'one']]);
			const second = await recordRun(store, root, [['a.txt', 'two']]);
			if (command === '/redo') await store.undo();
			const at = command === '/redo' ? first : second;
			let third = '';
			const cli = commands(async () => {
				third = await recordRun(store, root, [['a.txt', 'three']]);
				return answer ?? '';
			}, reason ?? '');

			await cli.run(command);

			expect(cli.printed.at(-1)).toBe(
				`The workspace is no longer at run ${at}: it is at run ${third}: it moved while you were answering, so this move did not run. See /history.`,
			);
			expect(readUnder(root, 'a.txt')).toBe('three');
			await expect(store.listRevisions()).resolves.toHaveLength(command === '/redo' ? 1 : 0);
		},
	);

	it('names the files a move left because they changed since', async () => {
		const runId = await recordRun(store, root, [['a.txt', 'agent']]);
		writeFileSync(join(root, 'a.txt'), 'edited by hand');
		const cli = commands('y', '');

		await cli.run('/undo');

		expect(cli.printed.slice(-2)).toEqual([
			'Left as they were, because they changed since:',
			`  a.txt (from run ${short(runId)})`,
		]);
		expect(readUnder(root, 'a.txt')).toBe('edited by hand');
	});

	it('explains what it cannot do, and changes nothing', async () => {
		const cli = commands();
		await cli.run('/undo');
		await cli.run('/redo');
		await cli.run('/goto nothing');
		await cli.run('/goto start');
		await cli.run('/goto');

		expect(cli.printed).toEqual([
			'There is no run to undo. Nothing was changed.',
			'There is no run to redo. Nothing was changed.',
			'Run nothing is not in the history of this workspace. Nothing was changed.',
			'The workspace is already there. Nothing was changed.',
			'Usage: /goto <run | start>',
		]);
		expect(cli.questions).toEqual([]);
	});

	it('will not move the workspace while a run writes to it', async () => {
		await recordRun(store, root, [['a.txt', 'one']]);
		const journal = await store.startRun();
		const cli = commands('y', '');
		try {
			await cli.run('/undo');
		} finally {
			await journal.finish('completed');
		}

		expect(cli.printed.at(-1)).toMatch(/^The workspace is busy: .* Nothing was changed\.$/);
	});

	it('lists the commands for one it does not know', async () => {
		const cli = commands();

		await cli.run('/help');

		expect(cli.printed[0]).toBe('History commands:');
	});
});
