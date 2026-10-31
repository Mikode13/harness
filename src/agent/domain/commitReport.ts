/** A commit the orchestrator's committer made. */
export interface MadeCommit {
	sha: string;
	/** The first line of its message. */
	subject: string;
}

/** What the committer did in one repository. */
export interface RepositoryCommit {
	/** The real path of the folder the repository, or its worktree, is checked out in. */
	repository: string;
	/** The branch's short name. Absent with no branch checked out. */
	branch?: string;
	/**
	 * `done`: committed. `left`: the harness made no commit there, and `reason` says why, such as
	 * a file that changed after the review. `rejected`: git refused the commit, such as a hook
	 * that failed, and `reason` holds the end of what it printed.
	 */
	outcome: 'done' | 'left' | 'rejected';
	reason?: string;
	/** The commits made, which the workspace's history records as the run's. */
	commits: MadeCommit[];
	/** The paths committed, relative to `repository`. */
	paths: string[];
	/** Paths the run changed that the commit leaves out, relative to `repository`, with why. */
	leftOut: { path: string; reason: string }[];
	/**
	 * Committed paths whose content is not what the reviewer approved, relative to `repository`:
	 * a hook or a filter of git's changed or added them, or someone edited them while git committed.
	 */
	unreviewed: string[];
}

/**
 * What the committer of `createLLMOrchestrator` did once the reviewer approved a run that changed
 * files. The run succeeds whichever it is: what it changed is on disk either way.
 *
 * - `committed`: at least one repository got a commit.
 * - `declined`: the user answered anything other than "Commit".
 * - `nothing`: nothing the run changed could be committed; `repositories` says why.
 * - `failed`: committing was authorized, and no repository got a commit; each says why.
 */
export interface CommitReport {
	outcome: 'committed' | 'declined' | 'nothing' | 'failed';
	repositories: RepositoryCommit[];
}
