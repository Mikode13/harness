import { RunInProgressError } from '#src/agent/domain/oneRunAtATime';
import type { RunContext } from '#src/agent/domain/runContext';
import { conversationFormat, type ConversationSnapshot } from '#src/agent/domain/snapshot';
import type { Conversation, ConversationState } from '#src/llm/domain/conversation';
import type { Session } from '#src/shared/domain/session';

/**
 * What an agent goes on from when it is restored: what a `ConversationSnapshot` holds, read and
 * checked.
 */
export interface RestoredConversation {
	conversation: ConversationState;
	session: Session;
	seenRevision: number;
	/** The history `seenRevision` counts in, when the agent had followed one. */
	history?: string;
	context?: { tokens: number; source?: string };
}

/** Why a snapshot is not taken while a run works on the agent. */
export function snapshotInRun(): RunInProgressError {
	return new RunInProgressError(
		'The agent has a run in progress, so its snapshot cannot be taken',
		{
			cause:
				'A run is recorded only once it ends, so a snapshot is taken between runs. Take it once run() settles.',
		},
	);
}

/**
 * The runs an agent's turns were recorded in that had not ended then. Until a run ends, a turn it
 * recorded may still learn the history run it belongs to, on the run's first write, or lose it,
 * when the run changed nothing. An agent's own run ends with it; one another agent owns, such as
 * a workflow's, ends later.
 */
export class EnclosingRuns {
	private readonly open = new Set<RunContext>();

	/** Notes the run a turn was just recorded in, and forgets those that ended. */
	recorded(context: RunContext): void {
		this.prune();
		if (!context.finished) this.open.add(context);
	}

	/** Forgets a run that has ended, such as the agent's own once it finished. */
	ended(context: RunContext): void {
		this.open.delete(context);
	}

	private prune(): void {
		for (const context of this.open) {
			if (context.finished) this.open.delete(context);
		}
	}

	/**
	 * @throws {RunInProgressError} while one of them has not ended.
	 */
	assertEnded(): void {
		this.prune();
		if (this.open.size === 0) return;
		throw new RunInProgressError(
			"A run that one of the agent's turns belongs to is still open, so its snapshot cannot be taken",
			{
				cause:
					"The agent ran inside another agent's run, such as a workflow stage or a delegated agent, and that run has not ended: what it writes may still tie the turn to its history run. Take the snapshot once the outermost run settles.",
			},
		);
	}
}

/** The snapshot of what an agent recorded, as plain JSON: a copy, which shares nothing with it. */
export function conversationSnapshotOf({
	conversation,
	session,
	seenRevision,
	history,
	contextTokens,
	source,
}: {
	conversation: Conversation;
	session: Session;
	seenRevision: number;
	/** The history `seenRevision` counts in, when known. */
	history: string | undefined;
	/** The tokens of context the model was last sent, when known. */
	contextTokens: number | undefined;
	/** The `providerDataSource` of the client that counted them. */
	source: string | undefined;
}): ConversationSnapshot {
	const { initial, turns, current } = conversation.state();
	return {
		format: conversationFormat,
		version: 1,
		session: { ...session },
		initial,
		turns,
		...(current === undefined ? {} : { currentTurn: current }),
		seenRevision,
		...(history === undefined ? {} : { history }),
		...(contextTokens === undefined
			? {}
			: { context: { tokens: contextTokens, ...(source === undefined ? {} : { source }) } }),
	};
}
