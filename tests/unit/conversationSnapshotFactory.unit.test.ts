import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { RunInProgressError } from '../../src/agent/domain/oneRunAtATime.ts';
import {
	type ConversationSnapshot,
	InvalidSnapshotError,
	UnsupportedSnapshotVersionError,
} from '../../src/agent/domain/snapshot.ts';
import { createLLMAgent } from '../../src/factory/infrastructure/agentLLMFactory.ts';
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

const usage = {
	input_tokens: 1,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
	output_tokens: 1,
};

/** A Claude answer that thinks, with a signature only Claude reads back, then says `text`. */
function claudeAnswer(text: string, signature = 'claude-only==') {
	return {
		stop_reason: 'end_turn',
		stop_details: null,
		content: [
			{ type: 'thinking', thinking: 'Claude reasoning', signature },
			{ type: 'text', text, citations: null },
		],
		usage,
	};
}

type Create = Mock<(params: unknown, options: unknown) => unknown>;

/** A Claude SDK whose requests `create` answers. */
function claudeSdk(create: Create): Create {
	vi.mocked(Anthropic).mockImplementation(function () {
		return fakeClaudeSdk(create);
	});
	return create;
}

function openAISdk(text: string) {
	const create = vi.fn().mockResolvedValue({
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [
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

/** What a request sent, as the bytes the provider would receive. */
function sentBody(create: Create, call: number): string {
	const params: unknown = create.mock.calls[call]?.[0];
	return JSON.stringify(params);
}

const options = { systemPrompt: 'You help.', logger, compactAt: false } as const;

afterEach(() => {
	vi.clearAllMocks();
});

describe('createLLMAgent restoring a snapshot', () => {
	it('sends Claude, byte for byte, what an agent that never stopped sends, its signed thinking included', async () => {
		const create = claudeSdk(
			vi
				.fn<(params: unknown, options: unknown) => unknown>()
				.mockResolvedValueOnce(claudeAnswer('Hello Miki.', 'sig/one+=='))
				.mockResolvedValue(claudeAnswer('You are Miki.')),
		);
		const agent = createLLMAgent('anthropic', options);
		await agent.run('My name is Miki.', { signal });
		const stored = JSON.stringify(agent.snapshot());
		await agent.run('Who am I?', { signal });

		const restored = createLLMAgent('anthropic', {
			...options,
			restore: JSON.parse(stored) as ConversationSnapshot,
		});
		await restored.run('Who am I?', { signal });

		expect(sentBody(create, 2)).toBe(sentBody(create, 1));
		expect(sentBody(create, 2)).toContain('sig/one+==');
	});

	it('hands a Claude conversation to OpenAI without its thinking, and keeps it for Claude', async () => {
		claudeSdk(
			vi
				.fn<(params: unknown, options: unknown) => unknown>()
				.mockResolvedValue(claudeAnswer('Hello Miki.', 'sig/one+==')),
		);
		const claude = createLLMAgent('anthropic', options);
		await claude.run('My name is Miki.', { signal });
		const openAICreate = openAISdk('You are Miki.');

		const openAI = createLLMAgent('openai', {
			...options,
			restore: JSON.parse(JSON.stringify(claude.snapshot())) as ConversationSnapshot,
		});
		await openAI.run('Who am I?', { signal });

		expect(openAICreate).toHaveBeenCalledWith(
			expect.objectContaining({
				input: [
					{ role: 'user', content: 'My name is Miki.' },
					{ role: 'assistant', content: 'Hello Miki.' },
					{ role: 'user', content: 'Who am I?' },
				],
			}),
			{ signal },
		);
		// Back to Claude, the thinking it signed is still there to send.
		expect(JSON.stringify(openAI.snapshot())).toContain('sig/one+==');
	});

	it('refuses a version it cannot restore before building or calling anything', () => {
		const create = claudeSdk(vi.fn());
		const later = {
			format: 'mikode-harness/conversation',
			version: 2,
		} as unknown as ConversationSnapshot;

		expect(() => createLLMAgent('anthropic', { ...options, restore: later })).toThrow(
			UnsupportedSnapshotVersionError,
		);
		expect(Anthropic).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it('refuses a malformed snapshot before building or calling anything', () => {
		const create = claudeSdk(vi.fn());
		const broken = {
			format: 'mikode-harness/conversation',
			version: 1,
			session: { id: 'calm-otter-1234' },
			initial: [],
			turns: [{ messages: [{ role: 'user', content: 'not parts' }] }],
			seenRevision: 0,
		} as unknown as ConversationSnapshot;

		expect(() => createLLMAgent('anthropic', { ...options, restore: broken })).toThrow(
			InvalidSnapshotError,
		);
		expect(Anthropic).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it('takes no snapshot while a run works, nor between two attempts of one run', async () => {
		let answer!: (message: unknown) => void;
		const between: unknown[] = [];
		const retryLogger = {
			// RetryingAgent reports the failed attempt between it and the next one.
			warn: vi.fn(() => {
				try {
					agent.snapshot();
				} catch (error) {
					between.push(error);
				}
			}),
		};
		claudeSdk(
			vi
				.fn<(params: unknown, options: unknown) => unknown>()
				// Unknown to the client, so classified as a passing failure, which is retried.
				.mockRejectedValueOnce(new Error('The connection dropped'))
				.mockImplementation(
					() =>
						new Promise(resolve => {
							answer = resolve;
						}),
				),
		);
		const agent = createLLMAgent('anthropic', { ...options, logger: retryLogger });
		const running = agent.run('Hello', { signal });
		await vi.waitFor(() => {
			expect(answer).toBeDefined();
		});

		expect(() => agent.snapshot()).toThrow(RunInProgressError);
		answer(claudeAnswer('Hi.'));
		await running;

		expect(between).toHaveLength(1);
		expect(between[0]).toBeInstanceOf(RunInProgressError);
		expect(agent.snapshot().turns).toHaveLength(1);
	});
});
