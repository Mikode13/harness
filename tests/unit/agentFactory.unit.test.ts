import Anthropic from '@anthropic-ai/sdk';
import type { Message as AnthropicMessage } from '@anthropic-ai/sdk/resources/messages';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/agent/domain/errors.ts';
import {
	createAgent,
	createOrchestrator,
	isAgentProvider,
} from '../../src/factory/infrastructure/agentFactory.ts';
import {
	createLLMAgent,
	createLLMOrchestrator,
} from '../../src/factory/infrastructure/agentLLMFactory.ts';
import type { AgentProvider } from '../../src/factory/infrastructure/types.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({ Codex: vi.fn() }));
// The error classes stay real: the OpenAI client classifies failures by them.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;

function createLogger() {
	return { warn: vi.fn() };
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

/** Every OpenAI response answers `text`; returns the spy that records each request. */
function openAIReplying(text: string) {
	const create = vi.fn(() =>
		Promise.resolve({
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
		} as unknown as Response),
	);
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});

	return create;
}

function claudeAPIReplying(text: string) {
	const create = vi.fn(() =>
		Promise.resolve({
			stop_reason: 'end_turn',
			content: [{ type: 'text', text, citations: null }],
			usage: {
				input_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				output_tokens: 1,
			},
		} as unknown as AnthropicMessage),
	);
	vi.mocked(Anthropic).mockImplementation(function () {
		return { messages: { create } } as unknown as Anthropic;
	});

	return create;
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
		['anthropic', true],
		['openai', true],
		['claude', false],
		['codex', false],
	])('recognizes %s as a provider: %s', (value, expected) => {
		expect(isAgentProvider(value)).toBe(expected);
	});
});

describe('createAgent', () => {
	it('builds each provider with its default model', async () => {
		const startThread = codexReplying('hi');
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('hi')]));

		createAgent('openai', { logger: createLogger() });
		await createAgent('anthropic', { logger: createLogger() }).run('prompt', signal, vi.fn());

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol']);
		expect(claudeModels()).toEqual(['opus']);
	});

	it('passes the requested model and reasoning effort to the engine', () => {
		const startThread = codexReplying('hi');

		createAgent('openai', {
			model: 'gpt-6-astra',
			reasoningEffort: 'ultra',
			logger: createLogger(),
		});

		expect(startThread).toHaveBeenCalledWith({
			model: 'gpt-6-astra',
			modelReasoningEffort: 'ultra',
		});
	});

	it('keeps permission checks enabled unless autoApprove is requested', async () => {
		const startThread = codexReplying('hi');
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('hi')]));

		createAgent('openai', { logger: createLogger() });
		await createAgent('anthropic', { logger: createLogger() }).run('prompt', signal, vi.fn());

		expect(startThread.mock.calls[0]?.[0]).not.toHaveProperty('approvalPolicy');
		expect(vi.mocked(query).mock.calls[0]?.[0].options).not.toHaveProperty('permissionMode');
	});

	it('rejects a model the provider does not support', () => {
		expect(() => createAgent('openai', { model: 'opus', logger: createLogger() })).toThrow(
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

		const response = await createAgent('anthropic', { logger }).run('prompt', signal, vi.fn());

		expect(response.response).toBe('recovered');
		expect(query).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('warns on stderr through the default logger when none is given', async () => {
		const unknownMessage = { type: 'brand_new_message', session_id: 'session-1' };
		vi.mocked(query).mockReturnValue(claudeStream([unknownMessage, claudeResult('hi')]));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await createAgent('anthropic').run('prompt', signal, vi.fn());

		expect(warn).toHaveBeenCalledWith(unknownMessage, 'Unknown Claude message type');
	});
});

describe('createLLMAgent', () => {
	it('sends the system prompt with the default OpenAI model', async () => {
		const create = openAIReplying('hi');

		const response = await createLLMAgent('openai', {
			systemPrompt: 'Be brief.',
			logger: createLogger(),
		}).run('prompt', signal, vi.fn());

		expect(response.response).toBe('hi');
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'gpt-5.6-luna',
				instructions: 'Be brief.',
				reasoning: { effort: 'high', summary: 'auto' },
			}),
			{ signal },
		);
	});

	it('rejects a model the OpenAI client does not support', () => {
		openAIReplying('hi');

		expect(() =>
			createLLMAgent('openai', { model: 'opus', systemPrompt: '', logger: createLogger() }),
		).toThrow(InvalidAgentConfigError);
	});

	it('retries a recoverable provider failure inside the agent it returns', async () => {
		const create = openAIReplying('recovered');
		create.mockRejectedValueOnce(new Error('socket hang up'));
		const logger = createLogger();

		const response = await createLLMAgent('openai', { systemPrompt: '', logger }).run(
			'prompt',
			signal,
			vi.fn(),
		);

		expect(response.response).toBe('recovered');
		expect(create).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledOnce();
		// The retry resends the prompt alone: a note would stay in the conversation for good.
		expect(create).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ input: [{ role: 'user', content: 'prompt' }] }),
			{ signal },
		);
	});

	it('sends the system prompt with the default Claude model', async () => {
		const create = claudeAPIReplying('hi');

		const response = await createLLMAgent('anthropic', {
			systemPrompt: 'Be brief.',
			logger: createLogger(),
		}).run('prompt', signal, vi.fn());

		expect(response.response).toBe('hi');
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'claude-sonnet-5',
				system: 'Be brief.',
				output_config: { effort: 'high' },
			}),
			{ signal },
		);
	});

	it('rejects a model the Claude client does not support', () => {
		claudeAPIReplying('hi');

		expect(() =>
			createLLMAgent('anthropic', {
				model: 'gpt-5.6-luna',
				systemPrompt: '',
				logger: createLogger(),
			}),
		).toThrow(InvalidAgentConfigError);
	});

	it('sends the model and reasoning effort it is asked for, by the same names as createAgent', async () => {
		const openAICreate = openAIReplying('hi');
		const claudeCreate = claudeAPIReplying('hi');

		await createLLMAgent('openai', {
			model: 'gpt-5.6-sol',
			reasoningEffort: 'max',
			systemPrompt: '',
			logger: createLogger(),
		}).run('prompt', signal, vi.fn());
		await createLLMAgent('anthropic', {
			model: 'opus',
			reasoningEffort: 'low',
			systemPrompt: '',
			logger: createLogger(),
		}).run('prompt', signal, vi.fn());

		expect(openAICreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'gpt-5.6-sol',
				reasoning: { effort: 'max', summary: 'auto' },
			}),
			{ signal },
		);
		// The Messages API takes the full ID behind the alias.
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'claude-opus-5-5', output_config: { effort: 'low' } }),
			{ signal },
		);
	});

	it.each([
		['openai', 'ultra'],
		['anthropic', 'ultra'],
	] as const)('rejects a reasoning effort the %s client does not support', (provider, effort) => {
		openAIReplying('hi');
		claudeAPIReplying('hi');

		expect(() =>
			createLLMAgent(provider, {
				reasoningEffort: effort,
				systemPrompt: '',
				logger: createLogger(),
			}),
		).toThrow(InvalidAgentConfigError);
	});

	it('rejects haiku, which has no adaptive thinking on the Messages API', () => {
		claudeAPIReplying('hi');

		expect(() =>
			createLLMAgent('anthropic', { model: 'haiku', systemPrompt: '', logger: createLogger() }),
		).toThrow(InvalidAgentConfigError);
	});

	it('rejects an unknown provider', () => {
		expect(() =>
			createLLMAgent('gemini' as AgentProvider, { systemPrompt: '', logger: createLogger() }),
		).toThrow(InvalidAgentConfigError);
	});

	it('fails to build when the OpenAI client cannot be set up', () => {
		vi.mocked(OpenAI).mockImplementation(function () {
			throw new Error('The OPENAI_API_KEY environment variable is missing');
		});

		expect(() => createLLMAgent('openai', { systemPrompt: '', logger: createLogger() })).toThrow(
			UnrecoverableError,
		);
	});
});

describe('createOrchestrator', () => {
	it('lets OpenAI plan and execute and Anthropic review by default', async () => {
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

	it('runs every role on Anthropic when asked to', async () => {
		vi.mocked(query)
			.mockReturnValueOnce(claudeStream([claudeResult('plan')]))
			.mockReturnValueOnce(claudeStream([claudeResult('implementation')]))
			.mockReturnValueOnce(claudeStream([claudeResult('{"decision":"approved"}')]));

		await expect(
			createOrchestrator({ provider: 'anthropic', logger: createLogger() }).run(
				'ship it',
				signal,
				vi.fn(),
			),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(claudeModels()).toEqual(['opus', 'sonnet', 'opus']);
		expect(claudeEfforts()).toEqual(['high', 'xhigh', 'high']);
		// The Agent SDKs take no system prompt, so each role's instructions lead its prompt.
		expect(vi.mocked(query).mock.calls.map(([params]) => params.prompt)).toEqual([
			expect.stringMatching(/^You are the planner agent/),
			expect.stringMatching(/^You are the executor agent/),
			expect.stringMatching(/^You are the reviewer agent/),
		]);
		expect(Codex).not.toHaveBeenCalled();
	});

	it('runs every role on OpenAI when asked to', () => {
		const startThread = codexReplying('done');

		createOrchestrator({ provider: 'openai', logger: createLogger() });

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol']);
		expect(codexEfforts(startThread)).toEqual(['high', 'xhigh', 'high']);
		expect(query).not.toHaveBeenCalled();
	});

	it('passes autoApprove to every role', async () => {
		const startThread = codexReplying('done');
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('{"decision":"approved"}')]));

		await createOrchestrator({ autoApprove: true, logger: createLogger() }).run(
			'ship it',
			signal,
			vi.fn(),
		);

		expect(startThread.mock.calls).toEqual([
			[expect.objectContaining({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })],
			[expect.objectContaining({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })],
		]);
		expect(vi.mocked(query).mock.calls[0]?.[0].options).toMatchObject({
			permissionMode: 'bypassPermissions',
		});
	});

	it('rejects an unknown provider coming from untyped input', () => {
		expect(() => createOrchestrator({ provider: 'astra' as AgentProvider })).toThrow(
			InvalidAgentConfigError,
		);
	});
});

describe('createLLMOrchestrator', () => {
	it('plans and reviews on the model APIs and executes on the Agent SDK', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');
		const startThread = codexReplying('implementation');

		await expect(
			(await createLLMOrchestrator({ logger: createLogger() })).run('ship it', signal, vi.fn()),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(openAICreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'gpt-5.6-sol',
				reasoning: { effort: 'high', summary: 'auto' },
				instructions: expect.stringContaining('AGENTS.md') as unknown,
			}),
			{ signal },
		);
		expect(codexModels(startThread)).toEqual(['gpt-5.6-luna']);
		expect(codexEfforts(startThread)).toEqual(['xhigh']);
		expect(startThread.mock.calls[0]?.[0]).not.toHaveProperty('approvalPolicy');
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'claude-opus-5-5',
				output_config: { effort: 'high' },
				system: expect.stringContaining('AGENTS.md') as unknown,
			}),
			{ signal },
		);
		expect(query).not.toHaveBeenCalled();
	});

	it('gives the model-backed roles their instructions as the system prompt, with the tools', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');
		const startThread = codexReplying('implementation');

		await (await createLLMOrchestrator({ logger: createLogger() })).run('ship it', signal, vi.fn());

		const plannerRequest = openAICreate.mock.calls[0] as unknown as [
			{ instructions: string; input: unknown; tools: { name: string }[] },
		];
		expect(plannerRequest[0].instructions).toContain('You are the planner agent');
		expect(JSON.stringify(plannerRequest[0].input)).not.toContain('You are the planner agent');
		expect(plannerRequest[0].tools.map(tool => tool.name)).toEqual([
			'listFiles',
			'searchText',
			'readFile',
		]);
		const reviewerRequest = claudeCreate.mock.calls[0] as unknown as [
			{ system: string; messages: unknown; tools: unknown[] },
		];
		expect(reviewerRequest[0].system).toContain('You are the reviewer agent');
		expect(JSON.stringify(reviewerRequest[0].messages)).not.toContain('You are the reviewer agent');
		expect(reviewerRequest[0].tools).toHaveLength(3);
		// The executor's Agent SDK takes no system prompt, so its instructions lead the prompt.
		const { runStreamed } = startThread.mock.results[0]?.value as {
			runStreamed: ReturnType<typeof vi.fn>;
		};
		expect(runStreamed.mock.calls[0]?.[0]).toMatch(/^You are the executor agent/);
	});

	it('runs every role on Anthropic when asked to', async () => {
		const claudeCreate = claudeAPIReplying('plan');
		claudeCreate.mockResolvedValueOnce({
			stop_reason: 'end_turn',
			content: [{ type: 'text', text: 'plan', citations: null }],
			usage: {
				input_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				output_tokens: 1,
			},
		} as unknown as AnthropicMessage);
		claudeCreate.mockResolvedValueOnce({
			stop_reason: 'end_turn',
			content: [{ type: 'text', text: '{"decision":"approved"}', citations: null }],
			usage: {
				input_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				output_tokens: 1,
			},
		} as unknown as AnthropicMessage);
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('implementation')]));

		await expect(
			(await createLLMOrchestrator({ provider: 'anthropic', logger: createLogger() })).run(
				'ship it',
				signal,
				vi.fn(),
			),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(claudeCreate).toHaveBeenCalledTimes(2);
		expect(claudeModels()).toEqual(['sonnet']);
		expect(claudeEfforts()).toEqual(['xhigh']);
		expect(Codex).not.toHaveBeenCalled();
		expect(OpenAI).not.toHaveBeenCalled();
	});

	it('passes autoApprove to the executor alone', async () => {
		openAIReplying('plan');
		claudeAPIReplying('{"decision":"approved"}');
		const startThread = codexReplying('implementation');

		await createLLMOrchestrator({ autoApprove: true, logger: createLogger() });

		expect(startThread.mock.calls).toEqual([
			[expect.objectContaining({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })],
		]);
	});

	it('rejects an unknown provider coming from untyped input', async () => {
		await expect(createLLMOrchestrator({ provider: 'astra' as AgentProvider })).rejects.toThrow(
			InvalidAgentConfigError,
		);
	});
});
