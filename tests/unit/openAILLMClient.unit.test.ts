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
import { textResponse, userMessage } from '../support/fakeLlmClient.ts';

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
		const first = await createClient().send([userMessage('My name is Miki.')], signal);

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
				{ role: 'assistant', content: 'Hi Miki' },
				{ role: 'user', content: 'What is my name?' },
			],
		});
		expect(answer.response).toBe('Your name is Miki.');
	});

	it('sends the whole context statelessly, with text alone and no empty messages', async () => {
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
			[userMessage('first'), answered, userMessage('second'), thinkingOnly, userMessage('third')],
			signal,
		);

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
				reasoning: { summary: 'auto' },
			},
			{ signal },
		);
	});

	it('maps reasoning summaries and text into parts, in order', async () => {
		createSdk(
			response({ output: [reasoning('step one', 'step two'), message({ text: 'answer' })] }),
		);

		const result = await createClient().send([userMessage('prompt')], signal);

		expect(result.message).toEqual({
			role: 'assistant',
			content: [
				{ type: 'reasoning', text: 'step one\nstep two' },
				{ type: 'text', text: 'answer' },
			],
		});
		expect(result.stopReason).toBe('completed');
	});

	it('leaves out an empty reasoning summary', async () => {
		createSdk(response({ output: [reasoning(), message({ text: 'answer' })] }));

		const result = await createClient().send([userMessage('prompt')], signal);

		expect(result.message.content).toEqual(textResponse('answer').message.content);
	});

	it('warns about an output item it does not map and leaves it out', async () => {
		const logger = { warn: vi.fn() };
		const call = { type: 'function_call', call_id: 'c1', name: 'ls', arguments: '{}' };
		createSdk(response({ output: [call as ResponseOutputItem, message({ text: 'answer' })] }));

		const result = await createClient(logger).send([userMessage('prompt')], signal);

		expect(result.message.content).toEqual([{ type: 'text', text: 'answer' }]);
		expect(logger.warn).toHaveBeenCalledWith(call, expect.any(String));
	});

	it('makes a throwing logger unrecoverable', async () => {
		const logger = {
			warn: vi.fn(() => {
				throw new Error('log sink closed');
			}),
		};
		createSdk(response({ output: [{ type: 'web_search_call' } as ResponseOutputItem] }));

		await expect(createClient(logger).send([userMessage('prompt')], signal)).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'log sink closed',
		});
	});

	it('counts cache reads and writes apart from the uncached input', async () => {
		createSdk(response());

		const result = await createClient().send([userMessage('prompt')], signal);

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

		const result = await createClient(logger).send([userMessage('prompt')], signal);

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

		const result = await createClient().send([userMessage('prompt')], signal);

		expect(result.stopReason).toBe(stopReason);
	});

	it('makes a failed response unrecoverable with its error', async () => {
		createSdk(
			response({
				status: 'failed',
				error: { code: 'invalid_prompt', message: 'The prompt was rejected' },
			}),
		);

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
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

			await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
				constructor: RecoverableError,
				cause: 'Try again later',
			});
		},
	);

	it('turns a context that no longer fits into a MaxContextError', async () => {
		createSdk(apiError(400, 'context_length_exceeded'));

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toBeInstanceOf(
			MaxContextError,
		);
	});

	it.each([
		[400, 'invalid_request_error'],
		[401, 'invalid_api_key'],
		[429, 'insufficient_quota'],
		[429, 'credit_balance_exhausted'],
		[429, 'project_spend_limit_exceeded'],
	])('makes a %i %s unrecoverable', async (status, code) => {
		createSdk(apiError(status, code));

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
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

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toBeInstanceOf(
			RecoverableError,
		);
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
			createClient().send([userMessage('prompt')], controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' });
	});
});
