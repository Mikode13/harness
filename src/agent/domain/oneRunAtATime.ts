import { UnrecoverableError } from '#src/shared/domain/errors';

type Options = ConstructorParameters<typeof UnrecoverableError>[1];

/**
 * A run started on an agent instance while another run on it works. An instance continues one
 * conversation, so two runs at once would each continue it from the same point, and one would
 * silently drop the other.
 */
export class RunInProgressError extends UnrecoverableError {
	// The parameters keep the shape `withSpentTokens` copies a classified failure with.
	constructor(
		message = 'The agent already has a run in progress',
		options: Options = {
			cause:
				'An agent instance continues one conversation, one run at a time. Wait for the run in progress to end, or send the message to it through its inbox.',
		},
	) {
		super(message, options);
		this.name = 'RunInProgressError';
	}
}

/**
 * The error for a snapshot taken while a run on the agent has not ended: that run is not in the
 * snapshot yet, so the snapshot would lack it. Its text names no part of the run.
 */
export function snapshotDuringRun(): RunInProgressError {
	return new RunInProgressError('The agent has a run in progress, so it cannot be saved yet', {
		cause:
			'A snapshot holds only the turns of runs that have ended: take it once the run has settled, not while it works or retries.',
	});
}

/** Lets an agent instance work on one run at a time, and rejects a run that starts meanwhile. */
export class OneRunAtATime {
	private running = false;

	/** Whether no run is in progress. */
	get idle(): boolean {
		return !this.running;
	}

	/** Runs `work`, unless a run is already in progress. */
	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.running) throw new RunInProgressError();
		this.running = true;
		try {
			return await work();
		} finally {
			this.running = false;
		}
	}
}
