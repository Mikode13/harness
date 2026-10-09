import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approver } from '../../src/agent/domain/approval.ts';
import { RunContext, type RunEnd, withRunContext } from '../../src/agent/domain/runContext.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { RecoveryStore } from '../../src/recovery/domain/recoveryStore.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type { ILogger } from '../../src/shared/domain/logger.ts';
import type { PreparedCall, PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';
import { replaceTool, writesOver as writesOverRoot } from '../support/replaceTool.ts';

const signal = new AbortController().signal;
const schema = { type: 'object' as const, properties: {}, required: [] };

/** A tool built the harness's way, preparing its calls with `prepare`. */
function preparingTool(
	prepare: PreparingTool['prepare'] = () =>
		Promise.resolve({ risk: 'safe', run: () => Promise.resolve('done') }),
): PreparingTool {
	return { name: 'edit', description: 'Edits', inputSchema: schema, prepare };
}

/** A prepared call whose `run` is a spy. */
function preparedCall(risk: PreparedCall['risk'] = 'safe') {
	return { risk, run: vi.fn(() => Promise.resolve('ran')) };
}

const oneCall = (input: unknown = { path: 'a' }) =>
	new FakeLLMClient(assistantResponse([toolCall('call-1', 'edit', input)]), textResponse('done'));

describe('LLMAgent with a tool that prepares its calls', () => {
	it('prepares the call with the run context, and runs what was prepared', async () => {
		const prepared = preparedCall();
		const prepare = vi.fn<PreparingTool['prepare']>(() => Promise.resolve(prepared));

		await new LLMAgent({ llmClient: oneCall(), tools: [preparingTool(prepare)] }).run('prompt', {
			signal,
		});

		expect(prepare).toHaveBeenCalledExactlyOnceWith(
			{ path: 'a' },
			expect.any(AbortSignal),
			expect.any(RunContext),
		);
		expect(prepared.run).toHaveBeenCalledOnce();
	});

	it('asks about the risk the preparation found, and runs nothing it was denied', async () => {
		const prepared = preparedCall('destructive');
		const approve = vi.fn<Approver>(() => ({ approved: false }));

		await new LLMAgent({
			llmClient: oneCall(),
			tools: [preparingTool(() => Promise.resolve(prepared))],
		}).run('prompt', { signal, approve });

		expect(approve).toHaveBeenCalledWith(
			{ tool: 'edit', input: { path: 'a' }, risk: 'destructive' },
			expect.any(AbortSignal),
		);
		expect(prepared.run).not.toHaveBeenCalled();
	});

	it('hands a failed preparation to the model, and carries on', async () => {
		const llmClient = oneCall();
		const tool = preparingTool(() => Promise.reject(new Error('"a" is outside the workspace')));

		const response = await new LLMAgent({ llmClient, tools: [tool] }).run('prompt', { signal });

		expect(response.response).toBe('done');
		expect(llmClient.contexts[1]?.at(-1)).toMatchObject({
			role: 'tool',
			content: [{ output: '"a" is outside the workspace', isError: true }],
		});
	});

	it('lets a cancellation during preparation end the run, without reporting the call', async () => {
		const controller = new AbortController();
		const onProgress = vi.fn();
		const tool = preparingTool(() => {
			controller.abort();
			return Promise.reject(new Error('stopped'));
		});

		await expect(
			new LLMAgent({ llmClient: oneCall(), tools: [tool] }).run('prompt', {
				signal: controller.signal,
				onProgress,
			}),
		).rejects.toHaveProperty('name', 'AbortError');
		// A cancelled call is not a failed one: nothing reports it as an error.
		expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'tool' }));
	});

	// Preparing can await work that never looks at the signal, and still succeed.
	it('asks nobody about a call prepared after the run was cancelled', async () => {
		const controller = new AbortController();
		const prepared = preparedCall('destructive');
		const approve = vi.fn<Approver>(() => ({ approved: true }));
		const tool = preparingTool(() => {
			controller.abort();
			return Promise.resolve(prepared);
		});

		await expect(
			new LLMAgent({ llmClient: oneCall(), tools: [tool] }).run('prompt', {
				signal: controller.signal,
				approve,
			}),
		).rejects.toHaveProperty('name', 'AbortError');
		expect(approve).not.toHaveBeenCalled();
		expect(prepared.run).not.toHaveBeenCalled();
	});
});

describe('LLMAgent and the run context', () => {
	/** A tool that registers a finisher on the context it is given, and records the context. */
	function finishingTool(ends: RunEnd[], contexts: RunContext[] = []) {
		return preparingTool((_, __, context) => {
			contexts.push(context);
			context.onFinish(end => {
				ends.push(end);
				return Promise.resolve();
			});
			return Promise.resolve(preparedCall());
		});
	}

	it('ends the context it created as completed when the run succeeds', async () => {
		const ends: RunEnd[] = [];

		await new LLMAgent({ llmClient: oneCall(), tools: [finishingTool(ends)] }).run('prompt', {
			signal,
		});

		expect(ends).toEqual(['completed']);
	});

	it('ends it as failed when the run fails', async () => {
		const ends: RunEnd[] = [];
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'edit')]),
			new UnrecoverableError('broken', { cause: 'broken' }),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [finishingTool(ends)] }).run('prompt', { signal }),
		).rejects.toBeInstanceOf(UnrecoverableError);
		expect(ends).toEqual(['failed']);
	});

	it('ends it as cancelled when the run is cancelled', async () => {
		const ends: RunEnd[] = [];
		const controller = new AbortController();
		const tool = preparingTool((_, __, context) => {
			context.onFinish(end => {
				ends.push(end);
				return Promise.resolve();
			});
			return Promise.resolve({
				risk: 'safe',
				run: () => {
					controller.abort();
					return Promise.reject(new Error('stopped'));
				},
			});
		});

		await expect(
			new LLMAgent({ llmClient: oneCall(), tools: [tool] }).run('prompt', {
				signal: controller.signal,
			}),
		).rejects.toHaveProperty('name', 'AbortError');
		expect(ends).toEqual(['cancelled']);
	});

	// An orchestrator creates the context; each role runs inside it and must not end it.
	it('runs inside a context it was given, without ending it', async () => {
		const ends: RunEnd[] = [];
		const contexts: RunContext[] = [];
		const context = new RunContext();
		const tool = finishingTool(ends, contexts);
		const options = withRunContext({ signal }, context);

		await new LLMAgent({ llmClient: oneCall(), tools: [tool] }).run('first', options);
		await new LLMAgent({ llmClient: oneCall(), tools: [tool] }).run('second', options);

		expect(contexts).toEqual([context, context]);
		expect(ends).toEqual([]);
		await context.finish('completed');
		expect(ends).toEqual(['completed', 'completed']);
	});

	it('gives each run that has no outer context a new one', async () => {
		const contexts: RunContext[] = [];
		const agent = new LLMAgent({
			llmClient: new FakeLLMClient(
				assistantResponse([toolCall('call-1', 'edit')]),
				textResponse('one'),
				assistantResponse([toolCall('call-2', 'edit')]),
				textResponse('two'),
			),
			tools: [finishingTool([], contexts)],
		});

		await agent.run('first', { signal });
		await agent.run('second', { signal });

		expect(contexts[0]).not.toBe(contexts[1]);
	});

	it('reports a context it could not end, and keeps the run it already finished', async () => {
		const logger: ILogger = { warn: vi.fn() };
		const tool = preparingTool((_, __, context) => {
			context.onFinish(() => Promise.reject(new Error('disk full')));
			return Promise.resolve(preparedCall());
		});

		const response = await new LLMAgent({ llmClient: oneCall(), tools: [tool], logger }).run(
			'prompt',
			{ signal },
		);

		expect(response.response).toBe('done');
		expect(logger.warn).toHaveBeenCalledWith('The run could not close its records: disk full');
	});
});

describe('LLMAgent writing a real repository through the engine', () => {
	let parent: string;
	let repo: string;
	let store: FileRecoveryStore;

	const read = (path: string) => readFileSync(join(repo, path), 'utf8');

	function writesOver(recovery: RecoveryStore = store) {
		return writesOverRoot(repo, recovery);
	}

	/** The model replaces `path` with `content`, then answers. */
	const replacing = (path: string, content: string) =>
		new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'replace', { path, content })]),
			textResponse('done'),
		);

	beforeEach(async () => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-lifecycle-')));
		repo = join(parent, 'repo');
		mkdirSync(repo);
		writeFileSync(join(repo, 'tracked.ts'), 'committed\n');
		writeFileSync(join(repo, '.env'), 'KEY=secret\n');
		execFileSync('git', ['init', '--quiet'], { cwd: repo });
		execFileSync(
			'git',
			[
				'-c',
				'user.name=T',
				'-c',
				'user.email=t@e.st',
				'commit',
				'--quiet',
				'--allow-empty',
				'-m',
				'x',
			],
			{ cwd: repo },
		);
		execFileSync('git', ['add', 'tracked.ts'], { cwd: repo });
		writeFileSync(join(repo, 'tracked.ts'), 'work in progress\n');
		store = await FileRecoveryStore.open({ root: repo, directory: join(parent, 'state') });
	});

	afterEach(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	/** The one run the store recorded, with its changes. */
	async function recordedRun() {
		const runs = execFileSync('find', [join(parent, 'state'), '-name', 'run.json'], {
			encoding: 'utf8',
		})
			.trim()
			.split('\n')
			.filter(Boolean);
		expect(runs).toHaveLength(1);
		const runId = runs[0]?.split('/').at(-2) ?? '';
		return store.readRun(runId);
	}

	it('edits a file with uncommitted work, keeping that work to undo, and closes the run', async () => {
		const response = await new LLMAgent({
			llmClient: replacing('tracked.ts', 'agent version\n'),
			tools: [replaceTool(await writesOver())],
		}).run('prompt', { signal });

		expect(response.response).toBe('done');
		expect(read('tracked.ts')).toBe('agent version\n');
		const { record, entries } = await recordedRun();
		expect(record.status).toBe('completed');
		const before = entries[0]?.before;
		if (!before?.exists) expect.unreachable('the file existed');
		await expect(store.readContent(before.hash)).resolves.toEqual(
			Buffer.from('work in progress\n'),
		);
	});

	it('refuses a secret, tells the model, and records nothing', async () => {
		const llmClient = replacing('.env', 'KEY=stolen\n');

		await new LLMAgent({ llmClient, tools: [replaceTool(await writesOver())] }).run('prompt', {
			signal,
		});

		expect(read('.env')).toBe('KEY=secret\n');
		expect(llmClient.contexts[1]?.at(-1)).toMatchObject({
			content: [{ isError: true, output: expect.stringContaining('may hold secrets') as string }],
		});
		expect(
			execFileSync('find', [join(parent, 'state'), '-name', 'run.json'], { encoding: 'utf8' }),
		).toBe('');
	});

	it('refuses to write a file the user changed while being asked', async () => {
		const llmClient = replacing('tracked.ts', 'agent version\n');
		const approve: Approver = () => {
			writeFileSync(join(repo, 'tracked.ts'), 'the user kept typing\n');
			return { approved: true };
		};

		await new LLMAgent({
			llmClient,
			tools: [replaceTool(await writesOver(), 'destructive')],
		}).run('prompt', { signal, approve });

		expect(read('tracked.ts')).toBe('the user kept typing\n');
		expect(llmClient.contexts[1]?.at(-1)).toMatchObject({
			content: [{ isError: true, output: expect.stringContaining('changed after') as string }],
		});
	});

	it('writes nothing when the run cannot be recorded', async () => {
		const llmClient = replacing('tracked.ts', 'agent version\n');
		// The real store, except that it cannot start a run.
		const broken: RecoveryStore = Object.assign(Object.create(store) as RecoveryStore, {
			startRun: () => Promise.reject(new Error('read-only disk')),
		});

		await new LLMAgent({ llmClient, tools: [replaceTool(await writesOver(broken))] }).run(
			'prompt',
			{ signal },
		);

		expect(read('tracked.ts')).toBe('work in progress\n');
		expect(llmClient.contexts[1]?.at(-1)).toMatchObject({
			content: [
				{ isError: true, output: expect.stringContaining('could not start recording') as string },
			],
		});
	});
});
