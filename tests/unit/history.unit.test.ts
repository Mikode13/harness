import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import {
	createHistory,
	HistoryExpiredError,
	historyStart,
	NothingToMoveError,
	UnknownRunError,
	WorkspaceBusyError,
	type History,
} from '../../src/index.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';
import { readUnder, recordRun } from '../support/recordedRuns.ts';
import { replaceTool, writesOver } from '../support/replaceTool.ts';

let parent: string;
let root: string;
let stateDirectory: string;
// The writing side, which has no public tools yet: the history itself is read through the exports.
let store: FileRecoveryStore;
let history: History;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-public-history-')));
	root = join(parent, 'repo');
	mkdirSync(root);
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	stateDirectory = join(parent, 'state');
	store = await FileRecoveryStore.open({ root, directory: stateDirectory, keepRuns: 3 });
	history = await createHistory({ root, stateDirectory });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

describe('the public history of a workspace', () => {
	it('is empty, at the start, before any run wrote', async () => {
		await expect(history.list()).resolves.toEqual({ runs: [] });
	});

	it('lists each run with its parent, status and the files it changed', async () => {
		const first = await recordRun(store, root, [
			['a.txt', 'one'],
			['src/b.txt', 'b'],
		]);
		const second = await recordRun(store, root, [
			['a.txt', 'two'],
			['c.txt', 'made'],
			['c.txt', undefined],
		]);

		const { head, runs } = await history.list();

		expect(head).toBe(second);
		expect(runs).toEqual([
			expect.objectContaining({ runId: first, status: 'completed', files: ['a.txt', 'src/b.txt'] }),
			// A file the run created and then deleted is not a change.
			expect.objectContaining({
				runId: second,
				parentRunId: first,
				status: 'completed',
				files: ['a.txt'],
			}),
		]);
		expect(runs[0]).not.toHaveProperty('parentRunId');
		expect(runs[0]?.finishedAt).toEqual(expect.any(String));
	});

	it('shows what a run changed as a diff', async () => {
		writeFileSync(join(root, 'a.txt'), 'before\n');
		const runId = await recordRun(store, root, [['a.txt', 'after\n']]);

		await expect(history.changes(runId)).resolves.toBe(
			[
				'diff --git a/a.txt b/a.txt',
				'--- a/a.txt',
				'+++ b/a.txt',
				'@@ -1 +1 @@',
				'-before',
				'+after',
			].join('\n'),
		);
	});

	it('rejects a run it never had, and an id that is not one, before reading anything', async () => {
		await expect(history.changes('20260101T000000000Z-abcdef')).rejects.toBeInstanceOf(
			UnknownRunError,
		);
		await expect(history.changes('../../escape')).rejects.toBeInstanceOf(UnknownRunError);
		await expect(history.goTo('20260101T000000000Z-abcdef')).rejects.toBeInstanceOf(
			UnknownRunError,
		);
	});

	it('undoes, redoes and goes to a run, with the reason given', async () => {
		const first = await recordRun(store, root, [['a.txt', 'one']]);
		const second = await recordRun(store, root, [['a.txt', 'two']]);

		const { at, ...undone } = await history.undo({ reason: 'not that' });
		expect(undone).toEqual({
			from: second,
			to: first,
			reason: 'not that',
			complete: true,
			conflicts: [],
		});
		expect(Date.parse(at)).not.toBeNaN();
		expect(readUnder(root, 'a.txt')).toBe('one');

		await expect(history.redo()).resolves.toMatchObject({ from: first, to: second });
		expect(readUnder(root, 'a.txt')).toBe('two');

		const back = await history.goTo(historyStart);
		expect(back).not.toHaveProperty('to');
		expect(readUnder(root, 'a.txt')).toBeUndefined();
		expect((await history.list()).head).toBeUndefined();
	});

	it('names, relative to the root, a file a move left because the user changed it', async () => {
		const runId = await recordRun(store, root, [['src/a.txt', 'agent']]);
		writeFileSync(join(root, 'src', 'a.txt'), 'edited by hand');

		const move = await history.undo();

		expect(move).toMatchObject({ complete: false, conflicts: [{ path: 'src/a.txt', runId }] });
		expect(readUnder(root, 'src/a.txt')).toBe('edited by hand');
	});

	it('says when there is nothing to undo or redo', async () => {
		await expect(history.undo()).rejects.toBeInstanceOf(NothingToMoveError);
		await recordRun(store, root, [['a.txt', 'one']]);
		await expect(history.redo()).rejects.toBeInstanceOf(NothingToMoveError);
	});

	it('will not move the workspace while a run writes to it', async () => {
		await recordRun(store, root, [['a.txt', 'one']]);
		const journal = await store.startRun();
		try {
			await expect(history.undo()).rejects.toBeInstanceOf(WorkspaceBusyError);
		} finally {
			await journal.finish('completed');
		}
	});

	it('tells a run retention chained from one it never had, and names where it went', async () => {
		const first = await recordRun(store, root, [['a.txt', 'one']]);
		const second = await recordRun(store, root, [['b.txt', 'two']]);
		await recordRun(store, root, [['c.txt', 'three']]);
		// Keeping three, the fourth run chains the first into the second.
		await recordRun(store, root, [['d.txt', 'four']]);

		const { runs } = await history.list();
		expect(runs.map(run => run.runId)).not.toContain(first);
		expect(runs.find(run => run.runId === second)).toMatchObject({
			absorbed: [first],
			files: ['a.txt', 'b.txt'],
		});
		await expect(history.changes(first)).rejects.toEqual(
			expect.objectContaining({ name: 'HistoryExpiredError', keptIn: second }),
		);
		await expect(history.goTo(first)).rejects.toBeInstanceOf(HistoryExpiredError);
	});

	it('is the same history, with the same paths, whichever spelling of the root opened it', async () => {
		const runId = await recordRun(store, root, [['src/a.txt', 'one']]);
		writeFileSync(join(root, 'src', 'a.txt'), 'edited by hand');
		const link = join(parent, 'link');
		symlinkSync(root, link);

		const throughLink = await createHistory({ root: link, stateDirectory });

		expect((await throughLink.list()).runs).toEqual([
			expect.objectContaining({ runId, files: ['src/a.txt'] }),
		]);
		await expect(throughLink.undo()).resolves.toMatchObject({
			conflicts: [{ path: 'src/a.txt', runId }],
		});
	});
});

describe('the run an agent recorded', () => {
	const signal = new AbortController().signal;

	async function agentWriting(...responses: (ReturnType<typeof textResponse> | Error)[]) {
		writeFileSync(join(root, 'a.txt'), 'original');
		return new LLMAgent({
			llmClient: new FakeLLMClient(...responses),
			tools: [replaceTool(await writesOver(root, store))],
		});
	}

	const write = assistantResponse([
		toolCall('call', 'replace', { path: 'a.txt', content: 'changed' }),
	]);

	it('is named in the response of a run that wrote, and is the head of the history', async () => {
		const agent = await agentWriting(write, textResponse('done'));

		const response = await agent.run('change it', { signal });

		const { head, runs } = await history.list();
		expect(response.runId).toBe(head);
		expect(runs).toEqual([
			expect.objectContaining({ runId: head, status: 'completed', files: ['a.txt'] }),
		]);
	});

	it('is absent from the response of a run that wrote nothing', async () => {
		const agent = await agentWriting(textResponse('nothing to do'));

		const response = await agent.run('look', { signal });

		expect(response).not.toHaveProperty('runId');
		await expect(history.list()).resolves.toEqual({ runs: [] });
	});

	it('is neither named nor kept when the run started recording but changed nothing', async () => {
		const agent = await agentWriting(write, textResponse('it could not be written'));
		// The temporary beside the file cannot be created, so the write fails once recording began.
		chmodSync(root, 0o555);
		let response;
		try {
			response = await agent.run('change it', { signal });
		} finally {
			chmodSync(root, 0o755);
		}

		expect(readUnder(root, 'a.txt')).toBe('original');
		expect(response).not.toHaveProperty('runId');
		await expect(history.list()).resolves.toEqual({ runs: [] });
	});

	it('stays in the history, failed, when the run fails after writing', async () => {
		const agent = await agentWriting(write, new Error('the model is down'));

		await expect(agent.run('change it', { signal })).rejects.toThrow();

		expect((await history.list()).runs).toEqual([
			expect.objectContaining({ status: 'failed', files: ['a.txt'] }),
		]);
		await history.undo();
		expect(readUnder(root, 'a.txt')).toBe('original');
	});

	it('stays in the history, cancelled, when the run is cancelled after writing', async () => {
		const controller = new AbortController();
		const agent = new LLMAgent({
			llmClient: {
				send: async () => {
					// The first call writes; the second is where the user stops the run.
					if (!controller.signal.aborted && (await history.list()).runs.length === 0) {
						return write;
					}
					controller.abort();
					throw controller.signal.reason;
				},
			},
			tools: [replaceTool(await writesOver(root, store))],
		});
		writeFileSync(join(root, 'a.txt'), 'original');

		await expect(agent.run('change it', { signal: controller.signal })).rejects.toThrow();

		expect((await history.list()).runs).toEqual([
			expect.objectContaining({ status: 'cancelled', files: ['a.txt'] }),
		]);
	});
});
