import type { Tokens } from '#src/shared/domain/tokens';
import type { Approver } from './approval.ts';
import type { Asker } from './question.ts';

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
	/**
	 * The run the workspace's history recorded, when this run wrote through the harness's write
	 * tools. Absent for a run that wrote nothing, and from the Agent SDK engines, whose changes
	 * the history does not record.
	 */
	runId?: string;
}

export type Callback = (item: ProgressEvent) => void;

/**
 * What a run needs besides its prompt. InstructedAgent passes it on whole. OrchestratorAgent
 * copies its own enumerable fields and replaces only `onProgress` per role; RetryingAgent does
 * the same for a run with `ask`, replacing only `ask`. A field must therefore be an own
 * enumerable one to reach every agent.
 */
export interface RunOptions {
	/**
	 * Cancels the run, which then rejects with the signal's reason: an `AbortError`, or a
	 * `TimeoutError` from `AbortSignal.timeout`. `isAbortError` recognizes both.
	 */
	signal: AbortSignal;
	/** Receives the run's live activity. Without it, the run is silent. */
	onProgress?: Callback | undefined;
	/**
	 * Asked before a model-backed agent runs a `destructive` tool call. Without it, such a call
	 * is denied. An agent built with `autoApprove` never asks, and the Agent SDK engines ignore
	 * it: their own permission systems decide.
	 */
	approve?: Approver | undefined;
	/**
	 * Answers what a model-backed agent asks the user, through its `askUser` tool, when a
	 * decision is the user's to make. Without it the agent has no such tool. The Agent SDK
	 * engines ignore it.
	 */
	ask?: Asker | undefined;
}

/** The `onProgress` of a run that gave none. */
export const ignoreProgress: Callback = () => undefined;

/**
 * Live activity during a run, for narration only: the result travels in `AgentResponse`.
 * New event types can arrive in a minor release, so render the types you know and ignore
 * the rest instead of switching over them exhaustively with a `never` check.
 */
export type ProgressEvent =
	| { type: 'command'; command: string; exitCode?: number; agent?: ProgressAgent }
	| { type: 'reasoning'; message: string; agent?: ProgressAgent }
	| { type: 'search'; query: string; agent?: ProgressAgent }
	| {
			type: 'fileChange';
			changes: { path: string; kind: 'add' | 'update' | 'delete' }[];
			agent?: ProgressAgent;
	  }
	| { type: 'mcpTool'; server: string; tool: string; status: string; agent?: ProgressAgent }
	| { type: 'agentMessage'; message: string; agent?: ProgressAgent }
	/** `id` pairs a call's end with its start when one step calls the same tool more than once. */
	| {
			type: 'tool';
			id: string;
			name: string;
			agent?: ProgressAgent;
			/** A short, tool-owned description of the call. Narration only. */
			summary?: string;
			/** The exit code of a configured command that ended with an error. Narration only. */
			exitCode?: number;
			/**
			 * `in_progress` only once the call is about to run, after any approval. `denied` when
			 * it never ran because no one allowed it, with no `in_progress` before it.
			 */
			status: 'in_progress' | 'completed' | 'error' | 'denied';
			/**
			 * On `completed`, for a call that changed a file through the harness's write tools: the
			 * change as a unified diff, for the person watching. Narration only; the run's whole
			 * record is the history's `changes`.
			 */
			diff?: string;
	  }
	| { type: 'todoList'; items: { text: string; completed: boolean }[]; agent?: ProgressAgent }
	| { type: 'turnStarted'; agent?: ProgressAgent }
	| { type: 'turnEnded'; agent?: ProgressAgent }
	/**
	 * One billed call to the model by an agent on the model APIs, including one the model
	 * stopped early or the client turned into an error: what the call sent and what it cost.
	 * Narration only: the run's total is `AgentResponse.tokens`, or the failure's `tokens`.
	 */
	| {
			type: 'step';
			/** 1 for the first call of the run. */
			step: number;
			/** Missing when the provider did not report this call's usage. */
			tokens?: Tokens;
			context: StepContext;
			agent?: ProgressAgent;
	  }
	/**
	 * A workflow's stage asks its agent for an answer; `attempt` is 2 or more when the previous
	 * answer was invalid. Stages run one at a time, so the events that follow, until the next
	 * workflow event, are this stage's agent's.
	 */
	| { type: 'workflowStage'; stage: string; attempt: number; agent?: ProgressAgent }
	/** The transition a stage's valid answer selected, and the stage it leads to. */
	| {
			type: 'workflowTransition';
			stage: string;
			transition: 'go' | 'stop' | 'complete';
			/** Absent after `stop` or `complete`. */
			nextStage?: string;
			agent?: ProgressAgent;
	  }
	/**
	 * An event of a subagent that a tool call started, such as one of the explorers an `explore`
	 * call runs at once. `callId` is the `id` of that call's `tool` events, and `subagent`
	 * numbers its subagents from 1, so the events of agents running in parallel stay apart.
	 */
	| {
			type: 'subagent';
			callId: string;
			subagent: number;
			/** What the subagent was asked. */
			task: string;
			event: ProgressEvent;
			agent?: ProgressAgent;
	  };

/**
 * What one call to the model sent, in characters by where it came from: an estimate of size
 * for finding what fills a context, not a token count.
 */
export interface StepContext {
	/** The system prompt. */
	instructions: number;
	/** The tool definitions. */
	tools: number;
	/**
	 * The text of the user's prompts and the model's answers, and the provider's summary of the
	 * turns before it once it has compacted them: only what the call sent.
	 */
	messages: number;
	/** Reasoning the model produced earlier and is sent back: its provider's own signed or encrypted blocks. */
	reasoning: number;
	/** The input of every tool call so far. */
	toolCalls: number;
	/** Every tool result so far, by tool, largest first. */
	toolResults: { tool: string; characters: number; calls: number }[];
	/** The largest single results, each with its call's summary when the tool gives one. */
	largestResults: { tool: string; characters: number; summary?: string }[];
}

/** A role in the fixed planner → executor → reviewer workflow. */
export type ProgressAgent = 'planner' | 'executor' | 'reviewer';

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
 * Cancellation is the one exception: an `AbortError`, or the `TimeoutError` of
 * `AbortSignal.timeout`, must propagate unchanged, because
 * consumers check for it before either error type.
 */
export interface Agent {
	run(prompt: string, options: RunOptions): Promise<AgentResponse>;
}
