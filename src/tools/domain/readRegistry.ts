import type { RunContext } from '#src/agent/domain/runContext';

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
 * What a harness-built tool gets for one call: the run it belongs to, shared by every role, and
 * the reads of the conversation that made the call.
 */
export interface ToolCallContext {
	readonly run: RunContext;
	readonly reads: RunReads;
}
