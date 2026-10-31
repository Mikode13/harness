import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { RunOptions } from '#src/agent/domain/agent';
import type { RepositoryCommit } from '#src/agent/domain/commitReport';
import { runContextOf } from '#src/agent/domain/runContext';
import type { FileChange } from '#src/recovery/domain/fileChanges';
import type {
	Commit,
	FileState,
	RecordedCommits,
	RecoveryStore,
} from '#src/recovery/domain/recoveryStore';
import { changedFiles, showChanges } from '#src/recovery/domain/runChanges';
import {
	type BranchTip,
	commitsBetween,
	notReady,
	readTip,
} from '#src/recovery/infrastructure/gitCommits';
import { isAbortError } from '#src/shared/domain/isAbortError';
import { describeFailure } from '#src/shared/domain/providerFailure';
import {
	firstLine,
	gitEnvironment,
	type ProcessResult,
} from '#src/shared/infrastructure/runProcess';
import { AccessDeniedError, type AccessPolicy } from '#src/tools/domain/accessPolicy';
import { EditUnconfirmedError } from '#src/tools/domain/fileEdits';
import { CommandCheckpoint, type CoveredFiles } from '#src/tools/infrastructure/commandCheckpoint';
import { withoutColors } from '#src/tools/infrastructure/commandOutput';
import { runCommandProcess } from '#src/tools/infrastructure/commandProcess';
import type { WorkspaceWrites } from '#src/tools/infrastructure/workspaceWrites';
import type { WriteSession } from '#src/tools/infrastructure/writeSession';
import type {
	Committer,
	FrozenChanges,
	FrozenRepository,
} from '#src/orchestration/domain/model/committer';

// How the history names what the commit changed, as it names a command.
const committerName = 'the committer';
// Never cancelled: once git ran, the commits it made must reach the history.
const uncancelled = new AbortController().signal;
// A commit whose hooks run the project's checks can take a while.
const commitTimeoutMs = 10 * 60_000;
const commitOutputBytes = 16 * 1024;
// What a rejection reports of what git and its hooks printed.
const reasonCharacters = 2000;
// The diff the message is written from: enough to say what changed, not the whole change.
const diffLines = 400;
const styleSubjects = 10;
// Each git call that reads or stages, which a filter of the repository's may slow down.
const gitTimeoutMs = 2 * 60_000;

/** A blob in a tree or in the index, and its mode. */
interface GitEntry {
	mode: string;
	sha: string;
}

/** What git holds, or would hold, at one path: the blob as git stores it, and its mode. */
interface PathState {
	exists: boolean;
	sha?: string;
	mode?: string;
	/** What HEAD holds there: none for a new file, which `git add` needs, and what staging matches. */
	inHead?: GitEntry;
}

/** What one repository's commit would hold when it was frozen. */
interface FrozenState {
	branch: string;
	head: string | undefined;
	paths: Map<string, PathState>;
}

/**
 * The orchestrator's `Committer` on git: it commits a run's changes with `git commit --only`, so
 * what else the user staged stays staged, and git's hooks run. The commit is captured and
 * recorded as a command is, so undoing the run can take it back.
 *
 * It commits only what it can tell is the run's, as the reviewer read it: a file the user had
 * changed before the run, or changed since, is left out and named.
 */
export class GitCommitter implements Committer {
	private readonly store: RecoveryStore;
	private readonly writes: WorkspaceWrites;
	private readonly covered: CoveredFiles;
	private readonly policy: AccessPolicy;
	private readonly runCommit: typeof runCommandProcess;
	// What each freeze found, kept here so the orchestrator never handles git's state.
	private readonly states = new WeakMap<FrozenChanges, Map<string, FrozenState>>();

	constructor({
		store,
		writes,
		covered,
		policy,
		runCommit = runCommandProcess,
	}: {
		store: RecoveryStore;
		writes: WorkspaceWrites;
		/** What the commit's checkpoint captures, as for a command. */
		covered: CoveredFiles;
		/** What the message's diff may show. */
		policy: AccessPolicy;
		/** Runs `git commit`. Replaced in tests. */
		runCommit?: typeof runCommandProcess;
	}) {
		this.store = store;
		this.writes = writes;
		this.covered = covered;
		this.policy = policy;
		this.runCommit = runCommit;
	}

	async freeze(options: RunOptions): Promise<FrozenChanges | undefined> {
		const runId = runContextOf(options)?.historyRun.runId;
		if (runId === undefined) return undefined;
		const { record, entries, unrecorded, commits } = await this.store.readRun(runId);
		const changes = changedFiles(record, entries);
		if (changes.length === 0 && unrecorded.length === 0) return undefined;

		const groups = new Map<string, { tip: BranchTip; items: Item[] }>();
		const tips = new Map<string, BranchTip | undefined>();
		const add = async (item: Item) => {
			const tip = await tipOf(item.path, tips, options.signal);
			// Outside any repository: there is nothing to commit it in.
			if (!tip) return;
			const group = groups.get(tip.repository) ?? { tip, items: [] };
			group.items.push(item);
			groups.set(tip.repository, group);
		};
		for (const change of changes) await add({ path: change.path, change });
		for (const { path } of unrecorded) await add({ path });

		const repositories: FrozenRepository[] = [];
		const states = new Map<string, FrozenState>();
		for (const { tip, items } of groups.values()) {
			const frozen = await this.freezeIn(tip, items, commits, runId, options.signal);
			repositories.push(frozen.repository);
			if (frozen.state) states.set(tip.repository, frozen.state);
		}
		const result: FrozenChanges = { repositories };
		this.states.set(result, states);
		return result;
	}

	private async freezeIn(
		tip: BranchTip,
		items: readonly Item[],
		commits: readonly RecordedCommits[],
		runId: string,
		signal: AbortSignal,
	): Promise<{ repository: FrozenRepository; state?: FrozenState }> {
		const { repository, branch, head } = tip;
		const refuse = (refused: string) => ({
			repository: {
				repository,
				...(branch === undefined ? {} : { branch }),
				paths: [],
				leftOut: [],
				refused,
				diff: '',
				style: [],
			},
		});
		if (branch === undefined) return refuse('no branch is checked out there');
		const blocked = await notReady(repository, branch);
		if (blocked !== undefined) return refuse(blocked);

		const rel = (path: string) => relative(repository, path).split(sep).join('/');
		const leftOut: { path: string; reason: string }[] = [];
		const candidates: { path: string; rel: string; change: FileChange }[] = [];
		for (const { path, change } of items) {
			const reason = change ? whyNotTheRuns(change) : 'the history could not copy it';
			if (reason !== undefined || !change) {
				leftOut.push({ path: rel(path), reason: reason ?? 'the history could not copy it' });
				continue;
			}
			candidates.push({ path, rel: rel(path), change });
		}
		const ignored = await ignoredOf(
			repository,
			candidates.map(candidate => candidate.rel),
			signal,
		);
		const wanted = candidates.filter(candidate => !ignored.has(candidate.rel));
		const inHead = await treeOf(
			repository,
			head,
			wanted.map(({ rel }) => rel),
			signal,
		);
		const before = await treeOf(
			repository,
			await startOf(repository, branch, head, commits, signal),
			wanted.map(({ rel }) => rel),
			signal,
		);

		const paths = new Map<string, PathState>();
		for (const { path, rel: name, change } of wanted) {
			// A file the user changed before the run, or since its last change, is theirs too.
			if (!(await this.held(path, change.after))) {
				leftOut.push({ path: name, reason: 'it changed after the task last changed it' });
				continue;
			}
			if (!(await this.matches(repository, name, change.before, before.get(name), signal))) {
				leftOut.push({ path: name, reason: 'it held changes of yours before this task' });
				continue;
			}
			const headEntry = inHead.get(name);
			if (headEntry && !isFile(headEntry.mode)) {
				leftOut.push({ path: name, reason: 'git holds a link or a submodule there' });
				continue;
			}
			const now = await stateOf(repository, name, path, signal);
			if (now.mode !== undefined && !isFile(now.mode)) {
				leftOut.push({ path: name, reason: 'it is a link or a folder now' });
				continue;
			}
			// Already committed, such as by a command the executor ran.
			if (sameBlob(now, headEntry)) continue;
			paths.set(name, { ...now, ...(headEntry ? { inHead: headEntry } : {}) });
		}
		// `--only` would replace what the user staged there, which nothing else holds.
		const staged = await indexOf(repository, [...paths.keys()], signal);
		for (const [name, state] of paths) {
			if (stagedApart(staged.get(name), state)) {
				paths.delete(name);
				leftOut.push({ path: name, reason: 'its staged version holds changes of yours' });
			}
		}

		const eligible = new Set(
			wanted.filter(({ rel: name }) => paths.has(name)).map(({ path }) => path),
		);
		const diff =
			eligible.size === 0
				? ''
				: await showChanges(this.store, runId, {
						maxLines: diffLines,
						visible: path =>
							eligible.has(path) ? this.readable(path, signal) : Promise.resolve(false),
					});
		return {
			repository: {
				repository,
				branch,
				paths: [...paths.keys()],
				leftOut,
				diff,
				style: await styleOf(repository, head, signal),
			},
			state: { branch, head, paths },
		};
	}

	/** Whether the file holds what the run left in it, by the history's own hash, and its mode. */
	private async held(path: string, after: FileState): Promise<boolean> {
		let content: Buffer;
		let mode: number;
		try {
			mode = (await stat(path)).mode;
			content = await readFile(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return !after.exists;
			throw error;
		}
		return (
			after.exists &&
			gitMode(mode) === gitMode(after.mode) &&
			createHash('sha256').update(content).digest('hex') === after.hash
		);
	}

	/**
	 * Whether `before`, what the file held when the run first changed it, is what the branch held,
	 * as git would store it, so a commit of the file holds the run's changes alone.
	 */
	private async matches(
		repository: string,
		name: string,
		before: FileState,
		entry: GitEntry | undefined,
		signal: AbortSignal,
	): Promise<boolean> {
		if (!before.exists) return entry === undefined;
		if (!entry) return false;
		const scratch = await mkdtemp(join(tmpdir(), 'harness-commit-'));
		try {
			const copy = join(scratch, 'before');
			await writeFile(copy, await this.store.readContent(before.hash));
			const hashed = await git(['hash-object', `--path=${name}`, copy], repository, signal);
			return firstLine(hashed) === entry.sha && gitMode(before.mode) === entry.mode;
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	private async readable(path: string, signal: AbortSignal): Promise<boolean> {
		try {
			await this.policy.check(path, 'read', signal);
			return true;
		} catch (error) {
			if (error instanceof AccessDeniedError) return false;
			throw error;
		}
	}

	async commit(
		frozen: FrozenChanges,
		messages: ReadonlyMap<string, string>,
		options: RunOptions,
	): Promise<RepositoryCommit[]> {
		const states = this.states.get(frozen);
		const context = runContextOf(options);
		if (!states || !context) throw new Error('These changes were not frozen for this run');
		const session = this.writes.sessionFor(context);
		// Alone, as a command: a change another agent of the run made meanwhile would be taken for its.
		return session.exclusive(async () => {
			const reports: RepositoryCommit[] = [];
			for (const each of frozen.repositories) {
				const state = states.get(each.repository);
				if (!state || each.paths.length === 0 || each.refused !== undefined) continue;
				reports.push(
					await this.commitIn(each, state, messages.get(each.repository), session, options.signal),
				);
			}
			return reports;
		}, options.signal);
	}

	private async commitIn(
		frozen: FrozenRepository,
		state: FrozenState,
		message: string | undefined,
		session: WriteSession,
		signal: AbortSignal,
	): Promise<RepositoryCommit> {
		const { repository } = frozen;
		const { branch } = state;
		const report = (
			outcome: RepositoryCommit['outcome'],
			fields: Partial<RepositoryCommit> = {},
		): RepositoryCommit => ({
			repository,
			branch,
			outcome,
			commits: [],
			paths: [],
			leftOut: [...frozen.leftOut],
			unreviewed: [],
			...fields,
		});
		const left = (reason: string) => report('left', { reason });
		if (message === undefined) return left('the committer wrote no message');

		signal.throwIfAborted();
		const journal = await session.journalForChange();
		const checkpoint = await CommandCheckpoint.begin({
			journal,
			covered: this.covered,
			by: committerName,
			signal,
		});
		// Checked once the checkpoint holds the files, so nothing changed while it captured them
		// reaches the commit.
		let still: Awaited<ReturnType<typeof stillAsFrozen>>;
		try {
			still = await stillAsFrozen(repository, state, signal);
		} catch (error) {
			await close(checkpoint, true, session);
			throw error;
		}
		if ('reason' in still) {
			await close(checkpoint, true, session);
			return left(still.reason);
		}
		const { tip, staged } = still;

		const paths = [...state.paths.keys()];
		// Only what the index does not hold yet: what the user staged stays staged however it ends.
		const added = paths.filter(name => state.paths.get(name)?.exists === true && !staged.has(name));

		let result: Awaited<ReturnType<typeof runCommandProcess>> | undefined;
		let failure: unknown;
		const scratch = await mkdtemp(join(tmpdir(), 'harness-commit-'));
		try {
			const messageFile = join(scratch, 'message');
			await writeFile(messageFile, message.endsWith('\n') ? message : `${message}\n`);
			// A new file is not known to git, which `--only` commits from.
			if (added.length > 0) await git(['add', '--', ...added], repository, signal);
			result = await this.runCommit(
				'git',
				// `--only`: these paths, from the files, whatever else the index holds.
				['-c', 'color.ui=never', 'commit', '--only', '-F', messageFile, '--', ...paths],
				{
					cwd: repository,
					env: { ...gitEnvironment(), GIT_LITERAL_PATHSPECS: '1' },
					timeoutMs: commitTimeoutMs,
					outputBytes: commitOutputBytes,
					signal,
				},
			);
		} catch (error) {
			failure = error;
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}

		const stopped = result?.stopped ?? !(failure instanceof UnstoppedGitError);
		// Whatever happened, what git made and what its hooks changed reach the history.
		let made: Commit[];
		try {
			const after = await readTip(repository, uncancelled);
			made = after ? await commitsBetween(tip, after, uncancelled) : [];
			if (made.length > 0) {
				await journal.committed({ repository, branch, commits: made, by: committerName });
			}
		} catch (error) {
			session.stop('Writing stopped: the harness could not record the commit it made');
			await checkpoint.end({ complete: stopped }).catch(() => undefined);
			throw new EditUnconfirmedError(
				'The committer ran git, but the harness could not record what it committed; writing has stopped for this run',
				{ cause: error },
			);
		}
		await close(checkpoint, stopped, session);
		if (!stopped) {
			session.stop('Writing stopped: a hook or a filter of the commit could not be stopped');
			throw new EditUnconfirmedError(
				'A hook or a filter of the commit could not be stopped: something it started may still be changing files. Writing has stopped for this run.',
			);
		}
		// What it staged for the commit, the user had not: it goes back to untracked.
		if (made.length === 0 && added.length > 0) {
			await git(['reset', '-q', '--', ...added], repository).catch(() => undefined);
		}
		if (isAbortError(failure)) throw failure;
		if (result?.outcome === 'cancelled') signal.throwIfAborted();

		const passed = result?.outcome === 'exited' && result.exitCode === 0;
		const printed = result ? withoutColors(result.output).trim() : '';
		const why =
			passed && made.length > 0
				? undefined
				: failure !== undefined
					? `git could not run: ${describeFailure(failure)}`
					: result?.outcome === 'timedOut'
						? 'git ran past its limit and was stopped'
						: printed === ''
							? 'git made no commit'
							: printed.slice(-reasonCharacters);
		if (made.length === 0) return report('rejected', why === undefined ? {} : { reason: why });
		const committed = await whatCommitted(repository, made, state.paths);
		return report('done', {
			...(why === undefined ? {} : { reason: why }),
			commits: made,
			paths: committed.paths,
			leftOut: [
				...frozen.leftOut,
				...committed.omitted.map(path => ({ path, reason: 'a hook left it out of the commit' })),
			],
			unreviewed: committed.unreviewed,
		});
	}
}

/**
 * Whether the repository is as it was frozen, on the same tip, ready, with every path and its
 * index entry unchanged: its tip and index then, or why it is not.
 */
async function stillAsFrozen(
	repository: string,
	state: FrozenState,
	signal: AbortSignal,
): Promise<{ tip: BranchTip; staged: Map<string, GitEntry> } | { reason: string }> {
	const tip = await readTip(repository, signal);
	if (tip?.branch !== state.branch || tip.head !== state.head) {
		return { reason: 'the branch moved, or another was checked out, since the review' };
	}
	const blocked = await notReady(repository, state.branch);
	if (blocked !== undefined) return { reason: blocked };
	const changed: string[] = [];
	const staged = await indexOf(repository, [...state.paths.keys()], signal);
	for (const [name, frozenState] of state.paths) {
		const now = await stateOf(repository, name, join(repository, ...name.split('/')), signal);
		if (!sameState(now, frozenState) || stagedApart(staged.get(name), frozenState)) {
			changed.push(name);
		}
	}
	if (changed.length > 0)
		return { reason: `files changed since the review: ${changed.join(', ')}` };
	return { tip, staged };
}

/** Ends the commit's checkpoint; a failure to record what it saw stops writing for the run. */
async function close(
	checkpoint: CommandCheckpoint,
	complete: boolean,
	session: WriteSession,
): Promise<void> {
	try {
		await checkpoint.end({ complete });
	} catch (error) {
		session.stop('Writing stopped: the harness could not record what the commit changed');
		throw new EditUnconfirmedError(
			'The committer ran git, but the harness could not record what its hooks changed; writing has stopped for this run',
			{ cause: error },
		);
	}
}

/** A git process whose group could not be stopped: something it started, such as a filter, may still run. */
class UnstoppedGitError extends Error {}

/** One file the run changed, or one it changed in a way the history could not copy. */
interface Item {
	path: string;
	change?: FileChange;
}

/** Why a change cannot be committed as the run's, or `undefined` when it can. */
function whyNotTheRuns(change: FileChange): string | undefined {
	if (change.pending) return 'the run is still changing it';
	if (change.uncertain) return 'the run stopped while changing it';
	if (!change.continuous) return 'someone else changed it while the task worked';
	return undefined;
}

/** The tip of the repository `path` is in, from its nearest folder that exists. */
async function tipOf(
	path: string,
	tips: Map<string, BranchTip | undefined>,
	signal: AbortSignal,
): Promise<BranchTip | undefined> {
	let folder = dirname(path);
	for (;;) {
		if (tips.has(folder)) return tips.get(folder);
		try {
			await stat(folder);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			const parent = dirname(folder);
			if (parent === folder) return undefined;
			folder = parent;
		}
	}
	const tip = await readTip(folder, signal);
	tips.set(folder, tip);
	return tip;
}

/** The paths of `names` git ignores, asked one at a time: `-z` needs a standard input. */
async function ignoredOf(
	repository: string,
	names: readonly string[],
	signal: AbortSignal,
): Promise<Set<string>> {
	const ignored = new Set<string>();
	for (const name of names) {
		// It takes paths, not pathspecs, and refuses to be told they are literal.
		const checked = await runGit(['check-ignore', '-q', '--', name], repository, {
			literal: false,
			signal,
		});
		// 1: git does not ignore it.
		if (checked.exitCode === 0) ignored.add(name);
		else if (checked.exitCode !== 1) throw gitFailed('tell which files git ignores', checked);
	}
	return ignored;
}

/** The mode and blob `tree` holds at each of `names`. */
async function treeOf(
	repository: string,
	tree: string | undefined,
	names: readonly string[],
	signal: AbortSignal = uncancelled,
): Promise<Map<string, GitEntry>> {
	const entries = new Map<string, GitEntry>();
	if (tree === undefined || names.length === 0) return entries;
	const listed = await git(
		['ls-tree', '-z', '--full-tree', tree, '--', ...names],
		repository,
		signal,
	);
	for (const line of nulSeparated(listed)) {
		const tab = line.indexOf('\t');
		const [mode = '', , sha = ''] = line.slice(0, tab).split(' ');
		entries.set(line.slice(tab + 1), { mode, sha });
	}
	return entries;
}

/**
 * The commit the run started from on `branch`: the parent of the first commit its commands made
 * there, or HEAD when they made none, so a commit of the run's own does not count as the user's.
 */
async function startOf(
	repository: string,
	branch: string,
	head: string | undefined,
	commits: readonly RecordedCommits[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const first = commits.find(made => made.repository === repository && made.branch === branch)
		?.commits[0]?.sha;
	if (first === undefined) return head;
	const parent = await runGit(['rev-parse', '-q', '--verify', `${first}~1^{commit}`], repository, {
		signal,
	});
	return parent.exitCode === 0 ? firstLine(parent.stdout) : undefined;
}

/**
 * What git would store for the file at `name`: its blob, after git's filters, and its mode. A
 * link or a folder there has no blob, and its mode is not a file's.
 */
async function stateOf(
	repository: string,
	name: string,
	path: string,
	signal: AbortSignal,
): Promise<Omit<PathState, 'inHead'>> {
	let found: Stats;
	try {
		found = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
		throw error;
	}
	if (!found.isFile()) return { exists: true, mode: found.isSymbolicLink() ? '120000' : 'other' };
	const hashed = await git(['hash-object', '--', name], repository, signal);
	return { exists: true, sha: firstLine(hashed), mode: gitMode(found.mode) };
}

/** What the index holds at each of `names`, merged entries only. */
async function indexOf(
	repository: string,
	names: readonly string[],
	signal: AbortSignal,
): Promise<Map<string, GitEntry>> {
	const entries = new Map<string, GitEntry>();
	if (names.length === 0) return entries;
	const listed = await git(['ls-files', '-s', '-z', '--', ...names], repository, signal);
	for (const line of nulSeparated(listed)) {
		const tab = line.indexOf('\t');
		const [mode = '', sha = '', stage = ''] = line.slice(0, tab).split(' ');
		if (stage === '0') entries.set(line.slice(tab + 1), { mode, sha });
	}
	return entries;
}

/**
 * Whether the index holds a version of the path that is neither HEAD's nor the one a commit would
 * hold: one the user staged.
 */
function stagedApart(staged: GitEntry | undefined, state: PathState): boolean {
	const asInHead =
		staged === undefined
			? state.inHead === undefined
			: staged.sha === state.inHead?.sha && staged.mode === state.inHead.mode;
	return !asInHead && !sameBlob(state, staged);
}

function sameBlob(state: Omit<PathState, 'inHead'>, entry: GitEntry | undefined): boolean {
	if (!state.exists) return entry === undefined;
	return entry !== undefined && entry.sha === state.sha && entry.mode === state.mode;
}

function sameState(a: Omit<PathState, 'inHead'>, b: Omit<PathState, 'inHead'>): boolean {
	return a.exists === b.exists && a.sha === b.sha && a.mode === b.mode;
}

function isFile(mode: string): boolean {
	return mode === '100644' || mode === '100755';
}

function gitMode(mode: number): string {
	return (mode & 0o111) === 0 ? '100644' : '100755';
}

/** The subjects of the branch's latest commits, newest first. */
async function styleOf(
	repository: string,
	head: string | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	if (head === undefined) return [];
	const log = await git(
		[
			'log',
			`-${String(styleSubjects)}`,
			'--no-show-signature',
			'--encoding=UTF-8',
			'--format=%s',
			head,
			'--',
		],
		repository,
		signal,
	);
	return log.split('\n').filter(subject => subject !== '');
}

/**
 * What the commits hold of what was frozen: the frozen paths they committed, those a hook left out,
 * and the committed paths whose content is not what was frozen, one a hook changed or added.
 */
async function whatCommitted(
	repository: string,
	made: readonly Commit[],
	frozen: ReadonlyMap<string, PathState>,
): Promise<{ paths: string[]; omitted: string[]; unreviewed: string[] }> {
	const touched = new Set<string>();
	for (const { sha } of made) {
		const listed = await git(
			['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--name-only', '--no-renames', sha],
			repository,
		);
		for (const name of nulSeparated(listed)) touched.add(name);
	}
	const tip = made.at(-1)?.sha;
	const committed = await treeOf(repository, tip, [...touched]);
	const unreviewed: string[] = [];
	for (const name of touched) {
		const state = frozen.get(name);
		const entry = committed.get(name);
		if (!state || !sameBlob(state, entry)) unreviewed.push(name);
	}
	const names = [...frozen.keys()];
	return {
		paths: names.filter(name => touched.has(name)),
		omitted: names.filter(name => !touched.has(name)),
		unreviewed,
	};
}

async function git(
	args: string[],
	repository: string,
	signal: AbortSignal = uncancelled,
): Promise<string> {
	const result = await runGit(args, repository, { signal });
	if (result.exitCode !== 0) throw gitFailed(`run git ${args[0] ?? ''}`, result);
	return result.stdout;
}

/**
 * Git with every pathspec taken literally, so a path is never read as a pattern. It runs in a
 * process group of its own, as a command does, so a filter it starts stops with it: with the run's
 * `signal`, or past `gitTimeoutMs`, which fails and is not a cancellation.
 *
 * @throws {UnstoppedGitError} when its group could not be stopped.
 */
async function runGit(
	args: string[],
	repository: string,
	{ literal = true, signal = uncancelled }: { literal?: boolean; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
	const printed = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
	const result = await runCommandProcess('git', ['-c', 'color.ui=never', ...args], {
		cwd: repository,
		env: { ...gitEnvironment(), ...(literal ? { GIT_LITERAL_PATHSPECS: '1' } : {}) },
		timeoutMs: gitTimeoutMs,
		outputBytes: 1,
		signal,
		onOutput: (stream, chunk) => {
			printed[stream].push(chunk);
		},
	});
	const what = `git ${args[0] ?? ''}`;
	if (!result.stopped) {
		throw new UnstoppedGitError(`${what} left a process running that could not be stopped`);
	}
	if (result.outcome === 'cancelled') signal.throwIfAborted();
	if (result.outcome !== 'exited') {
		throw new Error(`${what} did not finish within ${String(gitTimeoutMs / 1000)} seconds`);
	}
	return {
		exitCode: result.exitCode ?? -1,
		stdout: Buffer.concat(printed.stdout).toString('utf8'),
		stderr: Buffer.concat(printed.stderr).toString('utf8'),
	};
}

function gitFailed(what: string, { stderr }: { stderr: string }): Error {
	return new Error(`git could not ${what}: ${firstLine(stderr) || 'no reason given'}`);
}

function nulSeparated(text: string): string[] {
	return text.split('\0').filter(path => path !== '');
}
