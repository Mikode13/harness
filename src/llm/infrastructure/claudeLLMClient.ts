import Anthropic, { AnthropicError, APIError } from '@anthropic-ai/sdk';
import type {
	ContentBlock,
	Message as AnthropicMessage,
	MessageParam,
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

// The Messages API takes full model IDs, not the Agent SDK's aliases, so this list is its own.
export const claudeLLMModels = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5'] as const;
export type ClaudeLLMModel = (typeof claudeLLMModels)[number];

// Adaptive thinking spends from this budget too. Above roughly 21,000 the SDK refuses a request
// that is not streamed, because it could outlast its ten-minute timeout.
const maxOutputTokens = 16_000;

// The request itself is wrong or not allowed, so sending it again cannot succeed.
const unrecoverableStatuses = [400, 401, 403, 404, 413, 422];

// The account is out of credit, or its key cannot make the request. Resending cannot fix
// either, whatever status the error arrives with.
const unrecoverableErrorTypes = ['billing_error', 'authentication_error', 'permission_error'];

/**
 * Only the text crosses back. A reasoning part stays in the conversation for narration and is
 * left out of the request: the API accepts a turn without its earlier thinking, even within a
 * turn that called a tool. A message with no text is left out whole; the API joins the
 * consecutive user turns that leaves.
 */
function toClaudeInput(message: Message): MessageParam[] {
	// Tool results only follow tool calls, and this client offers the model no tools yet.
	if (message.role === 'tool') {
		return [];
	}

	const text = message.content
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('\n');

	return text ? [{ role: message.role, content: text }] : [];
}

function describeBlock(block: ContentBlock, logger: ILogger): MessagePart[] {
	switch (block.type) {
		case 'text':
			return [{ type: 'text', text: block.text }];
		case 'thinking':
			// Summarized thinking; the signature only matters for replay, which is not done.
			return block.thinking ? [{ type: 'reasoning', text: block.thinking }] : [];
		case 'redacted_thinking':
			// Encrypted by design: there is nothing to narrate.
			return [];
		default:
			// No tools are sent yet, so any other block is output this client does not expect.
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
		case 'end_turn':
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
			// `tool_use`, `pause_turn` and `stop_sequence` need tools, server tools or stop
			// sequences, and this client sends none of them.
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
	private readonly model: ClaudeLLMModel;
	private readonly systemPrompt: string;
	private readonly logger: ILogger;

	// `model` is untyped on purpose: this adapter is the one that knows what Claude supports.
	constructor({
		model,
		systemPrompt,
		logger,
	}: {
		model: string;
		systemPrompt: string;
		logger: ILogger;
	}) {
		if (!isOneOf(claudeLLMModels, model)) {
			throw new InvalidAgentConfigError(
				`"${model}" is not a Claude API model; expected one of: ${claudeLLMModels.join(', ')}`,
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

		this.model = model;
		this.systemPrompt = systemPrompt;
		this.logger = logger;
	}

	async send(
		{ context, tools }: { context: Message[]; tools: ToolDefinition[] },
		signal: AbortSignal,
	): Promise<LLMResponse> {
		if (tools.length > 0) {
			// Ignoring them would leave an agent believing the model can call tools it never saw.
			throw new UnrecoverableError('The Claude client cannot offer tools to the model yet', {
				cause: `It was given ${String(tools.length)} tools.`,
			});
		}

		let response: AnthropicMessage;

		try {
			response = await this.client.messages.create(
				{
					model: this.model,
					max_tokens: maxOutputTokens,
					system: this.systemPrompt,
					messages: context.flatMap(toClaudeInput),
					thinking: { type: 'adaptive', display: 'summarized' },
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
