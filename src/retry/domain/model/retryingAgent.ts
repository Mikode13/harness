import type { Agent, AgentResponse, Callback } from '../../../agent/domain/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../../agent/domain/errors.ts';
import { describeFailure } from '../../../agent/domain/providerFailure.ts';
import { isAbortError } from '../../../shared/domain/isAbortError.ts';

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

				// Only a failure the agent classified as recoverable earns another call. An
				// unclassified one breaks the `Agent` contract, so nothing here knows whether
				// replaying it is safe — it may already have written files or run commands.
				if (!(e instanceof RecoverableError))
					throw new UnrecoverableError('The agent failed without classifying the failure', {
						cause: describeFailure(e),
					});

				if (attempt === this.maxAttempts)
					throw new UnrecoverableError('Max attempts exhausted', {
						cause: `Gave up after ${String(this.maxAttempts)} attempts. Last failure: ${e.cause}`,
					});

				lastPrompt = `The past prompt failed for the following reason: ${e.cause}`;
			}
		}
		return undefined;
	}
}
