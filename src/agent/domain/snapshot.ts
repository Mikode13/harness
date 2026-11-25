import { UnrecoverableError } from '#src/shared/domain/errors';
import type { Session } from '#src/shared/domain/session';
import type { Agent } from './agent.ts';

/** The `format` of a `ConversationSnapshot`. */
export const conversationFormat = 'mikode-harness/conversation';

/** The versions of `ConversationSnapshot` this release restores. */
export const conversationVersions = [1] as const;

/**
 * Everything one agent on the model APIs recorded, as plain JSON, taken between its runs with
 * `ConversationAgent.snapshot()`: `JSON.stringify` it to store it, and give it back, parsed, to
 * `createLLMAgent`'s `restore` to build a fresh agent that goes on from it.
 *
 * It holds what the model was sent and answered, word for word: prompts, answers, tool calls and
 * their results, which can hold the contents of files the agent read and the output of the
 * commands it ran, and the providers' opaque data, such as signed or encrypted reasoning. Store
 * it as you would those files. It holds no system prompt, no tool, no credential and no
 * approval: those come from the agent that restores it.
 *
 * `format` and `version` say what it is; the rest is the harness's to read, and is checked
 * whole when it is restored. A later release may add a version, and still restores this one.
 */
export interface ConversationSnapshot {
	format: typeof conversationFormat;
	version: 1;
	/** The session the agent's runs belonged to when their options named none. */
	session: Session;
	/** The messages the conversation started with, before any turn. */
	initial: unknown[];
	/**
	 * Every turn recorded, oldest first: the turn it followed, by its index here, the run of the
	 * workspace's history it wrote in, and what was said in it, as plain JSON of no stable shape.
	 */
	turns: { parent?: number; runId?: string; messages: unknown[] }[];
	/** The turn the next run follows, unless the workspace moved since. Absent before the first. */
	currentTurn?: number;
	/** The latest move through the workspace's history the conversation followed. */
	seenRevision: number;
	/**
	 * The history the run ids and `seenRevision` belong to, once the agent followed one. Restored
	 * over another, the agent starts after that history's moves.
	 */
	history?: string;
	/**
	 * The tokens of context the model was last sent, as the provider labelled `source` counted
	 * them, which decides when the harness compacts it. Absent when unknown.
	 */
	context?: { tokens: number; source?: string };
}

/** An agent whose conversation can be taken as a snapshot between runs, and restored. */
export interface ConversationAgent extends Agent {
	/**
	 * A copy of what the agent recorded, as plain JSON. It records a run only once the run ends,
	 * so a snapshot taken once `run()` settled holds that run, and never half of one.
	 *
	 * @throws {RunInProgressError} while a run works on the agent, including between the attempts
	 * of a run that is retried: take it once `run()` settles. Also while a run that one of its
	 * turns was recorded in is still open, as another agent's run is when this agent works inside
	 * it, such as a workflow's stage: that run may still tie the turn to the history run it writes,
	 * so take the snapshot once the outermost run settles.
	 */
	snapshot(): ConversationSnapshot;
}

/** The `format` of a `SessionSnapshot`. */
export const sessionFormat = 'mikode-harness/session';

/** The versions of `SessionSnapshot` this release restores. */
export const sessionVersions = [1] as const;

/** The roles of `createLLMOrchestrator`, each a conversation a `SessionSnapshot` keeps. */
export const orchestratorRoles = ['planner', 'executor', 'reviewer'] as const;

/**
 * What a composed agent needs to go on, as plain JSON, taken when its run ended with
 * `SessionAgent.snapshot()`: `JSON.stringify` it to store it, and give it back, parsed, to the
 * same factory's `restore`. Today that is `createLLMOrchestrator`'s.
 *
 * It holds the conversation of each agent the composition keeps from one run to the next, the
 * planner's, the executor's and the reviewer's, each a `ConversationSnapshot` with what that
 * holds: file contents and command output among them. Agents that live only inside a run, the
 * explorers, the committer and the agents a `DelegationTool` starts, keep nothing: what they
 * handed over is in the conversation of the role that called them.
 *
 * `boundary` says where it was taken. `completed` is the one boundary this release supports: no
 * run was working, so nothing of a run is half kept. A checkpoint inside a run, between two
 * stages, is not supported yet; a run cut short, by a crash or a closed process, is not in any
 * snapshot, and restoring the last one never runs it again.
 */
export interface SessionSnapshot {
	format: typeof sessionFormat;
	version: 1;
	/** The composition it was taken of, which the agent restoring it must be. */
	flow: 'llm-orchestrator';
	/** Where it was taken: once every run had ended. */
	boundary: 'completed';
	/** The session the composition's runs belonged to when their options named none. */
	session: Session;
	/** Each kept agent's conversation, by its role. */
	roles: Record<(typeof orchestratorRoles)[number], ConversationSnapshot>;
}

/** A composed agent whose agents' conversations can be taken as a snapshot between runs. */
export interface SessionAgent extends Agent {
	/**
	 * A copy of what its agents recorded, as plain JSON, at the `completed` boundary.
	 *
	 * @throws {RunInProgressError} while a run works on it, between two of its stages included:
	 * take it once `run()` settles.
	 */
	snapshot(): SessionSnapshot;
}

type Options = ConstructorParameters<typeof UnrecoverableError>[1];

/**
 * A snapshot given to restore is not one this release can read: not a snapshot, or one whose
 * content breaks its format. Thrown while the agent is built, before any model or tool runs.
 */
export class InvalidSnapshotError extends UnrecoverableError {
	// The parameters keep the shape `withSpentTokens` copies a classified failure with.
	constructor(message: string, options: Options) {
		super(message, options);
		this.name = 'InvalidSnapshotError';
	}
}

/**
 * A snapshot of a version this release does not restore, such as one a later release took.
 * Thrown while the agent is built, before any model or tool runs.
 */
export class UnsupportedSnapshotVersionError extends InvalidSnapshotError {
	/** The version the snapshot names, as it names it. */
	readonly version: unknown;

	constructor(message: string, options: Options & { version?: unknown }) {
		super(message, options);
		this.name = 'UnsupportedSnapshotVersionError';
		this.version = options.version;
	}
}
