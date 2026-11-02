import type { Agent, RunOptions } from '#src/agent/domain/agent';
import type { Session } from '#src/shared/domain/session';
import type { ILogger } from '#src/shared/domain/logger';
import type { Tokens } from '#src/shared/domain/tokens';
import type { Validator } from '#src/shared/domain/validator';

/** The names of a workflow's stages: the keys of its map of what each stage receives. */
export type WorkflowStageName<Inputs> = keyof Inputs & string;

/**
 * What a stage chose once its answer was valid. `go` runs the stage it names, which receives
 * `input` and nothing else; `stop` ends the run early on purpose and `complete` ends it finished,
 * each with the run's result. `Inputs` maps each stage's name to what it receives, so a `go` that
 * names a stage that does not exist, or hands it the wrong input, does not compile.
 */
export type WorkflowTransition<Inputs, Result> =
	| {
			[Name in WorkflowStageName<Inputs>]: { type: 'go'; stage: Name; input: Inputs[Name] };
	  }[WorkflowStageName<Inputs>]
	| { type: 'stop'; result: Result }
	| { type: 'complete'; result: Result };

/**
 * One step of a workflow: how it creates its agent, the prompt that agent gets from the stage's
 * input, how its JSON answer is validated, and the transition the valid answer selects.
 */
export interface WorkflowStageDefinition<
	Inputs,
	Name extends WorkflowStageName<Inputs>,
	Output,
	Result,
> {
	/**
	 * Creates the stage's agent, with a context of its own, the first time the stage runs in a
	 * run. When the run comes back to the stage, the same agent goes on with its conversation;
	 * the next run creates another. It may be async, as `createLLMOrchestrator` is.
	 */
	agent(): Agent | PromiseLike<Agent>;
	prompt(input: Inputs[Name]): string | PromiseLike<string>;
	/** Receives the agent's answer parsed as JSON. */
	readonly validator: Validator<Output>;
	/** Receives the validated answer and the stage's own input, to carry forward what the next stage needs. */
	transition(
		output: Output,
		input: Inputs[Name],
	): WorkflowTransition<Inputs, Result> | PromiseLike<WorkflowTransition<Inputs, Result>>;
	/** How many answers the stage may give before an invalid one fails the run. */
	readonly maxAttempts?: number;
}

/**
 * A step of a workflow that runs code instead of an agent, such as asking the user, running a
 * check or reading what the run changed: it receives the stage's input and the run's own
 * options, and chooses the transition itself. It gives no answer to validate, so it runs once.
 */
export interface WorkflowCodeStageDefinition<
	Inputs,
	Name extends WorkflowStageName<Inputs>,
	Result,
> {
	/**
	 * A failure it throws ends the run as an agent's does: a cancellation, a `RecoverableError`
	 * or an `UnrecoverableError` as it is, anything else as an `UnrecoverableError`.
	 */
	run(
		input: Inputs[Name],
		options: RunOptions,
	): WorkflowTransition<Inputs, Result> | PromiseLike<WorkflowTransition<Inputs, Result>>;
}

/** A stage bound to its name, as `defineWorkflowStages` returns it. */
export interface WorkflowStage<
	Inputs,
	Result,
	Name extends WorkflowStageName<Inputs> = WorkflowStageName<Inputs>,
> extends WorkflowStageDefinition<Inputs, Name, unknown, Result> {
	readonly name: Name;
}

/** A code stage bound to its name, as `defineWorkflowStages` returns it. */
export interface WorkflowCodeStage<
	Inputs,
	Result,
	Name extends WorkflowStageName<Inputs> = WorkflowStageName<Inputs>,
> extends WorkflowCodeStageDefinition<Inputs, Name, Result> {
	readonly name: Name;
}

/**
 * Binds a stage to its name: an agent's, whose output it infers from the validator, or, through
 * `code`, a code stage.
 */
export interface WorkflowStageBinder<Inputs, Result> {
	<Name extends WorkflowStageName<Inputs>, Output>(
		name: Name,
		definition: WorkflowStageDefinition<Inputs, Name, Output, Result>,
	): WorkflowStage<Inputs, Result, Name>;
	code<Name extends WorkflowStageName<Inputs>>(
		name: Name,
		definition: WorkflowCodeStageDefinition<Inputs, Name, Result>,
	): WorkflowCodeStage<Inputs, Result, Name>;
}

/**
 * Binds stage definitions to one workflow's map of stage inputs and its result. The function it
 * returns infers each stage's output from its validator; its `code` binds a code stage.
 *
 * @example
 * const stage = defineWorkflowStages<{ triage: string; draft: Brief }, string>();
 * const triage = stage('triage', { agent, prompt, validator, transition });
 * const check = stage.code('draft', { run: async (brief, options) => ({ type: 'complete', result }) });
 */
export function defineWorkflowStages<Inputs, Result>(): WorkflowStageBinder<Inputs, Result> {
	return Object.assign(
		<Name extends WorkflowStageName<Inputs>, Output>(
			name: Name,
			definition: WorkflowStageDefinition<Inputs, Name, Output, Result>,
		): WorkflowStage<Inputs, Result, Name> => ({ ...definition, name }),
		{
			code: <Name extends WorkflowStageName<Inputs>>(
				name: Name,
				definition: WorkflowCodeStageDefinition<Inputs, Name, Result>,
			): WorkflowCodeStage<Inputs, Result, Name> => ({ ...definition, name }),
		},
	);
}

export interface WorkflowStageReport {
	stage: string;
	/** What the stage received. */
	input: unknown;
	/** The stage's validated answer; `undefined` for a code stage, which gives none. */
	output: unknown;
	/** How many answers the stage's agent gave, the last one valid; 1 for a code stage. */
	attempts: number;
	/** Seconds. */
	duration: number;
	/** Absent when a provider did not report an answer's usage. */
	tokens?: Tokens;
	transition: 'go' | 'stop' | 'complete';
	/** The stage that ran next, absent after `stop` or `complete`. */
	nextStage?: string;
}

export interface WorkflowResult<Result> {
	/** `stopped` is a deliberate early end, not a failure: a failure rejects the run. */
	status: 'completed' | 'stopped';
	result: Result;
	/** Every stage's usage. Absent when any answer's usage was not reported. */
	tokens?: Tokens;
	/** Seconds. */
	duration: number;
	runId?: string;
	/** The session the run belonged to: the one `RunOptions.session` gave, or a new one. */
	session?: Session;
	/** One report per stage run, in order: what each stage received, answered and chose. */
	stages: readonly WorkflowStageReport[];
}

export interface Workflow<Input, Result> {
	run(input: Input, options: RunOptions): Promise<WorkflowResult<Result>>;
}

export interface CreateWorkflowOptions<
	Inputs,
	Result,
	Initial extends WorkflowStageName<Inputs> = WorkflowStageName<Inputs>,
> {
	initialStage: Initial;
	/** Every stage, under its own name. */
	stages: {
		readonly [Name in WorkflowStageName<Inputs>]:
			WorkflowStage<Inputs, Result, Name> | WorkflowCodeStage<Inputs, Result, Name>;
	} & Readonly<Record<string, WorkflowStage<Inputs, Result> | WorkflowCodeStage<Inputs, Result>>>;
	/** The default for a stage without its own. Defaults to 3. */
	maxAttempts?: number;
	/** How many times a run may `go` to a stage, so a loop of stages ends. Defaults to 100. */
	maxTransitions?: number;
	logger?: ILogger;
}
