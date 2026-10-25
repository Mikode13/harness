import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { UnrecoverableError } from '#src/shared/domain/errors';
import { runProcess } from './runProcess.ts';

// Never cancelled: creating a worktree is short, and the consumer waits for it.
const uncancelled = new AbortController().signal;

/** Runs git in `cwd`, its output unaffected by the user's colour settings. */
export function git(args: string[], cwd: string, signal: AbortSignal = uncancelled) {
	return runProcess('git', ['-c', 'color.ui=never', ...args], { cwd, signal });
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}

/** One worktree of a repository, as `git worktree list` gives it. */
export interface ListedWorktree {
	/** Its folder, as a real path. */
	path: string;
	/** The branch it has checked out; absent when its HEAD is detached. */
	branch?: string;
	locked: boolean;
}

/**
 * Every worktree of the repository `cwd` belongs to, the main folder first.
 *
 * @throws {Error} when `cwd` is in no git repository.
 */
export async function listWorktrees(cwd: string, signal?: AbortSignal): Promise<ListedWorktree[]> {
	const { stdout, stderr, exitCode } = await git(
		['worktree', 'list', '--porcelain', '-z'],
		cwd,
		signal,
	);
	if (exitCode !== 0) throw new Error(`git could not list the worktrees: ${firstLine(stderr)}`);
	const worktrees: ListedWorktree[] = [];
	let current: ListedWorktree | undefined;
	// One attribute per NUL-terminated field, and an empty field between worktrees.
	for (const field of stdout.split('\0')) {
		if (field.startsWith('worktree ')) {
			current = { path: field.slice('worktree '.length), locked: false };
			worktrees.push(current);
		} else if (current && field.startsWith('branch refs/heads/')) {
			current.branch = field.slice('branch refs/heads/'.length);
		} else if (current && (field === 'locked' || field.startsWith('locked '))) {
			current.locked = true;
		}
	}
	// git prints the paths it was given; a link in one must not hide a match.
	return Promise.all(
		worktrees.map(async worktree => ({
			...worktree,
			path: await realpath(worktree.path).catch(() => worktree.path),
		})),
	);
}

/**
 * Removes what a `worktree add` that failed left behind, and only what this call can show it
 * made: the branch, which did not exist before, if it still points at `sha` and no worktree has
 * it, and the folder it made for worktrees, if it is still empty.
 */
async function undoPartialAdd({
	cwd,
	branch,
	ref,
	sha,
	made,
}: {
	cwd: string;
	branch: string;
	ref: string;
	sha: string;
	made: string | undefined;
}): Promise<void> {
	const left = await git(['rev-parse', '--verify', '--quiet', ref], cwd);
	const worktrees = await listWorktrees(cwd).catch(() => undefined);
	const unused = worktrees?.every(worktree => worktree.branch !== branch) ?? false;
	if (left.exitCode === 0 && left.stdout.trim() === sha && unused) {
		await git(['branch', '-D', branch], cwd);
	}
	if (made !== undefined) await rmdir(made).catch(() => undefined);
}

function failed(what: string, cause: string): UnrecoverableError {
	return new UnrecoverableError(`The worktree could not be created: ${what}`, { cause });
}

/**
 * Creates a git worktree of `repository` on a new branch, `branch`, started at `from`, so an
 * agent can work there apart from other runs on the same repository: it is a folder of its own,
 * with a history of runs of its own. Give its `path` as an agent's root.
 *
 * Without `path`, it goes in a folder beside the repository's main folder, named after it:
 * `../<repository>-worktrees/<branch>`, any `/` in the branch made a `-`. A relative `path` is
 * from the working directory. The harness never removes it; the user does, or an agent given
 * `removeWorktree` when the user asks it to.
 *
 * @throws {UnrecoverableError} when `repository` is in no git repository, `branch` is not a
 * valid new branch or already exists, `from` names no commit, or the folder already exists and
 * is not empty. A failure leaves no branch or folder of its own behind.
 */
export async function createWorktree({
	repository,
	branch,
	from,
	path,
}: {
	/** A folder of the repository: its main folder, or one of its worktrees. */
	repository: string;
	/** The new branch the worktree checks out. */
	branch: string;
	/** The revision the branch starts at, such as `main` or a commit. */
	from: string;
	/** Where the worktree goes. */
	path?: string;
}): Promise<{ path: string; branch: string }> {
	const cwd = resolve(repository);
	const valid = await git(['check-ref-format', '--branch', branch], cwd);
	if (valid.exitCode !== 0) {
		throw failed(
			`"${branch}" is not a valid branch name`,
			firstLine(valid.stderr) || 'git refused it.',
		);
	}
	// Resolved first, so a revision that starts with a dash can never be read as an option.
	const commit = await git(
		['rev-parse', '--verify', '--quiet', '--end-of-options', `${from}^{commit}`],
		cwd,
	);
	if (commit.exitCode !== 0) {
		throw failed(
			`"${from}" names no commit`,
			firstLine(commit.stderr) || 'git found no such revision.',
		);
	}

	const sha = commit.stdout.trim();
	const ref = `refs/heads/${branch}`;
	if ((await git(['show-ref', '--verify', '--quiet', ref], cwd)).exitCode === 0) {
		throw failed(`the branch "${branch}" already exists`, 'Name a new branch.');
	}

	let target: string;
	if (path === undefined) {
		const [main] = await listWorktrees(cwd).catch((error: unknown) => {
			throw failed(`${cwd} is in no git repository`, String(error));
		});
		if (!main) throw failed(`${cwd} is in no git repository`, 'git listed no worktree.');
		target = join(
			dirname(main.path),
			`${basename(main.path)}-worktrees`,
			branch.replaceAll('/', '-'),
		);
	} else {
		target = resolve(path);
	}
	// git takes an empty folder, but would create the branch before refusing a full one.
	const held = await readdir(target).catch((error: unknown) =>
		(error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined,
	);
	if (held === undefined || held.length > 0) {
		throw failed(`${target} already exists`, 'Give the worktree a folder that does not.');
	}
	// The first folder this call made, if any, which it removes again should git fail.
	const made = path === undefined ? await mkdir(dirname(target), { recursive: true }) : undefined;

	const added = await git(['worktree', 'add', '-b', branch, '--', target, sha], cwd);
	if (added.exitCode !== 0) {
		await undoPartialAdd({ cwd, branch, ref, sha, made });
		throw failed('git refused it', firstLine(added.stderr));
	}
	return { path: await realpath(target), branch };
}
