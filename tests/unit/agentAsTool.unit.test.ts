import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	Agent,
	AgentResponse,
	ProgressEvent,
	RunOptions,
} from '../../src/agent/domain/agent.ts';
import { delegationOf, runContextOf } from '../../src/agent/domain/runContext.ts';
import type { Transcript } from '../../src/agent/domain/transcript.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { createHistory } from '../../src/recovery/infrastructure/createHistory.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type { AgentTool, PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import {
	agentAsTool,
	type AgentAsToolOptions,
} from '../../src/tools/infrastructure/agentAsTool.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';
import { replaceTool, writesOver } from '../support/replaceTool.ts';

const signal = new AbortController().signal;

/** The tool `agentAsTool` makes, as the agent loop sees it. */
function delegation(
	options: Partial<AgentAsToolOptions> & Pick<AgentAsToolOptions, 'createAgent'>,
) {
	return agentAsTool({
		name: 'commit',
		description: 'Commits the work',
		...options,
	}) as unknown as PreparingTool;
}

/** A parent that hands `task` to `tool` in one step, then answers "parent done". */
function delegatingParent(tool: AgentTool, ...tasks: string[]) {
	const llmClient = new FakeLLMClient(
		assistantResponse(
			tasks.map((task, index) => toolCall(`call-${String(index + 1)}`, tool.name, { task })),
		),
		textResponse('parent done'),
	);
	return { llmClient, agent: new LLMAgent({ llmClient, tools: [tool] }) };
}

/** What the model was sent back for each tool call of its first step. */
function resultsOf(llmClient: FakeLLMClient) {
	return llmClient.contexts[1]?.at(-1)?.content;
}

function destructiveTool(name = 'wipe'): Tool {
	return {
		name,
		description: 'Wipes something',
		inputSchema: { type: 'object', properties: {}, required: [] },
		risk: () => 'destructive',
		execute: () => Promise.resolve('wiped'),
	};
}

const tokens = (count: number) => ({
	inputTokens: count,
	outputTokens: count,
	readCacheTokens: 0,
	writtenCacheTokens: 0,
});

describe('agentAsTool', () => {
	it('hands the task to a new agent within the run, and counts what it spent', async () => {
		const runs: RunOptions[] = [];
		const children: LLMAgent[] = [];
		const tool = delegation({
			createAgent: () => {
				const child = new LLMAgent({ llmClient: new FakeLLMClient(textResponse('committed')) });
				const run = child.run.bind(child);
				child.run = (prompt, options) => {
					runs.push(options);
					return run(prompt, options);
				};
				children.push(child);
				return child;
			},
		});
		const { llmClient, agent } = delegatingParent(tool, '  Commit a.txt  ', 'Commit b.txt');
		const events: ProgressEvent[] = [];

		const response = await agent.run('work', { signal, onProgress: event => events.push(event) });

		expect(response.response).toBe('parent done');
		// Two parent steps and one step of each child.
		expect(response.tokens).toEqual(tokens(4));
		expect(children).toHaveLength(2);
		expect(resultsOf(llmClient)).toEqual([
			expect.objectContaining({ callId: 'call-1', output: 'committed', isError: false }),
			expect.objectContaining({ callId: 'call-2', output: 'committed', isError: false }),
		]);
		expect(runs.map(options => delegationOf(options))).toEqual([
			{ tool: 'commit', callId: 'call-1', subagent: 1, depth: 1 },
			{ tool: 'commit', callId: 'call-2', subagent: 1, depth: 1 },
		]);
		// Both children run in the parent's run.
		expect(runContextOf(runs[0] ?? { signal })).toBe(runContextOf(runs[1] ?? { signal }));
		expect(runContextOf(runs[0] ?? { signal })).toBeDefined();
		expect(events).toContainEqual({
			type: 'subagent',
			callId: 'call-1',
			subagent: 1,
			name: 'commit',
			task: 'Commit a.txt',
			event: { type: 'agentMessage', message: 'committed' },
		});
	});

	it('runs the delegations of one step at once, and the other calls alone, in order', async () => {
		const started: string[] = [];
		const finish: Record<string, (response: AgentResponse) => void> = {};
		const tool = delegation({
			createAgent: () => ({
				run: (task: string) =>
					new Promise(resolve => {
						started.push(task);
						finish[task] = resolve;
					}),
			}),
		});
		const llmClient = new FakeLLMClient(
			assistantResponse([
				toolCall('call-1', 'commit', { task: 'a' }),
				toolCall('call-2', 'commit', { task: 'b' }),
				toolCall('call-3', 'note', {}),
			]),
			textResponse('parent done'),
		);
		const execute = vi.fn(() => Promise.resolve('noted'));
		const note: Tool = {
			name: 'note',
			description: 'Notes',
			inputSchema: { type: 'object', properties: {}, required: [] },
			risk: () => 'safe',
			execute,
		};
		const running = new LLMAgent({ llmClient, tools: [tool, note] }).run('work', { signal });

		await vi.waitFor(() => {
			expect(started).toEqual(['a', 'b']);
		});
		expect(execute).not.toHaveBeenCalled();
		finish.b?.({ response: 'b done', duration: 0 });
		finish.a?.({ response: 'a done', duration: 0 });
		await running;

		expect(execute).toHaveBeenCalledOnce();
		expect(resultsOf(llmClient)).toEqual([
			expect.objectContaining({ callId: 'call-1', output: 'a done' }),
			expect.objectContaining({ callId: 'call-2', output: 'b done' }),
			expect.objectContaining({ callId: 'call-3', output: 'noted' }),
		]);
	});

	it('gives the model an agent that failed as the call error, with what it spent', async () => {
		const tool = delegation({
			createAgent: () =>
				new LLMAgent({ llmClient: new FakeLLMClient(textResponse('', { stopReason: 'refused' })) }),
		});
		const { llmClient, agent } = delegatingParent(tool, 'Commit');

		const response = await agent.run('work', { signal });

		expect(response.response).toBe('parent done');
		expect(response.tokens).toEqual(tokens(3));
		expect(resultsOf(llmClient)).toEqual([
			expect.objectContaining({
				isError: true,
				output: expect.stringContaining(
					'The agent failed: The LLM stopped before completing its answer',
				) as string,
			}),
		]);
	});

	it("asks and approves through the run's own asker and approver", async () => {
		const childClient = new FakeLLMClient(
			assistantResponse([
				toolCall('ask-1', 'askUser', {
					questions: [
						{
							question: 'Which message?',
							options: [
								{ label: 'Short', description: 'One line' },
								{ label: 'Long', description: 'A body too' },
							],
							multiSelect: false,
						},
					],
				}),
			]),
			assistantResponse([toolCall('wipe-1', 'wipe', {})]),
			textResponse('child done'),
		);
		const tool = delegation({
			createAgent: () => new LLMAgent({ llmClient: childClient, tools: [destructiveTool()] }),
		});
		const { agent } = delegatingParent(tool, 'Commit');
		const ask = vi.fn(() => ['Short']);
		const approve = vi.fn(() => ({ approved: true }));

		await agent.run('work', { signal, ask, approve });

		expect(ask).toHaveBeenCalledOnce();
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'wipe', risk: 'destructive' }),
			expect.anything(),
		);
		expect(childClient.contexts[2]?.at(-1)?.content).toEqual([
			expect.objectContaining({ output: 'wiped', isError: false }),
		]);
	});

	it("never grants an agent the caller's autoApprove", async () => {
		const childClient = new FakeLLMClient(
			assistantResponse([toolCall('wipe-1', 'wipe', {})]),
			textResponse('child done'),
		);
		const tool = delegation({
			createAgent: () => new LLMAgent({ llmClient: childClient, tools: [destructiveTool()] }),
		});
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'commit', { task: 'Commit' })]),
			textResponse('parent done'),
		);

		await new LLMAgent({ llmClient, tools: [tool], autoApprove: true }).run('work', { signal });

		expect(childClient.contexts[1]?.at(-1)?.content).toEqual([
			expect.objectContaining({
				isError: true,
				output: expect.stringContaining('no one was asked to allow it') as string,
			}),
		]);
	});

	it.each([
		['throws', () => Promise.reject(new Error('the terminal closed'))],
		['answers with no decision', () => Promise.resolve({ approved: 'yes' })],
	])('ends the run when the approver %s inside the agent', async (_, answer) => {
		const tool = delegation({
			createAgent: () =>
				new LLMAgent({
					llmClient: new FakeLLMClient(
						assistantResponse([toolCall('wipe-1', 'wipe', {})]),
						textResponse('child done'),
					),
					tools: [destructiveTool()],
				}),
		});
		const { llmClient, agent } = delegatingParent(tool, 'Commit');

		const failure = await agent
			.run('work', { signal, approve: answer as never })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(UnrecoverableError);
		expect(failure).toMatchObject({ message: 'The tool call approver failed' });
		// The parent and the child each spent one step.
		expect((failure as UnrecoverableError).tokens).toEqual(tokens(2));
		// The parent's model never reads a result it would carry on from.
		expect(llmClient.contexts).toHaveLength(1);
	});

	it('ends the run when the asker answers wrongly inside the agent', async () => {
		const tool = delegation({
			createAgent: () =>
				new LLMAgent({
					llmClient: new FakeLLMClient(
						assistantResponse([
							toolCall('ask-1', 'askUser', {
								questions: [
									{
										question: 'Which?',
										options: [
											{ label: 'A', description: '' },
											{ label: 'B', description: '' },
										],
										multiSelect: false,
									},
								],
							}),
						]),
					),
				}),
		});
		const { agent } = delegatingParent(tool, 'Commit');

		await expect(agent.run('work', { signal, ask: () => [] })).rejects.toMatchObject({
			message: 'The asker failed',
		});
	});

	it('ends the run when the agent cannot be created', async () => {
		const tool = delegation({
			createAgent: () => {
				throw new InvalidAgentConfigError('no such model');
			},
		});
		const { agent } = delegatingParent(tool, 'Commit');

		await expect(agent.run('work', { signal })).rejects.toMatchObject({
			message: 'The agent for "commit" could not be created',
		});
	});

	it('leaves the run without a total when an agent was answered without usage', async () => {
		const tool = delegation({
			createAgent: () =>
				new LLMAgent({ llmClient: new FakeLLMClient(textResponse('committed', { usage: null })) }),
		});
		const { agent } = delegatingParent(tool, 'Commit');

		const response = await agent.run('work', { signal });

		expect(response.response).toBe('parent done');
		expect(response.tokens).toBeUndefined();
	});

	it("counts once what a nested agent spent, and wraps its events in its caller's", async () => {
		const grandchild = () =>
			new LLMAgent({ llmClient: new FakeLLMClient(textResponse('committed')) });
		// The coder's second delegation fails, billed: it counts too, once.
		let commits = 0;
		const commit = delegation({
			name: 'commit',
			createAgent: () => {
				commits++;
				return commits === 1
					? grandchild()
					: new LLMAgent({
							llmClient: new FakeLLMClient(textResponse('', { stopReason: 'refused' })),
						});
			},
		});
		const code = delegation({
			name: 'code',
			createAgent: () =>
				new LLMAgent({
					llmClient: new FakeLLMClient(
						assistantResponse([toolCall('k1', 'commit', { task: 'Commit a' })]),
						assistantResponse([toolCall('k2', 'commit', { task: 'Commit b' })]),
						textResponse('coded'),
					),
					tools: [commit],
				}),
		});
		const { agent } = delegatingParent(code, 'Code it');
		const events: ProgressEvent[] = [];

		const response = await agent.run('work', { signal, onProgress: event => events.push(event) });

		// The parent's two steps, the coder's three, and one step of each commit.
		expect(response.tokens).toEqual(tokens(7));
		expect(events).toContainEqual({
			type: 'subagent',
			callId: 'call-1',
			subagent: 1,
			name: 'code',
			task: 'Code it',
			event: {
				type: 'subagent',
				callId: 'k1',
				subagent: 1,
				name: 'commit',
				task: 'Commit a',
				event: { type: 'agentMessage', message: 'committed' },
			},
		});
	});

	it('ends the run with its usage unknown when an agent rejects unclassified', async () => {
		const tool = delegation({
			createAgent: () => ({ run: () => Promise.reject(new Error('not an agent failure')) }),
		});
		const { agent } = delegatingParent(tool, 'Commit');

		const failure = await agent.run('work', { signal }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(UnrecoverableError);
		expect(failure).toMatchObject({ usageUnreported: true, tokens: undefined });
	});

	it('stops the other delegations of the step when one ends the run', async () => {
		let stoppedSignal: AbortSignal | undefined;
		const tool = delegation({
			createAgent: () => ({
				run: (task: string, options: RunOptions) => {
					if (task === 'fails') return Promise.reject(new Error('not classified'));
					stoppedSignal = options.signal;
					return new Promise((_, reject) => {
						options.signal.addEventListener('abort', () => {
							reject(options.signal.reason as Error);
						});
					});
				},
			}),
		});
		const { agent } = delegatingParent(tool, 'waits', 'fails');

		await expect(agent.run('work', { signal })).rejects.toMatchObject({
			message: 'The agent for "commit" failed',
		});
		expect(stoppedSignal?.aborted).toBe(true);
	});

	it("leaves the run's usage unknown when it stopped a delegation that had spent", async () => {
		let holding!: () => void;
		const held = new Promise<void>(resolve => {
			holding = resolve;
		});
		const hold: Tool = {
			name: 'hold',
			description: 'Holds until stopped',
			inputSchema: { type: 'object', properties: {}, required: [] },
			risk: () => 'safe',
			execute: (_, holdSignal) => {
				holding();
				return new Promise((_resolve, reject) => {
					holdSignal.addEventListener('abort', () => {
						reject(holdSignal.reason as Error);
					});
				});
			},
		};
		// One agent has spent a step and holds; the other's approver then fails, ending the run.
		const waits = new LLMAgent({
			llmClient: new FakeLLMClient(assistantResponse([toolCall('h1', 'hold', {})])),
			tools: [hold],
		});
		const fails = new LLMAgent({
			llmClient: new FakeLLMClient(assistantResponse([toolCall('w1', 'wipe', {})])),
			tools: [destructiveTool()],
		});
		const tool = delegation({
			createAgent: () => ({
				run: (task, options) => (task === 'waits' ? waits : fails).run(task, options),
			}),
		});
		const { agent } = delegatingParent(tool, 'waits', 'fails');
		const approve = async () => {
			await held;
			throw new Error('the terminal closed');
		};

		const failure = await agent.run('work', { signal, approve }).catch((error: unknown) => error);

		expect(failure).toMatchObject({
			message: 'The tool call approver failed',
			usageUnreported: true,
			tokens: undefined,
		});
	});

	it('ends as cancelled when the run is cancelled while an agent works', async () => {
		const controller = new AbortController();
		const tool = delegation({
			createAgent: () => ({
				run: (_: string, options: RunOptions) => {
					controller.abort();
					return Promise.reject(options.signal.reason as Error);
				},
			}),
		});
		const { llmClient, agent } = delegatingParent(tool, 'Commit');

		await expect(agent.run('work', { signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(llmClient.contexts).toHaveLength(1);
	});

	it('refuses a call deeper than its maxDepth, and tells the model why', async () => {
		const innermost = new FakeLLMClient(textResponse('never'));
		const inner = delegation({
			name: 'commit',
			maxDepth: 1,
			createAgent: () => new LLMAgent({ llmClient: innermost }),
		});
		const childClient = new FakeLLMClient(
			assistantResponse([toolCall('deeper', 'commit', { task: 'Commit' })]),
			textResponse('child done'),
		);
		const outer = delegation({
			name: 'code',
			createAgent: () => new LLMAgent({ llmClient: childClient, tools: [inner] }),
		});
		const { agent } = delegatingParent(outer, 'Code it');

		await agent.run('work', { signal });

		expect(innermost.contexts).toHaveLength(0);
		expect(childClient.contexts[1]?.at(-1)?.content).toEqual([
			expect.objectContaining({
				isError: true,
				output: expect.stringContaining('may run at most 1 delegations deep') as string,
			}),
		]);
	});

	it('refuses a task with no text', async () => {
		const createAgent = vi.fn((): Agent => new LLMAgent({ llmClient: new FakeLLMClient() }));
		const { llmClient, agent } = delegatingParent(delegation({ createAgent }), '   ');

		await agent.run('work', { signal });

		expect(createAgent).not.toHaveBeenCalled();
		expect(resultsOf(llmClient)).toEqual([
			expect.objectContaining({ isError: true, output: 'The task needs some text.' }),
		]);
	});

	it('names the call that started the agent in its transcript', async () => {
		const transcripts: Transcript[] = [];
		const tool = delegation({
			createAgent: () =>
				new LLMAgent({
					llmClient: new FakeLLMClient(textResponse('committed')),
					onTranscript: transcript => {
						transcripts.push(transcript);
					},
				}),
		});
		const { agent } = delegatingParent(tool, 'Commit');

		await agent.run('work', { signal });

		expect(transcripts).toEqual([
			expect.objectContaining({
				delegation: { tool: 'commit', callId: 'call-1', subagent: 1 },
				outcome: 'completed',
			}),
		]);
	});

	it.each([0, 1.5, Number.NaN])('rejects a maxDepth of %s', maxDepth => {
		expect(() =>
			agentAsTool({ name: 'commit', description: '', createAgent: vi.fn(), maxDepth }),
		).toThrow(InvalidAgentConfigError);
	});

	it('is mutating unless told otherwise', async () => {
		const call = {
			run: undefined as never,
			reads: undefined as never,
			callId: 'call-1',
			onProgress: () => undefined,
			spend: () => undefined,
			depth: 0,
		};
		const createAgent = vi.fn();

		await expect(
			delegation({ createAgent }).prepare({ task: 'Commit' }, signal, call),
		).resolves.toMatchObject({ risk: 'mutating' });
		await expect(
			delegation({ createAgent, risk: 'destructive' }).prepare({ task: 'Commit' }, signal, call),
		).resolves.toMatchObject({ risk: 'destructive' });
	});
});

describe('agentAsTool over a workspace', () => {
	let parent: string;
	let repo: string;

	beforeEach(() => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-delegation-')));
		repo = join(parent, 'repo');
		execFileSync('git', ['init', '--quiet', repo]);
		writeFileSync(join(repo, 'shared.txt'), 'original\n');
	});

	afterEach(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	const read = (path: string) => readFileSync(join(repo, path), 'utf8');

	/** An agent whose model replaces `path` with `content` through `tools`, then answers. */
	function replacer(tools: AgentTool[], path: string, content: string) {
		return new LLMAgent({
			llmClient: new FakeLLMClient(
				assistantResponse([toolCall(`replace-${path}`, 'replace', { path, content })]),
				textResponse(`wrote ${path}`),
			),
			tools,
		});
	}

	it('records what the caller and its agents write as one run, which one undo reverts', async () => {
		const store = await FileRecoveryStore.open({ root: repo, directory: join(parent, 'state') });
		// Each agent has tools of its own over the same workspace.
		const childWrites = await writesOver(repo, store);
		const tool = delegation({
			createAgent: () => replacer([replaceTool(childWrites)], 'b.txt', 'b\n'),
		});
		const parentTools = [replaceTool(await writesOver(repo, store)), tool];
		writeFileSync(join(repo, 'a.txt'), 'a before\n');
		writeFileSync(join(repo, 'b.txt'), 'b before\n');
		const llmClient = new FakeLLMClient(
			assistantResponse([
				toolCall('replace-a', 'replace', { path: 'a.txt', content: 'a\n' }),
				toolCall('call-1', 'commit', { task: 'Write b' }),
			]),
			textResponse('parent done'),
		);

		const { runId } = await new LLMAgent({ llmClient, tools: parentTools }).run('work', {
			signal,
		});

		expect(read('a.txt')).toBe('a\n');
		expect(read('b.txt')).toBe('b\n');
		const history = await createHistory({ root: repo, stateDirectory: join(parent, 'state') });
		const { runs } = await history.list();
		expect(runs.map(run => run.runId)).toEqual([runId]);
		expect(runs[0]?.files).toEqual(['a.txt', 'b.txt']);
		await expect(history.undo()).resolves.toMatchObject({ complete: true });
		expect(read('a.txt')).toBe('a before\n');
		expect(read('b.txt')).toBe('b before\n');
	});

	it('records agents writing at once as one run, which undo reverts exactly', async () => {
		const store = await FileRecoveryStore.open({ root: repo, directory: join(parent, 'state') });
		const writes = await writesOver(repo, store);
		const tool = delegation({
			createAgent: () => {
				const next = contents.shift() ?? '';
				return replacer([replaceTool(writes)], next.startsWith('x') ? 'x.txt' : 'shared.txt', next);
			},
		});
		const contents = ['first\n', 'second\n', 'x\n'];
		writeFileSync(join(repo, 'x.txt'), 'x before\n');
		const { llmClient, agent } = delegatingParent(tool, 'one', 'two', 'three');

		await agent.run('work', { signal });

		expect(read('x.txt')).toBe('x\n');
		// One of them wrote last, or the other was refused for a version that had changed.
		expect(['first\n', 'second\n']).toContain(read('shared.txt'));
		expect(resultsOf(llmClient)).toHaveLength(3);
		const history = await createHistory({ root: repo, stateDirectory: join(parent, 'state') });
		const { runs } = await history.list();
		expect(runs).toHaveLength(1);
		await expect(history.undo()).resolves.toMatchObject({ complete: true });
		expect(read('shared.txt')).toBe('original\n');
		expect(read('x.txt')).toBe('x before\n');
	});
});
