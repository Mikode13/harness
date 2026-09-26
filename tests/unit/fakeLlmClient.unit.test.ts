import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/llm/domain/message.ts';
import { FakeLLMClient, textResponse, userMessage } from '../support/fakeLlmClient.ts';

// The fake is what the model-backed agent tests will stand on, so the few properties they
// rely on are pinned here instead of being rediscovered through a confusing agent failure.
describe('FakeLLMClient', () => {
	const signal = new AbortController().signal;

	it('answers from its script in order', async () => {
		const client = new FakeLLMClient(textResponse('first'), textResponse('second'));

		await expect(client.send([userMessage('a')], signal)).resolves.toEqual(textResponse('first'));
		await expect(client.send([userMessage('b')], signal)).resolves.toEqual(textResponse('second'));
	});

	it('records each context as it was when sent, not as the caller later changes it', async () => {
		const client = new FakeLLMClient(textResponse('pong'), textResponse('pong again'));
		const context: Message[] = [userMessage('ping')];

		const first = await client.send(context, signal);
		context.push(first.message, userMessage('ping again'));
		await client.send(context, signal);

		expect(client.contexts).toEqual([
			[userMessage('ping')],
			[userMessage('ping'), textResponse('pong').message, userMessage('ping again')],
		]);
	});

	it('rejects with the scripted failure', async () => {
		const failure = new Error('provider down');
		const client = new FakeLLMClient(failure);

		await expect(client.send([userMessage('a')], signal)).rejects.toBe(failure);
	});

	it('rejects a cancelled call with an AbortError and records nothing', async () => {
		const controller = new AbortController();
		controller.abort();
		const client = new FakeLLMClient(textResponse('never sent'));

		await expect(client.send([userMessage('a')], controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(client.contexts).toEqual([]);
	});

	it('fails loudly when a test scripts too few responses', async () => {
		const client = new FakeLLMClient();

		await expect(client.send([userMessage('a')], signal)).rejects.toThrow(
			'FakeLLMClient ran out of scripted responses',
		);
	});
});
