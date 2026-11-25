import { describe, expect, it } from 'vitest';
import { RunInProgressError } from '../../src/agent/domain/oneRunAtATime.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { parseConversationSnapshot } from '../../src/llm/domain/conversationSnapshot.ts';
import type { LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/shared/domain/errors.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
	toolMessage,
	toolResult,
	unansweredCalls,
	userMessage,
} from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

/** The message a text answer is recorded as. */
const answer = (text: string): Message => textResponse(text).message;

/** A safe tool that answers `sunny` for any city. */
const weather: Tool = {
	name: 'weather',
	description: 'The weather in a city',
	inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
	risk: () => 'safe',
	execute: () => Promise.resolve('sunny'),
};

/** A client whose answers wait until `openGate` is called, so a test can look at a run in progress. */
class GatedLLMClient extends FakeLLMClient {
	private readonly gate: Promise<void>;
	readonly openGate: () => void;

	constructor(...script: (LLMResponse | Error)[]) {
		super(...script);
		let open: () => void = () => undefined;
		this.gate = new Promise<void>(resolve => {
			open = () => {
				resolve();
			};
		});
		this.openGate = open;
	}

	override send(...args: Parameters<FakeLLMClient['send']>): Promise<LLMResponse> {
		return this.gate.then(() => super.send(...args));
	}
}

/** The error `snapshot()` throws, which the test has to catch to look at. */
function snapshotError(agent: LLMAgent): unknown {
	try {
		agent.snapshot();
	} catch (error) {
		return error;
	}
	throw new Error('snapshot() did not throw');
}

describe('LLMAgent snapshot', () => {
	it('continues a restored conversation as the uninterrupted one would', async () => {
		const uninterrupted = new FakeLLMClient(
			textResponse('first answer'),
			textResponse('second answer'),
		);
		const original = new LLMAgent({ llmClient: uninterrupted });
		await original.run('first', { signal });
		await original.run('second', { signal });

		const saver = new FakeLLMClient(textResponse('first answer'));
		const first = new LLMAgent({ llmClient: saver });
		await first.run('first', { signal });
		// Stored as JSON, the way a host keeps it, and read back before it is taken up.
		const saved = parseConversationSnapshot(JSON.parse(JSON.stringify(first.snapshot())));
		const resumed = new FakeLLMClient(textResponse('second answer'));
		const restored = new LLMAgent({ llmClient: resumed, snapshot: saved });

		await expect(restored.run('second', { signal })).resolves.toMatchObject({
			response: 'second answer',
		});
		expect(resumed.contexts[0]).toEqual(uninterrupted.contexts[1]);
	});

	it('snapshots the messages of an agent that has run nothing, and takes them up', async () => {
		const agent = new LLMAgent({
			llmClient: new FakeLLMClient(),
			messages: [userMessage('earlier')],
		});

		expect(agent.snapshot()).toEqual({
			version: 1,
			initial: [userMessage('earlier')],
			turns: [],
			current: null,
			seenRevision: 0,
			contextTokens: null,
		});
		const client = new FakeLLMClient(textResponse('answer'));
		await new LLMAgent({ llmClient: client, snapshot: agent.snapshot() }).run('now', { signal });
		expect(client.contexts).toEqual([[userMessage('earlier'), userMessage('now')]]);
	});

	it('refuses a snapshot together with the messages it would replace', () => {
		const snapshot = new LLMAgent({ llmClient: new FakeLLMClient() }).snapshot();

		expect(() => new LLMAgent({ llmClient: new FakeLLMClient(), messages: [], snapshot })).toThrow(
			InvalidAgentConfigError,
		);
	});

	it('refuses a snapshot while a run works, and holds the run once it has ended', async () => {
		const client = new GatedLLMClient(textResponse('secret answer'));
		const agent = new LLMAgent({ llmClient: client });
		const running = agent.run('secret prompt', { signal });

		const refused = snapshotError(agent);
		expect(refused).toBeInstanceOf(RunInProgressError);
		expect(refused).toBeInstanceOf(UnrecoverableError);
		// The error names no part of the run.
		expect(JSON.stringify(refused)).not.toContain('secret');
		expect((refused as Error).message).not.toContain('secret');

		client.openGate();
		await expect(running).resolves.toMatchObject({ response: 'secret answer' });
		expect(agent.snapshot().turns.map(turn => turn.messages)).toEqual([
			[userMessage('secret prompt'), answer('secret answer')],
		]);
	});

	it('keeps a run the model cut short, records nothing from a failed one, and continues from the last kept turn', async () => {
		const client = new FakeLLMClient(
			textResponse('partial', { stopReason: 'truncated' }),
			new RecoverableError('The connection dropped', { cause: 'socket closed' }),
			textResponse('next answer'),
		);
		const agent = new LLMAgent({ llmClient: client });

		await expect(agent.run('first', { signal })).rejects.toBeInstanceOf(UnrecoverableError);
		expect(agent.snapshot().turns.map(turn => turn.messages)).toEqual([
			[userMessage('first'), answer('partial')],
		]);
		await expect(agent.run('second', { signal })).rejects.toBeInstanceOf(RecoverableError);
		expect(agent.snapshot().turns).toHaveLength(1);

		await agent.run('third', { signal });
		expect(client.contexts[2]).toEqual([
			userMessage('first'),
			answer('partial'),
			userMessage('third'),
		]);
	});

	it('refuses to save a conversation that is not plain data, as an unrecoverable failure', async () => {
		const response = textResponse('');
		// A number where the text belongs: the run carries it, but it is not a snapshot.
		response.message.content = [{ type: 'text', text: 5 as unknown as string }];
		const agent = new LLMAgent({ llmClient: new FakeLLMClient(response) });
		await agent.run('prompt', { signal });

		expect(snapshotError(agent)).toBeInstanceOf(UnrecoverableError);
		expect(snapshotError(agent)).toMatchObject({
			message: 'The conversation could not be saved',
			cause: expect.stringContaining('Invalid conversation snapshot') as unknown,
		});
	});

	it('keeps the context size of a run that reported usage, and none before it', async () => {
		const agent = new LLMAgent({ llmClient: new FakeLLMClient(textResponse('answer')) });
		expect(agent.snapshot().contextTokens).toBeNull();

		await agent.run('prompt', { signal });

		// The default usage is one input token.
		expect(agent.snapshot().contextTokens).toBe(1);
	});

	it('shares nothing with the snapshot it returned or was given', async () => {
		const client = new FakeLLMClient(
			textResponse('first answer'),
			textResponse('second answer'),
			textResponse('third answer'),
		);
		const agent = new LLMAgent({ llmClient: client, messages: [userMessage('earlier')] });
		await agent.run('first', { signal });

		// Changing a snapshot the agent returned does not change the agent.
		const returned = agent.snapshot();
		(returned.initial as Message[]).push(userMessage('injected'));
		(returned.turns[0]?.messages as Message[] | undefined)?.push(userMessage('injected'));
		await agent.run('second', { signal });
		expect(client.contexts[1]).toEqual([
			userMessage('earlier'),
			userMessage('first'),
			answer('first answer'),
			userMessage('second'),
		]);

		// Nor does changing the snapshot a restored agent was given.
		const given = agent.snapshot();
		const resumed = new FakeLLMClient(textResponse('third answer'));
		const restored = new LLMAgent({ llmClient: resumed, snapshot: given });
		(given.initial as Message[]).push(userMessage('injected'));
		await restored.run('third', { signal });
		expect(resumed.contexts[0]).toEqual([
			userMessage('earlier'),
			userMessage('first'),
			answer('first answer'),
			userMessage('second'),
			answer('second answer'),
			userMessage('third'),
		]);
	});

	it('restores a run the model cut short, answering each call it kept, and the next call succeeds', async () => {
		const client = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'weather', { city: 'Madrid' })]),
			assistantResponse(
				[
					{ type: 'text', text: 'Madrid is sunny, and' },
					toolCall('call-2', 'weather', { city: 'Par' }),
				],
				{ stopReason: 'truncated' },
			),
		);
		const agent = new LLMAgent({ llmClient: client, tools: [weather] });
		await expect(agent.run('weather?', { signal })).rejects.toBeInstanceOf(UnrecoverableError);

		const resumed = new FakeLLMClient(textResponse('next answer'));
		await expect(
			new LLMAgent({
				llmClient: resumed,
				tools: [weather],
				snapshot: parseConversationSnapshot(JSON.parse(JSON.stringify(agent.snapshot()))),
			}).run('go on', { signal }),
		).resolves.toMatchObject({ response: 'next answer' });

		// The cut call never ran, so it is not kept; the answer before the limit is.
		expect(resumed.contexts[0]).toEqual([
			userMessage('weather?'),
			{ role: 'assistant', content: [toolCall('call-1', 'weather', { city: 'Madrid' })] },
			toolMessage(toolResult('call-1', 'weather', 'sunny')),
			answer('Madrid is sunny, and'),
			userMessage('go on'),
		]);
		expect(unansweredCalls(resumed.contexts[0] ?? [])).toEqual([]);
	});

	it('restores a run a repeated call stopped, answering every call in it, and the next call succeeds', async () => {
		const same = (id: string) => assistantResponse([toolCall(id, 'weather', { city: 'Madrid' })]);
		const agent = new LLMAgent({
			llmClient: new FakeLLMClient(...['1', '2', '3', '4', '5'].map(same), textResponse('never')),
			tools: [weather],
		});
		await expect(agent.run('prompt', { signal })).rejects.toMatchObject({
			message: 'The LLM repeated the same tool calls',
		});

		const resumed = new FakeLLMClient(textResponse('next answer'));
		await expect(
			new LLMAgent({
				llmClient: resumed,
				tools: [weather],
				snapshot: parseConversationSnapshot(JSON.parse(JSON.stringify(agent.snapshot()))),
			}).run('go on', { signal }),
		).resolves.toMatchObject({ response: 'next answer' });

		expect(unansweredCalls(resumed.contexts[0] ?? [])).toEqual([]);
		expect(resumed.contexts[0]?.slice(-3)).toEqual([
			{ role: 'assistant', content: [toolCall('5', 'weather', { city: 'Madrid' })] },
			toolMessage(
				toolResult(
					'5',
					'weather',
					expect.stringContaining('Not run: the run stopped here') as string,
					true,
				),
			),
			userMessage('go on'),
		]);
	});
});
