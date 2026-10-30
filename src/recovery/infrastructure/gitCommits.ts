import { realpath } from 'node:fs/promises';
import type { BranchMove, Commit, MovedCommit } from '#src/recovery/domain/recoveryStore';
import { firstLine, runProcess } from '#src/shared/infrastructure/runProcess';

const branchPrefix = 'refs/heads/';
// SHA-1 or SHA-256.
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Never cancelled: a move reports its commits once its files are moved.
const uncancelled = new AbortController().signal;

/** Where the branch checked out in one folder was at one moment. */
export interface BranchTip {
	/** The real path of the folder the repository, or its worktree, is checked out in. */
	repository: string;
	/** The branch's short name. Absent with no branch checked out. */
	branch?: string;
	/** Absent on a branch with no commit yet. */
	head?: string;
}

/** A commit a move went over, with the branch it was made on. */
export interface BranchCommit extends MovedCommit {
	repository: string;
	branch: string;
}

function git(args: string[], cwd: string, signal: AbortSignal) {
	return runProcess('git', ['-c', 'color.ui=never', ...args], { cwd, signal });
}

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/**
 * Where the branch checked out in `folder` is: `undefined` when `folder` is in no repository, or
 * git is not installed, since no command could have committed there.
 */
export async function readTip(folder: string, signal: AbortSignal): Promise<BranchTip | undefined> {
	let top;
	try {
		top = await git(['rev-parse', '--show-toplevel'], folder, signal);
	} catch (error) {
		if (code(error) === 'ENOENT') return undefined;
		throw error;
	}
	if (top.exitCode !== 0) return undefined;
	const [branch, head] = await Promise.all([
		// The full name: `--short` gives `heads/main` when a tag is also called `main`.
		git(['symbolic-ref', '-q', 'HEAD'], folder, signal),
		git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], folder, signal),
	]);
	const ref = branch.exitCode === 0 ? firstLine(branch.stdout) : '';
	return {
		repository: await realpath(firstLine(top.stdout)),
		...(ref.startsWith(branchPrefix) ? { branch: ref.slice(branchPrefix.length) } : {}),
		...(head.exitCode === 0 ? { head: firstLine(head.stdout) } : {}),
	};
}

/**
 * The commits made between two tips, oldest first: those new on the branch, when it is the same
 * branch both times and its new tip descends from the old one. Otherwise none are counted: a
 * branch switched, reset or rebased does not say which commits are new.
 *
 * @throws when git cannot list them.
 */
export async function commitsBetween(
	before: BranchTip,
	after: BranchTip,
	signal: AbortSignal,
): Promise<Commit[]> {
	const sameBranch =
		before.repository === after.repository &&
		before.branch !== undefined &&
		before.branch === after.branch;
	if (!sameBranch || after.head === undefined || after.head === before.head) return [];
	const { repository } = after;
	if (before.head !== undefined) {
		const descends = await git(
			['merge-base', '--is-ancestor', before.head, after.head],
			repository,
			signal,
		);
		if (descends.exitCode === 1) return [];
		if (descends.exitCode !== 0) throw gitFailed('compare the branch before and after', descends);
	}
	// On a branch with no commit before, every commit it holds now is new.
	const range = before.head === undefined ? after.head : `${before.head}..${after.head}`;
	// No signature checks: with `log.showSignature`, their text would be read as commits.
	const log = await git(
		['log', '--no-show-signature', '--reverse', '--format=%H%x00%s', range, '--'],
		repository,
		signal,
	);
	if (log.exitCode !== 0) throw gitFailed('list the new commits', log);
	return log.stdout.split('\n').flatMap(line => {
		const [sha = '', subject = ''] = line.split('\0');
		return shaPattern.test(sha) ? [{ sha, subject }] : [];
	});
}

/**
 * What a move that keeps the commits reports: per branch, the commits it went over that the
 * branch still holds. One the user since reset away did not stay. When git cannot tell, every
 * commit is reported, as recorded, and `unknown` is told why.
 */
export async function keptCommits(
	moved: readonly BranchCommit[],
	unknown: (repository: string, branch: string, error: unknown) => void,
): Promise<BranchMove[]> {
	const branches = new Map<
		string,
		{ repository: string; branch: string; commits: BranchCommit[] }
	>();
	for (const commit of moved) {
		const { repository, branch } = commit;
		const key = JSON.stringify([repository, branch]);
		const group = branches.get(key) ?? { repository, branch, commits: [] };
		group.commits.push(commit);
		branches.set(key, group);
	}
	const reports: BranchMove[] = [];
	for (const { repository, branch, commits } of branches.values()) {
		const held = await onBranch(repository, branch, commits).catch((error: unknown) => {
			unknown(repository, branch, error);
			return undefined;
		});
		const stayed = commits
			.filter(commit => held?.has(commit.sha) ?? true)
			.map(({ sha, subject, runId, direction }) => ({ sha, subject, runId, direction }));
		if (stayed.length === 0) continue;
		reports.push({ repository, branch, action: 'keep', outcome: 'done', commits: stayed });
	}
	return reports;
}

/**
 * The commits of `commits` that `branch` holds.
 *
 * @throws when git cannot tell, such as when the repository or the branch is gone.
 */
async function onBranch(
	repository: string,
	branch: string,
	commits: readonly Commit[],
): Promise<Set<string>> {
	const held = new Set<string>();
	for (const { sha } of commits) {
		const result = await git(
			['merge-base', '--is-ancestor', sha, `${branchPrefix}${branch}`],
			repository,
			uncancelled,
		);
		if (result.exitCode === 0) held.add(sha);
		else if (result.exitCode !== 1) throw gitFailed(`find ${sha} on ${branch}`, result);
	}
	return held;
}

function gitFailed(what: string, { stderr }: { stderr: string }): Error {
	return new Error(`git could not ${what}: ${firstLine(stderr) || 'no reason given'}`);
}
