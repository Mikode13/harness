import type { ToolDefinition } from '#src/llm/domain/tool';

export interface Tool extends ToolDefinition {
	/**
	 * Runs the tool on the input the model sent. The input is unknown because the model can
	 * send anything: validating it is the tool's job, and a rejection returns to the model as
	 * an error result.
	 */
	execute(input: unknown, signal: AbortSignal): Promise<string>;
}
