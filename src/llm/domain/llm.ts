import type { Tokens } from '#src/shared/domain/tokens';
import type { Message } from './message.ts';
import type { NativeTool, ToolDefinition } from './tool.ts';

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
	/**
	 * When the provider compacted the context in this call: the tokens of context it compacted,
	 * as the provider reported them. Missing when it did not compact, or did not report them.
	 */
	compactedContextTokens?: number;
}

export interface LLMClient {
	/** The system prompt every call sends, for measuring what a call carries. */
	readonly systemPrompt?: string;
	/**
	 * The `source` of the `providerData` and `compaction` parts this client sends back; it drops
	 * every other. For measuring what a call carries.
	 */
	readonly providerDataSource?: string;
	/** Whether this client can declare a native tool. Missing means it declares none. */
	supportsNative?(tool: NativeTool): boolean;
	/**
	 * Checks a threshold for `send`'s `compactAt`. Missing when the provider cannot compact.
	 *
	 * @throws {InvalidAgentConfigError} for a threshold the provider cannot take.
	 */
	checkCompactAt?(compactAt: number): void;
	/**
	 * @param compactAt the tokens of context at which the provider compacts it inside this call,
	 * answering with its summary first; `now` compacts it whatever its size, as far as the
	 * provider can. Without it, the call never compacts.
	 */
	send(
		{
			context,
			tools,
			compactAt,
		}: { context: Message[]; tools: ToolDefinition[]; compactAt?: number | 'now' | undefined },
		signal: AbortSignal,
	): Promise<LLMResponse>;
}
