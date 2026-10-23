import type { RunOptions } from './agent.ts';

export type RunEnd = 'completed' | 'failed' | 'cancelled';

/**
 * What one top-level run shares with every agent and tool inside it, across all its roles,
 * rounds and retries, such as the record of what it wrote. Whatever a tool starts for the run
 * registers how to end it, and the agent that created the context ends it with the run.
 *
 * Internal: it travels in `RunOptions` under a symbol, so decorators, which pass the options on
 * whole, carry it without knowing it exists, and no consumer can see or set it.
 */
export class RunContext {
	private readonly finishers: ((end: RunEnd) => Promise<void>)[] = [];

	/**
	 * The run the workspace's history recorded for this run, once it first wrote. The object is
	 * shared, not copied: a turn recorded before the first write still learns its run.
	 */
	readonly historyRun: { runId?: string } = {};

	/** Ends something the run started, when the run ends. */
	onFinish(finisher: (end: RunEnd) => Promise<void>): void {
		this.finishers.push(finisher);
	}

	/**
	 * Ends everything registered, all of it even when one fails, and then throws the first
	 * failure.
	 */
	async finish(end: RunEnd): Promise<void> {
		const failures: unknown[] = [];
		for (const finisher of this.finishers.splice(0)) {
			try {
				await finisher(end);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw failures[0];
	}
}

const runContextKey = Symbol('mikode-harness.runContext');

interface ContextualRunOptions extends RunOptions {
	[runContextKey]?: RunContext;
}

/** The context of the run these options belong to, if an outer agent created one. */
export function runContextOf(options: RunOptions): RunContext | undefined {
	return (options as ContextualRunOptions)[runContextKey];
}

/** The same options, carrying `context` for every agent the run reaches. */
export function withRunContext(options: RunOptions, context: RunContext): RunOptions {
	return { ...options, [runContextKey]: context } as ContextualRunOptions;
}

/**
 * Where an agent another agent's tool started runs: the call that started it, and how many
 * delegations deep it is, 1 for an agent the top-level agent started.
 */
export interface Delegation {
	/** The name of the tool that started it, such as `explore` or a specialist's. */
	readonly tool: string;
	/** The `id` of that call's `tool` events. */
	readonly callId: string;
	/** Which of the agents that call started, from 1. */
	readonly subagent: number;
	readonly depth: number;
}

const delegationKey = Symbol('mikode-harness.delegation');

interface DelegatedRunOptions extends RunOptions {
	[delegationKey]?: Delegation;
}

/** The call that started the agent these options reach, if another agent's tool did. */
export function delegationOf(options: RunOptions): Delegation | undefined {
	return (options as DelegatedRunOptions)[delegationKey];
}

/** The same options, for an agent `delegation` started. */
export function withDelegation(options: RunOptions, delegation: Delegation): RunOptions {
	return { ...options, [delegationKey]: delegation } as DelegatedRunOptions;
}
