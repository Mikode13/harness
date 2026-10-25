import type { Agent, AgentResponse, ProgressEvent, RunOptions } from '#src/agent/domain/agent';
import { newSession, sessionOf } from '#src/agent/domain/session';
import {
	RunContext,
	runContextOf,
	withRunContext,
	type RunEnd,
} from '#src/agent/domain/runContext';
import { RecoverableError, UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import { isAbortError } from '#src/shared/domain/isAbortError';
import type { ILogger } from '#src/shared/domain/logger';
import {
	classifyHostFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import type { Validator } from '#src/shared/domain/validator';
import type { Workflow, WorkflowResult, WorkflowStageReport } from './workflow.ts';

/** A stage with its types erased: the factory checked them, and the runner only passes values on. */
export interface RunnableStage {
	readonly name: string;
	agent(): Agent | PromiseLike<Agent>;
	prompt(input: unknown): string | PromiseLike<string>;
	readonly validator: Validator<unknown>;
	transition(output: unknown, input: unknown): unknown;
	readonly maxAttempts?: number;
}

type Transition<Result> =
	{ type: 'go'; stage: string; input: unknown } | { type: 'stop' | 'complete'; result: Result };

interface Totals {
	tokens: Tokens | undefined;
	unreported: boolean;
}

function addUsage(totals: Totals, response: AgentResponse): void {
	if (response.tokens === undefined) totals.unreported = true;
	totals.tokens = addTokens(totals.tokens, response.tokens);
}

function knownTokens(totals: Totals): Tokens | undefined {
	return totals.unreported ? undefined : totals.tokens;
}

function stripCodeFence(text: string): string {
	const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
	return match?.[1] ?? text;
}

function parseJSON(text: string): { value: unknown } | undefined {
	try {
		return { value: JSON.parse(stripCodeFence(text)) as unknown };
	} catch {
		return undefined;
	}
}

function retryNotice(reason: string): string {
	return `\n\nYour previous response could not be used: ${reason} Respond with JSON only, matching the schema exactly, with no surrounding text and no markdown code fences.`;
}

function has(record: object, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, field);
}

/** The types only bind TypeScript callers; a JavaScript callback can return anything. */
function isTransition<Result>(value: unknown): value is Transition<Result> {
	if (typeof value !== 'object' || value === null || !('type' in value)) return false;
	switch (value.type) {
		case 'go':
			return 'stage' in value && typeof value.stage === 'string' && has(value, 'input');
		case 'stop':
		case 'complete':
			return has(value, 'result');
		default:
			return false;
	}
}

/**
 * Runs the stages the factory already checked: one stage at a time, each answer validated before
 * its transition is taken, and only the transition's `input` reaching the next stage. Each stage
 * creates its agent once per run, so a run never sees another run's conversations.
 */
export class WorkflowRunner<Input, Result> implements Workflow<Input, Result> {
	private readonly stages: ReadonlyMap<string, RunnableStage>;
	private readonly initialStage: string;
	private readonly maxAttempts: number;
	private readonly maxTransitions: number;
	private readonly logger: ILogger;

	constructor(options: {
		initialStage: string;
		stages: ReadonlyMap<string, RunnableStage>;
		maxAttempts: number;
		maxTransitions: number;
		logger: ILogger;
	}) {
		this.initialStage = options.initialStage;
		this.stages = options.stages;
		this.maxAttempts = options.maxAttempts;
		this.maxTransitions = options.maxTransitions;
		this.logger = options.logger;
	}

	/**
	 * Every stage of one run shares one run context, so what their agents write is one run of the
	 * workspace's history. The workflow ends that context with the run, unless an outer agent owns it.
	 */
	async run(input: Input, options: RunOptions): Promise<WorkflowResult<Result>> {
		const start = Date.now();
		// Per invocation, not per instance: one workflow can serve several runs at once.
		const totals: Totals = { tokens: undefined, unreported: false };
		const stages: WorkflowStageReport[] = [];
		// Per run, like the agents its stages create: each run is a conversation of its own.
		const session = sessionOf(options) ?? newSession();
		const inherited = runContextOf(options);
		const context = inherited ?? new RunContext(session);
		let end: RunEnd = 'failed';
		let outcome: { status: 'completed' | 'stopped'; result: Result };

		try {
			outcome = await this.runStages(
				input,
				inherited ? options : withRunContext(options, context),
				totals,
				stages,
				new Map(),
			);
			end = 'completed';
		} catch (error) {
			if (isAbortError(error) || options.signal.aborted) end = 'cancelled';
			// A failing stage carries its own tokens; the stages before it are in the totals.
			throw withSpentTokens(error, totals.tokens, totals.unreported);
		} finally {
			if (!inherited) await this.finishContext(context, end);
		}

		// Read once the run ended: a run that changed nothing left the history then.
		const { runId } = context.historyRun;
		return {
			...outcome,
			tokens: knownTokens(totals),
			duration: (Date.now() - start) / 1000,
			stages,
			...(!inherited && runId ? { runId } : {}),
			session: { ...session },
		};
	}

	/** `agents` holds the agent each stage created in this run, so a stage the run comes back to goes on with it. */
	private async runStages(
		input: Input,
		options: RunOptions,
		totals: Totals,
		reports: WorkflowStageReport[],
		agents: Map<string, Agent>,
	): Promise<{ status: 'completed' | 'stopped'; result: Result }> {
		let stage = this.stageNamed(this.initialStage);
		let stageInput: unknown = input;

		for (let transitions = 0; ; transitions++) {
			const started = Date.now();
			const stageTotals: Totals = { tokens: undefined, unreported: false };
			const agent = await this.agentOf(stage, agents);
			const { output, attempts } = await this.answer(
				stage,
				agent,
				stageInput,
				options,
				totals,
				stageTotals,
			);
			const transition = await this.transition(stage, output, stageInput);
			options.signal.throwIfAborted();

			const tokens = knownTokens(stageTotals);
			const nextStage = transition.type === 'go' ? transition.stage : undefined;
			reports.push({
				stage: stage.name,
				input: stageInput,
				output,
				attempts,
				duration: (Date.now() - started) / 1000,
				...(tokens && { tokens }),
				transition: transition.type,
				...(nextStage !== undefined && { nextStage }),
			});
			this.emit(options, {
				type: 'workflowTransition',
				stage: stage.name,
				transition: transition.type,
				...(nextStage !== undefined && { nextStage }),
			});

			if (transition.type !== 'go') {
				const status = transition.type === 'complete' ? 'completed' : 'stopped';
				return { status, result: transition.result };
			}
			if (transitions + 1 > this.maxTransitions) {
				throw new UnrecoverableError('Workflow transition limit exhausted', {
					cause: `The run went to another stage more than ${String(this.maxTransitions)} times.`,
				});
			}
			stage = this.stageNamed(transition.stage, stage.name);
			stageInput = transition.input;
		}
	}

	/** The stage's agent in this run: created the first time the stage runs, then reused. */
	private async agentOf(stage: RunnableStage, agents: Map<string, Agent>): Promise<Agent> {
		const existing = agents.get(stage.name);
		if (existing) return existing;
		let agent: Agent;
		try {
			agent = await stage.agent();
		} catch (error) {
			throw classifyHostFailure(error, `Workflow stage "${stage.name}" could not create its agent`);
		}
		agents.set(stage.name, agent);
		return agent;
	}

	/**
	 * Asks the stage's agent until an answer is valid JSON its validator accepts, or attempts run
	 * out. Each answer's usage goes to the run's and the stage's totals; a failure carries the
	 * run's when `run` rethrows it.
	 */
	private async answer(
		stage: RunnableStage,
		agent: Agent,
		input: unknown,
		options: RunOptions,
		totals: Totals,
		stageTotals: Totals,
	): Promise<{ output: unknown; attempts: number }> {
		const maxAttempts = stage.maxAttempts ?? this.maxAttempts;
		options.signal.throwIfAborted();
		let prompt: string;
		try {
			prompt = await stage.prompt(input);
		} catch (error) {
			throw classifyHostFailure(error, `Workflow stage "${stage.name}" could not build its prompt`);
		}

		let failureReason: string | undefined;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			options.signal.throwIfAborted();
			this.emit(options, { type: 'workflowStage', stage: stage.name, attempt });
			const response = await this.runAgent(
				stage,
				agent,
				failureReason ? prompt + retryNotice(failureReason) : prompt,
				options,
			);
			addUsage(totals, response);
			// An answer that arrives after a cancellation is not used.
			options.signal.throwIfAborted();
			addUsage(stageTotals, response);

			const parsed = parseJSON(response.response);
			if (parsed) {
				let output: unknown;
				try {
					output = stage.validator.validate(parsed.value);
				} catch (error) {
					throw classifyHostFailure(
						error,
						`Workflow stage "${stage.name}" could not validate its answer`,
					);
				}
				if (output !== undefined) return { output, attempts: attempt };
				failureReason = 'it did not match the schema.';
			} else {
				failureReason = 'it was not valid JSON.';
			}

			if (attempt < maxAttempts) {
				this.warn(
					`Workflow stage "${stage.name}" answer ${String(attempt)}/${String(maxAttempts)} was unusable (${failureReason}); asking again`,
				);
			}
		}

		throw new UnrecoverableError('Workflow stage attempts exhausted', {
			cause: `Stage "${stage.name}" gave no usable answer in ${String(maxAttempts)} attempts: the last one ${failureReason ?? ''}`,
		});
	}

	private async runAgent(
		stage: RunnableStage,
		agent: Agent,
		prompt: string,
		options: RunOptions,
	): Promise<AgentResponse> {
		try {
			// No stage reads the inbox, as no role of an orchestrator does: what was sent stays for
			// the next run.
			return await agent.run(prompt, { ...options, inbox: undefined });
		} catch (error) {
			// Whatever the agent threw once the run was cancelled, the run ends as cancelled.
			options.signal.throwIfAborted();
			if (isAbortError(error)) throw error;
			if (error instanceof RecoverableError || error instanceof UnrecoverableError) throw error;
			throw new UnrecoverableError(`Workflow stage "${stage.name}" failed`, {
				cause: describeFailure(error),
			});
		}
	}

	private async transition(
		stage: RunnableStage,
		output: unknown,
		input: unknown,
	): Promise<Transition<Result>> {
		let transition: unknown;
		try {
			transition = await stage.transition(output, input);
		} catch (error) {
			throw classifyHostFailure(
				error,
				`Workflow stage "${stage.name}" could not choose its transition`,
			);
		}
		if (!isTransition<Result>(transition)) {
			throw new UnrecoverableError('Workflow transition is invalid', {
				cause: `Stage "${stage.name}" returned something that is not a transition.`,
			});
		}
		return transition;
	}

	private stageNamed(name: string, from?: string): RunnableStage {
		const stage = this.stages.get(name);
		if (!stage) {
			throw new UnrecoverableError('Workflow stage does not exist', {
				cause: from
					? `Stage "${from}" selected unknown stage "${name}".`
					: `The workflow has no stage "${name}".`,
			});
		}
		return stage;
	}

	/** The run's records end here, but its result stands: what it changed is already on disk. */
	private async finishContext(context: RunContext, end: RunEnd): Promise<void> {
		try {
			await context.finish(end);
		} catch (error) {
			this.warn(`The run could not close its records: ${describeFailure(error)}`);
		}
	}

	private emit(options: RunOptions, event: ProgressEvent): void {
		const { onProgress } = options;
		if (!onProgress) return;
		treatErrors(
			() => {
				onProgress(event);
			},
			classifyHostFailure,
			'Workflow progress callback failed',
		);
	}

	private warn(message: string): void {
		treatErrors(
			() => {
				this.logger.warn(message);
			},
			classifyHostFailure,
			'Workflow logger failed while reporting a retry',
		);
	}
}
