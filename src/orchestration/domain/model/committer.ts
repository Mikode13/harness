import type { RunOptions } from '#src/agent/domain/agent';
import type { RepositoryCommit } from '#src/agent/domain/commitReport';

/** What a commit in one repository would hold, as it was when the changes were frozen. */
export interface FrozenRepository {
	readonly repository: string;
	readonly branch?: string;
	/** The paths a commit would hold, relative to `repository`. */
	readonly paths: readonly string[];
	/** Paths the run changed that a commit would leave out, with why. */
	readonly leftOut: readonly { path: string; reason: string }[];
	/** Why nothing can be committed there, such as no branch checked out. */
	readonly refused?: string;
	/** What a commit would hold, as a diff, bounded, for the message. */
	readonly diff: string;
	/** The subjects of the branch's latest commits, newest first, whose style the message follows. */
	readonly style: readonly string[];
}

/** The changes of a run a commit would hold, frozen before the reviewer reads them. */
export interface FrozenChanges {
	readonly repositories: readonly FrozenRepository[];
}

/**
 * Commits what a run changed once the reviewer approved it. Git and the workspace's history stay
 * behind it, in infrastructure.
 */
export interface Committer {
	/**
	 * What the run would commit now, `undefined` when it changed no file. Taken before each
	 * review, so the commit holds what the reviewer read.
	 *
	 * @throws {UnrecoverableError} when git cannot tell what the run's files hold.
	 */
	freeze(options: RunOptions): Promise<FrozenChanges | undefined>;
	/**
	 * Commits each repository of `frozen` that is still as it was, with its message in `messages`,
	 * by repository. One whose files changed since, or with no message, is left, and says why.
	 */
	commit(
		frozen: FrozenChanges,
		messages: ReadonlyMap<string, string>,
		options: RunOptions,
	): Promise<RepositoryCommit[]>;
}
