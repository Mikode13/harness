import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstLine, runProcess } from './runProcess.ts';

/** Whether `.gitignore` excludes a path, which may not exist yet. */
export interface IgnoreRules {
	/** `relative` is relative to `root` and written with `/`. */
	isIgnored(root: string, relative: string, signal: AbortSignal): Promise<boolean>;
}

/**
 * git's environment without the variables that point it elsewhere: `GIT_DIR` or
 * `GIT_WORK_TREE` inherited from the host would make it answer about another repository.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

let emptyRepository: Promise<string> | undefined;

/**
 * A private, empty git directory for folders that are not repositories: `check-ignore` needs
 * one, and with it git still reads every `.gitignore` in the folder and the user's global
 * excludes. Created once per process and removed when the process exits.
 */
function getEmptyRepository(signal: AbortSignal): Promise<string> {
	emptyRepository ??= (async () => {
		const directory = await mkdtemp(join(tmpdir(), 'mikode-harness-git-'));
		process.once('exit', () => {
			rmSync(directory, { recursive: true, force: true });
		});
		const { exitCode, stderr } = await runProcess('git', ['init', '--bare', '--quiet', directory], {
			cwd: directory,
			signal,
			env: gitEnvironment(),
		});
		if (exitCode !== 0) {
			throw new Error(`git could not prepare an ignore check: ${firstLine(stderr)}`);
		}
		return directory;
	})();
	// A failed attempt is not kept, so the next check tries again.
	emptyRepository.catch(() => {
		emptyRepository = undefined;
	});
	return emptyRepository;
}

/**
 * Asks git, which knows every source of ignore rules: nested `.gitignore` files,
 * `.git/info/exclude` and the user's global excludes. `--no-index` makes a tracked file that a
 * rule names count as ignored too, as `RipgrepWorkspace` and `GitWorkspace` already treat it.
 */
export class GitIgnoreRules implements IgnoreRules {
	private readonly repositories = new Map<string, Promise<boolean>>();

	async isIgnored(root: string, relative: string, signal: AbortSignal): Promise<boolean> {
		const location = (await this.isRepository(root, signal))
			? []
			: ['--git-dir', await getEmptyRepository(signal), '--work-tree', root];
		const { exitCode, stderr } = await runProcess(
			'git',
			[...location, 'check-ignore', '--no-index', '--quiet', '--', relative],
			{ cwd: root, signal, env: gitEnvironment() },
		);
		// 0 means ignored and 1 means not; anything else is git failing to answer.
		if (exitCode === 0) return true;
		if (exitCode === 1) return false;
		throw new Error(`git could not check whether the path is ignored: ${firstLine(stderr)}`);
	}

	private isRepository(root: string, signal: AbortSignal): Promise<boolean> {
		let known = this.repositories.get(root);
		if (!known) {
			known = runProcess('git', ['rev-parse', '--is-inside-work-tree'], {
				cwd: root,
				signal,
				env: gitEnvironment(),
			}).then(({ exitCode, stdout }) => exitCode === 0 && stdout.trim() === 'true');
			this.repositories.set(root, known);
			known.catch(() => this.repositories.delete(root));
		}
		return known;
	}
}
