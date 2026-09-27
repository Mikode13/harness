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
} from '../../src/agent/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { MaxContextError } from '../../src/llm/domain/errors.ts';
import { ClaudeLLMClient } from '../../src/llm/infrastructure/claudeLLMClient.ts';
import { textResponse, userMessage } from '../support/fakeLlmClient.ts';

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
		return { messages: { create } } as unknown as Anthropic;
	});
	return { create };
}

function createClient(logger = { warn: vi.fn() }) {
	return new ClaudeLLMClient({ model: 'claude-sonnet-5', systemPrompt: 'Be brief.', logger });
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
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('rejects a model the Messages API does not take before building the SDK', () => {
		// The Agent SDK alias is not a model ID the API accepts.
		expect(
			() => new ClaudeLLMClient({ model: 'opus', systemPrompt: '', logger: { warn: vi.fn() } }),
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
		const first = await createClient().send([userMessage('My name is Miki.')], signal);

		// What a session manager would persist, handed to a new SDK instance and a new agent.
		const persisted = [userMessage('My name is Miki.'), first.message];
		const answer = await new LLMAgent({ llmClient: createClient(), messages: persisted }).run(
			'What is my name?',
			signal,
			vi.fn(),
		);

		expect(Anthropic).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[1]?.[0]).toMatchObject({
			messages: [
				{ role: 'user', content: 'My name is Miki.' },
				{ role: 'assistant', content: 'Hi Miki' },
				{ role: 'user', content: 'What is my name?' },
			],
		});
		expect(answer.response).toBe('Your name is Miki.');
	});

	it('sends the whole context with the system prompt apart, text alone and no empty messages', async () => {
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
				model: 'claude-sonnet-5',
				max_tokens: 16_000,
				system: 'Be brief.',
				messages: [
					{ role: 'user', content: 'first' },
					{ role: 'assistant', content: 'first answer' },
					{ role: 'user', content: 'second' },
					{ role: 'user', content: 'third' },
				],
				thinking: { type: 'adaptive', display: 'summarized' },
				cache_control: { type: 'ephemeral' },
			},
			{ signal },
		);
	});

	it('maps thinking and text into parts, in order, and drops redacted thinking', async () => {
		createSdk(
			response({
				content: [
					thinking('step one'),
					{ type: 'redacted_thinking', data: 'encrypted' },
					text('answer'),
				],
			}),
		);

		const result = await createClient().send([userMessage('prompt')], signal);

		expect(result.message).toEqual({
			role: 'assistant',
			content: [
				{ type: 'reasoning', text: 'step one' },
				{ type: 'text', text: 'answer' },
			],
		});
		expect(result.stopReason).toBe('completed');
	});

	it('leaves out empty thinking', async () => {
		createSdk(response({ content: [thinking(''), text('answer')] }));

		const result = await createClient().send([userMessage('prompt')], signal);

		expect(result.message.content).toEqual(textResponse('answer').message.content);
	});

	it('warns about a content block it does not map and leaves it out', async () => {
		const logger = { warn: vi.fn() };
		const call = { type: 'tool_use', id: 't1', name: 'ls', input: {} } as ContentBlock;
		createSdk(response({ content: [call, text('answer')] }));

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
		createSdk(response({ content: [{ type: 'server_tool_use' } as ContentBlock] }));

		await expect(createClient(logger).send([userMessage('prompt')], signal)).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'log sink closed',
			// The call was billed whatever the logger did.
			tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
		});
	});

	it('takes the input tokens as uncached, because Anthropic counts the cache apart', async () => {
		createSdk(response());

		const result = await createClient().send([userMessage('prompt')], signal);

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

		const result = await createClient().send([userMessage('prompt')], signal);

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

		const result = await createClient(logger).send([userMessage('prompt')], signal);

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

		await expect(createClient(logger).send([userMessage('prompt')], signal)).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'log sink closed',
			usageUnreported: true,
		});
	});

	it.each([
		['end_turn', 'completed'],
		['max_tokens', 'truncated'],
		['refusal', 'refused'],
	] as const)('stops on %s as %s', async (stopReason, expected) => {
		createSdk(response({ stop_reason: stopReason }));

		const result = await createClient().send([userMessage('prompt')], signal);

		expect(result.stopReason).toBe(expected);
	});

	it('turns a response stopped at the context window into a MaxContextError with its tokens', async () => {
		createSdk(response({ stop_reason: 'model_context_window_exceeded' }));

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
			constructor: MaxContextError,
			tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
		});
	});

	// Each needs something this client never sends: tools, server tools or stop sequences.
	it.each(['tool_use', 'pause_turn', 'stop_sequence'] as const)(
		'makes a response that stopped on %s unrecoverable with its tokens',
		async stopReason => {
			createSdk(response({ stop_reason: stopReason }));

			await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
				constructor: UnrecoverableError,
				cause: `The response stopped with "${stopReason}".`,
				tokens: { inputTokens: 10, readCacheTokens: 60, writtenCacheTokens: 30, outputTokens: 20 },
			});
		},
	);

	// No answer arrived, so nothing can be missing from the count.
	it('does not mark a connection failure as unreported', async () => {
		createSdk(new Error('socket hang up'));

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
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

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'The Claude client cannot send the request',
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it('makes a failure the SDK raises before sending unrecoverable', async () => {
		createSdk(new AnthropicError('Profile "work" could not be resolved'));

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'Profile "work" could not be resolved',
		});
	});

	it('turns a prompt that no longer fits into a MaxContextError', async () => {
		createSdk(
			apiError(400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'),
		);

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toBeInstanceOf(
			MaxContextError,
		);
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

		await expect(createClient().send([userMessage('prompt')], signal)).rejects.toMatchObject({
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
