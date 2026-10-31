import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions } from '../../src/agent/domain/agent.ts';
import { RunContext, withRunContext } from '../../src/agent/domain/runContext.ts';
import { createHistory } from '../../src/index.ts';
import { GitCommitter } from '../../src/orchestration/infrastructure/model/gitCommitter.ts';
import type { Commands } from '../../src/tools/domain/commands.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { commandToolFor, openWorkspace } from '../../src/tools/infrastructure/fileTools.ts';

const signal = new AbortController().signal;
// Whatever the machine's own configuration says: no signing, a known author, no hook but the
// tests' own.
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

let parent: string;
let root: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-committer-')));
	root = join(parent, 'repo');
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
	for (const [key, value] of [
		['user.name', 'Test'],
		['user.email', 'test@example.com'],
		['commit.gpgsign', 'false'],
		['core.hooksPath', join(root, '.git', 'hooks')],
	] as const) {
		git('config', key, value);
	}
	writeFileSync(join(root, 'a.txt'), 'one\n');
	writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
	git('add', '.');
	git('commit', '--quiet', '-m', 'feat: start');
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

function git(...args: string[]): string {
	return execFileSync('git', [...identity, ...args], { cwd: root, encoding: 'utf8' }).trim();
}

function head(): string {
	return git('rev-parse', 'HEAD');
}

/** A workspace whose commands run `script` in `sh`, and a run that is still working. */
async function workingRun(commands: Record<string, string>) {
	const opened = await openWorkspace(
		{ roots: [{ path: root, access: 'write' }], stateDirectory: join(parent, 'state') },
		{ warn: () => undefined },
	);
	const definitions: Commands = Object.fromEntries(
		Object.entries(commands).map(([name, script]) => [
			name,
			{ description: 'A test command', executable: 'sh', args: ['-c', script] },
		]),
	);
	const tool = (await commandToolFor(opened, definitions)) as PreparingTool;
	const context = new RunContext({ id: 'test-session' });
	const options: RunOptions = withRunContext({ signal }, context);
	const run = async (name: string) => {
		const call = await tool.prepare({ command: { name } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
			depth: 0,
		});
		await call.run(signal);
	};
	const committer = new GitCommitter({
		store: opened.store,
		writes: opened.writes,
		covered: opened.covered,
		policy: opened.policy,
	});
	return { opened, context, options, run, committer };
}

function hook(name: string, script: string): void {
	const path = join(root, '.git', 'hooks', name);
	mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${script}\n`);
	chmodSync(path, 0o755);
}

describe('the git committer', { timeout: 20_000 }, () => {
	it("commits the run's changes and new files, leaves what else is staged staged, and the run's history names the commit", async () => {
		const { run, committer, options, context } = await workingRun({
			edit: 'echo two > a.txt && echo new > b.txt && echo skip > ignored.txt',
		});
		// The user's own staged work, which the commit must not take.
		writeFileSync(join(root, 'mine.txt'), 'mine\n');
		git('add', 'mine.txt');
		await run('edit');

		const frozen = await committer.freeze(options);
		expect(frozen?.repositories).toEqual([
			expect.objectContaining({
				repository: root,
				branch: 'main',
				paths: ['a.txt', 'b.txt'],
				leftOut: [],
				style: ['feat: start'],
			}),
		]);
		expect(frozen?.repositories[0]?.diff).toContain('+two');

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'feat: change a\n\nAnd add b.']]),
			options,
		);

		expect(reports).toEqual([
			{
				repository: root,
				branch: 'main',
				outcome: 'done',
				commits: [{ sha: head(), subject: 'feat: change a' }],
				paths: ['a.txt', 'b.txt'],
				leftOut: [],
				unreviewed: [],
			},
		]);
		expect(git('log', '-1', '--format=%B')).toBe('feat: change a\n\nAnd add b.');
		expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('a.txt\nb.txt');
		expect(git('diff', '--cached', '--name-only')).toBe('mine.txt');
		expect(git('status', '--porcelain', '--', 'a.txt', 'b.txt')).toBe('');

		// Undoing the run takes the commit back, as for any command's.
		await context.finish('completed');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });
		const undone = await history.undo({ commits: 'revert' });
		expect(undone.git?.[0]).toMatchObject({ action: 'revert', outcome: 'done' });
	});

	it('leaves out a file that held changes of yours before the run, and one changed after the run did', async () => {
		writeFileSync(join(root, 'a.txt'), 'yours\n');
		writeFileSync(join(root, 'c.txt'), 'three\n');
		git('add', 'c.txt');
		git('commit', '--quiet', '-m', 'feat: c');
		const { run, committer, options } = await workingRun({
			edit: 'echo two >> a.txt && echo four > c.txt && echo new > b.txt',
		});
		await run('edit');
		writeFileSync(join(root, 'b.txt'), 'changed by hand\n');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({
			paths: ['c.txt'],
			leftOut: [
				{ path: 'a.txt', reason: 'it held changes of yours before this task' },
				{ path: 'b.txt', reason: 'it changed after the task last changed it' },
			],
		});
	});

	it('leaves the repository when a file changes after the review', async () => {
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);
		const start = head();
		writeFileSync(join(root, 'a.txt'), 'edited during the review\n');

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(reports[0]).toMatchObject({
			outcome: 'left',
			reason: 'files changed since the review: a.txt',
		});
		expect(head()).toBe(start);
	});

	it('reports a commit a hook rejects, with what it printed, and unstages the new files it added', async () => {
		hook('pre-commit', 'echo "lint failed" >&2\nexit 1');
		const { run, committer, options } = await workingRun({
			edit: 'echo two > a.txt && echo new > b.txt',
		});
		await run('edit');
		const frozen = await committer.freeze(options);
		const start = head();

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(reports[0]).toMatchObject({ outcome: 'rejected', reason: 'lint failed', commits: [] });
		expect(head()).toBe(start);
		expect(git('status', '--porcelain')).toBe('M a.txt\n?? b.txt');
	});

	it('names what a hook changed in the commit as unreviewed', async () => {
		hook('pre-commit', 'echo extra > extra.txt && git add extra.txt');
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(reports[0]).toMatchObject({ outcome: 'done', unreviewed: ['extra.txt'] });
	});

	it('leaves the repository when a file becomes a link to the same content after the review', async () => {
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);
		writeFileSync(join(root, 'copy.txt'), 'two\n');
		rmSync(join(root, 'a.txt'));
		symlinkSync('copy.txt', join(root, 'a.txt'));

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(reports[0]).toMatchObject({
			outcome: 'left',
			reason: 'files changed since the review: a.txt',
		});
	});

	it('refuses a repository with no branch checked out', async () => {
		git('switch', '--quiet', '--detach');
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({
			paths: [],
			refused: 'no branch is checked out there',
		});
	});

	it('finds nothing to commit when a command of the run committed it already', async () => {
		const { run, committer, options } = await workingRun({
			edit: `echo two > a.txt && git ${identity.join(' ')} commit --quiet -am "feat: by the executor"`,
		});
		await run('edit');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({ paths: [], leftOut: [] });
	});

	it('freezes nothing for a run that changed no file', async () => {
		const { committer, options } = await workingRun({ idle: 'true' });

		await expect(committer.freeze(options)).resolves.toBeUndefined();
	});
});
