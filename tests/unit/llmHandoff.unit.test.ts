import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { ClaudeLLMClient } from '../../src/llm/infrastructure/claudeLLMClient.ts';
import { OpenAILLMClient } from '../../src/llm/infrastructure/openAILLMClient.ts';
import { userMessage } from '../support/fakeLlmClient.ts';

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
		return { messages: { create } } as unknown as Anthropic;
	});
	return create;
}

/** An OpenAI SDK that reasons, then answers with `text`. */
function openAIAnswering(text: string) {
	const create = vi.fn().mockResolvedValue({
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [
			{
				type: 'reasoning',
				id: 'rs-1',
				summary: [{ type: 'summary_text', text: 'OpenAI reasoning' }],
				encrypted_content: 'openai-only',
			},
			{
				type: 'message',
				id: 'msg-1',
				role: 'assistant',
				status: 'completed',
				content: [{ type: 'output_text', text, annotations: [] }],
			},
		],
		usage: {
			input_tokens: 1,
			input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			output_tokens: 1,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 2,
		},
	});
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return create;
}

// #23: a conversation is MiKode's, so any provider can carry on from what another one said.
// Private reasoning stays behind: the handoff is portable, not lossless.
describe('a conversation handed between providers', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('lets OpenAI answer from what Claude was told, without Claude reasoning', async () => {
		claudeAnswering('ok');
		const claude = new ClaudeLLMClient({ model: 'claude-sonnet-5', systemPrompt: '', logger });
		const introduction = userMessage('My name is Miki.');
		const heard = await claude.send({ context: [introduction], tools: [] }, signal);
		const openAICreate = openAIAnswering('Your name is Miki.');

		const answer = await new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
			messages: [introduction, heard.message],
		}).run('What is my name?', signal, vi.fn());

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
			llmClient: new ClaudeLLMClient({ model: 'claude-sonnet-5', systemPrompt: '', logger }),
			messages: [introduction, heard.message],
		}).run('What is my name?', signal, vi.fn());

		expect(heard.message.content).toContainEqual({ type: 'reasoning', text: 'OpenAI reasoning' });
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: [
					{ role: 'user', content: 'My name is Miki.' },
					{ role: 'assistant', content: 'ok' },
					{ role: 'user', content: 'What is my name?' },
				],
			}),
			{ signal },
		);
		expect(answer.response).toBe('Your name is Miki.');
	});
});
