import type { Codex, Thread, ThreadItem, ThreadEvent, Usage } from '@openai/codex-sdk';
import {
	type Agent,
	type AgentResponse,
	type Callback,
	type ProgressEvent,
} from './models/agent.ts';
import { RecoverableError, UnrecoverableError } from './models/errors.ts';

type Model = 'gpt-5.6-sol' | 'gpt-5.6-luna';

interface StreamedTurn {
	events: AsyncGenerator<ThreadEvent>;
}

function convertEventToItem(event: ThreadEvent): ThreadItem | undefined {
	if (event.type === 'error')
		throw new UnrecoverableError('Codex stream error', { cause: event.message });

	if (event.type === 'turn.failed')
		throw new UnrecoverableError('Turn failed from codex sdk', { cause: event.error.message });

	if (event.type === 'item.completed') return event.item;

	return undefined;
}

function describeItem(item: ThreadItem): ProgressEvent | undefined {
	switch (item.type) {
		case 'agent_message':
			return { type: 'agentMessage', message: item.text };
		case 'reasoning':
			return { type: 'reasoning', message: item.text };
		case 'command_execution':
			return { type: 'command', command: item.command, exitCode: item.exit_code };
		case 'web_search':
			return { type: 'search', query: item.query };
		case 'file_change':
			return { type: 'fileChange', changes: item.changes };
		case 'mcp_tool_call': {
			if (item.error) {
				throw new RecoverableError('skill failed', { cause: item.error.message });
			}
			return { type: 'mcpTool', server: item.server, tool: item.tool, status: item.status };
		}
		case 'todo_list':
			return { type: 'todoList', items: item.items };
		case 'error':
			throw new RecoverableError('error while using the codex tools', { cause: item.message });
		default:
			console.warn(item, 'new type');
			return undefined;
	}
}

export class CodexAgent implements Agent {
	private thread: Thread;

	constructor({ sdk, model }: { sdk: Codex; model: Model }) {
		const thread = sdk.startThread({
			model,
			modelReasoningEffort: 'high',
		});

		this.thread = thread;
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		const response = await this.thread.runStreamed(prompt, { signal });
		return await this.parseResponse(response, callback);
	}

	private async parseResponse(
		turn: StreamedTurn,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		const lines: string[] = [];
		const start = Date.now();
		let usage: Usage | undefined = undefined;
		for await (const event of turn.events) {
			if (event.type === 'turn.completed') {
				usage = event.usage;
				continue;
			}

			const item = convertEventToItem(event);

			if (!item) continue;

			const description = describeItem(item);
			if (description) callback(description);
			if (description?.type === 'agentMessage') lines.push(description.message);
		}

		if (!lines.length || !usage) {
			return undefined;
		}

		return {
			response: lines.join('\n'),
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			duration: (Date.now() - start) / 1000,
		};
	}
}
