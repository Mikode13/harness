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
