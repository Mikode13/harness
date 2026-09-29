import type { Message } from './message.ts';

/**
 * What one agent remembers across its runs. The LLM never sees this object, only the
 * context built from it, so how the context is derived (compaction, later) can change
 * without touching either side.
 */
export class Conversation {
	private readonly messages: Message[];

	constructor(messages: Message[] = []) {
		this.messages = structuredClone(messages);
	}

	/**
	 * Records a whole run at once, once it succeeded: the prompt, every step the model took and
	 * every tool result. A failed run records nothing, so a retry cannot repeat its prompt, and
	 * no tool call is ever kept without its result.
	 */
	addRun(messages: Message[]): void {
		this.messages.push(...structuredClone(messages));
	}

	/**
	 * A deep copy, like everything the conversation takes in: a client that rewrites the
	 * messages it was sent cannot change what the next turn sends.
	 */
	getContext(): Message[] {
		return structuredClone(this.messages);
	}
}
