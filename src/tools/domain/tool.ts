import type { ToolRisk } from '#src/agent/domain/approval';
import type { ToolDefinition } from '#src/llm/domain/tool';

export interface Tool extends ToolDefinition {
	/**
	 * Judges this call from its input before it runs, so the agent can ask before a
	 * `destructive` one. Input the tool would reject cannot do harm, so it may count as `safe`.
	 */
	risk(input: unknown): ToolRisk;
	/**
	 * Runs the tool on the input the model sent. The input is unknown because the model can
	 * send anything: validating it is the tool's job, and a rejection returns to the model as
	 * an error result.
	 */
	execute(input: unknown, signal: AbortSignal): Promise<string>;
}
