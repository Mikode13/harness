import type { Codex, Thread, ThreadItem, ThreadEvent } from '@openai/codex-sdk';
import type { Agent, AgentResult } from './agent.ts';

type Model = 'gpt-5.6-sol' | 'gpt-5.6-luna';

interface StreamedTurn {
	events: AsyncGenerator<ThreadEvent>;
}

function convertEventToItem(event: ThreadEvent): ThreadItem | undefined {
	if (event.type === 'error') throw new Error(event.message);
	if (event.type === 'turn.failed') throw new Error('Turn failed from codex sdk');

	if (event.type === 'item.completed') return event.item;

	return undefined;
}

function describeItem(item: ThreadItem): string | undefined {
	switch (item.type) {
		case 'agent_message':
			return item.text;
		case 'reasoning':
			return undefined;
		case 'command_execution':
			return `executing: ${item.command}`;
		case 'web_search':
			return `searching: ${item.query}`;
		case 'file_change':
			return item.changes.map(change => `${change.kind}: ${change.path}`).join('\n');
		case 'mcp_tool_call': {
			const status = item.error ? `failed: ${item.error.message}` : item.status;
			return `tool: ${item.server}/${item.tool} (${status})`;
		}
		case 'todo_list':
			return item.items.map(innerItem => innerItem.text).join('\n');
		case 'error':
			// TODO: add retry functionallity at the moment it will fail
			return `error: ${item.message}`;
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
	async run(prompt: string, signal: AbortSignal): Promise<AgentResult> {
		const response = await this.thread.runStreamed(prompt, { signal });
		return await this.parseResponse(response);
	}

	private async parseResponse(turn: StreamedTurn): Promise<AgentResult> {
		const lines: string[] = [];
		for await (const event of turn.events) {
			const item = convertEventToItem(event);

			if (!item) continue;

			const description = describeItem(item);
			if (description) lines.push(description);
		}

		if (!lines.length) {
			return undefined;
		}

		return lines.join('\n');
	}
}
