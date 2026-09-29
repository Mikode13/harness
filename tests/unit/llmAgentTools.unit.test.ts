import { describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/agent/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { Tool } from '../../src/llm/domain/tool.ts';
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

const citySchema = {
	type: 'object' as const,
	properties: { city: { type: 'string' } },
	required: ['city'],
};

/** A tool whose `execute` is a spy; by default it reports the weather of the city it gets. */
function fakeTool(
	name: string,
	execute: Tool['execute'] = input => Promise.resolve(`${(input as { city: string }).city}: sunny`),
) {
	return {
		name,
		description: `The ${name} tool`,
		inputSchema: citySchema,
		execute: vi.fn(execute),
	};
}

/** The model asking for the weather in Madrid. */
const madridCall = toolCall('call-1', 'weather', { city: 'Madrid' });

describe('LLMAgent with tools', () => {
	it('offers the model the definition of each tool, never its code', async () => {
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', signal, vi.fn());

		expect(llmClient.tools).toEqual([
			[{ name: 'weather', description: 'The weather tool', inputSchema: citySchema }],
		]);
	});

	it('offers no tools when it was given none', async () => {
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await new LLMAgent({ llmClient }).run('prompt', signal, vi.fn());

		expect(llmClient.tools).toEqual([[]]);
	});

	it('rejects two tools with the same name', () => {
		expect(
			() =>
				new LLMAgent({
					llmClient: new FakeLLMClient(),
					tools: [fakeTool('weather'), fakeTool('weather')],
				}),
		).toThrow(InvalidAgentConfigError);
	});

	it('runs a requested tool and sends its result back until the model answers', async () => {
		const weather = fakeTool('weather');
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			textResponse('Sunny in Madrid'),
		);

		const response = await new LLMAgent({ llmClient, tools: [weather] }).run(
			'prompt',
			signal,
			vi.fn(),
		);

		expect(weather.execute).toHaveBeenCalledExactlyOnceWith({ city: 'Madrid' }, signal);
		expect(llmClient.contexts[1]).toEqual([
			userMessage('prompt'),
			assistantResponse([madridCall]).message,
			toolMessage(toolResult('call-1', 'weather', 'Madrid: sunny')),
		]);
		expect(response.response).toBe('Sunny in Madrid');
	});

	// One at a time keeps the order deterministic, and a later approval prompt (#43) needs it.
	it('runs the calls of one step one at a time, in order, and returns their results together', async () => {
		const log: string[] = [];
		const weather = fakeTool('weather', async input => {
			const { city } = input as { city: string };
			log.push(`start ${city}`);
			await Promise.resolve();
			log.push(`end ${city}`);
			return `${city}: sunny`;
		});
		const osloCall = toolCall('call-2', 'weather', { city: 'Oslo' });
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall, osloCall]),
			textResponse('answer'),
		);

		await new LLMAgent({ llmClient, tools: [weather] }).run('prompt', signal, vi.fn());

		expect(log).toEqual(['start Madrid', 'end Madrid', 'start Oslo', 'end Oslo']);
		expect(llmClient.contexts[1]?.[2]).toEqual(
			toolMessage(
				toolResult('call-1', 'weather', 'Madrid: sunny'),
				toolResult('call-2', 'weather', 'Oslo: sunny'),
			),
		);
	});

	it('answers with the text of the final step alone', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([{ type: 'text', text: 'Let me check.' }, madridCall]),
			textResponse('Sunny in Madrid'),
		);

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run(
			'prompt',
			signal,
			vi.fn(),
		);

		expect(response.response).toBe('Sunny in Madrid');
	});

	it('narrates every step in order, each tool call and how it ended included', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([{ type: 'text', text: 'Let me check.' }, madridCall]),
			textResponse('Sunny in Madrid'),
		);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', signal, event =>
			events.push(event),
		);

		expect(events).toEqual([
			{ type: 'agentMessage', message: 'Let me check.' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'completed' },
			{ type: 'agentMessage', message: 'Sunny in Madrid' },
		]);
	});

	it('tells apart two calls to the same tool in one step by their ids', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall, toolCall('call-2', 'weather', { city: 'Oslo' })]),
			textResponse('answer'),
		);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', signal, event =>
			events.push(event),
		);

		expect(events.filter(event => event.type === 'tool')).toEqual([
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-2', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'completed' },
			{ type: 'tool', id: 'call-2', name: 'weather', status: 'completed' },
		]);
	});

	// The model can correct itself from an error result; ending the run would waste the steps.
	it('tells the model about a tool it does not have and carries on', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'forecast', { city: 'Madrid' })]),
			textResponse('answer'),
		);

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run(
			'prompt',
			signal,
			vi.fn(),
		);

		expect(llmClient.contexts[1]?.[2]).toEqual(
			toolMessage({
				type: 'toolResult',
				callId: 'call-1',
				name: 'forecast',
				output: expect.stringContaining('forecast') as string,
				isError: true,
			}),
		);
		expect(response.response).toBe('answer');
	});

	// Input validation belongs to the tool, so bad arguments reach the loop this same way.
	it('returns the error of a failing tool to the model and carries on', async () => {
		const weather = fakeTool('weather', () => Promise.reject(new Error('city not found')));
		const llmClient = new FakeLLMClient(assistantResponse([madridCall]), textResponse('answer'));
		const events: ProgressEvent[] = [];

		const response = await new LLMAgent({ llmClient, tools: [weather] }).run(
			'prompt',
			signal,
			event => events.push(event),
		);

		expect(llmClient.contexts[1]?.[2]).toEqual(
			toolMessage({
				type: 'toolResult',
				callId: 'call-1',
				name: 'weather',
				output: expect.stringContaining('city not found') as string,
				isError: true,
			}),
		);
		expect(events).toContainEqual({
			type: 'tool',
			id: 'call-1',
			name: 'weather',
			status: 'error',
		});
		expect(response.response).toBe('answer');
	});

	// A tool may turn the abort into an error of its own; the signal, not the error, decides.
	it('lets a cancellation during a tool through, without calling the model again', async () => {
		const controller = new AbortController();
		const weather = fakeTool('weather', () => {
			controller.abort();
			return Promise.reject(new Error('interrupted'));
		});
		const llmClient = new FakeLLMClient(assistantResponse([madridCall]), textResponse('never'));
		// Counted on the spy: the fake records nothing for a call made after the abort.
		const send = vi.spyOn(llmClient, 'send');

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', controller.signal, vi.fn()),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(send).toHaveBeenCalledOnce();
	});

	// `maxSteps` counts calls to the model. The last step's calls are not run: no call is left
	// to send their results to.
	it('fails with the spent tokens when the model is still calling tools after maxSteps', async () => {
		const weather = fakeTool('weather');
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			assistantResponse([toolCall('call-2', 'weather', { city: 'Oslo' })]),
			textResponse('never'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [weather], maxSteps: 2 }).run('prompt', signal, vi.fn()),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: { inputTokens: 2, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 2 },
		});
		expect(llmClient.contexts).toHaveLength(2);
		expect(weather.execute).toHaveBeenCalledOnce();
	});

	it('reports the tokens of every step', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall], {
				usage: { inputTokens: 10, readCacheTokens: 1, writtenCacheTokens: 2, outputTokens: 3 },
			}),
			textResponse('answer', {
				usage: { inputTokens: 20, readCacheTokens: 4, writtenCacheTokens: 5, outputTokens: 6 },
			}),
		);

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run(
			'prompt',
			signal,
			vi.fn(),
		);

		expect(response.tokens).toEqual({
			inputTokens: 30,
			readCacheTokens: 5,
			writtenCacheTokens: 7,
			outputTokens: 9,
		});
	});

	// A partial sum would report a billed step as free.
	it('reports no tokens when any step did not report its usage', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall], { usage: null }),
			textResponse('answer'),
		);

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run(
			'prompt',
			signal,
			vi.fn(),
		);

		expect(response.tokens).toBeUndefined();
	});

	// RetryingAgent reruns the whole prompt, so a retry would run the tool a second time.
	it('makes a recoverable failure after a tool ran unrecoverable, with the tokens spent', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			new Error('socket hang up'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', signal, vi.fn()),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: textResponse('').usage,
		});
	});

	// A tool call recorded without its result would make every later request invalid.
	it('remembers nothing of a run that failed midway', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			new Error('socket hang up'),
			textResponse('answer'),
		);
		const agent = new LLMAgent({ llmClient, tools: [fakeTool('weather')] });

		await expect(agent.run('first', signal, vi.fn())).rejects.toThrow();
		await agent.run('second', signal, vi.fn());

		expect(llmClient.contexts[2]).toEqual([userMessage('second')]);
	});

	it('sends the next run the whole previous run, tool calls and results included', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			textResponse('Sunny in Madrid'),
			textResponse('You are welcome'),
		);
		const agent = new LLMAgent({ llmClient, tools: [fakeTool('weather')] });

		await agent.run('first', signal, vi.fn());
		await agent.run('thanks', signal, vi.fn());

		expect(llmClient.contexts[2]).toEqual([
			userMessage('first'),
			assistantResponse([madridCall]).message,
			toolMessage(toolResult('call-1', 'weather', 'Madrid: sunny')),
			textResponse('Sunny in Madrid').message,
			userMessage('thanks'),
		]);
	});

	// The model already answered, so replaying the run could repeat its side effects.
	it('makes a throwing progress callback unrecoverable before the tool runs', async () => {
		const weather = fakeTool('weather');
		const llmClient = new FakeLLMClient(assistantResponse([madridCall]));

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', signal, event => {
				if (event.type === 'tool') throw new Error('render failed');
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: textResponse('').usage,
		});
		expect(weather.execute).not.toHaveBeenCalled();
	});
});
