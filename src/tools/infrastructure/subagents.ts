import type { ProgressEvent, RunOptions } from '#src/agent/domain/agent';
import { withDelegation, withRunContext } from '#src/agent/domain/runContext';
import type { RecoverableError, UnrecoverableError } from '#src/shared/domain/errors';
import type { ToolCallContext } from '../domain/readRegistry.ts';

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
	}: {
		tool: string;
		name: string;
		subagent: number;
		task: string;
		/** What else it runs with, such as its signal. */
		options: RunOptions;
	},
): RunOptions {
	const onProgress = (event: ProgressEvent) => {
		call.onProgress({ type: 'subagent', callId: call.callId, subagent, name, task, event });
	};
	return withDelegation(withRunContext({ ...options, onProgress }, call.run), {
		tool,
		callId: call.callId,
		subagent,
		depth: call.depth + 1,
	});
}
