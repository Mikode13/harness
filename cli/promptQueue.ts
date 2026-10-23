/**
 * One person answers at one terminal, so the questions and approvals of agents working at once
 * wait their turn: each prompt given to `queued` is asked whole before the next one starts,
 * whichever of them it is. One cancelled while it waits is never asked.
 */
export function createPromptQueue() {
	// The end of the last prompt waiting or being asked, which the next one starts after.
	let asking: Promise<unknown> = Promise.resolve();

	return function queued<Input, Result>(
		prompt: (input: Input, signal: AbortSignal) => Result | Promise<Result>,
	): (input: Input, signal: AbortSignal) => Promise<Result> {
		return async (input, signal) => {
			const before = asking;
			let release!: () => void;
			asking = new Promise<void>(resolve => {
				release = resolve;
			});
			try {
				await untilAborted(before, signal);
				signal.throwIfAborted();
				return await prompt(input, signal);
			} finally {
				// Released even when cancelled while waiting: the prompts after it wait for those before.
				void before.then(release, release);
			}
		};
	};
}

/** Waits for `promise`, settled either way, or until `signal` aborts, whichever comes first. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise(resolve => {
		const done = () => {
			signal.removeEventListener('abort', done);
			resolve();
		};
		signal.addEventListener('abort', done, { once: true });
		promise.then(done, done);
	});
}
