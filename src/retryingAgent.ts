import type { Agent, AgentResponse, Callback } from './models/agent.ts';
import { isAbortError, RecoverableError, UnrecoverableError } from './models/errors.ts';

export class RetryingAgent implements Agent {
	private inner: Agent;
	private maxAttempts: number;

	constructor(inner: Agent, maxAttempts = 3) {
		this.inner = inner;
		this.maxAttempts = maxAttempts;
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		let lastPrompt: string | null = null;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			try {
				const promptToSend = lastPrompt ?? prompt;
				return await this.inner.run(promptToSend, signal, callback);
			} catch (e) {
				if (isAbortError(e) || e instanceof UnrecoverableError) throw e;
				if (attempt === this.maxAttempts)
					throw new UnrecoverableError('Max attempts exhausted', {
						cause: 'max attempts limit reached',
					});
				if (e instanceof RecoverableError)
					lastPrompt = `The past prompt failed for the following reason: ${e.cause}`;
			}
		}
		return undefined;
	}
}
