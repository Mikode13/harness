// We tried to add cost, but that would imply to manage it manually for some agents.
export interface AgentResponse {
	response: string;
	inputTokens: number;
	outputTokens: number;
	// time in seconds
	duration: number;
}

export type Callback = (item: ProgressEvent) => void;

/**
 * Live activity during a run, for narration only: the result travels in `AgentResponse`.
 * New event types can arrive in a minor release, so render the types you know and ignore
 * the rest instead of switching over them exhaustively with a `never` check.
 */
export type ProgressEvent =
	| { type: 'command'; command: string; exitCode?: number }
	| { type: 'reasoning'; message: string }
	| { type: 'search'; query: string }
	| { type: 'fileChange'; changes: { path: string; kind: 'add' | 'update' | 'delete' }[] }
	| { type: 'mcpTool'; server: string; tool: string; status: string }
	| { type: 'agentMessage'; message: string }
	| { type: 'todoList'; items: { text: string; completed: boolean }[] }
	| { type: 'turnStarted' }
	| { type: 'turnEnded' };

/**
 * The contract every engine (CodexAgent, ClaudeAgent, future providers) and every
 * decorator (RetryingAgent, OrchestratorAgent) is built against.
 *
 * Implementers MUST only ever reject with `RecoverableError` or `UnrecoverableError`
 * (see ./errors.ts) — never a raw SDK error, a plain `Error`, or anything else leaked
 * unclassified. Every consumer of `Agent` (RetryingAgent's retry decision,
 * OrchestratorAgent's failure handling) `instanceof`-checks against those two types to
 * decide what to do next; a leaked, unclassified error bypasses that decision
 * entirely — it gets retried when it shouldn't be, or crashes a run that a retry
 * would have recovered. Wrap every call into the underlying SDK so nothing escapes
 * unclassified, including failures the SDK itself doesn't model as a domain error
 * (network errors, malformed responses, etc.); `classifyProviderFailure` does this.
 *
 * Cancellation is the one exception: an `AbortError` must propagate unchanged, because
 * consumers check for it before either error type.
 */
export interface Agent {
	run(prompt: string, signal: AbortSignal, callback: Callback): Promise<AgentResponse | undefined>;
}
