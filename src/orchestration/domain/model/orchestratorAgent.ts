import type { Agent, AgentResponse, Callback } from '../../../agent/domain/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../../agent/domain/errors.ts';
import type { ReviewerDecision } from './reviewerDecision.ts';
import type { Validator } from '../interface/validator.ts';
import type { ILogger } from '../../../shared/domain/logger.ts';
import { classifyHostFailure, treatErrors } from '../../../agent/domain/providerFailure.ts';

const getPlannerPrompt = (userPrompt: string, previousFailureReason?: string) => {
	const feedback = previousFailureReason
		? `\n\nFeedback from the previous attempt:\n---\n${previousFailureReason}\n---`
		: '';

	return `You are the planner agent. Read the relevant repository code and create a concise, engineering-grade plan for the executor. Cover the requested behaviour, structural issues, affected files or symbols, API contracts and boundaries, important failure paths, and meaningful tests. Keep the plan focused on the current request and do not require an architecture redesign yet.

Original user request:
---
${userPrompt}
---${feedback}`;
};

const getExecutorPrompt = (userPrompt: string, plannerPrompt: string) =>
	`You are the executor agent. Read the relevant repository code and implement the original user request according to the planner's current plan. Preserve contracts and boundaries, handle important failure paths, keep the change focused, and add or update meaningful tests. Inspect and change the code; do not merely describe what should be done.

Original user request:
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

	return `You are the reviewer agent. Independently inspect the repository, the current diff, and relevant surrounding code; do not rely on the executor's narrative. Evaluate the original request first; plan compliance is secondary and provides supporting context. Check correctness and logic errors, important failure paths, unused or artificial abstractions, races or shared state, API contract breaks, boundary violations, regressions, scope, and test quality. If it is correct, respond with JSON only: {"decision":"approved"}. If it is not correct, respond with JSON only: {"decision":"rejected","feedback":"list concrete, prioritized findings and the required direction for each"}. The feedback must contain actionable engineering findings, not a general summary.

Original user request:
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
	duration: number;
	inputTokens: number;
	outputTokens: number;
}

function addToTotals(totals: RunTotals, response: AgentResponse): void {
	totals.duration += response.duration;
	totals.inputTokens += response.inputTokens;
	totals.outputTokens += response.outputTokens;
}

function stripCodeFence(text: string): string {
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
	return match?.[1] ?? text;
}

function parseReviewerDecision(
	response: AgentResponse | undefined,
	reviewerDecisionValidator: Validator<ReviewerDecision>,
): ReviewerDecision {
	if (!response?.response) {
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

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		// Per invocation, not per instance: the CLI keeps one orchestrator for a whole session.
		const totals: RunTotals = { duration: 0, inputTokens: 0, outputTokens: 0 };
		let lastFailureReason: string | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const isLastAttempt = attempt === this.maxAttempts;

			const plannerResponse = await this.plannerAgent.run(
				getPlannerPrompt(prompt, lastFailureReason),
				signal,
				callback,
			);

			if (!plannerResponse?.response) {
				lastFailureReason = 'The planner produced no response.';
				if (isLastAttempt) {
					throw new UnrecoverableError('Max attempts exhausted', { cause: lastFailureReason });
				}
				this.warn(
					`Attempt ${String(attempt)}/${String(this.maxAttempts)}: the planner produced no response; starting another round`,
				);
				continue;
			}

			addToTotals(totals, plannerResponse);

			const executorResponse = await this.executorAgent.run(
				getExecutorPrompt(prompt, plannerResponse.response),
				signal,
				callback,
			);

			if (!executorResponse?.response) {
				lastFailureReason = 'The executor produced no response.';
				if (isLastAttempt) {
					throw new UnrecoverableError('Max attempts exhausted', { cause: lastFailureReason });
				}

				this.warn(
					`Attempt ${String(attempt)}/${String(this.maxAttempts)}: the executor produced no response; starting another round`,
				);
				continue;
			}

			addToTotals(totals, executorResponse);

			const reviewerDecision = await this.getReviewerDecision(
				prompt,
				plannerResponse.response,
				executorResponse.response,
				signal,
				callback,
				totals,
			);

			if (reviewerDecision.decision === 'approved') {
				return { response: 'All job has finished', ...totals };
			}

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
		signal: AbortSignal,
		callback: Callback,
		totals: RunTotals,
	): Promise<ReviewerDecision> {
		let parseFailureReason: string | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const reviewerResponse = await this.reviewerAgent.run(
				getReviewerPrompt(userPrompt, plannerPrompt, executorResult, parseFailureReason),
				signal,
				callback,
			);

			if (reviewerResponse) {
				addToTotals(totals, reviewerResponse);
			}

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
