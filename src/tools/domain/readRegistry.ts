import type { ProgressEvent } from '#src/agent/domain/agent';
import type { Approver } from '#src/agent/domain/approval';
import type { Asker } from '#src/agent/domain/question';
import type { RunContext } from '#src/agent/domain/runContext';
import type { Tokens } from '#src/shared/domain/tokens';

/**
 * What one conversation has seen of each file: the hash of the content a read showed it, or an
 * edit of its own left. An edit is made only from that version, so the model never changes a
 * file it has not read, or one that changed since.
 *
 * Keyed by the file's real path, so two spellings of one file are one entry. It belongs to the
 * conversation, not to the run: each role, with its own conversation, has its own.
 */
export class ReadRegistry {
	private seen = new Map<string, string>();

	/** The reads of one run, which count for the conversation only once the run succeeded. */
	begin(): RunReads {
		return new RunReads(this.seen, seen => {
			this.seen = seen;
		});
	}

	/**
	 * Forgets every file: the workspace moved through its history, so what the conversation saw
	 * may no longer be what the files hold.
	 */
	clear(): void {
		this.seen = new Map();
	}
}

/**
 * The versions one run has seen, on top of what its conversation saw before it. A failed run
 * records nothing in its conversation, so the model does not remember what it read there: its
 * reads are kept only by `commit`.
 */
export class RunReads {
	private readonly base: ReadonlyMap<string, string>;
	private readonly own = new Map<string, string | undefined>();
	private readonly save: (seen: Map<string, string>) => void;

	constructor(base: ReadonlyMap<string, string>, save: (seen: Map<string, string>) => void) {
		this.base = base;
		this.save = save;
	}

	/** The version of `absolute` the conversation has seen, if any. */
	versionOf(absolute: string): string | undefined {
		return this.own.has(absolute) ? this.own.get(absolute) : this.base.get(absolute);
	}

	/** The conversation now knows `absolute` as holding the content `hash` names. */
	record(absolute: string, hash: string): void {
		this.own.set(absolute, hash);
	}

	/** The file is gone, as the conversation knows it. */
	forget(absolute: string): void {
		this.own.set(absolute, undefined);
	}

	/** Keeps this run's reads for the conversation's next runs. */
	commit(): void {
		const seen = new Map(this.base);
		for (const [path, hash] of this.own) {
			if (hash === undefined) seen.delete(path);
			else seen.set(path, hash);
		}
		this.save(seen);
	}
}

/**
 * What a harness-built tool gets for one call: the run it belongs to, shared by every role, the
 * reads of the conversation that made the call, and the run's narration and usage, for a call
 * that does its own work on the model, such as running subagents.
 */
export interface ToolCallContext {
	readonly run: RunContext;
	readonly reads: RunReads;
	/** The id of the call, which its `tool` events carry. */
	readonly callId: string;
	/**
	 * Narrates an event in the run's progress. It never throws: a failing callback ends the run
	 * once the call returns.
	 */
	readonly onProgress: (event: ProgressEvent) => void;
	/**
	 * Adds what the call spent on the model to the run's usage. `unreported` when a call it made
	 * came back without usage, which leaves the run's total unknown.
	 */
	readonly spend: (tokens: Tokens | undefined, unreported: boolean) => void;
	/** The run's approver and asker, for an agent the call starts. */
	readonly approve?: Approver;
	readonly ask?: Asker;
	/** How many delegations deep the agent that made the call runs: 0 for the top-level one. */
	readonly depth: number;
	/**
	 * The folders the call may write in, as real paths, set by the agents that delegated to the
	 * one that made it: empty when it may write nowhere, absent when none set a limit.
	 */
	readonly writeCeiling?: readonly string[];
	/**
	 * The `write` roots of the workspace of the agent that made the call, as it was given them:
	 * an agent the call starts writes only within them. Empty when it only reads, absent when it
	 * has no workspace.
	 */
	readonly agentWriteRoots?: readonly string[];
}
