import type { CommandLine, ToolRisk } from '#src/agent/domain/approval';
import type { ToolDefinition } from '#src/llm/domain/tool';
import type { ToolCallContext } from './readRegistry.ts';
import type { Tool, ToolSummarizer } from './tool.ts';

/**
 * A tool call checked and fixed before anyone approves it: its risk is judged on what will
 * really happen, and `run` does exactly that, nothing worked out again.
 */
export interface PreparedCall {
	readonly risk: ToolRisk;
	/** For a change to a file, what it will change as a unified diff, fixed when prepared. */
	readonly diff?: string;
	/** For a call that runs a configured command, what it will run, fixed when prepared. */
	readonly command?: CommandLine;
	/**
	 * For a call that runs a configured command, how it ended once it has: its outcome and its
	 * output, without how long it took, so two runs that ended alike give the same text.
	 * `undefined` before it runs, and when it never did.
	 */
	readonly ending?: () => string | undefined;
	run(signal: AbortSignal): Promise<string>;
}

/**
 * A tool ran and produced a result the model should see as an error. Internal tools use this
 * instead of a plain error when the result also carries narrative metadata, such as a command's
 * non-zero exit code.
 */
export class ToolExecutionError extends Error {
	readonly exitCode: number | undefined;

	constructor(message: string, { exitCode }: { exitCode?: number } = {}) {
		super(message);
		this.exitCode = exitCode;
	}
}

/**
 * A tool built by the harness, such as a write tool, which prepares each call against the
 * state of the run before it is approved. Internal: consumers build a `Tool`.
 */
export interface PreparingTool extends ToolDefinition {
	/** Describes the model's input without exposing preparation details to the provider. */
	summarize?: ToolSummarizer;
	/** Rejects with a message for the model when the call cannot run. */
	prepare(input: unknown, signal: AbortSignal, call: ToolCallContext): Promise<PreparedCall>;
}

/** What an agent can run: a consumer's `Tool`, or one the harness built. */
export type AgentTool = Tool | PreparingTool;

function isPreparing(tool: AgentTool): tool is PreparingTool {
	return 'prepare' in tool;
}

/**
 * Brings any tool into the one lifecycle of prepare, approve, run. A consumer's `Tool` has its
 * risk judged now, and later runs on the input as the model sent it.
 */
export async function prepareCall(
	tool: AgentTool,
	input: unknown,
	signal: AbortSignal,
	call: ToolCallContext,
): Promise<PreparedCall> {
	if (isPreparing(tool)) return tool.prepare(input, signal, call);

	const risk = tool.risk(input);
	return { risk, run: runSignal => tool.execute(input, runSignal) };
}
