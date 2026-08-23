// We tried to add cost, but that would imply to manage it manually for some agents.
export interface AgentResponse {
	response: string;
	inputTokens: number;
	outputTokens: number;
	// time in seconds, like 10s, 1800s
	duration: string;
}

export interface Agent {
	run(prompt: string, signal: AbortSignal): Promise<AgentResponse | undefined>;
}
