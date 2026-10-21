import { describe, expect, it, vi } from 'vitest';
import type { Transcript } from '../../src/agent/domain/transcript.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import { defineTool } from '../../src/tools/infrastructure/defineTool.ts';
import { z } from 'zod';
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

const weather = defineTool({
	name: 'weather',
	description: 'The weather in a city',
	input: z.object({ city: z.string() }),
	risk: () => 'safe',
	execute: ({ city }) => Promise.resolve(`Sunny in ${city}`),
});

const madrid = toolCall('call-1', 'weather', { city: 'Madrid' });

function client(...script: ConstructorParameters<typeof FakeLLMClient>) {
	return Object.assign(new FakeLLMClient(...script), { systemPrompt: 'Answer briefly.' });
}

function transcripts() {
	const received: Transcript[] = [];
	return { received, onTranscript: (transcript: Transcript) => void received.push(transcript) };
}

describe('LLMAgent transcripts', () => {
	it('hands over what the model saw once a run completes, every run with the turns before it', async () => {
		const { received, onTranscript } = transcripts();
		const agent = new LLMAgent({
			llmClient: client(
				assistantResponse([madrid]),
				textResponse('Sunny.'),
				textResponse('Still sunny.'),
			),
			tools: [weather],
			onTranscript,
		});

		await agent.run('Weather in Madrid?', { signal });
		await agent.run('And now?', { signal });

		const firstRun = [
			userMessage('Weather in Madrid?'),
			{ role: 'assistant', content: [madrid] },
			toolMessage(toolResult('call-1', 'weather', 'Sunny in Madrid', false)),
			{ role: 'assistant', content: [{ type: 'text', text: 'Sunny.' }] },
		];
		expect(received).toEqual([
			{
				outcome: 'completed',
				content: {
					instructions: 'Answer briefly.',
					tools: [
						{
							name: 'weather',
							description: 'The weather in a city',
							inputSchema: expect.objectContaining({ type: 'object' }) as unknown,
						},
					],
					messages: firstRun,
				},
			},
			{
				outcome: 'completed',
				content: expect.objectContaining({
					messages: [
						...firstRun,
						userMessage('And now?'),
						{ role: 'assistant', content: [{ type: 'text', text: 'Still sunny.' }] },
					],
				}) as unknown,
			},
		]);
	});

	it('hands over a failed run with what it ended with, and still fails it', async () => {
		const { received, onTranscript } = transcripts();
		const agent = new LLMAgent({
			llmClient: client(assistantResponse([madrid]), assistantResponse([madrid])),
			tools: [weather],
			maxSteps: 2,
			onTranscript,
		});

		await expect(agent.run('Weather in Madrid?', { signal })).rejects.toThrow(UnrecoverableError);

		expect(received).toHaveLength(1);
		expect(received[0]?.outcome).toBe('failed');
		expect(received[0]?.content).toMatchObject({
			error: 'The model was still calling tools after 2 steps.',
			messages: [
				userMessage('Weather in Madrid?'),
				{ role: 'assistant', content: [madrid] },
				toolMessage(toolResult('call-1', 'weather', 'Sunny in Madrid', false)),
				{ role: 'assistant', content: [madrid] },
			],
		});
	});

	it('hands over a run cut by the output limit with what its answer held', async () => {
		const { received, onTranscript } = transcripts();
		const agent = new LLMAgent({
			llmClient: client(
				assistantResponse([{ type: 'reasoning', text: 'A long plan' }], {
					stopReason: 'truncated',
				}),
			),
			onTranscript,
		});

		await expect(agent.run('Plan it', { signal })).rejects.toThrow(UnrecoverableError);

		expect(received[0]).toMatchObject({
			outcome: 'failed',
			content: {
				messages: [
					userMessage('Plan it'),
					{ role: 'assistant', content: [{ type: 'reasoning', text: 'A long plan' }] },
				],
			},
		});
	});

	it('hands over a cancelled run, and still cancels it', async () => {
		const { received, onTranscript } = transcripts();
		const controller = new AbortController();
		const stopping = defineTool({
			name: 'weather',
			description: 'The weather in a city',
			input: z.object({ city: z.string() }),
			risk: () => 'safe',
			execute: () => {
				controller.abort();
				return Promise.resolve('Sunny');
			},
		});
		const agent = new LLMAgent({
			llmClient: client(assistantResponse([madrid])),
			tools: [stopping],
			onTranscript,
		});

		await expect(
			agent.run('Weather in Madrid?', { signal: controller.signal }),
		).rejects.toMatchObject({ name: 'AbortError' });

		expect(received.map(transcript => transcript.outcome)).toEqual(['cancelled']);
	});

	it('hands over a copy, so changing it changes nothing the agent sends next', async () => {
		const llmClient = client(textResponse('Sunny.'), textResponse('Still sunny.'));
		const agent = new LLMAgent({
			llmClient,
			tools: [weather],
			onTranscript: ({ content }) => {
				const { tools, messages } = content as {
					tools: { inputSchema: Record<string, unknown> }[];
					messages: unknown[];
				};
				for (const tool of tools) tool.inputSchema.type = 'changed';
				messages.length = 0;
			},
		});

		await agent.run('Weather?', { signal });
		await agent.run('And now?', { signal });

		expect(llmClient.tools[1]?.[0]?.inputSchema).toMatchObject({ type: 'object' });
		expect(llmClient.contexts[1]).toHaveLength(3);
	});

	it('keeps the failure of a run whose transcript callback fails too', async () => {
		const warn = vi.fn();
		const agent = new LLMAgent({
			llmClient: client(assistantResponse([madrid])),
			tools: [weather],
			maxSteps: 1,
			logger: { warn },
			onTranscript: () => {
				throw new Error('disk full');
			},
		});

		await expect(agent.run('Weather?', { signal })).rejects.toMatchObject({
			cause: 'The model was still calling tools after 1 steps.',
		});
		expect(warn).toHaveBeenCalledWith("The run's transcript could not be handed over: disk full");
	});

	it('logs a transcript callback that fails, and keeps the run as it ended', async () => {
		const warn = vi.fn();
		const agent = new LLMAgent({
			llmClient: client(textResponse('Sunny.')),
			logger: { warn },
			onTranscript: () => Promise.reject(new Error('disk full')),
		});

		await expect(agent.run('Weather?', { signal })).resolves.toMatchObject({
			response: 'Sunny.',
		});
		expect(warn).toHaveBeenCalledWith("The run's transcript could not be handed over: disk full");
	});
});
