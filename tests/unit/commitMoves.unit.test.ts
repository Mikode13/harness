import { execFileSync } from 'node:child_process';
import {
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
import { createHistory } from '../../src/index.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import * as gitCommits from '../../src/recovery/infrastructure/gitCommits.ts';
import type { Commands } from '../../src/tools/domain/commands.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
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

beforeEach(() => {
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
		{ warn: () => undefined },
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

	it('names the commits of the steps a move took before its process stopped, once it is finished', async () => {
		const { opened, tool } = await commandTool({
			commit: shell('git commit --quiet --allow-empty -m "step"'),
		});
		const first = await run(tool, 'commit');
		const firstSha = head();
		const second = await run(tool, 'commit');
		const secondSha = head();
		// The process died going to the start, after undoing the second run.
		const [state] = readdirSync(join(parent, 'state'), { recursive: true, encoding: 'utf8' })
			.filter(path => path.endsWith('head.json'))
			.map(path => join(parent, 'state', path));
		const commit = { repository: root, branch: 'main', subject: 'step', direction: 'undo' };
		writeFileSync(
			state ?? '',
			JSON.stringify({
				runId: first.runId,
				revision: 0,
				pending: {
					revision: 1,
					from: second.runId,
					conflicts: [],
					commits: [{ ...commit, sha: secondSha, runId: second.runId }],
				},
			}),
		);

		await opened.store.redo();

		const [finished] = await opened.store.listRevisions();
		expect(finished?.git?.[0]?.commits).toEqual([
			{ sha: secondSha, subject: 'step', runId: second.runId, direction: 'undo' },
			{ sha: firstSha, subject: 'step', runId: first.runId, direction: 'undo' },
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
		await commitIn('a');
		const second = await commitIn('b');
		await commitIn('c');
		await commitIn('d');

		const { record, commits } = await store.readRun(second);

		expect(record.absorbed).toHaveLength(1);
		expect(commits.map(made => made.commits[0]?.subject)).toEqual(['a', 'b']);
	});
});
