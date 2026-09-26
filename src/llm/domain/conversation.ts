import type { Message } from './message.ts';

/**
 * What one agent remembers across its runs. The LLM never sees this object, only the
 * context built from it, so how the context is derived (compaction, later) can change
 * without touching either side.
 */
export class Conversation {
	private readonly messages: Message[];

	constructor(messages: Message[] = []) {
		this.messages = [...messages];
	}

	/**
	 * Records a prompt and its answer together, once the call succeeded. A failed call
	 * records nothing, so a retry of the same prompt cannot appear twice.
	 */
	addExchange(prompt: Message, answer: Message): void {
		this.messages.push(prompt, answer);
	}

	/** A copy: whoever sends it cannot rewrite what the conversation remembers. */
	getContext(): Message[] {
		return [...this.messages];
	}
}
