import type { Codex, Thread, ThreadEvent, ThreadItem, Usage } from '@openai/codex-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAgent } from '../../src/codexAgent.ts';
import type { ProgressEvent } from '../../src/models/agent.ts';

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

function createSdk(events: ThreadEvent[] = []) {
	const runStreamed = vi.fn().mockImplementation(() => Promise.resolve(streamedTurn(events)));
	const thread = {
		runStreamed,
	} as unknown as Thread;
	const startThread = vi.fn().mockReturnValue(thread);
	const sdk = {
		startThread,
	} as unknown as Codex;

	return { runStreamed, sdk, startThread };
}

describe('CodexAgent', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('configures one reusable thread and forwards each run input', async () => {
		const firstCallback = vi.fn();
		const secondCallback = vi.fn();
		const signal = new AbortController().signal;
		const { runStreamed, sdk, startThread } = createSdk([
			completed({ id: 'message-1', text: 'first', type: 'agent_message' }),
			{ type: 'turn.completed', usage: usage() },
		]);
		const agent = new CodexAgent({ sdk, model: 'gpt-5.6-luna', autoApprove: true });

		await agent.run('first prompt', signal, firstCallback);
		await agent.run('second prompt', signal, secondCallback);

		expect(startThread).toHaveBeenCalledOnce();
		expect(startThread).toHaveBeenCalledWith({
			approvalPolicy: 'never',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'high',
			sandboxMode: 'danger-full-access',
		});
		expect(runStreamed).toHaveBeenNthCalledWith(1, 'first prompt', { signal });
		expect(runStreamed).toHaveBeenNthCalledWith(2, 'second prompt', { signal });
		expect(firstCallback).toHaveBeenCalledWith({ type: 'agentMessage', message: 'first' });
		expect(secondCallback).toHaveBeenCalledWith({ type: 'agentMessage', message: 'first' });
	});

	it('keeps command execution restrictions enabled by default', () => {
		const { sdk, startThread } = createSdk();

		new CodexAgent({ sdk, model: 'gpt-5.6-sol' });

		expect(startThread).toHaveBeenCalledWith({
			model: 'gpt-5.6-sol',
			modelReasoningEffort: 'high',
		});
	});

	it('maps supported completed items in stream order and aggregates agent messages', async () => {
		const events: ProgressEvent[] = [];
		const { sdk } = createSdk([
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

		const response = await new CodexAgent({ sdk, model: 'gpt-5.6-sol' }).run(
			'prompt',
			new AbortController().signal,
			event => events.push(event),
		);

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

	it.each([
		['without an agent message', [{ type: 'turn.completed', usage: usage() }] as ThreadEvent[]],
		[
			'without completed usage',
			[completed({ id: 'message-1', text: 'partial', type: 'agent_message' })] as ThreadEvent[],
		],
	])('returns no response for an incomplete stream %s', async (_case, events) => {
		const { sdk } = createSdk(events);

		await expect(
			new CodexAgent({ sdk, model: 'gpt-5.6-sol' }).run(
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
		const { sdk } = createSdk([event]);

		await expect(
			new CodexAgent({ sdk, model: 'gpt-5.6-sol' }).run(
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
		const { sdk } = createSdk([event]);

		await expect(
			new CodexAgent({ sdk, model: 'gpt-5.6-sol' }).run(
				'prompt',
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toMatchObject({ message, cause });
	});
});
