import Anthropic, { AnthropicError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
	ContentBlock,
	Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/shared/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { MaxContextError } from '../../src/llm/domain/errors.ts';
import { ClaudeLLMClient } from '../../src/llm/infrastructure/claudeLLMClient.ts';
import { toolCall, toolMessage, toolResult, userMessage } from '../support/fakeLlmClient.ts';
import { fakeClaudeSdk } from '../support/fakeClaudeSdk.ts';

// The error classes stay real: the client classifies failures by them.
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;

function text(value: string): ContentBlock {
	return { type: 'text', text: value, citations: null };
}

function thinking(value: string): ContentBlock {
	return { type: 'thinking', thinking: value, signature: 'opaque' };
}

function response(overrides: Partial<AnthropicMessage> = {}): AnthropicMessage {
	return {
		stop_reason: 'end_turn',
		stop_details: null,
		content: [text('answer')],
		usage: {
			input_tokens: 10,
			cache_read_input_tokens: 60,
			cache_creation_input_tokens: 30,
			output_tokens: 20,
		},
		...overrides,
	} as AnthropicMessage;
}

/** Makes the next `new Anthropic()` inside the client return a fake SDK. */
function createSdk(...results: (AnthropicMessage | Error)[]) {
	const create = vi.fn();
	for (const result of results) {
		if (result instanceof Error) create.mockRejectedValueOnce(result);
		else create.mockResolvedValueOnce(result);
	}
	vi.mocked(Anthropic).mockImplementation(function () {
		return fakeClaudeSdk(create);
	});
	return { create };
}

function createClient(logger = { warn: vi.fn() }) {
	return new ClaudeLLMClient({ model: 'sonnet', systemPrompt: 'Be brief.', logger });
}

function apiError(status: number, type: string, message = `${type} happened`): APIError {
	return APIError.generate(
		status,
		{ type: 'error', error: { type, message } },
		undefined,
		new Headers(),
	);
}

describe('ClaudeLLMClient', () => {
	// What `measureContext` counts as sent back is the source this client replays.
	it('names the source of the provider data it sends back', () => {
		expect(createClient().providerDataSource).toBe('claude');
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('rejects a model it does not take before building the SDK', () => {
		// A full ID is not one of the aliases callers use.
		expect(
			() =>
				new ClaudeLLMClient({
					model: 'claude-opus-5-5',
					systemPrompt: '',
					logger: { warn: vi.fn() },
				}),
		).toThrow(InvalidAgentConfigError);
		expect(Anthropic).not.toHaveBeenCalled();
	});

	it('runs Haiku 5.5 with adaptive thinking at the effort given', async () => {
		const { create } = createSdk(response());

		await new ClaudeLLMClient({
			model: 'haiku',
			reasoningEffort: 'xhigh',
			systemPrompt: 'Sum up.',
			logger: { warn: vi.fn() },
		}).send({ context: [userMessage('undone turns')], tools: [] }, signal);

		const request = create.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(request.model).toBe('claude-haiku-5-5');
		expect(request.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
		expect(request.output_config).toEqual({ effort: 'xhigh' });
	});

	it('rejects a reasoning effort the Messages API does not take before building the SDK', () => {
		expect(
			() =>
				new ClaudeLLMClient({
					model: 'opus',
					reasoningEffort: 'ultra',
					systemPrompt: '',
					logger: { warn: vi.fn() },
				}),
		).toThrow(InvalidAgentConfigError);
		expect(Anthropic).not.toHaveBeenCalled();
	});

	it('makes an SDK that cannot be built unrecoverable', () => {
		vi.mocked(Anthropic).mockImplementation(function () {
			throw new Error('The ANTHROPIC_API_KEY environment variable is missing');
		});

		expect(() => createClient()).toThrow(UnrecoverableError);
	});

	// #23: a conversation must survive its adapter, because the state that carries it is MiKode's.
	it('continues a conversation on a new client from the messages an earlier one returned', async () => {
		const { create } = createSdk(
			response({ content: [thinking('greeting them'), text('Hi Miki')] }),
			response({ content: [text('Your name is Miki.')] }),
		);
		const first = await createClient().send(
			{ context: [userMessage('My name is Miki.')], tools: [] },
			signal,
		);

		// What a session manager would persist, handed to a new SDK instance and a new agent.
		const persisted = [userMessage('My name is Miki.'), first.message];
		const answer = await new LLMAgent({ llmClient: createClient(), messages: persisted }).run(
			'What is my name?',
			{ signal },
		);

		expect(Anthropic).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[1]?.[0]).toMatchObject({
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'My name is Miki.' }] },
				{
					role: 'assistant',
					// The signed thinking survives the new client too.
					content: [
						{ type: 'thinking', thinking: 'greeting them', signature: 'opaque' },
						{ type: 'text', text: 'Hi Miki' },
					],
				},
				{ role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
			],
		});
		expect(answer.response).toBe('Your name is Miki.');
	});

	it('sends the whole context with the system prompt apart, no reasoning text and no empty messages', async () => {
		const { create } = createSdk(response());
		const thinkingOnly = {
			role: 'assistant' as const,
			content: [{ type: 'reasoning' as const, text: 'hmm' }],
		};
		const answered = {
			role: 'assistant' as const,
			content: [
				{ type: 'reasoning' as const, text: 'private' },
				{ type: 'text' as const, text: 'first answer' },
			],
		};

		await createClient().send(
			{
				context: [
					userMessage('first'),
					answered,
					userMessage('second'),
					thinkingOnly,
					userMessage(''),
					userMessage('third'),
				],
				tools: [],
			},
			signal,
		);

		// Without tools the request carries no `tools` field at all.
		expect(create).toHaveBeenCalledWith(
			{
				model: 'claude-sonnet-5-5',
				max_tokens: 128_000,
				system: 'Be brief.',
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'first' }] },
					{ role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
					{ role: 'user', content: [{ type: 'text', text: 'second' }] },
					{ role: 'user', content: [{ type: 'text', text: 'third' }] },
				],
				thinking: { type: 'adaptive', display: 'summarized' },
				output_config: { effort: 'high' },
				cache_control: { type: 'ephemeral' },
			},
			{ signal },
		);
	});

	it('offers each tool by its definition, in strict mode', async () => {
		const { create } = createSdk(response());
		const inputSchema = {
			type: 'object' as const,
			properties: { city: { type: 'string' } },
			required: ['city'],
			additionalProperties: false,
		};

		await createClient().send(
			{
				context: [userMessage('prompt')],
				tools: [{ name: 'weather', description: 'Weather in a city', inputSchema }],
			},
			signal,
		);

		expect(create.mock.calls[0]?.[0]).toMatchObject({
			tools: [
				{
					name: 'weather',
					description: 'Weather in a city',
					input_schema: inputSchema,
					strict: true,
				},
			],
		});
	});

	it('maps thinking and text into parts, in order, keeping each signed block for replay', async () => {
		createSdk(
			response({
				content: [
					thinking('step one'),
					{ type: 'redacted_thinking', data: 'encrypted' },
					text('answer'),
				],
			}),
		);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message).toEqual({
			role: 'assistant',
			content: [
				{ type: 'reasoning', text: 'step one' },
				{
					type: 'providerData',
					source: 'claude',
					data: { type: 'thinking', thinking: 'step one', signature: 'opaque' },
				},
				{
					type: 'providerData',
					source: 'claude',
					data: { type: 'redacted_thinking', data: 'encrypted' },
				},
				{ type: 'text', text: 'answer' },
			],
		});
		expect(result.stopReason).toBe('completed');
	});

	it('keeps empty thinking only for replay', async () => {
		createSdk(response({ content: [thinking(''), text('answer')] }));

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([
			{
				type: 'providerData',
				source: 'claude',
				data: { type: 'thinking', thinking: '', signature: 'opaque' },
			},
			{ type: 'text', text: 'answer' },
		]);
	});

	it('maps a tool_use block into a tool call, as a completed answer', async () => {
		createSdk(
			response({
				stop_reason: 'tool_use',
				content: [
					text('Checking.'),
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'weather',
						input: { city: 'Madrid' },
						caller: { type: 'direct' },
					},
				],
			}),
		);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([
			{ type: 'text', text: 'Checking.' },
			toolCall('toolu_1', 'weather', { city: 'Madrid' }),
		]);
		expect(result.stopReason).toBe('completed');
	});

	// The API requires the signed thinking before the call, and every result in the next user turn.
	it('sends a tool round trip back with its signed thinking, and every result in one user turn', async () => {
		const { create } = createSdk(response());
		const signed = { type: 'thinking', thinking: 'need weather', signature: 'sig' };

		await createClient().send(
			{
				context: [
					userMessage('Weather in Madrid and Paris?'),
					{
						role: 'assistant',
						content: [
							{ type: 'reasoning', text: 'need weather' },
							{ type: 'providerData', source: 'claude', data: signed },
							{ type: 'text', text: 'Checking.' },
							toolCall('toolu_1', 'weather', { city: 'Madrid' }),
							toolCall('toolu_2', 'weather', { city: 'Paris' }),
						],
					},
					toolMessage(
						toolResult('toolu_1', 'weather', 'Sunny'),
						toolResult('toolu_2', 'weather', 'Service down', true),
					),
				],
				tools: [],
			},
			signal,
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'Weather in Madrid and Paris?' }] },
					{
						role: 'assistant',
						content: [
							signed,
							{ type: 'text', text: 'Checking.' },
							{ type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Madrid' } },
							{ type: 'tool_use', id: 'toolu_2', name: 'weather', input: { city: 'Paris' } },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny', is_error: false },
							{
								type: 'tool_result',
								tool_use_id: 'toolu_2',
								content: 'Service down',
								is_error: true,
							},
						],
					},
				],
			}),
			{ signal },
		);
	});

	it("leaves out another provider's data, which Claude could not read", async () => {
		const { create } = createSdk(response());

		await createClient().send(
			{
				context: [
					userMessage('prompt'),
					{
						role: 'assistant',
						content: [
							{ type: 'providerData', source: 'openai', data: { type: 'reasoning', id: 'rs_1' } },
							{ type: 'text', text: 'answer' },
						],
					},
				],
				tools: [],
			},
			signal,
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'prompt' }] },
					{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
				],
			}),
			{ signal },
		);
	});

	// OpenAI arguments that did not parse stay a string; Anthropic would reject it on every call.
	it('sends a call whose input is not an object as empty, beside the result that says it failed', async () => {
		const { create } = createSdk(response());

		await createClient().send(
			{
				context: [
					userMessage('prompt'),
					{ role: 'assistant', content: [toolCall('call_1', 'weather', '{"city":')] },
					toolMessage(toolResult('call_1', 'weather', 'Invalid input', true)),
				],
				tools: [],
			},
			signal,
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'prompt' }] },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: {} }],
					},
					{
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'call_1',
								content: 'Invalid input',
								is_error: true,
							},
						],
					},
				],
			}),
			{ signal },
		);
	});

	it('warns about a content block it does not map and leaves it out', async () => {
		const logger = { warn: vi.fn() };
		const call = {
			type: 'server_tool_use',
			id: 's1',
			name: 'web_search',
			input: {},
		} as ContentBlock;
		createSdk(response({ content: [call, text('answer')] }));

		const result = await createClient(logger).send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([{ type: 'text', text: 'answer' }]);
		expect(logger.warn).toHaveBeenCalledWith(call, expect.any(String));
	});

	it('makes a throwing logger unrecoverable', async () => {
		const logger = {
			warn: vi.fn(() => {
				throw new Error('log sink closed');
			}),
		};
		createSdk(response({ content: [{ type: 'server_tool_use' } as ContentBlock] }));

		await expect(
			createClient(logger).send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'log sink closed',
			// The call was billed whatever the logger did.
			tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
		});
	});

	it('takes the input tokens as uncached, because Anthropic counts the cache apart', async () => {
		createSdk(response());

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.usage).toEqual({
			inputTokens: 10,
			readCacheTokens: 60,
			writtenCacheTokens: 30,
			outputTokens: 20,
		});
	});

	it('counts cache it does not report as none', async () => {
		createSdk(
			response({
				usage: {
					input_tokens: 10,
					cache_read_input_tokens: null,
					cache_creation_input_tokens: null,
					output_tokens: 0,
				} as AnthropicMessage['usage'],
			}),
		);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		// No output is still a reported count, not a missing one.
		expect(result.usage).toEqual({
			inputTokens: 10,
			readCacheTokens: 0,
			writtenCacheTokens: 0,
			outputTokens: 0,
		});
	});

	it('reports a response without usage as unaccounted and warns', async () => {
		const logger = { warn: vi.fn() };
		createSdk(response({ usage: undefined }));

		const result = await createClient(logger).send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.usage).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('marks an answer without usage as unreported when warning about it fails', async () => {
		const logger = {
			warn: vi.fn(() => {
				throw new Error('log sink closed');
			}),
		};
		createSdk(response({ usage: undefined }));

		await expect(
			createClient(logger).send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'log sink closed',
			usageUnreported: true,
		});
	});

	it.each([
		['end_turn', 'completed'],
		['tool_use', 'completed'],
		['max_tokens', 'truncated'],
		['refusal', 'refused'],
	] as const)('stops on %s as %s', async (stopReason, expected) => {
		createSdk(response({ stop_reason: stopReason }));

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.stopReason).toBe(expected);
	});

	it('turns a response stopped at the context window into a MaxContextError with its tokens', async () => {
		createSdk(response({ stop_reason: 'model_context_window_exceeded' }));

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: MaxContextError,
			tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
		});
	});

	// Each needs something this client never sends: server tools or stop sequences.
	it.each(['pause_turn', 'stop_sequence'] as const)(
		'makes a response that stopped on %s unrecoverable with its tokens',
		async stopReason => {
			createSdk(response({ stop_reason: stopReason }));

			await expect(
				createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
			).rejects.toMatchObject({
				constructor: UnrecoverableError,
				cause: `The response stopped with "${stopReason}".`,
				tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
			});
		},
	);

	// No answer arrived, so nothing can be missing from the count.
	it('does not mark a connection failure as unreported', async () => {
		createSdk(new Error('socket hang up'));

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: RecoverableError,
			usageUnreported: false,
		});
	});

	// The real SDK, so a change to how it reports missing credentials fails here. It resolves no
	// local profile and has no network, so the test is the same on every machine.
	it('makes missing credentials unrecoverable on the first call, without retrying them', async () => {
		const { default: RealAnthropic } =
			await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
		class WithoutCredentials extends RealAnthropic {
			protected override _shouldResolveDefaultCredentials() {
				return false;
			}
		}
		const fetch = vi.fn(() => Promise.reject(new Error('no network in tests')));
		vi.mocked(Anthropic).mockImplementation(function () {
			return new WithoutCredentials({ apiKey: null, authToken: null, fetch, maxRetries: 0 });
		});

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'The Claude client cannot send the request',
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('makes a failure the SDK raises before sending unrecoverable', async () => {
		createSdk(new AnthropicError('Profile "work" could not be resolved'));

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'Profile "work" could not be resolved',
		});
	});

	it('turns a prompt that no longer fits into a MaxContextError', async () => {
		createSdk(
			apiError(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'),
		);

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toBeInstanceOf(MaxContextError);
	});

	it.each([
		[400, 'invalid_request_error'],
		[401, 'authentication_error'],
		[402, 'billing_error'],
		[403, 'permission_error'],
		[404, 'not_found_error'],
		[413, 'request_too_large'],
	])('makes a %i %s unrecoverable', async (status, type) => {
		createSdk(apiError(status, type));

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'Claude rejected the request',
		});
	});

	it.each([
		['a rate limit', apiError(429, 'rate_limit_error')],
		['an overload', apiError(529, 'overloaded_error')],
		['a server error', apiError(500, 'api_error')],
		['a network failure', new Error('socket hang up')],
	])('makes %s recoverable', async (_, error) => {
		createSdk(error);

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toBeInstanceOf(RecoverableError);
	});

	/**
	 * The real SDK over a fake fetch that streams `events`, then fails with `failure` or ends, so
	 * a change to how the SDK builds a message from its stream, or reports its failure, fails here.
	 */
	async function streamingSdk(events: object[], failure?: Error) {
		const { default: RealAnthropic } =
			await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const { type } = event as { type: string };
					controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`));
				}
				if (failure) controller.error(failure);
				else controller.close();
			},
		});
		const fetch = vi.fn(() =>
			Promise.resolve(
				new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
			),
		);
		vi.mocked(Anthropic).mockImplementation(function () {
			return new RealAnthropic({ apiKey: 'test', fetch, maxRetries: 0 });
		});
		return fetch;
	}

	const messageStart = { type: 'message_start', message: { ...response(), content: [] } };

	// The SDK joins a compaction's deltas as text, so a delta without a summary reads "null".
	it.each([
		['no delta', []],
		[
			'a delta without a summary',
			[{ type: 'compaction_delta', content: null, encrypted_content: null }],
		],
	])('leaves out a streamed compaction that failed, with %s', async (_, deltas) => {
		await streamingSdk([
			messageStart,
			{
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'compaction', content: null, encrypted_content: null },
			},
			...deltas.map(delta => ({ type: 'content_block_delta', index: 0, delta })),
			{ type: 'content_block_stop', index: 0 },
			{
				type: 'content_block_start',
				index: 1,
				content_block: { type: 'text', text: '', citations: null },
			},
			{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
			{ type: 'content_block_stop', index: 1 },
			{
				type: 'message_delta',
				delta: { stop_reason: 'end_turn', stop_sequence: null, container: null },
				context_management: null,
				usage: { output_tokens: 1 },
			},
			{ type: 'message_stop' },
		]);
		const logger = { warn: vi.fn() };

		const answer = await createClient(logger).send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(answer.message.content).toEqual([{ type: 'text', text: 'answer' }]);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('builds the same answer from a stream as from a whole message', async () => {
		const blocks = [
			{ type: 'compaction', content: '', encrypted_content: null },
			{ type: 'thinking', thinking: '', signature: '' },
			{ type: 'text', text: '', citations: null },
		];
		const deltas = [
			{
				type: 'compaction_delta',
				content: '<summary>before</summary>',
				encrypted_content: 'opaque',
			},
			{ type: 'thinking_delta', thinking: 'weighing it' },
			{ type: 'text_delta', text: 'answer' },
		];
		await streamingSdk([
			messageStart,
			...blocks.flatMap((block, index) => [
				{ type: 'content_block_start', index, content_block: block },
				{ type: 'content_block_delta', index, delta: deltas[index] },
				...(block.type === 'thinking'
					? [
							{
								type: 'content_block_delta',
								index,
								delta: { type: 'signature_delta', signature: 'signed' },
							},
						]
					: []),
				{ type: 'content_block_stop', index },
			]),
			{
				type: 'message_delta',
				delta: { stop_reason: 'end_turn', stop_sequence: null, container: null },
				context_management: null,
				usage: {
					output_tokens: 20,
					iterations: [
						{
							type: 'compaction',
							input_tokens: 180_000,
							cache_read_input_tokens: 5_000,
							cache_creation_input_tokens: 0,
							output_tokens: 3_500,
						},
						{
							type: 'message',
							input_tokens: 10,
							cache_read_input_tokens: 60,
							cache_creation_input_tokens: 30,
							output_tokens: 20,
						},
					],
				},
			},
			{ type: 'message_stop' },
		]);

		const answer = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(answer).toEqual({
			message: {
				role: 'assistant',
				content: [
					{
						type: 'compaction',
						source: 'claude',
						data: {
							type: 'compaction',
							content: '<summary>before</summary>',
							encrypted_content: 'opaque',
						},
					},
					{ type: 'reasoning', text: 'weighing it' },
					{
						type: 'providerData',
						source: 'claude',
						data: { type: 'thinking', thinking: 'weighing it', signature: 'signed' },
					},
					{ type: 'text', text: 'answer' },
				],
			},
			usage: {
				inputTokens: 180_010,
				readCacheTokens: 5_060,
				writtenCacheTokens: 30,
				outputTokens: 3_520,
			},
			stopReason: 'completed',
		});
	});

	it.each([
		['a connection lost halfway', [messageStart], new TypeError('terminated')],
		[
			'an overload the API reports mid-stream',
			[messageStart, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
			undefined,
		],
	])('makes %s recoverable, its usage unreported', async (_, events, failure) => {
		const fetch = await streamingSdk(events, failure);

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({ constructor: RecoverableError, usageUnreported: true });
		expect(fetch).toHaveBeenCalledOnce();
	});

	// The SDK's abort error is named 'Error', so it must not reach the caller as a failure.
	it('rethrows the cancellation instead of the SDK abort error', async () => {
		const controller = new AbortController();
		const { create } = createSdk();
		create.mockImplementationOnce(() => {
			controller.abort();
			return Promise.reject(new APIUserAbortError());
		});

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('ClaudeLLMClient compaction', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	const compactingClient = (compactAt: number, model = 'sonnet') =>
		new ClaudeLLMClient({ model, compactAt, systemPrompt: 'Be brief.', logger: { warn: vi.fn() } });

	it('asks Claude to compact at compactAt, keeping the system prompt cached across it', async () => {
		const { create } = createSdk(response());

		await compactingClient(150_000).send({ context: [userMessage('prompt')], tools: [] }, signal);

		expect(create.mock.calls[0]?.[0]).toMatchObject({
			betas: ['compact-2026-01-12'],
			context_management: {
				edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 } }],
			},
			system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
		});
	});

	it('sends an empty system prompt as a string, since Claude rejects an empty text block', async () => {
		const { create } = createSdk(response());

		await new ClaudeLLMClient({
			model: 'sonnet',
			compactAt: 150_000,
			systemPrompt: '',
			logger: { warn: vi.fn() },
		}).send({ context: [userMessage('prompt')], tools: [] }, signal);

		expect(create.mock.calls[0]?.[0]).toMatchObject({ system: '', betas: ['compact-2026-01-12'] });
	});

	it('sends the stable request without compactAt', async () => {
		const { create } = createSdk(response());

		await createClient().send({ context: [userMessage('prompt')], tools: [] }, signal);

		const request = create.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(request).not.toHaveProperty('betas');
		expect(request).not.toHaveProperty('context_management');
		expect(request.system).toBe('Be brief.');
	});

	it.each([49_999, 1.5e5 + 0.5, Number.NaN])(
		'rejects compactAt %s, below what Claude accepts, before building the SDK',
		compactAt => {
			expect(() => compactingClient(compactAt)).toThrow(InvalidAgentConfigError);
			expect(Anthropic).not.toHaveBeenCalled();
		},
	);

	it('asks Haiku 5.5 to compact too', async () => {
		const { create } = createSdk(response());

		await compactingClient(150_000, 'haiku').send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(create.mock.calls[0]?.[0]).toMatchObject({
			model: 'claude-haiku-5-5',
			betas: ['compact-2026-01-12'],
		});
	});

	it('keeps the compaction Claude returns, and sends from it on, leaving out what it replaced', async () => {
		const compaction = {
			type: 'compaction',
			content: '<summary>what happened</summary>',
			encrypted_content: 'opaque',
		} as unknown as ContentBlock;
		const { create } = createSdk(
			response({ content: [compaction, text('continued')] }),
			response(),
		);
		const client = compactingClient(150_000);
		const context = [userMessage('long task')];

		const answer = await client.send({ context, tools: [] }, signal);
		expect(answer.message.content[0]).toEqual({
			type: 'compaction',
			source: 'claude',
			data: {
				type: 'compaction',
				content: '<summary>what happened</summary>',
				encrypted_content: 'opaque',
			},
		});
		await client.send(
			{ context: [...context, answer.message, userMessage('next')], tools: [] },
			signal,
		);

		expect(create.mock.calls[1]?.[0]).toMatchObject({
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'compaction',
							content: '<summary>what happened</summary>',
							encrypted_content: 'opaque',
						},
						{ type: 'text', text: 'continued' },
					],
				},
				{ role: 'user', content: [{ type: 'text', text: 'next' }] },
			],
		});
	});

	// Claude answers a failed compaction sent back as if it were not there: checked live on
	// 2026-10-20, where it neither cut the context nor counted a token for it.
	it('leaves out a compaction that failed, warns, and sends the whole context next', async () => {
		const failed = {
			type: 'compaction',
			content: null,
			encrypted_content: null,
		} as unknown as ContentBlock;
		const { create } = createSdk(response({ content: [failed, text('continued')] }), response());
		const logger = { warn: vi.fn() };
		const client = new ClaudeLLMClient({
			model: 'sonnet',
			compactAt: 150_000,
			systemPrompt: 'Be brief.',
			logger,
		});
		const context = [userMessage('long task')];

		const answer = await client.send({ context, tools: [] }, signal);
		expect(answer.message.content).toEqual([{ type: 'text', text: 'continued' }]);
		expect(logger.warn).toHaveBeenCalledWith(
			'Claude could not compact the conversation; it is sent whole until Claude compacts it',
		);
		await client.send(
			{ context: [...context, answer.message, userMessage('next')], tools: [] },
			signal,
		);

		expect(create.mock.calls[1]?.[0]).toMatchObject({
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'long task' }] },
				{ role: 'assistant', content: [{ type: 'text', text: 'continued' }] },
				{ role: 'user', content: [{ type: 'text', text: 'next' }] },
			],
		});
	});

	it('keeps an earlier compaction as the boundary when a later one fails', async () => {
		const valid = {
			type: 'compaction',
			content: '<summary>what happened</summary>',
			encrypted_content: 'opaque',
		} as unknown as ContentBlock;
		const failed = {
			type: 'compaction',
			content: null,
			encrypted_content: null,
		} as unknown as ContentBlock;
		const { create } = createSdk(
			response({ content: [valid, text('first')] }),
			response({ content: [failed, text('second')] }),
			response(),
		);
		const client = compactingClient(150_000);
		let context = [userMessage('long task')];

		for (const next of ['more', 'last']) {
			const answer = await client.send({ context, tools: [] }, signal);
			context = [...context, answer.message, userMessage(next)];
		}
		await client.send({ context, tools: [] }, signal);

		expect(create.mock.calls[2]?.[0]).toMatchObject({
			messages: [
				{
					role: 'assistant',
					content: [
						{ type: 'compaction', content: '<summary>what happened</summary>' },
						{ type: 'text', text: 'first' },
					],
				},
				{ role: 'user', content: [{ type: 'text', text: 'more' }] },
				{ role: 'assistant', content: [{ type: 'text', text: 'second' }] },
				{ role: 'user', content: [{ type: 'text', text: 'last' }] },
			],
		});
	});

	it('counts the compaction in the tokens, which Claude leaves out of its totals', async () => {
		createSdk(
			response({
				usage: {
					input_tokens: 23_000,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
					output_tokens: 1_000,
					iterations: [
						{
							type: 'compaction',
							input_tokens: 180_000,
							cache_read_input_tokens: 5_000,
							cache_creation_input_tokens: 0,
							output_tokens: 3_500,
						},
						{
							type: 'message',
							input_tokens: 23_000,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 2_000,
							output_tokens: 1_000,
						},
					],
				} as unknown as AnthropicMessage['usage'],
			}),
		);

		const answer = await compactingClient(150_000).send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(answer.usage).toEqual({
			inputTokens: 203_000,
			readCacheTokens: 5_000,
			writtenCacheTokens: 2_000,
			outputTokens: 4_500,
		});
	});
});
