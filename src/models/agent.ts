// We tried to add cost, but that would imply to manage it manually for some agents.
export interface AgentResponse {
	response: string;
	inputTokens: number;
	outputTokens: number;
	// time in seconds
	duration: number;
}

export type Callback = (item: ProgressEvent) => void;

export type ProgressEvent =
	| { type: 'command'; command: string; exitCode?: number }
	| { type: 'reasoning'; message: string }
	| { type: 'search'; query: string }
	| { type: 'fileChange'; changes: { path: string; kind: 'add' | 'update' | 'delete' }[] }
	| { type: 'mcpTool'; server: string; tool: string; status: string }
	| { type: 'agentMessage'; message: string }
	| { type: 'todoList'; items: { text: string; completed: boolean }[] };

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
 * (network errors, malformed responses, etc.).
 */
export interface Agent {
	run(prompt: string, signal: AbortSignal, callback: Callback): Promise<AgentResponse | undefined>;
}

export function handleEvents(item: ProgressEvent): string | undefined {
	switch (item.type) {
		case 'agentMessage':
		case 'reasoning':
			return item.message;
		case 'command':
			if (!item.command) return undefined;

			return `command: ${item.command}, exit ${String(item.exitCode ?? '?')}`;
		case 'mcpTool':
			if (!item.server || !item.status) return undefined;
			return `tool: ${item.tool}, server: ${item.server}, status: ${item.status}`;
		case 'search':
			if (!item.query) return undefined;
			return `searching... query:${item.query}`;
		case 'fileChange':
			if (!item.changes.length) return undefined;

			return item.changes.map(change => `${change.path} - ${change.kind}`).join('\n');
		case 'todoList':
			if (!item.items.length) return undefined;

			return item.items
				.map(todoItem => `${todoItem.text} - status:${todoItem.completed ? '✔' : 'X'}`)
				.join('\n');
	}
}
