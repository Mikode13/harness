import type { Tokens } from '#src/shared/domain/tokens';
import type { AgentResponse, ProgressAgent, ProgressEvent } from './agent.ts';
import type { ApprovalDecision, ApprovalRequest } from './approval.ts';
import type { CommittedRun } from './committedRunError.ts';
import type { UserQuestion } from './question.ts';

/**
 * The version of the record's entries that this release of the harness writes, carried by every
 * entry as `version`. It changes, in a major release, whenever a reader of the previous version
 * would read the new entries wrongly: a new entry type, a field removed or changed, or a new
 * field a reader needs, including in a type an entry carries, such as `AgentResponse`,
 * `ApprovalRequest` or `UserQuestion`. A field no reader needs to be correct may be added in a
 * minor release without changing it.
 */
export const runRecordVersion = 1;

/**
 * One agent another agent's tool started, on the way from the run's own agent to the agent that
 * asked: the same `name`, `callId` and `subagent` as the `subagent` events that narrate it.
 */
export interface RecordedDelegation {
	/** `explorer`, or the name of the tool that delegates to it. */
	name: string;
	/** The `id` of the call that started it. */
	callId: string;
	/** Which of the call's agents it is, from 1. */
	subagent: number;
}

/**
 * Who asked a question or an approval: the role of `createLLMOrchestrator` that asked it, or that
 * made the call that started the agent that did; and, for an agent another agent started, the
 * agents that led to it, the outermost first. Both are absent for what the run's own agent asked,
 * or what the orchestrator asked itself, such as whether to carry out the plan.
 */
export interface RecordedOrigin {
	agent?: ProgressAgent;
	delegation?: RecordedDelegation[];
}

/** Why a run failed, as the error it rejected with says it. */
export interface RecordedFailure {
	/** A `RecoverableError` when true, an `UnrecoverableError` otherwise. */
	recoverable: boolean;
	message: string;
	cause: string;
	/** As the error's `tokens`: what the run spent before it failed, when it is known. */
	tokens?: Tokens;
	usageUnreported: boolean;
	/** What the run had committed, from a `RecoverableCommittedRunError` or an `UnrecoverableCommittedRunError`. */
	committed?: CommittedRun;
}

/**
 * One entry of a run's record: everything the run produced, in the order it produced it. Every
 * entry is plain JSON, so it can be stored as it is and read back by a later release, which reads
 * it by its `version`.
 *
 * Unlike `ProgressEvent`, the record is complete: a consumer needs every entry type to be
 * correct, so a new type is a new `runRecordVersion` and a major release. A consumer meeting a
 * `version` it does not know must not read the entry as one it knows, nor skip it. What a
 * `progress` entry carries is narration, under `ProgressEvent`'s own rule: its event may be of a
 * type the consumer does not know, which it ignores.
 */
export type RunEntry =
	/** An event the run narrated, as `onProgress` received it. */
	| { version: 1; type: 'progress'; event: ProgressEvent }
	/**
	 * Questions the run is about to ask `ask`, as the asker receives them. `id` numbers the run's
	 * questions and approval requests together, from 1, and the answer carries it.
	 */
	| { version: 1; type: 'question'; id: number; questions: UserQuestion[]; origin: RecordedOrigin }
	/** The asker's answer to the question `id`, one per question, before the run acts on it. */
	| { version: 1; type: 'answer'; id: number; answers: string[] }
	/** A call the run is about to ask `approve` about, as the approver receives it. */
	| {
			version: 1;
			type: 'approvalRequest';
			id: number;
			request: ApprovalRequest;
			origin: RecordedOrigin;
	  }
	/** The approver's decision on the request `id`, before the run acts on it. */
	| { version: 1; type: 'approvalDecision'; id: number; decision: ApprovalDecision }
	/**
	 * How the run ended, always its last entry: `completed` with the response `run()` resolves
	 * with, `failed` with the error it rejects with, or `cancelled`, by an abort or by the
	 * `AbortSignal.timeout` of its signal, when it rejects with the signal's reason.
	 */
	| { version: 1; type: 'end'; outcome: 'completed'; response: AgentResponse }
	| { version: 1; type: 'end'; outcome: 'failed'; failure: RecordedFailure }
	| { version: 1; type: 'end'; outcome: 'cancelled'; by: 'abort' | 'timeout' };

/**
 * Takes each entry of a run's record, one at a time and in order: the next comes only once the
 * promise this one returned settled. The run waits for every entry so far before it asks a
 * question or an approval, before it acts on the answer, and before it ends. A failure, thrown or
 * rejected, ends the run as an `UnrecoverableError`, never retried; see `RunOptions.onRecord`.
 */
export type RunRecordCallback = (entry: RunEntry) => void | Promise<void>;
