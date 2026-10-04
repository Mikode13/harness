import { describe, expect, it, vi } from 'vitest';
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

const signal = new AbortController().signal;

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
) {
	return {
		name,
		description: `The ${name} tool`,
		inputSchema: citySchema,
		risk: vi.fn(risk),
		execute: vi.fn(execute),
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
			onProgress: event => events.push(event),
		});

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

		await new LLMAgent({ llmClient, tools: [fakeTool('weather')] }).run('prompt', {
			signal,
			onProgress: event => events.push(event),
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
			onProgress: event => events.push(event),
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
				onProgress: event => events.push(event),
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
				onProgress: event => events.push(event),
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
			onProgress: event => events.push(event),
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
			onProgress: event => events.push(event),
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
