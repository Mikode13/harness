import type { Agent, AgentResponse, Callback, ProgressEvent } from '../../../agent/domain/agent.ts';
import { UnrecoverableError } from '../../../agent/domain/errors.ts';
import {
	classifyHostFailure,
	classifyProviderFailure,
	treatErrors,
} from '../../../agent/domain/providerFailure.ts';
import { Conversation } from '../../../llm/domain/conversation.ts';
import type { LLMClient, LLMResponse } from '../../../llm/domain/llm.ts';
import type { Message, MessagePart } from '../../../llm/domain/message.ts';

function describePart(part: MessagePart): ProgressEvent {
	return part.type === 'text'
		? { type: 'agentMessage', message: part.text }
		: { type: 'reasoning', message: part.text };
}

/**
 * An agent whose conversation is owned by MiKode: every run sends the whole context to a
 * stateless `LLMClient`. Turn boundaries are the consumer's to emit, as with the other
 * engines; this agent only narrates what the model produced.
 */
export class LLMAgent implements Agent {
	private readonly llmClient: LLMClient;
	private readonly conversation: Conversation;

	constructor({ llmClient, messages }: { llmClient: LLMClient; messages?: Message[] }) {
		this.llmClient = llmClient;
		this.conversation = new Conversation(messages);
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		const start = Date.now();
		const userMessage: Message = { role: 'user', content: [{ type: 'text', text: prompt }] };

		let response: LLMResponse;
		try {
			response = await this.llmClient.send(
				[...this.conversation.getContext(), userMessage],
				signal,
			);
		} catch (error) {
			throw classifyProviderFailure(error, 'The LLM call failed');
		}

		if (response.stopReason !== 'completed') {
			throw new UnrecoverableError('The LLM stopped before completing its answer', {
				cause: `The model stopped with "${response.stopReason}".`,
			});
		}

		this.conversation.addExchange(userMessage, response.message);

		for (const part of response.message.content) {
			treatErrors(
				() => {
					callback(describePart(part));
				},
				classifyHostFailure,
				'LLM agent progress callback failed',
			);
		}

		const text = response.message.content
			.filter(part => part.type === 'text')
			.map(part => part.text)
			.join('\n');

		if (!text) return undefined;

		return {
			response: text,
			tokens: response.usage,
			duration: (Date.now() - start) / 1000,
		};
	}
}
