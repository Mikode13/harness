import Anthropic, { AnthropicError, APIError } from '@anthropic-ai/sdk';
import type {
	ContentBlock,
	ContentBlockParam,
	Message as AnthropicMessage,
	MessageParam,
	OutputConfig,
	RedactedThinkingBlockParam,
	ThinkingBlockParam,
	Tool as ClaudeTool,
	Usage,
} from '@anthropic-ai/sdk/resources/messages';
import {
	InvalidAgentConfigError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/agent/domain/errors';
import {
	classifyHostFailure,
	classifyLocalFailure,
	classifyProviderFailure,
	describeFailure,
	treatErrors,
} from '#src/agent/domain/providerFailure';
import { isOneOf } from '#src/shared/domain/isOneOf';
import type { ILogger } from '#src/shared/domain/logger';
import type { Tokens } from '#src/shared/domain/tokens';
import { MaxContextError } from '../domain/errors.ts';
import type { LLMClient, LLMResponse, StopReason } from '../domain/llm.ts';
import type { Message, MessagePart } from '../domain/message.ts';
import type { ToolDefinition } from '../domain/tool.ts';

// The Messages API takes full model IDs. Callers name a model by the Agent SDK's alias, so both
// paths share one vocabulary; this table pins the ID each alias means here, and moves by hand
// when Anthropic releases a newer model. Haiku is left out: it has no adaptive thinking.
export const claudeLLMModels = ['opus', 'fable', 'sonnet'] as const;
export type ClaudeLLMModel = (typeof claudeLLMModels)[number];

const claudeLLMModelIds = {
	opus: 'claude-opus-5-5',
	fable: 'claude-fable-5-1',
	sonnet: 'claude-sonnet-5',
} as const satisfies Record<ClaudeLLMModel, string>;

export const claudeLLMReasoningEfforts = [
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const satisfies readonly NonNullable<OutputConfig['effort']>[];
export type ClaudeLLMReasoningEffort = (typeof claudeLLMReasoningEfforts)[number];

// Adaptive thinking spends from this budget too. Above roughly 21,000 the SDK refuses a request
// that is not streamed, because it could outlast its ten-minute timeout.
const maxOutputTokens = 16_000;

// The request itself is wrong or not allowed, so sending it again cannot succeed.
const unrecoverableStatuses = [400, 401, 403, 404, 413, 422];

// The account is out of credit, or its key cannot make the request. Resending cannot fix
// either, whatever status the error arrives with.
const unrecoverableErrorTypes = ['billing_error', 'authentication_error', 'permission_error'];

// This client's label on the thinking blocks it keeps for replay; see `ProviderDataPart`.
const claudeSource = 'claude';

/**
 * Anthropic rejects a `tool_use` whose input is not an object, with a 400 on every later call.
 * Another provider's call can hold anything else, such as OpenAI arguments that did not parse;
 * its result already told the model the call failed, so sending it as empty loses nothing.
 */
function toClaudeInputObject(input: unknown): unknown {
	return typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {};
}

/** Thinking crosses back only as the signed block this client kept, never as its text. */
function toClaudeBlocks(part: MessagePart): ContentBlockParam[] {
	switch (part.type) {
		case 'text':
			// The API rejects an empty text block.
			return part.text ? [{ type: 'text', text: part.text }] : [];
		case 'toolCall':
			return [
				{ type: 'tool_use', id: part.id, name: part.name, input: toClaudeInputObject(part.input) },
			];
		case 'toolResult':
			return [
				{
					type: 'tool_result',
					tool_use_id: part.callId,
					content: part.output,
					is_error: part.isError,
				},
			];
		case 'providerData':
			// Another provider's block would be rejected; losing it only costs that provider's reasoning.
			return part.source === claudeSource
				? [part.data as ThinkingBlockParam | RedactedThinkingBlockParam]
				: [];
		case 'reasoning':
			// Unsigned text cannot be replayed as thinking. The API accepts a turn without it.
			return [];
	}
}

/**
 * Tool results travel in a user turn, as the API requires. A message left with no blocks is
 * left out whole; the API joins the consecutive user turns that leaves.
 */
function toClaudeInput(message: Message): MessageParam[] {
	const content = message.content.flatMap(toClaudeBlocks);
	if (content.length === 0) {
		return [];
	}

	return [{ role: message.role === 'tool' ? 'user' : message.role, content }];
}

/**
 * Strict: the API constrains the model to the schema, so its input always parses and matches.
 * A schema outside what strict mode supports fails the request with a 400.
 */
function toClaudeTool({ name, description, inputSchema }: ToolDefinition): ClaudeTool {
	return { name, description, input_schema: inputSchema, strict: true };
}

function describeBlock(block: ContentBlock, logger: ILogger): MessagePart[] {
	switch (block.type) {
		case 'text':
			return [{ type: 'text', text: block.text }];
		case 'thinking': {
			// Kept signed for replay; the summarized text is only for narration.
			const signed: ThinkingBlockParam = {
				type: 'thinking',
				thinking: block.thinking,
				signature: block.signature,
			};
			const replay: MessagePart = { type: 'providerData', source: claudeSource, data: signed };
			return block.thinking ? [{ type: 'reasoning', text: block.thinking }, replay] : [replay];
		}
		case 'redacted_thinking': {
			// Encrypted by design: nothing to narrate, but it still goes back.
			const redacted: RedactedThinkingBlockParam = { type: 'redacted_thinking', data: block.data };
			return [{ type: 'providerData', source: claudeSource, data: redacted }];
		}
		case 'tool_use':
			return [{ type: 'toolCall', id: block.id, name: block.name, input: block.input }];
		default:
			// Server tools are never offered, so any other block is output this client does not expect.
			treatErrors(
				() => {
					logger.warn(block, 'Claude returned a content block the client does not map');
				},
				classifyHostFailure,
				'Claude client logger failed while mapping a response',
			);
			return [];
	}
}

function toStopReason(response: AnthropicMessage): StopReason {
	switch (response.stop_reason) {
		// `tool_use` is a complete answer that asks for tools: running them is the agent's call.
		case 'end_turn':
		case 'tool_use':
			return 'completed';
		case 'max_tokens':
			return 'truncated';
		case 'refusal':
			return 'refused';
		case 'model_context_window_exceeded':
			throw new MaxContextError('The context no longer fits the Claude model', {
				cause: 'The response stopped at the model context window.',
			});
		default:
			// `pause_turn` and `stop_sequence` need server tools or stop sequences, and this
			// client sends neither.
			throw new UnrecoverableError('The Claude response stopped unexpectedly', {
				cause: `The response stopped with "${response.stop_reason ?? 'unknown'}".`,
			});
	}
}

/** Unlike OpenAI, Anthropic counts cache reads and writes apart from `input_tokens`. */
function toTokens(usage: Usage | undefined, logger: ILogger): Tokens | undefined {
	if (!usage) {
		// Zeros would report a call that may have been billed as free.
		treatErrors(
			() => {
				logger.warn('Claude returned a response without usage; it cannot be accounted for');
			},
			classifyHostFailure,
			'Claude client logger failed while reading usage',
		);
		return undefined;
	}

	return {
		inputTokens: usage.input_tokens,
		readCacheTokens: usage.cache_read_input_tokens ?? 0,
		writtenCacheTokens: usage.cache_creation_input_tokens ?? 0,
		outputTokens: usage.output_tokens,
	};
}

function toLLMResponse(response: AnthropicMessage, logger: ILogger): LLMResponse {
	let usage: Tokens | undefined;

	try {
		// Inside the try: it warns when the usage is missing, and that warning can throw too.
		usage = toTokens(response.usage, logger);
		return {
			message: {
				role: 'assistant',
				content: response.content.flatMap(block => describeBlock(block, logger)),
			},
			usage,
			stopReason: toStopReason(response),
		};
	} catch (error) {
		// The call was billed whether the response failed or a logger did while mapping it, and
		// an answer without usage leaves the run's count unknown.
		throw withSpentTokens(error, usage, !response.usage);
	}
}

/**
 * The SDK resolves credentials lazily, so a missing key surfaces on the first call, as a plain
 * `Error` the SDK gives no class of its own. An `AnthropicError` that is not an `APIError` never
 * carries an answer from the API: on this client's path it is the SDK refusing to make the
 * call, such as an unresolved profile or a request too large to send without streaming.
 */
function isLocalSDKFailure(error: unknown): boolean {
	return (
		(error instanceof AnthropicError && !(error instanceof APIError)) ||
		(error instanceof Error && error.message.startsWith('Could not resolve authentication method'))
	);
}

function classifyClaudeFailure(error: unknown): Error {
	if (isLocalSDKFailure(error)) {
		// The API never answered, and calling again would fail the same way.
		return new UnrecoverableError('The Claude client cannot send the request', {
			cause: describeFailure(error),
		});
	}
	if (error instanceof APIError) {
		// Anthropic gives an overlong prompt no code of its own, only a 400 with this message.
		if (error.status === 400 && error.message.includes('prompt is too long')) {
			return new MaxContextError('The context no longer fits the Claude model', {
				cause: describeFailure(error),
			});
		}
		if (
			unrecoverableErrorTypes.some(type => type === error.type) ||
			unrecoverableStatuses.some(status => status === error.status)
		) {
			return new UnrecoverableError('Claude rejected the request', {
				cause: describeFailure(error),
			});
		}
	}

	// A rate limit, an overload (529), a 5xx or a network failure: a later attempt can succeed.
	return classifyProviderFailure(error, 'The Claude request failed');
}

/**
 * A stateless `LLMClient` on the Anthropic Messages API, which keeps nothing between calls:
 * every call carries the whole context, so the conversation is MiKode's, not the provider's.
 */
export class ClaudeLLMClient implements LLMClient {
	private readonly client: Anthropic;
	private readonly model: (typeof claudeLLMModelIds)[ClaudeLLMModel];
	private readonly reasoningEffort: ClaudeLLMReasoningEffort;
	private readonly systemPrompt: string;
	private readonly logger: ILogger;

	// `model` and `reasoningEffort` are untyped on purpose: this adapter is the one that knows
	// what Claude supports.
	constructor({
		model,
		reasoningEffort = 'high',
		systemPrompt,
		logger,
	}: {
		model: string;
		reasoningEffort?: string;
		systemPrompt: string;
		logger: ILogger;
	}) {
		if (!isOneOf(claudeLLMModels, model)) {
			throw new InvalidAgentConfigError(
				`"${model}" is not a Claude API model; expected one of: ${claudeLLMModels.join(', ')}`,
			);
		}
		if (!isOneOf(claudeLLMReasoningEfforts, reasoningEffort)) {
			throw new InvalidAgentConfigError(
				`"${reasoningEffort}" is not a Claude API reasoning effort; expected one of: ${claudeLLMReasoningEfforts.join(', ')}`,
			);
		}

		try {
			// The SDK's default retries stay on, as OpenAI's do. See "The provider SDKs keep their
			// transport retries under RetryingAgent" in decisions.md.
			this.client = new Anthropic();
		} catch (error) {
			// Conflicting credential options, for example: building it again cannot fix them. A
			// missing key does not fail here but on the first call; see `isLocalSDKFailure`.
			throw new UnrecoverableError('The Claude client could not be set up', {
				cause: describeFailure(error),
			});
		}

		this.model = claudeLLMModelIds[model];
		this.reasoningEffort = reasoningEffort;
		this.systemPrompt = systemPrompt;
		this.logger = logger;
	}

	async send(
		{ context, tools }: { context: Message[]; tools: ToolDefinition[] },
		signal: AbortSignal,
	): Promise<LLMResponse> {
		let response: AnthropicMessage;

		try {
			response = await this.client.messages.create(
				{
					model: this.model,
					max_tokens: maxOutputTokens,
					system: this.systemPrompt,
					messages: context.flatMap(toClaudeInput),
					// Left out when empty, so a request without tools stays as it always was.
					...(tools.length > 0 && { tools: tools.map(toClaudeTool) }),
					thinking: { type: 'adaptive', display: 'summarized' },
					output_config: { effort: this.reasoningEffort },
					// Anthropic caches only on request. This marks the last block, so the next call
					// reads everything before it from the cache instead of paying for it again.
					cache_control: { type: 'ephemeral' },
				},
				{ signal },
			);
		} catch (error) {
			// The SDK's abort error is named 'Error', so it would pass for a provider failure.
			signal.throwIfAborted();
			throw classifyClaudeFailure(error);
		}

		return treatErrors(
			() => toLLMResponse(response, this.logger),
			classifyLocalFailure,
			'Claude response mapping failed',
		);
	}
}
