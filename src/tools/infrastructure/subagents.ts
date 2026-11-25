import type { Agent, ProgressEvent, RunOptions } from '#src/agent/domain/agent';
import type { ChildSlot } from '#src/agent/domain/composedCapture';
import { withAuthor, withDelegation, withRunContext } from '#src/agent/domain/runContext';
import type { RecoverableError, UnrecoverableError } from '#src/shared/domain/errors';
import type { ChildOutcome } from '#src/orchestration/domain/model/composedSessionSnapshot';
import type { ToolCallContext } from '../domain/readRegistry.ts';

// An answer is read whole, like a read, which returns at most 16 KB.
const maxAnswerCharacters = 16_000;

/**
 * Ends the slot of a subagent whose run ended as `outcome`: it keeps the agent's state, or, when
 * `agent` was never made, forgets the subagent, since none of its work ran.
 */
export function endSubagent(
	slot: ChildSlot,
	agent: Agent | undefined,
	outcome: ChildOutcome,
): void {
	if (agent === undefined) slot.drop();
	else slot.settle(outcome, agent);
}

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
	}: {
		tool: string;
		name: string;
		subagent: number;
		task: string;
		/** What else it runs with, such as its signal. */
		options: RunOptions;
		/** Where it may write, as real paths; see `delegateCeiling`. */
		writeCeiling: readonly string[] | undefined;
	},
): RunOptions {
	const onProgress = (event: ProgressEvent) => {
		call.onProgress({ type: 'subagent', callId: call.callId, subagent, name, task, event });
	};
	const delegated = withRunContext({ ...options, onProgress }, call.run);
	// What it changes is its caller's, made through it.
	const authored =
		call.author === undefined ? delegated : withAuthor(delegated, `${call.author} › ${name}`);
	return withDelegation(authored, {
		tool,
		callId: call.callId,
		subagent,
		depth: call.depth + 1,
		...(writeCeiling ? { writeCeiling } : {}),
	});
}
