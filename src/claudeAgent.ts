import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
	Query,
	SDKAssistantMessage,
	SDKResultSuccess,
	SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentResponse, Callback, ProgressEvent } from './models/agent.ts';
import { RecoverableError } from './models/errors.ts';

type Model = 'sonnet' | 'opus' | 'haiku' | 'claude-fable-5';

interface PendingTool {
	name: string;
	input: Record<string, unknown>;
	server?: string;
}

interface ToolResultBlock {
	type: string;
	tool_use_id: string;
	is_error?: boolean;
	content?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function toolResultBlock(value: unknown): ToolResultBlock | undefined {
	const block = asRecord(value);
	if (!block || typeof block.type !== 'string' || typeof block.tool_use_id !== 'string') {
		return undefined;
	}

	return block as unknown as ToolResultBlock;
}

function toolResultId(value: unknown): string | undefined {
	return toolResultBlock(value)?.tool_use_id;
}

function fileChange(
	name: 'Edit' | 'Write',
	tool: PendingTool,
	output: unknown,
): ProgressEvent | undefined {
	const inputPath = stringValue(tool.input.file_path);
	const outputPath = stringValue(asRecord(output)?.filePath);
	const path = outputPath ?? inputPath;
	if (!path) return undefined;

	const kind =
		name === 'Write' && stringValue(asRecord(output)?.type) === 'create' ? 'add' : 'update';
	return { type: 'fileChange', changes: [{ path, kind }] };
}

function todoList(tool: PendingTool): ProgressEvent | undefined {
	if (!Array.isArray(tool.input.todos)) return undefined;

	const items = tool.input.todos.flatMap(todo => {
		const item = asRecord(todo);
		const text = stringValue(item?.content);
		const status = stringValue(item?.status);
		return text && status ? [{ text, completed: status === 'completed' }] : [];
	});

	return { type: 'todoList', items };
}

function mcpTool(tool: PendingTool, result: ToolResultBlock): ProgressEvent | undefined {
	const server = tool.server;
	const toolName = tool.name.startsWith('mcp__')
		? tool.name.slice('mcp__'.length).split('__').slice(1).join('__')
		: tool.name;
	if (!server || !toolName) return undefined;

	return {
		type: 'mcpTool',
		server,
		tool: toolName,
		status: result.is_error ? 'failed' : 'completed',
	};
}

function describeCompletedTool(
	tool: PendingTool,
	result: ToolResultBlock,
	output: unknown,
): ProgressEvent | undefined {
	if (tool.name === 'Bash') {
		const exitCode = asRecord(output)?.exitCode ?? asRecord(output)?.exit_code;
		return {
			type: 'command',
			command: stringValue(tool.input.command) ?? '',
			...(typeof exitCode === 'number' ? { exitCode } : {}),
		};
	}

	if (tool.name === 'WebSearch') {
		const query = stringValue(tool.input.query);
		return query ? { type: 'search', query } : undefined;
	}

	if (tool.name === 'Edit' || tool.name === 'Write') {
		return result.is_error ? undefined : fileChange(tool.name, tool, output);
	}

	if (tool.name === 'TodoWrite') {
		return result.is_error ? undefined : todoList(tool);
	}

	if (tool.name.startsWith('mcp__') || tool.server) {
		return mcpTool(tool, result);
	}

	return undefined;
}

export class ClaudeAgent implements Agent {
	private model: Model;
	private autoApprove: boolean;
	private sessionId?: string;

	constructor(model: Model, autoApprove = false) {
		this.model = model;
		this.autoApprove = autoApprove;
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		const stream = query({
			prompt,
			options: {
				model: this.model,
				maxTurns: 3,
				cwd: process.cwd(),
				resume: this.sessionId,
				...(this.autoApprove
					? {
							permissionMode: 'bypassPermissions' as const,
							allowDangerouslySkipPermissions: true,
						}
					: {}),
			},
		});

		signal.addEventListener('abort', () => {
			stream.close();
		});

		return await this.parseResponse(stream, callback);
	}

	private async parseResponse(
		stream: Query,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		const lines: string[] = [];
		let resultMessage: SDKResultSuccess | undefined;
		const pendingTools = new Map<string, PendingTool>();

		for await (const message of stream) {
			this.sessionId ??= message.session_id;

			switch (message.type) {
				case 'assistant':
					this.handleAssistantMessage(message, pendingTools, callback);
					break;
				case 'user':
					this.handleUserMessage(message, pendingTools, callback);
					break;
				case 'result':
					if (message.subtype === 'success') {
						lines.push(message.result);
						resultMessage = message;
					} else {
						throw new RecoverableError('Claude sdk error', {
							cause: [message.stop_reason, message.terminal_reason, ...message.errors].join(','),
						});
					}
					break;
			}
		}

		if (!lines.length || !resultMessage) {
			return undefined;
		}

		return {
			response: lines.join('\n'),
			inputTokens: resultMessage.usage.input_tokens,
			outputTokens: resultMessage.usage.output_tokens,
			duration: resultMessage.duration_ms / 1000,
		};
	}

	private handleAssistantMessage(
		message: SDKAssistantMessage,
		pendingTools: Map<string, PendingTool>,
		callback: Callback,
	): void {
		for (const block of message.message.content) {
			if (block.type === 'text') {
				callback({ type: 'agentMessage', message: block.text });
				continue;
			}

			if (block.type === 'thinking') {
				callback({ type: 'reasoning', message: block.thinking });
				continue;
			}

			if (
				block.type === 'tool_use' ||
				block.type === 'server_tool_use' ||
				block.type === 'mcp_tool_use'
			) {
				const input = asRecord(block.input);
				if (input) {
					pendingTools.set(block.id, {
						name: block.name === 'web_search' ? 'WebSearch' : block.name,
						input,
						...('server_name' in block && typeof block.server_name === 'string'
							? { server: block.server_name }
							: parseMcpServer(block.name)),
					});
				}
				continue;
			}

			this.handleCompletedTool(block, pendingTools, callback);
		}
	}

	private handleUserMessage(
		message: SDKUserMessage,
		pendingTools: Map<string, PendingTool>,
		callback: Callback,
	): void {
		if (!Array.isArray(message.message.content)) return;

		for (const block of message.message.content) {
			this.handleCompletedTool(block, pendingTools, callback, message.tool_use_result);
		}
	}

	private handleCompletedTool(
		block: unknown,
		pendingTools: Map<string, PendingTool>,
		callback: Callback,
		output?: unknown,
	): void {
		const id = toolResultId(block);
		if (!id) return;

		const tool = pendingTools.get(id);
		if (!tool) return;

		pendingTools.delete(id);
		const result = toolResultBlock(block);
		if (!result) return;

		const description = describeCompletedTool(tool, result, output ?? result.content);
		if (description) callback(description);
	}
}

function parseMcpServer(name: string): { server: string } | undefined {
	if (!name.startsWith('mcp__')) return undefined;

	const server = name.slice('mcp__'.length).split('__')[0];
	return server ? { server } : undefined;
}
