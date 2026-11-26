import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	type AgentResponse,
	type Asker,
	createLLMOrchestrator,
	type RunEntry,
	type SessionSnapshot,
	type Verification,
} from '../../src/index.ts';
import { orchestratorRolesFor } from '../../src/factory/infrastructure/agentFactory.ts';
import { orchestratorRolesOf } from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { reviewerPrompt } from '../../src/orchestration/domain/model/phasedOrchestrator.ts';
import {
	gradeFeedback,
	gradePlan,
	gradeRubric,
	type Item,
	itemsOf,
	type FeedbackVerdict,
	type Judged,
	type JudgeName,
	planCoverage,
	type PlanVerdict,
	rubricScore,
	type RubricVerdict,
} from './judge.ts';
import { type AgentModels, metricsOf, type RunMetrics } from './metrics.ts';
import { type CheckName, checkNames, type Task, taskFile } from './tasks.ts';
import {
	applyOverlay,
	changesSinceStart,
	forbiddenMatches,
	prepareWorkspace,
	removeWorkspace,
	restoreConfiguration,
	runCheck,
	stateDirectoryOf,
	taskCommands,
	taskFormatter,
	testFiles,
} from './workspace.ts';

/** The role configurations `createLLMOrchestrator` offers: a provider for every role, or its mix. */
export const profiles = ['default', 'anthropic', 'openai'] as const;
export type Profile = (typeof profiles)[number];

/** How one eval run is set up. */
export interface RunSettings {
	profile: Profile;
	/** Where this run's files go: its result, its records and the workspace it left. */
	folder: string;
	/** The judges that grade quality; none to skip grading. */
	judges: readonly JudgeName[];
	/** Replaces the task's pause between prompts, to try a task quickly. */
	pauseMinutes?: number;
}

// The explorers the roles send, on their provider's cheap model, as `createLLMOrchestrator` builds them.
const explorerModels = { anthropic: 'haiku', openai: 'gpt-5.6-luna' } as const;

/** The model of each agent a run of `profile` may call, to price its steps. */
export function modelsOf(profile: Profile): AgentModels {
	const roles = orchestratorRolesFor(profile === 'default' ? undefined : profile);
	const models: AgentModels = {};
	for (const [role, { provider, model }] of Object.entries(roles)) {
		models[role] = model;
		models[`${role}/explorer`] = explorerModels[provider];
	}
	return models;
}

/** Collects a run's record in memory and in a file, one JSON line per entry. */
class Recorder {
	readonly entries: RunEntry[] = [];
	readonly file: string;

	constructor(file: string) {
		this.file = file;
		writeFileSync(file, '');
	}

	readonly take = (entry: RunEntry): void => {
		this.entries.push(entry);
		appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
	};
}

/** What the tests the agent never saw say about its result. */
export interface HiddenTests {
	passed: number;
	total: number;
	failed: string[];
}

interface VitestReport {
	testResults?: {
		name?: string;
		status?: string;
		message?: string;
		assertionResults?: { status?: string; fullName?: string }[];
	}[];
}

/** Copies the task's hidden tests in and runs them alone. */
export function runHidden(task: Task, workspace: string, folder: string): HiddenTests | undefined {
	if (task.hidden === undefined) return undefined;
	applyOverlay(task, workspace, task.hidden);
	const report = join(folder, 'hidden-tests.json');
	const run = runCheck(workspace, 'test', [
		'--reporter=json',
		`--outputFile=${report}`,
		'tests/hidden',
	]);
	let parsed: VitestReport = {};
	try {
		parsed = JSON.parse(readFileSync(report, 'utf8')) as VitestReport;
	} catch {
		// Vitest writes no report when the tests cannot even load: every hidden test failed.
	}
	const files = parsed.testResults ?? [];
	const results = files.flatMap(file => file.assertionResults ?? []);
	const failed = results.flatMap(result =>
		result.status === 'passed' ? [] : [result.fullName ?? 'a test that did not load'],
	);
	// A file that failed with none of its tests failing did not load, or failed outside a test.
	const brokenFiles = files.flatMap(file =>
		file.status === 'failed' &&
		(file.assertionResults ?? []).every(test => test.status === 'passed')
			? [`${file.name ?? 'a hidden test file'}: ${file.message ?? 'it failed outside its tests'}`]
			: [],
	);
	// Vitest fails a run for what no test owns, such as an error thrown after the test that caused it.
	const outside =
		!run.passed && failed.length === 0 && brokenFiles.length === 0
			? [`Vitest failed the run outside any test:\n${run.output.slice(-2000)}`]
			: [];
	const extra = [...brokenFiles, ...outside];
	return {
		passed: results.filter(result => result.status === 'passed').length,
		total: Math.max(results.length + extra.length, 1),
		failed: [...failed, ...extra],
	};
}

/** Which mutants the agent's own tests caught, each a version of one file with one bug. */
export interface Mutants {
	killed: string[];
	survived: string[];
	/**
	 * The tests passed on the file as the agents left it, and on the reference's, which every mutant
	 * is a copy of with one bug. Without both, a failing run may only say the tests expect the
	 * agents' own implementation, so no mutant counts as killed.
	 */
	baselinePassed: boolean;
}

/**
 * Swaps each mutant in for its target and runs `tests`, by default the agent's own: a failing run
 * kills it.
 */
export function runMutants(
	task: Task,
	workspace: string,
	tests: readonly string[] = testFiles(workspace),
): Mutants | undefined {
	if (task.mutants === undefined) return undefined;
	const { target, directory } = task.mutants;
	const names = readdirSync(join(task.directory, directory)).sort();
	const file = join(workspace, target);
	// The agents may never have written it: then no test of theirs can kill a mutant of it.
	if (!existsSync(file)) return { killed: [], survived: names, baselinePassed: false };
	const original = readFileSync(file);
	const passWith = (content: Buffer): boolean => {
		writeFileSync(file, content);
		return tests.length > 0 && runCheck(workspace, 'test', [...tests]).passed;
	};
	const killed: string[] = [];
	const survived: string[] = [];
	let baselinePassed: boolean;
	try {
		baselinePassed =
			passWith(original) &&
			passWith(readFileSync(join(task.directory, task.reference ?? '', target)));
		for (const name of names) {
			if (!baselinePassed) {
				survived.push(name);
				continue;
			}
			const caught = !passWith(readFileSync(join(task.directory, directory, name)));
			(caught ? killed : survived).push(name);
		}
	} finally {
		writeFileSync(file, original);
	}
	return { killed, survived, baselinePassed };
}

/** The average of the judges' scores, from 0 to 1, over the judges that answered. */
export function meanScore(
	judged: readonly Judged<RubricVerdict>[],
	rubric: readonly Item[],
): number | undefined {
	const answered = judged.flatMap(each => ('verdict' in each ? [each.verdict] : []));
	if (answered.length === 0) return undefined;
	return answered.reduce((sum, verdict) => sum + rubricScore(verdict, rubric), 0) / answered.length;
}

/** The result of one run of a `task` task. */
export interface TaskResult {
	kind: 'task';
	/** Per prompt, in order. */
	prompts: { metrics: RunMetrics; seconds: number; response?: AgentResponse }[];
	/** Every prompt's metrics, summed where they add up. */
	cost: number | undefined;
	hidden?: HiddenTests;
	checks: Record<CheckName, boolean>;
	forbidden: string[];
	/**
	 * Configuration files the run changed or added, such as the ESLint or TypeScript settings. They
	 * are put back before the checks, which judge the code by the task's own rules, and a run that
	 * changed any did not pass.
	 */
	configurationChanged: string[];
	mutants?: Mutants;
	/** The reviewer approved every phase of the last prompt, yet a hidden test or a check fails. */
	falseApproval: boolean;
	/**
	 * Passed: every hidden test and every check pass, by the task's own configuration, which the
	 * run left as it was, and nothing forbidden is left.
	 */
	passed: boolean;
	quality?: { score: number | undefined; judges: Judged<RubricVerdict>[] };
	workspace: string;
}

/** Runs a task's prompts through `createLLMOrchestrator`, then checks and grades the result. */
export async function runTask(task: Task, settings: RunSettings): Promise<TaskResult> {
	const workspace = prepareWorkspace(task);
	const models = modelsOf(settings.profile);
	const options = {
		...(settings.profile === 'default' ? {} : { provider: settings.profile }),
		workspace: {
			roots: [{ path: workspace, access: 'write' as const }],
			stateDirectory: stateDirectoryOf(workspace),
		},
		commands: taskCommands(),
		formatter: taskFormatter,
		requiredChecks: task.checks.map(command => ({ command })),
		autoApprove: true,
	};
	const pause = settings.pauseMinutes ?? task.pauseMinutes;
	const prompts: TaskResult['prompts'] = [];
	let agent = await createLLMOrchestrator(options);
	for (const [index, file] of task.prompts.entries()) {
		if (index > 0) {
			if (pause > 0) await sleep(pause * 60_000);
			if (task.restoreBetween) {
				// As a server would: the session through JSON, into an orchestrator built afresh.
				const restore = JSON.parse(JSON.stringify(agent.snapshot())) as SessionSnapshot;
				agent = await createLLMOrchestrator({ ...options, restore });
			}
		}
		const recorder = new Recorder(join(settings.folder, `record-${String(index + 1)}.jsonl`));
		const started = Date.now();
		let response: AgentResponse | undefined;
		try {
			response = await agent.run(taskFile(task, file), {
				signal: AbortSignal.timeout(90 * 60_000),
				onRecord: recorder.take,
			});
		} catch {
			// The record's end says how the run failed.
		}
		prompts.push({
			metrics: metricsOf(recorder.entries, models),
			seconds: (Date.now() - started) / 1000,
			...(response ? { response } : {}),
		});
	}

	const diff = changesSinceStart(workspace);
	writeFileSync(join(settings.folder, 'changes.diff'), diff);
	// The checks judge by the task's rules: a run that relaxed them gets them back, and fails.
	const configurationChanged = restoreConfiguration(workspace);
	// The checks see what the agent left, before the hidden tests are copied in.
	const checks = Object.fromEntries(
		checkNames.map(check => [check, runCheck(workspace, check).passed]),
	) as Record<CheckName, boolean>;
	const hidden = runHidden(task, workspace, settings.folder);
	const forbidden = forbiddenMatches(workspace, task.forbidden);
	const mutants = runMutants(task, workspace);
	const passed =
		(hidden === undefined || hidden.passed === hidden.total) &&
		Object.values(checks).every(Boolean) &&
		forbidden.length === 0 &&
		configurationChanged.length === 0;
	const last = prompts.at(-1)?.response;
	const approvedAll =
		last?.phases !== undefined &&
		last.phases.length > 0 &&
		last.phases.every(phase => phase.status === 'approved');

	let quality: TaskResult['quality'];
	if (task.rubric !== undefined && settings.judges.length > 0) {
		const request = task.prompts.map(file => taskFile(task, file)).join('\n\nThen:\n\n');
		const rubric = itemsOf(taskFile(task, task.rubric));
		const judged = await gradeRubric(request, rubric, diff, settings.judges);
		quality = { score: meanScore(judged, rubric), judges: judged };
	}

	return {
		kind: 'task',
		prompts,
		cost: prompts.reduce<number | undefined>(
			(sum, { metrics }) =>
				sum === undefined || metrics.cost === undefined ? undefined : sum + metrics.cost,
			0,
		),
		...(hidden ? { hidden } : {}),
		checks,
		forbidden,
		configurationChanged,
		...(mutants ? { mutants } : {}),
		falseApproval: approvedAll && !passed,
		passed,
		...(quality ? { quality } : {}),
		workspace,
	};
}

/** The result of one run of a `plan` task. */
export interface PlanResult {
	kind: 'plan';
	metrics: RunMetrics;
	seconds: number;
	/** The plan the orchestrator asked to carry out, as the user would have read it. */
	plan?: string;
	/** Of the checklist's items, the share the judges found covered, on average. */
	coverage?: number;
	judges: Judged<PlanVerdict>[];
	workspace: string;
}

const planQuestion = 'Carry out this plan?';

/**
 * Runs the orchestrator on the task's prompt and stops it when it asks to carry out its plan, so
 * only the planner, and the explorers it sends, work. Any other question gets an answer that
 * leaves the decision to the agent.
 */
export async function runPlan(task: Task, settings: RunSettings): Promise<PlanResult> {
	const workspace = prepareWorkspace(task);
	let plan: string | undefined;
	const ask: Asker = questions =>
		questions.map(({ question }) => {
			if (!question.startsWith(planQuestion)) {
				return 'Decide yourself: the request says everything there is to say.';
			}
			plan = question.slice(planQuestion.length).trim();
			return 'Stop';
		});
	const agent = await createLLMOrchestrator({
		...(settings.profile === 'default' ? {} : { provider: settings.profile }),
		workspace: {
			roots: [{ path: workspace, access: 'write' }],
			stateDirectory: stateDirectoryOf(workspace),
		},
		commands: taskCommands(),
		autoApprove: true,
	});
	const request = taskFile(task, task.prompts[0] ?? '');
	const recorder = new Recorder(join(settings.folder, 'record-1.jsonl'));
	const started = Date.now();
	try {
		await agent.run(request, {
			signal: AbortSignal.timeout(30 * 60_000),
			ask,
			onRecord: recorder.take,
		});
	} catch {
		// The record's end says how the run failed.
	}
	const seconds = (Date.now() - started) / 1000;
	const metrics = metricsOf(recorder.entries, modelsOf(settings.profile));
	const checklist = itemsOf(taskFile(task, task.checklist ?? ''));
	const judged =
		plan === undefined || settings.judges.length === 0
			? []
			: await gradePlan(request, checklist, plan, settings.judges);
	const answered = judged.flatMap(each => ('verdict' in each ? [each.verdict] : []));
	const coverage =
		answered.length === 0
			? undefined
			: answered.reduce((sum, verdict) => sum + planCoverage(verdict, checklist), 0) /
				answered.length;
	if (plan !== undefined) writeFileSync(join(settings.folder, 'plan.md'), plan);
	return {
		kind: 'plan',
		metrics,
		seconds,
		...(plan === undefined ? {} : { plan }),
		...(coverage === undefined ? {} : { coverage }),
		judges: judged,
		workspace,
	};
}

/** How the reviewer judged one known change. */
export interface ReviewCaseResult {
	name: string;
	expected: 'approved' | 'rejected';
	/** What it answered: a decision, or `none` when no decision could be read. */
	decision: 'approved' | 'rejected' | 'replan' | 'none';
	feedback?: string;
	/** For a change with a bug it rejected: whether the judges found the bug in its feedback. */
	found?: { judges: Judged<FeedbackVerdict>[]; agreed: boolean | undefined };
	/** Its decision matched, and for a bug, its feedback named it. */
	correct: boolean;
	metrics: RunMetrics;
	seconds: number;
}

/** The result of one run of a `review` task. */
export interface ReviewResult {
	kind: 'review';
	cases: ReviewCaseResult[];
	/** Changes with a bug the reviewer rejected for that bug, of those with one. */
	recall: number;
	/** Correct changes the reviewer rejected, of those without a bug. */
	falseAlarms: number;
	cost: number | undefined;
}

/** The harness's own verdict on each check, as the orchestrator gives it to the reviewer. */
function verificationOf(workspace: string, checks: readonly CheckName[]): Verification {
	const results = checks.map(command => {
		const run = runCheck(workspace, command);
		return {
			command,
			status: run.passed ? ('passed' as const) : ('failed' as const),
			how: run.passed ? 'exited with code 0' : 'exited with an error',
			output: run.output,
		};
	});
	return { met: results.every(result => result.status === 'passed'), checks: results };
}

const decisionOf = (
	text: string,
): { decision: ReviewCaseResult['decision']; feedback?: string } => {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end < start) return { decision: 'none' };
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as {
			decision?: unknown;
			feedback?: unknown;
		};
		const decision =
			parsed.decision === 'approved' ||
			parsed.decision === 'rejected' ||
			parsed.decision === 'replan'
				? parsed.decision
				: 'none';
		return typeof parsed.feedback === 'string'
			? { decision, feedback: parsed.feedback }
			: { decision };
	} catch {
		return { decision: 'none' };
	}
};

/**
 * Has the reviewer of `profile` review each known change: the reviewer `createLLMOrchestrator`
 * builds, its model, instructions, tools and explorers included, sent the prompt a phase's review
 * sends, with the harness's own checks. Its `showChanges` finds nothing, since the change was not
 * made through the harness; the prompt carries its diff, as a run's review does.
 */
export async function runReview(task: Task, settings: RunSettings): Promise<ReviewResult> {
	const review = task.review;
	if (review === undefined) throw new Error(`${task.name} is not a review task`);
	const { provider, model } = orchestratorRolesFor(
		settings.profile === 'default' ? undefined : settings.profile,
	).reviewer;
	// Run alone, the reviewer's events name no role: its own steps, and its explorers'.
	const models: AgentModels = { agent: model, 'agent/explorer': explorerModels[provider] };
	const request = taskFile(task, task.prompts[0] ?? '');
	const cases: ReviewCaseResult[] = [];
	for (const [name, known] of Object.entries(review.cases)) {
		const workspace = prepareWorkspace(task);
		applyOverlay(task, workspace, known.change);
		const diff = changesSinceStart(workspace);
		const verification = verificationOf(workspace, task.checks);
		const orchestrator = await createLLMOrchestrator({
			...(settings.profile === 'default' ? {} : { provider: settings.profile }),
			workspace: {
				roots: [{ path: workspace, access: 'write' }],
				stateDirectory: stateDirectoryOf(workspace),
			},
			commands: taskCommands(),
		});
		const reviewer = orchestratorRolesOf(orchestrator).reviewer;
		// A role inside the orchestrator keeps no record of its own: its narration is the record.
		const recorder = new Recorder(join(settings.folder, `record-${name}.jsonl`));
		const started = Date.now();
		let answer = '';
		try {
			const response = await reviewer.run(
				reviewerPrompt(request, {
					plan: review.plan,
					at: 0,
					done: [],
					summary: review.summary,
					verification,
					diff,
				}),
				{
					signal: AbortSignal.timeout(20 * 60_000),
					onProgress: event => {
						recorder.take({ version: 1, type: 'progress', event });
					},
				},
			);
			answer = response.response;
		} catch (error) {
			recorder.take({
				version: 1,
				type: 'end',
				outcome: 'failed',
				failure: {
					recoverable: false,
					message: error instanceof Error ? error.message : String(error),
					cause: '',
					usageUnreported: false,
				},
			});
		}
		const { decision, feedback } = decisionOf(answer);
		let found: ReviewCaseResult['found'];
		if (
			known.key !== undefined &&
			decision === 'rejected' &&
			feedback !== undefined &&
			settings.judges.length > 0
		) {
			const judged = await gradeFeedback(known.key, feedback, settings.judges);
			const votes = judged.flatMap(each => ('verdict' in each ? [each.verdict.found] : []));
			found = { judges: judged, agreed: votes.length === 0 ? undefined : votes.every(Boolean) };
		}
		// Without judges, a rejection counts; with them, only one every answering judge says names
		// the bug, and none when no judge answered.
		const named = settings.judges.length === 0 || found?.agreed === true;
		const correct =
			known.expected === 'approved' ? decision === 'approved' : decision === 'rejected' && named;
		cases.push({
			name,
			expected: known.expected,
			decision,
			...(feedback === undefined ? {} : { feedback }),
			...(found ? { found } : {}),
			correct,
			metrics: metricsOf(recorder.entries, models),
			seconds: (Date.now() - started) / 1000,
		});
		removeWorkspace(workspace);
	}
	const bugs = cases.filter(result => result.expected === 'rejected');
	const clean = cases.filter(result => result.expected === 'approved');
	return {
		kind: 'review',
		cases,
		recall: bugs.length === 0 ? 1 : bugs.filter(result => result.correct).length / bugs.length,
		falseAlarms:
			clean.length === 0 ? 0 : clean.filter(result => !result.correct).length / clean.length,
		cost: cases.reduce<number | undefined>(
			(sum, result) =>
				sum === undefined || result.metrics.cost === undefined
					? undefined
					: sum + result.metrics.cost,
			0,
		),
	};
}

/** Makes a folder for a run's files. */
export function runFolder(root: string, task: string, run: number): string {
	const folder = join(root, task, `run-${String(run)}`);
	mkdirSync(folder, { recursive: true });
	return folder;
}
