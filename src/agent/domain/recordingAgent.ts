import { AsyncLocalStorage } from 'node:async_hooks';
import { RecoverableError, UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import { isAbortError } from '#src/shared/domain/isAbortError';
import type { ILogger } from '#src/shared/domain/logger';
import { describeFailure } from '#src/shared/domain/providerFailure';
import type { Agent, AgentResponse, ProgressAgent, ProgressEvent, RunOptions } from './agent.ts';
import { readDecision, type Approver } from './approval.ts';
import {
	RecoverableCommittedRunError,
	UnrecoverableCommittedRunError,
	withCommittedRun,
} from './committedRunError.ts';
import { readAnswers, type Asker } from './question.ts';
import type {
	RecordedDelegation,
	RecordedFailure,
	RecordedOrigin,
	RunEntry,
	RunRecordCallback,
} from './runRecord.ts';

// Who is asking, carried from the agent that asks up to the run's recorded asker or approver
// through every wrapper between them, none of which passes anything but the questions.
const origins = new AsyncLocalStorage<RecordedOrigin>();

/** The origin of whatever asks through `ask` or `approve` while `run` runs, changed by `change`. */
function within<T>(change: (origin: RecordedOrigin) => RecordedOrigin, run: () => T): T {
	return origins.run(change(origins.getStore() ?? {}), run);
}

/**
 * `ask` and `approve` of an agent another agent's tool started: what it asks is recorded as
 * asked by that agent, inside the agents that led to it. Each wrapper on the way out adds its
 * own, so the record gets the whole path, the outermost first.
 */
export function delegatedAsking(
	{ ask, approve }: Pick<RunOptions, 'ask' | 'approve'>,
	delegation: RecordedDelegation,
): Pick<RunOptions, 'ask' | 'approve'> {
	const change = ({ delegation: inner = [], ...origin }: RecordedOrigin): RecordedOrigin => ({
		...origin,
		delegation: [delegation, ...inner],
	});
	return {
		...(ask ? { ask: (questions, signal) => within(change, () => ask(questions, signal)) } : {}),
		...(approve
			? { approve: (request, signal) => within(change, () => approve(request, signal)) }
			: {}),
	};
}

/**
 * `ask` and `approve` of a role of an orchestrator: what it asks, or what an agent it started
 * asks, is recorded as the role's. The outermost orchestrator's role is the one that stays, as
 * its stamp on progress does.
 */
export function roleAsking(
	{ ask, approve }: Pick<RunOptions, 'ask' | 'approve'>,
	agent: ProgressAgent,
): Pick<RunOptions, 'ask' | 'approve'> {
	const change = (origin: RecordedOrigin): RecordedOrigin => ({ ...origin, agent });
	return {
		ask: ask && ((questions, signal) => within(change, () => ask(questions, signal))),
		approve: approve && ((request, signal) => within(change, () => approve(request, signal))),
	};
}

/**
 * Hands one run's entries to the consumer's callback, one at a time and in order. A callback
 * that returns a promise holds the entries after it until it settles; one that fails stops the
 * record, and every later entry, or wait, throws its failure.
 */
class RunRecorder {
	private readonly take: RunRecordCallback;
	private readonly waiting: RunEntry[] = [];
	private delivering: Promise<void> | undefined;
	private failure: UnrecoverableError | undefined;
	private nextId = 1;
	// How many entries were pushed, and how many of them the callback has taken, in order.
	private pushed = 0;
	private taken = 0;

	/**
	 * `after` is the earlier record of the same callback, still being taken after its run
	 * settled: this record hands nothing on until that one is taken, or failed.
	 */
	constructor(take: RunRecordCallback, after?: Promise<void>) {
		this.take = take;
		if (after) {
			this.delivering = after.then(() => {
				this.delivering = undefined;
				this.drain();
			});
		}
	}

	/** The number of the next question or approval request. */
	id(): number {
		return this.nextId++;
	}

	/** Whether the consumer failed to take an entry, so the record has a gap. */
	get broken(): boolean {
		return this.failure !== undefined;
	}

	/**
	 * Hands a copy of `entry` on now, or once those before it are taken. Throws when an entry
	 * before it failed, when the callback throws at once, or when the entry cannot be copied.
	 *
	 * The copy is taken now, so the callback gets the entry as it was when it happened, and what
	 * the callback does to it never reaches the asker, the approver, the agent or what `run()`
	 * returns, which hold the same values.
	 */
	push(entry: RunEntry): void {
		if (this.failure) throw this.failure;
		let copy: RunEntry;
		try {
			copy = structuredClone(entry);
		} catch (error) {
			throw this.fail(error);
		}
		entry = copy;
		this.pushed++;
		if (this.delivering) {
			this.waiting.push(entry);
			return;
		}
		const failure = this.deliver(entry);
		if (failure) throw failure;
	}

	/**
	 * Waits until every entry pushed so far is taken, and not those pushed after, such as what
	 * agents in the background narrate meanwhile, and throws if one was not. Given the run's
	 * signal, a cancellation stops the wait, with the signal's reason, so a slow record cannot
	 * hold a cancelled run before it asks.
	 */
	async flush(signal?: AbortSignal): Promise<void> {
		const target = this.pushed;
		while (this.taken < target && this.delivering) {
			await (signal ? untilAborted(this.delivering, signal) : this.delivering);
		}
		if (this.failure) throw this.failure;
	}

	/**
	 * Lets every entry pushed so far be taken after the run settled, without the run waiting for
	 * it, and logs a failure to take one.
	 */
	finishInBackground(log: (failure: unknown) => void): Promise<void> {
		return this.flush().catch(log);
	}

	/** Hands `entry` to the callback, and returns the failure when it threw at once. */
	private deliver(entry: RunEntry): UnrecoverableError | undefined {
		let taken: unknown;
		try {
			taken = this.take(entry);
		} catch (error) {
			return this.fail(error);
		}
		if (!isThenable(taken)) {
			this.taken++;
			return undefined;
		}
		this.delivering = Promise.resolve(taken).then(
			() => {
				this.taken++;
				this.delivering = undefined;
				this.drain();
			},
			(error: unknown) => {
				this.delivering = undefined;
				this.fail(error);
			},
		);
		return undefined;
	}

	/** Hands on the entries that waited, until one holds the rest or the record fails. */
	private drain(): void {
		while (!this.delivering && !this.failure) {
			const next = this.waiting.shift();
			if (!next) return;
			this.deliver(next);
		}
	}

	private fail(error: unknown): UnrecoverableError {
		this.failure ??= new UnrecoverableError('The run record could not take an entry', {
			cause: describeFailure(error),
		});
		this.waiting.length = 0;
		return this.failure;
	}
}

/**
 * The records still being taken after their run settled, by their callback, so the next run given
 * the same callback hands it nothing until the earlier record is taken.
 */
const unfinished = new WeakMap<RunRecordCallback, Promise<void>>();

/** Whether `signal` is aborted now, read where an earlier check may have narrowed it. */
function isCancelled(signal: AbortSignal): boolean {
	return signal.aborted;
}

/** `promise`, or the signal's reason once it aborts, whichever comes first. */
function untilAborted(promise: Promise<void>, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason as Error);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		void promise.then(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		});
	});
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === 'object' || typeof value === 'function') &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

/** The options the agent inside gets: its narration, questions and approvals go to `recorder`. */
function recordedOptions(options: RunOptions, recorder: RunRecorder): RunOptions {
	const { onProgress, ask, approve } = options;
	const recorded: RunOptions = {
		...options,
		// The record is this run's alone: an agent inside, built by a factory too, keeps none.
		onRecord: undefined,
		onProgress: (event: ProgressEvent) => {
			// What the consumer could not narrate never reaches the record either.
			onProgress?.(event);
			recorder.push({ version: 1, type: 'progress', event });
		},
	};
	if (ask) recorded.ask = recordedAsker(ask, recorder);
	if (approve) recorded.approve = recordedApprover(approve, recorder);
	return recorded;
}

/**
 * `ask`, with each question in the record before the asker sees it, and its answer there before
 * the agent reads it. A question the record did not take is never asked: the asker fails, which
 * ends the run.
 */
function recordedAsker(ask: Asker, recorder: RunRecorder): Asker {
	return async (questions, signal) => {
		// Read before anything is awaited: it belongs to the call that is asking.
		const origin = origins.getStore() ?? {};
		const id = recorder.id();
		recorder.push({ version: 1, type: 'question', id, questions, origin });
		await recorder.flush(signal);
		const answers = await ask(questions, signal);
		// An answer the agent will not take, given after a cancellation or of the wrong shape, is
		// not one: the agent ends the run as it does today.
		const read = signal.aborted ? undefined : readAnswers(answers, questions);
		if (!read) return answers;
		recorder.push({ version: 1, type: 'answer', id, answers: [...read] });
		await recorder.flush(signal);
		return answers;
	};
}

/** `approve`, with each request in the record before the approver sees it, and its decision before it is acted on. */
function recordedApprover(approve: Approver, recorder: RunRecorder): Approver {
	return async (request, signal) => {
		const origin = origins.getStore() ?? {};
		const id = recorder.id();
		recorder.push({ version: 1, type: 'approvalRequest', id, request, origin });
		await recorder.flush(signal);
		const answer = await approve(request, signal);
		if (signal.aborted) return answer;
		let decision;
		try {
			decision = readDecision(answer);
		} catch {
			// The agent refuses it, and ends the run, as it does today.
			return answer;
		}
		recorder.push({ version: 1, type: 'approvalDecision', id, decision });
		await recorder.flush(signal);
		return answer;
	};
}

/** The failure a run rejected with, as its record's end says it. */
function failureOf(error: unknown): RecordedFailure {
	if (!(error instanceof RecoverableError || error instanceof UnrecoverableError)) {
		// Nothing should reach here unclassified; the record still says the run failed.
		return {
			recoverable: false,
			message: 'The agent failed without classifying the failure',
			cause: describeFailure(error),
			usageUnreported: true,
		};
	}
	const committed =
		error instanceof RecoverableCommittedRunError || error instanceof UnrecoverableCommittedRunError
			? {
					committed: {
						commits: error.commits,
						phases: error.phases,
						...(error.runId === undefined ? {} : { runId: error.runId }),
					},
				}
			: {};
	return {
		recoverable: error instanceof RecoverableError,
		message: error.message,
		cause: error.cause,
		...(error.tokens ? { tokens: error.tokens } : {}),
		usageUnreported: error.usageUnreported,
		...committed,
	};
}

const isTimeout = (reason: unknown) =>
	typeof reason === 'object' &&
	reason !== null &&
	(reason as { name?: unknown }).name === 'TimeoutError';

/**
 * The end of a run that rejected with `error`. A cancellation is told apart by the run's signal,
 * whose reason a provider's own abort error may not carry.
 */
function endOf(error: unknown, signal: AbortSignal): RunEntry {
	if (isAbortError(error)) {
		const timedOut = isTimeout(error) || (signal.aborted && isTimeout(signal.reason));
		return { version: 1, type: 'end', outcome: 'cancelled', by: timedOut ? 'timeout' : 'abort' };
	}
	return { version: 1, type: 'end', outcome: 'failed', failure: failureOf(error) };
}

/**
 * Gives a run given `onRecord` its record: every progress event, question, answer, approval
 * request and decision, then how the run ended, in one ordered stream. A run without it runs as
 * it would without this agent. The factories put it outside everything else they build, so the
 * record is that of the run the consumer started, and an agent inside keeps none of its own.
 */
export class RecordingAgent implements Agent {
	private readonly inner: Agent;
	private readonly logger: ILogger;

	constructor({ inner, logger }: { inner: Agent; logger: ILogger }) {
		this.inner = inner;
		this.logger = logger;
	}

	async run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const { onRecord } = options;
		if (!onRecord) return this.inner.run(prompt, options);

		// A record the same callback still takes, from a run that settled before it was taken, comes
		// whole before this run's first entry, so a consumer never gets two runs' entries mixed.
		const recorder = new RunRecorder(onRecord, unfinished.get(onRecord));
		let response: AgentResponse;
		try {
			response = await this.inner.run(prompt, recordedOptions(options, recorder));
		} catch (error) {
			await this.endFailed(onRecord, recorder, error, options.signal);
			throw error;
		}

		try {
			recorder.push({ version: 1, type: 'end', outcome: 'completed', response });
			await recorder.flush(options.signal);
		} catch (error) {
			// Cancelled while the record still takes the end of a run that completed: the run did
			// complete, as its record says, so it resolves with its response, at once, with what it
			// committed, and the record goes on taking its entries meanwhile.
			if (isCancelled(options.signal) && isAbortError(error)) {
				this.finishLater(onRecord, recorder);
				return response;
			}
			// The run completed, but its record does not say so: the consumer must not take what it
			// has for the whole run. Nothing runs again, since the error is not retried, and what the
			// run committed travels with it, as with any failure after a commit.
			const failure = withSpentTokens(
				new UnrecoverableError('The run completed, but its record could not take every entry', {
					cause: describeFailure(error),
				}),
				response.tokens,
				response.tokens === undefined,
			);
			throw response.commits
				? withCommittedRun(failure, {
						commits: response.commits,
						phases: response.phases ?? [],
						...(response.runId === undefined ? {} : { runId: response.runId }),
					})
				: failure;
		}
		return response;
	}

	/**
	 * Records the end of a run that failed or was cancelled. The run's own error is what it
	 * rejects with, and a cancellation must propagate unchanged, so a record that cannot take the
	 * end is only logged.
	 */
	private async endFailed(
		onRecord: RunRecordCallback,
		recorder: RunRecorder,
		error: unknown,
		signal: AbortSignal,
	): Promise<void> {
		// A record with a gap gets no end: the run's failure is that gap, or came after it.
		if (recorder.broken) return;
		try {
			recorder.push(endOf(error, signal));
		} catch (failure) {
			this.warn(failure);
			return;
		}
		// A cancelled run rejects at once: it never waits for an entry the record is still taking,
		// and the end is handed on once those before it are taken. A run that failed waits for its
		// end, unless it is cancelled while it does.
		if (signal.aborted) {
			this.finishLater(onRecord, recorder);
			return;
		}
		try {
			await recorder.flush(signal);
		} catch (failure) {
			// Read again: the signal may have aborted while the record took the end.
			if (isCancelled(signal)) {
				this.finishLater(onRecord, recorder);
				return;
			}
			this.warn(failure);
		}
	}

	/**
	 * Lets `recorder` finish taking its entries after its run settled, and holds the next record of
	 * the same callback until it has.
	 */
	private finishLater(onRecord: RunRecordCallback, recorder: RunRecorder): void {
		const finished = recorder.finishInBackground(failure => {
			this.warn(failure);
		});
		unfinished.set(onRecord, finished);
		void finished.then(() => {
			if (unfinished.get(onRecord) === finished) unfinished.delete(onRecord);
		});
	}

	/** Logs that the record could not take the run's end; the run's own outcome is what counts. */
	private warn(failure: unknown): void {
		try {
			this.logger.warn(`The run's record could not take its end: ${describeFailure(failure)}`);
		} catch {
			// The run's own failure, or its cancellation, is what the consumer must get.
		}
	}
}
