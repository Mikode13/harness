import type { ProgressEvent, RunOptions } from '#src/agent/domain/agent';
import { withAuthor, withDelegation, withRunContext } from '#src/agent/domain/runContext';
import {
	withRecorder,
	type NonTerminalRecordEntry,
	type RunRecorder,
	type SubagentRecord,
	type TerminalRecordEntry,
} from '#src/agent/domain/runRecord';
import { type RecoverableError, UnrecoverableError } from '#src/shared/domain/errors';
import { classifyHostFailure, describeFailure } from '#src/shared/domain/providerFailure';
import { RunEndingToolError } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';

/** What names a subagent's entries in its caller's record: the call, and the subagent it started. */
export type SubagentIdentity = Omit<SubagentRecord, 'type' | 'entry'>;

/**
 * Whether the host code of a run failed inside a subagent: the approver, the asker, or the run
 * record. Such a failure ends the run that made the call, so the model never sees it.
 */
export interface HostFailure {
	host: boolean;
}

// An answer is read whole, like a read, which returns at most 16 KB.
const maxAnswerCharacters = 16_000;

/** A subagent's answer as the agent that called it reads it, cut where a read would be. */
export function cutAnswer(answer: string): string {
	if (answer.length <= maxAnswerCharacters) return answer;
	return `${answer.slice(0, maxAnswerCharacters)}\n[The answer was cut at ${String(maxAnswerCharacters)} characters.]`;
}

/** Why a subagent failed, for the agent that called it. */
export function failureOf(error: RecoverableError | UnrecoverableError): string {
	return typeof error.cause === 'string' ? `${error.message}: ${error.cause}` : error.message;
}

/**
 * The options of a subagent a call starts: within the run that made the call, one delegation
 * deeper, and narrated as that call's `subagent`, so the person watching can tell it apart.
 */
export function subagentOptions(
	call: ToolCallContext,
	{
		tool,
		name,
		subagent,
		task,
		options,
		writeCeiling,
		failed,
	}: {
		tool: string;
		name: string;
		subagent: number;
		task: string;
		/** What else it runs with, such as its signal. */
		options: RunOptions;
		/** Where it may write, as real paths; see `delegateCeiling`. */
		writeCeiling: readonly string[] | undefined;
		/** Where the host failures inside it are noted. */
		failed: HostFailure;
	},
): RunOptions {
	const onProgress = (event: ProgressEvent) => {
		call.onProgress({ type: 'subagent', callId: call.callId, subagent, name, task, event });
	};
	const delegated = withRunContext({ ...options, onProgress }, call.run);
	// What it changes is its caller's, made through it.
	const authored =
		call.author === undefined ? delegated : withAuthor(delegated, `${call.author} › ${name}`);
	const delegation = withDelegation(authored, {
		tool,
		callId: call.callId,
		subagent,
		depth: call.depth + 1,
		...(writeCeiling ? { writeCeiling } : {}),
	});
	const { recorder } = call;
	if (recorder === undefined) return delegation;
	return withRecorder(
		delegation,
		subagentRecorder(recorder, { callId: call.callId, name, subagent, task }, failed),
	);
}

/**
 * Writes what a subagent records into its caller's record, as `subagent` entries. The subagent's
 * progress is not among them: its `subagent` progress event carries it.
 */
function subagentRecorder(
	recorder: RunRecorder,
	identity: SubagentIdentity,
	failed: HostFailure,
): RunRecorder {
	return {
		record: entry => {
			if (entry.type === 'progress') {
				throw new TypeError('Progress reaches a subagent through onProgress, not its record');
			}
			report(recorder, { type: 'subagent', ...identity, entry }, failed);
		},
	};
}

/** Writes `entry` to `recorder`, noting in `failed` when it cannot be kept: a host failure. */
function report(recorder: RunRecorder, entry: NonTerminalRecordEntry, failed: HostFailure): void {
	try {
		recorder.record(entry);
	} catch (error) {
		failed.host = true;
		throw error;
	}
}

/**
 * The failure of a subagent that broke the contract of `Agent` by failing unclassified. What it
 * spent is unknown, not nothing, so the usage is unreported.
 */
export function unclassifiedFailure(error: unknown, context: string): UnrecoverableError {
	return new UnrecoverableError(context, { cause: describeFailure(error), usageUnreported: true });
}

/**
 * Writes how a subagent ended, as a `subagent` entry of the run that made the call. A record
 * that cannot be kept ends that run as a host failure, which the model never sees.
 *
 * @throws {RunEndingToolError} when the record cannot take the entry.
 */
export function recordEnd(
	call: ToolCallContext,
	identity: Omit<SubagentIdentity, 'callId'>,
	entry: TerminalRecordEntry,
): void {
	const { recorder } = call;
	if (recorder === undefined) return;
	try {
		recorder.record({ type: 'subagent', callId: call.callId, ...identity, entry });
	} catch (error) {
		throw new RunEndingToolError(classifyHostFailure(error, 'The run record could not be kept'));
	}
}
