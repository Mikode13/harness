import { z } from 'zod';
import type { Agent } from '#src/agent/domain/agent';
import { RecoverableError, UnrecoverableError } from '#src/shared/domain/errors';
import type { DelegatedAnswer, DelegatingTool } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';
import { defineDelegatingTool } from './defineTool.ts';
import { cutAnswer, failureOf, subagentOptions } from './subagents.ts';

/** The most explorers one call sends, so a single call cannot fan out without bound. */
export const maxExplorers = 4;

/**
 * Sends one explorer, a new agent that starts from its question alone. What it spends counts in
 * the run's usage, whether it answered or failed; a failure becomes its answer. A cancellation
 * escapes.
 */
async function explore(
	question: string,
	subagent: number,
	explorer: () => Agent,
	signal: AbortSignal,
	call: ToolCallContext,
): Promise<DelegatedAnswer> {
	// Within the run that made the call, so the explorer's reads belong to it.
	const options = subagentOptions(call, {
		tool: 'explore',
		name: 'explorer',
		subagent,
		task: question,
		options: { signal },
	});
	try {
		const { response, tokens } = await explorer().run(question, options);
		call.spend(tokens, tokens === undefined);
		return { text: cutAnswer(response || 'It found nothing to report.') };
	} catch (error) {
		// Whatever it threw once the run was cancelled, it ends as cancelled.
		signal.throwIfAborted();
		if (!(error instanceof RecoverableError || error instanceof UnrecoverableError)) throw error;
		call.spend(error.tokens, error.usageUnreported);
		return { text: `The explorer failed: ${failureOf(error)}`, failed: true };
	}
}

/**
 * `explore` for the planner and the reviewer: it sends cheaper, read-only explorers, created by
 * `explorer`, to find what an agent needs in the repository, so the agent that called it reads
 * their reports instead of filling its own context with the files.
 */
export function createExploreTool(explorer: () => Agent): DelegatingTool {
	return defineDelegatingTool({
		name: 'explore',
		description: `Sends read-only explorers to find things in the repository for you, one for each question, all at once. They work in the background: keep working meanwhile, and each explorer's report reaches you in a message of its own once it finishes. Give your final answer only once every explorer you sent has reported: an answer while they work is taken as waiting for them, and only the answer you give after the last report is kept. Each explorer starts from nothing but its question, so make each one complete: what to find, and what to report about it, such as which files and lines implement something and how. Ask up to ${String(maxExplorers)} independent questions in one call. Each answer is an explorer's report, not the files: read a file yourself when you need its exact text.`,
		input: z.object({
			questions: z.array(z.string()).describe('One complete, independent question per explorer.'),
		}),
		summarize: ({ questions }) =>
			questions.length === 1 ? (questions[0] ?? '') : `${String(questions.length)} questions`,
		delegate: ({ questions }, _, call) => {
			const asked = questions.map(question => question.trim());
			if (asked.length === 0 || asked.length > maxExplorers) {
				return Promise.reject(
					new Error(`Ask between 1 and ${String(maxExplorers)} questions in one call.`),
				);
			}
			if (asked.some(question => question === '')) {
				return Promise.reject(new Error('Every question needs some text.'));
			}
			return Promise.resolve({
				risk: 'safe',
				start: signal =>
					asked.map((question, index) => ({
						name: 'explorer',
						subagent: index + 1,
						task: question,
						answer: explore(question, index + 1, explorer, signal, call),
					})),
			});
		},
	});
}
