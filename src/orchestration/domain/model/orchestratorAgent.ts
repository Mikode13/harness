import type { Agent, AgentResponse, RunOptions } from '#src/agent/domain/agent';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import { RecoverableError, UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import type { ReviewerDecision } from './reviewerDecision.ts';
import type { Validator } from '../interface/validator.ts';
import type { ILogger } from '#src/shared/domain/logger';
import {
	classifyHostFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import {
	RunContext,
	type RunEnd,
	runContextOf,
	withRunContext,
} from '#src/agent/domain/runContext';
import { isAbortError } from '#src/shared/domain/isAbortError';

// Each role's standing instructions, kept apart from the data of a round so an agent with a
// system prompt can hold them there instead of receiving them again in every prompt. An agent
// without one gets them at the head of each prompt; see `InstructedAgent`.
export const plannerInstructions =
	'You are the planner agent. Read the relevant repository code and create a concise, engineering-grade plan for the executor. Cover the requested behaviour, structural issues, affected files or symbols, API contracts and boundaries, important failure paths, and meaningful tests. Keep the plan focused on the current request and do not require an architecture redesign yet.';

export const executorInstructions =
	"You are the executor agent. Read the relevant repository code and implement the original user request according to the planner's current plan. Preserve contracts and boundaries, handle important failure paths, keep the change focused, and add or update meaningful tests. Inspect and change the code; do not merely describe what should be done.";

export const reviewerInstructions =
	'You are the reviewer agent. Independently inspect the repository, the current diff, and relevant surrounding code; do not rely on the executor\'s narrative. Evaluate the original request first; plan compliance is secondary and provides supporting context. Check correctness and logic errors, important failure paths, unused or artificial abstractions, races or shared state, API contract breaks, boundary violations, regressions, scope, and test quality. If it is correct, respond with JSON only: {"decision":"approved"}. If it is not correct, respond with JSON only: {"decision":"rejected","feedback":"list concrete, prioritized findings and the required direction for each"}. The feedback must contain actionable engineering findings, not a general summary.';

const getPlannerPrompt = (userPrompt: string, previousFailureReason?: string) => {
	const feedback = previousFailureReason
		? `\n\nFeedback from the previous attempt:\n---\n${previousFailureReason}\n---`
		: '';

	return `Original user request:
---
${userPrompt}
---${feedback}`;
};

const getExecutorPrompt = (userPrompt: string, plannerPrompt: string) =>
	`Original user request:
---
${userPrompt}
---

Current implementation plan:
---
${plannerPrompt}
---`;

const getReviewerPrompt = (
	userPrompt: string,
	plannerPrompt: string,
	executorResult: string,
	parseFailureReason?: string,
) => {
	const retryNotice = parseFailureReason
		? `\n\nYour previous response could not be used: ${parseFailureReason} Respond with JSON only, matching the schema exactly, with no surrounding text and no markdown code fences.`
		: '';

	return `Original user request:
---
${userPrompt}
---

Planner's current plan:
---
${plannerPrompt}
---

Executor response (context only; verify it independently):
---
${executorResult}
---${retryNotice}`;
};

interface RunTotals {
	tokens: Tokens | undefined;
	/** A role answered without usage, so the run's total cannot be known. */
	unreported: boolean;
}

// Every role's response counts, even an empty one that starts another round: it was billed.
function addToTotals(totals: RunTotals, response: AgentResponse): void {
	if (!response.tokens) totals.unreported = true;
	totals.tokens = addTokens(totals.tokens, response.tokens);
}

/** Unknown rather than partial: a sum missing a billed call must not look complete. */
function runTokens(totals: RunTotals): Tokens | undefined {
	return totals.unreported ? undefined : totals.tokens;
}

function stripCodeFence(text: string): string {
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
	return match?.[1] ?? text;
}

function parseReviewerDecision(
	response: AgentResponse,
	reviewerDecisionValidator: Validator<ReviewerDecision>,
): ReviewerDecision {
	if (!response.response) {
		throw new RecoverableError("There's no decision from the reviewer, something went wrong", {
			cause: 'Reviewer decision is missing.',
		});
	}

	let parsedResponse: unknown;
	try {
		parsedResponse = JSON.parse(stripCodeFence(response.response));
	} catch {
		throw new RecoverableError('Reviewer returned an invalid decision', {
			cause: 'Reviewer response must be valid JSON.',
		});
	}

	const decision = reviewerDecisionValidator.validate(parsedResponse);
	if (!decision) {
		throw new RecoverableError('Reviewer returned an invalid decision', {
			cause: 'Reviewer response did not match the decision schema.',
		});
	}

	return decision;
}

export class OrchestratorAgent implements Agent {
	private plannerAgent: Agent;
	private executorAgent: Agent;
	private reviewerAgent: Agent;
	private reviewerDecisionValidator: Validator<ReviewerDecision>;
	private maxAttempts: number;
	private logger: ILogger;

	constructor({
		plannerAgent,
		executorAgent,
		reviewerAgent,
		reviewerDecisionValidator,
		maxAttempts = 3,
		logger,
	}: {
		plannerAgent: Agent;
		executorAgent: Agent;
		reviewerAgent: Agent;
		reviewerDecisionValidator: Validator<ReviewerDecision>;
		maxAttempts?: number;
		logger: ILogger;
	}) {
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
			throw new RangeError('maxAttempts must be a positive integer');
		}

		this.plannerAgent = plannerAgent;
		this.executorAgent = executorAgent;
		this.reviewerAgent = reviewerAgent;
		this.reviewerDecisionValidator = reviewerDecisionValidator;
		this.maxAttempts = maxAttempts;
		this.logger = logger;
	}

	/**
	 * Every role, round and retry of one run shares one run context, so what the executor writes
	 * is one run of the workspace's history, and the planner's and reviewer's turns are tied to
	 * it. The orchestrator ends that context with the run, unless an outer agent owns it.
	 */
	async run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const start = Date.now();
		// Per invocation, not per instance: the CLI keeps one orchestrator for a whole session.
		const totals: RunTotals = { tokens: undefined, unreported: false };
		const inherited = runContextOf(options);
		const context = inherited ?? new RunContext();
		let end: RunEnd = 'failed';

		try {
			await this.runRounds(prompt, inherited ? options : withRunContext(options, context), totals);
			end = 'completed';
		} catch (error) {
			if (isAbortError(error)) end = 'cancelled';
			// A failing role carries its own tokens; the roles before it are in the totals.
			throw withSpentTokens(error, totals.tokens, totals.unreported);
		} finally {
			if (!inherited) await this.finishContext(context, end);
		}

		// Read once the run ended: a run that changed nothing left the history then.
		const { runId } = context.historyRun;
		return {
			response: 'All job has finished',
			tokens: runTokens(totals),
			// The whole run's wall clock, so it matches what the consumer waited.
			duration: (Date.now() - start) / 1000,
			...(!inherited && runId ? { runId } : {}),
		};
	}

	/** The run's records end here, but its result stands: what it changed is already on disk. */
	private async finishContext(context: RunContext, end: RunEnd): Promise<void> {
		try {
			await context.finish(end);
		} catch (error) {
			this.warn(`The run could not close its records: ${describeFailure(error)}`);
		}
	}

	private async runRounds(prompt: string, options: RunOptions, totals: RunTotals): Promise<void> {
		let lastFailureReason: string | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const isLastAttempt = attempt === this.maxAttempts;

			const plannerResponse = await this.plannerAgent.run(
				getPlannerPrompt(prompt, lastFailureReason),
				options,
			);
			addToTotals(totals, plannerResponse);

			if (!plannerResponse.response) {
				lastFailureReason = 'The planner produced no response.';
				if (isLastAttempt) {
					throw new UnrecoverableError('Max attempts exhausted', { cause: lastFailureReason });
				}
				this.warn(
					`Attempt ${String(attempt)}/${String(this.maxAttempts)}: the planner produced no response; starting another round`,
				);
				continue;
			}

			const executorResponse = await this.executorAgent.run(
				getExecutorPrompt(prompt, plannerResponse.response),
				options,
			);
			addToTotals(totals, executorResponse);

			if (!executorResponse.response) {
				lastFailureReason = 'The executor produced no response.';
				if (isLastAttempt) {
					throw new UnrecoverableError('Max attempts exhausted', { cause: lastFailureReason });
				}

				this.warn(
					`Attempt ${String(attempt)}/${String(this.maxAttempts)}: the executor produced no response; starting another round`,
				);
				continue;
			}

			const reviewerDecision = await this.getReviewerDecision(
				prompt,
				plannerResponse.response,
				executorResponse.response,
				options,
				totals,
			);

			if (reviewerDecision.decision === 'approved') return;

			lastFailureReason = reviewerDecision.feedback;
			if (isLastAttempt) {
				throw new UnrecoverableError('Max attempts exhausted', { cause: lastFailureReason });
			}

			this.warn(
				`Attempt ${String(attempt)}/${String(this.maxAttempts)}: the reviewer rejected the round; starting another with its feedback`,
				lastFailureReason,
			);
		}

		throw new UnrecoverableError('Max attempts exhausted', {
			cause: lastFailureReason ?? 'Unknown failure.',
		});
	}

	// Retries only the reviewer call on a malformed decision, instead of redoing
	// planning/execution — a bad or unparsable reviewer response is not evidence
	// the plan or the implementation were wrong.
	private async getReviewerDecision(
		userPrompt: string,
		plannerPrompt: string,
		executorResult: string,
		options: RunOptions,
		totals: RunTotals,
	): Promise<ReviewerDecision> {
		let parseFailureReason: string | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const reviewerResponse = await this.reviewerAgent.run(
				getReviewerPrompt(userPrompt, plannerPrompt, executorResult, parseFailureReason),
				options,
			);

			addToTotals(totals, reviewerResponse);

			try {
				return parseReviewerDecision(reviewerResponse, this.reviewerDecisionValidator);
			} catch (error) {
				if (!(error instanceof RecoverableError)) throw error;

				parseFailureReason = error.cause;
				if (attempt === this.maxAttempts) {
					throw new UnrecoverableError('Max attempts exhausted', { cause: parseFailureReason });
				}

				this.warn(
					`Reviewer decision ${String(attempt)}/${String(this.maxAttempts)} was unusable; asking the reviewer again`,
					parseFailureReason,
				);
			}
		}

		throw new UnrecoverableError('Max attempts exhausted', {
			cause: parseFailureReason ?? 'Unknown failure.',
		});
	}

	private warn(...args: unknown[]): void {
		treatErrors(
			() => {
				this.logger.warn(...args);
			},
			classifyHostFailure,
			'Orchestrator logger failed while reporting a retry',
		);
	}
}
