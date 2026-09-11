import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidAgentConfigError } from '../../src/agent/domain/errors.ts';
import {
	createAgent,
	createOrchestrator,
	isAgentProvider,
	type AgentProvider,
} from '../../src/factory/infrastructure/agentFactory.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({ Codex: vi.fn() }));

const signal = new AbortController().signal;

function createLogger() {
	return { warn: vi.fn(), error: vi.fn() };
}

function claudeStream(messages: unknown[]): Query {
	let index = 0;
	const iterator = {
		next: () =>
			Promise.resolve(
				index < messages.length
					? { done: false, value: messages[index++] }
					: { done: true, value: undefined },
			),
		[Symbol.asyncIterator]() {
			return this;
		},
	};

	return {
		close: vi.fn(),
		[Symbol.asyncIterator]() {
			return iterator;
		},
	} as unknown as Query;
}

function claudeResult(text: string): unknown {
	return {
		duration_ms: 1000,
		result: text,
		session_id: 'session-1',
		subtype: 'success',
		type: 'result',
		usage: { input_tokens: 1, output_tokens: 1 },
	};
}

/** Every Codex thread replies with `text`; returns the spy that records each thread's options. */
function codexReplying(text: string) {
	const thread = {
		runStreamed: vi.fn(() =>
			Promise.resolve({
				events: (async function* (): AsyncGenerator<ThreadEvent> {
					await Promise.resolve();
					yield { type: 'item.completed', item: { id: 'message', text, type: 'agent_message' } };
					yield {
						type: 'turn.completed',
						usage: {
							cached_input_tokens: 0,
							cache_write_input_tokens: 0,
							input_tokens: 1,
							output_tokens: 1,
							reasoning_output_tokens: 0,
						},
					};
				})(),
			}),
		),
	} as unknown as Thread;
	const startThread = vi.fn<(options: { model: string; modelReasoningEffort: string }) => Thread>(
		() => thread,
	);
	vi.mocked(Codex).mockImplementation(function () {
		return { startThread } as unknown as Codex;
	});

	return startThread;
}

function codexModels(startThread: ReturnType<typeof codexReplying>): string[] {
	return startThread.mock.calls.map(([options]) => options.model);
}

function codexEfforts(startThread: ReturnType<typeof codexReplying>): string[] {
	return startThread.mock.calls.map(([options]) => options.modelReasoningEffort);
}

function claudeModels(): unknown[] {
	return vi.mocked(query).mock.calls.map(([params]) => params.options?.model);
}

function claudeEfforts(): unknown[] {
	return vi.mocked(query).mock.calls.map(([params]) => params.options?.effort);
}

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe('isAgentProvider', () => {
	it.each([
		['claude', true],
		['codex', true],
		['astra', false],
	])('recognizes %s as a provider: %s', (value, expected) => {
		expect(isAgentProvider(value)).toBe(expected);
	});
});

describe('createAgent', () => {
	it('builds each provider with its default model', async () => {
		const startThread = codexReplying('hi');
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('hi')]));

		createAgent('codex', { logger: createLogger() });
		await createAgent('claude', { logger: createLogger() }).run('prompt', signal, vi.fn());

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol']);
		expect(claudeModels()).toEqual(['opus']);
	});

	it('passes the requested model and reasoning effort to the engine', () => {
		const startThread = codexReplying('hi');

		createAgent('codex', {
			model: 'gpt-6-astra',
			reasoningEffort: 'minimal',
			logger: createLogger(),
		});

		expect(startThread).toHaveBeenCalledWith({
			model: 'gpt-6-astra',
			modelReasoningEffort: 'minimal',
		});
	});

	it('rejects a model the provider does not support', () => {
		expect(() => createAgent('codex', { model: 'opus', logger: createLogger() })).toThrow(
			InvalidAgentConfigError,
		);
	});

	it('rejects an unknown provider coming from untyped input', () => {
		expect(() => createAgent('astra' as AgentProvider, { logger: createLogger() })).toThrow(
			InvalidAgentConfigError,
		);
	});

	it('retries a recoverable provider failure inside the agent it returns', async () => {
		vi.mocked(query)
			.mockImplementationOnce(() => {
				throw new Error('socket hang up');
			})
			.mockReturnValueOnce(claudeStream([claudeResult('recovered')]));
		const logger = createLogger();

		const response = await createAgent('claude', { logger }).run('prompt', signal, vi.fn());

		expect(response?.response).toBe('recovered');
		expect(query).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('warns on stderr through the default logger when none is given', async () => {
		const unknownMessage = { type: 'brand_new_message', session_id: 'session-1' };
		vi.mocked(query).mockReturnValue(claudeStream([unknownMessage, claudeResult('hi')]));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await createAgent('claude').run('prompt', signal, vi.fn());

		expect(warn).toHaveBeenCalledWith(unknownMessage, 'Unknown Claude message type');
	});
});

describe('createOrchestrator', () => {
	it('lets Codex plan and execute and Claude review by default', async () => {
		const startThread = codexReplying('done');
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('{"decision":"approved"}')]));

		await expect(
			createOrchestrator({ logger: createLogger() }).run('ship it', signal, vi.fn()),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
		expect(codexEfforts(startThread)).toEqual(['high', 'xhigh']);
		expect(claudeModels()).toEqual(['opus']);
		expect(claudeEfforts()).toEqual(['high']);
	});

	it('runs every role on Claude when asked to', async () => {
		vi.mocked(query)
			.mockReturnValueOnce(claudeStream([claudeResult('plan')]))
			.mockReturnValueOnce(claudeStream([claudeResult('implementation')]))
			.mockReturnValueOnce(claudeStream([claudeResult('{"decision":"approved"}')]));

		await expect(
			createOrchestrator({ provider: 'claude', logger: createLogger() }).run(
				'ship it',
				signal,
				vi.fn(),
			),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(claudeModels()).toEqual(['opus', 'sonnet', 'opus']);
		expect(claudeEfforts()).toEqual(['high', 'xhigh', 'high']);
		expect(Codex).not.toHaveBeenCalled();
	});

	it('runs every role on Codex when asked to', () => {
		const startThread = codexReplying('done');

		createOrchestrator({ provider: 'codex', logger: createLogger() });

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol']);
		expect(codexEfforts(startThread)).toEqual(['high', 'xhigh', 'high']);
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects an unknown provider coming from untyped input', () => {
		expect(() => createOrchestrator({ provider: 'astra' as AgentProvider })).toThrow(
			InvalidAgentConfigError,
		);
	});
});
