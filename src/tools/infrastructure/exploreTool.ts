import { z } from 'zod';
import type { Agent } from '#src/agent/domain/agent';
import { RecoverableError, UnrecoverableError } from '#src/shared/domain/errors';
import type { PreparingTool } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';
import { definePreparingTool } from './defineTool.ts';
import { cutAnswer, failureOf, subagentOptions } from './subagents.ts';

/** The most explorers one call sends, so a single call cannot fan out without bound. */
export const maxExplorers = 4;

/**
 * Runs one explorer per question, all at once, each a new agent that starts from its question
 * alone. Every explorer's usage counts in the run's, whether it answered or failed; a failure
 * becomes that explorer's answer, so the others' are not lost. A cancellation escapes.
 */
async function explore(
	questions: readonly string[],
	explorer: () => Agent,
	signal: AbortSignal,
	call: ToolCallContext,
): Promise<string> {
	const answers = await Promise.allSettled(
		questions.map(async (question, index) => {
			const subagent = index + 1;
			const heading = `Explorer ${String(subagent)}: ${question}`;
			// Within the run that made the call, so the explorers' reads belong to it.
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
				return `${heading}\n${cutAnswer(response || 'It found nothing to report.')}`;
			} catch (error) {
				if (!(error instanceof RecoverableError || error instanceof UnrecoverableError)) {
					throw error;
				}
				call.spend(error.tokens, error.usageUnreported);
				return `${heading}\nThe explorer failed: ${failureOf(error)}`;
			}
		}),
	);
	// Whatever each explorer threw once the run was cancelled, the call ends as cancelled.
	signal.throwIfAborted();
	return answers
		.map(answer => {
			if (answer.status === 'rejected') throw answer.reason;
			return answer.value;
		})
		.join('\n\n');
}

/**
 * `explore` for the planner and the reviewer: it sends cheaper, read-only explorers, created by
 * `explorer`, to find what an agent needs in the repository, so the agent that called it reads
 * their reports instead of filling its own context with the files.
 */
export function createExploreTool(explorer: () => Agent): PreparingTool {
	return definePreparingTool({
		name: 'explore',
		description: `Sends read-only explorers to find things in the repository for you, one for each question, all at once. Each explorer starts from nothing but its question, so make each one complete: what to find, and what to report about it, such as which files and lines implement something and how. Ask up to ${String(maxExplorers)} independent questions in one call. Each answer is an explorer's report, not the files: read a file yourself when you need its exact text.`,
		input: z.object({
			questions: z.array(z.string()).describe('One complete, independent question per explorer.'),
		}),
		summarize: ({ questions }) =>
			questions.length === 1 ? (questions[0] ?? '') : `${String(questions.length)} questions`,
		prepare: ({ questions }, _, call) => {
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
				run: signal => explore(asked, explorer, signal, call),
			});
		},
	});
}
