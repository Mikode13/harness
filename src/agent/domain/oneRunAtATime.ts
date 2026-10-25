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

/** Lets an agent instance work on one run at a time, and rejects a run that starts meanwhile. */
export class OneRunAtATime {
	private running = false;

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
