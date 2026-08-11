export type AgentResult = string | undefined;

export interface Agent {
	run(prompt: string, signal: AbortSignal): Promise<AgentResult>;
}
