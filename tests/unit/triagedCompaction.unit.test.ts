import { describe, expect, it, vi } from 'vitest';
import type { ContextTriage } from '../../src/llm/domain/contextTriage.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import {
	triageCandidates,
	triagedCut,
	triagedKept,
} from '../../src/engines/domain/model/triagedCompaction.ts';
import { JevContextTriage } from '../../src/llm/infrastructure/jevContextTriage.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import { MaxContextError } from '../../src/llm/domain/errors.ts';
import { RecoverableError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
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

const weather = {
	name: 'weather',
	description: 'The weather tool',
	inputSchema: { type: 'object' as const, properties: { city: { type: 'string' } } },
	risk: () => 'safe' as const,
	execute: (input: unknown) => Promise.resolve(`${(input as { city: string }).city}: sunny`),
};

const usage = (inputTokens: number) => ({ inputTokens });

const heading =
	'The earlier part of this conversation was compacted into this summary, which you wrote:';

describe('triageCandidates', () => {
	it("is each tool result before the model's last answer, with its call", () => {
		const context = [
			userMessage('task'),
			answer('call-1', 'Madrid'),
			weatherOf('call-1', 'Madrid'),
			answer('call-2', 'Paris'),
			weatherOf('call-2', 'Paris'),
		];

		expect(triageCandidates(context)).toEqual([
			{ callId: 'call-1', tool: 'weather', input: { city: 'Madrid' }, output: 'Madrid: sunny' },
		]);
		expect(triageCandidates([userMessage('task')])).toEqual([]);
	});
});

describe('triagedCut', () => {
	const prompt = userMessage('task');
	const context: Message[] = [
		userMessage('earlier'),
		answer('call-0', 'Oslo'),
		weatherOf('call-0', 'Oslo'),
		prompt,
		{
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Two cities.' },
				toolCall('call-1', 'weather', { city: 'Madrid' }),
				toolCall('call-2', 'weather', { city: 'Lima' }),
			],
		},
		toolMessage(
			toolResult('call-1', 'weather', 'Madrid: sunny'),
			toolResult('call-2', 'weather', 'Lima: sunny'),
		),
		answer('call-3', 'Rome'),
		weatherOf('call-3', 'Rome'),
	];

	it('keeps the prompt, each kept call with its result and the last answer, in their order, and summarizes the rest', () => {
		expect(triagedCut(context, prompt, new Set(['call-0', 'call-2']))).toEqual({
			summarized: [
				userMessage('earlier'),
				{ role: 'assistant', content: [signed('call-0')] },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Two cities.' },
						toolCall('call-1', 'weather', { city: 'Madrid' }),
					],
				},
				toolMessage(toolResult('call-1', 'weather', 'Madrid: sunny')),
			],
			kept: [
				{ role: 'assistant', content: [toolCall('call-0', 'weather', { city: 'Oslo' })] },
				weatherOf('call-0', 'Oslo'),
				prompt,
				{ role: 'assistant', content: [toolCall('call-2', 'weather', { city: 'Lima' })] },
				toolMessage(toolResult('call-2', 'weather', 'Lima: sunny')),
				// Only the last answer keeps its signed reasoning.
				answer('call-3', 'Rome'),
				weatherOf('call-3', 'Rome'),
			],
		});
	});

	it('keeps the prompt first when an earlier compaction took it into its summary', () => {
		const cut = triagedCut(context.slice(4), prompt, new Set());

		expect(cut?.kept[0]).toEqual(prompt);
	});

	it('is nothing when no answer would be summarized', () => {
		const plain: Message[] = [
			prompt,
			assistantResponse([toolCall('call-1', 'weather', { city: 'Madrid' })]).message,
			weatherOf('call-1', 'Madrid'),
			answer('call-2', 'Paris'),
		];

		expect(triagedCut(plain, prompt, new Set(['call-1']))).toBeUndefined();
		expect(triagedCut([prompt, answer('call-1', 'Madrid')], prompt, new Set())).toBeUndefined();
		expect(triagedCut([prompt], prompt, new Set())).toBeUndefined();
	});

	it('tells the model what is kept', () => {
		expect(
			triagedKept([{ callId: 'call-1', tool: 'readFile', input: { path: 'a.ts' }, output: '' }]),
		).toBe(
			'the user\'s request for this run, your last answer with its tool results, and the results of these earlier tool calls: readFile {"path":"a.ts"},',
		);
		expect(triagedKept([])).toBe(
			"the user's request for this run and your last answer, with its tool results,",
		);
	});
});

describe('LLMAgent with Jev compaction', () => {
	const script = () =>
		new FakeLLMClient(
			assistantResponse(answer('call-1', 'Madrid').content, { usage: usage(50) }),
			assistantResponse(answer('call-2', 'Paris').content, { usage: usage(50) }),
			assistantResponse(answer('call-3', 'Rome').content, { usage: usage(150) }),
			textResponse('Paris was asked.'),
			textResponse('done'),
		);

	it("keeps what Jev scores as needed, and tells the model so in the summary's request", async () => {
		const llmClient = script();
		const triage = { score: vi.fn<ContextTriage['score']>().mockResolvedValue([3, 1]) };

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			compactor: { by: 'harness', at: 100, keptSteps: 1, triage },
		}).run('task', { signal });

		expect(response.response).toBe('done');
		expect(triage.score).toHaveBeenCalledWith(
			{
				task: 'task',
				latestAnswer: 'assistant called weather {"city":"Rome"}',
				results: [
					{ tool: 'weather', input: { city: 'Madrid' }, output: 'Madrid: sunny' },
					{ tool: 'weather', input: { city: 'Paris' }, output: 'Paris: sunny' },
				],
			},
			signal,
		);
		expect(JSON.stringify(llmClient.contexts[3]?.at(-1))).toContain(
			'the results of these earlier tool calls: weather {\\"city\\":\\"Madrid\\"}',
		);
		expect(llmClient.contexts[4]).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: `${heading}\n\nParis was asked.` },
					{ type: 'text', text: 'task' },
				],
			},
			{ role: 'assistant', content: [toolCall('call-1', 'weather', { city: 'Madrid' })] },
			weatherOf('call-1', 'Madrid'),
			answer('call-3', 'Rome'),
			weatherOf('call-3', 'Rome'),
		]);
	});

	it('has the recent compactor choose when Jev fails, and logs it', async () => {
		const llmClient = script();
		const logger = { warn: vi.fn() };
		const triage = {
			score: () => Promise.reject(new RecoverableError('Jev failed', { cause: 'overloaded' })),
		};

		await new LLMAgent({
			llmClient,
			tools: [weather],
			logger,
			compactor: { by: 'harness', at: 100, keptSteps: 1, triage },
		}).run('task', { signal });

		expect(logger.warn).toHaveBeenCalledWith(
			'Jev could not choose what to keep, so the recent compactor did: overloaded',
		);
		expect(llmClient.contexts[4]?.slice(1)).toEqual([
			answer('call-3', 'Rome'),
			weatherOf('call-3', 'Rome'),
		]);
	});

	it('stops when the run is cancelled during the triage', async () => {
		const controller = new AbortController();
		const triage = {
			score: (_: unknown, triageSignal: AbortSignal) => {
				controller.abort();
				triageSignal.throwIfAborted();
				return Promise.resolve([]);
			},
		};

		await expect(
			new LLMAgent({
				llmClient: script(),
				tools: [weather],
				compactor: { by: 'harness', at: 100, keptSteps: 1, triage },
			}).run('task', { signal: controller.signal }),
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('does not ask Jev again in the run once it kept every answer whole', async () => {
		const logger = { warn: vi.fn() };
		const triage = { score: vi.fn<ContextTriage['score']>().mockResolvedValue([3]) };
		const call = (id: string, city: string) =>
			assistantResponse([toolCall(id, 'weather', { city })], { usage: usage(150) });

		await new LLMAgent({
			llmClient: new FakeLLMClient(
				call('call-1', 'Madrid'),
				call('call-2', 'Paris'),
				call('call-3', 'Rome'),
				textResponse('done'),
			),
			tools: [weather],
			logger,
			compactor: { by: 'harness', at: 100, keptSteps: 1, triage },
		}).run('task', { signal });

		expect(triage.score).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			'The context could not be compacted: Jev kept every answer whole, so there is nothing to summarize',
		);
	});

	it('has the recent compactor cut a context that no longer fits when Jev keeps it all', async () => {
		const triage = { score: vi.fn<ContextTriage['score']>().mockResolvedValue([3]) };
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'weather', { city: 'Madrid' })]),
			assistantResponse([toolCall('call-2', 'weather', { city: 'Paris' })]),
			new MaxContextError('Too long', { cause: 'window' }),
			textResponse('Madrid was asked.'),
			textResponse('done'),
		);

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			logger: { warn: vi.fn() },
			compactor: { by: 'harness', at: undefined, keptSteps: 1, triage },
		}).run('task', { signal });

		expect(response.response).toBe('done');
		expect(triage.score).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(llmClient.contexts[3])).toContain('your last 1 answers');
	});

	it("has the recent compactor summarize a first answer that no longer fits, which Jev's cut always keeps", async () => {
		const triage = { score: vi.fn<ContextTriage['score']>() };
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'weather', { city: 'Madrid' })]),
			new MaxContextError('Too long', { cause: 'window' }),
			textResponse('Madrid was asked.'),
			textResponse('done'),
		);

		const response = await new LLMAgent({
			llmClient,
			tools: [weather],
			compactor: { by: 'harness', at: undefined, keptSteps: 1, triage },
		}).run('task', { signal });

		expect(response.response).toBe('done');
		// Jev had no earlier result to judge.
		expect(triage.score).not.toHaveBeenCalled();
		expect(JSON.stringify(llmClient.contexts[2])).toContain('Madrid');
	});
});

describe('JevContextTriage', () => {
	const jevAnswer = (score: number) =>
		new Response(
			JSON.stringify({
				model: 'jev-1.14.0',
				answers: {
					needed: {
						type: 'score',
						score,
						confidence: 0.9,
						legend: {},
						probabilities: {},
					},
				},
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	const results = [
		{ tool: 'readFile', input: { path: 'a.ts' }, output: 'a' },
		{ tool: 'readFile', input: { path: 'b.ts' }, output: 'b' },
	];

	it('asks Jev to score each result alone, and answers in their order', async () => {
		const bodies: unknown[] = [];
		const triage = new JevContextTriage({
			apiKey: 'test',
			compression: false,
			fetch: async (_url, init) => {
				// Uncompressed, the body is JSON text.
				const body = (await new Response(init?.body).json()) as { state: { result: string } };
				bodies.push(body);
				return jevAnswer(body.state.result === 'a' ? 2.5 : 0.2);
			},
		});

		const scores = await triage.score({ task: 'task', latestAnswer: 'latest', results }, signal);

		expect(scores).toEqual([2.5, 0.2]);
		expect(bodies[0]).toMatchObject({
			model: 'jev-1.14.0',
			state: {
				task: 'task',
				latestAnswer: 'latest',
				toolCall: { tool: 'readFile', input: '{"path":"a.ts"}' },
				result: 'a',
			},
			questions: { needed: { type: 'score' } },
		});
	});

	it('fails as a passing provider failure when Jev does', async () => {
		const triage = new JevContextTriage({
			apiKey: 'test',
			retry: { maxRetries: 0 },
			fetch: () => Promise.resolve(new Response('{"detail":"down"}', { status: 500 })),
		});

		await expect(
			triage.score({ task: 'task', latestAnswer: '', results }, signal),
		).rejects.toBeInstanceOf(RecoverableError);
	});

	it('fails without a key', async () => {
		vi.stubEnv('TYPESAFE_API_KEY', '');
		try {
			await expect(
				new JevContextTriage().score({ task: 'task', latestAnswer: '', results }, signal),
			).rejects.toMatchObject({
				constructor: UnrecoverableError,
				message: 'Jev is not configured',
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it('stops when cancelled', async () => {
		const controller = new AbortController();
		const triage = new JevContextTriage({
			apiKey: 'test',
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason as Error);
					});
					controller.abort();
				}),
		});

		await expect(
			triage.score({ task: 'task', latestAnswer: '', results }, controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' });
	});
});
