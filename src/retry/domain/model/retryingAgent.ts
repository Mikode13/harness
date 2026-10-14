import type { Agent, AgentResponse, RunOptions } from '#src/agent/domain/agent';
import { describeAnswered, rememberAnswers } from '#src/agent/domain/question';
import { RecoverableError, UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import {
	classifyHostFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import { isAbortError } from '#src/shared/domain/isAbortError';
import type { ILogger } from '#src/shared/domain/logger';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';

export class RetryingAgent implements Agent {
	private inner: Agent;
	private maxAttempts: number;
	private logger: ILogger;
	private noteFailures: boolean;

	constructor({
		inner,
		maxAttempts = 3,
		logger,
		noteFailures = true,
	}: {
		inner: Agent;
		maxAttempts?: number;
		logger: ILogger;
		/**
		 * Appends the previous failure to the retried prompt, so a provider session that may
		 * remember the failed turn is told what happened. Off for an agent that records nothing
		 * from a failed call, such as `LLMAgent`: there the note would become a permanent user
		 * message resent on every later turn.
		 */
		noteFailures?: boolean;
	}) {
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
			throw new RangeError('maxAttempts must be a positive integer');
		}

		this.inner = inner;
		this.maxAttempts = maxAttempts;
		this.logger = logger;
		this.noteFailures = noteFailures;
	}

	async run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const start = Date.now();
		let lastPrompt: string | null = null;
		// Failed attempts were billed too, so they travel with whichever way the run ends.
		let spent: Tokens | undefined;
		// An attempt was answered without usage, so `spent` is only a subtotal.
		let unreported = false;
		// What the user answered stays answered: a retry neither asks it again nor forgets it.
		const remembered = options.ask ? rememberAnswers(options.ask) : undefined;
		const attemptOptions = remembered ? { ...options, ask: remembered.ask } : options;

		for (let attempt = 1; ; attempt++) {
			try {
				const base = lastPrompt ?? prompt;
				// After an attempt the user answered, the model is told so, or it would ask again
				// in its own words, which the memory does not recognise.
				const promptToSend =
					attempt > 1 && remembered && remembered.answered.length > 0
						? `${base}\n\n${describeAnswered(remembered.answered)}`
						: base;
				const response = await this.inner.run(promptToSend, attemptOptions);
				return {
					...response,
					// Any call answered without usage makes the whole count unknown, not partial.
					tokens: unreported ? undefined : response.tokens && addTokens(spent, response.tokens),
					// Every attempt was waited for, not only the last one.
					duration: (Date.now() - start) / 1000,
				};
			} catch (e) {
				if (isAbortError(e)) throw e;
				if (e instanceof UnrecoverableError) throw withSpentTokens(e, spent, unreported);

				// Only a failure the agent classified as recoverable earns another call. An
				// unclassified one breaks the `Agent` contract, so nothing here knows whether
				// replaying it is safe — it may already have written files or run commands.
				if (!(e instanceof RecoverableError))
					throw new UnrecoverableError('The agent failed without classifying the failure', {
						cause: describeFailure(e),
						tokens: spent,
						usageUnreported: unreported,
					});

				spent = addTokens(spent, e.tokens);
				unreported ||= e.usageUnreported;

				if (attempt === this.maxAttempts)
					throw new UnrecoverableError('Max attempts exhausted', {
						cause: `Gave up after ${String(this.maxAttempts)} attempts. Last failure: ${e.cause}`,
						tokens: spent,
						usageUnreported: unreported,
					});

				// Keeps the original request: an attempt that failed before the provider registered
				// the turn left no session that remembers it.
				if (this.noteFailures) {
					lastPrompt = `${prompt}\n\nThe previous attempt failed for the following reason: ${e.cause}`;
				}
				try {
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
				} catch (logFailure) {
					// The attempts already spent their tokens, whatever the logger did.
					throw withSpentTokens(logFailure, spent, unreported);
				}
			}
		}
	}
}
