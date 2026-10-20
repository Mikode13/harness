import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import {
	rememberApprovals,
	type Approver,
	type RememberableDecision,
} from '../../src/agent/domain/approval.ts';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/shared/domain/errors.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
	toolMessage,
	toolResult,
	userMessage,
} from '../support/fakeLlmClient.ts';
import { defineTool } from '../../src/tools/infrastructure/defineTool.ts';

const signal = new AbortController().signal;

// What a run narrates, without the step events, which "step events" checks on its own.
const narration = (events: ProgressEvent[]) => (event: ProgressEvent) => {
	if (event.type !== 'step') events.push(event);
};

const citySchema = {
	type: 'object' as const,
	properties: { city: { type: 'string' } },
	required: ['city'],
};

/**
 * A tool whose `execute` is a spy; by default it reports the weather of the city it gets, and
 * every call is `safe`.
 */
function fakeTool(
	name: string,
	execute: Tool['execute'] = input => Promise.resolve(`${(input as { city: string }).city}: sunny`),
	risk: Tool['risk'] = () => 'safe',
	summarize?: Tool['summarize'],
) {
	return {
		name,
		description: `The ${name} tool`,
		inputSchema: citySchema,
		risk: vi.fn(risk),
		execute: vi.fn(execute),
		...(summarize ? { summarize: vi.fn(summarize) } : {}),
	};
}

/** The model asking for the weather in Madrid. */
const madridCall = toolCall('call-1', 'weather', { city: 'Madrid' });

describe('LLMAgent with tools', () => {
	it('offers the model the definition of each tool, never its code', async () => {
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', { signal });

		expect(llmClient.tools).toEqual([
			[{ name: 'weather', description: 'The weather tool', inputSchema: citySchema }],
		]);
	});

	it('offers no tools when it was given none', async () => {
		const llmClient = new FakeLLMClient(textResponse('answer'));

		await new LLMAgent({ llmClient }).run('prompt', { signal });

		expect(llmClient.tools).toEqual([[]]);
	});

	it.each([0, -1, 1.5, Number.NaN])('rejects %s as maxSteps', maxSteps => {
		expect(() => new LLMAgent({ llmClient: new FakeLLMClient(), maxSteps })).toThrow(
			InvalidAgentConfigError,
		);
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

		const response = await new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal });

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

		await new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal });

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

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
		});

		expect(response.response).toBe('Sunny in Madrid');
	});

	it('narrates every step in order, each tool call and how it ended included', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([{ type: 'text', text: 'Let me check.' }, madridCall]),
			textResponse('Sunny in Madrid'),
		);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
			onProgress: narration(events),
		});

		expect(events).toEqual([
			{ type: 'agentMessage', message: 'Let me check.' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'completed' },
			{ type: 'agentMessage', message: 'Sunny in Madrid' },
		]);
	});

	it('narrates each call to the model as a step, with what it sent and what it cost', async () => {
		const usage = { inputTokens: 2, readCacheTokens: 3, writtenCacheTokens: 0, outputTokens: 1 };
		const llmClient = Object.assign(
			new FakeLLMClient(
				assistantResponse([madridCall], { usage }),
				assistantResponse([{ type: 'text', text: 'answer' }], { usage: null }),
			),
			{ systemPrompt: 'Be brief.' },
		);
		const summarize = vi.fn(() => 'weather for Madrid');
		const events: ProgressEvent[] = [];

		await new LLMAgent({
			llmClient,
			tools: [fakeTool('weather', undefined, undefined, summarize)],
		}).run('prompt', { signal, onProgress: event => events.push(event) });

		const steps = events.filter(event => event.type === 'step');
		expect(steps).toHaveLength(2);
		expect(steps[0]).toMatchObject({ step: 1, tokens: usage });
		// The provider reported no usage for the second call.
		expect(steps[1] && 'tokens' in steps[1]).toBe(false);
		expect(steps[0]?.context).toMatchObject({
			instructions: 'Be brief.'.length,
			messages: 'prompt'.length,
			toolResults: [],
		});
		expect(steps[1]).toMatchObject({
			step: 2,
			context: {
				toolResults: [{ tool: 'weather', characters: 'Madrid: sunny'.length, calls: 1 }],
				largestResults: [{ tool: 'weather', characters: 13, summary: 'weather for Madrid' }],
			},
		});
		// The summary the call got when it ran, not a second run of the tool's summarizer.
		expect(summarize).toHaveBeenCalledOnce();
	});

	it('calculates one summary and reuses it for the start and completion events', async () => {
		const summarize = vi.fn((input: unknown) => `weather for ${(input as { city: string }).city}`);
		const llmClient = new FakeLLMClient(assistantResponse([madridCall]), textResponse('answer'));
		const events: ProgressEvent[] = [];

		await new LLMAgent({
			llmClient,
			tools: [fakeTool('weather', undefined, undefined, summarize)],
		}).run('prompt', {
			signal,
			onProgress: narration(events),
		});

		expect(summarize).toHaveBeenCalledOnce();
		expect(events.filter(event => event.type === 'tool')).toEqual([
			{
				type: 'tool',
				id: 'call-1',
				name: 'weather',
				status: 'in_progress',
				summary: 'weather for Madrid',
			},
			{
				type: 'tool',
				id: 'call-1',
				name: 'weather',
				status: 'completed',
				summary: 'weather for Madrid',
			},
		]);
	});

	it('reuses a summary when a tool fails and when a destructive call is denied', async () => {
		const failingSummary = vi.fn(() => 'failed weather');
		const failing = fakeTool(
			'weather',
			() => Promise.reject(new Error('city not found')),
			() => 'safe',
			failingSummary,
		);
		const failedEvents: ProgressEvent[] = [];
		await new LLMAgent({
			llmClient: new FakeLLMClient(assistantResponse([madridCall]), textResponse('answer')),
			tools: [failing],
		}).run('prompt', { signal, onProgress: narration(failedEvents) });
		expect(failingSummary).toHaveBeenCalledOnce();
		expect(failedEvents).toContainEqual({
			type: 'tool',
			id: 'call-1',
			name: 'weather',
			status: 'error',
			summary: 'failed weather',
		});

		const deniedSummary = vi.fn(() => 'write Madrid');
		const denied = fakeTool('weather', undefined, () => 'destructive', deniedSummary);
		const deniedEvents: ProgressEvent[] = [];
		await new LLMAgent({
			llmClient: new FakeLLMClient(assistantResponse([madridCall]), textResponse('answer')),
			tools: [denied],
		}).run('prompt', { signal, onProgress: narration(deniedEvents) });
		expect(deniedSummary).toHaveBeenCalledOnce();
		expect(deniedEvents).toEqual([
			{
				type: 'tool',
				id: 'call-1',
				name: 'weather',
				status: 'denied',
				summary: 'write Madrid',
			},
			{ type: 'agentMessage', message: 'answer' },
		]);
		expect(denied.execute).not.toHaveBeenCalled();
	});

	it('classifies a consumer summarizer failure before preparation or execution', async () => {
		const execute = vi.fn(() => Promise.resolve('should not run'));
		const summarize = vi.fn(() => {
			throw new Error('summary failed');
		});
		const weather = fakeTool('weather', execute, () => 'safe', summarize);

		await expect(
			new LLMAgent({
				llmClient: new FakeLLMClient(assistantResponse([madridCall])),
				tools: [weather],
			}).run('prompt', { signal }),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'The tool call summarizer failed',
			cause: 'summary failed',
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it('returns invalid schema input to the model without treating it as a host failure', async () => {
		const execute = vi.fn(() => Promise.resolve('should not run'));
		const summarize = vi.fn(({ city }: { city: string }) => city);
		const weather = defineTool({
			name: 'weather',
			description: 'Weather',
			input: z.object({ city: z.string() }),
			risk: 'safe',
			summarize,
			execute,
		});
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'weather', { city: 42 })]),
			textResponse('answer'),
		);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient, tools: [weather] }).run('prompt', {
			signal,
			onProgress: narration(events),
		});

		expect(summarize).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(events).toContainEqual({
			type: 'tool',
			id: 'call-1',
			name: 'weather',
			status: 'error',
		});
	});

	it('tells apart two calls to the same tool in one step by their ids', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall, toolCall('call-2', 'weather', { city: 'Oslo' })]),
			textResponse('answer'),
		);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
			onProgress: narration(events),
		});

		// Each call is announced only when its turn comes, never while another is running.
		expect(events.filter(event => event.type === 'tool')).toEqual([
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'completed' },
			{ type: 'tool', id: 'call-2', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-2', name: 'weather', status: 'completed' },
		]);
	});

	// The model can correct itself from an error result; ending the run would waste the steps.
	it('tells the model about a tool it does not have and carries on', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'forecast', { city: 'Madrid' })]),
			textResponse('answer'),
		);

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
		});

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

		const response = await new LLMAgent({ llmClient, tools: [weather] }).run('prompt', {
			signal,
			onProgress: narration(events),
		});

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
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal: controller.signal }),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(send).toHaveBeenCalledOnce();
	});

	// A tool that ignores the signal cannot make the run start the next one.
	it('starts no further tool once the run is cancelled', async () => {
		const controller = new AbortController();
		const first = fakeTool('weather', () => {
			controller.abort();
			return Promise.resolve('finished anyway');
		});
		const second = fakeTool('forecast');
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall, toolCall('call-2', 'forecast', { city: 'Oslo' })]),
			textResponse('never'),
		);
		const events: ProgressEvent[] = [];

		await expect(
			new LLMAgent({ llmClient, tools: [first, second] }).run('prompt', {
				signal: controller.signal,
				onProgress: narration(events),
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(second.execute).not.toHaveBeenCalled();
		// The call that never starts is never announced as running.
		expect(events.filter(event => event.type === 'tool')).toEqual([
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'in_progress' },
			{ type: 'tool', id: 'call-1', name: 'weather', status: 'completed' },
		]);
	});

	// A consumer can cancel synchronously from the callback, on the announcement itself.
	it('does not run a tool whose announcement made the consumer cancel', async () => {
		const controller = new AbortController();
		const weather = fakeTool('weather');
		const llmClient = new FakeLLMClient(assistantResponse([madridCall]), textResponse('never'));

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', {
				signal: controller.signal,
				onProgress: event => {
					if (event.type === 'tool' && event.status === 'in_progress') controller.abort();
				},
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(weather.execute).not.toHaveBeenCalled();
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

		const events: ProgressEvent[] = [];

		await expect(
			new LLMAgent({ llmClient, tools: [weather], maxSteps: 2 }).run('prompt', {
				signal,
				onProgress: narration(events),
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: { inputTokens: 2, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 2 },
		});
		expect(llmClient.contexts).toHaveLength(2);
		expect(weather.execute).toHaveBeenCalledOnce();
		// The unrun call is never announced as running.
		expect(events).not.toContainEqual(expect.objectContaining({ id: 'call-2' }));
	});

	it('defaults to 65 steps', async () => {
		const weather = fakeTool('weather');
		const cities = Array.from({ length: 65 }, (_, index) =>
			assistantResponse([
				toolCall(`call-${String(index)}`, 'weather', { city: `City ${String(index)}` }),
			]),
		);
		const llmClient = new FakeLLMClient(...cities, textResponse('never'));

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal }),
		).rejects.toThrow('The LLM did not finish within its step limit');
		expect(llmClient.contexts).toHaveLength(65);
	});

	// Each step's calls get new ids; what makes them the same is the tool and its input.
	it('stops a model that asks for the same calls five times in a row, before the fifth runs', async () => {
		const weather = fakeTool('weather');
		const same = (id: string) => assistantResponse([toolCall(id, 'weather', { city: 'Madrid' })]);
		const llmClient = new FakeLLMClient(
			same('a'),
			same('b'),
			same('c'),
			same('d'),
			same('e'),
			textResponse('never'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal }),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'The LLM repeated the same tool calls',
			cause: 'The model asked for the same tool calls 5 times in a row.',
			tokens: { inputTokens: 5, outputTokens: 5 },
		});
		expect(weather.execute).toHaveBeenCalledTimes(4);
	});

	it('counts the same input with its properties in another order as the same call', async () => {
		const weather = fakeTool('weather');
		const call = (id: string, input: Record<string, unknown>) =>
			assistantResponse([toolCall(id, 'weather', input)]);
		const forward = { city: 'Madrid', options: { unit: 'C', days: [1, 2] } };
		const backward = { options: { days: [1, 2], unit: 'C' }, city: 'Madrid' };
		const llmClient = new FakeLLMClient(
			call('a', forward),
			call('b', backward),
			call('c', forward),
			call('d', backward),
			call('e', forward),
			textResponse('never'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal }),
		).rejects.toThrow('The LLM repeated the same tool calls');
		expect(weather.execute).toHaveBeenCalledTimes(4);
	});

	it('tells apart inputs whose arrays hold the same items in another order', async () => {
		const weather = fakeTool('weather');
		const call = (id: string, days: number[]) =>
			assistantResponse([toolCall(id, 'weather', { city: 'Madrid', days })]);
		const llmClient = new FakeLLMClient(
			call('a', [1, 2]),
			call('b', [2, 1]),
			call('c', [1, 2]),
			call('d', [2, 1]),
			call('e', [1, 2]),
			textResponse('done'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal }),
		).resolves.toMatchObject({ response: 'done' });
	});

	it('lets a model repeat a call with something else between, or four times in a row', async () => {
		const weather = fakeTool('weather');
		const call = (id: string, city: string) =>
			assistantResponse([toolCall(id, 'weather', { city })]);
		const llmClient = new FakeLLMClient(
			call('1', 'Madrid'),
			call('2', 'Madrid'),
			call('3', 'Madrid'),
			call('4', 'Madrid'),
			call('5', 'Oslo'),
			call('6', 'Madrid'),
			call('7', 'Madrid'),
			call('8', 'Madrid'),
			call('9', 'Madrid'),
			textResponse('done'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', { signal }),
		).resolves.toMatchObject({ response: 'done' });
		expect(weather.execute).toHaveBeenCalledTimes(9);
	});

	describe('a command that keeps ending the same way', () => {
		/**
		 * A command tool whose calls end as `endings` say, one per run in order, as the real one
		 * reports its outcome and output; `undefined` is a call that never ran a command.
		 */
		function fakeCommand(...endings: (string | undefined)[]) {
			let runs = 0;
			const tool: PreparingTool = {
				name: 'runCommand',
				description: 'Runs a command',
				inputSchema: { type: 'object', properties: {}, required: [] },
				prepare: () => {
					let ending: string | undefined;
					return Promise.resolve({
						risk: 'safe',
						ending: () => ending,
						run: () => {
							ending = endings[runs];
							runs++;
							return Promise.resolve(`run ${String(runs)}`);
						},
					});
				},
			};
			return { tool, runs: () => runs };
		}
		const check = (id: string) => toolCall(id, 'runCommand', { command: { name: 'check' } });
		const edit = (id: string) => toolCall(id, 'weather', { city: id });

		// The loop of #100: check, patch, check again, with the patch never fixing what fails.
		it('stops the run on the fifth, whatever the calls between, and runs nothing after it', async () => {
			const command = fakeCommand('fail', 'fail', 'fail', 'fail', 'fail');
			const weather = fakeTool('weather');
			const llmClient = new FakeLLMClient(
				...['1', '2', '3', '4'].flatMap(id => [
					assistantResponse([check(`check-${id}`)]),
					assistantResponse([edit(`edit-${id}`)]),
				]),
				assistantResponse([check('check-5'), edit('edit-5')]),
				textResponse('never'),
			);

			await expect(
				new LLMAgent({ llmClient, tools: [command.tool, weather] }).run('prompt', { signal }),
			).rejects.toMatchObject({
				constructor: UnrecoverableError,
				message: 'The LLM kept getting the same result from a command',
				cause: '"runCommand" ended the same way, with the same output, 5 times in a row.',
				tokens: { inputTokens: 9, outputTokens: 9 },
			});
			expect(command.runs()).toBe(5);
			expect(weather.execute).toHaveBeenCalledTimes(4);
			expect(llmClient.contexts).toHaveLength(9);
		});

		it('starts the count again when the command ends another way, or never runs', async () => {
			const command = fakeCommand(
				'fail',
				'fail',
				'fail',
				'fail',
				'other',
				'fail',
				'fail',
				'fail',
				'fail',
				undefined,
				'fail',
				'fail',
				'fail',
				'fail',
			);
			// An edit between each, as in a real loop, so the calls are never the same twice in a row.
			const calls = Array.from({ length: 14 }, (_, index) => [
				assistantResponse([check(`check-${String(index)}`)]),
				assistantResponse([edit(`edit-${String(index)}`)]),
			]).flat();
			const llmClient = new FakeLLMClient(...calls, textResponse('done'));

			await expect(
				new LLMAgent({ llmClient, tools: [command.tool, fakeTool('weather')] }).run('prompt', {
					signal,
				}),
			).resolves.toMatchObject({ response: 'done' });
			expect(command.runs()).toBe(14);
		});

		it('counts each command apart, so another between does not break the count', async () => {
			const command = fakeCommand(...Array.from({ length: 10 }, () => 'fail'));
			const test = (id: string) => toolCall(id, 'runCommand', { command: { name: 'test' } });
			// Each in a step of its own, with the same calls in every pair: only the command differs.
			const llmClient = new FakeLLMClient(
				...['1', '2', '3', '4', '5'].flatMap(id => [
					assistantResponse([check(`check-${id}`)]),
					assistantResponse([test(`test-${id}`)]),
				]),
				textResponse('never'),
			);

			await expect(
				new LLMAgent({ llmClient, tools: [command.tool] }).run('prompt', { signal }),
			).rejects.toThrow('The LLM kept getting the same result from a command');
			// The fifth check stops the run, before the fifth test.
			expect(command.runs()).toBe(9);
		});

		it('starts each run with no count', async () => {
			const command = fakeCommand(...Array.from({ length: 8 }, () => 'fail'));
			const four = (run: string) =>
				['1', '2', '3', '4'].map(id => assistantResponse([check(`${run}-${id}`)]));
			const llmClient = new FakeLLMClient(
				...four('a'),
				textResponse('first'),
				...four('b'),
				textResponse('second'),
			);
			const agent = new LLMAgent({ llmClient, tools: [command.tool] });

			await agent.run('first', { signal });
			await expect(agent.run('second', { signal })).resolves.toMatchObject({
				response: 'second',
			});
		});
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

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
		});

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

		const response = await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
		});

		expect(response.tokens).toBeUndefined();
	});

	// RetryingAgent reruns the whole prompt, so a retry would run the tool a second time.
	it('makes a recoverable failure after a tool ran unrecoverable, with the tokens spent', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			new Error('socket hang up'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', { signal }),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: textResponse('').usage,
		});
	});

	// A missing tool never reached `execute`, so a retry cannot repeat any effect.
	it('keeps a recoverable failure recoverable when the only call named a missing tool', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'forecast', { city: 'Madrid' })]),
			new Error('socket hang up'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', { signal }),
		).rejects.toBeInstanceOf(RecoverableError);
	});

	// A tool call recorded without its result would make every later request invalid.
	it('remembers nothing of a run that failed midway', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			new Error('socket hang up'),
			textResponse('answer'),
		);
		const agent = new LLMAgent({ llmClient, tools: [fakeTool('weather')] });

		await expect(agent.run('first', { signal })).rejects.toThrow();
		await agent.run('second', { signal });

		expect(llmClient.contexts[2]).toEqual([userMessage('second')]);
	});

	it('sends the next run the whole previous run, tool calls and results included', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([madridCall]),
			textResponse('Sunny in Madrid'),
			textResponse('You are welcome'),
		);
		const agent = new LLMAgent({ llmClient, tools: [fakeTool('weather')] });

		await agent.run('first', { signal });
		await agent.run('thanks', { signal });

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
			new LLMAgent({ llmClient, tools: [weather] }).run('prompt', {
				signal,
				onProgress: event => {
					if (event.type === 'tool') throw new Error('render failed');
				},
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			tokens: textResponse('').usage,
		});
		expect(weather.execute).not.toHaveBeenCalled();
	});
});

describe('LLMAgent tool approval', () => {
	const deleteCall = toolCall('call-1', 'delete', { city: 'Madrid' });
	const destructive = () => fakeTool('delete', undefined, () => 'destructive');
	const answerAfterOneCall = (call = deleteCall) =>
		new FakeLLMClient(assistantResponse([call]), textResponse('done'));

	it.each(['safe', 'mutating'] as const)('runs a %s call without asking', async risk => {
		const tool = fakeTool('delete', undefined, () => risk);
		const approve = vi.fn<Approver>();

		await new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool] }).run('prompt', {
			signal,
			approve,
		});

		expect(tool.risk).toHaveBeenCalledExactlyOnceWith({ city: 'Madrid' });
		expect(approve).not.toHaveBeenCalled();
		expect(tool.execute).toHaveBeenCalledOnce();
	});

	it('denies a destructive call when the run has no approver, and the run carries on', async () => {
		const tool = destructive();
		const llmClient = answerAfterOneCall();
		const onProgress = vi.fn<(event: ProgressEvent) => void>();

		const response = await new LLMAgent({ llmClient, tools: [tool] }).run('prompt', {
			signal,
			onProgress,
		});

		expect(tool.execute).not.toHaveBeenCalled();
		const result = llmClient.contexts[1]?.[2]?.content[0];
		expect(result).toMatchObject({ type: 'toolResult', callId: 'call-1', isError: true });
		expect(result).toHaveProperty('output', expect.stringContaining('denied'));
		expect(onProgress).toHaveBeenCalledWith({
			type: 'tool',
			id: 'call-1',
			name: 'delete',
			status: 'denied',
		});
		expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
		expect(response.response).toBe('done');
	});

	it('asks the approver about a destructive call and runs it once allowed', async () => {
		const tool = destructive();
		const approve = vi.fn<Approver>(() => ({ approved: true }));

		await new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool] }).run('prompt', {
			signal,
			approve,
		});

		expect(approve).toHaveBeenCalledExactlyOnceWith(
			{ tool: 'delete', input: { city: 'Madrid' }, risk: 'destructive' },
			signal,
		);
		expect(tool.execute).toHaveBeenCalledOnce();
	});

	it("tells the model the user denied the call, with the user's reason", async () => {
		const tool = destructive();
		const llmClient = answerAfterOneCall();
		const approve = vi.fn<Approver>(() =>
			Promise.resolve({ approved: false, reason: 'rename it instead' }),
		);

		await new LLMAgent({ llmClient, tools: [tool] }).run('prompt', { signal, approve });

		expect(tool.execute).not.toHaveBeenCalled();
		const result = llmClient.contexts[1]?.[2]?.content[0];
		expect(result).toMatchObject({ isError: true });
		expect(result).toHaveProperty('output', expect.stringContaining('rename it instead'));
	});

	it('runs a destructive call without asking when it was built with autoApprove', async () => {
		const tool = destructive();
		const approve = vi.fn<Approver>();

		await new LLMAgent({
			llmClient: answerAfterOneCall(),
			tools: [tool],
			autoApprove: true,
		}).run('prompt', { signal, approve });

		expect(approve).not.toHaveBeenCalled();
		expect(tool.execute).toHaveBeenCalledOnce();
	});

	it('ends the run when the approver throws, without running the call', async () => {
		const tool = destructive();
		const approve = vi.fn<Approver>(() => {
			throw new Error('terminal closed');
		});

		const run = new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool] }).run('prompt', {
			signal,
			approve,
		});

		await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
		await expect(run).rejects.toHaveProperty('cause', 'terminal closed');
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it('stops when the run is cancelled while the user is being asked', async () => {
		const tool = destructive();
		const controller = new AbortController();
		const approve = vi.fn<Approver>(() => {
			controller.abort();
			return { approved: true };
		});

		const run = new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool] }).run('prompt', {
			signal: controller.signal,
			approve,
		});

		await expect(run).rejects.toHaveProperty('name', 'AbortError');
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it('answers with an error, without asking or running, when a tool cannot judge its call', async () => {
		const tool = fakeTool('delete', undefined, () => {
			throw new Error('cannot stat the file');
		});
		const llmClient = answerAfterOneCall();
		const approve = vi.fn<Approver>();

		await new LLMAgent({ llmClient, tools: [tool] }).run('prompt', { signal, approve });

		expect(approve).not.toHaveBeenCalled();
		expect(tool.execute).not.toHaveBeenCalled();
		expect(llmClient.contexts[1]?.[2]?.content[0]).toMatchObject({
			isError: true,
			output: 'cannot stat the file',
		});
	});

	// Deciding takes an await even when nothing is asked, and the run may be cancelled meanwhile.
	it('does not start a call the run was cancelled for while it was being judged', async () => {
		const controller = new AbortController();
		const tool = fakeTool('delete', undefined, () => {
			controller.abort();
			return 'safe';
		});

		const run = new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool] }).run('prompt', {
			signal: controller.signal,
		});

		await expect(run).rejects.toHaveProperty('name', 'AbortError');
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it('treats an approver that throws on a cancellation as a cancellation, not a failure', async () => {
		const controller = new AbortController();
		const approve = vi.fn<Approver>(() => {
			controller.abort();
			throw new Error('prompt closed');
		});

		const run = new LLMAgent({ llmClient: answerAfterOneCall(), tools: [destructive()] }).run(
			'prompt',
			{ signal: controller.signal, approve },
		);

		await expect(run).rejects.toHaveProperty('name', 'AbortError');
	});

	// Nothing ran, so replaying the prompt cannot repeat an effect.
	it('keeps a later failure retryable when the only call was denied', async () => {
		const tool = destructive();
		const llmClient = new FakeLLMClient(
			assistantResponse([deleteCall]),
			new RecoverableError('overloaded', { cause: '529' }),
		);

		const run = new LLMAgent({ llmClient, tools: [tool] }).run('prompt', { signal });

		await expect(run).rejects.toBeInstanceOf(RecoverableError);
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it('makes a later failure unrecoverable once an approved call ran', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([deleteCall]),
			new RecoverableError('overloaded', { cause: '529' }),
		);

		const run = new LLMAgent({ llmClient, tools: [destructive()] }).run('prompt', {
			signal,
			approve: () => ({ approved: true }),
		});

		await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
	});

	it('runs the call as it was approved, even if the approver changed what it was shown', async () => {
		const tool = destructive();
		const approve = vi.fn<Approver>(request => {
			(request.input as { city: string }).city = 'Oslo';
			return { approved: true };
		});

		await new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool] }).run('prompt', {
			signal,
			approve,
		});

		expect(tool.execute).toHaveBeenCalledExactlyOnceWith({ city: 'Madrid' }, signal);
	});

	// A consumer would otherwise show a call as running while the user is still being asked.
	it('announces a destructive call as running only once it is allowed', async () => {
		const events: ProgressEvent[] = [];
		const eventsWhenAsked: ProgressEvent[] = [];
		const approve = vi.fn<Approver>(() => {
			eventsWhenAsked.push(...events);
			return { approved: true };
		});

		await new LLMAgent({ llmClient: answerAfterOneCall(), tools: [destructive()] }).run('prompt', {
			signal,
			approve,
			onProgress: narration(events),
		});

		expect(eventsWhenAsked.filter(event => event.type === 'tool')).toEqual([]);
		expect(events.filter(event => event.type === 'tool')).toEqual([
			{ type: 'tool', id: 'call-1', name: 'delete', status: 'in_progress' },
			{ type: 'tool', id: 'call-1', name: 'delete', status: 'completed' },
		]);
	});

	it.each([
		['denied, with no approver', destructive, 'denied'],
		['to a tool it does not have', () => fakeTool('other'), 'error'],
	] as const)('never announces a call %s as running', async (_, tool, status) => {
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient: answerAfterOneCall(), tools: [tool()] }).run('prompt', {
			signal,
			onProgress: narration(events),
		});

		expect(events.filter(event => event.type === 'tool')).toEqual([
			{ type: 'tool', id: 'call-1', name: 'delete', status },
		]);
	});

	// An untyped approver can answer anything; a bad answer is its failure, not an unclassified one.
	it.each([
		['nothing', undefined],
		['a decision without a boolean approved', { approved: 'yes' }],
	])('ends the run as an approver failure when it answers %s', async (_, answer) => {
		const tool = destructive();
		const llmClient = new FakeLLMClient(
			assistantResponse([deleteCall], { usage: { inputTokens: 5 } }),
		);
		const agent = new LLMAgent({ llmClient, tools: [tool] });

		const run = agent.run('prompt', { signal, approve: (() => answer) as unknown as Approver });

		await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
		await expect(run).rejects.toHaveProperty('message', 'The tool call approver failed');
		await expect(run).rejects.toHaveProperty('tokens.inputTokens', 5);
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it('neither runs nor remembers a call whose remembered answer is malformed', async () => {
		const tool = destructive();
		const ask = vi
			.fn<Parameters<typeof rememberApprovals>[0]>()
			.mockReturnValueOnce({ approved: 'false', remember: true } as unknown as RememberableDecision)
			.mockReturnValueOnce({ approved: false });
		const agent = new LLMAgent({
			llmClient: new FakeLLMClient(
				assistantResponse([deleteCall]),
				assistantResponse([deleteCall]),
				textResponse('done'),
			),
			tools: [tool],
		});
		const approve = rememberApprovals(ask);

		await expect(agent.run('first', { signal, approve })).rejects.toHaveProperty(
			'message',
			'The tool call approver failed',
		);
		await agent.run('second', { signal, approve });

		expect(ask).toHaveBeenCalledTimes(2);
		expect(tool.execute).not.toHaveBeenCalled();
	});
});
