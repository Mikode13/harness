import type { Tokens } from '../../shared/domain/tokens.ts';
import type { Message } from './message.ts';

export type StopReason = 'completed' | 'truncated' | 'refused';

export interface LLMResponse {
	message: Message & { role: 'assistant' };
	/**
	 * Missing when the provider did not report it. The call was made and may have been billed,
	 * so the agent keeps the answer and only its tokens become unknown; a failure raised from
	 * such a response is marked `usageUnreported`.
	 */
	usage: Tokens | undefined;
	stopReason: StopReason;
}

export interface LLMClient {
	send(context: Message[], signal: AbortSignal): Promise<LLMResponse>;
}
