import type { Codex, Thread, ThreadItem, ThreadEvent, Usage } from '@openai/codex-sdk';
import type { Agent, AgentResponse } from './models/agent.ts';
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
			if (item.error) {
				throw new RecoverableError('skill failed', { cause: item.error.message });
			}
			return `tool: ${item.server}/${item.tool} (${item.status})`;
		}
		case 'todo_list':
			return item.items.map(innerItem => innerItem.text).join('\n');
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

	async run(prompt: string, signal: AbortSignal): Promise<AgentResponse | undefined> {
		const response = await this.thread.runStreamed(prompt, { signal });
		return await this.parseResponse(response);
	}

	private async parseResponse(turn: StreamedTurn): Promise<AgentResponse | undefined> {
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
			if (description) lines.push(description);
		}

		if (!lines.length || !usage) {
			return undefined;
		}

		return {
			response: lines.join('\n'),
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			duration: String((Date.now() - start) / 1000) + 's',
		};
	}
}
