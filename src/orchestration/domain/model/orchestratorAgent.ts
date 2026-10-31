import type {
	Agent,
	AgentResponse,
	ProgressAgent,
	ProgressEvent,
	RunOptions,
} from '#src/agent/domain/agent';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import { RecoverableError, UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import type { CommitReport, RepositoryCommit } from '#src/agent/domain/commitReport';
import { readAnswers, type UserQuestion } from '#src/agent/domain/question';
import type { Committer, FrozenChanges, FrozenRepository } from './committer.ts';
import type { ReviewerDecision } from './reviewerDecision.ts';
import type { Validator } from '#src/shared/domain/validator';
import type { ILogger } from '#src/shared/domain/logger';
import {
	classifyHostFailure,
	classifyLocalFailure,
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
import { OneRunAtATime } from '#src/agent/domain/oneRunAtATime';
import { newSession, sessionOf } from '#src/agent/domain/session';

// Each role's standing instructions, kept apart from the data of a round so an agent with a
// system prompt can hold them there instead of receiving them again in every prompt. An agent
// without one gets them at the head of each prompt; see `InstructedAgent`.
const conciseCommunication =
	'Communicate tersely and professionally. In reasoning updates, state only the next concrete action or a verified finding, in one short sentence. Do not narrate routine intentions, uncertainty, self-reflection, encouragement, or a desire to be thorough. Do not restate tool results. Once you decide what to do, act immediately. Use only the detail required by your role in the final response.';

export const plannerInstructions = `You are the planner agent. Read the relevant repository code and create a concise, engineering-grade plan for the executor. Cover the requested behaviour, structural issues, affected files or symbols, API contracts and boundaries, important failure paths, and meaningful tests. Keep the plan focused on the current request and do not require an architecture redesign yet. ${conciseCommunication}`;

const executorTask = `You are the executor agent. Read the relevant repository code and implement the original user request according to the planner's current plan. Preserve contracts and boundaries, handle important failure paths, keep the change focused, and add or update meaningful tests. Inspect and change the code; do not merely describe what should be done. ${conciseCommunication}`;

// For an executor that can run the project's tests and checks: an Agent SDK one, which has a
// shell, or a model-API one given commands. The harness cannot tell which command runs the
// tests, so any command counts.
export const executorInstructions = `${executorTask} Before you finish, run the project's tests and checks, and finish only when they pass. Once they pass and the plan is carried out, finish at once: do not add work beyond the plan, because the reviewer asks for what is missing. If you cannot make them pass, finish by saying which ones fail and why.`;

// For a model-API executor with no command, which cannot run anything: told so, it neither
// spends its steps looking for a way to test nor claims a result it could not have.
export const executorInstructionsWithoutCommands = `${executorTask} You have no command that runs the project's tests or checks, so you cannot run them. Once the plan is carried out, finish at once: do not add work beyond the plan, because the reviewer asks for what is missing. Say in your summary that the tests and checks were not run.`;

const reviewerTask = `Review the code. Independently inspect the repository, the current diff, and relevant surrounding code; do not rely on the executor's narrative. Judge it against the original request, and any issue it names, first: check that the plan is right for it, and that the change fulfills it. Check correctness and logic errors, important failure paths, unused or artificial abstractions, races or shared state, API contract breaks, boundary violations, regressions, scope, and test quality. If it is correct, respond with JSON only: {"decision":"approved"}. If it is not correct, respond with JSON only: {"decision":"rejected","feedback":"list concrete, prioritized findings and the required direction for each"}. The feedback must contain actionable engineering findings, not a general summary. ${conciseCommunication}`;

// Each goes with the executor instructions of the same name. The executor may finish with
// failing tests, saying so, and nothing in the harness checks which: the reviewer takes it
// from the executor's response.
export const reviewerInstructions = `You are the reviewer agent. The executor was told to run the project's tests and checks before finishing, and to finish only when they pass, or to say which ones fail and why. Whether they pass is the one thing to take from its response: do not run them yourself, and do not approve a change whose response says that any of them fail. ${reviewerTask}`;

export const reviewerInstructionsWithoutCommands = `You are the reviewer agent. Nobody has run the tests or checks: the executor had no command for them. Judge from the code whether the tests it added or changed would pass, and do not approve a change whose tests could not. ${reviewerTask}`;

export const committerInstructions =
	"You are the committer agent. Write the git commit message for the change you are given, which the reviewer approved. Follow the style of the repository's recent commit subjects when they show one, such as a type prefix. Answer with the message only: a subject line in the imperative mood, at most 72 characters, then, when the change needs it, a blank line and a short body that says what changed and why. No code fences, no quotes around it, no trailers.";

const getCommitterPrompt = (userPrompt: string, plannerPrompt: string, frozen: FrozenRepository) =>
	`Original user request:
---
${userPrompt}
---

Plan the change carried out:
---
${plannerPrompt}
---

Repository: ${frozen.repository}${frozen.branch === undefined ? '' : `, branch ${frozen.branch}`}
${frozen.style.length > 0 ? `\nIts recent commit subjects:\n${frozen.style.map(subject => `- ${subject}`).join('\n')}\n` : ''}
The change to commit:
---
${frozen.diff}
---`;

// The one answer that commits: anything else, the user's own words included, does not.
const commitLabel = 'Commit';

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

/** A repository the committer did not try, reported as left. */
function leftIn({ repository, branch, leftOut, refused }: FrozenRepository): RepositoryCommit {
	return {
		repository,
		...(branch === undefined ? {} : { branch }),
		outcome: 'left',
		reason: refused ?? 'nothing the run changed there can be committed',
		commits: [],
		paths: [],
		leftOut: [...leftOut],
		unreviewed: [],
	};
}

/** The question that asks whether to commit: what would be committed, and what left out. */
function describeCommit(ready: readonly FrozenRepository[]): string {
	const files = (count: number) => `${String(count)} ${count === 1 ? 'file' : 'files'}`;
	const where = ready
		.map(
			({ repository, branch, paths }) =>
				`${files(paths.length)} in ${repository}${branch === undefined ? '' : ` on ${branch}`}`,
		)
		.join('; ');
	const leftOut = ready.flatMap(({ leftOut }) => leftOut);
	const left =
		leftOut.length === 0
			? ''
			: ` ${files(leftOut.length)} the task changed would be left out: ${leftOut.map(({ path, reason }) => `${path} (${reason})`).join(', ')}.`;
	return `The reviewer approved the change. Commit it? It would commit ${where}.${left}`;
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
	private committer: Committer | undefined;
	private createCommitter: (() => Agent) | undefined;
	private autoCommit: boolean;
	private readonly runs = new OneRunAtATime();
	// The session its runs belong to when their options name none.
	private readonly session = newSession();

	constructor({
		plannerAgent,
		executorAgent,
		reviewerAgent,
		reviewerDecisionValidator,
		maxAttempts = 3,
		logger,
		committer,
		createCommitter,
		autoCommit = false,
	}: {
		plannerAgent: Agent;
		executorAgent: Agent;
		reviewerAgent: Agent;
		reviewerDecisionValidator: Validator<ReviewerDecision>;
		maxAttempts?: number;
		logger: ILogger;
		/** Commits what an approved run changed; with `createCommitter`, whose agent writes the message. */
		committer?: Committer;
		/** A new agent for each message, so none carries an earlier commit's diff. */
		createCommitter?: () => Agent;
		/** Commits without asking. Without it, a run with no `ask` commits nothing. */
		autoCommit?: boolean;
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
		this.committer = committer;
		this.createCommitter = createCommitter;
		this.autoCommit = autoCommit;
	}

	/**
	 * Every role, round and retry of one run shares one run context, so what the executor writes
	 * is one run of the workspace's history, and the planner's and reviewer's turns are tied to
	 * it. The orchestrator ends that context with the run, unless an outer agent owns it.
	 *
	 * @throws {RunInProgressError} when another run on it is still working, before any role
	 * starts.
	 */
	run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		return this.runs.run(() => this.runAlone(prompt, options));
	}

	private async runAlone(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const start = Date.now();
		// Per invocation, not per instance: the CLI keeps one orchestrator for a whole session.
		const totals: RunTotals = { tokens: undefined, unreported: false };
		const session = sessionOf(options) ?? this.session;
		const inherited = runContextOf(options);
		const context = inherited ?? new RunContext(session);
		let end: RunEnd = 'failed';
		let commits: CommitReport | undefined;

		try {
			const runOptions = inherited ? options : withRunContext(options, context);
			const approved = await this.runRounds(prompt, runOptions, totals);
			// Before the run's records end: its commit is one of its changes.
			commits = await this.commitStage(prompt, approved, runOptions, totals);
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
			// A copy: a consumer changing it must not change what later runs record.
			session: { ...session },
			...(commits ? { commits } : {}),
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

	/** The plan the reviewer approved, and what a commit would hold, frozen before that review. */
	private async runRounds(
		prompt: string,
		options: RunOptions,
		totals: RunTotals,
	): Promise<{ plan: string; frozen: FrozenChanges | undefined }> {
		let lastFailureReason: string | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const isLastAttempt = attempt === this.maxAttempts;

			const plannerResponse = await this.plannerAgent.run(
				getPlannerPrompt(prompt, lastFailureReason),
				this.optionsForRole(options, 'planner'),
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
				this.optionsForRole(options, 'executor'),
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

			// Before the review, so what is committed is what the reviewer read.
			const frozen = await this.freeze(options);
			const reviewerDecision = await this.getReviewerDecision(
				prompt,
				plannerResponse.response,
				executorResponse.response,
				options,
				totals,
			);

			if (reviewerDecision.decision === 'approved') {
				return { plan: plannerResponse.response, frozen };
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
		options: RunOptions,
		totals: RunTotals,
	): Promise<ReviewerDecision> {
		let parseFailureReason: string | undefined;

		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			const reviewerResponse = await this.reviewerAgent.run(
				getReviewerPrompt(userPrompt, plannerPrompt, executorResult, parseFailureReason),
				this.optionsForRole(options, 'reviewer'),
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

	/** Whether an approved run may be committed: by the user's word, or without asking. */
	private committing(options: RunOptions): boolean {
		return (
			this.committer !== undefined &&
			this.createCommitter !== undefined &&
			(this.autoCommit || options.ask !== undefined)
		);
	}

	private async freeze(options: RunOptions): Promise<FrozenChanges | undefined> {
		if (!this.committer || !this.committing(options)) return undefined;
		try {
			return await this.committer.freeze(options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The committer could not read what the run changed');
		}
	}

	/**
	 * Commits what the approved run changed, once the user says so, or without asking with
	 * `autoCommit`. The run succeeds whatever git does with the commit: its files are changed and
	 * approved either way, and the report says what was committed. A git state that cannot be read
	 * ends it, as a committer that fails does, like any role.
	 */
	private async commitStage(
		prompt: string,
		{ plan, frozen }: { plan: string; frozen: FrozenChanges | undefined },
		options: RunOptions,
		totals: RunTotals,
	): Promise<CommitReport | undefined> {
		const { committer } = this;
		if (!committer || !frozen) return undefined;
		const ready = frozen.repositories.filter(
			({ paths, refused }) => paths.length > 0 && refused === undefined,
		);
		const unready = frozen.repositories.filter(each => !ready.includes(each)).map(leftIn);
		if (ready.length === 0) {
			this.warnLeft(unready);
			return { outcome: 'nothing', repositories: unready };
		}
		if (!this.autoCommit && !(await this.userCommits(ready, options))) {
			return { outcome: 'declined', repositories: [] };
		}

		const messages = new Map<string, string>();
		for (const each of ready) {
			const message = await this.messageFor(prompt, plan, each, options, totals);
			if (message !== undefined) messages.set(each.repository, message);
		}
		let committed: RepositoryCommit[];
		try {
			committed = await committer.commit(frozen, messages, options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The committer could not commit the change');
		}
		const repositories = [...committed, ...unready];
		this.warnLeft(repositories);
		return {
			outcome: committed.some(({ outcome }) => outcome === 'done') ? 'committed' : 'failed',
			repositories,
		};
	}

	/**
	 * Asks whether to commit, as `askUser` asks: a cancellation ends the run however the asker
	 * answers, and an asker that fails or answers wrongly is host code, which ends it too.
	 */
	private async userCommits(
		ready: readonly FrozenRepository[],
		{ ask, signal }: RunOptions,
	): Promise<boolean> {
		if (!ask) return false;
		const question: UserQuestion = {
			question: describeCommit(ready),
			options: [
				{ label: commitLabel, description: 'Commit the files this task changed' },
				{ label: 'Do not commit', description: 'Leave the changes uncommitted' },
			],
			multiSelect: false,
		};
		signal.throwIfAborted();
		let answers: unknown;
		try {
			answers = await ask([question], signal);
		} catch (error) {
			signal.throwIfAborted();
			throw classifyHostFailure(error, 'The asker failed');
		}
		signal.throwIfAborted();
		const read = readAnswers(answers, [question]);
		if (!read) {
			throw new UnrecoverableError('The asker failed', {
				cause: 'It must answer the question with some text.',
			});
		}
		return read[0] === commitLabel;
	}

	/** The committer's message for one repository, or `undefined` when it wrote none. */
	private async messageFor(
		prompt: string,
		plan: string,
		frozen: FrozenRepository,
		options: RunOptions,
		totals: RunTotals,
	): Promise<string | undefined> {
		const { createCommitter } = this;
		if (!createCommitter) return undefined;
		const response = await createCommitter().run(getCommitterPrompt(prompt, plan, frozen), {
			...this.optionsForRole(options, 'committer'),
			// It only writes a message: nothing to ask, nothing to approve.
			ask: undefined,
			approve: undefined,
		});
		addToTotals(totals, response);
		const message = stripCodeFence(response.response).trim();
		return message === '' ? undefined : message;
	}

	/** Tells the logger of each repository the committer made no commit in, or not as reviewed. */
	private warnLeft(repositories: readonly RepositoryCommit[]): void {
		for (const { repository, outcome, reason, unreviewed } of repositories) {
			if (outcome !== 'done') {
				this.warn(`The committer made no commit in ${repository}: ${reason ?? 'no reason given'}`);
			} else if (reason !== undefined) {
				this.warn(
					`The committer's commit in ${repository} was made, but git failed after it: ${reason}`,
				);
			}
			if (unreviewed.length > 0) {
				this.warn(
					`The committer's commit in ${repository} holds what the reviewer did not see, which a hook or a filter changed: ${unreviewed.join(', ')}`,
				);
			}
		}
	}

	private warn(...args: unknown[]): void {
		treatErrors(
			() => {
				this.logger.warn(...args);
			},
			classifyHostFailure,
			'Orchestrator logger failed while reporting a retry or a commit',
		);
	}

	/**
	 * Keep the options object extensible and the private run context intact while making the
	 * orchestrator's attribution authoritative over anything a nested agent supplied. No role
	 * reads the inbox, which only a single model-backed agent reads: what was sent stays for the
	 * next run.
	 */
	private optionsForRole(options: RunOptions, agent: ProgressAgent): RunOptions {
		const onProgress = options.onProgress;
		return {
			...options,
			inbox: undefined,
			onProgress: onProgress
				? (event: ProgressEvent) => {
						treatErrors(
							() => {
								onProgress({ ...event, agent });
							},
							classifyHostFailure,
							'Orchestrator progress callback failed',
						);
					}
				: undefined,
		};
	}
}
