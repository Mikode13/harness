import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** Tells what git could not do while the move went on. */
export type BranchWarning = (message: string) => void;

// No hook runs: one that changed the files, such as a `reference-transaction` or a
// `post-index-change` hook, would write outside the journal while a move restores them.
function git(args: string[], cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv = {}) {
	return runProcess('git', ['-c', 'color.ui=never', '-c', `core.hooksPath=${devNull}`, ...args], {
		cwd,
		signal,
		env: { ...gitEnvironment(), ...env },
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
 * Where each commit the runs made is now, by `commitKey`, read from the moves made so far: a
 * revert or a reset that was done takes it back, and a re-apply puts it, or a new commit for it,
 * back on the branch. A commit no move took back is not in the map.
 */
export function commitStates(
	revisions: readonly { git?: readonly BranchMove[] }[],
): Map<string, CommitState> {
	const states = new Map<string, CommitState>();
	for (const { git: moves = [] } of revisions) {
		for (const { repository, branch, action, outcome, commits } of moves) {
			if (outcome !== 'done' || action === 'keep') continue;
			for (const { sha, original } of commits) {
				states.set(
					commitKey(repository, branch, original ?? sha),
					action === 'reapply' ? { sha } : { sha, taken: action },
				);
			}
		}
	}
	return states;
}

/**
 * Names a commit a run recorded on one branch: the same commit may be on two branches, and a move
 * that takes it back from one leaves it on the other.
 */
export function commitKey(repository: string, branch: string, sha: string): string {
	return JSON.stringify([repository, branch, sha]);
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
				? await revert(repository, branch, live, warn)
				: await reset(repository, branch, live, warn);
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
				: await reapply(repository, branch, taken, warn),
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
		warn(
			`The history could not tell which commits ${branch} in ${repository} still holds, and reports every commit the move went over: ${errorText(error)}`,
		);
		return undefined;
	});
	const stayed = commits.filter(commit => held?.has(commit.sha) ?? true);
	return stayed.length === 0 ? undefined : report(repository, branch, 'keep', stayed);
}

/**
 * Why git cannot change `branch` in `repository` now, or `undefined` when it can: it must still be
 * checked out there, with no merge, rebase, cherry-pick or revert in progress, which moving the
 * branch under would spoil.
 */
async function notReady(repository: string, branch: string): Promise<string | undefined> {
	try {
		const tip = await readTip(repository, uncancelled);
		if (tip?.branch !== branch) return `${branch} is no longer checked out in ${repository}`;
		for (const name of inProgress) {
			const path = await git(['rev-parse', '--git-path', name], repository, uncancelled);
			if (path.exitCode !== 0) return gitReason('find what is in progress', path);
			if (await exists(resolve(repository, path.stdout.replace(/\n$/, '')))) {
				return `a merge, rebase, cherry-pick or revert is in progress in ${repository}`;
			}
		}
	} catch (error) {
		return `the harness could not read the state of ${repository}: ${errorText(error)}`;
	}
	return undefined;
}

// What git keeps while an operation that may still be finished or aborted is in progress.
const inProgress = [
	'MERGE_HEAD',
	'CHERRY_PICK_HEAD',
	'REVERT_HEAD',
	'rebase-merge',
	'rebase-apply',
	'sequencer',
];

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (code(error) === 'ENOENT') return false;
		throw error;
	}
}

/**
 * Adds commits that take back `commits`, given newest first, those still on the branch. They are
 * made in an index of their own, and the branch is moved to them: the files are never touched,
 * since the history moves them.
 */
async function revert(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	warn: BranchWarning,
): Promise<BranchMove | undefined> {
	const blocked = await notReady(repository, branch);
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
	const left = (reason: string) => report(repository, branch, 'revert', onIt, reason);
	let from: string;
	let tip: string;
	try {
		from = await branchTip(repository, branch);
		let made = from;
		await withIndex(repository, from, async (index, scratch) => {
			for (const { sha, subject } of onIt) {
				await applyChange(repository, index, scratch, {
					from: sha,
					to: await parentOf(repository, sha),
				});
				made = await commitIndex(repository, index, scratch, {
					parent: made,
					message: `Revert "${subject}"\n\nThis reverts commit ${sha}.\n`,
				});
			}
		});
		tip = made;
	} catch (error) {
		return left(`git could not revert them: ${errorText(error)}`);
	}
	const moved = await moveBranch(repository, branch, from, tip, warn);
	return moved ? left(moved) : report(repository, branch, 'revert', onIt);
}

/**
 * Moves the branch back to before `commits`, given newest first, only when they are exactly what
 * the branch holds on top of where it goes back to, and its upstream holds none of them.
 */
async function reset(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	warn: BranchWarning,
): Promise<BranchMove> {
	const left = (reason: string) => report(repository, branch, 'reset', commits, reason);
	const blocked = await notReady(repository, branch);
	if (blocked) return left(blocked);
	let from: string;
	let target: string | undefined;
	try {
		from = await branchTip(repository, branch);
		target = await parentOf(repository, commits.at(-1)?.sha ?? '');
		if (target === undefined) {
			return left('the oldest of them starts the branch, so there is no commit to go back to');
		}
		const onTop = new Set(await revList(repository, `${target}..${from}`));
		if (onTop.size !== commits.length || commits.some(commit => !onTop.has(commit.sha))) {
			return left(
				'other commits are among them or on top of them, and a reset would drop those too',
			);
		}
		for (const { sha } of commits) {
			const published = await isPublished(repository, branch, sha);
			if (published !== false) return left(published || "the branch's upstream holds them");
		}
	} catch (error) {
		return left(`git could not reset the branch: ${errorText(error)}`);
	}
	const moved = await moveBranch(repository, branch, from, target, warn);
	return moved ? left(moved) : report(repository, branch, 'reset', commits);
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
 * commits, cherry-picked in an index of their own, otherwise. The files are never touched.
 */
async function reapply(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	warn: BranchWarning,
): Promise<BranchMove> {
	const left = (reason: string) => report(repository, branch, 'reapply', commits, reason);
	const blocked = await notReady(repository, branch);
	if (blocked) return left(blocked);
	let from: string;
	let put: { tip: string; commits: readonly BranchCommit[] };
	try {
		from = await branchTip(repository, branch);
		put =
			(await forwardTo(repository, from, commits)) ?? (await cherryPick(repository, from, commits));
	} catch (error) {
		return left(`git could not cherry-pick them: ${errorText(error)}`);
	}
	const moved = await moveBranch(repository, branch, from, put.tip, warn);
	return moved ? left(moved) : report(repository, branch, 'reapply', put.commits);
}

/**
 * The newest of `commits`, when every one was reset and they still sit on `from`, so the branch can
 * go forward to them again.
 */
async function forwardTo(
	repository: string,
	from: string,
	commits: readonly BranchCommit[],
): Promise<{ tip: string; commits: readonly BranchCommit[] } | undefined> {
	if (!commits.every(commit => commit.taken === 'reset')) return undefined;
	const newest = commits.at(-1)?.sha ?? '';
	const base = await parentOf(repository, commits[0]?.sha ?? '');
	if (base !== from) return undefined;
	const chain = await revList(repository, `${from}..${newest}`);
	const same = chain.length === commits.length && commits.every(({ sha }) => chain.includes(sha));
	return same ? { tip: newest, commits } : undefined;
}

/** New commits on `from` that make the changes of `commits`, each naming the one it re-applies. */
async function cherryPick(
	repository: string,
	from: string,
	commits: readonly BranchCommit[],
): Promise<{ tip: string; commits: readonly BranchCommit[] }> {
	const created: BranchCommit[] = [];
	let tip = from;
	await withIndex(repository, from, async (index, scratch) => {
		for (const commit of commits) {
			const parent = await parentOf(repository, commit.sha);
			await applyChange(repository, index, scratch, { from: parent, to: commit.sha });
			const { author, message } = await authorOf(repository, commit.sha);
			tip = await commitIndex(repository, index, scratch, { parent: tip, message, author });
			created.push({ ...commit, sha: tip, original: commit.original ?? commit.sha });
		}
	});
	return { tip, commits: created };
}

async function branchTip(repository: string, branch: string): Promise<string> {
	const tip = await git(
		['rev-parse', '-q', '--verify', `${branchPrefix}${branch}^{commit}`],
		repository,
		uncancelled,
	);
	if (tip.exitCode !== 0) throw gitFailed(`read ${branch}`, tip);
	return firstLine(tip.stdout);
}

/**
 * The only parent of `sha`, or `undefined` for a commit with none. A merge is refused: which of
 * its parents it would go back to is not the history's to choose.
 */
async function parentOf(repository: string, sha: string): Promise<string | undefined> {
	const listed = await git(['rev-list', '--parents', '-n', '1', sha], repository, uncancelled);
	if (listed.exitCode !== 0) throw gitFailed(`read ${sha}`, listed);
	const [, ...parents] = firstLine(listed.stdout).split(' ');
	if (parents.length > 1)
		throw new Error(`${sha} is a merge, which the history does not take back or re-apply`);
	return parents[0];
}

async function revList(repository: string, range: string): Promise<string[]> {
	const listed = await git(['rev-list', range], repository, uncancelled);
	if (listed.exitCode !== 0) throw gitFailed(`list ${range}`, listed);
	return listed.stdout.split('\n').filter(line => line !== '');
}

/**
 * Runs `use` with an index of its own, read from `tree`, and a folder for what git reads from a
 * file, both removed after.
 */
async function withIndex(
	repository: string,
	tree: string,
	use: (index: string, scratch: string) => Promise<void>,
): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), 'harness-git-'));
	try {
		const index = join(scratch, 'index');
		const read = await git(['read-tree', tree], repository, uncancelled, { GIT_INDEX_FILE: index });
		if (read.exitCode !== 0) throw gitFailed('read the branch', read);
		await use(index, scratch);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/**
 * Applies to `index` the change from one commit to another, `undefined` for none: what reverting
 * or re-applying a commit does. The patch goes through a file, as bytes, so no text decoding can
 * change it, and comes from `diff-tree`, which reads the stored blobs, never the user's diff
 * configuration or text conversion. An empty commit changes nothing.
 *
 * @throws when it does not apply, such as when a later commit changed the same lines.
 */
async function applyChange(
	repository: string,
	index: string,
	scratch: string,
	{ from, to }: { from: string | undefined; to: string | undefined },
): Promise<void> {
	const empty = await emptyTree(repository);
	const patch = join(scratch, 'change.patch');
	const diff = await git(
		[
			'diff-tree',
			'-r',
			'-p',
			'--binary',
			'--no-renames',
			`--output=${patch}`,
			from ?? empty,
			to ?? empty,
		],
		repository,
		uncancelled,
	);
	if (diff.exitCode !== 0) throw gitFailed('read the change', diff);
	if ((await stat(patch)).size === 0) return;
	// The change as it was stored: no whitespace fixed, none ignored when matching.
	const applied = await git(
		[
			'-c',
			'apply.ignoreWhitespace=no',
			'apply',
			'--cached',
			'--binary',
			'--whitespace=nowarn',
			patch,
		],
		repository,
		uncancelled,
		{ GIT_INDEX_FILE: index },
	);
	if (applied.exitCode !== 0) throw gitFailed('apply the change', applied);
}

async function emptyTree(repository: string): Promise<string> {
	const hashed = await git(['hash-object', '-t', 'tree', '/dev/null'], repository, uncancelled);
	if (hashed.exitCode !== 0) throw gitFailed('name the empty tree', hashed);
	return firstLine(hashed.stdout);
}

/**
 * Makes a commit of `index` on `parent`, signed when the repository signs its commits, and
 * returns it. Author and message come from the commit it re-applies, or from the user's
 * configuration for a revert.
 */
async function commitIndex(
	repository: string,
	index: string,
	scratch: string,
	{ parent, message, author }: { parent: string; message: string; author?: NodeJS.ProcessEnv },
): Promise<string> {
	const tree = await git(['write-tree'], repository, uncancelled, { GIT_INDEX_FILE: index });
	if (tree.exitCode !== 0) throw gitFailed('write the tree', tree);
	const messageFile = join(scratch, 'message');
	await writeFile(messageFile, message);
	const signs = await git(['config', '--bool', '--get', 'commit.gpgsign'], repository, uncancelled);
	const committed = await git(
		[
			'commit-tree',
			...(firstLine(signs.stdout) === 'true' ? ['-S'] : []),
			firstLine(tree.stdout),
			'-p',
			parent,
			'-F',
			messageFile,
		],
		repository,
		uncancelled,
		author,
	);
	if (committed.exitCode !== 0) throw gitFailed('make the commit', committed);
	return firstLine(committed.stdout);
}

/** The author of `sha`, as the variables git reads it from, and its whole message. */
async function authorOf(
	repository: string,
	sha: string,
): Promise<{ author: NodeJS.ProcessEnv; message: string }> {
	const shown = await git(
		[
			'log',
			'-1',
			'--no-show-signature',
			'--encoding=UTF-8',
			'--format=%an%x00%ae%x00%aI%x00%B',
			sha,
		],
		repository,
		uncancelled,
	);
	if (shown.exitCode !== 0) throw gitFailed(`read ${sha}`, shown);
	const [name = '', email = '', date = '', ...message] = shown.stdout.split('\0');
	return {
		author: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
		message: message.join('\0'),
	};
}

/**
 * Moves `branch` from `from` to `to`, only if it is still at `from`, then brings the index of the
 * paths that differ to `to`, so git shows the files against the new tip: the files themselves
 * are left as they are. What the user staged in one of those paths, matching neither tip, is kept
 * and goes to `warn`. Returns why it could not move the branch; once the branch moved, a failure
 * to update the index goes to `warn`, and only what `warn` throws escapes.
 */
async function moveBranch(
	repository: string,
	branch: string,
	from: string,
	to: string,
	warn: BranchWarning,
): Promise<string | undefined> {
	let paths;
	let kept;
	try {
		// Both sides of a rename: the index must drop the old path and take the new one.
		const changed = await git(
			['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to],
			repository,
			uncancelled,
		);
		if (changed.exitCode !== 0) return gitReason('compare the branch before and after', changed);
		// The index of a path that matches the old tip follows the branch; one that matches the new
		// tip already has; any other holds what the user staged.
		const offOld = await stagedAgainst(repository, from);
		const offNew = await stagedAgainst(repository, to);
		const differing = nulSeparated(changed.stdout);
		paths = differing.filter(path => !offOld.has(path));
		kept = differing.filter(path => offOld.has(path) && offNew.has(path));
		const moved = await git(
			[
				'update-ref',
				'-m',
				'harness: move through the history',
				`${branchPrefix}${branch}`,
				to,
				from,
			],
			repository,
			uncancelled,
		);
		if (moved.exitCode !== 0) return gitReason('move the branch', moved);
	} catch (error) {
		return `git could not move the branch: ${errorText(error)}`;
	}
	if (kept.length > 0) {
		warn(
			`The history moved ${branch} in ${repository} and kept what was staged in ${kept.join(', ')}, which git now shows against the new tip`,
		);
	}
	const unindexed = await indexAt(repository, to, paths);
	if (unindexed !== undefined) {
		warn(
			`The history moved ${branch} in ${repository}, but could not bring its index to the new tip, so git may show those files as staged: ${unindexed}`,
		);
	}
	return undefined;
}

/** The paths whose entry in the index differs from `tree`. */
async function stagedAgainst(repository: string, tree: string): Promise<Set<string>> {
	const compared = await git(
		['diff-index', '--cached', '-z', '--name-only', '--no-renames', tree],
		repository,
		uncancelled,
	);
	if (compared.exitCode !== 0) throw gitFailed('compare the index', compared);
	return new Set(nulSeparated(compared.stdout));
}

function nulSeparated(text: string): string[] {
	return text.split('\0').filter(path => path !== '');
}

/** Brings the index of `paths`, taken literally, to `to`, or returns why it could not. */
async function indexAt(
	repository: string,
	to: string,
	paths: readonly string[],
): Promise<string | undefined> {
	if (paths.length === 0) return undefined;
	try {
		const scratch = await mkdtemp(join(tmpdir(), 'harness-git-'));
		try {
			const listed = join(scratch, 'paths');
			await writeFile(listed, `${paths.join('\0')}\0`);
			const indexed = await git(
				['reset', '-q', to, `--pathspec-from-file=${listed}`, '--pathspec-file-nul'],
				repository,
				uncancelled,
				{ GIT_LITERAL_PATHSPECS: '1' },
			);
			return indexed.exitCode === 0 ? undefined : gitReason('update the index', indexed);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	} catch (error) {
		return errorText(error);
	}
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
