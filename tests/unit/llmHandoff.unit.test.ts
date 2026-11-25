import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import {
	type ConversationSnapshot,
	parseConversationSnapshot,
} from '../../src/llm/domain/conversationSnapshot.ts';
import { ClaudeLLMClient } from '../../src/llm/infrastructure/claudeLLMClient.ts';
import { OpenAILLMClient } from '../../src/llm/infrastructure/openAILLMClient.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import { toolCall, toolMessage, toolResult, userMessage } from '../support/fakeLlmClient.ts';
import { fakeClaudeSdk } from '../support/fakeClaudeSdk.ts';

// The error classes stay real: the clients classify failures by them.
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;
const logger = { warn: vi.fn() };

/** A Claude SDK that thinks, then answers with `text`. */
function claudeAnswering(text: string) {
	const create = vi.fn().mockResolvedValue({
		stop_reason: 'end_turn',
		stop_details: null,
		content: [
			{ type: 'thinking', thinking: 'Claude reasoning', signature: 'claude-only' },
			{ type: 'text', text, citations: null },
		],
		usage: {
			input_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
			output_tokens: 1,
		},
	});
	vi.mocked(Anthropic).mockImplementation(function () {
		return fakeClaudeSdk(create);
	});
	return create;
}

/** The reasoning item OpenAI answers with: its summary is shown, and the item is sent back whole. */
const openAIReasoning = {
	type: 'reasoning',
	id: 'rs-1',
	summary: [{ type: 'summary_text', text: 'OpenAI reasoning' }],
	encrypted_content: 'openai-only',
};

/** The compaction item OpenAI answers with when it compacts the context before its answer. */
const openAICompaction = { type: 'compaction', id: 'cmp-1', encrypted_content: 'compacted-only' };

/** The message item OpenAI answers `text` with. */
const openAIMessage = (text: string) => ({
	type: 'message',
	id: 'msg-1',
	role: 'assistant',
	status: 'completed',
	content: [{ type: 'output_text', text, annotations: [] }],
});

/** The call OpenAI makes to the `weather` tool for Madrid. */
const openAIWeatherCall = {
	type: 'function_call',
	id: 'fc-1',
	call_id: 'call_1',
	name: 'weather',
	arguments: '{"city":"Madrid"}',
	status: 'completed',
};

/** An OpenAI SDK whose successive calls answer with each of `outputs`, a list of items each. */
function openAIReplying(...outputs: unknown[][]) {
	const create = vi.fn();
	for (const output of outputs) {
		create.mockResolvedValueOnce({
			status: 'completed',
			incomplete_details: null,
			error: null,
			output,
			usage: {
				input_tokens: 1,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				output_tokens: 1,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: 2,
			},
		});
	}
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return create;
}

/** An OpenAI SDK that reasons, then answers with `text`. */
function openAIAnswering(text: string) {
	return openAIReplying([openAIReasoning, openAIMessage(text)]);
}

/** The conversation as a host keeps it: JSON on disk, read back before it is taken up. */
function storedAndReadBack(agent: LLMAgent): ConversationSnapshot {
	return parseConversationSnapshot(JSON.parse(JSON.stringify(agent.snapshot())));
}

// #23: a conversation is MiKode's, so any provider can carry on from what another one said.
// Private reasoning stays behind: the handoff is portable, not lossless.
describe('a conversation handed between providers', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('lets OpenAI answer from what Claude was told, without Claude reasoning', async () => {
		claudeAnswering('ok');
		const claude = new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger });
		const introduction = userMessage('My name is Miki.');
		const heard = await claude.send({ context: [introduction], tools: [] }, signal);
		const openAICreate = openAIAnswering('Your name is Miki.');

		const answer = await new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
			messages: [introduction, heard.message],
		}).run('What is my name?', { signal });

		expect(heard.message.content).toContainEqual({ type: 'reasoning', text: 'Claude reasoning' });
		expect(openAICreate).toHaveBeenCalledWith(
			expect.objectContaining({
				input: [
					{ role: 'user', content: 'My name is Miki.' },
					{ role: 'assistant', content: 'ok' },
					{ role: 'user', content: 'What is my name?' },
				],
			}),
			{ signal },
		);
		expect(answer.response).toBe('Your name is Miki.');
	});

	it('lets Claude answer from what OpenAI was told, without OpenAI reasoning', async () => {
		openAIAnswering('ok');
		const openAI = new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger });
		const introduction = userMessage('My name is Miki.');
		const heard = await openAI.send({ context: [introduction], tools: [] }, signal);
		const claudeCreate = claudeAnswering('Your name is Miki.');

		const answer = await new LLMAgent({
			llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
			messages: [introduction, heard.message],
		}).run('What is my name?', { signal });

		expect(heard.message.content).toContainEqual({ type: 'reasoning', text: 'OpenAI reasoning' });
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'My name is Miki.' }] },
					{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
					{ role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
				],
			}),
			{ signal },
		);
		expect(answer.response).toBe('Your name is Miki.');
	});

	// A tool round trip is semantic history too: the calls and their results cross with their IDs.
	it('lets Claude carry on from a tool round trip OpenAI made', async () => {
		const claudeCreate = claudeAnswering('It is sunny in Madrid.');

		await new LLMAgent({
			llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
			messages: [
				userMessage('Weather in Madrid?'),
				{
					role: 'assistant',
					content: [
						{ type: 'providerData', source: 'openai', data: { type: 'reasoning', id: 'rs-1' } },
						toolCall('call_1', 'weather', { city: 'Madrid' }),
					],
				},
				toolMessage(toolResult('call_1', 'weather', 'Sunny')),
				{ role: 'assistant', content: [{ type: 'text', text: 'Sunny.' }] },
			],
		}).run('Thanks!', { signal });

		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'Weather in Madrid?' }] },
					{
						role: 'assistant',
						content: [
							{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Madrid' } },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny', is_error: false },
						],
					},
					{ role: 'assistant', content: [{ type: 'text', text: 'Sunny.' }] },
					{ role: 'user', content: [{ type: 'text', text: 'Thanks!' }] },
				],
			}),
			{ signal },
		);
	});
});

// A saved conversation carries each provider's own items back to it, and no other provider's.
describe('a saved conversation carried on', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('sends OpenAI its reasoning item back as OpenAI wrote it', async () => {
		openAIAnswering('first answer');
		const first = new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
		});
		await first.run('first', { signal });
		const second = openAIAnswering('second answer');

		await new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
			snapshot: storedAndReadBack(first),
		}).run('second', { signal });

		expect(second).toHaveBeenCalledWith(
			expect.objectContaining({
				input: [
					{ role: 'user', content: 'first' },
					openAIReasoning,
					{ role: 'assistant', content: 'first answer' },
					{ role: 'user', content: 'second' },
				],
			}),
			{ signal },
		);
		// Byte for byte: the same keys, in the same order.
		expect(JSON.stringify(second.mock.calls[0]?.[0])).toContain(JSON.stringify(openAIReasoning));
	});

	it('sends OpenAI the compaction it wrote first, in place of the turns it replaced', async () => {
		openAIReplying([openAICompaction, openAIMessage('first answer')]);
		const first = new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
		});
		await first.run('first', { signal });
		const second = openAIAnswering('second answer');

		await new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
			snapshot: storedAndReadBack(first),
		}).run('second', { signal });

		expect(second).toHaveBeenCalledWith(
			expect.objectContaining({
				input: [
					openAICompaction,
					{ role: 'assistant', content: 'first answer' },
					{ role: 'user', content: 'second' },
				],
			}),
			{ signal },
		);
		expect(JSON.stringify(second.mock.calls[0]?.[0])).toContain(JSON.stringify(openAICompaction));
	});

	it('sends Claude its thinking block back with the signature Claude gave', async () => {
		claudeAnswering('first answer');
		const first = new LLMAgent({
			llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
		});
		await first.run('first', { signal });
		const second = claudeAnswering('second answer');

		await new LLMAgent({
			llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
			snapshot: storedAndReadBack(first),
		}).run('second', { signal });

		const thinking = { type: 'thinking', thinking: 'Claude reasoning', signature: 'claude-only' };
		expect(second).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'first' }] },
					{ role: 'assistant', content: [thinking, { type: 'text', text: 'first answer' }] },
					{ role: 'user', content: [{ type: 'text', text: 'second' }] },
				],
			}),
			{ signal },
		);
		expect(JSON.stringify(second.mock.calls[0]?.[0])).toContain(JSON.stringify(thinking));
	});

	it("sends Claude what OpenAI said, tool round trip included, and none of OpenAI's private items", async () => {
		const weather: Tool = {
			name: 'weather',
			description: 'The weather in a city',
			inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
			risk: () => 'safe',
			execute: () => Promise.resolve('Sunny'),
		};
		openAIReplying(
			[openAICompaction, openAIReasoning, openAIWeatherCall],
			[openAIMessage('It is sunny.')],
		);
		const saver = new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
			tools: [weather],
		});
		await saver.run('Weather in Madrid?', { signal });
		const claude = claudeAnswering('You are welcome.');

		await new LLMAgent({
			llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
			snapshot: storedAndReadBack(saver),
		}).run('Thanks!', { signal });

		expect(claude).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: [{ type: 'text', text: 'Weather in Madrid?' }] },
					{
						role: 'assistant',
						content: [
							{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Madrid' } },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny', is_error: false },
						],
					},
					{ role: 'assistant', content: [{ type: 'text', text: 'It is sunny.' }] },
					{ role: 'user', content: [{ type: 'text', text: 'Thanks!' }] },
				],
			}),
			{ signal },
		);
		expect(JSON.stringify(claude.mock.calls[0]?.[0])).not.toMatch(/openai-only|compacted-only/);
	});
});
