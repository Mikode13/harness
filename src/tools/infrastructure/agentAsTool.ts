import { z } from 'zod';
import type { Agent, RunOptions } from '#src/agent/domain/agent';
import { type Approver, readDecision, type ToolRisk } from '#src/agent/domain/approval';
import { type Asker, readAnswers } from '#src/agent/domain/question';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/shared/domain/errors';
import { isAbortError } from '#src/shared/domain/isAbortError';
import { classifyHostFailure } from '#src/shared/domain/providerFailure';
import type { ToolDefinition } from '#src/llm/domain/tool';
import { type PreparingTool, RunEndingToolError } from '../domain/preparedCall.ts';
import type { ToolCallContext } from '../domain/readRegistry.ts';
import { definePreparingTool } from './defineTool.ts';
import { cutAnswer, failureOf, subagentOptions } from './subagents.ts';

declare const delegationToolBrand: unique symbol;

/**
 * A tool from `agentAsTool`, which hands a task to another agent. It goes to an agent from
 * `createLLMAgent` beside its other tools; what it does inside is the harness's.
 */
export type DelegationTool = ToolDefinition & { readonly [delegationToolBrand]: true };

/** How deep agents may delegate unless a tool says otherwise: planner → coder → committer. */
export const defaultMaxDepth = 2;

export interface AgentAsToolOptions {
	/** The name the model calls it by, such as `commit`. */
	name: string;
	/** What the agent does and when to hand it a task, for the model that may call it. */
	description: string;
	/**
	 * A new agent for each call, such as one from `createLLMAgent`: it starts from the task alone
	 * and never shares a conversation with another call.
	 */
	createAgent: () => Agent;
	/**
	 * How the call itself is judged before it runs. `mutating` unless given: handing over a task
	 * asks no one, and the agent's own `destructive` calls are approved through the run's
	 * `approve`, as the calling agent's would be. `destructive` asks before every task is handed
	 * over.
	 */
	risk?: ToolRisk;
	/**
	 * How many delegations deep the agent may run, 1 for one the top-level agent calls. A call
	 * that would go deeper is refused, and the model is told why. Defaults to 2.
	 */
	maxDepth?: number;
}

/**
 * Offers an agent to another agent as a tool. The calling model writes the task; the agent runs
 * it as part of the caller's run, and its answer is the call's result:
 *
 * - its changes go into the same run of the workspace's history, so one undo reverts both, and
 *   each agent keeps its own tools' access policy and its own reads;
 * - what it spends counts in the caller's `tokens`, a failed attempt included;
 * - its progress arrives as `subagent` events of the call, and a transcript it gives names the
 *   call in `delegation`;
 * - it is asked and approved through the run's `ask` and `approve`. Delegating never grants
 *   `autoApprove`: the agent has it only if `createAgent` gave it.
 *
 * Calls of these tools next to each other in one step run at once, and any other call runs
 * alone. Every change and command of the run is made one at a time, so the history stays exact,
 * but agents working at once can see each other's unfinished work. An agent that fails is the call's error result, for the model to act on; a
 * cancellation, or a run's approver or asker that failed inside it, ends the run.
 *
 * Only for agents on the model APIs, from `createLLMAgent`: an agent from `createAgent` runs as
 * its own run, outside these guarantees.
 *
 * @throws {InvalidAgentConfigError} when `maxDepth` is not a positive integer.
 */
export function agentAsTool({
	name,
	description,
	createAgent,
	risk = 'mutating',
	maxDepth = defaultMaxDepth,
}: AgentAsToolOptions): DelegationTool {
	if (!Number.isInteger(maxDepth) || maxDepth < 1) {
		throw new InvalidAgentConfigError(
			`maxDepth of "${name}" must be a positive integer; got ${String(maxDepth)}`,
		);
	}
	const tool: PreparingTool = {
		...definePreparingTool({
			name,
			description,
			input: z.object({
				task: z
					.string()
					.describe(
						'The whole task. The agent starts from it alone, so say what to do and what to report back.',
					),
			}),
			summarize: ({ task }) => task,
			prepare: ({ task }, _, call) => {
				const asked = task.trim();
				if (asked === '') return Promise.reject(new Error('The task needs some text.'));
				if (call.depth >= maxDepth) {
					return Promise.reject(
						new Error(
							`"${name}" may run at most ${String(maxDepth)} delegations deep, and this agent already runs ${String(call.depth)} deep. Do the work yourself, or answer with what you have.`,
						),
					);
				}
				return Promise.resolve({
					risk,
					// What the agent changes is in the history, but it may run tools of the consumer's
					// that change what the history never sees.
					unrecorded: true,
					run: signal => delegate(asked, signal, call),
				});
			},
		}),
		parallel: true,
	};

	async function delegate(task: string, signal: AbortSignal, call: ToolCallContext) {
		// The run's approver and asker are host code: one that fails inside the agent ends the
		// run, not just the agent's task.
		const failed = { host: false };
		const options = subagentOptions(call, {
			tool: name,
			name,
			subagent: 1,
			task,
			options: {
				signal,
				...(call.approve ? { approve: watchedApprover(call.approve, failed) } : {}),
				...(call.ask ? { ask: watchedAsker(call.ask, failed) } : {}),
			} satisfies RunOptions,
		});

		let agent: Agent;
		try {
			agent = createAgent();
		} catch (error) {
			throw new RunEndingToolError(
				classifyHostFailure(error, `The agent for "${name}" could not be created`),
			);
		}

		try {
			const { response, tokens } = await agent.run(task, options);
			call.spend(tokens, tokens === undefined);
			return cutAnswer(response || 'It finished without an answer.');
		} catch (error) {
			if (isAbortError(error)) throw error;
			const classified = error instanceof RecoverableError || error instanceof UnrecoverableError;
			// Its failure carries what it spent, which the run's failure keeps.
			if (classified && failed.host) throw new RunEndingToolError(error);
			if (!classified) {
				// It broke the contract of `Agent`, so what it spent is unknown, not nothing.
				throw new RunEndingToolError(
					withSpentTokens(
						classifyHostFailure(error, `The agent for "${name}" failed`),
						undefined,
						true,
					),
				);
			}
			call.spend(error.tokens, error.usageUnreported);
			throw new Error(`The agent failed: ${failureOf(error)}`, { cause: error });
		}
	}

	// A file tool's kind of brand: the harness built it, and only `createLLMAgent` takes it.
	return tool as unknown as DelegationTool;
}

/** `approve`, noting in `failed` when it throws or answers with no decision. */
function watchedApprover(approve: Approver, failed: { host: boolean }): Approver {
	return async (request, signal) => {
		try {
			const answer = await approve(request, signal);
			readDecision(answer);
			return answer;
		} catch (error) {
			// One that gives up on a cancellation did not fail.
			if (!signal.aborted) failed.host = true;
			throw error;
		}
	};
}

/** `ask`, noting in `failed` when it throws or answers in a shape no agent accepts. */
function watchedAsker(ask: Asker, failed: { host: boolean }): Asker {
	return async (questions, signal) => {
		try {
			const answers = await ask(questions, signal);
			if (!readAnswers(answers, questions)) failed.host = true;
			return answers;
		} catch (error) {
			if (!signal.aborted) failed.host = true;
			throw error;
		}
	};
}
