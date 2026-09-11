import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
	EffortLevel,
	Query,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultSuccess,
	SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
	Agent,
	AgentResponse,
	Callback,
	ProgressEvent,
} from '../../../../agent/domain/agent.ts';
import { InvalidAgentConfigError, RecoverableError } from '../../../../agent/domain/errors.ts';
import {
	classifiedProviderStream,
	classifyHostFailure,
	classifyLocalFailure,
	classifyProviderFailure,
	treatErrors,
} from '../../../../agent/domain/providerFailure.ts';
import type { ILogger } from '../../../../shared/domain/logger.ts';
import { isOneOf } from '../../../../shared/domain/isOneOf.ts';

// The SDK types `model` as a plain string, so this list is maintained by hand.
export const claudeModels = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ClaudeModel = (typeof claudeModels)[number];

export const claudeReasoningEfforts = [
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const satisfies readonly EffortLevel[];
export type ClaudeReasoningEffort = (typeof claudeReasoningEfforts)[number];

type SDKSystemMessage = Extract<SDKMessage, { type: 'system' }>;

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

function emitProgress(callback: Callback, event: ProgressEvent): void {
	try {
		callback(event);
	} catch (error) {
		throw classifyHostFailure(error, 'Claude progress callback failed');
	}
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

// Tools without narration (Read, Grep, Task, ...) are a presentation choice, not an unknown:
// the tool set is open-ended, so warning here would only produce noise.
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
	private model: ClaudeModel;
	private autoApprove: boolean;
	private reasoningEffort: ClaudeReasoningEffort;
	private sessionId?: string;
	private logger: ILogger;

	// `model` and `reasoningEffort` are untyped on purpose: this adapter is the one that knows
	// what Claude supports, so it validates them instead of trusting the caller.
	constructor({
		model,
		autoApprove = false,
		reasoningEffort = 'high',
		logger,
	}: {
		model: string;
		autoApprove?: boolean;
		reasoningEffort?: string;
		logger: ILogger;
	}) {
		if (!isOneOf(claudeModels, model)) {
			throw new InvalidAgentConfigError(
				`"${model}" is not a Claude model; expected one of: ${claudeModels.join(', ')}`,
			);
		}
		if (!isOneOf(claudeReasoningEfforts, reasoningEffort)) {
			throw new InvalidAgentConfigError(
				`"${reasoningEffort}" is not a Claude reasoning effort; expected one of: ${claudeReasoningEfforts.join(', ')}`,
			);
		}

		this.model = model;
		this.autoApprove = autoApprove;
		this.reasoningEffort = reasoningEffort;
		this.logger = logger;
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		let stream: Query;

		try {
			stream = query({
				prompt,
				options: {
					effort: this.reasoningEffort,
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
		} catch (error) {
			throw classifyProviderFailure(error, 'Claude refused the request');
		}

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

		const messages = classifiedProviderStream(stream, 'Claude stream ended unexpectedly');

		for await (const message of messages) {
			this.sessionId ??= message.session_id;

			try {
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
					case 'system':
						this.handleSystemMessage(message);
						break;
					// Known messages with nothing to narrate or report.
					case 'stream_event':
					case 'tool_progress':
					case 'tool_use_summary':
					case 'auth_status':
					case 'rate_limit_event':
					case 'prompt_suggestion':
					case 'conversation_reset':
						break;
					default: {
						// `never` breaks the build when an SDK upgrade adds a message type; the
						// warning covers a CLI binary that is newer than the types.
						const unknownMessage: never = message;
						this.warn(unknownMessage, 'Unknown Claude message type');
					}
				}
			} catch (error) {
				throw classifyLocalFailure(error, 'Claude failed while mapping progress');
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

	private handleSystemMessage(message: SDKSystemMessage): void {
		switch (message.subtype) {
			// Failures the SDK handled without failing the turn: only a warning makes them visible.
			case 'api_retry':
			case 'model_refusal_fallback':
			case 'model_refusal_no_fallback':
			case 'permission_denied':
			case 'mirror_error':
				this.warn(message, 'Claude reported a failure without failing the turn');
				return;
			// Known messages with nothing to narrate or report.
			case 'init':
			case 'compact_boundary':
			case 'status':
			case 'control_request_progress':
			case 'local_command_output':
			case 'hook_started':
			case 'hook_progress':
			case 'hook_response':
			case 'plugin_install':
			case 'task_notification':
			case 'task_started':
			case 'task_updated':
			case 'task_progress':
			case 'background_tasks_changed':
			case 'thinking_tokens':
			case 'session_state_changed':
			case 'worker_shutting_down':
			case 'commands_changed':
			case 'notification':
			case 'files_persisted':
			case 'memory_recall':
			case 'elicitation_complete':
			case 'informational':
				return;
			default: {
				const unknownMessage: never = message;
				this.warn(unknownMessage, 'Unknown Claude system message');
			}
		}
	}

	private handleAssistantMessage(
		message: SDKAssistantMessage,
		pendingTools: Map<string, PendingTool>,
		callback: Callback,
	): void {
		for (const block of message.message.content) {
			switch (block.type) {
				case 'text':
					emitProgress(callback, { type: 'agentMessage', message: block.text });
					break;
				case 'thinking':
					emitProgress(callback, { type: 'reasoning', message: block.thinking });
					break;
				case 'tool_use':
				case 'server_tool_use':
				case 'mcp_tool_use': {
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
					break;
				}
				case 'web_search_tool_result':
				case 'web_fetch_tool_result':
				case 'advisor_tool_result':
				case 'code_execution_tool_result':
				case 'bash_code_execution_tool_result':
				case 'text_editor_code_execution_tool_result':
				case 'tool_search_tool_result':
				case 'mcp_tool_result':
					this.handleCompletedTool(block, pendingTools, callback);
					break;
				// Known blocks with nothing to narrate.
				case 'redacted_thinking':
				case 'container_upload':
				case 'compaction':
				case 'fallback':
					break;
				default: {
					const unknownBlock: never = block;
					this.warn(unknownBlock, 'Unknown Claude content block');
				}
			}
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
		if (description) emitProgress(callback, description);
	}

	private warn(...args: unknown[]): void {
		treatErrors(
			() => {
				this.logger.warn(...args);
			},
			classifyHostFailure,
			'Claude logger failed while reporting progress',
		);
	}
}

function parseMcpServer(name: string): { server: string } | undefined {
	if (!name.startsWith('mcp__')) return undefined;

	const server = name.slice('mcp__'.length).split('__')[0];
	return server ? { server } : undefined;
}
