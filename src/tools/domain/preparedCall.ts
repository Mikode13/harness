import type { ToolRisk } from '#src/agent/domain/approval';
import type { RunContext } from '#src/agent/domain/runContext';
import type { ToolDefinition } from '#src/llm/domain/tool';
import type { Tool } from './tool.ts';

/**
 * A tool call checked and fixed before anyone approves it: its risk is judged on what will
 * really happen, and `run` does exactly that, nothing worked out again.
 */
export interface PreparedCall {
	readonly risk: ToolRisk;
	run(signal: AbortSignal): Promise<string>;
}

/**
 * A tool built by the harness, such as a write tool, which prepares each call against the
 * state of the run before it is approved. Internal: consumers build a `Tool`.
 */
export interface PreparingTool extends ToolDefinition {
	/** Rejects with a message for the model when the call cannot run. */
	prepare(input: unknown, signal: AbortSignal, context: RunContext): Promise<PreparedCall>;
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
	context: RunContext,
): Promise<PreparedCall> {
	if (isPreparing(tool)) return tool.prepare(input, signal, context);

	const risk = tool.risk(input);
	return { risk, run: runSignal => tool.execute(input, runSignal) };
}
