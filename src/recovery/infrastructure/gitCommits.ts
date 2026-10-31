import {
	copyFile,
	type FileHandle,
	mkdtemp,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
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

/**
 * What one move tells each branch it changes: where to warn, and, by repository, the paths whose
 * index the user staged, as found by the phases so far, so a later phase does not take them for
 * the branch's.
 */
export interface BranchMoving {
	warn: BranchWarning;
	staged: Map<string, Set<string>>;
}

/** The move of a branch git was about to make, so a move whose process stopped can tell if it did. */
export interface BranchIntent {
	from: string;
	to: string;
	/** What the move reports once the branch is at `to`. */
	report: BranchMove;
}

/** How far git got with one phase of a move, going over its branches in order. */
export interface GitProgress {
	/** How many branches are finished. */
	branches: number;
	/** What the finished branches report. */
	reports: BranchMove[];
	/** The move the next branch was about to make, when the process stopped as git made it. */
	intent?: BranchIntent;
}

/**
 * One phase of a move: how far an earlier attempt at it got, and where to keep how far it gets,
 * before git moves a branch and after each branch is finished.
 */
export interface GitPhase {
	progress: GitProgress;
	record: (progress: GitProgress) => Promise<void>;
}

/** What a branch's step needs to move it, and the intent of an earlier attempt that moved it. */
interface BranchStep {
	moving: BranchMoving;
	intend: (intent: BranchIntent) => Promise<void>;
	resumed?: BranchIntent;
}

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
			for (const { sha, original, runId } of commits) {
				states.set(
					commitKey(repository, branch, original ?? sha, runId),
					action === 'reapply' ? { sha } : { sha, taken: action },
				);
			}
		}
	}
	return states;
}

/**
 * Names a commit a run recorded on one branch: the same commit may be on two branches, and a move
 * that takes it back from one leaves it on the other; and a later run may bring back one an
 * earlier move took back, which is then that run's to take back again.
 */
export function commitKey(repository: string, branch: string, sha: string, runId: string): string {
	return JSON.stringify([repository, branch, sha, runId]);
}

/**
 * What undoing does with the commits of the runs it undoes, per branch, newest first, before the
 * files are moved: with `keep`, it reports those still on their branch; with `revert` or `reset`,
 * it takes them back, or leaves them and says why. A commit an earlier move took back is left
 * out. A phase an earlier attempt began goes on from where it stopped, as `eachBranch` says.
 */
export async function undoCommits(
	commits: readonly BranchCommit[],
	policy: CommitsPolicy,
	phase: GitPhase,
	moving: BranchMoving,
): Promise<BranchMove[]> {
	return eachBranch(commits, phase, moving, async ({ repository, branch, commits: all }, step) => {
		const live = all.filter(commit => commit.taken === undefined);
		if (live.length === 0) return [];
		if (policy === 'keep') return listed(await keptOn(repository, branch, live, moving.warn));
		return listed(
			policy === 'revert'
				? await revert(repository, branch, live, step)
				: await reset(repository, branch, live, step),
		);
	});
}

/**
 * What redoing does with the commits of the runs it redoes, per branch, oldest first, before the
 * files are moved: it puts back those an earlier move took back, and reports the others as kept.
 * A phase an earlier attempt began goes on as for `undoCommits`.
 */
export async function redoCommits(
	commits: readonly BranchCommit[],
	phase: GitPhase,
	moving: BranchMoving,
): Promise<BranchMove[]> {
	return eachBranch(commits, phase, moving, async ({ repository, branch, commits: all }, step) => {
		const taken = all.filter(commit => commit.taken !== undefined);
		const kept = await keptOn(
			repository,
			branch,
			all.filter(commit => commit.taken === undefined),
			moving.warn,
		);
		return [
			...listed(kept),
			...(taken.length === 0 ? [] : [await reapply(repository, branch, taken, step)]),
		];
	});
}

function listed(move: BranchMove | undefined): BranchMove[] {
	return move ? [move] : [];
}

/**
 * Each commit of `commits` once, where it first appears: two runs record the same one when the
 * branch went back and a later command brought it forward again, and git takes it back, or puts
 * it back, once. The report still names it for each run.
 */
function once(commits: readonly BranchCommit[]): BranchCommit[] {
	const seen = new Set<string>();
	return commits.filter(({ sha }) => {
		if (seen.has(sha)) return false;
		seen.add(sha);
		return true;
	});
}

/**
 * Follows each branch in turn, and records after each how far the phase got. A branch an earlier
 * attempt finished is not followed again; the one it was moving when its process stopped is
 * reported as git left it, by `resumedAt`; those after it are followed as usual.
 */
async function eachBranch(
	commits: readonly BranchCommit[],
	{ progress, record }: GitPhase,
	moving: BranchMoving,
	follow: (
		group: { repository: string; branch: string; commits: BranchCommit[] },
		step: BranchStep,
	) => Promise<BranchMove[]>,
): Promise<BranchMove[]> {
	const reports = [...progress.reports];
	for (const [at, group] of byBranch(commits).entries()) {
		if (at < progress.branches) continue;
		const step: BranchStep = {
			moving,
			intend: intent => record({ branches: at, reports: [...reports], intent }),
			...(at === progress.branches && progress.intent ? { resumed: progress.intent } : {}),
		};
		reports.push(...(await follow(group, step)));
		await record({ branches: at + 1, reports: [...reports] });
	}
	return reports;
}

/**
 * What an earlier attempt that stopped as git moved the branch did: the move it intended when the
 * branch is where it was going, with `warn` told that the index may not have followed, and
 * `undefined` otherwise, when the harness leaves the branch as it is.
 */
async function resumedAt(
	repository: string,
	branch: string,
	{ to, report: intended }: BranchIntent,
	warn: BranchWarning,
): Promise<BranchMove | undefined> {
	const tip = await branchTip(repository, branch).catch(() => undefined);
	if (tip !== to) return undefined;
	warn(
		`The history moved ${branch} in ${repository} before its process stopped, so it may not have brought the index to the new tip, and its lock on the index may remain: git may show those files as staged`,
	);
	return intended;
}

const stoppedReason =
	'the move stopped as git was about to move this branch, which is not where git would have taken it, so the harness left it as it is';

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
 * branch under would spoil, and no sparse checkout, whose `skip-worktree` entries an index
 * written entry by entry would lose, so git would show the files it leaves out as deleted.
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
		const sparse = await git(
			['config', '--bool', '--get', 'core.sparseCheckout'],
			repository,
			uncancelled,
		);
		if (firstLine(sparse.stdout) === 'true') {
			return `${repository} uses a sparse checkout, which the history does not follow`;
		}
		// Set by a sparse checkout, or by hand with `git update-index --skip-worktree`.
		const entries = await git(['ls-files', '-t', '-z'], repository, uncancelled);
		if (entries.exitCode !== 0) return gitReason('list the index', entries);
		if (nulSeparated(entries.stdout).some(entry => entry.startsWith('S '))) {
			return `the index of ${repository} holds skip-worktree entries, which the history does not follow`;
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
 * Adds commits that take back `commits`, given newest first, those still on the branch. Git merges
 * each in memory, as `git revert` would, and the branch is moved to them: the files are never
 * touched, since the history moves them.
 */
async function revert(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	step: BranchStep,
): Promise<BranchMove | undefined> {
	if (step.resumed) {
		return (
			(await resumedAt(repository, branch, step.resumed, step.moving.warn)) ??
			report(repository, branch, 'revert', commits, stoppedReason)
		);
	}
	const blocked = (await notReady(repository, branch)) ?? (await cannotMerge(repository));
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
		for (const { sha, subject } of once(onIt)) {
			const tree = await merged(repository, {
				base: sha,
				ours: made,
				theirs: (await parentOf(repository, sha)) ?? (await emptyCommit(repository)),
			});
			made = await commitTree(repository, tree, {
				parent: made,
				message: `Revert "${subject}"\n\nThis reverts commit ${sha}.\n`,
			});
		}
		tip = made;
	} catch (error) {
		return left(`git could not revert them: ${errorText(error)}`);
	}
	const done = report(repository, branch, 'revert', onIt);
	const moved = await moveBranch(repository, branch, { from, to: tip, report: done }, step);
	return moved ? left(moved) : done;
}

/**
 * Moves the branch back to before `commits`, given newest first, only when they are exactly what
 * the branch holds on top of where it goes back to, and its upstream holds none of them.
 */
async function reset(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	step: BranchStep,
): Promise<BranchMove> {
	const left = (reason: string) => report(repository, branch, 'reset', commits, reason);
	if (step.resumed) {
		return (
			(await resumedAt(repository, branch, step.resumed, step.moving.warn)) ?? left(stoppedReason)
		);
	}
	const blocked = await notReady(repository, branch);
	if (blocked) return left(blocked);
	const distinct = once(commits);
	let from: string;
	let target: string | undefined;
	try {
		from = await branchTip(repository, branch);
		// Every one, since a merge that is reset away could never be cherry-picked back.
		for (const { sha } of distinct.slice(0, -1)) await parentOf(repository, sha);
		target = await parentOf(repository, distinct.at(-1)?.sha ?? '');
		if (target === undefined) {
			return left('the oldest of them starts the branch, so there is no commit to go back to');
		}
		const onTop = new Set(await revList(repository, `${target}..${from}`));
		if (onTop.size !== distinct.length || distinct.some(commit => !onTop.has(commit.sha))) {
			return left(
				'other commits are among them or on top of them, and a reset would drop those too',
			);
		}
		for (const { sha } of distinct) {
			const published = await isPublished(repository, branch, sha);
			if (published !== false) return left(published || "the branch's upstream holds them");
		}
	} catch (error) {
		return left(`git could not reset the branch: ${errorText(error)}`);
	}
	const done = report(repository, branch, 'reset', commits);
	const moved = await moveBranch(repository, branch, { from, to: target, report: done }, step);
	return moved ? left(moved) : done;
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
 * commits, merged in memory as `git cherry-pick` would, otherwise. The files are never touched.
 */
async function reapply(
	repository: string,
	branch: string,
	commits: readonly BranchCommit[],
	step: BranchStep,
): Promise<BranchMove> {
	const left = (reason: string) => report(repository, branch, 'reapply', commits, reason);
	if (step.resumed) {
		return (
			(await resumedAt(repository, branch, step.resumed, step.moving.warn)) ?? left(stoppedReason)
		);
	}
	const blocked = await notReady(repository, branch);
	if (blocked) return left(blocked);
	const distinct = once(commits);
	let from: string;
	let put: { tip: string; picked?: ReadonlyMap<string, string> };
	try {
		from = await branchTip(repository, branch);
		const forward = await forwardTo(repository, from, distinct);
		if (forward) put = { tip: forward };
		else {
			const unmerged = await cannotMerge(repository);
			if (unmerged) return left(unmerged);
			put = await cherryPick(repository, from, distinct);
		}
	} catch (error) {
		return left(`git could not cherry-pick them: ${errorText(error)}`);
	}
	const { tip, picked } = put;
	const done = report(
		repository,
		branch,
		'reapply',
		picked
			? commits.map(commit => ({
					...commit,
					sha: picked.get(commit.sha) ?? commit.sha,
					original: commit.original ?? commit.sha,
				}))
			: commits,
	);
	const moved = await moveBranch(repository, branch, { from, to: tip, report: done }, step);
	return moved ? left(moved) : done;
}

/**
 * The newest of `commits`, when every one was reset and they still sit on `from`, so the branch can
 * go forward to them again.
 */
async function forwardTo(
	repository: string,
	from: string,
	commits: readonly BranchCommit[],
): Promise<string | undefined> {
	if (!commits.every(commit => commit.taken === 'reset')) return undefined;
	const newest = commits.at(-1)?.sha ?? '';
	const base = await parentOf(repository, commits[0]?.sha ?? '');
	if (base !== from) return undefined;
	const chain = await revList(repository, `${from}..${newest}`);
	const same = chain.length === commits.length && commits.every(({ sha }) => chain.includes(sha));
	return same ? newest : undefined;
}

/** New commits on `from` that make the changes of `commits`, and the new one for each. */
async function cherryPick(
	repository: string,
	from: string,
	commits: readonly BranchCommit[],
): Promise<{ tip: string; picked: Map<string, string> }> {
	const picked = new Map<string, string>();
	let tip = from;
	for (const commit of commits) {
		const tree = await merged(repository, {
			base: (await parentOf(repository, commit.sha)) ?? (await emptyCommit(repository)),
			ours: tip,
			theirs: commit.sha,
		});
		const { author, message } = await authorOf(repository, commit.sha);
		tip = await commitTree(repository, tree, { parent: tip, message, author });
		picked.set(commit.sha, tip);
	}
	return { tip, picked };
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

// The first git whose `merge-tree` takes `--merge-base`, which reverting needs.
const oldestMergingGit = [2, 40] as const;

/**
 * Whether `git version` names a git that merges a commit's change in memory: `git version 2.40.0`
 * does, `git version 2.39.3 (Apple Git-146)` does not. An answer it cannot read does not.
 */
export function mergesInMemory(versionOutput: string): boolean {
	const match = /^git version (\d+)\.(\d+)/.exec(versionOutput.trim());
	if (!match) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return (
		major > oldestMergingGit[0] || (major === oldestMergingGit[0] && minor >= oldestMergingGit[1])
	);
}

/** Why git cannot revert or re-apply a commit in memory here, or `undefined` when it can. */
async function cannotMerge(repository: string): Promise<string | undefined> {
	try {
		const version = await git(['version'], repository, uncancelled);
		if (version.exitCode !== 0) return gitReason('tell its version', version);
		if (mergesInMemory(version.stdout)) return undefined;
		return `reverting or re-applying commits needs git ${oldestMergingGit.join('.')} or later, and this machine has ${firstLine(version.stdout) || 'an unknown version'}`;
	} catch (error) {
		return `the harness could not run git: ${errorText(error)}`;
	}
}

/**
 * The tree of `ours` with the change from `base` to `theirs` merged in, as `git revert` and `git
 * cherry-pick` merge it: three ways, by content, never by where a patch's context matches.
 *
 * @throws when they conflict, such as when a later commit changed the same lines.
 */
async function merged(
	repository: string,
	{ base, ours, theirs }: { base: string; ours: string; theirs: string },
): Promise<string> {
	const result = await git(
		['merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, ours, theirs],
		repository,
		uncancelled,
	);
	if (result.exitCode === 1) {
		throw new Error('the change conflicts with what the branch holds now');
	}
	if (result.exitCode !== 0) throw gitFailed('merge the change', result);
	return firstLine(result.stdout);
}

/**
 * A commit of the empty tree, which no branch holds, to merge against for a commit with no parent:
 * the same whatever the machine, so making it again adds nothing.
 */
async function emptyCommit(repository: string): Promise<string> {
	const tree = await git(['hash-object', '-t', 'tree', devNull], repository, uncancelled);
	if (tree.exitCode !== 0) throw gitFailed('name the empty tree', tree);
	const identity = { NAME: 'harness', EMAIL: 'harness@localhost', DATE: '@0 +0000' };
	const committed = await git(
		['commit-tree', firstLine(tree.stdout), '-m', 'The empty tree'],
		repository,
		uncancelled,
		Object.fromEntries(
			['AUTHOR', 'COMMITTER'].flatMap(role =>
				Object.entries(identity).map(([field, value]) => [`GIT_${role}_${field}`, value]),
			),
		),
	);
	if (committed.exitCode !== 0) throw gitFailed('make the empty commit', committed);
	return firstLine(committed.stdout);
}

/**
 * Makes a commit of `tree` on `parent`, signed when the repository signs its commits, and returns
 * it. Author and message come from the commit it re-applies, or from the user's configuration for
 * a revert. The message goes through a file, so git keeps it as it is.
 */
async function commitTree(
	repository: string,
	tree: string,
	{ parent, message, author }: { parent: string; message: string; author?: NodeJS.ProcessEnv },
): Promise<string> {
	const scratch = await mkdtemp(join(tmpdir(), 'harness-git-'));
	try {
		const messageFile = join(scratch, 'message');
		await writeFile(messageFile, message);
		const signs = await git(
			['config', '--bool', '--get', 'commit.gpgsign'],
			repository,
			uncancelled,
		);
		const committed = await git(
			[
				// The message is written in UTF-8, whatever encoding the repository's commits use.
				'-c',
				'i18n.commitEncoding=UTF-8',
				'commit-tree',
				...(firstLine(signs.stdout) === 'true' ? ['-S'] : []),
				tree,
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
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
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
			// `format:`, not a terminator: the message ends as the commit's does.
			'--format=format:%an%x00%ae%x00%aI%x00%B',
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
 * Moves `branch` from `from` to `to`, only if it is still at `from` and still checked out, then
 * brings the index of the paths that differ to `to`, so git shows the files against the new tip:
 * the files themselves are left as they are. The move is recorded as intended before git makes
 * it, so a process that stops meanwhile can tell. What the user staged in one of those paths,
 * matching neither tip, or under or above one, is kept and goes to `warn`. Returns why it could
 * not move the branch; once the branch moved, a failure to update the index goes to `warn`, and
 * only what `warn` throws escapes.
 */
async function moveBranch(
	repository: string,
	branch: string,
	intent: BranchIntent,
	{ moving, intend }: BranchStep,
): Promise<string | undefined> {
	const { from, to } = intent;
	const { warn } = moving;
	const staged = moving.staged.get(repository) ?? new Set<string>();
	moving.staged.set(repository, staged);
	// The index stays locked from the moment it is read until the one written replaces it, as git's
	// own commands hold it, so what another process stages meanwhile waits rather than is lost.
	let index;
	try {
		index = await lockIndex(repository);
	} catch (error) {
		return errorText(error);
	}
	try {
		let update;
		try {
			// Checked again now that no checkout can change the index: one since it was first
			// checked would have git write another branch's index.
			const blocked = await notReady(repository, branch);
			if (blocked) return blocked;
			update = await indexUpdate(repository, from, to, staged, index.env);
		} catch (error) {
			return `git could not move the branch: ${errorText(error)}`;
		}
		await intend(intent);
		try {
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
		// The index first: a logger that throws must not leave it at the old tip.
		const unindexed = await writeIndex(repository, update, index);
		if (unindexed !== undefined) {
			warn(
				`The history moved ${branch} in ${repository}, but could not bring its index to the new tip, so git may show those files as staged: ${unindexed}`,
			);
		}
		if (update.kept.length > 0) {
			warn(
				`The history moved ${branch} in ${repository} and kept what was staged in ${update.kept.join(', ')}, which git now shows against the new tip`,
			);
		}
		return undefined;
	} finally {
		const unlocked = await index.release();
		if (unlocked !== undefined) {
			warn(
				`The history could not remove the lock it took on the index of ${repository}, so git may refuse to change the index until it is removed: ${unlocked}`,
			);
		}
	}
}

/** The index of a repository, locked as git locks it, with a copy to read and change. */
interface LockedIndex {
	/** Points git at the copy. */
	env: NodeJS.ProcessEnv;
	/** Replaces the index with the copy, through the lock. */
	publish(): Promise<void>;
	/** Removes the lock, unless the copy replaced the index, and the copy. Returns why it could not. */
	release(): Promise<string | undefined>;
}

/**
 * Takes `index.lock` as git does, created only if no one holds it, and copies the index beside it.
 *
 * @throws when git holds the lock, or the index cannot be found or copied.
 */
async function lockIndex(repository: string): Promise<LockedIndex> {
	const located = await git(['rev-parse', '--git-path', 'index'], repository, uncancelled);
	if (located.exitCode !== 0) throw gitFailed('find the index', located);
	const path = resolve(repository, located.stdout.replace(/\n$/, ''));
	const lock = `${path}.lock`;
	let handle: FileHandle;
	try {
		handle = await open(lock, 'wx');
	} catch (error) {
		if (code(error) !== 'EEXIST') throw error;
		throw new Error(`another git process is changing the index of ${repository} (${lock} exists)`, {
			cause: error,
		});
	}
	let unclosed = true;
	const close = async () => {
		if (!unclosed) return;
		unclosed = false;
		await handle.close();
	};
	let scratch: string | undefined;
	let published = false;
	const release = async (): Promise<string | undefined> => {
		try {
			await close();
			if (!published) await rm(lock, { force: true });
			if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
			return undefined;
		} catch (error) {
			return errorText(error);
		}
	};
	try {
		scratch = await mkdtemp(join(tmpdir(), 'harness-git-'));
		const copy = join(scratch, 'index');
		await copyFile(path, copy).catch((error: unknown) => {
			// A repository with nothing staged yet has no index.
			if (code(error) !== 'ENOENT') throw error;
		});
		return {
			env: { GIT_INDEX_FILE: copy },
			publish: async () => {
				await handle.writeFile(await readFile(copy));
				await handle.sync();
				await close();
				await rename(lock, path);
				published = true;
			},
			release,
		};
	} catch (error) {
		await release();
		throw error;
	}
}

/** The exact entries of the index that follow a branch from one tip to another. */
interface IndexUpdate {
	/** Paths `to` does not hold. */
	remove: string[];
	add: { mode: string; sha: string; path: string }[];
	/** Paths left as the user staged them. */
	kept: string[];
}

/**
 * What brings the index of the paths that differ between `from` and `to` to `to`. A path whose
 * entry matches `from` follows the branch; one that matches `to` already has; any other holds
 * what the user staged, and so does one an earlier phase of the move found staged, in `staged`,
 * which this adds to, and one whose new file or folder would take the place of an entry the user
 * staged above or under it.
 */
async function indexUpdate(
	repository: string,
	from: string,
	to: string,
	staged: Set<string>,
	index: NodeJS.ProcessEnv,
): Promise<IndexUpdate> {
	// Both sides of a rename: the index must drop the old path and take the new one.
	const changed = await git(
		['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to],
		repository,
		uncancelled,
	);
	if (changed.exitCode !== 0) throw gitFailed('compare the branch before and after', changed);
	const offOld = await stagedAgainst(repository, from, index);
	const offNew = await stagedAgainst(repository, to, index);
	const differing = nulSeparated(changed.stdout);
	for (const path of differing) if (offOld.has(path)) staged.add(path);
	const following = new Set(differing.filter(path => !staged.has(path)));
	const kept = differing.filter(path => staged.has(path) && offNew.has(path));
	const entries = await treeEntries(repository, to, following);

	// The user's entries, and every folder they sit in.
	const others = new Set<string>();
	const folders = new Set<string>();
	for (const path of await indexedPaths(repository, index)) {
		if (following.has(path)) continue;
		others.add(path);
		for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) {
			folders.add(path.slice(0, end));
		}
	}
	const clashes = (path: string) => {
		if (folders.has(path)) return true;
		for (let end = path.indexOf('/'); end !== -1; end = path.indexOf('/', end + 1)) {
			if (others.has(path.slice(0, end))) return true;
		}
		return false;
	};

	const update: IndexUpdate = { remove: [], add: [], kept };
	for (const path of following) {
		const entry = entries.get(path);
		if (entry === undefined) update.remove.push(path);
		else if (clashes(path)) kept.push(path);
		else update.add.push({ ...entry, path });
	}
	return update;
}

/** The paths whose entry in the index differs from `tree`. */
async function stagedAgainst(
	repository: string,
	tree: string,
	index: NodeJS.ProcessEnv,
): Promise<Set<string>> {
	const compared = await git(
		['diff-index', '--cached', '-z', '--name-only', '--no-renames', tree],
		repository,
		uncancelled,
		index,
	);
	if (compared.exitCode !== 0) throw gitFailed('compare the index', compared);
	return new Set(nulSeparated(compared.stdout));
}

/** The mode and object of each of `paths` that `tree` holds as a file. */
async function treeEntries(
	repository: string,
	tree: string,
	paths: ReadonlySet<string>,
): Promise<Map<string, { mode: string; sha: string }>> {
	const entries = new Map<string, { mode: string; sha: string }>();
	if (paths.size === 0) return entries;
	const listed = await git(['ls-tree', '-r', '-z', '--full-tree', tree], repository, uncancelled);
	if (listed.exitCode !== 0) throw gitFailed('list the new tip', listed);
	for (const line of nulSeparated(listed.stdout)) {
		const tab = line.indexOf('\t');
		const path = line.slice(tab + 1);
		if (!paths.has(path)) continue;
		const [mode = '', , sha = ''] = line.slice(0, tab).split(' ');
		entries.set(path, { mode, sha });
	}
	return entries;
}

async function indexedPaths(repository: string, index: NodeJS.ProcessEnv): Promise<Set<string>> {
	const listed = await git(['ls-files', '-z'], repository, uncancelled, index);
	if (listed.exitCode !== 0) throw gitFailed('list the index', listed);
	return new Set(nulSeparated(listed.stdout));
}

function nulSeparated(text: string): string[] {
	return text.split('\0').filter(path => path !== '');
}

// Paths per update-index, well within any system's limit on arguments.
const perCall = 500;

/**
 * Writes `update` to the copy of the index, entry by entry, never as a pathspec, which would reach
 * whatever the index holds under a folder, then puts the copy in place of the index. The copy is
 * written whole, not split, whatever the repository's configuration. Returns why it could not.
 */
async function writeIndex(
	repository: string,
	update: IndexUpdate,
	index: LockedIndex,
): Promise<string | undefined> {
	if (update.remove.length === 0 && update.add.length === 0) return undefined;
	const unsplit = ['-c', 'core.splitIndex=false', 'update-index'];
	try {
		for (let at = 0; at < update.remove.length; at += perCall) {
			const removed = await git(
				[...unsplit, '--force-remove', '--', ...update.remove.slice(at, at + perCall)],
				repository,
				uncancelled,
				index.env,
			);
			if (removed.exitCode !== 0) return gitReason('update the index', removed);
		}
		for (let at = 0; at < update.add.length; at += perCall) {
			const added = await git(
				[
					...unsplit,
					'--add',
					...update.add
						.slice(at, at + perCall)
						.flatMap(({ mode, sha, path }) => ['--cacheinfo', mode, sha, path]),
				],
				repository,
				uncancelled,
				index.env,
			);
			if (added.exitCode !== 0) return gitReason('update the index', added);
		}
		await index.publish();
	} catch (error) {
		return errorText(error);
	}
	return undefined;
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
