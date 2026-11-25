import type { ConversationSnapshot } from '#src/llm/domain/conversationSnapshot';
import type {
	AgentRole,
	ChildOrigin,
	ChildOutcome,
	ModelAgentRecord,
} from '#src/orchestration/domain/model/composedSessionSnapshot';
import { UnrecoverableError } from '#src/shared/domain/errors';
import { describeFailure } from '#src/shared/domain/providerFailure';
import type { Agent } from './agent.ts';
import { RunInProgressError, snapshotDuringRun } from './oneRunAtATime.ts';

/**
 * How the harness reads the state of an agent that belongs to a composed session. It is not part
 * of the public API: an agent on the model APIs answers to this key, and the orchestrator reads it
 * through `isComposedCapable` to save its session.
 */
export const composedCaptureKey = Symbol('composedCapture');

/** An agent's captured state: its conversation, and the subagents its runs completed. */
export interface CapturedAgent {
	readonly conversation: ConversationSnapshot;
	readonly children: readonly CapturedChild[];
}

/** Where a subagent came from, without the role of the record it sits under. */
export type SubagentOrigin = Omit<ChildOrigin, 'role'>;

/** A subagent that completed, with the agent it ran. */
export interface CapturedChild {
	readonly origin: SubagentOrigin;
	readonly agent: CapturedAgent;
}

/** An agent that can give its captured state, as `composedCaptureKey` gives it. */
export interface ComposedCapable {
	[composedCaptureKey](): CapturedAgent;
}

export function isComposedCapable(agent: unknown): agent is ComposedCapable {
	try {
		return (
			typeof agent === 'object' &&
			agent !== null &&
			typeof Reflect.get(agent, composedCaptureKey) === 'function'
		);
	} catch {
		// A consumer's agent may fail the probe itself: that only means it cannot be saved.
		return false;
	}
}

/**
 * An agent whose run has ended, as a composed session holds it: the agent itself, whose state is
 * read when the session is saved, or the state a saved session restored it with.
 */
export type EndedAgent = { readonly live: Agent } | { readonly restored: CapturedAgent };

/**
 * The state of an ended agent, as the session saves it. `label` names the agent in the error for
 * one that cannot be saved.
 *
 * @throws {RunInProgressError} while a run of the agent, or of a subagent of it, has not ended.
 * @throws {UnrecoverableError} naming `label` when the agent is not on the model APIs, or its
 * state cannot be saved.
 */
export function capturedOfEnded(label: string, ended: EndedAgent): CapturedAgent {
	if ('restored' in ended) return ended.restored;
	const { live } = ended;
	if (!isComposedCapable(live)) {
		throw new UnrecoverableError(`${label} cannot be saved`, {
			cause: 'it is not an agent on the model APIs',
		});
	}
	try {
		return live[composedCaptureKey]();
	} catch (error) {
		if (error instanceof RunInProgressError) throw error;
		throw new UnrecoverableError(`${label} cannot be saved`, { cause: describeFailure(error) });
	}
}

/** A subagent from the call that started it, until it settles with its outcome and its agent. */
export interface ChildEntry {
	readonly origin: Omit<SubagentOrigin, 'outcome'>;
	settled?: { readonly outcome: ChildOutcome; readonly ended: EndedAgent };
}

/** The place one subagent holds in its agent's ledger, from the call that starts it. */
export class ChildSlot {
	private readonly entries: ChildEntry[];
	private readonly entry: ChildEntry;

	constructor(entries: ChildEntry[], entry: ChildEntry) {
		this.entries = entries;
		this.entry = entry;
	}

	/** Keeps the subagent's agent, once its run ended with `outcome`. */
	settle(outcome: ChildOutcome, agent: Agent): void {
		this.entry.settled = { outcome, ended: { live: agent } };
	}

	/** Forgets the subagent, for one that never ran an agent and so has nothing to keep. */
	drop(): void {
		const index = this.entries.indexOf(this.entry);
		if (index !== -1) this.entries.splice(index, 1);
	}
}

/**
 * The subagents one agent's calls started, in the order the calls started them, whatever order
 * they finish in. A subagent is kept once its run has ended, and its agent's state is read only
 * when the agent's own state is captured, so it is never read while the subagent still works.
 * Records outlive the runs that made them.
 */
export class ChildLedger {
	private readonly entries: ChildEntry[];

	/** @param restored The subagents a saved session completed: they are kept as they were. */
	constructor(restored: readonly CapturedChild[] = []) {
		this.entries = restored.map(({ origin, agent }) => {
			const { outcome, ...started } = origin;
			return { origin: started, settled: { outcome, ended: { restored: agent } } };
		});
	}

	/** Reserves the place of a subagent that a call is starting, in the order calls start them. */
	start(origin: Omit<SubagentOrigin, 'outcome'>): ChildSlot {
		const entry: ChildEntry = { origin };
		this.entries.push(entry);
		return new ChildSlot(this.entries, entry);
	}

	/**
	 * Every completed subagent, in the order they started, each with the agent it ran.
	 *
	 * @throws {RunInProgressError} while a subagent's run has not ended, whatever else it holds.
	 * @throws {UnrecoverableError} naming the first subagent whose agent cannot be saved.
	 */
	capture(): CapturedChild[] {
		if (this.entries.some(({ settled }) => settled === undefined)) throw snapshotDuringRun();
		return this.entries.map(({ origin, settled }) => {
			if (settled === undefined) throw snapshotDuringRun();
			return {
				origin: { ...origin, outcome: settled.outcome },
				agent: capturedOfEnded(
					`Subagent ${origin.name} ${String(origin.subagent)} of ${origin.tool} call ${origin.callId}`,
					settled.ended,
				),
			};
		});
	}
}

/**
 * The captured state of a saved agent, as it is taken up again: the records' roles are dropped,
 * since they are the place a record sits in, not a part of its agent.
 */
export function capturedOf(record: ModelAgentRecord): CapturedAgent {
	return {
		conversation: record.conversation,
		children: record.children.map(({ origin, agent }) => ({
			origin: {
				tool: origin.tool,
				name: origin.name,
				callId: origin.callId,
				subagent: origin.subagent,
				task: origin.task,
				outcome: origin.outcome,
			},
			agent: capturedOf(agent),
		})),
	};
}

/**
 * The record of an agent that ran under `role`. Every subagent in it, however deep, sits under
 * that role too.
 */
export function recordOf(role: AgentRole, agent: CapturedAgent): ModelAgentRecord {
	return {
		conversation: agent.conversation,
		children: agent.children.map(child => ({
			origin: { role, ...child.origin },
			agent: recordOf(role, child.agent),
		})),
	};
}
