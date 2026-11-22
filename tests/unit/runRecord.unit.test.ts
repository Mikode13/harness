import { describe, expect, it, vi } from 'vitest';
import type { Agent, RunOptions } from '../../src/agent/domain/agent.ts';
import type { UserQuestion } from '../../src/agent/domain/question.ts';
import {
	delegatedAsking,
	RecordingAgent,
	roleAsking,
} from '../../src/agent/domain/recordingAgent.ts';
import { runRecordVersion, type RunEntry } from '../../src/agent/domain/runRecord.ts';
import { UnrecoverableCommittedRunError } from '../../src/agent/domain/committedRunError.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { RetryingAgent } from '../../src/retry/domain/model/retryingAgent.ts';
import { RecoverableError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import { agentAsTool } from '../../src/tools/infrastructure/agentAsTool.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';

const question: UserQuestion = {
	question: 'Which shape should the API take?',
	options: [
		{ label: 'One function', description: 'Simpler, one more parameter.' },
		{ label: 'Two functions', description: 'One per path.' },
	],
	multiSelect: false,
};

const askCall = (id = 'ask-1') => toolCall(id, 'askUser', { questions: [question] });

const emptySchema = { type: 'object' as const, properties: {}, required: [] };

/** A tool with an effect: each call is counted in `runs`. */
function effectTool(name: string, risk: 'mutating' | 'destructive' = 'mutating') {
	const runs = { count: 0 };
	const tool: Tool = {
		name,
		description: `The ${name} tool`,
		inputSchema: emptySchema,
		risk: () => risk,
		execute: () => {
			runs.count++;
			return Promise.resolve(`${name} done`);
		},
	};
	return { tool, runs };
}

const logger = () => ({ warn: vi.fn() });

/**
 * An agent on the model APIs as `createLLMAgent` builds it, with retry and the record, over
 * `llmClient`.
 */
function recorded(llmClient: FakeLLMClient, tools: Tool[] = [], log = logger()) {
	return new RecordingAgent({
		inner: new RetryingAgent({
			inner: new LLMAgent({ llmClient, tools }),
			logger: log,
			noteFailures: false,
		}),
		logger: log,
	});
}

/** The record's entries with their progress events reduced to their type, for an order check. */
function shapeOf(entries: RunEntry[]): string[] {
	return entries.map(entry => {
		if (entry.type === 'progress') {
			const { event } = entry;
			return event.type === 'tool' ? `progress:tool:${event.status}` : `progress:${event.type}`;
		}
		return entry.type === 'end' ? `end:${entry.outcome}` : entry.type;
	});
}

function collect(): { entries: RunEntry[]; onRecord: (entry: RunEntry) => void } {
	const entries: RunEntry[] = [];
	return { entries, onRecord: entry => void entries.push(entry) };
}

describe('the run record', () => {
	it('records a run that asks: its progress, the question, the answer and its end, in order', async () => {
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));
		const { entries, onRecord } = collect();
		const progress = vi.fn();
		const ask = vi.fn(() => {
			// The question is in the record before the asker sees it.
			expect(entries.at(-1)).toMatchObject({ type: 'question' });
			return ['Two functions'];
		});

		const response = await recorded(llmClient).run('design it', {
			signal: new AbortController().signal,
			onProgress: progress,
			ask,
			onRecord,
		});

		expect(shapeOf(entries).filter(shape => shape !== 'progress:step')).toEqual([
			'progress:tool:in_progress',
			'question',
			'answer',
			'progress:tool:completed',
			'progress:agentMessage',
			'end:completed',
		]);
		expect(entries.find(entry => entry.type === 'question')).toEqual({
			version: 1,
			type: 'question',
			id: 1,
			questions: [question],
			origin: {},
		});
		expect(entries.find(entry => entry.type === 'answer')).toEqual({
			version: 1,
			type: 'answer',
			id: 1,
			answers: ['Two functions'],
		});
		expect(entries.at(-1)).toEqual({ version: 1, type: 'end', outcome: 'completed', response });
		// The consumer's own callbacks work as they did.
		expect(progress.mock.calls.map(([event]) => event as unknown)).toEqual(
			entries.flatMap(entry => (entry.type === 'progress' ? [entry.event] : [])),
		);
		expect(ask).toHaveBeenCalledOnce();
		// Plain JSON, for a consumer that stores it as it is.
		expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
		expect(entries.map(entry => entry.version)).toEqual(entries.map(() => runRecordVersion));
	});

	it('records a denied call with its request and the decision', async () => {
		const { tool, runs } = effectTool('delete', 'destructive');
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'delete')]),
			textResponse('I left it'),
		);
		const { entries, onRecord } = collect();

		await recorded(llmClient, [tool]).run('delete it', {
			signal: new AbortController().signal,
			approve: () => ({ approved: false, reason: 'Keep it' }),
			onRecord,
		});

		expect(runs.count).toBe(0);
		expect(shapeOf(entries).filter(shape => shape !== 'progress:step')).toEqual([
			'approvalRequest',
			'approvalDecision',
			'progress:tool:denied',
			'progress:agentMessage',
			'end:completed',
		]);
		expect(entries.filter(entry => entry.type.startsWith('approval'))).toEqual([
			{
				version: 1,
				type: 'approvalRequest',
				id: 1,
				request: { tool: 'delete', input: {}, risk: 'destructive' },
				origin: {},
			},
			{
				version: 1,
				type: 'approvalDecision',
				id: 1,
				decision: { approved: false, reason: 'Keep it' },
			},
		]);
	});

	it('records a failed run with the failure it rejects with', async () => {
		const failure = new UnrecoverableError('The model refused', { cause: 'refusal' });
		const { entries, onRecord } = collect();

		const run = recorded(new FakeLLMClient(failure)).run('go', {
			signal: new AbortController().signal,
			onRecord,
		});

		await expect(run).rejects.toBe(failure);
		expect(entries).toEqual([
			{
				version: 1,
				type: 'end',
				outcome: 'failed',
				failure: {
					recoverable: false,
					message: 'The model refused',
					cause: 'refusal',
					usageUnreported: false,
				},
			},
		]);
	});

	it('records a cancelled run as cancelled, and its AbortError propagates unchanged', async () => {
		const controller = new AbortController();
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));
		const { entries, onRecord } = collect();
		let reason: unknown;

		const run = recorded(llmClient).run('design it', {
			signal: controller.signal,
			ask: (_, signal) => {
				controller.abort();
				reason = signal.reason;
				throw signal.reason;
			},
			onRecord,
		});

		await expect(run).rejects.toSatisfy(error => error === reason && reason !== undefined);
		expect(shapeOf(entries).filter(shape => shape !== 'progress:step')).toEqual([
			'progress:tool:in_progress',
			'question',
			'end:cancelled',
		]);
		expect(entries.at(-1)).toEqual({ version: 1, type: 'end', outcome: 'cancelled', by: 'abort' });
	});

	it('tells a timeout from an abort', async () => {
		const signal = AbortSignal.abort(new DOMException('Too slow', 'TimeoutError'));
		const { entries, onRecord } = collect();

		const cancelled: Agent = {
			run: (_, options) => {
				options.signal.throwIfAborted();
				return Promise.resolve({ response: 'not cancelled', duration: 0 });
			},
		};

		await expect(
			new RecordingAgent({ inner: cancelled, logger: logger() }).run('go', { signal, onRecord }),
		).rejects.toBe(signal.reason);
		// A provider's own abort error, as the model clients may throw, is a timeout all the same.
		await expect(
			recorded(new FakeLLMClient(textResponse('late'))).run('go', { signal, onRecord }),
		).rejects.toMatchObject({ name: 'AbortError' });
		const timedOut = { version: 1, type: 'end', outcome: 'cancelled', by: 'timeout' };
		expect(entries).toEqual([timedOut, timedOut]);
	});

	it("records a delegated agent's question where it asked, and only the run's own end", async () => {
		const child = new FakeLLMClient(assistantResponse([askCall()]), textResponse('committed'));
		const tool = agentAsTool({
			name: 'commit',
			description: 'Commits the work',
			// An agent from a factory keeps a record of its own only for a run given `onRecord`.
			createAgent: () => recorded(child),
		}) as unknown as Tool;
		const parent = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'commit', { task: 'Commit it' })]),
			textResponse('I wait.'),
			textResponse('parent done'),
		);
		const { entries, onRecord } = collect();

		await recorded(parent, [tool]).run('ship it', {
			signal: new AbortController().signal,
			ask: () => ['One function'],
			onRecord,
		});

		const question = entries.find(entry => entry.type === 'question');
		expect(question).toMatchObject({
			origin: { delegation: [{ name: 'commit', callId: 'call-1', subagent: 1 }] },
		});
		// The subagent's narration is in the record as it is in the progress.
		const ended = entries.findIndex(
			entry => entry.type === 'progress' && entry.event.type === 'subagentEnded',
		);
		expect(entries.indexOf(question as RunEntry)).toBeLessThan(ended);
		expect(entries.filter(entry => entry.type === 'end')).toEqual([
			expect.objectContaining({ outcome: 'completed' }),
		]);
		expect(entries.at(-1)?.type).toBe('end');
	});

	it('names the role and every delegation on the way, the outermost first', async () => {
		const { entries, onRecord } = collect();
		const asking: Agent = {
			run: async (_, options) => {
				const role = roleAsking(options, 'executor');
				const outer = delegatedAsking(role, { name: 'code', callId: 'call-1', subagent: 1 });
				const inner = delegatedAsking(outer, { name: 'commit', callId: 'call-7', subagent: 2 });
				await inner.ask?.([question], options.signal);
				await role.approve?.({ tool: 'delete', input: {}, risk: 'destructive' }, options.signal);
				return { response: 'done', duration: 0 };
			},
		};

		await new RecordingAgent({ inner: asking, logger: logger() }).run('go', {
			signal: new AbortController().signal,
			ask: () => ['One function'],
			approve: () => ({ approved: true }),
			onRecord,
		});

		expect(entries.find(entry => entry.type === 'question')).toMatchObject({
			origin: {
				agent: 'executor',
				delegation: [
					{ name: 'code', callId: 'call-1', subagent: 1 },
					{ name: 'commit', callId: 'call-7', subagent: 2 },
				],
			},
		});
		expect(entries.find(entry => entry.type === 'approvalRequest')).toMatchObject({
			id: 2,
			origin: { agent: 'executor' },
		});
	});

	it('hands entries one at a time, in order, and asks only once the question is taken', async () => {
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));
		const taken: string[] = [];
		let taking = 0;
		let most = 0;
		const onRecord = async (entry: RunEntry) => {
			taking++;
			most = Math.max(most, taking);
			await new Promise(resolve => setTimeout(resolve, 2));
			taken.push(entry.type);
			taking--;
		};
		const ask = vi.fn(() => {
			expect(taken.at(-1)).toBe('question');
			return ['One function'];
		});

		await recorded(llmClient).run('design it', {
			signal: new AbortController().signal,
			ask,
			onRecord,
		});

		expect(most).toBe(1);
		expect(ask).toHaveBeenCalledOnce();
		expect(taken.filter(type => type !== 'progress')).toEqual(['question', 'answer', 'end']);
		// `run()` resolves only once its end is taken.
		expect(taken.at(-1)).toBe('end');
	});

	it('lets a cancellation end a run at once while its record still takes a question, and ends the record after', async () => {
		const controller = new AbortController();
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));
		const ask = vi.fn(() => ['One function']);
		const entries: RunEntry[] = [];

		const run = recorded(llmClient).run('design it', {
			signal: controller.signal,
			ask,
			onRecord: entry => {
				entries.push(entry);
				if (entry.type !== 'question') return undefined;
				// A slow store: the user cancels while it takes the question.
				setTimeout(() => {
					controller.abort();
				}, 5);
				return new Promise<void>(resolve => setTimeout(resolve, 30));
			},
		});

		const error = await run.catch((failure: unknown) => failure);
		expect(error).toBe(controller.signal.reason);
		expect(ask).not.toHaveBeenCalled();
		// `run()` settled while the record still took the question: the end comes after it.
		expect(entries.at(-1)).toMatchObject({ type: 'question' });
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(entries.at(-1)).toEqual({ version: 1, type: 'end', outcome: 'cancelled', by: 'abort' });
	});

	it('ends a cancelled run at once even when its record never settles an entry', async () => {
		const controller = new AbortController();
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));

		const run = recorded(llmClient).run('design it', {
			signal: controller.signal,
			ask: () => ['One function'],
			onRecord: entry => {
				if (entry.type !== 'question') return undefined;
				setTimeout(() => {
					controller.abort();
				}, 5);
				// A store that hangs: it never answers.
				return new Promise<void>(() => undefined);
			},
		});

		const error = await run.catch((failure: unknown) => failure);
		expect(error).toBe(controller.signal.reason);
		expect(error).toBeDefined();
	});

	it('ends a run cancelled while its record takes the completed end with the cancellation, at once', async () => {
		const controller = new AbortController();
		const llmClient = new FakeLLMClient(textResponse('done'));

		const run = recorded(llmClient).run('design it', {
			signal: controller.signal,
			onRecord: entry => {
				if (entry.type !== 'end') return undefined;
				setTimeout(() => {
					controller.abort();
				}, 5);
				return new Promise<void>(() => undefined);
			},
		});

		const error = await run.catch((failure: unknown) => failure);
		expect(error).toBe(controller.signal.reason);
		expect(error).toBeDefined();
	});

	it('hands on every entry that waited, in order, when only some of them take time', async () => {
		const taken: number[] = [];
		const emitting: Agent = {
			run: (_, options) => {
				for (let index = 1; index <= 4; index++) {
					options.onProgress?.({ type: 'agentMessage', message: String(index) });
				}
				return Promise.resolve({ response: 'done', duration: 0 });
			},
		};

		await new RecordingAgent({ inner: emitting, logger: logger() }).run('go', {
			signal: new AbortController().signal,
			onRecord: entry => {
				if (entry.type !== 'progress' || entry.event.type !== 'agentMessage') return undefined;
				taken.push(Number(entry.event.message));
				// Only the first takes time; the others are taken at once.
				return entry.event.message === '1'
					? new Promise(resolve => setTimeout(resolve, 2))
					: undefined;
			},
		});

		expect(taken).toEqual([1, 2, 3, 4]);
	});

	it('asks once the question is taken, without waiting for what was narrated after it', async () => {
		const taken: string[] = [];
		let takenWhenAsked: string[] = [];
		const asking: Agent = {
			run: async (_, options) => {
				const asked = options.ask?.([question], options.signal);
				// Such as an agent in the background narrating while the question waits to be taken.
				options.onProgress?.({ type: 'agentMessage', message: 'later' });
				await asked;
				return { response: 'done', duration: 0 };
			},
		};

		await new RecordingAgent({ inner: asking, logger: logger() }).run('go', {
			signal: new AbortController().signal,
			ask: () => {
				takenWhenAsked = [...taken];
				return ['One function'];
			},
			onRecord: async entry => {
				await new Promise(resolve => setTimeout(resolve, entry.type === 'progress' ? 50 : 1));
				taken.push(entry.type);
			},
		});

		expect(takenWhenAsked).toEqual(['question']);
		expect(taken).toEqual(['question', 'progress', 'answer', 'end']);
	});

	it('hands the callback copies, so what it changes never reaches the asker or what run() returns', async () => {
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));
		const asked: unknown[] = [];

		const response = await recorded(llmClient).run('design it', {
			signal: new AbortController().signal,
			ask: questions => {
				asked.push(structuredClone(questions));
				return ['Two functions'];
			},
			onRecord: entry => {
				if (entry.type === 'question') {
					(entry.questions[0] as { question: string }).question = 'Changed by the record';
				}
				if (entry.type === 'end' && entry.outcome === 'completed') {
					(entry.response as { response: string }).response = 'Changed by the record';
				}
			},
		});

		expect(asked).toEqual([[question]]);
		expect(response.response).toBe('done');
	});

	it('takes each entry as it was when it happened, even if the run changes the value after', async () => {
		const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));
		const { entries, onRecord } = collect();

		await recorded(llmClient).run('design it', {
			signal: new AbortController().signal,
			ask: questions => {
				(questions[0] as { question: string }).question = 'Changed by the asker';
				return ['Two functions'];
			},
			onRecord,
		});

		expect(entries.find(entry => entry.type === 'question')).toMatchObject({
			questions: [question],
		});
	});

	it('leaves a run without onRecord exactly as it was', async () => {
		const inner = {
			run: vi.fn<Agent['run']>(() => Promise.resolve({ response: 'hi', duration: 0 })),
		};
		const options: RunOptions = { signal: new AbortController().signal, ask: () => ['x'] };

		await new RecordingAgent({ inner, logger: logger() }).run('go', options);

		expect(inner.run).toHaveBeenCalledWith('go', options);
		expect(inner.run.mock.calls[0]?.[1]).toBe(options);
	});

	it('keeps the record to the run the consumer started: an agent inside gets no onRecord', async () => {
		const inner = {
			run: vi.fn<Agent['run']>(() => Promise.resolve({ response: 'hi', duration: 0 })),
		};
		await new RecordingAgent({ inner, logger: logger() }).run('go', {
			signal: new AbortController().signal,
			onRecord: () => undefined,
		});

		expect(inner.run.mock.calls[0]?.[1].onRecord).toBeUndefined();
	});

	describe('a consumer that fails to take an entry', () => {
		it('never asks a question it did not take, and nothing that ran runs again', async () => {
			const { tool, runs } = effectTool('write');
			const llmClient = new FakeLLMClient(
				assistantResponse([toolCall('call-1', 'write'), askCall()]),
				textResponse('done'),
			);
			const ask = vi.fn(() => ['One function']);

			const run = recorded(llmClient, [tool]).run('go', {
				signal: new AbortController().signal,
				ask,
				onRecord: entry => {
					if (entry.type === 'question') return Promise.reject(new Error('Disk full'));
					return undefined;
				},
			});

			await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
			await expect(run).rejects.toMatchObject({ cause: 'Disk full' });
			expect(ask).not.toHaveBeenCalled();
			expect(runs.count).toBe(1);
			// Not retried: the model was called once.
			expect(llmClient.contexts).toHaveLength(1);
		});

		it('never gives the model an answer it did not take', async () => {
			const llmClient = new FakeLLMClient(assistantResponse([askCall()]), textResponse('done'));

			const run = recorded(llmClient).run('go', {
				signal: new AbortController().signal,
				ask: () => ['One function'],
				onRecord: entry => {
					if (entry.type === 'answer') throw new Error('Disk full');
				},
			});

			await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
			expect(llmClient.contexts).toHaveLength(1);
		});

		it('never runs a call whose approval request or decision it did not take', async () => {
			for (const failing of ['approvalRequest', 'approvalDecision'] as const) {
				const { tool, runs } = effectTool('delete', 'destructive');
				const llmClient = new FakeLLMClient(
					assistantResponse([toolCall('call-1', 'delete')]),
					textResponse('done'),
				);
				const approve = vi.fn(() => ({ approved: true as const }));

				const run = recorded(llmClient, [tool]).run('go', {
					signal: new AbortController().signal,
					approve,
					onRecord: entry => {
						if (entry.type === failing) throw new Error('Disk full');
					},
				});

				await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
				expect(runs.count).toBe(0);
				expect(approve).toHaveBeenCalledTimes(failing === 'approvalRequest' ? 0 : 1);
				expect(llmClient.contexts).toHaveLength(1);
			}
		});

		it('ends the run at its next narration after a progress entry it failed to take, and takes nothing more', async () => {
			const { tool, runs } = effectTool('write');
			const llmClient = new FakeLLMClient(
				assistantResponse([toolCall('call-1', 'write')]),
				assistantResponse([toolCall('call-2', 'write')]),
				textResponse('done'),
			);
			const taken: RunEntry[] = [];

			const run = recorded(llmClient, [tool]).run('go', {
				signal: new AbortController().signal,
				onRecord: entry => {
					taken.push(entry);
					// The first entry, the first call's start, fails once the run moved on.
					if (taken.length === 1) return Promise.reject(new Error('Connection lost'));
					return undefined;
				},
			});

			await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
			await expect(run).rejects.toMatchObject({ cause: 'Connection lost' });
			expect(taken).toHaveLength(1);
			// The first call may have run before the failure arrived; nothing runs again.
			expect(runs.count).toBeLessThanOrEqual(1);
			expect(llmClient.contexts).toHaveLength(1);
		});

		it('rejects a completed run whose end it did not take, with what the run spent', async () => {
			const { tool, runs } = effectTool('write');
			const llmClient = new FakeLLMClient(
				assistantResponse([toolCall('call-1', 'write')], {
					usage: { inputTokens: 10, outputTokens: 1 },
				}),
				textResponse('done', { usage: { inputTokens: 20, outputTokens: 2 } }),
			);

			const run = recorded(llmClient, [tool]).run('go', {
				signal: new AbortController().signal,
				onRecord: entry => {
					if (entry.type === 'end') return Promise.reject(new Error('Disk full'));
					return undefined;
				},
			});

			await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
			await expect(run).rejects.toMatchObject({
				message: 'The run completed, but its record could not take every entry',
				cause: 'Disk full',
				tokens: { inputTokens: 30, outputTokens: 3 },
			});
			expect(runs.count).toBe(1);
			expect(llmClient.contexts).toHaveLength(2);
		});

		it('carries what a completed run committed when it did not take its end', async () => {
			const commits = {
				outcome: 'committed' as const,
				repositories: [
					{
						repository: '/repo',
						branch: 'main',
						outcome: 'done' as const,
						commits: [{ sha: 'a'.repeat(40), subject: 'Change a' }],
						paths: ['a.ts'],
						leftOut: [],
						unreviewed: [],
					},
				],
			};
			const phases = [{ goal: 'parse', status: 'approved' as const, summary: 'parsed' }];
			const committing: Agent = {
				run: () =>
					Promise.resolve({ response: 'done', duration: 0, commits, phases, runId: 'run-1' }),
			};

			const run = new RecordingAgent({ inner: committing, logger: logger() }).run('go', {
				signal: new AbortController().signal,
				onRecord: entry => {
					if (entry.type === 'end') throw new Error('Disk full');
				},
			});

			await expect(run).rejects.toBeInstanceOf(UnrecoverableCommittedRunError);
			await expect(run).rejects.toMatchObject({
				message: 'The run completed, but its record could not take every entry',
				cause: 'Disk full',
				commits,
				phases,
				runId: 'run-1',
			});
		});

		it('keeps the failure or the cancellation of a run whose end it did not take, and logs it', async () => {
			const failure = new RecoverableError('Connection lost', { cause: 'reset' });
			const log = logger();
			const controller = new AbortController();
			controller.abort();
			const onRecord = () => Promise.reject(new Error('Disk full'));
			const failing: Agent = { run: () => Promise.reject(failure) };

			await expect(
				new RecordingAgent({ inner: failing, logger: log }).run('go', {
					signal: controller.signal,
					onRecord,
				}),
			).rejects.toBe(failure);
			const cancelled: Agent = {
				run: (_, options) => {
					options.signal.throwIfAborted();
					return Promise.resolve({ response: 'not cancelled', duration: 0 });
				},
			};
			await expect(
				new RecordingAgent({ inner: cancelled, logger: log }).run('go', {
					signal: controller.signal,
					onRecord,
				}),
			).rejects.toBe(controller.signal.reason);
			expect(log.warn).toHaveBeenCalledTimes(2);
			expect(log.warn).toHaveBeenCalledWith("The run's record could not take its end: Disk full");
		});

		it('ends the run when an agent another agent started asks a question it did not take', async () => {
			const child = new FakeLLMClient(assistantResponse([askCall()]), textResponse('committed'));
			const tool = agentAsTool({
				name: 'commit',
				description: 'Commits the work',
				createAgent: () => recorded(child),
			}) as unknown as Tool;
			const parent = new FakeLLMClient(
				assistantResponse([toolCall('call-1', 'commit', { task: 'Commit it' })]),
				textResponse('I wait.'),
				textResponse('parent done'),
			);
			const ask = vi.fn(() => ['One function']);

			const run = recorded(parent, [tool]).run('ship it', {
				signal: new AbortController().signal,
				ask,
				onRecord: entry => {
					if (entry.type === 'question') throw new Error('Disk full');
				},
			});

			await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
			expect(ask).not.toHaveBeenCalled();
		});
	});
});
