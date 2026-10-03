import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../src/agent/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	userMessage,
} from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

function reasonedResponse(reasoning: string, text?: string): LLMResponse {
	const response = textResponse(text ?? '');
	response.message.content = [
		{ type: 'reasoning', text: reasoning },
		...(text === undefined ? [] : [{ type: 'text' as const, text }]),
	];
	return response;
}

describe('LLMAgent', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends the prompt and returns the answer with its usage and duration', async () => {
		const usage = { inputTokens: 4, readCacheTokens: 3, writtenCacheTokens: 2, outputTokens: 1 };
		const llmClient = new FakeLLMClient(textResponse('pong', { usage }));
		vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_500);

		const response = await new LLMAgent({ llmClient }).run('ping', { signal });

		expect(llmClient.contexts).toEqual([[userMessage('ping')]]);
		expect(response).toEqual({ response: 'pong', tokens: usage, duration: 2.5 });
	});

	it('sends each run the exchanges of the previous ones', async () => {
		const llmClient = new FakeLLMClient(
			textResponse('first answer'),
			textResponse('second answer'),
		);
		const agent = new LLMAgent({ llmClient });

		await agent.run('first', { signal });
		await agent.run('second', { signal });

		expect(llmClient.contexts[1]).toEqual([
			userMessage('first'),
			textResponse('first answer').message,
			userMessage('second'),
		]);
	});

	it('keeps a client that rewrites its context from changing the next turn', async () => {
		const answer = textResponse('answer');
		const contexts: Message[][] = [];
		const llmClient: LLMClient = {
			send: ({ context }) => {
				contexts.push(structuredClone(context));
				for (const message of context) {
					for (const part of message.content) if (part.type === 'text') part.text = 'rewritten';
				}
				return Promise.resolve(answer);
			},
		};
		const agent = new LLMAgent({ llmClient });

		await agent.run('first', { signal });
		answer.message.content = [{ type: 'text', text: 'rewritten' }];
		await agent.run('second', { signal });

		expect(contexts[1]).toEqual([
			userMessage('first'),
			textResponse('answer').message,
			userMessage('second'),
		]);
	});

	it('continues a conversation it is given', async () => {
		const earlier = [userMessage('earlier'), textResponse('earlier answer').message];
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await new LLMAgent({ llmClient, messages: earlier }).run('now', { signal });

		expect(llmClient.contexts).toEqual([[...earlier, userMessage('now')]]);
	});

	it('narrates every part in order but answers with the text alone', async () => {
		const llmClient = new FakeLLMClient(reasonedResponse('thinking', 'answer'));
		const events: ProgressEvent[] = [];

		const response = await new LLMAgent({ llmClient }).run('prompt', {
			signal,
			onProgress: event => events.push(event),
		});

		expect(events).toEqual([
			{ type: 'reasoning', message: 'thinking' },
			{ type: 'agentMessage', message: 'answer' },
		]);
		expect(response.response).toBe('answer');
	});

	// Provider data is for the client to send back, not for anyone to read.
	it('neither narrates nor answers with provider data, but keeps it for the next call', async () => {
		const replay = { type: 'providerData' as const, source: 'fake', data: { signed: 'opaque' } };
		const withReplay = assistantResponse([replay, { type: 'text', text: 'answer' }]);
		const llmClient = new FakeLLMClient(withReplay, textResponse('second answer'));
		const agent = new LLMAgent({ llmClient });
		const events: ProgressEvent[] = [];

		const response = await agent.run('first', { signal, onProgress: event => events.push(event) });
		await agent.run('second', { signal });

		expect(events).toEqual([{ type: 'agentMessage', message: 'answer' }]);
		expect(response.response).toBe('answer');
		expect(llmClient.contexts[1]?.[1]).toEqual(withReplay.message);
	});

	// The call was billed, so its tokens travel even without an answer.
	it('answers with empty text and the usage when the model produced no text', async () => {
		const llmClient = new FakeLLMClient(reasonedResponse('thinking only'));

		const response = await new LLMAgent({ llmClient }).run('prompt', { signal });

		expect(response).toMatchObject({ response: '', tokens: textResponse('').usage });
	});

	it('marks a stop without usage as unreported', async () => {
		const llmClient = new FakeLLMClient(
			textResponse('partial', { stopReason: 'truncated', usage: null }),
		);

		await expect(new LLMAgent({ llmClient }).run('prompt', { signal })).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: undefined,
			usageUnreported: true,
		});
	});

	it.each(['refused', 'truncated'] as const)(
		'fails without remembering the exchange when the model stopped as %s',
		async stopReason => {
			const llmClient = new FakeLLMClient(
				textResponse('partial', { stopReason }),
				textResponse('answer'),
			);
			const agent = new LLMAgent({ llmClient });

			await expect(agent.run('first', { signal })).rejects.toMatchObject({
				constructor: UnrecoverableError,
				cause: `The model stopped with "${stopReason}".`,
				// The unusable answer was billed.
				tokens: textResponse('').usage,
			});
			await agent.run('second', { signal });

			expect(llmClient.contexts[1]).toEqual([userMessage('second')]);
		},
	);

	// Missing accounting does not make the answer wrong: only the tokens are unknown.
	it('keeps an answer whose usage was not reported, without tokens', async () => {
		const llmClient = new FakeLLMClient(
			textResponse('unaccounted', { usage: null }),
			textResponse('answer'),
		);
		const agent = new LLMAgent({ llmClient });

		const response = await agent.run('first', { signal });
		await agent.run('second', { signal });

		expect(response.response).toBe('unaccounted');
		expect(response.tokens).toBeUndefined();
		expect(llmClient.contexts[1]).toHaveLength(3);
	});

	// RetryingAgent runs the same prompt again after a recoverable failure; the prompt of the
	// failed attempt must not still be in the conversation when it does.
	it('makes a provider failure recoverable and lets a retry send the prompt once', async () => {
		const llmClient = new FakeLLMClient(new Error('socket hang up'), textResponse('answer'));
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('prompt', { signal })).rejects.toBeInstanceOf(RecoverableError);
		await agent.run('prompt', { signal });

		expect(llmClient.contexts[1]).toEqual([userMessage('prompt')]);
	});

	it('keeps a failure the client already classified', async () => {
		const failure = new UnrecoverableError('Quota exhausted', { cause: 'insufficient_quota' });
		const llmClient = new FakeLLMClient(failure);

		await expect(new LLMAgent({ llmClient }).run('prompt', { signal })).rejects.toBe(failure);
	});

	it('lets a cancellation through unchanged', async () => {
		const controller = new AbortController();
		controller.abort();
		const llmClient = new FakeLLMClient(textResponse('never sent'));

		await expect(
			new LLMAgent({ llmClient }).run('prompt', { signal: controller.signal }),
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	// The model already answered, so replaying the run could repeat its side effects.
	it('makes a throwing progress callback unrecoverable', async () => {
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await expect(
			new LLMAgent({ llmClient }).run('prompt', {
				signal,
				onProgress: () => {
					throw new Error('render failed');
				},
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'LLM agent progress callback failed',
			cause: 'render failed',
			tokens: textResponse('').usage,
		});
	});
});
