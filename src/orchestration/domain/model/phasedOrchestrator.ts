import type {
	Agent,
	AgentResponse,
	ProgressAgent,
	ProgressEvent,
	RunOptions,
} from '#src/agent/domain/agent';
import type { CommitReport } from '#src/agent/domain/commitReport';
import { type CommittedRun, withCommittedRun } from '#src/agent/domain/committedRunError';
import type { PhaseResult, Verification } from '#src/agent/domain/phaseResult';
import { OneRunAtATime } from '#src/agent/domain/oneRunAtATime';
import { readAnswers, type UserQuestion } from '#src/agent/domain/question';
import { runContextOf, withAuthor } from '#src/agent/domain/runContext';
import { newSession, sessionOf } from '#src/agent/domain/session';
import {
	InvalidAgentConfigError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/shared/domain/errors';
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
	type CommitQuestion,
	commitQuestions,
	defaultPhaseLimits,
	type PhaseLimits,
	type PhaseReport,
	type PhaseReview,
	type Plan,
} from './phases.ts';
import type { Verifier } from './verification.ts';

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

// The answers that approve a plan: anything else is the user's correction, but for a stop.
const approveLabel = 'Approve';
const stopLabel = 'Stop';
// With the commit asked about with the plan, approving also says how to commit.
const atEndLabel = 'Approve, commit at the end';
const eachPhaseLabel = 'Approve, commit each phase';
const uncommittedLabel = 'Approve, do not commit';

/** How the run commits what its phases change, as the configuration or the user chose. */
interface Committing {
	/** After each approved phase, or once the last is. */
	readonly each: boolean;
	/** Whether the user is asked before each commit. */
	readonly asks: boolean;
}

/** Where a phased run stands: the plan, the phase in progress and what the run knows of it. */
interface Course {
	readonly plan: Plan;
	/** The phase in progress, by its index in the plan. */
	readonly at: number;
	/** Each phase approved so far, in order. */
	readonly done: readonly PhaseResult[];
	/** Rejections in a row of the phase in progress, by the checks or the reviewer. */
	readonly rejections: number;
	/** Times the phase in progress went back to the planner. */
	readonly replans: number;
	/**
	 * Where the phase's diff starts in the run's record: where it stood when the first phase began,
	 * or, for a later one, when the previous phase's diff was read, so what changed during its
	 * review and the barrier after it is reviewed too.
	 */
	readonly mark: number;
	/** How the run commits; absent when it commits nothing. */
	readonly committing?: Committing;
	/** What each commit so far did, in order. */
	readonly commits: readonly CommitReport[];
	/** The required checks at the phase in progress's last barrier. */
	readonly verification?: Verification;
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
	/** Where the run's record stood when `diff` was read: the next phase's diff starts there. */
	readonly reviewed: number;
	/** What a commit after its review would hold, frozen before it. */
	readonly frozen?: FrozenChanges;
}

/** A run that ends unfinished, and why. */
interface Ending {
	readonly course: Course;
	readonly reason: string;
}

/** Why the planner plans: the request, the user's correction of a plan, or a phase it must rethink. */
type Planning =
	| { readonly kind: 'request' }
	| {
			readonly kind: 'correction';
			readonly plan: Plan;
			readonly correction: string;
			/** The user's corrections so far, this one included. */
			readonly corrections: number;
	  }
	| { readonly kind: 'replan'; readonly course: Course; readonly reason: string };

/** A plan for the user to approve, after the corrections the user has made so far. */
interface Proposed {
	readonly plan: Plan;
	readonly corrections: number;
}

interface Stages {
	plan: Planning;
	replan: Planning;
	approve: Proposed;
	begin: Course;
	execute: Course;
	verify: Executed;
	review: Reviewing;
	commit: Reviewing;
	unfinished: Ending;
}

interface Outcome {
	readonly response: string;
	readonly commits?: CommitReport;
	readonly phases?: PhaseResult[];
	readonly verification?: Verification;
}

type Transition = WorkflowTransition<Stages, Outcome>;

interface Totals {
	tokens: Tokens | undefined;
	unreported: boolean;
}

/** How far a run got, for a failure to say what it had committed. */
interface Reached {
	/** Where the run stood when its phase in progress began, or was replanned. */
	course?: Course;
	/** The run the workspace's history recorded, once the run committed. */
	runId?: string;
}

function renderPlan(plan: Plan, at?: number, done: readonly PhaseResult[] = []): string {
	const phases = plan.phases.map((phase, index) => {
		const state =
			at === undefined ? '' : index < at ? ' (done)' : index === at ? ' (in progress)' : '';
		const said = done[index]?.summary;
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
			return `${asked}\n\nThe plan so far:\n---\n${renderPlan(course.plan, course.at, course.done)}\n---\n\nPhase ${String(course.at + 1)} cannot be finished as planned:\n---\n${reason}\n---\n\nGive the phases that remain, starting with the one that replaces phase ${String(course.at + 1)}. The phases already done stay as they are; what was changed so far stays on disk. ${planFormat(maxPhases - course.at)}`;
		}
	}
};

const executorPrompt = (course: Course): string =>
	`The plan:\n---\n${renderPlan(course.plan, course.at, course.done)}\n---\n\nYour phase now:\n---\n${phaseOf(course)}\n---${course.feedback === undefined ? '' : `\n\nFix this first:\n---\n${course.feedback}\n---`}\n\n${reportFormat}`;

const reviewerPrompt = (request: string, input: Reviewing): string =>
	[
		`Original user request:\n---\n${request}\n---`,
		`The plan:\n---\n${renderPlan(input.plan, input.at, input.done)}\n---`,
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

/** Each role's events name it, over anything a nested agent supplied, and so do its changes. */
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
	return withAuthor(
		{
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
		},
		agent,
	);
}

/**
 * The planner → executor → reviewer flow in phases, on the workflow primitive. The planner plans
 * the task in phases, which the user approves through `ask` when there is one. Each phase goes to
 * the executor, then to the required checks, which the harness runs itself, then to the reviewer
 * with the phase's diff. A rejection goes back to the executor with its feedback, and after a few
 * in a row to the planner, as does an executor or reviewer that says the plan is wrong. The run
 * commits once at the end, after each phase, or as the user chose with the plan, as `CommitFlow`
 * does, once the required checks pass again.
 */
export class PhasedOrchestrator implements Agent {
	private readonly planner: Agent;
	private readonly executor: Agent;
	private readonly reviewer: Agent;
	private readonly planValidator: Validator<Plan>;
	private readonly replanValidator: Validator<Plan>;
	private readonly reportValidator: Validator<PhaseReport>;
	private readonly reviewValidator: Validator<PhaseReview>;
	private readonly changes: ChangeLog;
	private readonly verifier: Verifier | undefined;
	private readonly commits: CommitFlow;
	private readonly autoCommit: boolean;
	private readonly commitQuestion: CommitQuestion;
	private readonly limits: PhaseLimits;
	private readonly logger: ILogger;
	private readonly runs = new OneRunAtATime();
	// The session its runs belong to when their options name none.
	private readonly session = newSession();

	/**
	 * @throws {InvalidAgentConfigError} for a limit that is not a positive integer, or names no
	 * limit, a `commitQuestion` that is not one, or `plan` with `autoCommit`.
	 */
	constructor({
		planner,
		executor,
		reviewer,
		validators,
		changes,
		verifier,
		committer,
		createCommitter,
		autoCommit = false,
		commitQuestion = 'end',
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
		/**
		 * The required checks every phase must pass before its review, and again before a commit.
		 * None without it.
		 */
		verifier?: Verifier;
		/** Commits what an approved run changed; with `createCommitter`, whose agent writes the message. */
		committer?: Committer;
		/** A new agent for each message, so none carries an earlier commit's diff. */
		createCommitter?: () => Agent;
		/** Commits without asking. Without it, a run with no `ask` commits nothing. */
		autoCommit?: boolean;
		commitQuestion?: CommitQuestion;
		limits?: Partial<PhaseLimits>;
		logger: ILogger;
	}) {
		const chosen = phaseLimits(limits);
		if (!commitQuestions.includes(commitQuestion)) {
			throw new InvalidAgentConfigError(
				`commitQuestion must be one of: ${commitQuestions.join(', ')}`,
			);
		}
		if (autoCommit && commitQuestion === 'plan') {
			throw new InvalidAgentConfigError(
				'commitQuestion "plan" asks the user how to commit, and autoCommit asks nothing',
			);
		}
		this.planner = asRole(planner, 'planner');
		this.executor = asRole(executor, 'executor');
		this.reviewer = asRole(reviewer, 'reviewer');
		this.planValidator = validators.plan(chosen.phases);
		// A replan's phases count with the ones done, so `planned` holds it to the limit: a plan
		// grown past it ends the run unfinished instead of being asked again.
		this.replanValidator = validators.plan(Number.MAX_SAFE_INTEGER);
		this.reportValidator = validators.report;
		this.reviewValidator = validators.review;
		this.changes = changes;
		this.verifier = verifier;
		this.autoCommit = autoCommit;
		this.commitQuestion = commitQuestion;
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
	 * @throws {RecoverableCommittedRunError | UnrecoverableCommittedRunError} for a failure that
	 * ends a run after one of its phases was committed, of the failure's own kind, with what the
	 * run committed.
	 */
	run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		return this.runs.run(() => this.runAlone(prompt, options));
	}

	private async runAlone(request: string, options: RunOptions): Promise<AgentResponse> {
		// Per invocation, not per instance: the CLI keeps one orchestrator for a whole session.
		const spent: Totals = { tokens: undefined, unreported: false };
		const reached: Reached = {};
		// Only a run of its own: inside another agent's, the run holds that agent's changes too.
		const ownRun = runContextOf(options) === undefined;
		const workflow = new WorkflowRunner<Planning, Outcome>({
			initialStage: 'plan',
			stages: this.stagesFor(request, ownRun, spent, reached),
			maxAttempts: 3,
			// The corrections' and the phases' own limits end the run; this only keeps the runner
			// from ending it first.
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
			// The committer's answers, which no stage of the workflow counts, and what the phases
			// committed, which stays in git.
			throw withCommittedRun(
				withSpentTokens(error, spent.tokens, spent.unreported),
				committedRun(reached),
			);
		}
		const { commits, phases, verification } = result.result;
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
			...(phases ? { phases } : {}),
			...(verification ? { verification } : {}),
		};
	}

	/** One run's stages: they close over its request, what its committer spends and how far it got. */
	private stagesFor(
		request: string,
		ownRun: boolean,
		spent: Totals,
		reached: Reached,
	): ReadonlyMap<string, RunnableStage> {
		const stage = defineWorkflowStages<Stages, Outcome>();
		const plan = (validator: Validator<Plan>) => ({
			agent: () => this.planner,
			prompt: (planning: Planning) => plannerPrompt(request, planning, this.limits.phases),
			validator,
			transition: (answer: Plan, planning: Planning): Transition => {
				const next = this.planned(answer, planning);
				if (next.type === 'go' && next.stage === 'execute') reached.course = next.input;
				return next;
			},
		});
		const stages = [
			stage('plan', plan(this.planValidator)),
			stage('replan', plan(this.replanValidator)),
			stage.code('approve', {
				run: (proposed, options) => this.approve(proposed, ownRun, options),
			}),
			stage.code('begin', {
				run: (course): Promise<Transition> => {
					reached.course = course;
					return Promise.resolve({ type: 'go', stage: 'execute', input: course });
				},
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
			stage.code('verify', { run: (executed, options) => this.verify(executed, options) }),
			stage('review', {
				agent: () => this.reviewer,
				prompt: input => reviewerPrompt(request, input),
				validator: this.reviewValidator,
				transition: (review, input) => this.reviewed(review, input),
			}),
			stage.code('commit', {
				run: (input, options) => this.commit(request, input, options, spent, reached),
			}),
			stage.code('unfinished', {
				run: async ({ course, reason }, options) =>
					this.ended(course, reason, await this.check(options)),
			}),
		];
		return new Map(stages.map(each => [each.name, each as RunnableStage]));
	}

	/** A first plan, or a corrected one, goes to the user; a replan replaces what is left. */
	private planned(plan: Plan, planning: Planning): Transition {
		if (planning.kind !== 'replan') {
			const corrections = planning.kind === 'correction' ? planning.corrections : 0;
			return { type: 'go', stage: 'approve', input: { plan, corrections } };
		}
		const { course } = planning;
		const phases = [...course.plan.phases.slice(0, course.at), ...plan.phases];
		if (phases.length > this.limits.phases) {
			return this.unfinished(
				{ ...course, replans: course.replans + 1 },
				`${planning.reason}\nThe new plan grew past ${String(this.limits.phases)} phases, the most a run may hold.`,
			);
		}
		// With no feedback: the executor gets the plan the reason changed.
		return {
			type: 'go',
			stage: 'execute',
			input: {
				...courseOf(course),
				plan: { summary: plan.summary, phases },
				rejections: 0,
				replans: course.replans + 1,
			},
		};
	}

	/**
	 * Asks the user to approve the plan when the run can ask: `Approve` carries it out, `Stop`
	 * ends the run with nothing done, and anything else is a correction the planner plans with.
	 * When the commit is asked about with the plan, approving also says how to commit.
	 */
	private async approve(
		{ plan, corrections }: Proposed,
		ownRun: boolean,
		options: RunOptions,
	): Promise<Transition> {
		const { ask, signal } = options;
		// Only a run of its own commits: inside another agent's, the run holds that agent's changes
		// too.
		const commits = ownRun && this.commits.committing(options);
		const choosing = commits && this.commitQuestion === 'plan';
		const configured: Committing | undefined =
			commits && !choosing
				? { each: this.commitQuestion === 'phase', asks: !this.autoCommit }
				: undefined;
		const begin = async (committing: Committing | undefined): Promise<Transition> => ({
			type: 'go',
			stage: 'begin',
			input: {
				plan,
				at: 0,
				done: [],
				rejections: 0,
				replans: 0,
				// Not the run's start: inside another agent's run, its record holds that agent's
				// changes too.
				mark: await this.mark(options),
				commits: [],
				...(committing ? { committing } : {}),
			},
		});
		if (!ask) return begin(configured);
		const stop = { label: stopLabel, description: 'End the task without changing anything' };
		const question: UserQuestion = {
			question: `Carry out this plan?\n\n${renderPlan(plan)}`,
			options: choosing
				? [
						{ label: atEndLabel, description: 'Carry the plan out, then commit it all at once' },
						{
							label: eachPhaseLabel,
							description: 'Carry the plan out, committing each phase once it is approved',
						},
						{
							label: uncommittedLabel,
							description: 'Carry the plan out, and leave the changes uncommitted',
						},
						stop,
					]
				: [{ label: approveLabel, description: 'Carry the plan out as it is' }, stop],
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
		if (answer === stopLabel) {
			return {
				type: 'stop',
				result: { response: 'The user stopped the task before it began.', phases: pending(plan) },
			};
		}
		if (choosing) {
			if (answer === atEndLabel) return begin({ each: false, asks: false });
			if (answer === eachPhaseLabel) return begin({ each: true, asks: false });
			if (answer === uncommittedLabel) return begin(undefined);
		} else if (answer === approveLabel) {
			return begin(configured);
		}
		if (corrections >= this.limits.corrections) {
			const response = `The task ends with nothing changed: the plan was corrected ${String(corrections)} ${corrections === 1 ? 'time' : 'times'}, the most a run may take, and the last answer was not to approve it either:\n${answer}`;
			this.warn(response);
			return { type: 'stop', result: { response, phases: pending(plan) } };
		}
		return {
			type: 'go',
			stage: 'plan',
			input: { kind: 'correction', plan, correction: answer, corrections: corrections + 1 },
		};
	}

	/**
	 * The barrier before the review: the required checks, which the harness runs itself, must pass
	 * for the files as they are, or the phase goes back to the executor with their results. Then
	 * what a commit after the review would hold is frozen, so it is what the reviewer read.
	 */
	private async verify(executed: Executed, options: RunOptions): Promise<Transition> {
		const verification = await this.check(options);
		const checked = verification ? { ...executed, verification } : executed;
		if (verification && !verification.met) {
			return this.rejected(
				checked,
				`The required checks do not pass for the files as they are:\n${describeChecks(verification)}`,
			);
		}
		let diff: string;
		// Nothing writes between the two: the executor is done, and the checks have run.
		const reviewed = await this.mark(options);
		try {
			diff = await this.changes.since(executed.mark, options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The harness could not read what the phase changed');
		}
		const frozen = commitsAfter(executed) ? await this.commits.freeze(options) : undefined;
		return {
			type: 'go',
			stage: 'review',
			input: { ...checked, diff, reviewed, ...(frozen ? { frozen } : {}) },
		};
	}

	private reviewed(review: PhaseReview, input: Reviewing): Transition {
		if (review.decision === 'rejected') return this.rejected(input, review.feedback);
		if (review.decision === 'replan')
			return this.toPlanner(input, `The reviewer: ${review.feedback}`);
		// The last phase checks again even with no commit, so the run ends on the files as they are.
		const last = input.at === input.plan.phases.length - 1;
		return input.frozen || (last && this.verifier)
			? { type: 'go', stage: 'commit', input }
			: approved(input);
	}

	/**
	 * The barrier after the review, before a commit or the end of the run, since a command the
	 * reviewer ran may have changed what the checks saw: a check that no longer passes sends the
	 * phase back to the executor, as a rejection. Then the commit, when one follows, and the next
	 * phase or the end of the run.
	 */
	private async commit(
		request: string,
		input: Reviewing,
		options: RunOptions,
		spent: Totals,
		reached: Reached,
	): Promise<Transition> {
		const verification = await this.check(options);
		const checked = verification ? { ...input, verification } : input;
		if (verification && !verification.met) {
			return this.rejected(
				checked,
				`After the review, the required checks do not pass for the files as they are:\n${describeChecks(verification)}`,
			);
		}
		const { frozen, committing } = input;
		if (!frozen || !committing) return approved(checked);
		const phase = `phase ${String(input.at + 1)} of ${String(input.plan.phases.length)}, "${goalOf(input)}"`;
		const commits = await this.commits.commit({
			prompt: request,
			plan: committing.each
				? `${renderPlan(input.plan, input.at, input.done)}\n\nThis commit is for ${phase}, and any earlier phase left uncommitted.`
				: renderPlan(input.plan),
			frozen,
			asks: committing.asks,
			approved: committing.each ? phase : 'the change',
			options,
			committerOptions: roleOptions(options, 'committer'),
			onResponse: response => {
				if (!response.tokens) spent.unreported = true;
				spent.tokens = addTokens(spent.tokens, response.tokens);
			},
		});
		reached.runId = runContextOf(options)?.firstRunId;
		return approved(checked, commits);
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
			stage: 'replan',
			input: { kind: 'replan', course: courseOf(course), reason },
		};
	}

	/** The run ends unfinished, once its required checks say how the files stand. */
	private unfinished(course: Course, reason: string): Transition {
		return { type: 'go', stage: 'unfinished', input: { course: courseOf(course), reason } };
	}

	/**
	 * The run ends without throwing: what the phases changed and nothing committed stays on disk,
	 * and the response says what is unfinished, why, and which required checks do not pass for
	 * the files as they are.
	 */
	private ended(at: Course, reason: string, checked: Verification | undefined): Transition {
		const course = checked ? { ...at, verification: checked } : at;
		const phase = course.plan.phases[course.at];
		const { verification } = course;
		const failing = verification?.checks.filter(({ status }) => status !== 'passed') ?? [];
		const unmet =
			failing.length === 0
				? ''
				: `\nThe required checks that do not pass: ${failing.map(({ command, status }) => `${command} (${status})`).join(', ')}.`;
		const committed = course.commits.some(({ outcome }) => outcome === 'committed');
		const response = `The task is unfinished: phase ${String(course.at + 1)} of ${String(course.plan.phases.length)}${phase ? `, "${phase.goal}",` : ''} could not be completed after ${String(course.replans)} ${course.replans === 1 ? 'replan' : 'replans'}. The last reason:\n${reason}${unmet}\n${committed ? 'What the phases committed stays committed; the rest stays on disk, uncommitted.' : 'What the phases changed stays on disk, uncommitted.'}`;
		this.warn(response);
		const commits = allCommits(course.commits);
		return {
			type: 'stop',
			result: {
				response,
				phases: phasesOf(course),
				...(commits ? { commits } : {}),
				...(verification ? { verification } : {}),
			},
		};
	}

	private async mark(options: RunOptions): Promise<number> {
		try {
			return await this.changes.mark(options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The harness could not read what the run changed');
		}
	}

	/** Where the required checks stand now, run by the harness where they must be; none without a verifier. */
	private async check(options: RunOptions): Promise<Verification | undefined> {
		try {
			return await this.verifier?.verify(options);
		} catch (error) {
			throw classifyLocalFailure(error, 'The required checks could not run');
		}
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
 * The limits a run keeps, each given one a positive integer.
 *
 * A limit given as `undefined` keeps its default.
 *
 * @throws {InvalidAgentConfigError} for one that is not, or a name that is no limit.
 */
function phaseLimits(limits: unknown): PhaseLimits {
	// Typed, but it may come from a JSON file.
	if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
		throw new InvalidAgentConfigError('limits must be an object');
	}
	const given: Partial<Record<keyof PhaseLimits, number>> = {};
	for (const [name, value] of Object.entries(limits)) {
		// Own entries only, as from a JSON file: an inherited name such as "constructor" is no limit.
		if (!Object.hasOwn(defaultPhaseLimits, name)) {
			throw new InvalidAgentConfigError(
				`limits.${name} is not a limit; expected one of: ${Object.keys(defaultPhaseLimits).join(', ')}`,
			);
		}
		// Given as `undefined`, as from optional settings, it keeps its default.
		if (value === undefined) continue;
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
			throw new InvalidAgentConfigError(`limits.${name} must be a positive integer`);
		}
		given[name as keyof PhaseLimits] = value;
	}
	return { ...defaultPhaseLimits, ...given };
}

/** Whether the phase's review is followed by a commit: every phase's, or the last one's. */
function commitsAfter(course: Course): boolean {
	return (
		course.committing !== undefined &&
		(course.committing.each || course.at === course.plan.phases.length - 1)
	);
}

/** The phase approved, with its commit when it had one, and the next phase, or the end. */
function approved(input: Reviewing, commits?: CommitReport): Transition {
	const result: PhaseResult = {
		goal: goalOf(input),
		status: 'approved',
		summary: input.summary,
		...(input.verification ? { verification: input.verification } : {}),
		...(commits && input.committing?.each ? { commits } : {}),
	};
	const done = [...input.done, result];
	const made = commits ? [...input.commits, commits] : input.commits;
	if (input.at < input.plan.phases.length - 1) {
		return {
			type: 'go',
			stage: 'begin',
			input: {
				plan: input.plan,
				at: input.at + 1,
				done,
				rejections: 0,
				replans: 0,
				mark: input.reviewed,
				commits: made,
				...(input.committing ? { committing: input.committing } : {}),
			},
		};
	}
	const all = allCommits(made);
	return {
		type: 'complete',
		result: {
			response: finished(input.plan, done),
			phases: done,
			...(all ? { commits: all } : {}),
			...(input.verification ? { verification: input.verification } : {}),
		},
	};
}

/**
 * Only where the run stands, without what an attempt at the phase left, such as its diff or the
 * changes a commit would hold: the next attempt finds its own.
 */
function courseOf({
	plan,
	at,
	done,
	rejections,
	replans,
	mark,
	committing,
	commits,
	verification,
}: Course): Course {
	return {
		plan,
		at,
		done,
		rejections,
		replans,
		mark,
		commits,
		...(committing ? { committing } : {}),
		...(verification ? { verification } : {}),
	};
}

function goalOf({ plan, at }: Course): string {
	return plan.phases[at]?.goal ?? '';
}

/** Every phase of a plan the run ended before beginning. */
function pending(plan: Plan): PhaseResult[] {
	return plan.phases.map(({ goal }) => ({ goal, status: 'pending' }));
}

/** Each phase of a run that ended in the phase in progress. */
function phasesOf(course: Course): PhaseResult[] {
	const { plan, at, done, verification } = course;
	return plan.phases.map(({ goal }, index): PhaseResult => {
		const approvedOne = done[index];
		if (index < at && approvedOne) return approvedOne;
		if (index === at) {
			return { goal, status: 'unfinished', ...(verification ? { verification } : {}) };
		}
		return { goal, status: 'pending' };
	});
}

/** What a run that failed had committed, when it committed anything. */
function committedRun({ course, runId }: Reached): CommittedRun | undefined {
	const commits = course && allCommits(course.commits);
	if (!course || !commits) return undefined;
	return { commits, phases: phasesOf(course), ...(runId === undefined ? {} : { runId }) };
}

/**
 * The run's commits as one report: committed when any commit was made, failed when none was and
 * one failed, declined when the user declined, and every repository of each in order.
 */
function allCommits(reports: readonly CommitReport[]): CommitReport | undefined {
	if (reports.length <= 1) return reports[0];
	const outcomes = new Set(reports.map(({ outcome }) => outcome));
	const outcome =
		(['committed', 'failed', 'declined'] as const).find(each => outcomes.has(each)) ?? 'nothing';
	return { outcome, repositories: reports.flatMap(({ repositories }) => repositories) };
}

/** The run's answer once every phase is approved: each phase and what its executor said of it. */
function finished(plan: Plan, done: readonly PhaseResult[]): string {
	const phases = plan.phases.map(
		(phase, index) => `${String(index + 1)}. ${phase.goal}: ${done[index]?.summary ?? ''}`,
	);
	return `Carried out the plan in ${String(plan.phases.length)} ${plan.phases.length === 1 ? 'phase' : 'phases'}:\n${phases.join('\n')}`;
}
