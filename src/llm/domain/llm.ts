import type { Tokens } from '../../shared/domain/tokens.ts';
import type { Message } from './message.ts';

export type StopReason = 'completed' | 'truncated' | 'refused';

export interface LLMResponse {
	message: Message & { role: 'assistant' };
	/**
	 * Missing when the provider did not report it. The call was made but cannot be accounted
	 * for, so the agent treats the response as unusable.
	 */
	usage: Tokens | undefined;
	stopReason: StopReason;
}

export interface LLMClient {
	send(context: Message[], signal: AbortSignal): Promise<LLMResponse>;
}
