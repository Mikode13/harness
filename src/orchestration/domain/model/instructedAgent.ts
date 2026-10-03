import type { Agent, AgentResponse, Callback } from '#src/agent/domain/agent';

/**
 * Gives an agent without a system prompt its role's instructions at the head of every prompt.
 * An agent with one, such as `LLMAgent`, holds them there instead, so they are not resent
 * inside each prompt.
 */
export class InstructedAgent implements Agent {
	private readonly inner: Agent;
	private readonly instructions: string;

	constructor({ inner, instructions }: { inner: Agent; instructions: string }) {
		this.inner = inner;
		this.instructions = instructions;
	}

	run(prompt: string, signal: AbortSignal, callback: Callback): Promise<AgentResponse> {
		return this.inner.run(`${this.instructions}\n\n${prompt}`, signal, callback);
	}
}
