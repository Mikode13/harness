import { isAbortError } from '#src/shared/domain/isAbortError';
import { RecoverableError, UnrecoverableError, withSpentTokens } from '#src/shared/domain/errors';
import { describeFailure } from '#src/shared/domain/providerFailure';
import type { AgentResponse, ProgressEvent, RunOptions } from './agent.ts';
import type { ApprovalDecision, ApprovalRequest } from './approval.ts';
import {
	type CommittedRun,
	RecoverableCommittedRunError,
	UnrecoverableCommittedRunError,
	withCommittedRun,
} from './committedRunError.ts';
import type { UserQuestion } from './question.ts';

/**
 * Receives a run's record, one entry at a time and synchronously: the entry is handed over
 * before the run goes on, in the order it happened. Returning a promise is a failure, not a
 * delivery.
 */
export type RecordCallback = (entry: RunRecordEntry) => void;

/**
 * Live activity, as `onProgress` receives it. The record keeps it even when no `onProgress` is
 * given, so the record of a run never lacks narration the run produced.
 */
export interface ProgressRecord {
	type: 'progress';
	event: ProgressEvent;
}

/** The questions an agent asked the user, exactly as `ask` received them, before it is called. */
export interface QuestionRecord {
	type: 'question';
	questions: UserQuestion[];
}

/** The answers the asker gave, one per question, once they are validated. */
export interface AnswerRecord {
	type: 'answer';
	answers: string[];
}

/** A tool call waiting for someone to allow it, exactly as `approve` received it. */
export interface ApprovalRequestRecord {
	type: 'approvalRequest';
	request: ApprovalRequest;
}

/** The decision the approver gave, once it is validated. A denial is a decision too. */
export interface ApprovalDecisionRecord {
	type: 'approvalDecision';
	decision: ApprovalDecision;
}

/** The run's outcome when it succeeded: the same `AgentResponse` it resolves with. */
export interface CompletedRecord {
	type: 'completed';
	response: AgentResponse;
}

/** The run's outcome when it failed: the classified error it rejects with, the same instance. */
export interface FailedRecord {
	type: 'failed';
	error: RecoverableError | UnrecoverableError;
}

/**
 * The run's outcome when it was cancelled: the `AbortError` or `TimeoutError` it rejects with,
 * the same instance. Distinct from `failed`, so a consumer never mistakes a stop for a failure.
 */
export interface CancelledRecord {
	type: 'cancelled';
	error: Error;
}

/**
 * Something a subagent did, attributed to the call that started it, as the `subagent` progress
 * event attributes its activity. `entry` is what the subagent recorded: its questions, decisions
 * and outcome. Its progress arrives as the `subagent` progress event, not here, so it is not
 * recorded twice. Its `completed`, `failed` or `cancelled` is the subagent's, nested here, and
 * never the run's terminal entry.
 */
export interface SubagentRecord {
	type: 'subagent';
	callId: string;
	subagent: number;
	name: string;
	task: string;
	entry: NestedRecordEntry;
}

/** A run's outcome, which the run's own record ends with: exactly one, and last. */
export type TerminalRecordEntry = CompletedRecord | FailedRecord | CancelledRecord;

/**
 * One entry of a run's record: what happened, in the order it happened. The record is complete
 * where `onProgress` is not: it carries every question and approval, and the run's outcome, and
 * `ProgressEvent` stays narration only.
 *
 * New entry types can arrive in a minor release. A consumer must forward or reject an entry it
 * does not know, never skip it while treating the record as complete. Each run's record ends
 * with exactly one top-level terminal entry, and nothing follows it.
 */
export type RunRecordEntry =
	| ProgressRecord
	| QuestionRecord
	| AnswerRecord
	| ApprovalRequestRecord
	| ApprovalDecisionRecord
	| SubagentRecord
	| TerminalRecordEntry;

/** What an agent records before its run ends: every entry but the run's terminal one. */
export type NonTerminalRecordEntry = Exclude<RunRecordEntry, TerminalRecordEntry>;

/** What a subagent records: every entry but progress, which the `subagent` progress event carries. */
export type NestedRecordEntry = Exclude<RunRecordEntry, ProgressRecord>;

/**
 * What an agent inside a recorded run writes to. It can record, but it cannot end the record:
 * only the run that owns the record writes its terminal entry.
 */
export interface RunRecorder {
	record(entry: NonTerminalRecordEntry): void;
}

const recorderKey = Symbol('mikode-harness.runRecorder');

interface RecordedRunOptions extends RunOptions {
	[recorderKey]?: RunRecorder;
}

/** The recorder of the outer run these options belong to, if an outer run owns a record. */
export function recorderOf(options: RunOptions): RunRecorder | undefined {
	return (options as RecordedRunOptions)[recorderKey];
}

/** `options`, with the record of the run they start in written to `recorder`. */
export function withRecorder(options: RunOptions, recorder: RunRecorder): RunOptions {
	const recorded: RecordedRunOptions = { ...options, [recorderKey]: recorder };
	return recorded;
}

/**
 * Runs `run` as the owner of its record, when `options` carries an `onRecord` and no outer run
 * owns one. The owner delivers the progress of `run` (also to `onProgress`, when given), and then
 * exactly one terminal entry: `completed` with the response, `cancelled` for an abort, or `failed`
 * with the classified error. A run that an outer run owns is `run` itself: its entries go to
 * the outer record, and its outcome is the outer run's to record.
 *
 * A record that cannot be delivered is an `UnrecoverableError`: the callback threw, or returned a
 * promise, or the entry could not be copied. Delivery stops at the first such failure: nothing
 * else is delivered, the terminal entry included, and the run rejects with that failure, as a
 * committed run's error when the run committed. A cancellation is rethrown unchanged, even when
 * its entry cannot be delivered: a stop stays a stop.
 *
 * `run` must pass its options on whole, so the record reaches every agent it starts. Progress it
 * narrates must go through the `onProgress` it was given, which forwards to the record.
 */
export async function recordRun(
	options: RunOptions,
	run: (options: RunOptions) => AgentResponse | Promise<AgentResponse>,
): Promise<AgentResponse> {
	const { onRecord, onProgress } = options;
	if (onRecord === undefined || recorderOf(options) !== undefined) return run(options);

	const owned = new OwnedRecord(onRecord);
	const recorded: RecordedRunOptions = {
		...options,
		onProgress: event => {
			owned.append({ type: 'progress', event });
			onProgress?.(event);
		},
		[recorderKey]: {
			record: entry => {
				owned.append(entry);
			},
		},
	};

	let response: AgentResponse;
	try {
		response = await run(recorded);
	} catch (error) {
		throw owned.fail(error);
	}
	owned.complete(response);

	return response;
}

/** The record of one run, owned by the run that started it. Internal to `recordRun`. */
class OwnedRecord {
	// Typed to return `unknown`, so a callback that returns a promise can be seen and refused.
	private readonly sink: (entry: RunRecordEntry) => unknown;
	private failure: UnrecoverableError | undefined;
	private ended = false;

	constructor(sink: RecordCallback) {
		this.sink = sink;
	}

	append(entry: NonTerminalRecordEntry): void {
		if (this.ended) throw new Error('A run record takes nothing after its terminal entry');

		const failure = this.deliver(entry);
		if (failure) throw failure;
	}

	complete(response: AgentResponse): void {
		const failure = this.end({ type: 'completed', response });
		if (!failure) return;

		// The commits stay in git whether or not the outcome could be recorded, so the error says so.
		const committed =
			response.commits === undefined
				? undefined
				: {
						commits: response.commits,
						phases: response.phases ?? [],
						...(response.runId === undefined ? {} : { runId: response.runId }),
					};
		throw withCommittedRun(
			withSpentTokens(failure, response.tokens, response.tokens === undefined),
			committed,
		);
	}

	/**
	 * Returns what the run rejects with: a cancellation rejects with its own error, a failure with
	 * the classified error its record ends with, or with the host failure that replaced that, as
	 * a committed run's error when the classified one was.
	 */
	fail(error: unknown): unknown {
		if (isAbortError(error)) {
			// The abort is what the run rejects with, whether or not its entry could be delivered.
			this.end({ type: 'cancelled', error });
			return error;
		}

		const classified =
			error instanceof RecoverableError || error instanceof UnrecoverableError
				? error
				: new UnrecoverableError('The agent failed without classifying the failure', {
						cause: describeFailure(error),
					});
		const failure = this.end({ type: 'failed', error: classified });
		if (!failure) return classified;

		// The record's refusal replaces the classified error, so it keeps what the run committed.
		return withCommittedRun(
			withSpentTokens(failure, classified.tokens, classified.usageUnreported),
			committedOf(classified),
		);
	}

	private end(entry: TerminalRecordEntry): UnrecoverableError | undefined {
		if (this.ended) throw new Error('A run record has exactly one terminal entry');

		this.ended = true;
		return this.deliver(entry);
	}

	/** Delivers one entry. Returns the host failure that stopped delivery, if any, and delivers nothing after it. */
	private deliver(entry: RunRecordEntry): UnrecoverableError | undefined {
		if (this.failure) return this.failure;

		try {
			const returned = this.sink(copyEntry(entry));
			if (isThenable(returned)) {
				// A rejection would surface after the run has moved on, so it is taken here instead.
				void returned.then(undefined, () => undefined);
				throw new TypeError(
					'The run record callback returned a promise, but it must be synchronous',
				);
			}
		} catch (error) {
			this.failure = new UnrecoverableError('The run record could not be delivered', {
				cause: describeFailure(error),
			});
		}

		return this.failure;
	}
}

/**
 * A copy of the entry's mutable payload, so the record and the callbacks that received the same
 * values cannot change each other. An error is kept as it is: a classified failure must stay the
 * instance the run rejects with.
 */
function copyEntry(entry: RunRecordEntry): RunRecordEntry {
	switch (entry.type) {
		case 'progress':
			return { type: entry.type, event: structuredClone(entry.event) };
		case 'question':
			return { type: entry.type, questions: structuredClone(entry.questions) };
		case 'answer':
			return { type: entry.type, answers: structuredClone(entry.answers) };
		case 'approvalRequest':
			return { type: entry.type, request: structuredClone(entry.request) };
		case 'approvalDecision':
			return { type: entry.type, decision: structuredClone(entry.decision) };
		case 'completed':
			return { type: entry.type, response: structuredClone(entry.response) };
		case 'failed':
		case 'cancelled':
			return { ...entry };
		case 'subagent':
			return { ...entry, entry: copyEntry(entry.entry) as NestedRecordEntry };
	}
}

/** What a committed run's error says it committed, if it is one. */
function committedOf(error: RecoverableError | UnrecoverableError): CommittedRun | undefined {
	if (!(
		error instanceof RecoverableCommittedRunError || error instanceof UnrecoverableCommittedRunError
	)) {
		return undefined;
	}
	return {
		commits: error.commits,
		phases: error.phases,
		...(error.runId === undefined ? {} : { runId: error.runId }),
	};
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'then' in value &&
		typeof value.then === 'function'
	);
}
