import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
	const warnings: string[] = [];
	const committer = new GitCommitter({
		store: opened.store,
		writes: opened.writes,
		covered: opened.covered,
		policy: opened.policy,
		logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) },
	});
	return { opened, context, options, run, committer, warnings };
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

	it('records the commit it made when it cannot remove the folder that held its message, and warns', async () => {
		const temporary = join(parent, 'tmp');
		mkdirSync(temporary);
		// Locks the message's folder once git committed, so removing what it holds fails.
		hook('post-commit', `chmod 500 "${temporary}"/harness-commit-*`);
		const { run, committer, options, context, warnings } = await workingRun({
			edit: 'echo two > a.txt',
		});
		await run('edit');
		const frozen = await committer.freeze(options);

		vi.stubEnv('TMPDIR', temporary);
		try {
			const reports = await committer.commit(
				frozen ?? { repositories: [] },
				new Map([[root, 'Change a']]),
				options,
			);
			expect(reports[0]).toMatchObject({ outcome: 'done', commits: [{ sha: head() }] });
		} finally {
			vi.unstubAllEnvs();
			execFileSync('chmod', ['-R', 'u+w', temporary]);
		}
		expect(warnings).toEqual([expect.stringContaining('which held its message')]);

		await context.finish('completed');
		const history = await createHistory({ root, stateDirectory: join(parent, 'state') });
		const undone = await history.undo({ commits: 'revert' });
		expect(undone.git?.[0]).toMatchObject({ action: 'revert', outcome: 'done' });
	});

	it("freezes its own history's run when a tool of the run wrote to another history last", async () => {
		mkdirSync(join(root, 'sub'));
		const { run, committer, options, context } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const other = await openWorkspace(
			{
				roots: [{ path: join(root, 'sub'), access: 'write' }],
				stateDirectory: join(parent, 'other'),
			},
			{ warn: () => undefined },
		);
		const tool = (await commandToolFor(other, {
			note: {
				description: 'A test command',
				executable: 'sh',
				args: ['-c', 'echo note > note.txt'],
			},
		})) as PreparingTool;
		const call = await tool.prepare({ command: { name: 'note' } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
			depth: 0,
		});
		await call.run(signal);

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({ paths: ['a.txt'], leftOut: [] });
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

	it('leaves out a file whose staged version is yours, and commits what the run staged itself', async () => {
		writeFileSync(join(root, 'a.txt'), 'staged by you\n');
		git('add', 'a.txt');
		writeFileSync(join(root, 'a.txt'), 'one\n');
		const { run, committer, options } = await workingRun({
			edit: 'echo two > a.txt && echo new > b.txt && git add b.txt',
		});
		await run('edit');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({
			paths: ['b.txt'],
			leftOut: [{ path: 'a.txt', reason: 'its staged version holds changes of yours' }],
		});
		await committer.commit(frozen ?? { repositories: [] }, new Map([[root, 'Add b']]), options);
		expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('b.txt');
		expect(git('show', ':a.txt')).toBe('staged by you');
	});

	it('leaves out a file whose mode changed after the run', async () => {
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		chmodSync(join(root, 'a.txt'), 0o755);

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({
			paths: [],
			leftOut: [{ path: 'a.txt', reason: 'it changed after the task last changed it' }],
		});
	});

	it('leaves out a file a folder replaced after the run, and one under a folder a file replaced', async () => {
		const { run, committer, options } = await workingRun({
			edit: 'echo two > a.txt && mkdir d && echo e > d/e.txt',
		});
		await run('edit');
		rmSync(join(root, 'a.txt'));
		mkdirSync(join(root, 'a.txt'));
		rmSync(join(root, 'd'), { recursive: true });
		writeFileSync(join(root, 'd'), 'a file now\n');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({
			paths: [],
			leftOut: [
				{ path: 'a.txt', reason: 'it changed after the task last changed it' },
				{ path: 'd/e.txt', reason: 'it changed after the task last changed it' },
			],
		});
	});

	it('leaves the repository when the run changes another file after the review, as a command of the reviewer can', async () => {
		const { run, committer, options } = await workingRun({
			edit: 'echo two > a.txt',
			review: 'echo generated > c.txt',
		});
		await run('edit');
		const frozen = await committer.freeze(options);
		const start = head();
		await run('review');

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(reports[0]).toMatchObject({
			outcome: 'left',
			reason: 'the task changed files after the review: c.txt',
		});
		expect(head()).toBe(start);
	});

	it("runs the commit's hooks with git's own patterns, so a hook's pathspec matches", async () => {
		hook('pre-commit', `git diff --cached --name-only -- '*.txt' > "${join(parent, 'hook-saw')}"`);
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);

		await committer.commit(frozen ?? { repositories: [] }, new Map([[root, 'Change a']]), options);

		expect(readFileSync(join(parent, 'hook-saw'), 'utf8')).toBe('a.txt\n');
		expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('a.txt');
	});

	it('commits as the author the environment names, as a CI with no user.name does', async () => {
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);

		vi.stubEnv('GIT_AUTHOR_NAME', 'CI Bot');
		vi.stubEnv('GIT_AUTHOR_EMAIL', 'ci@example.com');
		try {
			await committer.commit(
				frozen ?? { repositories: [] },
				new Map([[root, 'Change a']]),
				options,
			);
		} finally {
			vi.unstubAllEnvs();
		}

		expect(git('log', '-1', '--format=%an <%ae>')).toBe('CI Bot <ci@example.com>');
	});

	it('leaves the repository, with the reason, when the run may write no more', async () => {
		const { opened, run, committer, options, context } = await workingRun({
			edit: 'echo two > a.txt',
		});
		await run('edit');
		const frozen = await committer.freeze(options);
		const start = head();
		opened.writes.sessionFor(context).stop('Writing stopped: a test stopped it');

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(reports[0]).toMatchObject({
			outcome: 'left',
			reason: 'Writing stopped: a test stopped it',
		});
		expect(head()).toBe(start);
	});

	it('leaves the repository when a folder above a file to commit became a link after the review', async () => {
		const { run, committer, options } = await workingRun({ edit: 'mkdir d && echo d > d/f.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);
		const start = head();
		mkdirSync(join(root, 'e'));
		writeFileSync(join(root, 'e', 'f.txt'), 'd\n');
		rmSync(join(root, 'd'), { recursive: true });
		symlinkSync('e', join(root, 'd'));

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Add d']]),
			options,
		);

		expect(reports[0]).toMatchObject({
			outcome: 'left',
			reason: 'files changed since the review: d/f.txt',
		});
		expect(head()).toBe(start);
	});

	it('leaves out a file under a folder a link replaced after the run', async () => {
		const { run, committer, options } = await workingRun({
			edit: 'mkdir d e && echo d > d/f.txt && echo e > e/f.txt',
		});
		await run('edit');
		rmSync(join(root, 'd'), { recursive: true });
		symlinkSync('e', join(root, 'd'));

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({
			paths: ['e/f.txt'],
			leftOut: [{ path: 'd/f.txt', reason: 'a folder above it is a link now' }],
		});
	});

	it('commits a file the run normalized with the attributes it added', async () => {
		git('config', 'core.autocrlf', 'false');
		writeFileSync(join(root, 'c.txt'), 'x\r\ny\r\n');
		git('add', 'c.txt');
		git('commit', '--quiet', '-m', 'feat: c');
		const { run, committer, options } = await workingRun({
			edit: "printf '* text=auto\\n' > .gitattributes && printf 'x\\ny\\n' > c.txt",
		});
		await run('edit');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({ leftOut: [] });
		expect([...(frozen?.repositories[0]?.paths ?? [])].sort()).toEqual(['.gitattributes', 'c.txt']);
	});

	it('names a file a hook left out of the commit, not as committed', async () => {
		hook('pre-commit', 'git reset -q HEAD -- a.txt');
		const { run, committer, options } = await workingRun({
			edit: 'echo two > a.txt && echo new > b.txt',
		});
		await run('edit');
		const frozen = await committer.freeze(options);

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Change a']]),
			options,
		);

		expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('b.txt');
		expect(reports[0]).toMatchObject({
			outcome: 'done',
			paths: ['b.txt'],
			leftOut: [{ path: 'a.txt', reason: 'a hook left it out of the commit' }],
		});
	});

	it('ends with the cancellation when the run is cancelled before git commits, and unstages the new files', async () => {
		const { opened, run, options, context } = await workingRun({
			edit: 'echo two > a.txt && echo new > b.txt',
		});
		await run('edit');
		const controller = new AbortController();
		const cancelling = new GitCommitter({
			store: opened.store,
			writes: opened.writes,
			covered: opened.covered,
			policy: opened.policy,
			logger: { warn: () => undefined },
			runCommit: () => {
				controller.abort();
				return Promise.reject(new DOMException('The run was cancelled', 'AbortError'));
			},
		});
		const frozen = await cancelling.freeze(options);
		const start = head();

		await expect(
			cancelling.commit(
				frozen ?? { repositories: [] },
				new Map([[root, 'Change a']]),
				withRunContext({ signal: controller.signal }, context),
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(head()).toBe(start);
		expect(git('status', '--porcelain')).toBe('M a.txt\n?? b.txt');
	});

	it('leaves the repository when a file changes while the commit captures the files', async () => {
		const { opened, run, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		let edited = false;
		const committer = new GitCommitter({
			store: opened.store,
			writes: opened.writes,
			covered: signal => {
				if (!edited) writeFileSync(join(root, 'a.txt'), 'edited meanwhile\n');
				edited = true;
				return opened.covered(signal);
			},
			policy: opened.policy,
			logger: { warn: () => undefined },
		});
		const frozen = await committer.freeze(options);
		const start = head();

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

	it('leaves a new file you staged staged when a hook rejects the commit', async () => {
		hook('pre-commit', 'exit 1');
		const { run, committer, options } = await workingRun({ edit: 'echo new > b.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);
		git('add', 'b.txt');

		const reports = await committer.commit(
			frozen ?? { repositories: [] },
			new Map([[root, 'Add b']]),
			options,
		);

		expect(reports[0]?.outcome).toBe('rejected');
		expect(git('status', '--porcelain')).toBe('A  b.txt');
	});

	it('stops a filter that hangs, with git, when the run is cancelled', async () => {
		git(
			'config',
			'filter.slow.clean',
			'if [ -f stall ]; then echo $$ > filter.pid; exec sleep 30; fi; cat',
		);
		writeFileSync(join(root, '.gitattributes'), 'a.txt filter=slow\n');
		const { run, committer, context } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		writeFileSync(join(root, 'stall'), '');
		const controller = new AbortController();
		setTimeout(() => {
			controller.abort();
		}, 500);

		await expect(
			committer.freeze(withRunContext({ signal: controller.signal }, context)),
		).rejects.toMatchObject({ name: 'AbortError' });

		const pid = Number(readFileSync(join(root, 'filter.pid'), 'utf8'));
		expect(() => process.kill(pid, 0)).toThrow();
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

	it('unstages what it added with no hook, after a hook rejects the commit', async () => {
		hook('pre-commit', 'exit 1');
		const { run, committer, options } = await workingRun({ edit: 'echo new > b.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);
		// Only the reset takes b.txt out of the index: a hook that ran after it would leave a mark.
		hook(
			'post-index-change',
			'git ls-files --error-unmatch b.txt >/dev/null 2>&1 || touch "$(git rev-parse --git-dir)/unstaged-seen"',
		);

		await committer.commit(frozen ?? { repositories: [] }, new Map([[root, 'Add b']]), options);

		expect(git('status', '--porcelain')).toBe('?? b.txt');
		expect(existsSync(join(root, '.git', 'unstaged-seen'))).toBe(false);
	});

	it('fails to freeze a repository git cannot read, rather than take it for none', async () => {
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		writeFileSync(join(root, '.git', 'HEAD'), 'not a ref\n');

		await expect(committer.freeze(options)).rejects.toThrow('git could not read the repository');
	});

	it("runs the commit's hooks without the harness's secrets, with what signing needs", async () => {
		hook('pre-commit', 'env > "$(git rev-parse --git-dir)/hook-env"');
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		const frozen = await committer.freeze(options);
		vi.stubEnv('OPENAI_API_KEY', 'a secret');
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
		try {
			await committer.commit(
				frozen ?? { repositories: [] },
				new Map([[root, 'Change a']]),
				options,
			);
		} finally {
			vi.unstubAllEnvs();
		}

		const seen = readFileSync(join(root, '.git', 'hook-env'), 'utf8');
		expect(seen).not.toContain('OPENAI_API_KEY');
		expect(seen).toContain('SSH_AUTH_SOCK=/tmp/agent.sock');
	});

	it("checks whether git is ready without the harness's secrets", async () => {
		const monitor = join(parent, 'fsmonitor.sh');
		writeFileSync(monitor, `#!/bin/sh\nenv >> ${join(parent, 'monitor-env')}\nexit 1\n`);
		chmodSync(monitor, 0o755);
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		git('config', 'core.fsmonitor', monitor);
		vi.stubEnv('OPENAI_API_KEY', 'a secret');
		try {
			await committer.freeze(options);
		} finally {
			vi.unstubAllEnvs();
		}

		const seen = readFileSync(join(parent, 'monitor-env'), 'utf8');
		expect(seen).not.toContain('OPENAI_API_KEY');
	});

	it('freezes what the history recorded, not an edit made while it froze', async () => {
		// A filter that edits the file while git hashes what it held before the run.
		git(
			'config',
			'filter.racy.clean',
			'c=$(cat); if [ "$c" = one ] && [ -f race ]; then rm race; echo yours > a.txt; fi; printf "%s\\n" "$c"',
		);
		writeFileSync(join(root, '.gitattributes'), 'a.txt filter=racy\n');
		// Clean only through the filter, which adds the newline git holds, so the filter hashes it.
		writeFileSync(join(root, 'a.txt'), 'one');
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		writeFileSync(join(root, 'race'), '');

		const frozen = await committer.freeze(options);

		expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('yours\n');
		expect(frozen?.repositories[0]).toMatchObject({
			paths: [],
			leftOut: [{ path: 'a.txt', reason: 'it changed after the task last changed it' }],
		});
	});

	it('fails to freeze a repository whose index git cannot read', async () => {
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');
		writeFileSync(join(root, '.git', 'index'), 'not an index');

		await expect(committer.freeze(options)).rejects.toThrow('git could not list the index');
	});

	it('commits a file whose executable bit git does not trust, with the mode git holds', async () => {
		git('config', 'core.fileMode', 'false');
		chmodSync(join(root, 'a.txt'), 0o755);
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');

		const frozen = await committer.freeze(options);
		expect(frozen?.repositories[0]).toMatchObject({ paths: ['a.txt'], leftOut: [] });
		await committer.commit(frozen ?? { repositories: [] }, new Map([[root, 'Change a']]), options);

		expect(git('ls-tree', 'HEAD', 'a.txt')).toMatch(/^100644 /);
	});

	it('commits a file whose group or others may execute it, which git holds as not executable', async () => {
		chmodSync(join(root, 'a.txt'), 0o645);
		const { run, committer, options } = await workingRun({ edit: 'echo two > a.txt' });
		await run('edit');

		const frozen = await committer.freeze(options);

		expect(frozen?.repositories[0]).toMatchObject({ paths: ['a.txt'], leftOut: [] });
	});

	it('bounds the diff for the message by its characters, for a change on one long line', async () => {
		const { run, committer, options } = await workingRun({
			edit: "head -c 200000 /dev/zero | tr '\\0' x > long.txt",
		});
		await run('edit');

		const frozen = await committer.freeze(options);

		const diff = frozen?.repositories[0]?.diff ?? '';
		expect(diff.length).toBeLessThan(50_000);
		expect(diff).toMatch(/\.\.\. the rest of the diff is not shown$/);
	});

	it('writes the message from what the commit would change, not what a commit of the run holds already', async () => {
		const { run, committer, options } = await workingRun({
			edit: `echo two > a.txt && git ${identity.join(' ')} commit --quiet -am "feat: two" && echo three > a.txt`,
		});
		await run('edit');

		const frozen = await committer.freeze(options);

		const diff = frozen?.repositories[0]?.diff ?? '';
		expect(diff).toContain('-two');
		expect(diff).toContain('+three');
		expect(diff).not.toContain('-one');
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
