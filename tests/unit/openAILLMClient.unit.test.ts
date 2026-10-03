import OpenAI, { APIError, APIUserAbortError } from 'openai';
import type { Response, ResponseOutputItem } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/agent/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { MaxContextError } from '../../src/llm/domain/errors.ts';
import { OpenAILLMClient } from '../../src/llm/infrastructure/openAILLMClient.ts';
import { toolCall, toolMessage, toolResult, userMessage } from '../support/fakeLlmClient.ts';

// The error classes stay real: the client classifies failures by them.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;

function message(...content: ({ refusal: string } | { text: string })[]): ResponseOutputItem {
	return {
		type: 'message',
		id: 'msg-1',
		role: 'assistant',
		status: 'completed',
		content: content.map(part =>
			'refusal' in part
				? { type: 'refusal', refusal: part.refusal }
				: { type: 'output_text', text: part.text, annotations: [] },
		),
	};
}

function reasoning(...summary: string[]): ResponseOutputItem {
	return {
		type: 'reasoning',
		id: 'rs-1',
		summary: summary.map(text => ({ type: 'summary_text', text })),
		encrypted_content: 'opaque',
	};
}

function functionCall(callId: string, name: string, args: string): ResponseOutputItem {
	return { type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: args };
}

function response(overrides: Partial<Response> = {}): Response {
	return {
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [message({ text: 'answer' })],
		usage: {
			input_tokens: 100,
			input_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
			output_tokens: 20,
			output_tokens_details: { reasoning_tokens: 5 },
			total_tokens: 120,
		},
		...overrides,
	} as Response;
}

/** Makes the next `new OpenAI()` inside the client return a fake SDK. */
function createSdk(...results: (Response | Error)[]) {
	const create = vi.fn();
	for (const result of results) {
		if (result instanceof Error) create.mockRejectedValueOnce(result);
		else create.mockResolvedValueOnce(result);
	}
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return { create };
}

function createClient(logger = { warn: vi.fn() }) {
	return new OpenAILLMClient({ model: 'gpt-5.6-sol', systemPrompt: 'Be brief.', logger });
}

function apiError(status: number, code: string): APIError {
	return new APIError(status, { code, message: `${code} happened` }, undefined, new Headers());
}

describe('OpenAILLMClient', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('rejects a model OpenAI does not offer before building the SDK', () => {
		expect(
			() => new OpenAILLMClient({ model: 'opus', systemPrompt: '', logger: { warn: vi.fn() } }),
		).toThrow(InvalidAgentConfigError);
		expect(OpenAI).not.toHaveBeenCalled();
	});

	it('rejects a reasoning effort OpenAI does not offer before building the SDK', () => {
		// Codex's catalog lists 'ultra'; the Responses API does not.
		expect(
			() =>
				new OpenAILLMClient({
					model: 'gpt-5.6-sol',
					reasoningEffort: 'ultra',
					systemPrompt: '',
					logger: { warn: vi.fn() },
				}),
		).toThrow(InvalidAgentConfigError);
		expect(OpenAI).not.toHaveBeenCalled();
	});

	it('makes an SDK that cannot be built unrecoverable', () => {
		vi.mocked(OpenAI).mockImplementation(function () {
			throw new Error('The OPENAI_API_KEY environment variable is missing');
		});

		expect(() => createClient()).toThrow(UnrecoverableError);
	});

	// #23: a conversation must survive its adapter, because the state that carries it is MiKode's.
	it('continues a conversation on a new client from the messages an earlier one returned', async () => {
		const { create } = createSdk(
			response({ output: [reasoning('greeting them'), message({ text: 'Hi Miki' })] }),
			response({ output: [message({ text: 'Your name is Miki.' })] }),
		);
		const first = await createClient().send(
			{ context: [userMessage('My name is Miki.')], tools: [] },
			signal,
		);

		// What a session manager would persist, handed to a new SDK instance and a new agent.
		const persisted = [userMessage('My name is Miki.'), first.message];
		const answer = await new LLMAgent({ llmClient: createClient(), messages: persisted }).run(
			'What is my name?',
			signal,
			vi.fn(),
		);

		expect(OpenAI).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[1]?.[0]).toMatchObject({
			store: false,
			input: [
				{ role: 'user', content: 'My name is Miki.' },
				// The encrypted reasoning survives the new client too.
				{
					type: 'reasoning',
					id: 'rs-1',
					summary: [{ type: 'summary_text', text: 'greeting them' }],
					encrypted_content: 'opaque',
				},
				{ role: 'assistant', content: 'Hi Miki' },
				{ role: 'user', content: 'What is my name?' },
			],
		});
		expect(answer.response).toBe('Your name is Miki.');
	});

	it('sends the whole context statelessly, with no reasoning text and no empty messages', async () => {
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
				model: 'gpt-5.6-sol',
				instructions: 'Be brief.',
				input: [
					{ role: 'user', content: 'first' },
					{ role: 'assistant', content: 'first answer' },
					{ role: 'user', content: 'second' },
					{ role: 'user', content: 'third' },
				],
				store: false,
				reasoning: { effort: 'high', summary: 'auto' },
				include: ['reasoning.encrypted_content'],
			},
			{ signal },
		);
	});

	it('offers each tool as a strict function', async () => {
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
					type: 'function',
					name: 'weather',
					description: 'Weather in a city',
					parameters: inputSchema,
					strict: true,
				},
			],
		});
	});

	it('maps reasoning summaries and text into parts, in order, keeping the encrypted item for replay', async () => {
		createSdk(
			response({ output: [reasoning('step one', 'step two'), message({ text: 'answer' })] }),
		);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message).toEqual({
			role: 'assistant',
			content: [
				{ type: 'reasoning', text: 'step one\nstep two' },
				{
					type: 'providerData',
					source: 'openai',
					data: {
						type: 'reasoning',
						id: 'rs-1',
						summary: [
							{ type: 'summary_text', text: 'step one' },
							{ type: 'summary_text', text: 'step two' },
						],
						encrypted_content: 'opaque',
					},
				},
				{ type: 'text', text: 'answer' },
			],
		});
		expect(result.stopReason).toBe('completed');
	});

	it('keeps a reasoning item with an empty summary only for replay', async () => {
		createSdk(response({ output: [reasoning(), message({ text: 'answer' })] }));

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([
			{
				type: 'providerData',
				source: 'openai',
				data: { type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: 'opaque' },
			},
			{ type: 'text', text: 'answer' },
		]);
	});

	// OpenAI stores nothing, so an item without its encrypted content has nothing to send back.
	it('keeps no replay for a reasoning item without encrypted content', async () => {
		createSdk(
			response({
				output: [
					{ ...reasoning('step one'), encrypted_content: null } as ResponseOutputItem,
					message({ text: 'answer' }),
				],
			}),
		);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([
			{ type: 'reasoning', text: 'step one' },
			{ type: 'text', text: 'answer' },
		]);
	});

	it('maps a function call into a tool call with parsed arguments', async () => {
		createSdk(
			response({
				output: [
					functionCall('call_1', 'weather', '{"city":"Madrid"}'),
					functionCall('call_2', 'weather', '{"city":"Paris"}'),
				],
			}),
		);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		// The pairing ID is `call_id`; the item's own `id` means nothing outside OpenAI.
		expect(result.message.content).toEqual([
			toolCall('call_1', 'weather', { city: 'Madrid' }),
			toolCall('call_2', 'weather', { city: 'Paris' }),
		]);
		expect(result.stopReason).toBe('completed');
	});

	// Failing the mapping would end the run; the tool's rejection lets the model try again.
	it('hands arguments that do not parse to the tool as the raw string', async () => {
		createSdk(response({ output: [functionCall('call_1', 'weather', '{"city":')] }));

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([toolCall('call_1', 'weather', '{"city":')]);
	});

	// OpenAI requires each reasoning item beside the calls that followed it.
	it('sends a tool round trip back as items, in order, with the reasoning before its calls', async () => {
		const { create } = createSdk(response());
		const encrypted = { type: 'reasoning', id: 'rs-1', summary: [], encrypted_content: 'opaque' };

		await createClient().send(
			{
				context: [
					userMessage('Weather in Madrid?'),
					{
						role: 'assistant',
						content: [
							{ type: 'providerData', source: 'openai', data: encrypted },
							{ type: 'text', text: 'Checking.' },
							toolCall('call_1', 'weather', { city: 'Madrid' }),
							toolCall('call_2', 'weather', '{"city":'),
						],
					},
					toolMessage(
						toolResult('call_1', 'weather', 'Sunny'),
						toolResult('call_2', 'weather', 'Invalid input', true),
					),
				],
				tools: [],
			},
			signal,
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				input: [
					{ role: 'user', content: 'Weather in Madrid?' },
					encrypted,
					{ role: 'assistant', content: 'Checking.' },
					{
						type: 'function_call',
						call_id: 'call_1',
						name: 'weather',
						arguments: '{"city":"Madrid"}',
					},
					// Sent back exactly as the model wrote it, not serialized again.
					{ type: 'function_call', call_id: 'call_2', name: 'weather', arguments: '{"city":' },
					// OpenAI has no error flag; the output text carries the failure.
					{ type: 'function_call_output', call_id: 'call_1', output: 'Sunny' },
					{
						type: 'function_call_output',
						call_id: 'call_2',
						output: 'The tool call failed: Invalid input',
					},
				],
			}),
			{ signal },
		);
	});

	// Without a marker a failure and a success with the same output would read the same.
	it('marks a failed result in the text it sends, and leaves the conversation as it was', async () => {
		const { create } = createSdk(response());
		const context = [
			userMessage('prompt'),
			{
				role: 'assistant' as const,
				content: [toolCall('call_1', 'answer'), toolCall('call_2', 'answer')],
			},
			toolMessage(toolResult('call_1', 'answer', '42'), toolResult('call_2', 'answer', '42', true)),
		];
		const before = structuredClone(context);

		await createClient().send({ context, tools: [] }, signal);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				input: [
					{ role: 'user', content: 'prompt' },
					{ type: 'function_call', call_id: 'call_1', name: 'answer', arguments: '{}' },
					{ type: 'function_call', call_id: 'call_2', name: 'answer', arguments: '{}' },
					{ type: 'function_call_output', call_id: 'call_1', output: '42' },
					{ type: 'function_call_output', call_id: 'call_2', output: 'The tool call failed: 42' },
				],
			}),
			{ signal },
		);
		expect(context).toEqual(before);
	});

	it("leaves out another provider's data, which OpenAI could not read", async () => {
		const { create } = createSdk(response());

		await createClient().send(
			{
				context: [
					userMessage('prompt'),
					{
						role: 'assistant',
						content: [
							{ type: 'providerData', source: 'claude', data: { type: 'thinking' } },
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
				input: [
					{ role: 'user', content: 'prompt' },
					{ role: 'assistant', content: 'answer' },
				],
			}),
			{ signal },
		);
	});

	it('warns about an output item it does not map and leaves it out', async () => {
		const logger = { warn: vi.fn() };
		const search = { type: 'web_search_call', id: 'ws-1', status: 'completed' };
		createSdk(response({ output: [search as ResponseOutputItem, message({ text: 'answer' })] }));

		const result = await createClient(logger).send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.message.content).toEqual([{ type: 'text', text: 'answer' }]);
		expect(logger.warn).toHaveBeenCalledWith(search, expect.any(String));
	});

	it('makes a throwing logger unrecoverable', async () => {
		const logger = {
			warn: vi.fn(() => {
				throw new Error('log sink closed');
			}),
		};
		createSdk(response({ output: [{ type: 'web_search_call' } as ResponseOutputItem] }));

		await expect(
			createClient(logger).send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'log sink closed',
			// The call was billed whatever the logger did.
			tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
		});
	});

	it('counts cache reads and writes apart from the uncached input', async () => {
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

	it.each([
		['a refusal part', response({ output: [message({ refusal: 'I cannot help' })] }), 'refused'],
		[
			'a content filter',
			response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }),
			'refused',
		],
		[
			'the output token limit',
			response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
			'truncated',
		],
	] as const)('stops on %s as %s', async (_, sdkResponse, stopReason) => {
		createSdk(sdkResponse);

		const result = await createClient().send(
			{ context: [userMessage('prompt')], tools: [] },
			signal,
		);

		expect(result.stopReason).toBe(stopReason);
	});

	// OpenAI answered, so the call may have been billed: the run's count is unknown.
	it('marks a failed response without usage as unreported', async () => {
		createSdk(
			response({
				status: 'failed',
				error: { code: 'invalid_prompt', message: 'The prompt was rejected' },
				usage: undefined,
			}),
		);

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: undefined,
			usageUnreported: true,
		});
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

	it('makes a failed response unrecoverable with its error', async () => {
		createSdk(
			response({
				status: 'failed',
				error: { code: 'invalid_prompt', message: 'The prompt was rejected' },
			}),
		);

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'The prompt was rejected',
			// A failed response may still have been billed.
			tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
		});
	});

	// Retried like the same failure arriving as an SDK error.
	it.each(['server_error', 'rate_limit_exceeded'] as const)(
		'makes a failed response with %s recoverable',
		async code => {
			createSdk(response({ status: 'failed', error: { code, message: 'Try again later' } }));

			await expect(
				createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
			).rejects.toMatchObject({
				constructor: RecoverableError,
				cause: 'Try again later',
			});
		},
	);

	it('turns a context that no longer fits into a MaxContextError', async () => {
		createSdk(apiError(400, 'context_length_exceeded'));

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toBeInstanceOf(MaxContextError);
	});

	it.each([
		[400, 'invalid_request_error'],
		[401, 'invalid_api_key'],
		[429, 'insufficient_quota'],
		[429, 'credit_balance_exhausted'],
		[429, 'project_spend_limit_exceeded'],
	])('makes a %i %s unrecoverable', async (status, code) => {
		createSdk(apiError(status, code));

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'OpenAI rejected the request',
		});
	});

	it.each([
		['a rate limit', apiError(429, 'rate_limit_exceeded')],
		['a server error', apiError(500, 'server_error')],
		['a network failure', new Error('socket hang up')],
	])('makes %s recoverable', async (_, error) => {
		createSdk(error);

		await expect(
			createClient().send({ context: [userMessage('prompt')], tools: [] }, signal),
		).rejects.toBeInstanceOf(RecoverableError);
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
