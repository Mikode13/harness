import type {
	Codex,
	ModelReasoningEffort,
	Thread,
	ThreadEvent,
	ThreadItem,
	Usage,
} from '@openai/codex-sdk';
import {
	type Agent,
	type AgentResponse,
	type Callback,
	type ProgressEvent,
} from '../../../../agent/domain/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../../../agent/domain/errors.ts';
import {
	classifiedProviderStream,
	classifyProviderFailure,
	describeProviderFailure,
} from '../../../../agent/domain/providerFailure.ts';
import type { ILogger } from '../../../../shared/domain/logger.ts';

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

function describeItem(item: ThreadItem, logger: ILogger): ProgressEvent | undefined {
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
			logger.warn(item, 'new type');
			return undefined;
	}
}

export class CodexAgent implements Agent {
	private thread: Thread;
	private logger: ILogger;

	constructor({
		sdk,
		model,
		logger,
		autoApprove = false,
		reasoningEffort = 'high',
	}: {
		sdk: Codex;
		model: Model;
		logger: ILogger;
		autoApprove?: boolean;
		reasoningEffort?: ModelReasoningEffort;
	}) {
		try {
			this.thread = sdk.startThread({
				model,
				modelReasoningEffort: reasoningEffort,
				...(autoApprove
					? { approvalPolicy: 'never' as const, sandboxMode: 'danger-full-access' as const }
					: {}),
			});
		} catch (error) {
			// Not recoverable, unlike a request: a thread the SDK refused to open at all is
			// rejected configuration, and running the same constructor again cannot fix it.
			throw new UnrecoverableError('Codex rejected the thread configuration', {
				cause: describeProviderFailure(error),
			});
		}

		this.logger = logger;
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		let turn: StreamedTurn;

		try {
			turn = await this.thread.runStreamed(prompt, { signal });
		} catch (error) {
			throw classifyProviderFailure(error, 'Codex refused the request');
		}

		return await this.parseResponse(turn, callback);
	}

	private async parseResponse(
		turn: StreamedTurn,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		const lines: string[] = [];
		const start = Date.now();
		let usage: Usage | undefined = undefined;

		const events = classifiedProviderStream(turn.events, 'Codex stream ended unexpectedly');

		for await (const event of events) {
			if (event.type === 'turn.completed') {
				usage = event.usage;
				continue;
			}

			const item = convertEventToItem(event);

			if (!item) continue;

			const description = describeItem(item, this.logger);
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
