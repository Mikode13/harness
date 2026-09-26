import type { Tokens } from '../../shared/domain/tokens.ts';
import type { Message } from './message.ts';

export type StopReason = 'completed' | 'truncated' | 'refused';

export interface LLMResponse {
	message: Message & { role: 'assistant' };
	usage: Tokens;
	stopReason: StopReason;
}

export interface LLMClient {
	send(context: Message[], signal: AbortSignal): Promise<LLMResponse>;
}
