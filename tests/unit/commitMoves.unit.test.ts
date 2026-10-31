import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunContext } from '../../src/agent/domain/runContext.ts';
import { commitsNote } from '../../src/engines/domain/model/historyFollower.ts';
import { createHistory, historyStart, UnrecoverableError } from '../../src/index.ts';
import { WorkspaceBusyError } from '../../src/recovery/domain/recoveryStore.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { FolderClaims } from '../../src/recovery/infrastructure/folderClaims.ts';
import * as gitCommits from '../../src/recovery/infrastructure/gitCommits.ts';
import type { Commands } from '../../src/tools/domain/commands.ts';
import { type PreparingTool, RunEndingToolError } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { EditUnconfirmedError } from '../../src/tools/domain/fileEdits.ts';
import { createCommandTool } from '../../src/tools/infrastructure/commandTool.ts';
import { commandToolFor, openWorkspace } from '../../src/tools/infrastructure/fileTools.ts';

vi.mock('../../src/recovery/infrastructure/gitCommits.ts', async importOriginal => {
	const actual = await importOriginal<typeof gitCommits>();
	return { ...actual, commitsBetween: vi.fn(actual.commitsBetween) };
});

const signal = new AbortController().signal;
// Whatever the machine's own git configuration says: no signing, no hooks, a known author.
const gitConfig = [
	'-c',
	'user.name=Test',
	'-c',
	'user.email=test@example.com',
	'-c',
	'commit.gpgsign=false',
	'-c',
	'core.hooksPath=/dev/null',
];

let parent: string;
let root: string;
let warnings: string[];

beforeEach(() => {
	warnings = [];
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-commits-')));
	root = join(parent, 'repo');
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
	writeFileSync(join(root, 'a.txt'), 'one\n');
	git('add', 'a.txt');
	git('commit', '--quiet', '-m', 'start');
});

afterEach(() => {
	vi.clearAllMocks();
	rmSync(parent, { recursive: true, force: true });
});

function git(...args: string[]): string {
	return execFileSync('git', [...gitConfig, ...args], { cwd: root, encoding: 'utf8' }).trim();
}

async function tip(): Promise<gitCommits.BranchTip> {
	const read = await gitCommits.readTip(root, signal);
	if (!read) throw new Error(`${root} is not a repository`);
	return read;
}

function head(): string {
	return git('rev-parse', 'HEAD');
}

/** A command that runs `script` in `sh`, with every `git` in it configured as the tests need. */
function shell(script: string): Commands[string] {
	const configured = script.replaceAll('git ', `git ${gitConfig.join(' ')} `);
	return { description: 'A test command', executable: 'sh', args: ['-c', configured] };
}

async function commandTool(commands: Commands) {
	const opened = await openWorkspace(
		{ roots: [{ path: root, access: 'write' }], stateDirectory: join(parent, 'state') },
		{ warn: (message: unknown) => warnings.push(String(message)) },
	);
	return { opened, tool: (await commandToolFor(opened, commands)) as PreparingTool };
}

/** Runs one command in a run of its own, and finishes the run. */
async function run(tool: PreparingTool, name: string) {
	const context = new RunContext({ id: 'test-session' });
	const call = await tool.prepare({ command: { name } }, signal, {
		run: context,
		reads: new ReadRegistry().begin(),
		callId: 'call',
		onProgress: () => undefined,
		spend: () => undefined,
		depth: 0,
	});
	const output = await call.run(signal);
	await context.finish('completed');
	return { output, runId: context.historyRun.runId ?? '' };
}

describe('the commits between two tips of a branch', () => {
	it('are none outside a repository', async () => {
		await expect(gitCommits.readTip(parent, signal)).resolves.toBeUndefined();
	});

	it('are those new on the same branch, oldest first, when its new tip descends from the old', async () => {
		const before = await tip();
		git('commit', '--quiet', '--allow-empty', '-m', 'first');
		git('commit', '--quiet', '--allow-empty', '-m', 'second');
		const after = await tip();

		expect(before).toMatchObject({ repository: root, branch: 'main' });
		expect(before.head).toMatch(/^[0-9a-f]{40}$/);
		const commits = await gitCommits.commitsBetween(before, after, signal);
		expect(commits.map(commit => commit.subject)).toEqual(['first', 'second']);
		expect(commits[1]?.sha).toBe(head());
	});

	it('are none when the branch was switched, rewound or left', async () => {
		const before = await tip();
		git('switch', '--quiet', '-c', 'other');
		git('commit', '--quiet', '--allow-empty', '-m', 'elsewhere');
		const switched = await tip();
		git('switch', '--quiet', 'main');
		git('commit', '--quiet', '--amend', '--allow-empty', '-m', 'rewritten');
		const rewound = await tip();
		git('switch', '--quiet', '--detach');
		git('commit', '--quiet', '--allow-empty', '-m', 'detached');
		const detached = await tip();

		for (const after of [switched, rewound, detached]) {
			await expect(gitCommits.commitsBetween(before, after, signal)).resolves.toEqual([]);
		}
		expect(detached).not.toHaveProperty('branch');
	});

	it('are counted on a branch a tag shares its name with', async () => {
		git('tag', 'main');
		const before = await tip();
		git('commit', '--quiet', '--allow-empty', '-m', 'beside the tag');
		const after = await tip();

		expect(before.branch).toBe('main');
		await expect(gitCommits.commitsBetween(before, after, signal)).resolves.toEqual([
			{ sha: head(), subject: 'beside the tag' },
		]);
		await expect(
			gitCommits.undoCommits(
				[
					{
						repository: root,
						branch: 'main',
						sha: head(),
						subject: 'x',
						runId: 'r',
						direction: 'undo',
					},
				],
				'keep',
				{ progress: { branches: 0, reports: [] }, record: () => Promise.resolve() },
				{ warn: () => undefined, staged: new Map() },
			),
		).resolves.toMatchObject([{ branch: 'main', commits: [{ sha: head() }] }]);
	});

	it('are read from a repository whose folder ends in a space, whatever encoding its log uses', async () => {
		const spaced = join(parent, 'spaced ');
		execFileSync('git', ['init', '--quiet', '--initial-branch=main', spaced]);
		execFileSync('git', [...gitConfig, 'commit', '--quiet', '--allow-empty', '-m', 'start'], {
			cwd: spaced,
		});
		execFileSync('git', ['config', 'i18n.logOutputEncoding', 'ISO-8859-1'], { cwd: spaced });
		const before = await gitCommits.readTip(spaced, signal);
		execFileSync('git', [...gitConfig, 'commit', '--quiet', '--allow-empty', '-m', 'café'], {
			cwd: spaced,
		});
		const after = await gitCommits.readTip(spaced, signal);

		expect(before?.repository).toBe(spaced);
		if (!before || !after) throw new Error('Not read');
		await expect(gitCommits.commitsBetween(before, after, signal)).resolves.toMatchObject([
			{ subject: 'café' },
		]);
	});

	it('are every commit of a branch that had none before', async () => {
		git('switch', '--quiet', '--orphan', 'fresh');
		const before = await tip();
		git('commit', '--quiet', '--allow-empty', '-m', 'the first');
		const after = await tip();

		expect(before).not.toHaveProperty('head');
		await expect(gitCommits.commitsBetween(before, after, signal)).resolves.toEqual([
			{ sha: head(), subject: 'the first' },
		]);
	});
});

describe('runCommand', { timeout: 20_000 }, () => {
	it('records the commits a command made, and tells the model', async () => {
		const { opened, tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
		});

		const { output, runId } = await run(tool, 'commit');

		expect(output).toContain(
			`Commits it made on main, recorded in the history: ${head().slice(0, 7)} change a.`,
		);
		const { commits } = await opened.store.readRun(runId);
		expect(commits).toEqual([
			{
				repository: root,
				branch: 'main',
				commits: [{ sha: head(), subject: 'change a' }],
				by: 'commit',
			},
		]);
	});

	it('records the commits of a command whose files could not be compared after it', async () => {
		const { opened } = await commandTool({ unused: shell('true') });
		let listings = 0;
		const tool = await createCommandTool({
			commands: { empty: shell('git commit --quiet --allow-empty -m "kept"') },
			policy: opened.policy,
			writes: opened.writes,
			covered: async listSignal => {
				if (listings++ > 0) throw new Error('listing failed');
				return opened.covered(listSignal);
			},
			base: opened.base,
			logger: opened.logger,
		});

		const context = new RunContext({ id: 'test-session' });
		const call = await tool.prepare({ command: { name: 'empty' } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
			depth: 0,
		});
		await expect(call.run(signal)).rejects.toBeInstanceOf(EditUnconfirmedError);
		await context.finish('failed');

		// Settling found no file changed, and the commit keeps the run.
		const runId = context.historyRun.runId ?? '';
		await expect(opened.store.readRun(runId)).resolves.toMatchObject({
			commits: [{ commits: [{ sha: head(), subject: 'kept' }] }],
		});
	});

	it('counts no commit made while the files were captured, before the command started', async () => {
		const { opened } = await commandTool({ unused: shell('true') });
		let listings = 0;
		const tool = await createCommandTool({
			commands: { check: shell('true') },
			policy: opened.policy,
			writes: opened.writes,
			covered: async listSignal => {
				// The user commits while the harness captures the files.
				if (listings++ === 0) git('commit', '--quiet', '--allow-empty', '-m', 'the user');
				return opened.covered(listSignal);
			},
			base: opened.base,
			logger: opened.logger,
		});

		const { output, runId } = await run(tool, 'check');

		expect(output).not.toContain('Commits it made');
		expect(runId).toBe('');
	});

	it('reads only commits from a log configured to show signatures', async () => {
		const key = join(parent, 'key');
		execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
		git('config', 'log.showSignature', 'true');
		const before = await tip();
		git(
			'-c',
			'gpg.format=ssh',
			'-c',
			`user.signingkey=${key}`,
			'commit',
			'--quiet',
			'-S',
			'--allow-empty',
			'-m',
			'signed',
		);

		await expect(gitCommits.commitsBetween(before, await tip(), signal)).resolves.toEqual([
			{ sha: head(), subject: 'signed' },
		]);
	});

	it('ends the run once what the command changed is recorded, when the logger fails', async () => {
		vi.mocked(gitCommits.commitsBetween).mockRejectedValueOnce(new Error('git broke'));
		const opened = await openWorkspace(
			{ roots: [{ path: root, access: 'write' }], stateDirectory: join(parent, 'state') },
			{
				warn: () => {
					throw new Error('logger broke');
				},
			},
		);
		const tool = (await commandToolFor(opened, {
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
		})) as PreparingTool;

		const context = new RunContext({ id: 'test-session' });
		const call = await tool.prepare({ command: { name: 'commit' } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
			depth: 0,
		});
		await expect(call.run(signal)).rejects.toBeInstanceOf(RunEndingToolError);
		await context.finish('failed');

		const { entries } = await opened.store.readRun(context.historyRun.runId ?? '');
		expect(entries).toMatchObject([{ path: join(root, 'a.txt'), status: 'applied' }]);
	});

	it('reads the repository the command runs in, whatever git the host points to', async () => {
		const other = join(parent, 'other');
		execFileSync('git', ['init', '--quiet', other]);
		const { opened, tool } = await commandTool({
			commit: shell('git commit --quiet --allow-empty -m "here"'),
		});

		vi.stubEnv('GIT_DIR', join(other, '.git'));
		const { runId } = await run(tool, 'commit');
		vi.unstubAllEnvs();

		await expect(opened.store.readRun(runId)).resolves.toMatchObject({
			commits: [{ repository: root, commits: [{ sha: head(), subject: 'here' }] }],
		});
	});

	it('keeps a run in the history that made a commit and changed no file', async () => {
		const { opened, tool } = await commandTool({
			empty: shell('git commit --quiet --allow-empty -m "nothing"'),
		});

		const { runId } = await run(tool, 'empty');

		expect(runId).not.toBe('');
		await expect(opened.store.listRuns()).resolves.toMatchObject({ head: runId });
	});

	it('records no commit made on another branch than the one it started on', async () => {
		const { opened, tool } = await commandTool({
			branch: shell('git switch --quiet -c other && git commit --quiet --allow-empty -m "x"'),
		});

		const { output, runId } = await run(tool, 'branch');

		expect(output).not.toContain('Commits it made');
		// Nothing else changed: the run left the history.
		expect(runId).toBe('');
		await expect(opened.store.listRuns()).resolves.toMatchObject({ runs: [] });
	});

	it('tells the model when git could not tell whether it made commits', async () => {
		vi.mocked(gitCommits.commitsBetween).mockRejectedValueOnce(new Error('git broke'));
		const { opened, tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
		});

		const { output, runId } = await run(tool, 'commit');

		expect(output).toContain(
			'The harness could not tell whether it made commits, so the history does not name any: git broke',
		);
		await expect(opened.store.readRun(runId)).resolves.toMatchObject({ commits: [] });
		expect(warnings).toEqual([
			'The harness could not tell whether "commit" made commits, so the history names none: git broke',
		]);
	});
});

describe('a move over runs that made commits', { timeout: 20_000 }, () => {
	it('restores the files, keeps the commits, and names them in the direction it went', async () => {
		const { tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
		});
		const { runId } = await run(tool, 'commit');
		const sha = head();
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo();

		expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
		expect(head()).toBe(sha);
		expect(undone.git).toEqual([
			{
				repository: root,
				branch: 'main',
				action: 'keep',
				outcome: 'done',
				commits: [{ sha, subject: 'change a', runId, direction: 'undo' }],
			},
		]);

		const redone = await history.redo();

		expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two\n');
		expect(redone.git?.[0]?.commits).toEqual([
			{ sha, subject: 'change a', runId, direction: 'redo' },
		]);
	});

	it('names only the commits still on their branch, and nothing for runs that made none', async () => {
		const { tool } = await commandTool({
			commit: shell('git commit --quiet --allow-empty -m "gone soon"'),
			touch: shell('echo three > a.txt'),
		});
		await run(tool, 'commit');
		git('reset', '--quiet', '--hard', 'HEAD~1');
		await run(tool, 'touch');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const touched = await history.undo();
		const committed = await history.undo();

		expect(touched).not.toHaveProperty('git');
		expect(committed).not.toHaveProperty('git');
	});

	it('goes on with git for a move that stopped before git moved a branch', async () => {
		git('config', 'user.name', 'Test');
		git('config', 'user.email', 'test@example.com');
		const { opened, tool } = await commandTool({
			commit: shell('git commit --quiet --allow-empty -m "step"'),
		});
		const first = await run(tool, 'commit');
		const firstSha = head();
		const second = await run(tool, 'commit');
		const secondSha = head();
		// The process died going to the start, once git began and before it moved the branch.
		const [state] = readdirSync(join(parent, 'state'), { recursive: true, encoding: 'utf8' })
			.filter(path => path.endsWith('head.json'))
			.map(path => join(parent, 'state', path));
		writeFileSync(
			state ?? '',
			JSON.stringify({
				runId: second.runId,
				revision: 0,
				pending: {
					revision: 1,
					from: second.runId,
					conflicts: [],
					commits: 'revert',
					gitUndo: { branches: 0, reports: [] },
				},
			}),
		);

		await opened.store.redo();

		const revisions = await opened.store.listRevisions();
		const finished = revisions.find(revision => revision.git?.[0]?.action === 'revert');
		expect(finished?.git).toEqual([
			{
				repository: root,
				branch: 'main',
				action: 'revert',
				outcome: 'done',
				commits: [
					{ sha: secondSha, subject: 'step', runId: second.runId, direction: 'undo' },
					{ sha: firstSha, subject: 'step', runId: first.runId, direction: 'undo' },
				],
			},
		]);
	});
});

describe('retention', () => {
	it('keeps the commits of a run it chains into the next', async () => {
		const store = await FileRecoveryStore.open({
			root,
			directory: join(parent, 'state'),
			keepRuns: 3,
		});
		const commitIn = async (subject: string) => {
			const journal = await store.startRun();
			const commits = [{ sha: subject.padEnd(40, '0'), subject }];
			await journal.committed({ repository: root, branch: 'main', commits, by: 'commit' });
			await journal.finish('completed');
			return journal.runId;
		};
		const first = await commitIn('a');
		const second = await commitIn('b');
		await commitIn('c');
		await commitIn('d');

		const { record, commits } = await store.readRun(second);

		expect(record.absorbed).toEqual([first]);
		expect(commits.map(made => [made.commits[0]?.subject, made.runId])).toEqual([
			['a', first],
			['b', undefined],
		]);
		// A move over the run that holds both still names the run that made each commit.
		await store.goTo(historyStart);
		const [revision] = await store.listRevisions();
		expect(revision?.git?.[0]?.commits.map(made => made.runId).slice(-2)).toEqual([second, first]);
	});
});

describe('undoing and redoing commits', { timeout: 20_000 }, () => {
	beforeEach(() => {
		// What the history's own git commits need, whatever the machine's configuration says.
		git('config', 'user.name', 'Test');
		git('config', 'user.email', 'test@example.com');
		git('config', 'commit.gpgsign', 'false');
		git('config', 'core.hooksPath', '/dev/null');
	});

	async function committedRun() {
		const { opened, tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
		});
		const { runId } = await run(tool, 'commit');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });
		return { opened, history, runId, sha: head() };
	}

	function readA(): string {
		return readFileSync(join(root, 'a.txt'), 'utf8');
	}

	it('reverts them, and cherry-picks them back on redo, then reverts the new ones', async () => {
		const { history, runId, sha } = await committedRun();

		const undone = await history.undo({ commits: 'revert' });

		expect(readA()).toBe('one\n');
		expect(undone.complete).toBe(true);
		expect(git('log', '-1', '--format=%s')).toBe('Revert "change a"');
		expect(git('status', '--porcelain')).toBe('');
		expect(undone.git).toEqual([
			{
				repository: root,
				branch: 'main',
				action: 'revert',
				outcome: 'done',
				commits: [{ sha, subject: 'change a', runId, direction: 'undo' }],
			},
		]);

		const redone = await history.redo();
		const picked = head();

		expect(readA()).toBe('two\n');
		expect(picked).not.toBe(sha);
		expect(redone.git).toEqual([
			{
				repository: root,
				branch: 'main',
				action: 'reapply',
				outcome: 'done',
				commits: [{ sha: picked, original: sha, subject: 'change a', runId, direction: 'redo' }],
			},
		]);

		const again = await history.undo({ commits: 'revert' });

		expect(readA()).toBe('one\n');
		expect(again.git?.[0]?.commits).toEqual([
			{ sha: picked, original: sha, subject: 'change a', runId, direction: 'undo' },
		]);
	});

	it('resets them away, and moves the branch forward to the same commits on redo', async () => {
		const { history, runId, sha } = await committedRun();
		const start = git('rev-parse', `${sha}^`);

		const undone = await history.undo({ commits: 'reset' });

		expect(head()).toBe(start);
		expect(readA()).toBe('one\n');
		expect(git('status', '--porcelain')).toBe('');
		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'done' });

		const redone = await history.redo();

		expect(head()).toBe(sha);
		expect(readA()).toBe('two\n');
		expect(redone.git?.[0]).toEqual({
			repository: root,
			branch: 'main',
			action: 'reapply',
			outcome: 'done',
			commits: [{ sha, subject: 'change a', runId, direction: 'redo' }],
		});
	});

	it('cherry-picks reset commits back when the branch moved on since', async () => {
		const { history, sha } = await committedRun();
		await history.undo({ commits: 'reset' });
		git('commit', '--quiet', '--allow-empty', '-m', 'the user');

		const redone = await history.redo();

		expect(git('log', '-1', '--format=%s')).toBe('change a');
		expect(redone.git?.[0]?.commits[0]).toMatchObject({ sha: head(), original: sha });
		// The message as the commit's ends, with no line added.
		const raw = (commit: string) =>
			execFileSync('git', ['cat-file', 'commit', commit], { cwd: root, encoding: 'utf8' });
		expect(raw('HEAD').endsWith('\n\nchange a\n')).toBe(true);
		expect(raw(sha).endsWith('\n\nchange a\n')).toBe(true);
	});

	it('leaves the branch, and the index of the one checked out, when the user switches while git commits', async () => {
		const { history } = await committedRun();
		git('branch', 'other');
		// A signing program that switches the branch, as the user could while git signs.
		const program = join(parent, 'sign.sh');
		writeFileSync(
			program,
			[
				'#!/bin/sh',
				`git -C '${root}' switch --quiet other`,
				'cat > /dev/null',
				"printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 X\\n' >&2",
				"printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nx\\n-----END PGP SIGNATURE-----\\n'",
			].join('\n'),
			{ mode: 0o755 },
		);
		git('config', 'commit.gpgsign', 'true');
		git('config', 'gpg.program', program);

		const undone = await history.undo({ commits: 'revert' });

		expect(undone.git?.[0]).toMatchObject({
			action: 'revert',
			outcome: 'left',
			reason: `main is no longer checked out in ${root}`,
		});
		expect(git('diff', '--cached', '--name-only')).toBe('');
	});

	it('leaves the branch when a reset would drop a commit on top, or one its upstream holds', async () => {
		const { history } = await committedRun();
		git('commit', '--quiet', '--allow-empty', '-m', 'the user');
		const tip = head();

		const onTop = await history.undo({ commits: 'reset' });

		expect(head()).toBe(tip);
		expect(readA()).toBe('one\n');
		expect(onTop.git?.[0]).toMatchObject({
			action: 'reset',
			outcome: 'left',
			reason: 'other commits are among them or on top of them, and a reset would drop those too',
		});

		await history.redo();
		const remote = join(parent, 'remote.git');
		execFileSync('git', ['init', '--quiet', '--bare', remote]);
		git('remote', 'add', 'origin', remote);
		git('reset', '--quiet', '--hard', 'HEAD~1');
		git('push', '--quiet', '-u', 'origin', 'main');

		const published = await history.undo({ commits: 'reset' });

		expect(published.git?.[0]).toMatchObject({
			outcome: 'left',
			reason: "the branch's upstream holds them",
		});
	});

	it('leaves the branch as it was when a revert conflicts, or the branch is not checked out', async () => {
		const { history, runId } = await committedRun();
		writeFileSync(join(root, 'a.txt'), 'three\n');
		git('commit', '--quiet', '-am', 'the user');
		const tip = head();

		const conflicting = await history.undo({ commits: 'revert' });

		expect(head()).toBe(tip);
		expect(git('status', '--porcelain')).toBe('');
		expect(conflicting.git?.[0]).toMatchObject({ action: 'revert', outcome: 'left' });
		expect(conflicting.git?.[0]?.reason).toMatch(/^git could not revert them: /);
		expect(conflicting.conflicts).toEqual([{ path: 'a.txt', runId }]);

		await history.redo();
		git('switch', '--quiet', '-c', 'other');

		const elsewhere = await history.undo({ commits: 'revert' });

		expect(elsewhere.git?.[0]).toMatchObject({
			outcome: 'left',
			reason: `main is no longer checked out in ${root}`,
		});
	});

	it('leaves the files to the history: a run that only committed an earlier edit keeps it', async () => {
		const { tool } = await commandTool({
			edit: shell('echo two > a.txt'),
			commit: shell('git commit --quiet -am "commit a"'),
		});
		await run(tool, 'edit');
		const committed = head();
		await run(tool, 'commit');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		for (const commits of ['reset', 'revert'] as const) {
			const undone = await history.undo({ commits });

			expect(undone).toMatchObject({ complete: true, git: [{ action: commits, outcome: 'done' }] });
			// The edit's run is where the workspace is: its file stays, now a change git shows.
			expect(readA()).toBe('two\n');
			expect(git('status', '--porcelain')).toBe('M a.txt');
			await history.redo();
		}
		expect(git('log', '--format=%s', `${committed}..HEAD`).split('\n')).toEqual([
			'commit a',
			'Revert "commit a"',
			'commit a',
		]);
	});

	it('leaves the branch while the user has a cherry-pick in progress, and the cherry-pick too', async () => {
		const { history } = await committedRun();
		const marker = join(root, '.git', 'CHERRY_PICK_HEAD');
		writeFileSync(marker, `${head()}\n`);
		const tip = head();

		const undone = await history.undo({ commits: 'revert' });

		expect(head()).toBe(tip);
		expect(readFileSync(marker, 'utf8')).toBe(`${tip}\n`);
		expect(undone.git?.[0]).toMatchObject({
			outcome: 'left',
			reason: `a merge, rebase, cherry-pick or revert is in progress in ${root}`,
		});
	});

	it('resets nothing when its upstream holds any of the commits, not only the oldest', async () => {
		const { tool } = await commandTool({
			merge: shell(
				'git switch --quiet -c side && git commit --quiet --allow-empty -m S && git switch --quiet main && git commit --quiet --allow-empty -m M && git merge --quiet --no-ff --no-edit side',
			),
		});
		await run(tool, 'merge');
		const remote = join(parent, 'remote.git');
		execFileSync('git', ['init', '--quiet', '--bare', remote]);
		git('remote', 'add', 'origin', remote);
		// The upstream holds the mainline commit, and not the side branch's.
		git('push', '--quiet', 'origin', 'HEAD^1:refs/heads/main');
		git('fetch', '--quiet', 'origin');
		git('branch', '--quiet', '--set-upstream-to=origin/main');
		const tip = head();
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'reset' });

		expect(head()).toBe(tip);
		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'left' });
	});

	it('resets nothing when a merge is among the commits, which could not be put back', async () => {
		const { tool } = await commandTool({
			merge: shell(
				'git switch --quiet -c side && git commit --quiet --allow-empty -m S && git switch --quiet main && git commit --quiet --allow-empty -m M && git merge --quiet --no-ff --no-edit side',
			),
		});
		await run(tool, 'merge');
		const tip = head();
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'reset' });

		expect(head()).toBe(tip);
		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'left' });
		expect(undone.git?.[0]?.reason).toMatch(/is a merge, which the history does not take back/);
	});

	it('takes a commit back from one branch and still from another that holds it', async () => {
		const { tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
			follow: shell('git merge --quiet --ff-only main'),
		});
		await run(tool, 'commit');
		git('switch', '--quiet', '-c', 'other', 'HEAD~1');
		await run(tool, 'follow');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const onOther = await history.undo({ commits: 'revert' });
		git('switch', '--quiet', 'main');
		const onMain = await history.undo({ commits: 'revert' });

		expect(onOther.git?.[0]).toMatchObject({ branch: 'other', action: 'revert', outcome: 'done' });
		expect(onMain.git?.[0]).toMatchObject({ branch: 'main', action: 'revert', outcome: 'done' });
		expect(git('log', '-1', '--format=%s')).toBe('Revert "change a"');
	});

	it('takes back a commit a later run brought back after an earlier move reset it', async () => {
		const { tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
			restore: shell('git merge --quiet --ff-only saved'),
		});
		await run(tool, 'commit');
		const sha = head();
		const start = git('rev-parse', `${sha}^`);
		git('branch', 'saved');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });
		await history.undo({ commits: 'reset' });
		const { runId } = await run(tool, 'restore');
		expect(head()).toBe(sha);

		const undone = await history.undo({ commits: 'reset' });

		expect(head()).toBe(start);
		expect(undone.git).toEqual([
			{
				repository: root,
				branch: 'main',
				action: 'reset',
				outcome: 'done',
				commits: [{ sha, subject: 'change a', runId, direction: 'undo' }],
			},
		]);
	});

	it.each(['revert', 'reset'] as const)(
		'%ss once a commit two runs on the route both made, and names it for each',
		async policy => {
			const { tool } = await commandTool({
				commit: shell('echo two > a.txt && git commit --quiet -am "change a"'),
				restore: shell('git merge --quiet --ff-only saved'),
			});
			const first = await run(tool, 'commit');
			const sha = head();
			const start = git('rev-parse', `${sha}^`);
			git('branch', 'saved');
			// The user goes back, and the next run brings the same commit forward again.
			git('reset', '--quiet', '--hard', start);
			const second = await run(tool, 'restore');
			expect(head()).toBe(sha);
			const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

			const undone = await history.goTo(historyStart, { commits: policy });

			expect(undone.git).toEqual([
				{
					repository: root,
					branch: 'main',
					action: policy,
					outcome: 'done',
					commits: [
						{ sha, subject: 'change a', runId: second.runId, direction: 'undo' },
						{ sha, subject: 'change a', runId: first.runId, direction: 'undo' },
					],
				},
			]);
			if (policy === 'reset') expect(head()).toBe(start);
			else expect(git('log', '--format=%s', `${sha}..HEAD`)).toBe('Revert "change a"');
			expect(git('status', '--porcelain')).toBe('');

			const redone = await history.goTo(second.runId);

			const back = head();
			expect(git('log', '--format=%s', `${start}..HEAD`).split('\n')[0]).toBe('change a');
			expect(redone.git?.[0]?.commits.map(commit => commit.sha)).toEqual([back, back]);
			expect(git('status', '--porcelain')).toBe('');
		},
	);

	it('writes the message of a commit it makes as UTF-8, whatever encoding the repository names', async () => {
		const { tool } = await commandTool({
			commit: shell('echo two > a.txt && git commit --quiet -am "cambió a"'),
		});
		await run(tool, 'commit');
		git('config', 'i18n.commitEncoding', 'ISO-8859-1');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		await history.undo({ commits: 'revert' });

		expect(git('cat-file', 'commit', 'HEAD')).not.toContain('encoding ');
		expect(git('log', '-1', '--encoding=UTF-8', '--format=%s')).toBe('Revert "cambió a"');
	});

	it('leaves the branch when the change it reverts was changed since, even if a copy matches', async () => {
		writeFileSync(join(root, 'a.txt'), 'a\nb\nc\nd\ne\nf\ng\n');
		git('commit', '--quiet', '-am', 'lines');
		const { tool } = await commandTool({
			commit: shell(
				'sed -i.bak \'s/^d$/D/\' a.txt && rm a.txt.bak && git commit --quiet -am "change d"',
			),
		});
		await run(tool, 'commit');
		// The user changes the line again, and adds elsewhere a copy of the block the commit left.
		writeFileSync(join(root, 'a.txt'), 'a\nb\nc\nDD\ne\nf\ng\nx\na\nb\nc\nD\ne\nf\ng\n');
		git('commit', '--quiet', '-am', 'the user');
		const tip = head();
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'revert' });

		expect(head()).toBe(tip);
		expect(undone.git?.[0]).toMatchObject({
			action: 'revert',
			outcome: 'left',
			reason: 'git could not revert them: the change conflicts with what the branch holds now',
		});
	});

	it('keeps what the user staged in a path the commits changed, and warns', async () => {
		const { opened, sha } = await committedRun();
		const start = git('rev-parse', `${sha}^`);
		writeFileSync(join(root, 'a.txt'), 'three\n');
		git('add', 'a.txt');
		writeFileSync(join(root, 'a.txt'), 'two\n');

		const undone = await opened.store.undo({ commits: 'reset' });

		expect(undone).toMatchObject({ git: [{ action: 'reset', outcome: 'done' }] });
		expect(head()).toBe(start);
		expect(readA()).toBe('one\n');
		expect(git('show', ':a.txt')).toBe('three');
		expect(warnings).toEqual([
			`The history moved main in ${root} and kept what was staged in a.txt, which git now shows against the new tip`,
		]);
	});

	it('keeps what the user staged under a folder the commits made of a file', async () => {
		writeFileSync(join(root, 'f'), 'file\n');
		git('add', 'f');
		git('commit', '--quiet', '-m', 'add f');
		const { opened, tool } = await commandTool({
			fold: shell(
				'git rm --quiet f && mkdir f && echo b > f/b && git add f/b && git commit --quiet -m "fold f"',
			),
		});
		await run(tool, 'fold');
		writeFileSync(join(root, 'f', 'c'), 'c\n');
		git('add', 'f/c');

		const undone = await opened.store.undo({ commits: 'reset' });

		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'done' });
		expect(
			git('ls-files', '--stage')
				.split('\n')
				.map(line => line.split('\t')[1]),
		).toEqual(['a.txt', 'f/c']);
		expect(git('show', ':f/c')).toBe('c');
		expect(warnings).toContainEqual(
			`The history moved main in ${root} and kept what was staged in f, which git now shows against the new tip`,
		);
	});

	it('keeps what the user staged across both halves of a move to another branch', async () => {
		const { tool } = await commandTool({
			two: shell('echo two > a.txt && git commit --quiet -am "two"'),
			three: shell('echo three > a.txt && git commit --quiet -am "three"'),
		});
		const { runId: first } = await run(tool, 'two');
		const store = await FileRecoveryStore.open({
			root,
			directory: join(parent, 'state'),
			logger: { warn: (message: unknown) => warnings.push(String(message)) },
		});
		await store.undo({ commits: 'reset' });
		await run(tool, 'three');
		// What the user stages is the start's, where the move passes between the two runs.
		writeFileSync(join(root, 'a.txt'), 'one\n');
		git('add', 'a.txt');
		writeFileSync(join(root, 'a.txt'), 'three\n');

		const moved = await store.goTo(first, { commits: 'reset' });

		expect(moved.git?.map(({ action, outcome }) => `${action} ${outcome}`)).toEqual([
			'reset done',
			'reapply done',
		]);
		expect(git('show', ':a.txt')).toBe('one');
		expect(warnings).toContainEqual(
			`The history moved main in ${root} and kept what was staged in a.txt, which git now shows against the new tip`,
		);
	});

	it('warns of nothing staged that already matches the new tip', async () => {
		const { opened } = await committedRun();
		writeFileSync(join(root, 'a.txt'), 'one\n');
		git('add', 'a.txt');
		writeFileSync(join(root, 'a.txt'), 'two\n');

		await opened.store.undo({ commits: 'reset' });

		expect(git('status', '--porcelain')).toBe('');
		expect(warnings).toEqual([]);
	});

	it("re-applies the stored contents, whatever the user's diff configuration converts", async () => {
		writeFileSync(join(root, '.git', 'info', 'attributes'), '*.txt diff=upper\n');
		git('config', 'diff.upper.textconv', 'tr a-z A-Z');
		git('config', 'diff.noprefix', 'true');
		const { tool } = await commandTool({
			add: shell('echo two > b.txt && git add b.txt && git commit --quiet -m "add b"'),
		});
		await run(tool, 'add');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'revert' });
		const redone = await history.redo();

		expect(undone.git?.[0]).toMatchObject({ action: 'revert', outcome: 'done' });
		expect(redone.git?.[0]).toMatchObject({ action: 'reapply', outcome: 'done' });
		expect(git('show', 'HEAD:b.txt')).toBe('two');
	});

	it('brings both sides of a rename back in the index', async () => {
		const { tool } = await commandTool({
			rename: shell('git mv a.txt b.txt && git commit --quiet -m "rename a"'),
		});
		await run(tool, 'rename');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'reset' });

		expect(undone).toMatchObject({ complete: true, git: [{ action: 'reset', outcome: 'done' }] });
		expect(readA()).toBe('one\n');
		expect(git('status', '--porcelain')).toBe('');
	});

	it('updates the index of the paths the commits changed only, read literally', async () => {
		writeFileSync(join(root, 'file1.txt'), 'one\n');
		git('add', 'file1.txt');
		git('commit', '--quiet', '-m', 'add file1');
		const { tool } = await commandTool({
			add: shell('echo two > \'file[1].txt\' && git add . && git commit --quiet -m "add file[1]"'),
		});
		await run(tool, 'add');
		writeFileSync(join(root, 'file1.txt'), 'staged\n');
		git('add', 'file1.txt');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'reset' });

		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'done' });
		expect(git('diff', '--cached', '--name-only')).toBe('file1.txt');
	});

	it('reverts and re-applies an empty commit with the others', async () => {
		const { tool } = await commandTool({
			commit: shell(
				'git commit --quiet --allow-empty -m empty && echo two > a.txt && git commit --quiet -am "change a"',
			),
		});
		await run(tool, 'commit');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		const undone = await history.undo({ commits: 'revert' });
		const redone = await history.redo();

		expect(undone.git?.[0]).toMatchObject({ action: 'revert', outcome: 'done' });
		expect(redone.git?.[0]).toMatchObject({ action: 'reapply', outcome: 'done' });
		expect(git('log', '--format=%s', '-4').split('\n')).toEqual([
			'change a',
			'empty',
			'Revert "empty"',
			'Revert "change a"',
		]);
		expect(readA()).toBe('two\n');
	});

	it('brings a split index to the new tip, whole', async () => {
		git('config', 'core.splitIndex', 'true');
		git('update-index', '--split-index');
		const { history, sha } = await committedRun();

		const undone = await history.undo({ commits: 'reset' });

		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'done' });
		expect(head()).toBe(git('rev-parse', `${sha}^`));
		expect(git('status', '--porcelain')).toBe('');
		expect(git('ls-files', '--stage')).toMatch(/\ta\.txt$/);
	});

	it('leaves the branch while another git process holds the index, and leaves its lock', async () => {
		const { history, sha } = await committedRun();
		const lock = join(root, '.git', 'index.lock');
		writeFileSync(lock, 'theirs');

		const undone = await history.undo({ commits: 'reset' });

		expect(head()).toBe(sha);
		expect(readFileSync(lock, 'utf8')).toBe('theirs');
		expect(undone.git?.[0]).toMatchObject({
			action: 'reset',
			outcome: 'left',
			reason: `another git process is changing the index of ${root} (${lock} exists)`,
		});
	});

	it('releases the index, ends the move, and finishes it as done, when the logger fails once the branch moved', async () => {
		const { runId, sha } = await committedRun();
		const start = git('rev-parse', `${sha}^`);
		let broken = true;
		const store = await FileRecoveryStore.open({
			root,
			directory: join(parent, 'state'),
			logger: {
				warn: () => {
					if (!broken) return;
					broken = false;
					throw new Error('logger broke');
				},
			},
		});
		// What the user staged makes the move warn, once the branch has moved.
		writeFileSync(join(root, 'a.txt'), 'three\n');
		git('add', 'a.txt');
		writeFileSync(join(root, 'a.txt'), 'two\n');

		await expect(store.undo({ commits: 'reset' })).rejects.toBeInstanceOf(UnrecoverableError);

		// The branch moved before the logger failed: the next move reports the reset as done, so
		// redoing puts the commit back.
		expect(head()).toBe(start);
		expect(existsSync(join(root, '.git', 'index.lock'))).toBe(false);
		expect(git('show', ':a.txt')).toBe('three');
		await store.redo();
		const revisions = await store.listRevisions();
		const finished = revisions.find(revision => revision.git?.[0]?.action === 'reset');
		expect(finished?.git).toEqual([
			{
				repository: root,
				branch: 'main',
				action: 'reset',
				outcome: 'done',
				commits: [{ sha, subject: 'change a', runId, direction: 'undo' }],
			},
		]);
		expect(head()).toBe(sha);
	});

	/** Makes the move in progress the undo of `runId`, cut as git was about to reset its commit. */
	function cutReset(runId: string, sha: string, start: string): void {
		const [state] = readdirSync(join(parent, 'state'), { recursive: true, encoding: 'utf8' })
			.filter(path => path.endsWith('head.json'))
			.map(path => join(parent, 'state', path));
		const report = {
			repository: root,
			branch: 'main',
			action: 'reset',
			outcome: 'done',
			commits: [{ sha, subject: 'change a', runId, direction: 'undo' }],
		};
		writeFileSync(
			state ?? '',
			JSON.stringify({
				runId,
				revision: 0,
				pending: {
					revision: 1,
					from: runId,
					conflicts: [],
					commits: 'reset',
					gitUndo: { branches: 0, reports: [], intent: { from: sha, to: start, report } },
				},
			}),
		);
	}

	it('finishes a move cut once git moved the branch as done, and redoing puts the commits back', async () => {
		const { opened, runId, sha } = await committedRun();
		const start = git('rev-parse', `${sha}^`);
		cutReset(runId, sha, start);
		// Git moved the branch, and the process stopped before it updated the index.
		git('update-ref', 'refs/heads/main', start, sha);

		await opened.store.redo();

		const revisions = await opened.store.listRevisions();
		const finished = revisions.find(revision => revision.git?.[0]?.action === 'reset');
		expect(finished?.git?.[0]).toMatchObject({ action: 'reset', outcome: 'done' });
		expect(warnings.some(warning => warning.includes('before its process stopped'))).toBe(true);
		expect(head()).toBe(sha);
		expect(readA()).toBe('two\n');
	});

	it('leaves a branch the move was cut before git moved, and runs no git on it', async () => {
		const { opened, runId, sha } = await committedRun();
		const start = git('rev-parse', `${sha}^`);
		cutReset(runId, sha, start);

		await opened.store.redo();

		const revisions = await opened.store.listRevisions();
		const finished = revisions.find(revision => revision.git?.[0]?.action === 'reset');
		expect(finished?.git?.[0]).toMatchObject({
			action: 'reset',
			outcome: 'left',
			reason:
				'the move stopped as git was about to move this branch, which is not where git would have taken it, so the harness left it as it is',
		});
		expect(head()).toBe(sha);
	});

	it('reports a branch a cut move finished as it did, without running git on it again', async () => {
		const { opened, runId, sha } = await committedRun();
		const [state] = readdirSync(join(parent, 'state'), { recursive: true, encoding: 'utf8' })
			.filter(path => path.endsWith('head.json'))
			.map(path => join(parent, 'state', path));
		const report = {
			repository: root,
			branch: 'main',
			action: 'revert',
			outcome: 'left',
			reason: 'an earlier attempt',
			commits: [{ sha, subject: 'change a', runId, direction: 'undo' }],
		};
		writeFileSync(
			state ?? '',
			JSON.stringify({
				runId,
				revision: 0,
				pending: {
					revision: 1,
					from: runId,
					conflicts: [],
					commits: 'revert',
					gitUndo: { branches: 1, reports: [report] },
				},
			}),
		);

		await opened.store.redo();

		const revisions = await opened.store.listRevisions();
		expect(revisions.find(revision => revision.revision === 1)?.git).toEqual([report]);
		expect(head()).toBe(sha);
	});

	it('re-applies a change as stored, whatever whitespace git is configured to fix', async () => {
		git('config', 'apply.whitespace', 'fix');
		const { tool } = await commandTool({
			add: shell('printf \'two  \\n\' > b.txt && git add b.txt && git commit --quiet -m "add b"'),
		});
		await run(tool, 'add');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });

		await history.undo({ commits: 'revert' });
		const redone = await history.redo();

		expect(redone.git?.[0]).toMatchObject({ action: 'reapply', outcome: 'done' });
		expect(git('cat-file', '-s', 'HEAD:b.txt')).toBe('6');
	});

	it("runs none of the repository's hooks as it moves the branch and the index", async () => {
		const { history } = await committedRun();
		git('config', '--unset', 'core.hooksPath');
		for (const hook of ['reference-transaction', 'post-index-change']) {
			writeFileSync(join(root, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> hooked\n`, {
				mode: 0o755,
			});
		}

		const undone = await history.undo({ commits: 'reset' });

		expect(undone.git?.[0]).toMatchObject({ action: 'reset', outcome: 'done' });
		expect(existsSync(join(root, 'hooked'))).toBe(false);
	});

	it('waits for the removal of a worktree it made commits in, reopened by its first root', async () => {
		const second = join(parent, 'second');
		execFileSync('git', ['init', '--quiet', '--initial-branch=main', second]);
		execFileSync('git', [...gitConfig, 'commit', '--quiet', '--allow-empty', '-m', 'start'], {
			cwd: second,
		});
		const stateDirectory = join(parent, 'state');
		const opened = await openWorkspace(
			{
				roots: [
					{ path: root, access: 'write' },
					{ path: second, access: 'write' },
				],
				stateDirectory,
			},
			{ warn: (message: unknown) => warnings.push(String(message)) },
		);
		const tool = (await commandToolFor(opened, {
			commit: { ...shell('git commit --quiet --allow-empty -m "in second"'), cwd: second },
		})) as PreparingTool;
		await run(tool, 'commit');
		const history = await createHistory({ root, stateDirectory });
		const release = await new FolderClaims(realpathSync(stateDirectory)).claimRemoval(second);

		await expect(history.undo({ commits: 'reset' })).rejects.toThrow(WorkspaceBusyError);
		await release();
		await expect(history.undo({ commits: 'reset' })).resolves.toMatchObject({
			git: [{ repository: second, action: 'reset', outcome: 'done' }],
		});
	});

	it('refuses an unknown policy before it moves anything', async () => {
		const { history } = await committedRun();

		await expect(history.undo({ commits: 'drop' as never })).rejects.toBeInstanceOf(RangeError);
		expect(readA()).toBe('two\n');
	});
});

describe('the git that reverts and re-applies commits', () => {
	it('is 2.40 or later, whose merge-tree takes a merge base', () => {
		expect(gitCommits.mergesInMemory('git version 2.40.0')).toBe(true);
		expect(gitCommits.mergesInMemory('git version 3.0.1\n')).toBe(true);
		expect(gitCommits.mergesInMemory('git version 2.39.3 (Apple Git-146)')).toBe(false);
		expect(gitCommits.mergesInMemory('not git')).toBe(false);
	});
});

describe('what the model is told of the commits', () => {
	const at = '2026-10-30T00:00:00.000Z';
	const commit = { subject: 'change a', runId: 'r1' };

	it('names each branch, what git did and why it could not', () => {
		const note = commitsNote([
			{
				revision: 1,
				at,
				complete: true,
				conflicts: [],
				git: [
					{
						repository: '/repo',
						branch: 'main',
						action: 'reapply',
						outcome: 'done',
						commits: [
							{ ...commit, sha: 'b'.repeat(40), original: 'a'.repeat(40), direction: 'redo' },
						],
					},
					{
						repository: '/repo',
						branch: 'side',
						action: 'reset',
						outcome: 'left',
						reason: "the branch's upstream holds them",
						commits: [{ ...commit, sha: 'c'.repeat(40), direction: 'redo' }],
					},
				],
			},
		]);

		expect(note).toContain(
			'- main in /repo: aaaaaaa change a, now bbbbbbb put back on the branch.',
		);
		expect(note).toContain(
			"- side in /repo: git could not remove ccccccc change a, so the branch was left as it was: the branch's upstream holds them",
		);
	});

	it('is nothing for moves over no commit', () => {
		expect(commitsNote([{ revision: 1, at, complete: true, conflicts: [] }])).toBeUndefined();
	});
});
