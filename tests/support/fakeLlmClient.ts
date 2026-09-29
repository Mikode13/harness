import type { LLMClient, LLMResponse, StopReason } from '../../src/llm/domain/llm.ts';
import type { Message, MessagePart } from '../../src/llm/domain/message.ts';
import type { ToolDefinition } from '../../src/llm/domain/tool.ts';
import type { Tokens } from '../../src/shared/domain/tokens.ts';

/**
 * An offline `LLMClient` that answers from a script, in order, and records what it was sent.
 * Each recorded context is a copy, so a caller that keeps appending to the same array cannot
 * rewrite what an earlier call received.
 */
export class FakeLLMClient implements LLMClient {
	readonly contexts: Message[][] = [];
	readonly tools: ToolDefinition[][] = [];
	private readonly script: (LLMResponse | Error)[];

	constructor(...script: (LLMResponse | Error)[]) {
		this.script = script;
	}

	send(
		{ context, tools }: { context: Message[]; tools: ToolDefinition[] },
		signal: AbortSignal,
	): Promise<LLMResponse> {
		if (signal.aborted) {
			return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
		}

		this.contexts.push(structuredClone(context));
		this.tools.push(structuredClone(tools));

		const next = this.script.shift();
		if (!next) return Promise.reject(new Error('FakeLLMClient ran out of scripted responses'));
		if (next instanceof Error) return Promise.reject(next);

		return Promise.resolve(structuredClone(next));
	}
}

interface ResponseOptions {
	// `null` stands for a provider that reported no usage.
	usage?: Partial<Tokens> | null;
	stopReason?: StopReason;
}

/** A finished assistant turn made of `content`. */
export function assistantResponse(
	content: MessagePart[],
	{ usage = {}, stopReason = 'completed' }: ResponseOptions = {},
): LLMResponse {
	return {
		message: { role: 'assistant', content },
		usage:
			usage === null
				? undefined
				: { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0, ...usage },
		stopReason,
	};
}

/** A finished assistant turn made of one text part. */
export function textResponse(text: string, options?: ResponseOptions): LLMResponse {
	return assistantResponse([{ type: 'text', text }], options);
}

/** A user turn made of one text part, the way an agent records a prompt. */
export function userMessage(text: string): Message {
	return { role: 'user', content: [{ type: 'text', text }] };
}

/** The model asking for one tool call. */
export function toolCall(id: string, name: string, input: unknown = {}): MessagePart {
	return { type: 'toolCall', id, name, input };
}

/** What a tool call produced, as the agent reports it back to the model. */
export function toolResult(
	callId: string,
	name: string,
	output: string,
	isError = false,
): MessagePart {
	return { type: 'toolResult', callId, name, output, isError };
}

/** The turn that carries a step's tool results back to the model. */
export function toolMessage(...results: MessagePart[]): Message {
	return { role: 'tool', content: results };
}
