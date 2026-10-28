export type MessagePart =
	| TextPart
	| ReasoningPart
	| ToolCallPart
	| ToolResultPart
	| ProviderDataPart
	| CompactionPart
	| ContextSummaryPart;

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

/**
 * The harness's own summary of the context before it, written once the context passed the
 * agent's threshold, with a copy of each message it kept word for word. Unlike a `CompactionPart`
 * it belongs to no provider: the context every client sends is derived from the latest one on
 * (`compactedContext`), and the conversation still holds every part it replaced.
 */
export interface ContextSummaryPart {
	type: 'contextSummary';
	summary: string;
	kept: Message[];
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

/** How the model is told that a summary stands for what came before it. */
const summaryHeading =
	'The earlier part of this conversation was compacted into this summary, which you wrote:';

/**
 * `context` from its latest `ContextSummaryPart` on: the summary, then the messages it kept word
 * for word, then everything after it. The whole context when it has none. Messages after the
 * summary are the same objects, not copies.
 */
export function compactedContext(context: Message[]): Message[] {
	const at = context.findLastIndex(message =>
		message.content.some(part => part.type === 'contextSummary'),
	);
	const part = context[at]?.content.findLast(part => part.type === 'contextSummary');
	if (!part) return context;
	const summary: TextPart = { type: 'text', text: `${summaryHeading}\n\n${part.summary}` };
	const [first, ...kept] = part.kept;
	// One user message, not two in a row, when what was kept starts with the user's.
	const opening: Message[] =
		first?.role === 'user'
			? [{ role: 'user', content: [summary, ...first.content] }]
			: [{ role: 'user', content: [summary] }, ...(first ? [first] : [])];
	return [...opening, ...kept, ...context.slice(at + 1)];
}
