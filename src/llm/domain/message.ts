export type MessagePart =
	TextPart | ReasoningPart | ToolCallPart | ToolResultPart | ProviderDataPart | CompactionPart;

export interface TextPart {
	type: 'text';
	text: string;
}

export interface ReasoningPart {
	type: 'reasoning';
	text: string;
}

export interface ToolCallPart {
	id: string;
	type: 'toolCall';
	name: string;
	input: unknown;
}

export interface ToolResultPart {
	callId: string;
	type: 'toolResult';
	name: string;
	output: string;
	isError: boolean;
}

/**
 * A block only the client that produced it can read back, such as signed or encrypted
 * reasoning, kept whole so that client can send it again on the next call. `source` is the
 * client's own label and the domain gives it no meaning: every other client leaves the part out.
 * `data` must stay plain JSON, since the conversation is copied and will be persisted.
 */
export interface ProviderDataPart {
	type: 'providerData';
	source: string;
	data: unknown;
}

/**
 * A provider's own summary of everything before it, written when its context passed the
 * client's `compactAt`. Like `ProviderDataPart`, only the client labelled `source` reads it
 * back: that client sends the conversation from its latest compaction on, and every other client
 * leaves the part out and sends the conversation whole, which the conversation still holds.
 */
export interface CompactionPart {
	type: 'compaction';
	source: string;
	data: unknown;
}

export interface Message {
	role: 'user' | 'assistant' | 'tool';
	content: MessagePart[];
}

/**
 * What the client labelled `source` sends of `context`: everything from its latest compaction
 * on, that compaction included, or the whole context when it has none.
 */
export function sentContext(context: Message[], source: string | undefined): Message[] {
	for (let index = context.length - 1; index >= 0; index--) {
		const message = context[index];
		const at =
			message?.content.findLastIndex(
				part => part.type === 'compaction' && part.source === source,
			) ?? -1;
		if (message && at !== -1) {
			return [{ ...message, content: message.content.slice(at) }, ...context.slice(index + 1)];
		}
	}
	return context;
}
