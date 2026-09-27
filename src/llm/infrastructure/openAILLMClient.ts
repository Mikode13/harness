import OpenAI, { APIError } from 'openai';
import type {
	Response,
	ResponseInputItem,
	ResponseOutputItem,
	ResponseUsage,
} from 'openai/resources/responses/responses';
import {
	InvalidAgentConfigError,
	RecoverableError,
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

// The SDK types `model` as a plain string, so this list is maintained by hand.
export const openAIModels = [
	'gpt-6-astra',
	'gpt-5.6-sol',
	'gpt-5.6-luna',
	'gpt-5.6-terra',
] as const;
export type OpenAIModel = (typeof openAIModels)[number];

// The request itself is wrong or not allowed, so sending it again cannot succeed.
const unrecoverableStatuses = [400, 401, 403, 404, 422];

// Out of credit or over a spend limit. These arrive as a 429 like a rate limit, but the account
// stays blocked however often the request is sent.
const exhaustedQuotaCodes = [
	'insufficient_quota',
	'credit_balance_exhausted',
	'project_spend_limit_exceeded',
];

// The codes OpenAI gives a failed response that a new attempt can succeed past.
const transientResponseErrorCodes = ['server_error', 'rate_limit_exceeded'];

/**
 * Only the text crosses back. OpenAI replays reasoning only from the encrypted item it
 * returned, which a `Message` does not keep, so a reasoning part stays in the conversation
 * for narration and is left out of the request. A message with no text is left out whole.
 */
function toOpenAIInput(message: Message): ResponseInputItem[] {
	const text = message.content
		.filter(part => part.type === 'text')
		.map(part => part.text)
		.join('\n');

	return text ? [{ role: message.role, content: text }] : [];
}

function describeItem(item: ResponseOutputItem, logger: ILogger): MessagePart[] {
	switch (item.type) {
		case 'message':
			// A refusal is not an answer: it only sets the stop reason.
			return item.content.flatMap(content =>
				content.type === 'output_text' ? [{ type: 'text' as const, text: content.text }] : [],
			);
		case 'reasoning': {
			// The summary is the readable part; the encrypted content is opaque by design.
			const text = item.summary.map(summary => summary.text).join('\n');
			return text ? [{ type: 'reasoning', text }] : [];
		}
		default:
			// No tools are sent yet, so any other item is output this client does not expect.
			treatErrors(
				() => {
					logger.warn(item, 'OpenAI returned an output item the client does not map');
				},
				classifyHostFailure,
				'OpenAI client logger failed while mapping a response',
			);
			return [];
	}
}

function toStopReason(response: Response): StopReason {
	if (response.status === 'incomplete') {
		return response.incomplete_details?.reason === 'content_filter' ? 'refused' : 'truncated';
	}
	if (response.status !== 'completed') {
		const cause =
			response.error?.message ??
			`The response ended with status "${response.status ?? 'unknown'}".`;
		// The same failure is retried when it arrives as an SDK error, so it must be here too.
		if (response.error && transientResponseErrorCodes.includes(response.error.code)) {
			throw new RecoverableError('The OpenAI response failed', { cause });
		}
		throw new UnrecoverableError('The OpenAI response did not complete', { cause });
	}

	const refused = response.output.some(
		item => item.type === 'message' && item.content.some(content => content.type === 'refusal'),
	);
	return refused ? 'refused' : 'completed';
}

/** OpenAI counts both cache reads and cache writes inside `input_tokens`. */
function toTokens(usage: ResponseUsage | undefined, logger: ILogger): Tokens | undefined {
	if (!usage) {
		// Zeros would report a call that may have been billed as free.
		treatErrors(
			() => {
				logger.warn('OpenAI returned a response without usage; it cannot be accounted for');
			},
			classifyHostFailure,
			'OpenAI client logger failed while reading usage',
		);
		return undefined;
	}

	const { cached_tokens, cache_write_tokens } = usage.input_tokens_details;
	return {
		inputTokens: usage.input_tokens - cached_tokens - cache_write_tokens,
		readCacheTokens: cached_tokens,
		writtenCacheTokens: cache_write_tokens,
		outputTokens: usage.output_tokens,
	};
}

function toLLMResponse(response: Response, logger: ILogger): LLMResponse {
	let usage: Tokens | undefined;

	try {
		// Inside the try: it warns when the usage is missing, and that warning can throw too.
		usage = toTokens(response.usage, logger);
		return {
			message: {
				role: 'assistant',
				content: response.output.flatMap(item => describeItem(item, logger)),
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

function classifyOpenAIFailure(error: unknown): Error {
	if (error instanceof APIError) {
		if (error.code === 'context_length_exceeded') {
			return new MaxContextError('The context no longer fits the OpenAI model', {
				cause: describeFailure(error),
			});
		}
		if (
			exhaustedQuotaCodes.some(code => code === error.code) ||
			unrecoverableStatuses.some(status => status === error.status)
		) {
			return new UnrecoverableError('OpenAI rejected the request', {
				cause: describeFailure(error),
			});
		}
	}

	return classifyProviderFailure(error, 'The OpenAI request failed');
}

/**
 * A stateless `LLMClient` on the OpenAI Responses API. With `store: false` OpenAI keeps
 * nothing between calls, so every call carries the whole context: the conversation is
 * MiKode's, not the provider's.
 */
export class OpenAILLMClient implements LLMClient {
	private readonly client: OpenAI;
	private readonly model: OpenAIModel;
	private readonly systemPrompt: string;
	private readonly logger: ILogger;

	// `model` is untyped on purpose: this adapter is the one that knows what OpenAI supports.
	constructor({
		model,
		systemPrompt,
		logger,
	}: {
		model: string;
		systemPrompt: string;
		logger: ILogger;
	}) {
		if (!isOneOf(openAIModels, model)) {
			throw new InvalidAgentConfigError(
				`"${model}" is not an OpenAI model; expected one of: ${openAIModels.join(', ')}`,
			);
		}

		try {
			// The SDK's default retries stay on: they back off and honour `Retry-After`, which
			// `RetryingAgent` does not. See "The provider SDKs keep their transport retries" in decisions.md.
			this.client = new OpenAI();
		} catch (error) {
			// A missing API key, for example: building the client again cannot fix it.
			throw new UnrecoverableError('The OpenAI client could not be set up', {
				cause: describeFailure(error),
			});
		}

		this.model = model;
		this.systemPrompt = systemPrompt;
		this.logger = logger;
	}

	async send(context: Message[], signal: AbortSignal): Promise<LLMResponse> {
		let response: Response;

		try {
			response = await this.client.responses.create(
				{
					model: this.model,
					instructions: this.systemPrompt,
					input: context.flatMap(toOpenAIInput),
					store: false,
					reasoning: { summary: 'auto' },
				},
				{ signal },
			);
		} catch (error) {
			// The SDK's abort error is named 'Error', so it would pass for a provider failure.
			signal.throwIfAborted();
			throw classifyOpenAIFailure(error);
		}

		return treatErrors(
			() => toLLMResponse(response, this.logger),
			classifyLocalFailure,
			'OpenAI response mapping failed',
		);
	}
}
