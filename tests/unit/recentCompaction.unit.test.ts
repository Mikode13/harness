import { describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import type { LLMClient } from '../../src/llm/domain/llm.ts';
import { agentAsTool } from '../../src/tools/infrastructure/agentAsTool.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { messagesAsText, recentCut } from '../../src/engines/domain/model/recentCompaction.ts';
import { MaxContextError } from '../../src/llm/domain/errors.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import { compactedContext, type Message } from '../../src/llm/domain/message.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
	toolMessage,
	toolResult,
	userMessage,
} from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

const signed = (id: string) => ({ type: 'providerData' as const, source: 'fake', data: { id } });

const answer = (id: string, city: string): Message => ({
	role: 'assistant',
	content: [signed(id), toolCall(id, 'weather', { city })],
});

const weatherOf = (id: string, city: string) =>
	toolMessage(toolResult(id, 'weather', `${city}: sunny`));

const heading =
	'The earlier part of this conversation was compacted into this summary, which you wrote:';

describe('compactedContext', () => {
	it('is the whole context when it holds no summary', () => {
		const context = [userMessage('task')];

		expect(compactedContext(context)).toBe(context);
	});

	it('starts at the latest summary, with what it kept, the summary joined to a user message first', () => {
		const later = answer('call-3', 'Rome');
		const context: Message[] = [
			userMessage('task'),
			answer('call-1', 'Madrid'),
			{
				role: 'user',
				content: [
					{
						type: 'contextSummary',
						summary: 'Madrid is sunny.',
						kept: [userMessage('task'), answer('call-2', 'Paris')],
					},
				],
			},
			later,
		];

		const compacted = compactedContext(context);

		expect(compacted).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: `${heading}\n\nMadrid is sunny.` },
					{ type: 'text', text: 'task' },
				],
			},
			answer('call-2', 'Paris'),
			later,
		]);
		// What follows the summary is sent as it is.
		expect(compacted[2]).toBe(later);
	});

	it('gives the summary a message of its own when what it kept starts with an answer', () => {
		const context: Message[] = [
			{
				role: 'user',
				content: [{ type: 'contextSummary', summary: 'S', kept: [answer('call-2', 'Paris')] }],
			},
		];

		expect(compactedContext(context)).toEqual([
			{ role: 'user', content: [{ type: 'text', text: `${heading}\n\nS` }] },
			answer('call-2', 'Paris'),
		]);
	});
});

describe('recentCut', () => {
	it('keeps the last answers with their results, and the prompt before them', () => {
		const prompt = userMessage('task');
		const context = [
			prompt,
			answer('call-1', 'Madrid'),
			weatherOf('call-1', 'Madrid'),
			answer('call-2', 'Paris'),
			weatherOf('call-2', 'Paris'),
			answer('call-3', 'Rome'),
			weatherOf('call-3', 'Rome'),
		];

		const cut = recentCut(context, prompt, 2);

		expect(cut?.summarized).toEqual(context.slice(1, 3));
		expect(cut?.kept).toEqual([
			prompt,
			// Only the last answer keeps its signed reasoning, for the call it is waiting on.
			{ role: 'assistant', content: [toolCall('call-2', 'weather', { city: 'Paris' })] },
			weatherOf('call-2', 'Paris'),
			answer('call-3', 'Rome'),
			weatherOf('call-3', 'Rome'),
		]);
	});

	it("summarizes earlier runs' answers, so what is kept starts at the prompt", () => {
		const earlier = userMessage('earlier task');
		const prompt = userMessage('task');
		const context = [
			earlier,
			answer('call-1', 'Madrid'),
			weatherOf('call-1', 'Madrid'),
			prompt,
			answer('call-2', 'Paris'),
		];

		expect(recentCut(context, prompt, 5)?.kept).toEqual([prompt, answer('call-2', 'Paris')]);
	});

	it('summarizes at least one answer, and nothing without one', () => {
		const prompt = userMessage('task');

		expect(recentCut([prompt], prompt, 10)).toBeUndefined();
		expect(recentCut([prompt, answer('call-1', 'Madrid')], prompt, 10)).toEqual({
			summarized: [answer('call-1', 'Madrid')],
			kept: [prompt],
		});
		expect(
			recentCut([prompt, answer('call-1', 'Madrid'), answer('call-2', 'Paris')], prompt, 10),
		).toEqual({
			summarized: [answer('call-1', 'Madrid')],
			kept: [prompt, answer('call-2', 'Paris')],
		});
	});

	it('summarizes again the message an earlier compaction of the run joined the prompt to, keeping the prompt once', () => {
		const prompt = userMessage('task');
		const joined: Message = {
			role: 'user',
			content: [{ type: 'text', text: 'summary' }, ...prompt.content],
		};
		const context = [
			joined,
			answer('call-2', 'Paris'),
			weatherOf('call-2', 'Paris'),
			answer('call-3', 'Rome'),
			weatherOf('call-3', 'Rome'),
		];

		expect(recentCut(context, prompt, 1)).toEqual({
			summarized: context.slice(0, 3),
			kept: [prompt, answer('call-3', 'Rome'), weatherOf('call-3', 'Rome')],
		});
	});

	it("leaves out a provider's compactions and earlier summaries from what it keeps", () => {
		const prompt = userMessage('task');
		const context: Message[] = [
			prompt,
			answer('call-1', 'Madrid'),
			{
				role: 'assistant',
				content: [
					{ type: 'compaction', source: 'fake', data: {} },
					{ type: 'text', text: 'Paris next.' },
				],
			},
		];

		expect(recentCut(context, prompt, 1)?.kept).toEqual([
			prompt,
			{ role: 'assistant', content: [{ type: 'text', text: 'Paris next.' }] },
		]);
	});
});

describe('messagesAsText', () => {
	it('writes who did what, each part and the whole cut short', () => {
		const text = messagesAsText(
			[userMessage('a long task'), answer('call-1', 'Madrid'), weatherOf('call-1', 'Madrid')],
			1_000,
			6,
		);

		expect(text).toBe('user: a long…\nassistant called weather {"city…\nweather returned: Madrid…');
		expect(messagesAsText([userMessage('a long task')], 5, 100)).toBe('user:\n[the rest was cut]');
	});
});

const weather = {
	name: 'weather',
	description: 'The weather tool',
	inputSchema: { type: 'object' as const, properties: { city: { type: 'string' } } },
	risk: () => 'safe' as const,
	execute: (input: unknown) => Promise.resolve(`${(input as { city: string }).city}: sunny`),
};

const usage = (inputTokens: number) => ({ inputTokens });

describe('LLMAgent with the recent compactor', () => {
	it('has its model summarize the context past the threshold, from the same context and tools, and goes on from the summary', async () => {
		const events: ProgressEvent[] = [];
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
			textResponse('Madrid is sunny; Paris was asked.', { usage: usage(160) }),
			textResponse('Both are sunny.'),
			textResponse('Rome too.'),
		);
		const agent = new LLMAgent({
			llmClient,
			tools: [weather],
			compactor: { by: 'harness', at: 100, keptSteps: 1 },
		});

		const response = await agent.run('task', {
			signal,
			onProgress: event => {
				if (event.type === 'compaction') events.push(event);
			},
		});
		await agent.run('next', { signal });

		const full = [
			userMessage('task'),
			answer('call-1', 'Madrid'),
			weatherOf('call-1', 'Madrid'),
			answer('call-2', 'Paris'),
			weatherOf('call-2', 'Paris'),
		];
		// The summary is asked for after the context as it was last sent, with the same tools.
		expect(llmClient.contexts[2]?.slice(0, -1)).toEqual(full);
		expect(JSON.stringify(llmClient.contexts[2]?.at(-1))).toContain(
			'Your context is about to be compacted',
		);
		expect(llmClient.tools[2]).toEqual(llmClient.tools[1]);
		const compacted = [
			{
				role: 'user',
				content: [
					{ type: 'text', text: `${heading}\n\nMadrid is sunny; Paris was asked.` },
					{ type: 'text', text: 'task' },
				],
			},
			answer('call-2', 'Paris'),
			weatherOf('call-2', 'Paris'),
		];
		expect(llmClient.contexts[3]).toEqual(compacted);
		// The next run goes on from the summary too, and the provider is never asked to compact.
		expect(llmClient.contexts[4]).toEqual([
			...compacted,
			textResponse('Both are sunny.').message,
			userMessage('next'),
		]);
		expect(llmClient.compactAts).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(events).toEqual([
			{ type: 'compaction', by: 'harness', reason: 'threshold', contextTokens: 150 },
		]);
		// The summary is billed with the run.
		expect(response.tokens?.inputTokens).toBe(50 + 150 + 160 + 1);
	});

	it("keeps in the run's transcript the messages a summary replaced, and the summary", async () => {
		const transcripts: unknown[] = [];
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
			textResponse('Madrid is sunny; Paris was asked.'),
			textResponse('Both are sunny.'),
		);

		await new LLMAgent({
			llmClient,
			tools: [weather],
			compactor: { by: 'harness', at: 100, keptSteps: 1 },
			onTranscript: transcript => {
				transcripts.push(transcript.content);
			},
		}).run('task', { signal });

		expect(transcripts).toMatchObject([
			{
				messages: [
					userMessage('task'),
					answer('call-1', 'Madrid'),
					weatherOf('call-1', 'Madrid'),
					answer('call-2', 'Paris'),
					weatherOf('call-2', 'Paris'),
					{
						role: 'user',
						content: [{ type: 'contextSummary', summary: 'Madrid is sunny; Paris was asked.' }],
					},
					textResponse('Both are sunny.').message,
				],
			},
		]);
		// Without the copies of what it kept, already above it.
		expect(JSON.stringify(transcripts)).not.toContain('"kept"');
	});

	it('does not summarize again in the run when what the summary kept is still past the threshold', async () => {
		const logger = { warn: vi.fn() };
		const events: ProgressEvent[] = [];
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
			textResponse('Madrid is sunny; Paris was asked.', { usage: usage(160) }),
			assistantResponse(answer('call-3', 'Rome').content, { usage: usage(140) }),
			assistantResponse(answer('call-4', 'Oslo').content, { usage: usage(170) }),
			textResponse('done'),
		);

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			logger,
			compactor: { by: 'harness', at: 100, keptSteps: 1 },
		}).run('task', {
			signal,
			onProgress: event => {
				if (event.type === 'compaction') events.push(event);
			},
		});

		expect(response.response).toBe('done');
		// One summary, and no other call asks for one.
		expect(llmClient.contexts).toHaveLength(6);
		expect(events).toHaveLength(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'The context could not be compacted: what the summary kept is still 140 tokens, past the threshold of 100, so the context is not compacted again in this run unless it no longer fits',
		);
	});

	it('goes on whole when the summary fails, and does not ask again in the same run', async () => {
		const logger = { warn: vi.fn() };
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
			assistantResponse([toolCall('call-9', 'weather', { city: 'Oslo' })]),
			assistantResponse(answer('call-3', 'Rome').content, { usage: usage(150) }),
			textResponse('done'),
		);

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			logger,
			compactor: { by: 'harness', at: 100, keptSteps: 1 },
		}).run('task', { signal });

		expect(response.response).toBe('done');
		// Answered with a call instead of a summary, and not asked again once past the threshold.
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledWith(
			'The context could not be compacted: the model did not answer with a summary',
		);
		expect(llmClient.contexts[4]?.[0]).toEqual(userMessage('task'));
	});

	it('compacts a context that no longer fits from a transcript of it, even with compaction off', async () => {
		const events: ProgressEvent[] = [];
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content),
			assistantResponse(answer('call-2', 'Paris').content),
			new MaxContextError('Too long', {
				cause: 'window',
				tokens: { inputTokens: 500, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 0 },
			}),
			textResponse('Madrid is sunny.'),
			textResponse('done'),
		);

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			logger: { warn: vi.fn() },
			compactor: { by: 'harness', at: undefined, keptSteps: 1 },
		}).run('task', {
			signal,
			onProgress: event => {
				if (event.type === 'compaction') events.push(event);
			},
		});

		expect(response.response).toBe('done');
		const [request] = llmClient.contexts[3] ?? [];
		expect(llmClient.contexts[3]).toHaveLength(1);
		expect(JSON.stringify(request)).toContain('It no longer fits your context');
		expect(JSON.stringify(request)).toContain('assistant called weather {\\"city\\":\\"Madrid\\"}');
		expect(llmClient.tools[3]).toEqual([]);
		expect(events).toEqual([
			{ type: 'compaction', by: 'harness', reason: 'maxContext', contextTokens: 500 },
		]);
	});

	it("keeps the summary's tokens when the logger throws on its failure", async () => {
		const logger = {
			warn: () => {
				throw new Error('log failed');
			},
		};
		const refused = (llmClient: FakeLLMClient) =>
			new LLMAgent({
				llmClient,
				tools: [weather],
				logger,
				compactor: { by: 'harness', at: 100, keptSteps: 1 },
			}).run('task', { signal });

		await expect(
			refused(
				new FakeLLMClient(
					assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
					assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
					textResponse('', { usage: usage(160) }),
				),
			),
		).rejects.toMatchObject({
			message: 'LLM agent logger failed',
			tokens: { inputTokens: 360 },
			usageUnreported: false,
		});
		await expect(
			refused(
				new FakeLLMClient(
					assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
					assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
					textResponse('', { usage: null }),
				),
			),
			// A total with an unreported call is unknown, never a subtotal.
		).rejects.toMatchObject({ tokens: undefined, usageUnreported: true });
	});

	it('ends the run on a summary failure that is not a passing one of the provider', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
			new UnrecoverableError('Claude client logger failed while mapping a response', {
				cause: 'the logger threw',
			}),
		);

		await expect(
			new LLMAgent({
				llmClient,
				tools: [weather],
				logger: { warn: vi.fn() },
				compactor: { by: 'harness', at: 100, keptSteps: 1 },
			}).run('task', { signal }),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'Claude client logger failed while mapping a response',
			tokens: { inputTokens: 200 },
		});
		expect(llmClient.contexts).toHaveLength(3);
	});

	it('measures the context of the last run kept, not of one that was not', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(60) }),
			textResponse('Both sunny.', { usage: usage(70) }),
			textResponse('', { usage: usage(150), stopReason: 'refused' }),
			textResponse('Hello.'),
		);
		const agent = new LLMAgent({
			llmClient,
			tools: [weather],
			compactor: { by: 'harness', at: 100, keptSteps: 1 },
		});

		await agent.run('task', { signal });
		await expect(agent.run('refused', { signal })).rejects.toBeInstanceOf(UnrecoverableError);
		await agent.run('hello', { signal });

		// The refused run is not in the conversation, so neither is its size: no summary is asked.
		expect(llmClient.contexts[4]?.at(-1)).toEqual(userMessage('hello'));
		expect(llmClient.contexts).toHaveLength(5);
	});

	it('summarizes from a transcript when the summary request itself no longer fits', async () => {
		const events: ProgressEvent[] = [];
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(150) }),
			new MaxContextError('Too long', {
				cause: 'window',
				tokens: { inputTokens: 300, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 0 },
			}),
			textResponse('Madrid is sunny.', { usage: usage(20) }),
			textResponse('done'),
		);

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			compactor: { by: 'harness', at: 100, keptSteps: 1 },
		}).run('task', {
			signal,
			onProgress: event => {
				if (event.type === 'compaction') events.push(event);
			},
		});

		expect(response.response).toBe('done');
		expect(llmClient.contexts[3]).toHaveLength(1);
		expect(JSON.stringify(llmClient.contexts[3])).toContain('It no longer fits your context');
		expect(events).toEqual([
			{ type: 'compaction', by: 'harness', reason: 'threshold', contextTokens: 150 },
		]);
		// The request that did not fit is billed with the run.
		expect(response.tokens?.inputTokens).toBe(50 + 150 + 300 + 20 + 1);
	});

	it('fails when a context that no longer fits holds no answer to summarize', async () => {
		const logger = { warn: vi.fn() };

		await expect(
			new LLMAgent({
				llmClient: new FakeLLMClient(new MaxContextError('Too long', { cause: 'window' })),
				logger,
				compactor: { by: 'harness', at: undefined, keptSteps: 1 },
			}).run('task', { signal }),
		).rejects.toMatchObject({
			constructor: MaxContextError,
			cause:
				'It no longer fit, and could not be compacted: the model has not answered yet, so there is nothing to summarize.',
		});
		// The failure that ends the run is thrown, not logged as well.
		expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not be compacted'));
	});

	it('ends the run as soon as the summary is written when an agent at work ended it meanwhile', async () => {
		let openGate: (value: undefined) => void = () => undefined;
		const gate = new Promise<undefined>(resolve => {
			openGate = resolve;
		});
		// The delegated agent answers only once the summary is being written.
		const childClient: LLMClient = {
			send: async () => {
				await gate;
				return textResponse('committed');
			},
		};
		const commit = agentAsTool({
			name: 'commit',
			description: 'Commits the work',
			createAgent: () => new LLMAgent({ llmClient: childClient }),
		});
		const sent: Message[][] = [];
		const parentClient: LLMClient = {
			send: async ({ context }) => {
				sent.push(context);
				if (sent.length === 1) {
					return assistantResponse([toolCall('call-1', 'commit', { task: 'Commit' })], {
						usage: usage(150),
					});
				}
				// The summary: the agent's narration fails while it is written.
				openGate(undefined);
				await new Promise(resolve => setTimeout(resolve, 10));
				return textResponse('Commit was asked.');
			},
		};

		await expect(
			new LLMAgent({
				llmClient: parentClient,
				tools: [commit as never],
				compactor: { by: 'harness', at: 100, keptSteps: 1 },
			}).run('work', {
				signal,
				onProgress: event => {
					if (event.type === 'subagent') throw new Error('the terminal closed');
				},
			}),
		).rejects.toMatchObject({ message: 'LLM agent progress callback failed' });
		// No call follows the summary.
		expect(sent).toHaveLength(2);
	});

	it('fails when a context that no longer fits cannot be summarized', async () => {
		const logger = { warn: vi.fn() };
		const llmClient = new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content),
			assistantResponse(answer('call-2', 'Paris').content),
			new MaxContextError('Too long', { cause: 'window' }),
			new Error('overloaded'),
		);

		await expect(
			new LLMAgent({
				llmClient,
				tools: [weather],
				logger,
				compactor: { by: 'harness', at: undefined, keptSteps: 1 },
			}).run('task', { signal }),
		).rejects.toMatchObject({
			constructor: MaxContextError,
			cause: 'It no longer fit, and could not be compacted: overloaded.',
		});
		expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not be compacted'));
	});
});
