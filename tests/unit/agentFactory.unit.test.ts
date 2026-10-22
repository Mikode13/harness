import Anthropic from '@anthropic-ai/sdk';
import type { Message as AnthropicMessage } from '@anthropic-ai/sdk/resources/messages';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import {
	agentModels,
	agentReasoningEfforts,
	createAgent,
	createOrchestrator,
	isAgentProvider,
	isModelOf,
	isReasoningEffortOf,
} from '../../src/factory/infrastructure/agentFactory.ts';
import {
	createFileTools,
	createLLMAgent,
	createLLMOrchestrator,
	isLLMModelOf,
	isLLMReasoningEffortOf,
	llmModels,
	llmReasoningEfforts,
} from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { agentProviders, type AgentProvider } from '../../src/factory/infrastructure/types.ts';
import {
	claudeModels as claudeModelCatalog,
	claudeReasoningEfforts,
	type ClaudeModel,
	type ClaudeReasoningEffort,
} from '../../src/engines/claude/infrastructure/model/claudeAgent.ts';
import {
	codexModels as codexModelCatalog,
	codexReasoningEfforts,
	type CodexModel,
	type CodexReasoningEffort,
} from '../../src/engines/codex/infrastructure/model/codexAgent.ts';
import {
	claudeLLMModels,
	claudeLLMReasoningEfforts,
	type ClaudeLLMModel,
	type ClaudeLLMReasoningEffort,
} from '../../src/llm/infrastructure/claudeLLMClient.ts';
import {
	openAIModels,
	openAIReasoningEfforts,
	type OpenAIModel,
	type OpenAIReasoningEffort,
} from '../../src/llm/infrastructure/openAILLMClient.ts';
import { defineTool } from '../../src/tools/infrastructure/defineTool.ts';
import type { FileTool, WorkspaceOptions } from '../../src/tools/infrastructure/fileTools.ts';
import { RunContext, runContextOf } from '../../src/agent/domain/runContext.ts';
import type { Agent } from '../../src/agent/domain/agent.ts';
import { createWorkflow } from '../../src/factory/infrastructure/workflowFactory.ts';
import { defineWorkflowStages } from '../../src/workflow/domain/workflow.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { createHistory } from '../../src/recovery/infrastructure/createHistory.ts';
import { fakeClaudeSdk } from '../support/fakeClaudeSdk.ts';

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
		return fakeClaudeSdk(create);
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

describe('provider model and reasoning catalogs', () => {
	it('exposes each provider adapter catalog under the matching provider', () => {
		expect(agentModels.anthropic).toBe(claudeModelCatalog);
		expect(agentModels.openai).toBe(codexModelCatalog);
		expect(agentReasoningEfforts.anthropic).toBe(claudeReasoningEfforts);
		expect(agentReasoningEfforts.openai).toBe(codexReasoningEfforts);
		expect(llmModels.anthropic).toBe(claudeLLMModels);
		expect(llmModels.openai).toBe(openAIModels);
		expect(llmReasoningEfforts.anthropic).toBe(claudeLLMReasoningEfforts);
		expect(llmReasoningEfforts.openai).toBe(openAIReasoningEfforts);
	});

	it('accepts every value listed for its provider', () => {
		for (const provider of agentProviders) {
			for (const model of agentModels[provider]) {
				expect(isModelOf(provider, model)).toBe(true);
			}
			for (const effort of agentReasoningEfforts[provider]) {
				expect(isReasoningEffortOf(provider, effort)).toBe(true);
			}
			for (const model of llmModels[provider]) {
				expect(isLLMModelOf(provider, model)).toBe(true);
			}
			for (const effort of llmReasoningEfforts[provider]) {
				expect(isLLMReasoningEffortOf(provider, effort)).toBe(true);
			}
		}
	});

	it('rejects arbitrary and cross-provider values', () => {
		expect(isModelOf('anthropic', 'gpt-5.6-sol')).toBe(false);
		expect(isModelOf('openai', 'opus')).toBe(false);
		expect(isModelOf('anthropic', 'not-a-model')).toBe(false);
		expect(isLLMModelOf('anthropic', 'gpt-5.6-sol')).toBe(false);
		expect(isLLMModelOf('openai', 'opus')).toBe(false);
		expect(isLLMModelOf('openai', 'not-a-model')).toBe(false);
		expect(isReasoningEffortOf('anthropic', 'ultra')).toBe(false);
		expect(isReasoningEffortOf('openai', 'not-an-effort')).toBe(false);
		expect(isLLMReasoningEffortOf('openai', 'ultra')).toBe(false);
		expect(isLLMReasoningEffortOf('anthropic', 'not-an-effort')).toBe(false);
	});

	// Both paths take the same names, so one role table serves both. A model or an effort added
	// to one path only has to change this test on purpose.
	it.each(agentProviders)(
		'holds the same names on both paths for %s, but Codex ultra',
		provider => {
			expect([...llmModels[provider]].sort()).toEqual([...agentModels[provider]].sort());
			expect([...llmReasoningEfforts[provider]].sort()).toEqual(
				agentReasoningEfforts[provider].filter(effort => effort !== 'ultra').sort(),
			);
		},
	);

	it('keeps the Agent SDK and model API effort catalogs distinct', () => {
		expect(isReasoningEffortOf('openai', 'ultra')).toBe(true);
		expect(isLLMReasoningEffortOf('openai', 'ultra')).toBe(false);
	});

	it('narrows to the selected provider catalog at compile time', () => {
		const anthropicModel = 'model' as string;
		if (isModelOf('anthropic', anthropicModel)) {
			expectTypeOf(anthropicModel).toEqualTypeOf<ClaudeModel>();
		}
		const openAIModel = 'model' as string;
		if (isModelOf('openai', openAIModel)) {
			expectTypeOf(openAIModel).toEqualTypeOf<CodexModel>();
		}
		const anthropicEffort = 'effort' as string;
		if (isReasoningEffortOf('anthropic', anthropicEffort)) {
			expectTypeOf(anthropicEffort).toEqualTypeOf<ClaudeReasoningEffort>();
		}
		const openAIEffort = 'effort' as string;
		if (isReasoningEffortOf('openai', openAIEffort)) {
			expectTypeOf(openAIEffort).toEqualTypeOf<CodexReasoningEffort>();
		}
		const anthropicLLMModel = 'model' as string;
		if (isLLMModelOf('anthropic', anthropicLLMModel)) {
			expectTypeOf(anthropicLLMModel).toEqualTypeOf<ClaudeLLMModel>();
		}
		const openAILLMModel = 'model' as string;
		if (isLLMModelOf('openai', openAILLMModel)) {
			expectTypeOf(openAILLMModel).toEqualTypeOf<OpenAIModel>();
		}
		const anthropicLLMEffort = 'effort' as string;
		if (isLLMReasoningEffortOf('anthropic', anthropicLLMEffort)) {
			expectTypeOf(anthropicLLMEffort).toEqualTypeOf<ClaudeLLMReasoningEffort>();
		}
		const openAILLMEffort = 'effort' as string;
		if (isLLMReasoningEffortOf('openai', openAILLMEffort)) {
			expectTypeOf(openAILLMEffort).toEqualTypeOf<OpenAIReasoningEffort>();
		}
	});
});

describe('createAgent', () => {
	it('builds each provider with its default model', async () => {
		const startThread = codexReplying('hi');
		vi.mocked(query).mockReturnValue(claudeStream([claudeResult('hi')]));

		createAgent('openai', { logger: createLogger() });
		await createAgent('anthropic', { logger: createLogger() }).run('prompt', { signal });

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol']);
		expect(claudeModels()).toEqual(['claude-opus-5-5']);
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
		await createAgent('anthropic', { logger: createLogger() }).run('prompt', { signal });

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

		const response = await createAgent('anthropic', { logger }).run('prompt', { signal });

		expect(response.response).toBe('recovered');
		expect(query).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it('warns on stderr through the default logger when none is given', async () => {
		const unknownMessage = { type: 'brand_new_message', session_id: 'session-1' };
		vi.mocked(query).mockReturnValue(claudeStream([unknownMessage, claudeResult('hi')]));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await createAgent('anthropic').run('prompt', { signal });

		expect(warn).toHaveBeenCalledWith(unknownMessage, 'Unknown Claude message type');
	});
});

describe('createLLMAgent', () => {
	it('sends the system prompt with the default OpenAI model', async () => {
		const create = openAIReplying('hi');

		const response = await createLLMAgent('openai', {
			systemPrompt: 'Be brief.',
			logger: createLogger(),
		}).run('prompt', { signal });

		expect(response.response).toBe('hi');
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'gpt-5.6-luna',
				instructions: 'Be brief.',
				reasoning: { effort: 'high', summary: 'concise' },
			}),
			{ signal },
		);
	});

	it('has the provider compact at compactAt', async () => {
		const create = openAIReplying('hi');

		await createLLMAgent('openai', {
			systemPrompt: 'Be brief.',
			compactAt: 120_000,
			logger: createLogger(),
		}).run('prompt', { signal });

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				context_management: [{ type: 'compaction', compact_threshold: 120_000 }],
			}),
			{ signal },
		);
	});

	it.each([
		[true, 1],
		[false, 0],
	])(
		'runs a destructive call without asking only with autoApprove (%s)',
		async (autoApprove, runs) => {
			const create = openAIReplying('done');
			const answer = await create();
			create.mockClear();
			create.mockResolvedValueOnce({
				...answer,
				output: [
					{ type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'delete', arguments: '{}' },
				],
			} as unknown as Response);
			const execute = vi.fn(() => Promise.resolve('deleted'));
			const tool = defineTool({
				name: 'delete',
				description: '',
				input: z.object({}),
				risk: 'destructive',
				execute,
			});

			await createLLMAgent('openai', {
				systemPrompt: '',
				tools: [tool],
				autoApprove,
				logger: createLogger(),
			}).run('prompt', { signal });

			expect(execute).toHaveBeenCalledTimes(runs);
		},
	);

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

		const response = await createLLMAgent('openai', { systemPrompt: '', logger }).run('prompt', {
			signal,
		});

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
		}).run('prompt', { signal });

		expect(response.response).toBe('hi');
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'claude-sonnet-5-5',
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
		}).run('prompt', { signal });
		await createLLMAgent('anthropic', {
			model: 'opus',
			reasoningEffort: 'low',
			systemPrompt: '',
			logger: createLogger(),
		}).run('prompt', { signal });

		expect(openAICreate).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'gpt-5.6-sol',
				reasoning: { effort: 'max', summary: 'concise' },
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

	it('runs haiku, which names Claude Haiku 5.5, at the reasoning effort given', async () => {
		const create = claudeAPIReplying('hi');

		await createLLMAgent('anthropic', {
			model: 'haiku',
			reasoningEffort: 'xhigh',
			systemPrompt: '',
			logger: createLogger(),
		}).run('prompt', { signal });

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'claude-haiku-5-5', output_config: { effort: 'xhigh' } }),
			{ signal },
		);
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
			createOrchestrator({ logger: createLogger() }).run('ship it', { signal }),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(codexModels(startThread)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
		expect(codexEfforts(startThread)).toEqual(['high', 'xhigh']);
		expect(claudeModels()).toEqual(['claude-opus-5-5']);
		expect(claudeEfforts()).toEqual(['high']);
	});

	it('runs every role on Anthropic when asked to', async () => {
		vi.mocked(query)
			.mockReturnValueOnce(claudeStream([claudeResult('plan')]))
			.mockReturnValueOnce(claudeStream([claudeResult('implementation')]))
			.mockReturnValueOnce(claudeStream([claudeResult('{"decision":"approved"}')]));

		await expect(
			createOrchestrator({ provider: 'anthropic', logger: createLogger() }).run('ship it', {
				signal,
			}),
		).resolves.toMatchObject({ response: 'All job has finished' });

		expect(claudeModels()).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
		expect(claudeEfforts()).toEqual(['high', 'xhigh', 'high']);
		// The Agent SDKs take no system prompt, so each role's instructions lead its prompt.
		expect(vi.mocked(query).mock.calls.map(([params]) => params.prompt)).toEqual([
			expect.stringMatching(/^You are the planner agent/),
			expect.stringMatching(/^You are the executor agent/),
			expect.stringMatching(/^You are the reviewer agent/),
		]);
		expect(Codex).not.toHaveBeenCalled();
	});

	it("puts a caller's own instructions ahead of a role's prompt, and keeps ours for the rest", async () => {
		vi.mocked(query)
			.mockReturnValueOnce(claudeStream([claudeResult('plan')]))
			.mockReturnValueOnce(claudeStream([claudeResult('implementation')]))
			.mockReturnValueOnce(claudeStream([claudeResult('{"decision":"approved"}')]));

		await createOrchestrator({
			provider: 'anthropic',
			systemPrompts: { planner: 'Plan in one line.' },
			logger: createLogger(),
		}).run('ship it', { signal });

		expect(vi.mocked(query).mock.calls.map(([params]) => params.prompt)).toEqual([
			expect.stringMatching(/^Plan in one line\.\n\nOriginal user request:/),
			expect.stringMatching(/^You are the executor agent/),
			expect.stringMatching(/^You are the reviewer agent/),
		]);
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

		await createOrchestrator({ autoApprove: true, logger: createLogger() }).run('ship it', {
			signal,
		});

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

/** An OpenAI response whose one item creates `path` with `apply_patch`. */
function patchResponse(path: string): Response {
	return {
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [
			{
				type: 'apply_patch_call',
				id: 'apc-1',
				call_id: 'call-1',
				status: 'completed',
				operation: { type: 'create_file', path, diff: '+written by the executor\n' },
			},
		],
		usage: {
			input_tokens: 1,
			input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			output_tokens: 1,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 2,
		},
	} as unknown as Response;
}

describe('createLLMOrchestrator', () => {
	let parent: string;
	let repo: string;
	let workspace: WorkspaceOptions;

	beforeEach(() => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-factory-')));
		repo = join(parent, 'repo');
		mkdirSync(repo);
		execFileSync('git', ['init', '--quiet'], { cwd: repo });
		workspace = {
			roots: [{ path: repo, access: 'write' }],
			stateDirectory: join(parent, 'state'),
		};
	});

	afterEach(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	/** The request each call to a faked SDK client was made with, in order. */
	const requestsOf = (create: { mock: { calls: unknown[][] } }) =>
		create.mock.calls.map(call => call[0] as Record<string, unknown>);

	interface ToolDeclaration {
		name?: string;
		type?: string;
	}
	const declared = (request: unknown) =>
		((request as { tools?: ToolDeclaration[] }).tools ?? []).map(tool => tool.name ?? tool.type);

	it('plans, executes and reviews on the model APIs, none on an Agent SDK', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await expect(
			(await createLLMOrchestrator({ workspace, logger: createLogger() })).run('ship it', {
				signal,
			}),
		).resolves.toMatchObject({ response: 'All job has finished' });

		const [planner, executor] = requestsOf(openAICreate);
		expect(planner).toMatchObject({
			model: 'gpt-5.6-sol',
			reasoning: { effort: 'high', summary: 'concise' },
		});
		expect(executor).toMatchObject({
			model: 'gpt-5.6-luna',
			reasoning: { effort: 'xhigh', summary: 'concise' },
		});
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'claude-opus-5-5', output_config: { effort: 'high' } }),
			{ signal },
		);
		expect(Codex).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	});

	it('gives the planner and reviewer the reading tools and explore, and the executor its file tools', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({ workspace, logger: createLogger() })
		).run('ship it', { signal });

		const reading = ['listFiles', 'searchText', 'readFile', 'readFiles', 'showChanges', 'explore'];
		expect(declared(requestsOf(openAICreate)[0])).toEqual(reading);
		expect(declared(requestsOf(openAICreate)[1])).toEqual([
			'listFiles',
			'searchText',
			'readFile',
			'readFiles',
			'apply_patch',
		]);
		expect(declared(requestsOf(claudeCreate)[0])).toEqual(reading);
	});

	it('gives only the executor the configured commands', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');
		const commands = { test: { description: 'Runs the tests', executable: 'true' } };

		await (
			await createLLMOrchestrator({ workspace, commands, logger: createLogger() })
		).run('ship it', { signal });

		expect(declared(requestsOf(openAICreate)[0])).not.toContain('runCommand');
		expect(declared(requestsOf(openAICreate)[1])).toContain('runCommand');
		expect(declared(requestsOf(claudeCreate)[0])).not.toContain('runCommand');
	});

	it('gives each role the commands whose roles name it, the executor by default', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');
		const commands = {
			issue: { description: 'Shows an issue', executable: 'true', roles: ['planner' as const] },
			test: { description: 'Runs the tests', executable: 'true' },
		};

		await (
			await createLLMOrchestrator({ workspace, commands, logger: createLogger() })
		).run('ship it', { signal });

		const [planner, executor] = requestsOf(openAICreate);
		const runCommand = (request: unknown) =>
			((request as { tools?: { name?: string; description?: string }[] }).tools ?? []).find(
				tool => tool.name === 'runCommand',
			)?.description;
		expect(runCommand(planner)).toContain('- issue: Shows an issue');
		expect(runCommand(planner)).not.toContain('- test:');
		expect(runCommand(executor)).toContain('- test: Runs the tests');
		expect(runCommand(executor)).not.toContain('- issue:');
		expect(declared(requestsOf(claudeCreate)[0])).not.toContain('runCommand');
	});

	it('gives the executor only reading tools in a workspace with no write root', async () => {
		const openAICreate = openAIReplying('plan');
		claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({
				workspace: { ...workspace, roots: [{ path: repo, access: 'read' }] },
				logger: createLogger(),
			})
		).run('ship it', { signal });

		expect(declared(requestsOf(openAICreate)[1])).toEqual([
			'listFiles',
			'searchText',
			'readFile',
			'readFiles',
		]);
	});

	it('gives every role its instructions as the system prompt, then the workspace and its own guidance', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({ workspace, logger: createLogger() })
		).run('ship it', { signal });

		const [planner, executor] = requestsOf(openAICreate) as unknown as {
			instructions: string;
			input: unknown;
		}[];
		expect(planner?.instructions).toMatch(/^You are the planner agent/);
		expect(executor?.instructions).toMatch(/^You are the executor agent/);
		const reviewer = requestsOf(claudeCreate)[0] as unknown as { system: string };
		expect(reviewer.system).toMatch(/^You are the reviewer agent/);
		for (const prompt of [planner?.instructions, executor?.instructions, reviewer.system]) {
			expect(prompt).toContain(`The workspace:\n- ${repo}\n`);
		}
		// Only the planner learns the repository; the others work from its plan.
		expect(planner?.instructions).toContain('Start with AGENTS.md');
		expect(planner?.instructions).toContain('Name in the plan every file to change');
		expect(executor?.instructions).toContain('Work from the plan: read the files it names');
		expect(reviewer.system).toContain('Work from the plan and the changes');
		for (const prompt of [executor?.instructions, reviewer.system]) {
			expect(prompt).not.toContain('AGENTS.md');
		}
		expect(JSON.stringify(planner?.input)).not.toContain('You are the planner agent');
	});

	it.each([
		['without commands', undefined, /cannot run them/, /Nobody has run the tests/],
		[
			'with a command',
			{ test: { description: 'Runs the tests', executable: 'true' } },
			/finish only when they pass/,
			/do not run them yourself/,
		],
	] as const)(
		'tells the executor and the reviewer whether the tests are run, %s',
		async (_, commands, executorSays, reviewerSays) => {
			const openAICreate = openAIReplying('plan');
			const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

			await (
				await createLLMOrchestrator({
					workspace,
					...(commands === undefined ? {} : { commands }),
					logger: createLogger(),
				})
			).run('ship it', { signal });

			const executor = (requestsOf(openAICreate)[1] as unknown as { instructions: string })
				.instructions;
			const reviewer = (requestsOf(claudeCreate)[0] as unknown as { system: string }).system;
			expect(executor).toMatch(executorSays);
			expect(reviewer).toMatch(reviewerSays);
			// Each version leaves out the other's promise.
			expect(executor).not.toMatch(commands === undefined ? /finish only when/ : /cannot run/);
			expect(reviewer).not.toMatch(
				commands === undefined ? /do not run them yourself/ : /Nobody has run/,
			);
		},
	);

	it("uses a caller's own system prompt word for word, followed by the workspace, and keeps ours for the rest", async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({
				workspace,
				systemPrompts: { reviewer: 'Review strictly.', executor: 'Change only tests.' },
				logger: createLogger(),
			})
		).run('ship it', { signal });

		// Word for word, then the workspace, which the model needs to name a file; not our guidance.
		const reviewer = (requestsOf(claudeCreate)[0] as unknown as { system: string }).system;
		const executor = (requestsOf(openAICreate)[1] as unknown as { instructions: string })
			.instructions;
		expect(reviewer).toMatch(/^Review strictly\.\n\nThe workspace:\n/);
		expect(executor).toMatch(/^Change only tests\.\n\nThe workspace:\n/);
		for (const prompt of [reviewer, executor]) expect(prompt).not.toContain('AGENTS.md');
		expect(
			(requestsOf(openAICreate)[0] as unknown as { instructions: string }).instructions,
		).toMatch(/^You are the planner agent[\s\S]*AGENTS\.md/);
	});

	it('runs every role on Anthropic when asked to, the executor with the text editor', async () => {
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await expect(
			(
				await createLLMOrchestrator({ provider: 'anthropic', workspace, logger: createLogger() })
			).run('ship it', { signal }),
		).resolves.toMatchObject({ response: 'All job has finished' });

		const requests = requestsOf(claudeCreate);
		expect(requests.map(request => request.model)).toEqual([
			'claude-opus-5-5',
			'claude-haiku-5-5',
			'claude-opus-5-5',
		]);
		expect(requests[1]).toMatchObject({ output_config: { effort: 'xhigh' } });
		expect(declared(requests[1])).toEqual([
			'listFiles',
			'searchText',
			'str_replace_based_edit_tool',
			'delete_file',
		]);
		expect(OpenAI).not.toHaveBeenCalled();
	});

	it('records what the executor wrote as one run of the history, and names it', async () => {
		const patch = {
			type: 'apply_patch_call',
			id: 'apc-1',
			call_id: 'call-1',
			status: 'completed',
			operation: { type: 'create_file', path: 'notes.md', diff: '+written by the executor\n' },
		};
		const openAICreate = openAIReplying('plan');
		// The planner answers; the executor writes, then answers.
		openAICreate
			.mockImplementationOnce(openAICreate.getMockImplementation() as never)
			.mockImplementationOnce(() =>
				Promise.resolve({
					status: 'completed',
					incomplete_details: null,
					error: null,
					output: [patch],
					usage: {
						input_tokens: 1,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 2,
					},
				} as unknown as Response),
			);
		claudeAPIReplying('{"decision":"approved"}');

		const response = await (
			await createLLMOrchestrator({ workspace, logger: createLogger() })
		).run('write notes', { signal });

		expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('written by the executor\n');
		const history = await createHistory({ root: repo, stateDirectory: join(parent, 'state') });
		const { head, runs } = await history.list();
		expect(response.runId).toBe(head);
		expect(runs).toEqual([
			expect.objectContaining({ runId: head, files: ['notes.md'], status: 'completed' }),
		]);
	});

	it.each([
		['fails', 'failed'],
		['is cancelled', 'cancelled'],
	] as const)(
		'closes the run and frees the workspace when it %s after the executor wrote',
		async (_, status) => {
			const openAICreate = openAIReplying('plan');
			openAICreate
				.mockImplementationOnce(openAICreate.getMockImplementation() as never)
				.mockImplementationOnce(() => Promise.resolve(patchResponse('notes.md')));
			const controller = new AbortController();
			const claudeCreate = claudeAPIReplying('unused');
			claudeCreate.mockImplementation(() => {
				if (status === 'cancelled') {
					controller.abort();
					return Promise.reject(controller.signal.reason as Error);
				}
				return Promise.reject(new Error('the reviewer is down'));
			});

			await expect(
				(await createLLMOrchestrator({ workspace, logger: createLogger() })).run('write notes', {
					signal: controller.signal,
				}),
			).rejects.toThrow();

			const history = await createHistory({ root: repo, stateDirectory: join(parent, 'state') });
			expect((await history.list()).runs).toEqual([
				expect.objectContaining({ status, files: ['notes.md'] }),
			]);
			// The workspace is free: the run released it.
			await expect(history.undo()).resolves.toMatchObject({ complete: true });
		},
	);

	/**
	 * OpenAI answering the planner with a plan, then the executor with a new read on every call,
	 * so only the executor's step limit ends the run. Returns the spy that counts the calls.
	 */
	function executorThatNeverStops({ planFirst = true } = {}) {
		const create = openAIReplying('plan');
		let call = 0;
		if (planFirst) create.mockImplementationOnce(create.getMockImplementation() as never);
		create.mockImplementation(() =>
			Promise.resolve({
				status: 'completed',
				incomplete_details: null,
				error: null,
				output: [
					{
						type: 'function_call',
						id: `fc-${String(call)}`,
						call_id: `call-${String(call)}`,
						name: 'readFile',
						// A different file each time, so the loop stop never fires.
						arguments: JSON.stringify({
							path: `missing-${String(call++)}.ts`,
							fromLine: null,
							lineCount: null,
						}),
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
		return create;
	}

	it.each([
		['the executor 80 by default', undefined, 80],
		['every role the same number', 7, 7],
		['a role its own number, the rest their defaults', { executor: 5, planner: 2 }, 5],
	] as const)('gives %s', async (_, maxSteps, executorSteps) => {
		const openAICreate = executorThatNeverStops();
		claudeAPIReplying('{"decision":"approved"}');

		await expect(
			(
				await createLLMOrchestrator({
					workspace,
					logger: createLogger(),
					...(maxSteps === undefined ? {} : { maxSteps }),
				})
			).run('ship it', { signal }),
		).rejects.toThrow('The LLM did not finish within its step limit');

		// One call for the plan, then the executor's.
		expect(openAICreate).toHaveBeenCalledTimes(1 + executorSteps);
	});

	it.each([
		['65 by default', undefined, 65],
		['its own number', { planner: 3 }, 3],
		['the number every role gets', 4, 4],
	] as const)('gives the planner %s', async (_, maxSteps, plannerSteps) => {
		const openAICreate = executorThatNeverStops({ planFirst: false });

		await expect(
			(
				await createLLMOrchestrator({
					workspace,
					logger: createLogger(),
					...(maxSteps === undefined ? {} : { maxSteps }),
				})
			).run('ship it', { signal }),
		).rejects.toThrow('The LLM did not finish within its step limit');

		expect(openAICreate).toHaveBeenCalledTimes(plannerSteps);
	});

	it('refuses a step limit for a role that does not exist', async () => {
		await expect(
			createLLMOrchestrator({
				workspace,
				maxSteps: { exector: 100 } as never,
				logger: createLogger(),
			}),
		).rejects.toThrow('maxSteps names roles that do not exist: exector');
	});

	it.each([
		['null', null],
		['a list', [100]],
		['text', '100'],
	])('refuses a step limit that is %s, as untyped input can give', async (_, maxSteps) => {
		await expect(
			createLLMOrchestrator({
				workspace,
				maxSteps: maxSteps as never,
				logger: createLogger(),
			}),
		).rejects.toThrow(
			new InvalidAgentConfigError(
				'maxSteps must be a number or an object of steps per role, such as { "executor": 120 }',
			),
		);
	});

	it('has each role compact at its own compactAt, and no role without one', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({
				workspace,
				compactAt: { executor: 200_000, reviewer: 150_000 },
				logger: createLogger(),
			})
		).run('ship it', { signal });

		const [planner, executor] = requestsOf(openAICreate);
		expect(planner).not.toHaveProperty('context_management');
		expect(executor).toMatchObject({
			context_management: [{ type: 'compaction', compact_threshold: 200_000 }],
		});
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				context_management: {
					edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 150_000 } }],
				},
			}),
			{ signal },
		);
	});

	it('refuses a compaction for a role that does not exist', async () => {
		await expect(
			createLLMOrchestrator({
				workspace,
				compactAt: { exector: 200_000 } as never,
				logger: createLogger(),
			}),
		).rejects.toThrow('compactAt names roles that do not exist: exector');
	});

	it("refuses a compactAt the reviewer's provider cannot take", async () => {
		await expect(
			createLLMOrchestrator({ workspace, compactAt: 10_000, logger: createLogger() }),
		).rejects.toThrow(InvalidAgentConfigError);
	});

	it('rejects an unknown provider coming from untyped input', async () => {
		await expect(
			createLLMOrchestrator({ provider: 'astra' as AgentProvider, workspace }),
		).rejects.toThrow(InvalidAgentConfigError);
	});

	it('rejects an invalid formatter, or one with no write root to run in', async () => {
		await expect(
			createLLMOrchestrator({ workspace, formatter: { executable: '' } }),
		).rejects.toThrow('The formatter needs an executable');
		await expect(
			createLLMOrchestrator({
				workspace: { ...workspace, roots: [{ path: process.cwd(), access: 'read' }] },
				formatter: { executable: 'prettier' },
			}),
		).rejects.toThrow('The formatter needs a cwd inside a write root of the workspace');
	});
});

describe('createFileTools, and createLLMAgent over a workspace', () => {
	let parent: string;
	let repo: string;
	let workspace: WorkspaceOptions;

	beforeEach(() => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-file-tools-')));
		repo = join(parent, 'repo');
		mkdirSync(repo);
		execFileSync('git', ['init', '--quiet'], { cwd: repo });
		workspace = { roots: [{ path: repo, access: 'write' }], stateDirectory: join(parent, 'state') };
	});

	afterEach(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	it('gives each provider its own file tools, and only reading ones without a write root', async () => {
		const names = async (provider: AgentProvider, options: WorkspaceOptions) =>
			(await createFileTools(provider, options, { logger: createLogger() })).map(tool => tool.name);
		const readOnly = { ...workspace, roots: [{ path: repo, access: 'read' as const }] };

		await expect(names('openai', workspace)).resolves.toEqual([
			'listFiles',
			'searchText',
			'readFile',
			'readFiles',
			'apply_patch',
		]);
		await expect(names('anthropic', workspace)).resolves.toEqual([
			'listFiles',
			'searchText',
			'str_replace_based_edit_tool',
			'delete_file',
		]);
		for (const provider of agentProviders) {
			await expect(names(provider, readOnly)).resolves.toEqual([
				'listFiles',
				'searchText',
				'readFile',
				'readFiles',
			]);
		}
		await expect(
			createFileTools('gemini' as AgentProvider, workspace, { logger: createLogger() }),
		).rejects.toThrow(InvalidAgentConfigError);
	});

	it('adds runCommand with commands, which need a write root to run in', async () => {
		const commands = { test: { description: 'Runs the tests', executable: 'true' } };
		const tools = await createFileTools('openai', workspace, { commands, logger: createLogger() });

		expect(tools.map(tool => tool.name)).toEqual([
			'listFiles',
			'searchText',
			'readFile',
			'readFiles',
			'apply_patch',
			'runCommand',
		]);
		await expect(
			createFileTools(
				'openai',
				{ ...workspace, roots: [{ path: repo, access: 'read' }] },
				{ commands, logger: createLogger() },
			),
		).rejects.toThrow('Command "test" needs a cwd inside a write root of the workspace');
	});

	it('formats what an edit writes with formatter, which needs a write root to run in', async () => {
		const formatter = { executable: 'sh', args: ['-c', 'printf "formatted\\n" > "$1"', 'sh'] };
		const tools = await createFileTools('openai', workspace, { formatter, logger: createLogger() });
		const patch = tools.find(tool => tool.name === 'apply_patch') as unknown as PreparingTool;
		const run = new RunContext();

		const prepared = await patch.prepare(
			{ type: 'create_file', path: 'a.txt', diff: '+written' },
			signal,
			{
				run,
				reads: new ReadRegistry().begin(),
				callId: 'call',
				onProgress: () => undefined,
				spend: () => undefined,
				depth: 0,
			},
		);
		await prepared.run(signal);
		await run.finish('completed');

		expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('formatted\n');
		await expect(
			createFileTools(
				'openai',
				{ ...workspace, roots: [{ path: repo, access: 'read' }] },
				{ formatter, logger: createLogger() },
			),
		).rejects.toThrow('The formatter needs a cwd inside a write root of the workspace');
	});

	it('records two stages that write with file tools of their own as one run, each under its policy', async () => {
		mkdirSync(join(repo, 'config'));
		// The second stage reaches the same workspace and history through links.
		symlinkSync(repo, join(parent, 'repo-link'));
		symlinkSync(join(parent, 'state'), join(parent, 'state-link'));
		const logger = createLogger();
		const drafting = await createFileTools(
			'openai',
			{
				...workspace,
				roots: [
					{ path: repo, access: 'write' },
					{ path: join(repo, 'config'), access: 'read' },
				],
			},
			{ logger },
		);
		const finishing = await createFileTools(
			'openai',
			{
				roots: [{ path: join(parent, 'repo-link'), access: 'write' }],
				stateDirectory: join(parent, 'state-link'),
			},
			{ logger },
		);
		/** A stage whose model creates each of `paths` with `tools`, and reports what each did. */
		const writer = (tools: FileTool[], paths: string[]) => (): Agent => ({
			run: async (_prompt, options) => {
				const patch = tools.find(tool => tool.name === 'apply_patch') as unknown as PreparingTool;
				const results: string[] = [];
				for (const path of paths) {
					try {
						const prepared = await patch.prepare(
							{ type: 'create_file', path, diff: '+written' },
							signal,
							{
								run: runContextOf(options) ?? new RunContext(),
								reads: new ReadRegistry().begin(),
								callId: path,
								onProgress: () => undefined,
								spend: () => undefined,
								depth: 0,
							},
						);
						results.push(await prepared.run(signal));
					} catch (error) {
						results.push((error as Error).message);
					}
				}
				return { response: JSON.stringify(results), duration: 0 };
			},
		});
		const stage = defineWorkflowStages<{ draft: null; finish: null }, string[][]>();
		const outputs: string[][] = [];
		const asResults = { validate: (input: unknown) => input as string[] };
		const workflow = createWorkflow({
			initialStage: 'draft',
			stages: {
				draft: stage('draft', {
					agent: writer(drafting, ['a.txt', 'config/c.txt']),
					prompt: () => 'draft',
					validator: asResults,
					transition: output => {
						outputs.push(output);
						return { type: 'go', stage: 'finish', input: null };
					},
				}),
				finish: stage('finish', {
					agent: writer(finishing, ['b.txt']),
					prompt: () => 'finish',
					validator: asResults,
					transition: output => ({ type: 'complete', result: [...outputs, output] }),
				}),
			},
			logger,
		});

		const { result } = await workflow.run(null, { signal });

		expect(result).toEqual([
			['Created a.txt (1 line, 8 bytes).', expect.stringMatching(/config\/c\.txt/)],
			['Created b.txt (1 line, 8 bytes).'],
		]);
		// The first stage may not write config/, though the second stage may.
		expect(existsSync(join(repo, 'config', 'c.txt'))).toBe(false);
		const history = await createHistory({ root: repo, stateDirectory: join(parent, 'state') });
		const { runs } = await history.list();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.files).toEqual(['a.txt', 'b.txt']);
		await expect(history.undo()).resolves.toMatchObject({ complete: true });
		expect(existsSync(join(repo, 'a.txt'))).toBe(false);
		expect(existsSync(join(repo, 'b.txt'))).toBe(false);
	});

	it('refuses a workspace with no root when the agent is built', () => {
		expect(() =>
			createLLMAgent('openai', {
				systemPrompt: '',
				workspace: { roots: [] },
				logger: createLogger(),
			}),
		).toThrow(InvalidAgentConfigError);
	});

	it('tries the history again on the next run after it could not be opened', async () => {
		openAIReplying('done');
		const stateDirectory = join(parent, 'blocked');
		// A file where the folder should be: the history cannot be made.
		writeFileSync(stateDirectory, '');
		const agent = createLLMAgent('openai', {
			systemPrompt: '',
			workspace: { ...workspace, stateDirectory },
			logger: createLogger(),
		});
		await expect(agent.run('first', { signal })).rejects.toBeInstanceOf(UnrecoverableError);

		rmSync(stateDirectory);

		await expect(agent.run('second', { signal })).resolves.toMatchObject({ response: 'done' });
	});

	it('tells the model the workspace after its own system prompt', async () => {
		const create = openAIReplying('done');

		await createLLMAgent('openai', {
			systemPrompt: 'You fix bugs.',
			workspace,
			logger: createLogger(),
		}).run('fix it', { signal });

		expect((create.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
			instructions: expect.stringMatching(
				new RegExp(
					`^You fix bugs\\.\\n\\nThe workspace:\\n- ${repo}\\nName a file by its path relative to`,
				),
			) as unknown,
		});
	});

	it('follows what the history undoes, with a summary from the cheap model unless turned off', async () => {
		for (const summarizeUndone of [true, false]) {
			const create = openAIReplying('done');
			const patch = {
				type: 'apply_patch_call',
				id: 'apc-1',
				call_id: 'call-1',
				status: 'completed',
				operation: {
					type: 'create_file',
					path: `note-${String(summarizeUndone)}.md`,
					diff: '+hi\n',
				},
			};
			create.mockImplementationOnce(() =>
				Promise.resolve({
					status: 'completed',
					incomplete_details: null,
					error: null,
					output: [patch],
					usage: {
						input_tokens: 1,
						input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
						output_tokens: 1,
						output_tokens_details: { reasoning_tokens: 0 },
						total_tokens: 2,
					},
				} as unknown as Response),
			);
			const agent = createLLMAgent('openai', {
				systemPrompt: 'You write notes.',
				tools: await createFileTools('openai', workspace, { logger: createLogger() }),
				workspace,
				summarizeUndone,
				logger: createLogger(),
			});
			const { runId } = await agent.run('write a note', { signal });
			expect(runId).toEqual(expect.any(String));
			await (await createHistory({ root: repo, stateDirectory: join(parent, 'state') })).undo();

			await agent.run('try again', { signal });

			const requests = (create.mock.calls as unknown[][]).map(call => JSON.stringify(call[0]));
			const summaries = requests.filter(request => request.includes('The user undid the work'));
			expect(summaries).toHaveLength(summarizeUndone ? 1 : 0);
			if (summarizeUndone) {
				expect(JSON.parse(summaries[0] ?? '{}')).toMatchObject({
					model: 'gpt-5.6-luna',
					reasoning: { effort: 'high' },
				});
			}
			// Either way the model is told what was undone.
			expect(requests.at(-1)).toContain('Note from the harness');
		}
	});
	it('summarizes what was undone on Claude with Haiku 5.5 at high effort, as on OpenAI', async () => {
		const create = claudeAPIReplying('done');
		create.mockImplementationOnce(() =>
			Promise.resolve({
				stop_reason: 'tool_use',
				content: [
					{
						type: 'tool_use',
						id: 'toolu-1',
						name: 'str_replace_based_edit_tool',
						input: { command: 'create', path: 'note.md', file_text: 'hi\n' },
						caller: { type: 'direct' },
					},
				],
				usage: { input_tokens: 1, output_tokens: 1 },
			} as unknown as AnthropicMessage),
		);
		const agent = createLLMAgent('anthropic', {
			systemPrompt: 'You write notes.',
			tools: await createFileTools('anthropic', workspace, { logger: createLogger() }),
			workspace,
			logger: createLogger(),
		});
		await agent.run('write a note', { signal });
		await (await createHistory({ root: repo, stateDirectory: join(parent, 'state') })).undo();

		await agent.run('try again', { signal });

		const summary = (create.mock.calls as unknown[][])
			.map(call => call[0] as Record<string, unknown>)
			.find(request => JSON.stringify(request).includes('The user undid the work'));
		expect(summary).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'high' } });
	});
});
