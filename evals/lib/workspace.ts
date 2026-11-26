import { execFileSync, spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Commands, Formatter } from '../../src/index.ts';
import { type CheckName, type Task, tasksDirectory } from './tasks.ts';

/** The harness's own packages, which every task's repository uses for its tests and checks. */
const harnessModules = join(import.meta.dirname, '..', '..', 'node_modules');

const git = (cwd: string, args: string[]): string =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'evals',
			GIT_AUTHOR_EMAIL: 'evals@example.invalid',
			GIT_COMMITTER_NAME: 'evals',
			GIT_COMMITTER_EMAIL: 'evals@example.invalid',
		},
	});

/**
 * A fresh repository for `task` in a folder of its own: `_base`, then the task's repository and
 * its overlays, then the folders of `overlays`, committed as one commit, with the harness's `node_modules` linked in
 * and ignored. Nothing of the harness's history is in it, so the task never depends on it.
 */
export function prepareWorkspace(task: Task, overlays: readonly string[] = []): string {
	const root = mkdtempSync(join(tmpdir(), `eval-${task.name}-`));
	cpSync(join(tasksDirectory, '_base'), root, { recursive: true });
	cpSync(join(task.directory, task.repo), root, { recursive: true });
	for (const overlay of [...task.overlays, ...overlays]) {
		cpSync(join(task.directory, overlay), root, { recursive: true });
	}
	symlinkSync(harnessModules, join(root, 'node_modules'), 'dir');
	git(root, ['init', '--quiet', '--initial-branch=main']);
	git(root, ['add', '--all']);
	git(root, ['commit', '--quiet', '--no-verify', '--message', 'The task as it starts']);
	return root;
}

/**
 * Where the harness keeps the history of `workspace`: beside it, not in the user's state folder,
 * so it goes with it.
 */
export function stateDirectoryOf(workspace: string): string {
	return `${workspace}-state`;
}

/** Removes a workspace and the history the harness kept of it. */
export function removeWorkspace(workspace: string): void {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(stateDirectoryOf(workspace), { recursive: true, force: true });
}

/** Lays a folder of the task over the workspace, uncommitted, as an agent's change would be. */
export function applyOverlay(task: Task, workspace: string, overlay: string): void {
	cpSync(join(task.directory, overlay), workspace, { recursive: true });
}

/** Everything the workspace holds that its first commit did not, new files included, as a diff. */
export function changesSinceStart(workspace: string): string {
	git(workspace, ['add', '--all', '--intent-to-add']);
	const first = git(workspace, ['rev-list', '--max-parents=0', 'HEAD']).trim();
	return git(workspace, ['diff', first, '--', '.', ':(exclude)tests/hidden']);
}

// What decides how the checks judge the code: a run that changes one has changed its own judge.
const configuration = [
	/(^|\/)package\.json$/u,
	/(^|\/)tsconfig[^/]*\.json$/u,
	/(^|\/)eslint\.config\.[cm]?[jt]s$/u,
	/(^|\/)\.eslintrc[^/]*$/u,
	/(^|\/)\.eslintignore$/u,
	/(^|\/)prettier\.config\.[cm]?[jt]s$/u,
	/(^|\/)\.prettierrc[^/]*$/u,
	/(^|\/)\.prettierignore$/u,
	/(^|\/)vite(st)?\.(config|workspace)\.[cm]?[jt]s$/u,
	/(^|\/)\.gitignore$/u,
];

/**
 * Puts back every configuration file the run changed, as the task started, and removes those it
 * added, so the checks judge the code by the task's own rules. Returns the files it put back or
 * removed: a run that changed any did not pass, whatever the checks say after.
 */
export function restoreConfiguration(workspace: string): string[] {
	const first = git(workspace, ['rev-list', '--max-parents=0', 'HEAD']).trim();
	const changed = git(workspace, ['status', '--porcelain', '--untracked-files=all', '--no-renames'])
		.split('\n')
		.filter(line => line.length > 3)
		.map(line => line.slice(3))
		.filter(
			path => !path.startsWith('tests/hidden/') && configuration.some(rule => rule.test(path)),
		);
	for (const path of changed) {
		const tracked =
			spawnSync('git', ['cat-file', '-e', `${first}:${path}`], { cwd: workspace }).status === 0;
		if (tracked) git(workspace, ['checkout', first, '--', path]);
		else rmSync(join(workspace, path), { force: true });
	}
	return changed.sort();
}

/** The test files under `tests/`, the hidden ones left out, relative to the workspace. */
export function testFiles(workspace: string, folder = 'tests'): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (relative(workspace, path) !== join('tests', 'hidden')) walk(path);
			} else if (entry.name.endsWith('.test.ts')) {
				found.push(relative(workspace, path));
			}
		}
	};
	walk(join(workspace, folder));
	return found.sort();
}

/** The workspace's files under `src/` and `tests/` whose text matches one of `patterns`. */
export function forbiddenMatches(workspace: string, patterns: readonly string[]): string[] {
	if (patterns.length === 0) return [];
	const found: string[] = [];
	const walk = (directory: string): void => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (relative(workspace, path) !== join('tests', 'hidden')) walk(path);
				continue;
			}
			const text = readFileSync(path, 'utf8');
			for (const pattern of patterns) {
				if (new RegExp(pattern, 'u').test(text))
					found.push(`${relative(workspace, path)}: ${pattern}`);
			}
		}
	};
	walk(join(workspace, 'src'));
	walk(join(workspace, 'tests'));
	return found;
}

/** How a check of the workspace ended. */
export interface CheckRun {
	passed: boolean;
	output: string;
}

const checkCommands: Record<CheckName, { executable: string; args: string[] }> = {
	test: { executable: 'node_modules/.bin/vitest', args: ['run'] },
	typecheck: { executable: 'node_modules/.bin/tsc', args: ['--noEmit', '-p', '.'] },
	lint: { executable: 'node_modules/.bin/eslint', args: ['--max-warnings', '0', '.'] },
};

/** Runs a check in the workspace, as its command would, with `extra` arguments after its own. */
export function runCheck(workspace: string, check: CheckName, extra: string[] = []): CheckRun {
	const { executable, args } = checkCommands[check];
	const ran = spawnSync(join(workspace, executable), [...args, ...extra], {
		cwd: workspace,
		encoding: 'utf8',
		timeout: 10 * 60 * 1000,
		env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CI: '1' },
	});
	return {
		passed: ran.status === 0,
		output: `${ran.stdout}${ran.stderr}`.slice(-16_000),
	};
}

/**
 * The commands the agents may run in a task's repository, the same three as its checks. Each
 * runs the harness's own tools, through the linked `node_modules`, without a shell.
 */
export function taskCommands(): Commands {
	return {
		test: {
			description:
				"Runs the project's tests with Vitest. Give paths to run only some test files; give none to run them all.",
			executable: checkCommands.test.executable,
			args: [
				...checkCommands.test.args,
				{ type: 'paths', name: 'paths', description: 'Test files to run' },
			],
		},
		typecheck: {
			description: 'Type-checks the whole project with tsc.',
			executable: checkCommands.typecheck.executable,
			args: checkCommands.typecheck.args,
		},
		lint: {
			description:
				'Lints the project with ESLint, strict typescript-eslint rules, warnings counted as errors.',
			executable: checkCommands.lint.executable,
			args: checkCommands.lint.args,
		},
	};
}

/** The formatter the edit tools run on each file they write: the project's Prettier. */
export const taskFormatter: Formatter = {
	executable: 'node_modules/.bin/prettier',
	args: ['--write', '--ignore-unknown'],
};
