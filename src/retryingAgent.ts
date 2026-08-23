import type { Agent, AgentResponse } from './models/agent.ts';
import { isAbortError, UnrecoverableError } from './models/errors.ts';

export class RetryingAgent implements Agent {
	constructor(
		private inner: Agent,
		private maxAttempts = 3,
	) {}

	async run(prompt: string, signal: AbortSignal): Promise<AgentResponse | undefined> {
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			try {
				return await this.inner.run(prompt, signal);
			} catch (e) {
				if (isAbortError(e) || e instanceof UnrecoverableError || attempt === this.maxAttempts)
					throw e;
			}
		}
		return undefined;
	}
}
