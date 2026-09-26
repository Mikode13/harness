import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../src/agent/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { LLMResponse } from '../../src/llm/domain/llm.ts';
import { FakeLLMClient, textResponse, userMessage } from '../support/fakeLlmClient.ts';

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

		const response = await new LLMAgent({ llmClient }).run('ping', signal, vi.fn());

		expect(llmClient.contexts).toEqual([[userMessage('ping')]]);
		expect(response).toEqual({ response: 'pong', tokens: usage, duration: 2.5 });
	});

	it('sends each run the exchanges of the previous ones', async () => {
		const llmClient = new FakeLLMClient(
			textResponse('first answer'),
			textResponse('second answer'),
		);
		const agent = new LLMAgent({ llmClient });

		await agent.run('first', signal, vi.fn());
		await agent.run('second', signal, vi.fn());

		expect(llmClient.contexts[1]).toEqual([
			userMessage('first'),
			textResponse('first answer').message,
			userMessage('second'),
		]);
	});

	it('continues a conversation it is given', async () => {
		const earlier = [userMessage('earlier'), textResponse('earlier answer').message];
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await new LLMAgent({ llmClient, messages: earlier }).run('now', signal, vi.fn());

		expect(llmClient.contexts).toEqual([[...earlier, userMessage('now')]]);
	});

	it('narrates every part in order but answers with the text alone', async () => {
		const llmClient = new FakeLLMClient(reasonedResponse('thinking', 'answer'));
		const events: ProgressEvent[] = [];

		const response = await new LLMAgent({ llmClient }).run('prompt', signal, event =>
			events.push(event),
		);

		expect(events).toEqual([
			{ type: 'reasoning', message: 'thinking' },
			{ type: 'agentMessage', message: 'answer' },
		]);
		expect(response?.response).toBe('answer');
	});

	it('returns undefined when the model produced no text', async () => {
		const llmClient = new FakeLLMClient(reasonedResponse('thinking only'));

		await expect(new LLMAgent({ llmClient }).run('prompt', signal, vi.fn())).resolves.toBe(
			undefined,
		);
	});

	it.each(['refused', 'truncated'] as const)(
		'fails without remembering the exchange when the model stopped as %s',
		async stopReason => {
			const llmClient = new FakeLLMClient(
				textResponse('partial', { stopReason }),
				textResponse('answer'),
			);
			const agent = new LLMAgent({ llmClient });

			await expect(agent.run('first', signal, vi.fn())).rejects.toMatchObject({
				constructor: UnrecoverableError,
				cause: `The model stopped with "${stopReason}".`,
			});
			await agent.run('second', signal, vi.fn());

			expect(llmClient.contexts[1]).toEqual([userMessage('second')]);
		},
	);

	// RetryingAgent runs the same prompt again after a recoverable failure; the prompt of the
	// failed attempt must not still be in the conversation when it does.
	it('makes a provider failure recoverable and lets a retry send the prompt once', async () => {
		const llmClient = new FakeLLMClient(new Error('socket hang up'), textResponse('answer'));
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('prompt', signal, vi.fn())).rejects.toBeInstanceOf(RecoverableError);
		await agent.run('prompt', signal, vi.fn());

		expect(llmClient.contexts[1]).toEqual([userMessage('prompt')]);
	});

	it('keeps a failure the client already classified', async () => {
		const failure = new UnrecoverableError('Quota exhausted', { cause: 'insufficient_quota' });
		const llmClient = new FakeLLMClient(failure);

		await expect(new LLMAgent({ llmClient }).run('prompt', signal, vi.fn())).rejects.toBe(failure);
	});

	it('lets a cancellation through unchanged', async () => {
		const controller = new AbortController();
		controller.abort();
		const llmClient = new FakeLLMClient(textResponse('never sent'));

		await expect(
			new LLMAgent({ llmClient }).run('prompt', controller.signal, vi.fn()),
		).rejects.toMatchObject({ name: 'AbortError' });
	});

	// The model already answered, so replaying the run could repeat its side effects.
	it('makes a throwing progress callback unrecoverable', async () => {
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await expect(
			new LLMAgent({ llmClient }).run('prompt', signal, () => {
				throw new Error('render failed');
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'LLM agent progress callback failed',
			cause: 'render failed',
		});
	});
});
