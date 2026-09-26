import type { LLMClient, LLMResponse, StopReason } from '../../src/llm/domain/llm.ts';
import type { Tokens } from '../../src/shared/domain/tokens.ts';
import type { Message } from '../../src/llm/domain/message.ts';

/**
 * An offline `LLMClient` that answers from a script, in order, and records what it was sent.
 * Each recorded context is a copy, so a caller that keeps appending to the same array cannot
 * rewrite what an earlier call received.
 */
export class FakeLLMClient implements LLMClient {
	readonly contexts: Message[][] = [];
	private readonly script: (LLMResponse | Error)[];

	constructor(...script: (LLMResponse | Error)[]) {
		this.script = script;
	}

	send(context: Message[], signal: AbortSignal): Promise<LLMResponse> {
		if (signal.aborted) {
			return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
		}

		this.contexts.push(structuredClone(context));

		const next = this.script.shift();
		if (!next) return Promise.reject(new Error('FakeLLMClient ran out of scripted responses'));
		if (next instanceof Error) return Promise.reject(next);

		return Promise.resolve(structuredClone(next));
	}
}

/** A finished assistant turn made of one text part. */
export function textResponse(
	text: string,
	{
		usage = {},
		stopReason = 'completed',
	}: { usage?: Partial<Tokens>; stopReason?: StopReason } = {},
): LLMResponse {
	return {
		message: { role: 'assistant', content: [{ type: 'text', text }] },
		usage: { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0, ...usage },
		stopReason,
	};
}

/** A user turn made of one text part, the way an agent records a prompt. */
export function userMessage(text: string): Message {
	return { role: 'user', content: [{ type: 'text', text }] };
}
