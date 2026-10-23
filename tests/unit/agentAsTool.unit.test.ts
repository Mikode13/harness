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
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message, MessagePart } from '../../src/llm/domain/message.ts';
import { createHistory } from '../../src/recovery/infrastructure/createHistory.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type {
	AgentTool,
	CommandEnding,
	DelegatingTool,
	PreparingTool,
} from '../../src/tools/domain/preparedCall.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import {
	agentAsTool,
	type AgentAsToolOptions,
} from '../../src/tools/infrastructure/agentAsTool.ts';
import { createExploreTool } from '../../src/tools/infrastructure/exploreTool.ts';
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
	}) as unknown as DelegatingTool;
}

/** The answers of agents the harness has given the model in `context`, in order. */
function answersIn(context: Message[] | undefined): string[] {
	return (context ?? [])
		.filter(message => message.role === 'user')
		.flatMap(message => message.content)
		.flatMap(part =>
			part.type === 'text' && part.text.startsWith('This message is from the harness')
				? part.text.split('\n\n').slice(1)
				: [],
		);
}

/**
 * A model that takes `steps` in order, then says it waits until it has read the answers of
 * `agents` agents, and answers `final`: agents finish in their own time.
 */
class WaitingModel implements LLMClient {
	readonly contexts: Message[][] = [];
	private readonly steps: LLMResponse[];
	private readonly agents: number;
	private readonly final: string;

	constructor(steps: LLMResponse[], agents: number, final = 'parent done') {
		this.steps = steps;
		this.agents = agents;
		this.final = final;
	}

	send({ context }: { context: Message[] }, sendSignal: AbortSignal): Promise<LLMResponse> {
		if (sendSignal.aborted) {
			return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
		}
		this.contexts.push(structuredClone(context));
		const next =
			this.steps.shift() ??
			textResponse(answersIn(context).length >= this.agents ? this.final : 'I wait.');
		return Promise.resolve(structuredClone(next));
	}
}

/** A parent that hands each task to `tool` in one step, then answers "parent done". */
function delegatingParent(tool: AgentTool, ...tasks: string[]) {
	const llmClient = new WaitingModel(
		[
			assistantResponse(
				tasks.map((task, index) => toolCall(`call-${String(index + 1)}`, tool.name, { task })),
			),
		],
		tasks.length,
	);
	return { llmClient, agent: new LLMAgent({ llmClient, tools: [tool] }) };
}

/** What the model was sent back for each tool call of its first step. */
function resultsOf(llmClient: { contexts: Message[][] }): MessagePart[] | undefined {
	return llmClient.contexts[1]?.find(message => message.role === 'tool')?.content;
}

/** Every answer of an agent the model read by its last step. */
function answersOf(llmClient: { contexts: Message[][] }): string[] {
	return answersIn(llmClient.contexts.at(-1));
}

/** The call's result: the agents it sent work in the background. */
const sent = (...names: string[]) =>
	expect.stringContaining(
		`Sent to work in the background: ${names.join(', ')}.`,
	) as unknown as string;

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
		// Every step of the parent and one step of each child.
		expect(response.tokens).toEqual(tokens(llmClient.contexts.length + 2));
		expect(children).toHaveLength(2);
		expect(resultsOf(llmClient)).toEqual([
			expect.objectContaining({ callId: 'call-1', output: sent('commit 1'), isError: false }),
			expect.objectContaining({ callId: 'call-2', output: sent('commit 1'), isError: false }),
		]);
		expect(answersOf(llmClient).sort()).toEqual([
			'commit 1, sent by your call call-1 with the task: Commit a.txt\nIts answer:\ncommitted',
			'commit 1, sent by your call call-2 with the task: Commit b.txt\nIts answer:\ncommitted',
		]);
		expect(runs.map(options => delegationOf(options))).toEqual([
			{ tool: 'commit', callId: 'call-1', subagent: 1, depth: 1 },
			{ tool: 'commit', callId: 'call-2', subagent: 1, depth: 1 },
		]);
		// Both children run in the parent's run.
		expect(runContextOf(runs[0] ?? { signal })).toBe(runContextOf(runs[1] ?? { signal }));
		expect(runContextOf(runs[0] ?? { signal })).toBeDefined();
		// The call is narrated as sent, then the agent's work, then its end.
		const first = events.filter(
			event =>
				('callId' in event && event.callId === 'call-1') ||
				('id' in event && event.id === 'call-1'),
		);
		expect(first.map(event => ('status' in event ? event.status : event.type))).toEqual([
			'in_progress',
			'sent',
			'subagent',
			'subagent',
			'subagentEnded',
		]);
		expect(first).toContainEqual({
			type: 'subagent',
			callId: 'call-1',
			subagent: 1,
			name: 'commit',
			task: 'Commit a.txt',
			event: { type: 'agentMessage', message: 'committed' },
		});
		expect(first.at(-1)).toEqual({
			type: 'subagentEnded',
			callId: 'call-1',
			subagent: 1,
			name: 'commit',
			outcome: 'answered',
		});
	});

	it('lets the caller work while its agents do, and gives it each answer as it arrives', async () => {
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
			textResponse('I wait for a and b.'),
			textResponse('I wait for a.'),
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
		const events: ProgressEvent[] = [];
		const running = new LLMAgent({ llmClient, tools: [tool, note] }).run('work', {
			signal,
			onProgress: event => events.push(event),
		});

		// Its next step comes while both agents still work, with every call answered.
		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(2);
		});
		expect(started).toEqual(['a', 'b']);
		expect(execute).toHaveBeenCalledOnce();
		expect(resultsOf(llmClient)).toEqual([
			expect.objectContaining({ callId: 'call-1', output: sent('commit 1') }),
			expect.objectContaining({ callId: 'call-2', output: sent('commit 1') }),
			expect.objectContaining({ callId: 'call-3', output: 'noted' }),
		]);
		// Its answer while they work is a wait, narrated like any message.
		await vi.waitFor(() => {
			expect(events).toContainEqual({ type: 'agentMessage', message: 'I wait for a and b.' });
		});
		expect(llmClient.contexts).toHaveLength(2);

		// It goes on with the first to finish, without waiting for the other.
		finish.b?.({ response: 'b done', duration: 0 });
		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(3);
		});
		expect(answersIn(llmClient.contexts[2])).toEqual([
			'commit 1, sent by your call call-2 with the task: b\nIts answer:\nb done',
		]);
		finish.a?.({ response: 'a done', duration: 0 });

		await expect(running).resolves.toMatchObject({ response: 'parent done' });
		expect(answersIn(llmClient.contexts[3]).at(-1)).toBe(
			'commit 1, sent by your call call-1 with the task: a\nIts answer:\na done',
		);
	});

	it("gives an answer that arrived while the caller ran tools after that step's results", async () => {
		const tool = delegation({
			createAgent: () => new LLMAgent({ llmClient: new FakeLLMClient(textResponse('committed')) }),
		});
		// It works long enough for the agent to finish meanwhile.
		const slow: Tool = {
			name: 'slow',
			description: 'Takes a while',
			inputSchema: { type: 'object', properties: {}, required: [] },
			risk: () => 'safe',
			execute: () =>
				new Promise(resolve =>
					setTimeout(() => {
						resolve('slow done');
					}, 10),
				),
		};
		const llmClient = new WaitingModel(
			[
				assistantResponse([
					toolCall('call-1', 'commit', { task: 'Commit' }),
					toolCall('call-2', 'slow', {}),
				]),
			],
			1,
		);

		await new LLMAgent({ llmClient, tools: [tool, slow] }).run('work', { signal });

		// The step after: every call's result, then the answer, as the model reads them.
		expect(llmClient.contexts).toHaveLength(2);
		expect(llmClient.contexts[1]?.slice(-2)).toEqual([
			{
				role: 'tool',
				content: [
					expect.objectContaining({ callId: 'call-1', output: sent('commit 1') }),
					expect.objectContaining({ callId: 'call-2', output: 'slow done' }),
				],
			},
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: 'This message is from the harness, not the user: agents you sent finished.\n\ncommit 1, sent by your call call-1 with the task: Commit\nIts answer:\ncommitted',
					},
				],
			},
		]);
	});

	it('gives each explorer of one explore call to the caller as it finishes', async () => {
		const finish: Record<string, (response: AgentResponse) => void> = {};
		const explore = createExploreTool(() => ({
			run: (question: string) =>
				new Promise(resolve => {
					finish[question] = resolve;
				}),
		}));
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'explore', { questions: ['a?', 'b?'] })]),
			textResponse('I wait for both.'),
			textResponse('I wait for a.'),
			textResponse('parent done'),
		);
		const running = new LLMAgent({ llmClient, tools: [explore] }).run('work', { signal });

		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(2);
		});
		finish['b?']?.({ response: 'b is here', duration: 0 });
		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(3);
		});
		expect(answersIn(llmClient.contexts[2])).toEqual([
			'explorer 2, sent by your call call-1 with the task: b?\nIts answer:\nb is here',
		]);
		finish['a?']?.({ response: 'a is here', duration: 0 });

		await expect(running).resolves.toMatchObject({ response: 'parent done' });
		expect(answersIn(llmClient.contexts[3]).at(-1)).toBe(
			'explorer 1, sent by your call call-1 with the task: a?\nIts answer:\na is here',
		);
	});

	it('ends only once every agent it sent has answered, and the model read it', async () => {
		let finish!: (response: AgentResponse) => void;
		const tool = delegation({
			createAgent: () => ({
				run: () =>
					new Promise(resolve => {
						finish = resolve;
					}),
			}),
		});
		const { llmClient, agent } = delegatingParent(tool, 'Commit');
		let ended = false;
		const running = agent.run('work', { signal }).finally(() => {
			ended = true;
		});

		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(2);
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		// It answered "I wait.", and makes no call while the agent works.
		expect(ended).toBe(false);
		expect(llmClient.contexts).toHaveLength(2);
		finish({ response: 'committed', duration: 0 });

		await expect(running).resolves.toMatchObject({ response: 'parent done' });
		expect(llmClient.contexts).toHaveLength(3);
	});

	it('fails at its step limit when it is still waiting for an agent', async () => {
		let stopped: AbortSignal | undefined;
		// It works until it is stopped.
		const tool = delegation({
			createAgent: () => ({
				run: (_: string, options: RunOptions) =>
					new Promise((_resolve, reject) => {
						options.signal.addEventListener('abort', () => {
							stopped = options.signal;
							reject(options.signal.reason as Error);
						});
					}),
			}),
		});
		const llmClient = new WaitingModel(
			[assistantResponse([toolCall('call-1', 'commit', { task: 'Commit' })])],
			1,
		);

		const events: ProgressEvent[] = [];

		await expect(
			new LLMAgent({ llmClient, tools: [tool], maxSteps: 2 }).run('work', {
				signal,
				onProgress: event => events.push(event),
			}),
		).rejects.toMatchObject({
			message: 'The LLM did not finish within its step limit',
			cause: 'The model was still waiting for the agents it sent after 2 steps.',
			// The agent was stopped before it reported what it spent.
			usageUnreported: true,
		});
		expect(stopped?.aborted).toBe(true);
		expect(events.at(-1)).toEqual({
			type: 'subagentEnded',
			callId: 'call-1',
			subagent: 1,
			name: 'commit',
			outcome: 'stopped',
		});
	});

	it('gives the model an agent that failed as its answer, with what it spent', async () => {
		const tool = delegation({
			createAgent: () =>
				new LLMAgent({ llmClient: new FakeLLMClient(textResponse('', { stopReason: 'refused' })) }),
		});
		const { llmClient, agent } = delegatingParent(tool, 'Commit');
		const events: ProgressEvent[] = [];

		const response = await agent.run('work', { signal, onProgress: event => events.push(event) });

		expect(response.response).toBe('parent done');
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'subagentEnded', outcome: 'failed' }),
		);
		expect(response.tokens).toEqual(tokens(llmClient.contexts.length + 1));
		expect(answersOf(llmClient)).toEqual([
			expect.stringContaining(
				'Its answer:\nThe agent failed: The LLM stopped before completing its answer',
			),
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
		const llmClient = new WaitingModel(
			[assistantResponse([toolCall('call-1', 'commit', { task: 'Commit' })])],
			1,
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
		// Every step of the parent, and the child's one.
		expect((failure as UnrecoverableError).tokens).toEqual(tokens(llmClient.contexts.length + 1));
		// The parent's model never reads an answer it would carry on from.
		expect(llmClient.contexts.flatMap(answersIn)).toEqual([]);
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
		const coder = new WaitingModel(
			[
				assistantResponse([toolCall('k1', 'commit', { task: 'Commit a' })]),
				assistantResponse([toolCall('k2', 'commit', { task: 'Commit b' })]),
			],
			2,
			'coded',
		);
		const code = delegation({
			name: 'code',
			createAgent: () => new LLMAgent({ llmClient: coder, tools: [commit] }),
		});
		const { llmClient, agent } = delegatingParent(code, 'Code it');
		const events: ProgressEvent[] = [];

		const response = await agent.run('work', { signal, onProgress: event => events.push(event) });

		// Every step of the parent and of the coder, and one step of each commit.
		expect(response.tokens).toEqual(tokens(llmClient.contexts.length + coder.contexts.length + 2));
		// The coder ended only once both its commits had answered.
		expect(answersOf(coder)).toHaveLength(2);
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

	it('stops every agent still working when one ends the run', async () => {
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

	it("leaves the run's usage unknown when it stopped an agent that had spent", async () => {
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

	it('stops every agent when the run is cancelled while it waits, and ends once they have', async () => {
		const controller = new AbortController();
		const stopped: string[] = [];
		const tool = delegation({
			createAgent: () => ({
				run: (task: string, options: RunOptions) =>
					new Promise((_resolve, reject) => {
						options.signal.addEventListener('abort', () => {
							// It takes a moment to stop, and the run waits for it.
							setTimeout(() => {
								stopped.push(task);
								reject(options.signal.reason as Error);
							}, 5);
						});
					}),
			}),
		});
		const { llmClient, agent } = delegatingParent(tool, 'a', 'b');
		const running = agent.run('work', { signal: controller.signal });

		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(2);
		});
		controller.abort();

		await expect(running).rejects.toMatchObject({ name: 'AbortError' });
		expect(stopped.sort()).toEqual(['a', 'b']);
	});

	it('never takes a check passing alike for a loop while an agent that may change files works', async () => {
		// A check that passes again is a loop only when nothing could have changed in between.
		const ending: CommandEnding = {
			passed: true,
			how: 'exited with code 0',
			output: 'all passed',
			fingerprint: 'all passed',
			state: 'one',
			changed: [],
		};
		const command: PreparingTool = {
			name: 'runCommand',
			description: 'Runs a command',
			inputSchema: { type: 'object', properties: {}, required: [] },
			prepare: () =>
				Promise.resolve({ risk: 'safe', ending: () => ending, run: () => Promise.resolve('ran') }),
		};
		let finish!: (response: AgentResponse) => void;
		const tool = delegation({
			createAgent: () => ({
				run: () =>
					new Promise(resolve => {
						finish = resolve;
					}),
			}),
		});
		const check = (id: string) => toolCall(id, 'runCommand', {});
		const llmClient = new WaitingModel(
			[
				assistantResponse([toolCall('call-1', 'commit', { task: 'Commit' }), check('check-1')]),
				assistantResponse([check('check-2')]),
				assistantResponse([check('check-3')]),
			],
			1,
		);
		const running = new LLMAgent({ llmClient, tools: [tool, command] }).run('work', { signal });

		await vi.waitFor(() => {
			expect(llmClient.contexts).toHaveLength(4);
		});
		finish({ response: 'committed', duration: 0 });
		await running;

		const checks = llmClient.contexts
			.at(-1)
			?.flatMap(message => message.content)
			.flatMap(part =>
				part.type === 'toolResult' && part.name === 'runCommand' ? [part.output] : [],
			);
		expect(checks).toEqual(['ran', 'ran', 'ran']);
	});

	it('ends the run when the progress callback fails on what an agent narrates', async () => {
		const tool = delegation({
			createAgent: () => new LLMAgent({ llmClient: new FakeLLMClient(textResponse('committed')) }),
		});
		const { llmClient, agent } = delegatingParent(tool, 'Commit');

		await expect(
			agent.run('work', {
				signal,
				onProgress: event => {
					if (event.type === 'subagent') throw new Error('the terminal closed');
				},
			}),
		).rejects.toMatchObject({ message: 'LLM agent progress callback failed' });
		// The parent's model never reads the answer of an agent whose narration was lost.
		expect(llmClient.contexts.flatMap(answersIn)).toEqual([]);
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
			delegation({ createAgent }).delegate({ task: 'Commit' }, signal, call),
		).resolves.toMatchObject({ risk: 'mutating' });
		await expect(
			delegation({ createAgent, risk: 'destructive' }).delegate({ task: 'Commit' }, signal, call),
		).resolves.toMatchObject({ risk: 'destructive' });
		// Preparing hands nothing over.
		expect(createAgent).not.toHaveBeenCalled();
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
		const llmClient = new WaitingModel(
			[
				assistantResponse([
					toolCall('replace-a', 'replace', { path: 'a.txt', content: 'a\n' }),
					toolCall('call-1', 'commit', { task: 'Write b' }),
				]),
			],
			1,
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
