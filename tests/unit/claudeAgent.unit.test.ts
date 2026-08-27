import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgent } from '../../src/claudeAgent.ts';
import type { ProgressEvent } from '../../src/models/agent.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

const sessionId = 'session-1';

function stream(messages: unknown[]): Query {
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

function assistant(content: unknown[]): unknown {
	return {
		type: 'assistant',
		message: { content },
		session_id: sessionId,
	};
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
	return { id, input, name, type: 'tool_use' };
}

function toolResult(id: string, toolUseResult?: unknown, isError = false): unknown {
	return {
		message: {
			content: [{ is_error: isError, tool_use_id: id, type: 'tool_result' }],
			role: 'user',
		},
		session_id: sessionId,
		tool_use_result: toolUseResult,
		type: 'user',
	};
}

function result(resultText = 'final answer'): Record<string, unknown> {
	return {
		duration_ms: 1250,
		result: resultText,
		session_id: sessionId,
		subtype: 'success',
		type: 'result',
		usage: { input_tokens: 11, output_tokens: 7 },
	};
}

describe('ClaudeAgent', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('normalizes assistant blocks and completed tool results in stream order', async () => {
		vi.mocked(query).mockReturnValue(
			stream([
				{ type: 'system', subtype: 'init', session_id: sessionId },
				assistant([
					{ text: 'hello', type: 'text' },
					{ thinking: 'considering', type: 'thinking' },
					toolUse('bash', 'Bash', { command: 'echo hello' }),
					{
						id: 'search',
						input: { query: 'Claude SDK' },
						name: 'web_search',
						type: 'server_tool_use',
					},
					toolUse('edit', 'Edit', { file_path: '/tmp/example.ts' }),
					toolUse('write', 'Write', { file_path: '/tmp/new.ts' }),
					toolUse('todos', 'TodoWrite', {
						todos: [
							{ content: 'Ship it', status: 'completed' },
							{ content: 'Review it', status: 'pending' },
						],
					}),
					{
						id: 'mcp',
						input: { value: 1 },
						name: 'lookup',
						server_name: 'catalog',
						type: 'mcp_tool_use',
					},
					toolUse('mcp-2', 'mcp__files__read', {}),
					{
						content: [],
						tool_use_id: 'search',
						type: 'web_search_tool_result',
					},
				]),
				toolResult('bash', { exitCode: 0 }),
				toolResult('edit', { filePath: '/tmp/example.ts' }),
				toolResult('write', { filePath: '/tmp/new.ts', type: 'create' }),
				toolResult('todos'),
				toolResult('mcp'),
				toolResult('mcp-2'),
				result(),
			]),
		);
		const events: ProgressEvent[] = [];

		const response = await new ClaudeAgent('sonnet').run(
			'prompt',
			new AbortController().signal,
			event => events.push(event),
		);

		expect(events).toEqual([
			{ type: 'agentMessage', message: 'hello' },
			{ type: 'reasoning', message: 'considering' },
			{ type: 'search', query: 'Claude SDK' },
			{ type: 'command', command: 'echo hello', exitCode: 0 },
			{ type: 'fileChange', changes: [{ path: '/tmp/example.ts', kind: 'update' }] },
			{ type: 'fileChange', changes: [{ path: '/tmp/new.ts', kind: 'add' }] },
			{
				type: 'todoList',
				items: [
					{ text: 'Ship it', completed: true },
					{ text: 'Review it', completed: false },
				],
			},
			{ type: 'mcpTool', server: 'catalog', tool: 'lookup', status: 'completed' },
			{ type: 'mcpTool', server: 'files', tool: 'read', status: 'completed' },
		]);
		expect(response).toEqual({
			response: 'final answer',
			inputTokens: 11,
			outputTokens: 7,
			duration: 1.25,
		});
	});

	it('ignores unsupported SDK messages without duplicating the final result', async () => {
		vi.mocked(query).mockReturnValue(
			stream([
				{ type: 'rate_limit_event', session_id: sessionId },
				assistant([{ text: 'visible progress', type: 'text' }]),
				result('visible progress'),
			]),
		);
		const callback = vi.fn();

		const response = await new ClaudeAgent('sonnet').run(
			'prompt',
			new AbortController().signal,
			callback,
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith({ type: 'agentMessage', message: 'visible progress' });
		expect(response?.response).toBe('visible progress');
	});

	it('preserves session continuity and result metadata', async () => {
		const secondSessionId = 'session-2';
		vi.mocked(query)
			.mockReturnValueOnce(stream([result('first')]))
			.mockReturnValueOnce(stream([{ ...result('second'), session_id: secondSessionId }]));
		const agent = new ClaudeAgent('sonnet', true, 'low');
		const signal = new AbortController().signal;
		const callback = vi.fn();

		await agent.run('first prompt', signal, callback);
		await agent.run('second prompt', signal, callback);

		expect(query).toHaveBeenNthCalledWith(2, {
			prompt: 'second prompt',
			options: {
				allowDangerouslySkipPermissions: true,
				cwd: process.cwd(),
				effort: 'low',
				maxTurns: 3,
				model: 'sonnet',
				permissionMode: 'bypassPermissions',
				resume: sessionId,
			},
		});
	});

	it('keeps permission checks enabled by default', async () => {
		vi.mocked(query).mockReturnValue(stream([result()]));

		await new ClaudeAgent('sonnet').run('prompt', new AbortController().signal, vi.fn());

		expect(query).toHaveBeenCalledWith({
			prompt: 'prompt',
			options: {
				cwd: process.cwd(),
				effort: 'high',
				maxTurns: 3,
				model: 'sonnet',
				resume: undefined,
			},
		});
	});

	it('turns a failed SDK result into a recoverable error', async () => {
		vi.mocked(query).mockReturnValue(
			stream([
				{
					errors: ['rate limited'],
					session_id: sessionId,
					stop_reason: 'error',
					subtype: 'error_during_execution',
					terminal_reason: 'temporary failure',
					type: 'result',
				},
			]),
		);

		await expect(
			new ClaudeAgent('sonnet').run('prompt', new AbortController().signal, vi.fn()),
		).rejects.toMatchObject({
			message: 'Claude sdk error',
			cause: 'error,temporary failure,rate limited',
		});
	});
});
