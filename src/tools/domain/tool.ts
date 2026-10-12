import type { ToolRisk } from '#src/agent/domain/approval';
import type { ToolDefinition } from '#src/llm/domain/tool';

/** Narration for a call, kept out of the definition sent to an LLM provider. */
export type ToolSummarizer = (input: unknown) => string;

/**
 * An input rejected by a harness-created schema is a tool error, not a failure of host code.
 * It is kept internal to the tool lifecycle so `LLMAgent` can return it to the model without
 * treating invalid model input as an unrecoverable consumer callback failure.
 */
export class InvalidToolInputError extends Error {}

export interface Tool extends ToolDefinition {
	/**
	 * Describes the model's input without reading resources. `defineTool` validates the input
	 * before calling this function.
	 */
	summarize?: ToolSummarizer;
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
