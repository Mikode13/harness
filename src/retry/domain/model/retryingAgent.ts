import type { Agent, AgentResponse, Callback } from '../../../agent/domain/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../../agent/domain/errors.ts';
import {
	classifyHostFailure,
	describeFailure,
	treatErrors,
} from '../../../agent/domain/providerFailure.ts';
import { isAbortError } from '../../../shared/domain/isAbortError.ts';
import type { ILogger } from '../../../shared/domain/logger.ts';

export class RetryingAgent implements Agent {
	private inner: Agent;
	private maxAttempts: number;
	private logger: ILogger;

	constructor({
		inner,
		maxAttempts = 3,
		logger,
	}: {
		inner: Agent;
		maxAttempts?: number;
		logger: ILogger;
	}) {
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
			throw new RangeError('maxAttempts must be a positive integer');
		}

		this.inner = inner;
		this.maxAttempts = maxAttempts;
		this.logger = logger;
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

				// Keeps the original request: an attempt that failed before the provider registered
				// the turn left no session that remembers it.
				lastPrompt = `${prompt}\n\nThe previous attempt failed for the following reason: ${e.cause}`;
				treatErrors(
					() => {
						this.logger.warn(
							`Attempt ${String(attempt)}/${String(this.maxAttempts)} failed; retrying`,
							e,
						);
					},
					classifyHostFailure,
					'RetryingAgent logger failed while reporting a retry',
				);
			}
		}
		return undefined;
	}
}
