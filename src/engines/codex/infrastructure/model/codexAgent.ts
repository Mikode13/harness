import {
	Codex,
	type ModelReasoningEffort,
	type Thread,
	type ThreadEvent,
	type ThreadItem,
	type Usage,
} from '@openai/codex-sdk';
import {
	type Agent,
	type AgentResponse,
	type Callback,
	type ProgressEvent,
} from '#src/agent/domain/agent';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/agent/domain/errors';
import {
	classifiedProviderStream,
	classifyHostFailure,
	classifyLocalFailure,
	classifyProviderFailure,
	describeFailure,
	treatErrors,
} from '#src/agent/domain/providerFailure';
import type { ILogger } from '#src/shared/domain/logger';
import type { Tokens } from '#src/shared/domain/tokens';
import { isOneOf } from '#src/shared/domain/isOneOf';

// The SDK types `model` as a plain string, so this list is maintained by hand.
export const codexModels = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'] as const;
export type CodexModel = (typeof codexModels)[number];

// The efforts Codex's model catalog lists; the SDK also types 'minimal' and 'persistent', which
// none of the models above supports. `satisfies` only proves this is a subset of the SDK's type,
// so an SDK upgrade that adds an effort has to be reconciled here by hand.
export const codexReasoningEfforts = [
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
] as const satisfies readonly ModelReasoningEffort[];
export type CodexReasoningEffort = (typeof codexReasoningEfforts)[number];

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
			treatErrors(
				() => {
					logger.warn(item, 'new type');
				},
				classifyHostFailure,
				'Codex logger failed while reporting progress',
			);
			return undefined;
	}
}

// Codex counts cached tokens inside input_tokens; Tokens keeps them apart.
function toTokens(usage: Usage): Tokens {
	return {
		inputTokens: usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
		readCacheTokens: usage.cached_input_tokens,
		writtenCacheTokens: usage.cache_write_input_tokens,
		outputTokens: usage.output_tokens,
	};
}

export class CodexAgent implements Agent {
	private thread: Thread;
	private logger: ILogger;

	// `model` and `reasoningEffort` are untyped on purpose: this adapter is the one that knows
	// what Codex supports, so it validates them instead of trusting the caller.
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
		// Checked before the SDK is involved: an unsupported value is the caller's mistake, not
		// a configuration Codex rejected.
		if (!isOneOf(codexModels, model)) {
			throw new InvalidAgentConfigError(
				`"${model}" is not a Codex model; expected one of: ${codexModels.join(', ')}`,
			);
		}
		if (!isOneOf(codexReasoningEfforts, reasoningEffort)) {
			throw new InvalidAgentConfigError(
				`"${reasoningEffort}" is not a Codex reasoning effort; expected one of: ${codexReasoningEfforts.join(', ')}`,
			);
		}
		// The one per-model gap in Codex's catalog.
		if (model === 'gpt-5.6-luna' && reasoningEffort === 'ultra') {
			throw new InvalidAgentConfigError(
				'"gpt-5.6-luna" does not support the "ultra" reasoning effort',
			);
		}

		try {
			const sdk = new Codex();
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
				cause: describeFailure(error),
			});
		}

		this.logger = logger;
	}

	async run(prompt: string, signal: AbortSignal, callback: Callback): Promise<AgentResponse> {
		const start = Date.now();
		let turn: StreamedTurn;

		try {
			turn = await this.thread.runStreamed(prompt, { signal });
		} catch (error) {
			throw classifyProviderFailure(error, 'Codex refused the request');
		}

		return await this.parseResponse(turn, callback, start);
	}

	private async parseResponse(
		turn: StreamedTurn,
		callback: Callback,
		start: number,
	): Promise<AgentResponse> {
		const lines: string[] = [];
		let usage: Usage | undefined = undefined;

		// Once Codex produced an item, the provider answered: a failure after that without usage
		// leaves the run's count unknown, unlike one that never got an answer.
		let answered = false;

		try {
			const events = classifiedProviderStream(turn.events, 'Codex stream ended unexpectedly');

			for await (const event of events) {
				// A `turn.failed` alone may be a quota or authentication failure with no model work.
				if (event.type.startsWith('item.')) answered = true;
				if (event.type === 'turn.completed') {
					usage = event.usage;
					continue;
				}

				const item = convertEventToItem(event);

				if (!item) continue;

				let description: ProgressEvent | undefined;
				try {
					description = describeItem(item, this.logger);
				} catch (error) {
					throw classifyLocalFailure(error, 'Codex failed while mapping progress');
				}

				if (description) {
					try {
						callback(description);
					} catch (error) {
						throw classifyHostFailure(error, 'Codex progress callback failed');
					}
				}
				if (description?.type === 'agentMessage') lines.push(description.message);
			}

			if (!usage) {
				// The turn's work stands; only its accounting is missing.
				treatErrors(
					() => {
						this.logger.warn('Codex ended a turn without reporting usage');
					},
					classifyHostFailure,
					'Codex logger failed while reporting missing usage',
				);
			}
		} catch (error) {
			if (usage) throw withSpentTokens(error, toTokens(usage));
			throw answered ? withSpentTokens(error, undefined, true) : error;
		}

		return {
			// Empty when the turn only ran commands or edited files.
			response: lines.join('\n'),
			tokens: usage && toTokens(usage),
			duration: (Date.now() - start) / 1000,
		};
	}
}
