export type MessagePart =
	TextPart | ReasoningPart | ToolCallPart | ToolResultPart | ProviderDataPart;

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

export interface Message {
	role: 'user' | 'assistant' | 'tool';
	content: MessagePart[];
}
