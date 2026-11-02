import type { RunOptions } from '#src/agent/domain/agent';

/**
 * What a run changed since a point, such as the start of a phase, for the reviewer to read. The
 * workspace's history stays behind it, in infrastructure.
 */
export interface ChangeLog {
	/** Where the run's record stands now: the point `since` shows the changes after. */
	mark(options: RunOptions): Promise<number>;
	/** What the run changed after `mark`, as a diff per file, bounded; empty when nothing. */
	since(mark: number, options: RunOptions): Promise<string>;
}
