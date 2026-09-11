import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAgent } from '../../src/engines/codex/infrastructure/model/codexAgent.ts';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/agent/domain/errors.ts';

vi.mock('@openai/codex-sdk', () => ({ Codex: vi.fn() }));

function streamedTurn(events: ThreadEvent[]): { events: AsyncGenerator<ThreadEvent> } {
	return {
		events: (async function* () {
			for (const event of events) {
				await Promise.resolve();
				yield event;
			}
		})(),
	};
}

function completed(item: ThreadItem): ThreadEvent {
	return { type: 'item.completed', item };
}

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		cached_input_tokens: 2,
		cache_write_input_tokens: 1,
		input_tokens: 13,
		output_tokens: 8,
		reasoning_output_tokens: 3,
		...overrides,
	};
}

/** Makes the next `new Codex()` inside the agent return a fake SDK. */
function createSdk(events: ThreadEvent[] = []) {
	const runStreamed = vi.fn().mockImplementation(() => Promise.resolve(streamedTurn(events)));
	const thread = {
		runStreamed,
	} as unknown as Thread;
	const startThread = vi.fn().mockReturnValue(thread);
	vi.mocked(Codex).mockImplementation(function () {
		return { startThread } as unknown as Codex;
	});

	return { runStreamed, startThread };
}

function createLogger() {
	return { warn: vi.fn(), error: vi.fn() };
}

describe('CodexAgent', () => {
	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('configures one reusable thread and forwards each run input', async () => {
		const firstCallback = vi.fn();
		const secondCallback = vi.fn();
		const signal = new AbortController().signal;
		const { runStreamed, startThread } = createSdk([
			completed({ id: 'message-1', text: 'first', type: 'agent_message' }),
			{ type: 'turn.completed', usage: usage() },
		]);
		const agent = new CodexAgent({
			model: 'gpt-5.6-luna',
			logger: createLogger(),
			autoApprove: true,
			reasoningEffort: 'low',
		});

		await agent.run('first prompt', signal, firstCallback);
		await agent.run('second prompt', signal, secondCallback);

		expect(Codex).toHaveBeenCalledOnce();
		expect(startThread).toHaveBeenCalledOnce();
		expect(startThread).toHaveBeenCalledWith({
			approvalPolicy: 'never',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'low',
			sandboxMode: 'danger-full-access',
		});
		expect(runStreamed).toHaveBeenNthCalledWith(1, 'first prompt', { signal });
		expect(runStreamed).toHaveBeenNthCalledWith(2, 'second prompt', { signal });
		expect(firstCallback).toHaveBeenCalledWith({ type: 'agentMessage', message: 'first' });
		expect(secondCallback).toHaveBeenCalledWith({ type: 'agentMessage', message: 'first' });
	});

	it('keeps command execution restrictions enabled by default', () => {
		const { startThread } = createSdk();

		new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() });

		expect(startThread).toHaveBeenCalledWith({
			model: 'gpt-5.6-sol',
			modelReasoningEffort: 'high',
		});
	});

	it('maps supported completed items in stream order and aggregates agent messages', async () => {
		const events: ProgressEvent[] = [];
		createSdk([
			completed({ id: 'message-1', text: 'hello', type: 'agent_message' }),
			completed({ id: 'reasoning-1', text: 'thinking', type: 'reasoning' }),
			completed({
				aggregated_output: 'ok',
				command: 'echo hello',
				exit_code: 0,
				id: 'command-1',
				status: 'completed',
				type: 'command_execution',
			}),
			completed({ id: 'search-1', query: 'Codex SDK', type: 'web_search' }),
			completed({
				changes: [{ kind: 'update', path: '/tmp/example.ts' }],
				id: 'file-1',
				status: 'completed',
				type: 'file_change',
			}),
			completed({
				arguments: {},
				id: 'mcp-1',
				server: 'catalog',
				status: 'completed',
				tool: 'lookup',
				type: 'mcp_tool_call',
			}),
			completed({
				id: 'todo-1',
				items: [{ completed: true, text: 'Ship it' }],
				type: 'todo_list',
			}),
			completed({ id: 'message-2', text: 'goodbye', type: 'agent_message' }),
			{ type: 'turn.completed', usage: usage({ input_tokens: 21, output_tokens: 34 }) },
		]);
		const start = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_250);

		const response = await new CodexAgent({
			model: 'gpt-5.6-sol',
			logger: createLogger(),
		}).run('prompt', new AbortController().signal, event => events.push(event));

		expect(events).toEqual([
			{ type: 'agentMessage', message: 'hello' },
			{ type: 'reasoning', message: 'thinking' },
			{ type: 'command', command: 'echo hello', exitCode: 0 },
			{ type: 'search', query: 'Codex SDK' },
			{ type: 'fileChange', changes: [{ kind: 'update', path: '/tmp/example.ts' }] },
			{ type: 'mcpTool', server: 'catalog', tool: 'lookup', status: 'completed' },
			{ type: 'todoList', items: [{ completed: true, text: 'Ship it' }] },
			{ type: 'agentMessage', message: 'goodbye' },
		]);
		expect(response).toEqual({
			response: 'hello\ngoodbye',
			inputTokens: 21,
			outputTokens: 34,
			duration: 2.25,
		});
		expect(start).toHaveBeenCalledTimes(2);
	});

	it('logs and ignores a completed item of an unrecognized type', async () => {
		const unknownItem = { id: 'unknown-1', type: 'reasoning_summary' } as unknown as ThreadItem;
		createSdk([completed(unknownItem), { type: 'turn.completed', usage: usage() }]);
		const logger = createLogger();
		const events: ProgressEvent[] = [];

		await new CodexAgent({ model: 'gpt-5.6-sol', logger }).run(
			'prompt',
			new AbortController().signal,
			event => events.push(event),
		);

		expect(events).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(unknownItem, 'new type');
	});

	it.each([
		['a model from another provider', { model: 'opus' }, '"opus" is not a Codex model'],
		[
			'a reasoning effort Codex does not support',
			{ model: 'gpt-5.6-sol', reasoningEffort: 'max' },
			'"max" is not a Codex reasoning effort',
		],
	])('rejects %s before creating the SDK', (_case, options, message) => {
		const create = () => new CodexAgent({ ...options, logger: createLogger() });

		expect(create).toThrow(InvalidAgentConfigError);
		expect(create).toThrow(message);
		expect(Codex).not.toHaveBeenCalled();
	});

	it.each([
		['without an agent message', [{ type: 'turn.completed', usage: usage() }] as ThreadEvent[]],
		[
			'without completed usage',
			[completed({ id: 'message-1', text: 'partial', type: 'agent_message' })] as ThreadEvent[],
		],
	])('returns no response for an incomplete stream %s', async (_case, events) => {
		createSdk(events);

		await expect(
			new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() }).run(
				'prompt',
				new AbortController().signal,
				vi.fn(),
			),
		).resolves.toBeUndefined();
	});

	it.each([
		[
			'a failed MCP tool call',
			completed({
				arguments: {},
				error: { message: 'catalog unavailable' },
				id: 'mcp-1',
				server: 'catalog',
				status: 'failed',
				tool: 'lookup',
				type: 'mcp_tool_call',
			}),
			'skill failed',
			'catalog unavailable',
		],
		[
			'a failed Codex tool item',
			completed({ id: 'error-1', message: 'tool crashed', type: 'error' }),
			'error while using the codex tools',
			'tool crashed',
		],
	] as const)('raises a recoverable error for %s', async (_case, event, message, cause) => {
		createSdk([event]);

		await expect(
			new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() }).run(
				'prompt',
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toMatchObject({ message, cause });
	});

	it.each([
		[
			'a stream error',
			{ message: 'stream disconnected', type: 'error' },
			'Codex stream error',
			'stream disconnected',
		],
		[
			'a failed turn',
			{ error: { message: 'model failed' }, type: 'turn.failed' },
			'Turn failed from codex sdk',
			'model failed',
		],
	] as const)('raises an unrecoverable error for %s', async (_case, event, message, cause) => {
		createSdk([event]);

		await expect(
			new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() }).run(
				'prompt',
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toMatchObject({ message, cause });
	});

	// Regression: both boundaries let raw Errors escape, so RetryingAgent retried failures
	// it could not classify.
	describe('provider failures at the adapter boundary', () => {
		function failingStream(error: unknown) {
			return {
				events: (async function* (): AsyncGenerator<ThreadEvent> {
					await Promise.resolve();
					yield completed({ type: 'reasoning', text: 'thinking' } as ThreadItem);
					throw error;
				})(),
			};
		}

		/** The rejection itself, so a test can assert on its type and its cause. */
		async function rejectionOf(agent: CodexAgent, callback = vi.fn()): Promise<unknown> {
			let captured: unknown;
			let resolved = false;

			await agent.run('prompt', new AbortController().signal, callback).then(
				() => {
					resolved = true;
				},
				(error: unknown) => {
					captured = error;
				},
			);

			expect(resolved, 'expected the run to reject').toBe(false);

			return captured;
		}

		function createAgent() {
			return new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() });
		}

		it('classifies a request that the SDK rejects outright', async () => {
			const { runStreamed } = createSdk();
			runStreamed.mockRejectedValue(new Error('socket hang up'));

			const failure = await rejectionOf(createAgent());

			expect(failure).toBeInstanceOf(RecoverableError);
			expect(failure).toMatchObject({ cause: 'socket hang up' });
		});

		it('classifies a stream that fails part-way through a turn', async () => {
			const { runStreamed } = createSdk();
			runStreamed.mockResolvedValue(failingStream(new Error('connection reset')));

			const failure = await rejectionOf(createAgent());

			expect(failure).toBeInstanceOf(RecoverableError);
			expect(failure).toMatchObject({ cause: 'connection reset' });
		});

		it('lets cancellation through unchanged', async () => {
			const abort = new Error('The operation was aborted');
			abort.name = 'AbortError';
			const { runStreamed } = createSdk();
			runStreamed.mockRejectedValue(abort);

			const failure = await rejectionOf(createAgent());

			expect(failure).toBe(abort);
		});

		it('does not reclassify an error the adapter already classified', async () => {
			const { runStreamed } = createSdk();
			runStreamed.mockResolvedValue(
				streamedTurn([{ type: 'turn.failed', error: { message: 'quota exhausted' } }]),
			);

			const failure = await rejectionOf(createAgent());

			expect(failure).toBeInstanceOf(UnrecoverableError);
			expect(failure).toMatchObject({ cause: 'quota exhausted' });
		});

		it('reports a thread the SDK refuses to open as unrecoverable', () => {
			const { startThread } = createSdk();
			startThread.mockImplementation(() => {
				throw new Error('unknown model');
			});

			expect(() => createAgent()).toThrow(UnrecoverableError);
			expect(() => createAgent()).toThrow('Codex rejected the thread configuration');
		});

		it('reports an SDK that cannot be created as unrecoverable', () => {
			vi.mocked(Codex).mockImplementation(function () {
				throw new Error('codex binary not found');
			});

			expect(() => createAgent()).toThrow(UnrecoverableError);
		});
	});

	// Regression: the stream `try/catch` used to span the loop body too, so a throw from the
	// consumer callback or the logger came back as a RecoverableError and RetryingAgent
	// replayed a turn that had already run its commands and file writes.
	describe('host failures outside the provider boundary', () => {
		function agentWith(events: ThreadEvent[], logger = createLogger()) {
			createSdk(events);
			return new CodexAgent({ model: 'gpt-5.6-sol', logger });
		}

		async function rejectionOfRun(agent: CodexAgent, callback = vi.fn()): Promise<unknown> {
			return await agent
				.run('prompt', new AbortController().signal, callback)
				.then(() => undefined)
				.catch((error: unknown) => error);
		}

		it('classifies a throwing consumer callback as unrecoverable', async () => {
			const thrown = new Error('the renderer crashed');
			const callback = vi.fn(() => {
				throw thrown;
			});

			const failure = await rejectionOfRun(
				agentWith([completed({ id: 'message-1', text: 'hi', type: 'agent_message' })]),
				callback,
			);

			expect(failure).toBeInstanceOf(UnrecoverableError);
			expect(failure).toMatchObject({
				message: 'Codex progress callback failed',
				cause: 'the renderer crashed',
			});
		});

		it('classifies a throwing logger as unrecoverable', async () => {
			const thrown = new Error('the log sink is gone');
			const logger = createLogger();
			logger.warn.mockImplementation(() => {
				throw thrown;
			});

			const failure = await rejectionOfRun(
				agentWith([completed({ type: 'unheard_of' } as unknown as ThreadItem)], logger),
			);

			expect(failure).toBeInstanceOf(UnrecoverableError);
			expect(failure).toMatchObject({
				message: 'Codex logger failed while reporting progress',
				cause: 'the log sink is gone',
			});
		});

		it('classifies a stream that cannot create its iterator', async () => {
			const { runStreamed } = createSdk();
			runStreamed.mockResolvedValue({
				events: {
					[Symbol.asyncIterator]() {
						throw new Error('iterator initialization failed');
					},
				},
			});

			const failure = await rejectionOfRun(
				new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() }),
			);

			expect(failure).toBeInstanceOf(RecoverableError);
			expect(failure).toMatchObject({ cause: 'iterator initialization failed' });
		});

		it('preserves the classified stream failure when cleanup also fails', async () => {
			const { runStreamed } = createSdk();
			runStreamed.mockResolvedValue({
				events: {
					[Symbol.asyncIterator]() {
						return {
							next: () => Promise.reject(new Error('connection reset')),
							return: () => Promise.reject(new Error('cleanup failed')),
						};
					},
				},
			});

			const failure = await rejectionOfRun(
				new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() }),
			);

			expect(failure).toBeInstanceOf(RecoverableError);
			expect(failure).toMatchObject({ cause: 'connection reset' });
		});

		it('closes the provider stream when host code throws', async () => {
			let closed = false;
			const { runStreamed } = createSdk();
			runStreamed.mockResolvedValue({
				events: (async function* (): AsyncGenerator<ThreadEvent> {
					try {
						await Promise.resolve();
						yield completed({ id: 'message-1', text: 'hi', type: 'agent_message' });
					} finally {
						closed = true;
					}
				})(),
			});
			const agent = new CodexAgent({ model: 'gpt-5.6-sol', logger: createLogger() });

			await rejectionOfRun(
				agent,
				vi.fn(() => {
					throw new Error('the renderer crashed');
				}),
			);

			expect(closed).toBe(true);
		});
	});
});
