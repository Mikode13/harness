import type { Agent, AgentResponse } from './models/agent.ts';
import { isAbortError, RecoverableError, UnrecoverableError } from './models/errors.ts';

export class RetryingAgent implements Agent {
	constructor(
		private inner: Agent,
		private maxAttempts = 3,
	) {}

	async run(prompt: string, signal: AbortSignal): Promise<AgentResponse | undefined> {
		let lastPrompt: string | null = null;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			try {
				const promptToSend = lastPrompt ?? prompt;
				return await this.inner.run(promptToSend, signal);
			} catch (e) {
				if (isAbortError(e) || e instanceof UnrecoverableError || attempt === this.maxAttempts)
					throw e;
				if (e instanceof RecoverableError)
					lastPrompt = `The past prompt failed for the following reason: ${e.cause}`;
			}
		}
		return undefined;
	}
}
