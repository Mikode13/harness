import { RecoverableError, UnrecoverableError } from '#src/shared/domain/errors';
import type { CommitReport } from './commitReport.ts';
import type { PhaseResult } from './phaseResult.ts';

type Options = ConstructorParameters<typeof RecoverableError>[1];

/**
 * What a run of `createLLMOrchestrator` that committed after each phase had committed when it
 * failed: the commits stay in git, so the consumer can still report or undo them.
 */
export interface CommittedRun {
	/** Every commit the run made, by repository, as `AgentResponse.commits` gives them. */
	readonly commits: CommitReport;
	/** Each phase of the plan: approved, unfinished for the one the run failed in, or not begun. */
	readonly phases: readonly PhaseResult[];
	/** The run the workspace's history recorded, as `AgentResponse.runId`. */
	readonly runId?: string;
}

/**
 * A `RecoverableError` from a run that had already committed: the same failure, with what the
 * run committed. Running the request again carries out the plan from its start, phases already
 * committed included.
 */
export class RecoverableCommittedRunError extends RecoverableError implements CommittedRun {
	readonly commits: CommitReport;
	readonly phases: readonly PhaseResult[];
	readonly runId?: string;

	constructor(message: string, options: Options & CommittedRun) {
		super(message, options);
		this.name = 'RecoverableCommittedRunError';
		this.commits = options.commits;
		this.phases = options.phases;
		if (options.runId !== undefined) this.runId = options.runId;
	}
}

/** An `UnrecoverableError` from a run that had already committed: the same failure, with what the run committed. */
export class UnrecoverableCommittedRunError extends UnrecoverableError implements CommittedRun {
	readonly commits: CommitReport;
	readonly phases: readonly PhaseResult[];
	readonly runId?: string;

	constructor(message: string, options: Options & CommittedRun) {
		super(message, options);
		this.name = 'UnrecoverableCommittedRunError';
		this.commits = options.commits;
		this.phases = options.phases;
		if (options.runId !== undefined) this.runId = options.runId;
	}
}

/**
 * `error` with what the run committed, when it is a classified failure and the run committed
 * anything. A cancellation or an unclassified failure is returned unchanged, as is a failure of a
 * run that committed nothing. A subclass such as `MaxContextError` becomes the committed run's
 * error of its kind, so its message and cause stay but its class does not.
 */
export function withCommittedRun(error: unknown, run: CommittedRun | undefined): unknown {
	if (run?.commits.outcome !== 'committed') return error;
	if (!(error instanceof RecoverableError || error instanceof UnrecoverableError)) return error;
	const options = {
		...run,
		cause: error.cause,
		tokens: error.tokens,
		usageUnreported: error.usageUnreported,
	};
	const copy =
		error instanceof RecoverableError
			? new RecoverableCommittedRunError(error.message, options)
			: new UnrecoverableCommittedRunError(error.message, options);
	// The trace should point at where the failure happened, not at the run that wrapped it.
	copy.stack = error.stack;
	return copy;
}
