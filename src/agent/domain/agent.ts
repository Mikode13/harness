import type { Tokens } from '#src/shared/domain/tokens';
import type { Approver } from './approval.ts';

/**
 * How a run ended when it did not fail. Every token a run spends travels with its end: here
 * when it finishes, in `RecoverableError.tokens` or `UnrecoverableError.tokens` when it fails.
 */
export interface AgentResponse {
	/** The final text. Empty when the run produced none, for example a turn that only edited files. */
	response: string;
	/**
	 * Missing when any call in the run completed without reporting usage, which is not the same
	 * as zero: a partial sum would look complete.
	 */
	tokens?: Tokens;
	/** Wall-clock seconds the consumer waited for the run, retries and every role included. */
	duration: number;
}

export type Callback = (item: ProgressEvent) => void;

/** What a run needs besides its prompt. Decorators pass it on whole, so a new field reaches every agent. */
export interface RunOptions {
	/** Cancels the run, which then rejects with the signal's `AbortError`. */
	signal: AbortSignal;
	/** Receives the run's live activity. Without it, the run is silent. */
	onProgress?: Callback | undefined;
	/**
	 * Asked before a model-backed agent runs a `destructive` tool call. Without it, such a call
	 * is denied. An agent built with `autoApprove` never asks, and the Agent SDK engines ignore
	 * it: their own permission systems decide.
	 */
	approve?: Approver | undefined;
}

/** The `onProgress` of a run that gave none. */
export const ignoreProgress: Callback = () => undefined;

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
	/** `id` pairs a call's end with its start when one step calls the same tool more than once. */
	| {
			type: 'tool';
			id: string;
			name: string;
			/**
			 * `in_progress` only once the call is about to run, after any approval. `denied` when
			 * it never ran because no one allowed it, with no `in_progress` before it.
			 */
			status: 'in_progress' | 'completed' | 'error' | 'denied';
	  }
	| { type: 'todoList'; items: { text: string; completed: boolean }[] }
	| { type: 'turnStarted' }
	| { type: 'turnEnded' };

/**
 * The contract every engine (CodexAgent, ClaudeAgent, future providers) and every
 * decorator (RetryingAgent, OrchestratorAgent) is built against.
 *
 * Implementers MUST only ever reject with `RecoverableError` or `UnrecoverableError`
 * (see src/shared/domain/errors.ts) — never a raw SDK error, a plain `Error`, or anything else leaked
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
	run(prompt: string, options: RunOptions): Promise<AgentResponse>;
}
