import { realpath } from 'node:fs/promises';
import type {
	BranchMove,
	Commit,
	CommitsPolicy,
	MovedCommit,
} from '#src/recovery/domain/recoveryStore';
import { firstLine, gitEnvironment, runProcess } from '#src/shared/infrastructure/runProcess';

const branchPrefix = 'refs/heads/';
// SHA-1 or SHA-256.
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Never cancelled: a move that started changing a branch finishes, or takes it back.
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

/** A commit a move goes over, with its branch and what earlier moves did with it. */
export interface BranchCommit extends MovedCommit {
	repository: string;
	branch: string;
	/** How an earlier move took it back, when one did and none put it back since. */
	taken?: 'revert' | 'reset';
}

/** Where a commit a run made is now, after the moves recorded so far. */
export interface CommitState {
	/** The commit on the branch for it: the run's own, or one a later move cherry-picked. */
	sha: string;
	/** How a move took it back, when one did and none put it back since. */
	taken?: 'revert' | 'reset';
}

/** Tells why a branch could not be checked, while the move goes on. */
export type BranchWarning = (repository: string, branch: string, error: unknown) => void;

function git(args: string[], cwd: string, signal: AbortSignal) {
	return runProcess('git', ['-c', 'color.ui=never', ...args], {
		cwd,
		signal,
		env: gitEnvironment(),
	});
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
		// Only git's own line end: a folder's name may end in a space, or hold a newline.
		repository: await realpath(top.stdout.replace(/\n$/, '')),
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
	// No signature checks, whose text `log.showSignature` would mix in, and UTF-8 whatever
	// `i18n.logOutputEncoding` says, which is how the output is read.
	const log = await git(
		[
			'log',
			'--no-show-signature',
			'--encoding=UTF-8',
			'--reverse',
			'--format=%H%x00%s',
			range,
			'--',
		],
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
 * Where each commit the runs made is now, by the SHA the run recorded, read from the moves made so
 * far: a revert or a reset that was done takes it back, and a re-apply puts it, or a new commit
 * for it, back on the branch. A commit no move took back is not in the map.
 */
export function commitStates(
	revisions: readonly { git?: readonly BranchMove[] }[],
): Map<string, CommitState> {
	const states = new Map<string, CommitState>();
	for (const { git: moves = [] } of revisions) {
		for (const { action, outcome, commits } of moves) {
			if (outcome !== 'done' || action === 'keep') continue;
			for (const { sha, original } of commits) {
				states.set(original ?? sha, action === 'reapply' ? { sha } : { sha, taken: action });
			}
		}
	}
	return states;
}

/**
 * What undoing does with the commits of the runs it undoes, per branch, newest first, before the
 * files are moved: with `keep`, it reports those still on their branch; with `revert` or `reset`,
 * it takes them back, or leaves them and says why. A commit an earlier move took back is left
 * out. With `interrupted`, a move whose process stopped while git ran, git is not run again, and
 * every branch it would have changed is reported as left.
 */
export async function undoCommits(
	commits: readonly BranchCommit[],
	policy: CommitsPolicy,
	{ interrupted, warn }: { interrupted: boolean; warn: BranchWarning },
): Promise<BranchMove[]> {
	const reports: BranchMove[] = [];
	for (const { repository, branch, commits: all } of byBranch(commits)) {
		const live = all.filter(commit => commit.taken === undefined);
		if (live.length === 0) continue;
		if (policy === 'keep') {
			const kept = await keptOn(repository, branch, live, warn);
			if (kept) reports.push(kept);
			continue;
		}
		if (interrupted) {
			reports.push(report(repository, branch, policy, live, stoppedReason));
			continue;
		}
		const moved =
			policy === 'revert'
				? await revert(repository, branch, live)
				: await reset(repository, branch, live);
		if (moved) reports.push(moved);
	}
	return reports;
}

/**
 * What redoing does with the commits of the runs it redoes, per branch, oldest first, before the
 * files are moved: it puts back those an earlier move took back, and reports the others as kept.
 * With `interrupted`, as for `undoCommits`.
 */
export async function redoCommits(
	commits: readonly BranchCommit[],
	{ interrupted, warn }: { interrupted: boolean; warn: BranchWarning },
): Promise<BranchMove[]> {
	const reports: BranchMove[] = [];
	for (const { repository, branch, commits: all } of byBranch(commits)) {
		const taken = all.filter(commit => commit.taken !== undefined);
		const kept = await keptOn(
			repository,
			branch,
			all.filter(commit => commit.taken === undefined),
			warn,
		);
		if (kept) reports.push(kept);
		if (taken.length === 0) continue;
		reports.push(
			interrupted
				? report(repository, branch, 'reapply', taken, stoppedReason)
				: await reapply(repository, branch, taken),
		);
	}
	return reports;
}

const stoppedReason =
	'the move stopped while git ran on this branch, so the harness left it as it was';

function byBranch(
	commits: readonly BranchCommit[],
): { repository: string; branch: string; commits: BranchCommit[] }[] {
	const branches = new Map<
		string,
		{ repository: string; branch: string; commits: BranchCommit[] }
	>();
	for (const commit of commits) {
		const { repository, branch } = commit;
		const key = JSON.stringify([repository, branch]);
		const group = branches.get(key) ?? { repository, branch, commits: [] };
		group.commits.push(commit);
		branches.set(key, group);
	}
	return [...branches.values()];
}

function report(
	repository: string,
	branch: string,
	action: BranchMove['action'],
	commits: readonly MovedCommit[],
	reason?: string,
): BranchMove {
	return {
		repository,
		branch,
		action,
		outcome: reason === undefined ? 'done' : 'left',
		...(reason === undefined ? {} : { reason }),
		commits: commits.map(({ sha, original, subject, runId, direction }) => ({
			sha,
			...(original === undefined ? {} : { original }),
			subject,
			runId,
			direction,
		})),
	};
}

/**
 * The commits of `commits` the branch still holds, as kept. One the user since reset away did not
 * stay. When git cannot tell, every commit is reported, and `warn` is told why.
 */
async function keptOn(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	warn: BranchWarning,
): Promise<BranchMove | undefined> {
	if (commits.length === 0) return undefined;
	const held = await onBranch(repository, branch, commits).catch((error: unknown) => {
		warn(repository, branch, error);
		return undefined;
	});
	const stayed = commits.filter(commit => held?.has(commit.sha) ?? true);
	return stayed.length === 0 ? undefined : report(repository, branch, 'keep', stayed);
}

/** Why git cannot change `branch` in `repository` now, or `undefined` when it can. */
async function notCheckedOut(repository: string, branch: string): Promise<string | undefined> {
	try {
		const tip = await readTip(repository, uncancelled);
		if (tip?.branch === branch) return undefined;
	} catch (error) {
		return `the harness could not read which branch is checked out in ${repository}: ${errorText(error)}`;
	}
	return `${branch} is no longer checked out in ${repository}`;
}

/** Adds commits that take back `commits`, given newest first, those still on the branch. */
async function revert(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
): Promise<BranchMove | undefined> {
	const blocked = await notCheckedOut(repository, branch);
	if (blocked) return report(repository, branch, 'revert', commits, blocked);
	let held;
	try {
		held = await onBranch(repository, branch, commits);
	} catch (error) {
		return report(repository, branch, 'revert', commits, errorText(error));
	}
	// One the user since reset away needs no revert.
	const onIt = commits.filter(commit => held.has(commit.sha));
	if (onIt.length === 0) return undefined;
	const shas = onIt.map(commit => commit.sha);
	const reverted = await git(['revert', '--no-edit', ...shas], repository, uncancelled);
	if (reverted.exitCode !== 0) {
		// Back to before the first of them, if it got that far.
		await git(['revert', '--abort'], repository, uncancelled).catch(() => undefined);
		return report(repository, branch, 'revert', onIt, gitReason('revert them', reverted));
	}
	return report(repository, branch, 'revert', onIt);
}

/**
 * Moves the branch back to before `commits`, given newest first, only when they are exactly what
 * the branch holds on top of where it goes back to, and its upstream holds none of them.
 */
async function reset(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
): Promise<BranchMove> {
	const left = (reason: string) => report(repository, branch, 'reset', commits, reason);
	const blocked = await notCheckedOut(repository, branch);
	if (blocked) return left(blocked);
	const oldest = commits.at(-1)?.sha ?? '';
	const base = await git(['rev-parse', '-q', '--verify', `${oldest}^`], repository, uncancelled);
	if (base.exitCode !== 0) {
		return left('the oldest of them starts the branch, so there is no commit to go back to');
	}
	const target = firstLine(base.stdout);
	const above = await git(
		['rev-list', `${target}..${branchPrefix}${branch}`],
		repository,
		uncancelled,
	);
	if (above.exitCode !== 0) return left(gitReason('list the commits on the branch', above));
	const onTop = new Set(above.stdout.split('\n').filter(line => line !== ''));
	if (onTop.size !== commits.length || commits.some(commit => !onTop.has(commit.sha))) {
		return left('other commits are among them or on top of them, and a reset would drop those too');
	}
	const published = await isPublished(repository, branch, oldest);
	if (published !== false) return left(published || "the branch's upstream holds them");
	const moved = await git(['reset', '--quiet', '--keep', target], repository, uncancelled);
	if (moved.exitCode !== 0) return left(gitReason('reset the branch', moved));
	return report(repository, branch, 'reset', commits);
}

/**
 * Whether the branch's upstream holds `sha`: `false` when it has none or does not hold it, `''`
 * when it does, or why git could not tell.
 */
async function isPublished(
	repository: string,
	branch: string,
	sha: string,
): Promise<string | false> {
	const upstream = await git(
		['for-each-ref', '--format=%(upstream)', `${branchPrefix}${branch}`],
		repository,
		uncancelled,
	);
	if (upstream.exitCode !== 0) return gitReason("read the branch's upstream", upstream);
	const ref = firstLine(upstream.stdout);
	if (ref === '') return false;
	const held = await git(['merge-base', '--is-ancestor', sha, ref], repository, uncancelled);
	if (held.exitCode === 0) return '';
	if (held.exitCode === 1) return false;
	return gitReason(`tell whether ${ref} holds them`, held);
}

/**
 * Puts back `commits`, given oldest first, which earlier moves took back: forward to the same
 * commits when every one was reset and the branch is still where the reset left it, and as new
 * commits, cherry-picked, otherwise.
 */
async function reapply(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
): Promise<BranchMove> {
	const left = (reason: string) => report(repository, branch, 'reapply', commits, reason);
	const blocked = await notCheckedOut(repository, branch);
	if (blocked) return left(blocked);
	const tip = await git(['rev-parse', '-q', '--verify', 'HEAD'], repository, uncancelled);
	if (tip.exitCode !== 0) return left(gitReason('read the branch', tip));
	const from = firstLine(tip.stdout);

	if (commits.every(commit => commit.taken === 'reset')) {
		const forward = await fastForward(repository, from, commits);
		if (forward === true) return report(repository, branch, 'reapply', commits);
		if (forward !== undefined) return left(forward);
	}

	const shas = commits.map(commit => commit.sha);
	const picked = await git(
		['cherry-pick', '--allow-empty', '--keep-redundant-commits', ...shas],
		repository,
		uncancelled,
	);
	if (picked.exitCode !== 0) {
		await git(['cherry-pick', '--abort'], repository, uncancelled).catch(() => undefined);
		return left(gitReason('cherry-pick them', picked));
	}
	const made = await git(['rev-list', '--reverse', `${from}..HEAD`], repository, uncancelled);
	const created = made.stdout.split('\n').filter(line => line !== '');
	if (made.exitCode !== 0 || created.length !== commits.length) {
		return left(gitReason('list the commits it cherry-picked', made));
	}
	return report(
		repository,
		branch,
		'reapply',
		commits.map((commit, index) => ({
			...commit,
			sha: created[index] ?? commit.sha,
			original: commit.original ?? commit.sha,
		})),
	);
}

/**
 * Moves the branch forward to `commits` again when it is still where a reset of them left it:
 * `true` once it did, why git failed to, or `undefined` when the branch moved since.
 */
async function fastForward(
	repository: string,
	from: string,
	commits: readonly BranchCommit[],
): Promise<true | string | undefined> {
	const oldest = commits[0]?.sha ?? '';
	const newest = commits.at(-1)?.sha ?? '';
	const base = await git(['rev-parse', '-q', '--verify', `${oldest}^`], repository, uncancelled);
	if (base.exitCode !== 0 || firstLine(base.stdout) !== from) return undefined;
	const chain = await git(['rev-list', `${from}..${newest}`], repository, uncancelled);
	const between = new Set(chain.stdout.split('\n').filter(line => line !== ''));
	if (chain.exitCode !== 0 || between.size !== commits.length) return undefined;
	if (commits.some(commit => !between.has(commit.sha))) return undefined;
	const moved = await git(['reset', '--quiet', '--keep', newest], repository, uncancelled);
	return moved.exitCode === 0 || gitReason('move the branch forward', moved);
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
	return new Error(gitReason(what, { stderr }));
}

function gitReason(what: string, { stderr }: { stderr: string }): string {
	return `git could not ${what}: ${firstLine(stderr) || 'no reason given'}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
