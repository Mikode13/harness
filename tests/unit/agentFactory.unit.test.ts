import Anthropic from '@anthropic-ai/sdk';
import type { Message as AnthropicMessage } from '@anthropic-ai/sdk/resources/messages';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';
import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { InvalidAgentConfigError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import {
	createAgent,
	createOrchestrator,
	isAgentProvider,
} from '../../src/factory/infrastructure/agentFactory.ts';
import {
	createFileTools,
	createLLMAgent,
	createLLMOrchestrator,
} from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { agentProviders, type AgentProvider } from '../../src/factory/infrastructure/types.ts';
import { defineTool } from '../../src/tools/infrastructure/defineTool.ts';
import type { WorkspaceOptions } from '../../src/tools/infrastructure/fileTools.ts';
import { createHistory } from '../../src/recovery/infrastructure/createHistory.ts';

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
		await createAgent('anthropic', { logger: createLogger() }).run('prompt', { signal });

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
				reasoning: { effort: 'high', summary: 'auto' },
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

	it('rejects a reasoning effort for haiku, which runs without thinking', () => {
		claudeAPIReplying('hi');

		expect(() =>
			createLLMAgent('anthropic', {
				model: 'haiku',
				reasoningEffort: 'high',
				systemPrompt: '',
				logger: createLogger(),
			}),
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
			createOrchestrator({ logger: createLogger() }).run('ship it', { signal }),
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
			createOrchestrator({ provider: 'anthropic', logger: createLogger() }).run('ship it', {
				signal,
			}),
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
			reasoning: { effort: 'high', summary: 'auto' },
		});
		expect(executor).toMatchObject({
			model: 'gpt-5.6-luna',
			reasoning: { effort: 'xhigh', summary: 'auto' },
		});
		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({ model: 'claude-opus-5-5', output_config: { effort: 'high' } }),
			{ signal },
		);
		expect(Codex).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	});

	it('gives the planner and reviewer the reading tools, and the executor its file tools', async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({ workspace, logger: createLogger() })
		).run('ship it', { signal });

		const reading = ['listFiles', 'searchText', 'readFile', 'showChanges'];
		expect(declared(requestsOf(openAICreate)[0])).toEqual(reading);
		expect(declared(requestsOf(openAICreate)[1])).toEqual([
			'listFiles',
			'searchText',
			'readFile',
			'apply_patch',
		]);
		expect(declared(requestsOf(claudeCreate)[0])).toEqual(reading);
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

		expect(declared(requestsOf(openAICreate)[1])).toEqual(['listFiles', 'searchText', 'readFile']);
	});

	it('gives every role its instructions as the system prompt, then the workspace', async () => {
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
			expect(prompt).toContain('AGENTS.md');
		}
		expect(JSON.stringify(planner?.input)).not.toContain('You are the planner agent');
	});

	it("uses a caller's own system prompt word for word, and keeps ours for the rest", async () => {
		const openAICreate = openAIReplying('plan');
		const claudeCreate = claudeAPIReplying('{"decision":"approved"}');

		await (
			await createLLMOrchestrator({
				workspace,
				systemPrompts: { reviewer: 'Review strictly.', executor: 'Change only tests.' },
				logger: createLogger(),
			})
		).run('ship it', { signal });

		expect(claudeCreate).toHaveBeenCalledWith(
			expect.objectContaining({ system: 'Review strictly.' }),
			{
				signal,
			},
		);
		expect(requestsOf(openAICreate)[1]).toMatchObject({ instructions: 'Change only tests.' });
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
			'claude-sonnet-5',
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

	it('rejects an unknown provider coming from untyped input', async () => {
		await expect(
			createLLMOrchestrator({ provider: 'astra' as AgentProvider, workspace }),
		).rejects.toThrow(InvalidAgentConfigError);
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
			]);
		}
		await expect(
			createFileTools('gemini' as AgentProvider, workspace, { logger: createLogger() }),
		).rejects.toThrow(InvalidAgentConfigError);
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
});
