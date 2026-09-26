export type MessagePart = { type: 'text'; text: string } | { type: 'reasoning'; text: string };

export interface Message {
	role: 'user' | 'assistant';
	content: MessagePart[];
}
