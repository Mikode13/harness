import Anthropic, { AnthropicError, APIError } from '@anthropic-ai/sdk';
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
// The beta surface, for compaction: without its beta header, a request is the stable one.
import type {
	BetaCompactionBlockParam as CompactionBlockParam,
	BetaContentBlock as ContentBlock,
	BetaContentBlockParam as ContentBlockParam,
	BetaMessage as AnthropicMessage,
	BetaMessageParam as MessageParam,
	BetaOutputConfig as OutputConfig,
	BetaRedactedThinkingBlockParam as RedactedThinkingBlockParam,
	BetaThinkingBlockParam as ThinkingBlockParam,
	BetaTool as ClaudeTool,
	BetaToolTextEditor20250728 as ToolTextEditor20250728,
	BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
	InvalidAgentConfigError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/shared/domain/errors';
import {
	classifyHostFailure,
	classifyLocalFailure,
	classifyProviderFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import { isOneOf } from '#src/shared/domain/isOneOf';
import type { ILogger } from '#src/shared/domain/logger';
import type { Tokens } from '#src/shared/domain/tokens';
import { MaxContextError } from '../domain/errors.ts';
import type { LLMClient, LLMResponse, StopReason } from '../domain/llm.ts';
import { type Message, type MessagePart, sentContext } from '../domain/message.ts';
import { type NativeTool, nativeOf, type ToolDefinition } from '../domain/tool.ts';
import { claudeModelIds } from './claudeModelIds.ts';

// The Messages API takes full model IDs; `claudeModelIds` pins the one each alias names.
export const claudeLLMModels = [
	'opus',
	'fable',
	'sonnet',
	'haiku',
] as const satisfies readonly (keyof typeof claudeModelIds)[];
export type ClaudeLLMModel = (typeof claudeLLMModels)[number];

export const claudeLLMReasoningEfforts = [
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as const satisfies readonly NonNullable<OutputConfig['effort']>[];
export type ClaudeLLMReasoningEffort = (typeof claudeLLMReasoningEfforts)[number];

// Adaptive thinking spends from this budget too, so a hard step at a high effort can need most
// of it. The request is streamed so it is not bound by the SDK's ten-minute timeout, which made
// it refuse more than about 21,000 without a stream. Every model the aliases name writes up to
// 128,000; Haiku 5.5 at `xhigh` once spent 64,000 on one answer.
const maxOutputTokens = 128_000;

// The request itself is wrong or not allowed, so sending it again cannot succeed.
const unrecoverableStatuses = [400, 401, 403, 404, 413, 422];

// The account is out of credit, or its key cannot make the request. Resending cannot fix
// either, whatever status the error arrives with.
const unrecoverableErrorTypes = ['billing_error', 'authentication_error', 'permission_error'];

// This client's label on the thinking blocks it keeps for replay; see `ProviderDataPart`.
const claudeSource = 'claude';

// Anthropic's compaction at a token threshold, and the least threshold it accepts.
const compactionBeta = 'compact-2026-01-12';
const minCompactAt = 50_000;

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
		case 'compaction':
			// Another provider's summary means nothing here; this client sends the turns it replaced.
			return part.source === claudeSource ? [part.data as CompactionBlockParam] : [];
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

// Anthropic fixes the text editor's name: its calls arrive under it.
const textEditorName = 'str_replace_based_edit_tool';

/**
 * Strict: the API constrains the model to the schema, so its input always parses and matches.
 * A schema outside what strict mode supports fails the request with a 400. The native text
 * editor has Anthropic's own schema, and its calls and results are ordinary tool blocks.
 */
function toClaudeTool(definition: ToolDefinition): ClaudeTool | ToolTextEditor20250728 {
	const native = nativeOf(definition);
	if (native === 'textEditor') {
		if (definition.name !== textEditorName) {
			throw new InvalidAgentConfigError(
				`Claude's text editor must be named "${textEditorName}", not "${definition.name}"`,
			);
		}
		return { type: 'text_editor_20250728', name: textEditorName };
	}
	if (native !== undefined) {
		throw new InvalidAgentConfigError(`Claude has no native tool "${native}"`);
	}
	const { name, description, inputSchema } = definition;
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
		case 'compaction': {
			// A compaction that failed, with no summary. Claude reads one sent back as if it were not
			// there, so it is left out: the context goes on whole, and Claude compacts again later.
			if (!block.content) {
				treatErrors(
					() => {
						logger.warn(
							'Claude could not compact the conversation; it is sent whole until Claude compacts it',
						);
					},
					classifyHostFailure,
					'Claude client logger failed while mapping a response',
				);
				return [];
			}
			// Claude's summary of the context before it, readable, with what it alone reads back.
			const compaction: CompactionBlockParam = {
				type: 'compaction',
				content: block.content,
				encrypted_content: block.encrypted_content,
			};
			return [{ type: 'compaction', source: claudeSource, data: compaction }];
		}
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

/**
 * Unlike OpenAI, Anthropic counts cache reads and writes apart from `input_tokens`. A call that
 * compacted leaves the compaction out of its totals, so with iterations their sum is the bill.
 */
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

	if (usage.iterations && usage.iterations.length > 0) {
		return usage.iterations.reduce<Tokens>(
			(sum, iteration) => ({
				inputTokens: sum.inputTokens + iteration.input_tokens,
				readCacheTokens: sum.readCacheTokens + iteration.cache_read_input_tokens,
				writtenCacheTokens: sum.writtenCacheTokens + iteration.cache_creation_input_tokens,
				outputTokens: sum.outputTokens + iteration.output_tokens,
			}),
			{ inputTokens: 0, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 0 },
		);
	}
	return {
		inputTokens: usage.input_tokens,
		readCacheTokens: usage.cache_read_input_tokens ?? 0,
		writtenCacheTokens: usage.cache_creation_input_tokens ?? 0,
		outputTokens: usage.output_tokens,
	};
}

/**
 * How many tokens of context the call compacted, when it did: what its compaction iteration read,
 * since Anthropic bills a compaction as a call of its own over the context before it.
 */
function compactedContext(usage: Usage | undefined): { compactedContextTokens?: number } {
	const compaction = usage?.iterations?.find(iteration => iteration.type === 'compaction');
	if (!compaction) return {};
	return {
		compactedContextTokens:
			compaction.input_tokens +
			compaction.cache_read_input_tokens +
			compaction.cache_creation_input_tokens,
	};
}

/**
 * @param summaries each compaction's summary as it was streamed, by the index of its block. The
 * SDK joins a delta that carries none as the text "null", so the final message cannot tell.
 */
function toLLMResponse(
	response: AnthropicMessage,
	logger: ILogger,
	summaries: ReadonlyMap<number, string>,
): LLMResponse {
	let usage: Tokens | undefined;

	try {
		// Inside the try: it warns when the usage is missing, and that warning can throw too.
		usage = toTokens(response.usage, logger);
		return {
			message: {
				role: 'assistant',
				content: response.content.flatMap((block, index) => {
					const summary = summaries.get(index);
					return describeBlock(
						block.type === 'compaction' && summary !== undefined
							? { ...block, content: summary }
							: block,
						logger,
					);
				}),
			},
			usage,
			stopReason: toStopReason(response),
			...compactedContext(response.usage),
		};
	} catch (error) {
		// The call was billed whether the response failed or a logger did while mapping it, and
		// an answer without usage leaves the run's count unknown.
		throw withSpentTokens(error, usage, !response.usage);
	}
}

/**
 * The SDK resolves credentials lazily, so a missing key surfaces on the first call, as a plain
 * `Error` the SDK gives no class of its own. Before the stream connects, an `AnthropicError` that
 * is not an `APIError` never carries an answer from the API: it is the SDK refusing to make the
 * call, such as an unresolved profile. Once it connects, the stream reports any failure as one,
 * such as a connection lost halfway; see `classifyClaudeFailure`.
 */
function isLocalSDKFailure(error: unknown): boolean {
	return (
		(error instanceof AnthropicError && !(error instanceof APIError)) ||
		(error instanceof Error && error.message.startsWith('Could not resolve authentication method'))
	);
}

/** `connected` is whether the stream had its response: a failure after that broke the stream off. */
function classifyClaudeFailure(error: unknown, connected: boolean): Error {
	if (connected && !(error instanceof APIError)) {
		// The API was answering, so a later attempt can succeed. An error event the API sends
		// mid-stream, such as an overload, arrives as an `APIError` and is classified below.
		return classifyProviderFailure(error, 'The Claude stream broke off');
	}
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
	private readonly model: (typeof claudeModelIds)[ClaudeLLMModel];
	private readonly reasoningEffort: ClaudeLLMReasoningEffort;
	readonly systemPrompt: string;
	readonly providerDataSource = claudeSource;
	private readonly logger: ILogger;

	// `model` and `reasoningEffort` are untyped on purpose: this adapter is the one that knows
	// what Claude supports.
	constructor({
		model,
		reasoningEffort,
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
		const effort = reasoningEffort ?? 'high';
		if (!isOneOf(claudeLLMReasoningEfforts, effort)) {
			throw new InvalidAgentConfigError(
				`"${effort}" is not a Claude API reasoning effort; expected one of: ${claudeLLMReasoningEfforts.join(', ')}`,
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

		this.model = claudeModelIds[model];
		this.reasoningEffort = effort;
		this.systemPrompt = systemPrompt;
		this.logger = logger;
	}

	supportsNative(tool: NativeTool): boolean {
		return tool === 'textEditor';
	}

	checkCompactAt(compactAt: number): void {
		if (!(Number.isInteger(compactAt) && compactAt >= minCompactAt)) {
			throw new InvalidAgentConfigError(
				`compactAt must be a whole number of tokens of at least ${String(minCompactAt)} on Claude, not ${String(compactAt)}`,
			);
		}
	}

	async send(
		{
			context,
			tools,
			compactAt,
		}: { context: Message[]; tools: ToolDefinition[]; compactAt?: number | 'now' | undefined },
		signal: AbortSignal,
	): Promise<LLMResponse> {
		// Compacting now is compacting at the least threshold Anthropic takes, which a context
		// too large for the model has long passed.
		const trigger = compactAt === 'now' ? minCompactAt : compactAt;
		let response: AnthropicMessage;
		let stream: BetaMessageStream | undefined;
		// What each compaction streamed of its summary, by block index, its missing parts left out.
		const summaries = new Map<number, string>();

		try {
			// Streamed only to lift the timeout: the client still answers with the whole message.
			const sent = this.client.beta.messages.stream(
				{
					model: this.model,
					max_tokens: maxOutputTokens,
					// A compaction changes the conversation's first block, so the cache would otherwise
					// keep nothing: this keeps the system prompt cached across it. The API rejects an
					// empty text block, and an empty prompt has nothing to cache.
					system:
						trigger === undefined || this.systemPrompt === ''
							? this.systemPrompt
							: [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }],
					// The latest compaction carries everything before it, which Anthropic would only ignore.
					messages: sentContext(context, claudeSource).flatMap(toClaudeInput),
					// Left out when empty, so a request without tools stays as it always was.
					...(tools.length > 0 && { tools: tools.map(toClaudeTool) }),
					thinking: { type: 'adaptive', display: 'summarized' },
					output_config: { effort: this.reasoningEffort },
					// Anthropic caches only on request. This marks the last block, so the next call
					// reads everything before it from the cache instead of paying for it again.
					cache_control: { type: 'ephemeral' },
					// Anthropic compacts inside the call that passes it, and answers with the compaction first.
					...(trigger !== undefined && {
						betas: [compactionBeta],
						context_management: {
							edits: [
								{
									type: 'compact_20260112',
									trigger: { type: 'input_tokens', value: trigger },
								},
							],
						},
					}),
				},
				{ signal },
			);
			stream = sent;
			sent.on('streamEvent', event => {
				if (event.type === 'content_block_start' && event.content_block.type === 'compaction') {
					summaries.set(event.index, event.content_block.content ?? '');
				} else if (
					event.type === 'content_block_delta' &&
					event.delta.type === 'compaction_delta'
				) {
					summaries.set(
						event.index,
						(summaries.get(event.index) ?? '') + (event.delta.content ?? ''),
					);
				}
			});
			response = await sent.finalMessage();
		} catch (error) {
			// The SDK's abort error is named 'Error', so it would pass for a provider failure.
			signal.throwIfAborted();
			const connected = Boolean(stream?.response);
			const failure = classifyClaudeFailure(error, connected);
			// Once the stream connected, Claude may have written, and billed, part of an answer it
			// never finished sending, so the run's count cannot be known.
			throw connected ? withSpentTokens(failure, undefined, true) : failure;
		}

		return treatErrors(
			() => toLLMResponse(response, this.logger, summaries),
			classifyLocalFailure,
			'Claude response mapping failed',
		);
	}
}
