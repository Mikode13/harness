export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

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

export interface Message {
	role: 'user' | 'assistant' | 'tool';
	content: MessagePart[];
}
