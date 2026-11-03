import type {
	Agent,
	AgentResponse,
	ProgressAgent,
	ProgressEvent,
	RunOptions,
} from '#src/agent/domain/agent';
import type { CommitReport } from '#src/agent/domain/commitReport';
import { OneRunAtATime } from '#src/agent/domain/oneRunAtATime';
import { readAnswers, type UserQuestion } from '#src/agent/domain/question';
import { runContextOf } from '#src/agent/domain/runContext';
import { newSession, sessionOf } from '#src/agent/domain/session';
import { UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import type { ILogger } from '#src/shared/domain/logger';
import {
	classifyHostFailure,
	classifyLocalFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import type { Validator } from '#src/shared/domain/validator';
import { defineWorkflowStages, type WorkflowTransition } from '#src/workflow/domain/workflow';
import { type RunnableStage, WorkflowRunner } from '#src/workflow/domain/workflowRunner';
import type { ChangeLog } from './changeLog.ts';
import { CommitFlow } from './commitFlow.ts';
import type { Committer, FrozenChanges } from './committer.ts';
import {
	defaultPhaseLimits,
	type PhaseLimits,
	type PhaseReport,
	type PhaseReview,
	type Plan,
} from './phases.ts';
import type { Verification, Verifier } from './verification.ts';

const conciseCommunication =
	'Communicate tersely and professionally. In reasoning updates, state only the next concrete action or a verified finding, in one short sentence. Do not narrate routine intentions, uncertainty, self-reflection, encouragement, or a desire to be thorough. Do not restate tool results. Once you decide what to do, act immediately. Use only the detail required by your role in the final response.';

export const phasedPlannerInstructions = `You are the planner agent. Read the relevant repository code and plan the user's request in phases: each a part of the task the executor carries out, and the reviewer approves, on its own, small enough to review as one diff, in the order they must be done. A small task is one phase. The executor sees only the plan, never the request, so write each phase so it can be carried out from the plan alone: name the behaviour, the affected files or symbols, the contracts and boundaries to keep, the important failure paths and the meaningful tests. ${conciseCommunication}`;

const phasedExecutorTask = `You are the executor agent. You carry out a plan one phase at a time: change the code for the phase you are given, and nothing beyond it, since later phases come next. Read the relevant repository code first. Preserve contracts and boundaries, handle important failure paths, and add or update meaningful tests. Inspect and change the code; do not merely describe what should be done. If the phase cannot be carried out as the plan says, because the plan is wrong rather than the work hard, say so instead of forcing it. ${conciseCommunication}`;

// For an executor that can run the project's tests and checks.
export const phasedExecutorInstructions = `${phasedExecutorTask} Before you finish a phase, run the project's tests and checks, and finish only when they pass. If you cannot make them pass, finish by saying which ones fail and why.`;

// For one with no command, which cannot run anything: told so, it neither spends its steps looking
// for a way to test nor claims a result it could not have.
export const phasedExecutorInstructionsWithoutCommands = `${phasedExecutorTask} You have no command that runs the project's tests or checks, so you cannot run them. Say in your summary that they were not run.`;

const phasedReviewerTask = `Review one phase of a plan: you get the request, the plan, the phase, and the diff of what the phase changed. Independently inspect the repository and the surrounding code; do not rely on the executor's narrative. Use showChanges when you need everything the task has changed so far, such as a problem that spans phases. Judge the phase against the request and its goal and done criteria: correctness and logic errors, important failure paths, unused or artificial abstractions, races or shared state, API contract breaks, boundary violations, regressions, scope, and test quality. Do not ask for what a later phase of the plan does. Say when the plan itself is wrong for the request, so the phase cannot be right however it is done. Feedback must contain actionable engineering findings, not a general summary. ${conciseCommunication}`;

export const phasedReviewerInstructions = `You are the reviewer agent. The executor was told to run the project's tests and checks before finishing a phase, and to finish only when they pass, or to say which ones fail and why. Unless the harness's own results are given, whether they pass is the one thing to take from its summary: do not run them yourself, and do not approve a phase whose summary says that any of them fail. ${phasedReviewerTask}`;

export const phasedReviewerInstructionsWithoutCommands = `You are the reviewer agent. Nobody has run the tests or checks: the executor had no command for them. Judge from the code whether the tests it added or changed would pass, and do not approve a phase whose tests could not. ${phasedReviewerTask}`;

// The one answer that approves a plan: anything else is the user's correction, but for a stop.
const approveLabel = 'Approve';
const stopLabel = 'Stop';

/** Where a phased run stands: the plan, the phase in progress and what the run knows of it. */
interface Course {
	readonly plan: Plan;
	/** The phase in progress, by its index in the plan. */
	readonly at: number;
	/** What the executor said of each phase approved so far, in order. */
	readonly summaries: readonly string[];
	/** Rejections in a row of the phase in progress, by the checks or the reviewer. */
	readonly rejections: number;
	/** Times the phase in progress went back to the planner. */
	readonly replans: number;
	/** Where the run's record stood when the phase began, for its diff. */
	readonly mark: number;
	/** What the executor must fix first, from the checks or the reviewer. */
	readonly feedback?: string;
}

/** A phase the executor says is done. */
interface Executed extends Course {
	readonly summary: string;
}

/** A phase ready for its review: what it changed, and the evidence of its checks. */
interface Reviewing extends Executed {
	readonly diff: string;
	readonly verification?: Verification;
	/** What a commit would hold, frozen before the last phase's review. */
	readonly frozen?: FrozenChanges;
}

/** Why the planner plans: the request, the user's correction of a plan, or a phase it must rethink. */
type Planning =
	| { readonly kind: 'request' }
	| { readonly kind: 'correction'; readonly plan: Plan; readonly correction: string }
	| { readonly kind: 'replan'; readonly course: Course; readonly reason: string };

interface Stages {
	plan: Planning;
	approve: Plan;
	begin: Course;
	execute: Course;
	verify: Executed;
	review: Reviewing;
	commit: Reviewing;
}

interface Outcome {
	readonly response: string;
	readonly commits?: CommitReport;
}

type Transition = WorkflowTransition<Stages, Outcome>;

interface Totals {
	tokens: Tokens | undefined;
	unreported: boolean;
}

function renderPlan(plan: Plan, at?: number, summaries: readonly string[] = []): string {
	const phases = plan.phases.map((phase, index) => {
		const state =
			at === undefined ? '' : index < at ? ' (done)' : index === at ? ' (in progress)' : '';
		const said = summaries[index];
		return [
			`${String(index + 1)}. ${phase.goal}${state}`,
			`   Files: ${phase.files.length > 0 ? phase.files.join(', ') : 'none named'}`,
			`   Done when: ${phase.done}`,
			...(said === undefined ? [] : [`   The executor said: ${said}`]),
		].join('\n');
	});
	return `${plan.summary}\n\n${phases.join('\n')}`;
}

function phaseOf({ plan, at }: Course): string {
	const phase = plan.phases[at];
	return phase
		? `Phase ${String(at + 1)} of ${String(plan.phases.length)}: ${phase.goal}\nFiles: ${phase.files.join(', ') || 'none named'}\nDone when: ${phase.done}`
		: '';
}

function describeChecks({ checks }: Verification): string {
	return checks
		.map(({ command, status, how, output }) =>
			[
				`- ${command}: ${status}${how === undefined ? '' : `, ${how}`}`,
				...(output === undefined || output.trim() === '' ? [] : [output.trimEnd()]),
			].join('\n'),
		)
		.join('\n');
}

const planFormat = (maxPhases: number) =>
	`Answer with JSON only, at most ${String(maxPhases)} phases: {"summary":"what the task is and how the plan does it, for the user","phases":[{"goal":"what this phase achieves","files":["files it changes or creates"],"done":"what must hold for it to be done"}]}`;

const reportFormat =
	'When the phase is done, answer with JSON only: {"status":"done","summary":"what you changed, and how you checked it"}. If the plan is wrong for it, answer with JSON only: {"status":"replan","reason":"what in the plan must change, and why"}.';

const reviewFormat =
	'If the phase is correct, answer with JSON only: {"decision":"approved"}. If the work is not, answer with JSON only: {"decision":"rejected","feedback":"concrete, prioritized findings and the required direction for each"}. If the plan itself is wrong, answer with JSON only: {"decision":"replan","feedback":"what in the plan must change, and why"}.';

const plannerPrompt = (request: string, planning: Planning, maxPhases: number): string => {
	const asked = `Original user request:\n---\n${request}\n---`;
	const format = planFormat(maxPhases);
	switch (planning.kind) {
		case 'request':
			return `${asked}\n\n${format}`;
		case 'correction':
			return `${asked}\n\nYour plan:\n---\n${renderPlan(planning.plan)}\n---\n\nThe user's answer to it:\n---\n${planning.correction}\n---\n\nPlan again, with what the user said. ${format}`;
		case 'replan': {
			const { course, reason } = planning;
			return `${asked}\n\nThe plan so far:\n---\n${renderPlan(course.plan, course.at, course.summaries)}\n---\n\nPhase ${String(course.at + 1)} cannot be finished as planned:\n---\n${reason}\n---\n\nGive the phases that remain, starting with the one that replaces phase ${String(course.at + 1)}. The phases already done stay as they are; what was changed so far stays on disk. ${planFormat(maxPhases - course.at)}`;
		}
	}
};

const executorPrompt = (course: Course): string =>
	`The plan:\n---\n${renderPlan(course.plan, course.at, course.summaries)}\n---\n\nYour phase now:\n---\n${phaseOf(course)}\n---${course.feedback === undefined ? '' : `\n\nFix this first:\n---\n${course.feedback}\n---`}\n\n${reportFormat}`;

const reviewerPrompt = (request: string, input: Reviewing): string =>
	[
		`Original user request:\n---\n${request}\n---`,
		`The plan:\n---\n${renderPlan(input.plan, input.at, input.summaries)}\n---`,
		`The phase to review:\n---\n${phaseOf(input)}\n---`,
		`Executor summary (context only; verify it independently):\n---\n${input.summary}\n---`,
		...(input.verification
			? [
					`The harness ran the required checks itself, for the files as they are now; these results, not the executor's word, say whether they pass:\n---\n${describeChecks(input.verification)}\n---`,
				]
			: []),
		`What this phase changed:\n---\n${input.diff === '' ? 'Nothing the history recorded.' : input.diff}\n---`,
		reviewFormat,
	].join('\n\n');

/** Each role's events name it, over anything a nested agent supplied. */
function asRole(agent: Agent, role: ProgressAgent): Agent {
	return { run: (prompt, options) => agent.run(prompt, roleOptions(options, role)) };
}

/**
 * Keep the options object extensible and the private run context intact while making the
 * orchestrator's attribution authoritative over anything a nested agent supplied. No role
 * reads the inbox, the committer included, which runs from a code stage: what was sent stays
 * for the next run.
 */
function roleOptions(options: RunOptions, agent: ProgressAgent): RunOptions {
	const { onProgress } = options;
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

/**
 * The planner → executor → reviewer flow in phases, on the workflow primitive. The planner plans
 * the task in phases, which the user approves through `ask` when there is one. Each phase goes to
 * the executor, then to the required checks, which the harness runs itself, then to the reviewer
 * with the phase's diff. A rejection goes back to the executor with its feedback, and after a few
 * in a row to the planner, as does an executor or reviewer that says the plan is wrong. Once the
 * last phase is approved, the run commits what it changed, as `CommitFlow` does.
 */
export class PhasedOrchestrator implements Agent {
	private readonly planner: Agent;
	private readonly executor: Agent;
	private readonly reviewer: Agent;
	private readonly planValidator: Validator<Plan>;
	private readonly reportValidator: Validator<PhaseReport>;
	private readonly reviewValidator: Validator<PhaseReview>;
	private readonly changes: ChangeLog;
	private readonly verifier: Verifier | undefined;
	private readonly commits: CommitFlow;
	private readonly limits: PhaseLimits;
	private readonly logger: ILogger;
	private readonly runs = new OneRunAtATime();
	// The session its runs belong to when their options name none.
	private readonly session = newSession();

	constructor({
		planner,
		executor,
		reviewer,
		validators,
		changes,
		verifier,
		committer,
		createCommitter,
		autoCommit,
		limits = {},
		logger,
	}: {
		/** Each role's agent, kept for every run, so it goes on with its conversation. */
		planner: Agent;
		executor: Agent;
		reviewer: Agent;
		validators: {
			/** Checks a plan of at most `maxPhases` phases: the orchestrator's own limit. */
			plan: (maxPhases: number) => Validator<Plan>;
			report: Validator<PhaseReport>;
			review: Validator<PhaseReview>;
		};
		/** What each phase changed, for its reviewer. */
		changes: ChangeLog;
		/** The required checks every phase must pass before its review. None without it. */
		verifier?: Verifier;
		/** Commits what an approved run changed; with `createCommitter`, whose agent writes the message. */
		committer?: Committer;
		/** A new agent for each message, so none carries an earlier commit's diff. */
		createCommitter?: () => Agent;
		/** Commits without asking. Without it, a run with no `ask` commits nothing. */
		autoCommit?: boolean;
		limits?: Partial<PhaseLimits>;
		logger: ILogger;
	}) {
		const chosen = { ...defaultPhaseLimits, ...limits };
		for (const [name, value] of Object.entries(chosen)) {
			if (!Number.isInteger(value) || value < 1) {
				throw new RangeError(`limits.${name} must be a positive integer`);
			}
		}
		this.planner = asRole(planner, 'planner');
		this.executor = asRole(executor, 'executor');
		this.reviewer = asRole(reviewer, 'reviewer');
		this.planValidator = validators.plan(chosen.phases);
		this.reportValidator = validators.report;
		this.reviewValidator = validators.review;
		this.changes = changes;
		this.verifier = verifier;
		this.limits = chosen;
		this.logger = logger;
		this.commits = new CommitFlow({
			committer,
			createCommitter,
			autoCommit,
			warn: message => {
				this.warn(message);
			},
		});
	}

	/**
	 * Every role, phase and retry of one run shares one run context, so what the executor writes
	 * is one run of the workspace's history. The orchestrator ends that context with the run,
	 * unless an outer agent owns it.
	 *
	 * @throws {RunInProgressError} when another run on it is still working, before any role
	 * starts.
	 */
	run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		return this.runs.run(() => this.runAlone(prompt, options));
	}

	private async runAlone(request: string, options: RunOptions): Promise<AgentResponse> {
		// Per invocation, not per instance: the CLI keeps one orchestrator for a whole session.
		const spent: Totals = { tokens: undefined, unreported: false };
		// Only a run of its own: inside another agent's, the run holds that agent's changes too.
		const ownRun = runContextOf(options) === undefined;
		const workflow = new WorkflowRunner<Planning, Outcome>({
			initialStage: 'plan',
			stages: this.stagesFor(request, ownRun, spent),
			maxAttempts: 3,
			// The phases' own limits end the run; this only keeps the runner from ending it first.
			maxTransitions: Number.MAX_SAFE_INTEGER,
			logger: this.logger,
		});
		let result;
		try {
			result = await workflow.run(
				{ kind: 'request' },
				{ ...options, session: sessionOf(options) ?? this.session },
			);
		} catch (error) {
			// The committer's answers, which no stage of the workflow counts.
			throw withSpentTokens(error, spent.tokens, spent.unreported);
		}
		const { commits } = result.result;
		return {
			response: result.result.response,
			tokens:
				result.tokens === undefined || spent.unreported
					? undefined
					: addTokens(result.tokens, spent.tokens),
			duration: result.duration,
			...(result.runId === undefined ? {} : { runId: result.runId }),
			...(result.session ? { session: result.session } : {}),
			...(commits ? { commits } : {}),
		};
	}

	/** One run's stages: they close over its request and what its committer spends. */
	private stagesFor(
		request: string,
		ownRun: boolean,
		spent: Totals,
	): ReadonlyMap<string, RunnableStage> {
		const stage = defineWorkflowStages<Stages, Outcome>();
		const stages = [
			stage('plan', {
				agent: () => this.planner,
				prompt: planning => plannerPrompt(request, planning, this.limits.phases),
				validator: this.planValidator,
				transition: (plan, planning) => this.planned(plan, planning),
			}),
			stage.code('approve', { run: (plan, options) => this.approve(plan, options) }),
			stage.code('begin', {
				run: async (course, options): Promise<Transition> => ({
					type: 'go',
					stage: 'execute',
					input: { ...course, mark: await this.mark(options) },
				}),
			}),
			stage('execute', {
				agent: () => this.executor,
				prompt: executorPrompt,
				validator: this.reportValidator,
				transition: (report, course): Transition =>
					report.status === 'done'
						? { type: 'go', stage: 'verify', input: { ...course, summary: report.summary } }
						: this.toPlanner(course, `The executor: ${report.reason}`),
			}),
			stage.code('verify', { run: (executed, options) => this.verify(executed, ownRun, options) }),
			stage('review', {
				agent: () => this.reviewer,
				prompt: input => reviewerPrompt(request, input),
				validator: this.reviewValidator,
				transition: (review, input) => this.reviewed(review, input),
			}),
			stage.code('commit', {
				run: async (input, options): Promise<Transition> => ({
					type: 'complete',
					result: {
						response: finished(input),
						...(await this.commit(request, input, options, spent)),
					},
				}),
			}),
		];
		return new Map(stages.map(each => [each.name, each as RunnableStage]));
	}

	/** A first plan, or a corrected one, goes to the user; a replan replaces what is left. */
	private planned(plan: Plan, planning: Planning): Transition {
		if (planning.kind !== 'replan') return { type: 'go', stage: 'approve', input: plan };
		const { course } = planning;
		const phases = [...course.plan.phases.slice(0, course.at), ...plan.phases];
		if (phases.length > this.limits.phases) {
			return this.unfinished(
				course,
				`the plan grew past ${String(this.limits.phases)} phases, the most a run may hold`,
			);
		}
		// With no feedback: the executor gets the plan the reason changed.
		return {
			type: 'go',
			stage: 'execute',
			input: {
				plan: { summary: plan.summary, phases },
				at: course.at,
				summaries: course.summaries,
				rejections: 0,
				replans: course.replans + 1,
				mark: course.mark,
			},
		};
	}

	/**
	 * Asks the user to approve the plan when the run can ask: `Approve` carries it out, `Stop`
	 * ends the run with nothing done, and anything else is a correction the planner plans with.
	 */
	private async approve(plan: Plan, { ask, signal }: RunOptions): Promise<Transition> {
		const begin: Transition = {
			type: 'go',
			stage: 'begin',
			input: { plan, at: 0, summaries: [], rejections: 0, replans: 0, mark: 0 },
		};
		if (!ask) return begin;
		const question: UserQuestion = {
			question: `Carry out this plan?\n\n${renderPlan(plan)}`,
			options: [
				{ label: approveLabel, description: 'Carry the plan out as it is' },
				{ label: stopLabel, description: 'End the task without changing anything' },
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
		const [answer] = readAnswers(answers, [question]) ?? [];
		if (answer === undefined) {
			throw new UnrecoverableError('The asker failed', {
				cause: 'It must answer the question with some text.',
			});
		}
		if (answer === approveLabel) return begin;
		if (answer === stopLabel) {
			return { type: 'stop', result: { response: 'The user stopped the task before it began.' } };
		}
		return { type: 'go', stage: 'plan', input: { kind: 'correction', plan, correction: answer } };
	}

	/**
	 * The barrier before the review: the required checks, which the harness runs itself, must pass
	 * for the files as they are, or the phase goes back to the executor with their results.
	 */
	private async verify(
		executed: Executed,
		ownRun: boolean,
		options: RunOptions,
	): Promise<Transition> {
		let verification: Verification | undefined;
		try {
			verification = await this.verifier?.verify(options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The required checks could not run');
		}
		if (verification && !verification.met) {
			return this.rejected(
				executed,
				`The required checks do not pass for the files as they are:\n${describeChecks(verification)}`,
			);
		}
		let diff: string;
		try {
			diff = await this.changes.since(executed.mark, options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The harness could not read what the phase changed');
		}
		// Before the last review, so what is committed is what the reviewer read.
		const last = executed.at === executed.plan.phases.length - 1;
		const frozen = last && ownRun ? await this.commits.freeze(options) : undefined;
		return {
			type: 'go',
			stage: 'review',
			input: {
				...executed,
				diff,
				...(verification ? { verification } : {}),
				...(frozen ? { frozen } : {}),
			},
		};
	}

	private reviewed(review: PhaseReview, input: Reviewing): Transition {
		if (review.decision === 'rejected') return this.rejected(input, review.feedback);
		if (review.decision === 'replan')
			return this.toPlanner(input, `The reviewer: ${review.feedback}`);
		const summaries = [...input.summaries, input.summary];
		if (input.at < input.plan.phases.length - 1) {
			return {
				type: 'go',
				stage: 'begin',
				input: {
					plan: input.plan,
					at: input.at + 1,
					summaries,
					rejections: 0,
					replans: 0,
					mark: 0,
				},
			};
		}
		const done = { ...input, summaries };
		return input.frozen
			? { type: 'go', stage: 'commit', input: done }
			: { type: 'complete', result: { response: finished(done) } };
	}

	/** Back to the executor with `feedback`, or, after too many rejections in a row, to the planner. */
	private rejected(course: Course, feedback: string): Transition {
		const rejections = course.rejections + 1;
		if (rejections >= this.limits.rejections) {
			return this.toPlanner(
				course,
				`Rejected ${String(rejections)} times in a row; the last time:\n${feedback}`,
			);
		}
		return { type: 'go', stage: 'execute', input: { ...courseOf(course), rejections, feedback } };
	}

	/** To the planner to rethink the phase, or, once it has too often, the end of the run. */
	private toPlanner(course: Course, reason: string): Transition {
		if (course.replans >= this.limits.replans) return this.unfinished(course, reason);
		return {
			type: 'go',
			stage: 'plan',
			input: { kind: 'replan', course: courseOf(course), reason },
		};
	}

	/**
	 * The run ends without throwing: what the phases changed stays on disk, uncommitted, and the
	 * response says what is unfinished and why.
	 */
	private unfinished(course: Course, reason: string): Transition {
		const phase = course.plan.phases[course.at];
		const response = `The task is unfinished: phase ${String(course.at + 1)} of ${String(course.plan.phases.length)}${phase ? `, "${phase.goal}",` : ''} could not be completed after ${String(course.replans)} ${course.replans === 1 ? 'replan' : 'replans'}. The last reason:\n${reason}\nWhat the phases changed stays on disk, uncommitted.`;
		this.warn(response);
		return { type: 'stop', result: { response } };
	}

	private async mark(options: RunOptions): Promise<number> {
		try {
			return await this.changes.mark(options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The harness could not read what the run changed');
		}
	}

	private async commit(
		request: string,
		input: Reviewing,
		options: RunOptions,
		spent: Totals,
	): Promise<{ commits?: CommitReport }> {
		if (!input.frozen) return {};
		const commits = await this.commits.commit({
			prompt: request,
			plan: renderPlan(input.plan),
			frozen: input.frozen,
			options,
			committerOptions: roleOptions(options, 'committer'),
			onResponse: response => {
				if (!response.tokens) spent.unreported = true;
				spent.tokens = addTokens(spent.tokens, response.tokens);
			},
		});
		return commits ? { commits } : {};
	}

	private warn(message: string): void {
		treatErrors(
			() => {
				this.logger.warn(message);
			},
			classifyHostFailure,
			'Orchestrator logger failed while reporting a commit or an unfinished task',
		);
	}
}

/**
 * Only where the run stands, without what an attempt at the phase left, such as its diff or the
 * changes a commit would hold: the next attempt finds its own.
 */
function courseOf({ plan, at, summaries, rejections, replans, mark }: Course): Course {
	return { plan, at, summaries, rejections, replans, mark };
}

/** The run's answer once every phase is approved: each phase and what its executor said of it. */
function finished({ plan, summaries }: Course): string {
	const phases = plan.phases.map(
		(phase, index) => `${String(index + 1)}. ${phase.goal}: ${summaries[index] ?? ''}`,
	);
	return `Carried out the plan in ${String(plan.phases.length)} ${plan.phases.length === 1 ? 'phase' : 'phases'}:\n${phases.join('\n')}`;
}
