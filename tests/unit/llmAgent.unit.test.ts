import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/shared/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { MaxContextError } from '../../src/llm/domain/errors.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	userMessage,
} from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

// What a run narrates, without the step events, which "step events" checks on its own.
const narration = (events: ProgressEvent[]) => (event: ProgressEvent) => {
	if (event.type !== 'step') events.push(event);
};

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
		expect(response).toEqual({
			response: 'pong',
			tokens: usage,
			duration: 2.5,
			session: { id: expect.stringMatching(/^[a-z]+-[a-z]+-\d{4}$/) as string },
		});
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
			onProgress: narration(events),
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

		const response = await agent.run('first', { signal, onProgress: narration(events) });
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

	it('narrates a call the model stopped early as a step, since it was billed', async () => {
		const llmClient = new FakeLLMClient(textResponse('partial', { stopReason: 'truncated' }));
		const events: ProgressEvent[] = [];

		await expect(
			new LLMAgent({ llmClient }).run('prompt', {
				signal,
				onProgress: event => events.push(event),
			}),
		).rejects.toBeInstanceOf(UnrecoverableError);

		expect(events.filter(event => event.type === 'step')).toEqual([
			expect.objectContaining({ step: 1, tokens: textResponse('').usage }),
		]);
	});

	it('narrates a billed answer the client turned into an error as a step, and no unbilled one', async () => {
		const usage = { inputTokens: 9, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 0 };
		const billed = new MaxContextError('The context no longer fits', {
			cause: 'stopped at the window',
			tokens: usage,
		});
		const events: ProgressEvent[] = [];
		const onProgress = (event: ProgressEvent) => events.push(event);

		await expect(
			new LLMAgent({ llmClient: new FakeLLMClient(billed) }).run('prompt', { signal, onProgress }),
		).rejects.toMatchObject({ tokens: usage });
		// A request the provider refused before answering spent nothing.
		await expect(
			new LLMAgent({ llmClient: new FakeLLMClient(new Error('400')) }).run('prompt', {
				signal,
				onProgress,
			}),
		).rejects.toBeInstanceOf(RecoverableError);

		expect(events.filter(event => event.type === 'step')).toEqual([
			expect.objectContaining({ step: 1, tokens: usage }),
		]);
	});

	it("keeps a billed failure's tokens when the callback throws on its step", async () => {
		const usage = { inputTokens: 9, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 0 };
		const llmClient = new FakeLLMClient(
			new MaxContextError('Too long', { cause: 'stopped at the window', tokens: usage }),
		);

		await expect(
			new LLMAgent({ llmClient }).run('prompt', {
				signal,
				onProgress: () => {
					throw new Error('render failed');
				},
			}),
		).rejects.toMatchObject({
			message: 'LLM agent progress callback failed',
			tokens: usage,
		});
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

	it('fails without remembering the exchange when the model refused', async () => {
		const llmClient = new FakeLLMClient(
			textResponse('partial', { stopReason: 'refused' }),
			textResponse('answer'),
		);
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('first', { signal })).rejects.toMatchObject({
			constructor: UnrecoverableError,
			cause: 'The model stopped with "refused".',
			// The unusable answer was billed.
			tokens: textResponse('').usage,
		});
		await agent.run('second', { signal });

		expect(llmClient.contexts[1]).toEqual([userMessage('second')]);
	});

	it('fails on an answer cut by the output limit, and remembers what it held', async () => {
		const llmClient = new FakeLLMClient(
			textResponse('partial', { stopReason: 'truncated' }),
			textResponse('answer'),
		);
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('first', { signal })).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: textResponse('').usage,
		});
		await agent.run('second', { signal });

		expect(llmClient.contexts[1]).toEqual([
			userMessage('first'),
			{ role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
			userMessage('second'),
		]);
	});

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

/** A client whose provider compacts at 1,000 tokens or more. */
class CompactingClient extends FakeLLMClient {
	checkCompactAt(compactAt: number): void {
		if (compactAt < 1_000) throw new InvalidAgentConfigError('compactAt must be at least 1000');
	}
}

/** An answer whose provider compacted the context first. */
function compactedResponse(text: string, contextTokens?: number): LLMResponse {
	const response = assistantResponse([
		{ type: 'compaction', source: 'fake', data: {} },
		{ type: 'text', text },
	]);
	return contextTokens === undefined
		? response
		: { ...response, compactedContextTokens: contextTokens };
}

describe('LLMAgent compaction', () => {
	const usage = { inputTokens: 9, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 0 };
	const outgrown = () =>
		new MaxContextError('The context no longer fits', { cause: 'too long', tokens: usage });

	it("sends the compactor's threshold with every call, and none when compaction is off", async () => {
		const compacting = new CompactingClient(textResponse('a'));
		const off = new CompactingClient(textResponse('b'));

		await new LLMAgent({
			llmClient: compacting,
			compactor: { by: 'provider', at: 450_000 },
		}).run('prompt', { signal });
		await new LLMAgent({ llmClient: off }).run('prompt', { signal });

		expect(compacting.compactAts).toEqual([450_000]);
		expect(off.compactAts).toEqual([undefined]);
	});

	it("refuses a threshold the client's provider cannot take, or a client that cannot compact", () => {
		const compactor = { by: 'provider', at: 500 } as const;

		expect(() => new LLMAgent({ llmClient: new CompactingClient(), compactor })).toThrow(
			'compactAt must be at least 1000',
		);
		expect(
			() =>
				new LLMAgent({ llmClient: new FakeLLMClient(), compactor: { ...compactor, at: 5_000 } }),
		).toThrow('This model client cannot compact');
	});

	it('narrates a compaction after the step of the call that made it', async () => {
		const events: ProgressEvent[] = [];
		const llmClient = new CompactingClient(compactedResponse('done', 460_000));

		await new LLMAgent({ llmClient, compactor: { by: 'provider', at: 450_000 } }).run('prompt', {
			signal,
			onProgress: event => events.push(event),
		});

		expect(events.map(event => event.type)).toEqual(['step', 'compaction', 'agentMessage']);
		expect(events[1]).toEqual({
			type: 'compaction',
			by: 'provider',
			reason: 'threshold',
			contextTokens: 460_000,
		});
	});

	it('compacts a context that no longer fits once, even with compaction off, and tries again', async () => {
		const logger = { warn: vi.fn() };
		const events: ProgressEvent[] = [];
		const llmClient = new CompactingClient(
			outgrown(),
			compactedResponse('done'),
			textResponse('more'),
		);
		const agent = new LLMAgent({ llmClient, logger });

		const response = await agent.run('prompt', {
			signal,
			onProgress: event => events.push(event),
		});
		await agent.run('next', { signal });

		expect(response.response).toBe('done');
		// The failed call is billed with the run.
		expect(response.tokens).toEqual({
			inputTokens: 10,
			readCacheTokens: 0,
			writtenCacheTokens: 0,
			outputTokens: 1,
		});
		// Only the call after the failure compacts now; the next run is back to the threshold.
		expect(llmClient.compactAts).toEqual([undefined, 'now', undefined]);
		expect(logger.warn).toHaveBeenCalledWith(
			'The context no longer fits the model; the next call compacts it and tries again',
		);
		expect(events.filter(event => event.type === 'compaction')).toEqual([
			{ type: 'compaction', by: 'provider', reason: 'maxContext' },
		]);
	});

	it('fails when the context still does not fit after compacting, with every call billed', async () => {
		const llmClient = new CompactingClient(outgrown(), outgrown());

		await expect(new LLMAgent({ llmClient }).run('prompt', { signal })).rejects.toMatchObject({
			constructor: MaxContextError,
			tokens: { ...usage, inputTokens: 18 },
		});
		expect(llmClient.compactAts).toEqual([undefined, 'now']);
	});

	it('fails at once when no step is left to try again', async () => {
		const llmClient = new CompactingClient(outgrown());

		await expect(
			new LLMAgent({ llmClient, maxSteps: 1 }).run('prompt', { signal }),
		).rejects.toBeInstanceOf(MaxContextError);
		expect(llmClient.compactAts).toEqual([undefined]);
	});
});
