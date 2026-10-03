import type { TextMatch } from '../domain/workspace.ts';
import { BoundedWorkspace } from './boundedWorkspace.ts';
import { firstLine, runProcess } from './runProcess.ts';

/**
 * The fallback `Workspace`, on the git the repository already has. git applies `.gitignore`
 * by itself, even to an explicit path, but only inside a repository: outside one, every
 * operation fails.
 */
export class GitWorkspace extends BoundedWorkspace {
	protected async listCandidates(signal: AbortSignal): Promise<string[]> {
		// Tracked files, and new ones not yet added; ignored ones are neither.
		const { stdout, stderr, exitCode } = await this.git(
			['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
			signal,
		);
		if (exitCode !== 0) {
			throw new Error(`git could not list the files: ${firstLine(stderr)}`);
		}

		return stdout.split('\0').filter(path => path !== '');
	}

	protected async findMatches(
		pattern: string,
		ignoreCase: boolean,
		signal: AbortSignal,
	): Promise<TextMatch[]> {
		const { stdout, stderr, exitCode } = await this.git(
			[
				'grep',
				// Untracked files too, or the agent could not search a file it has just created.
				'--untracked',
				// Binary files left out, as ripgrep does.
				'-I',
				'--line-number',
				// path NUL line NUL text, so a colon in a path cannot split it.
				'-z',
				// Perl syntax, so `\d` and `\b` mean what they mean to ripgrep.
				'-P',
				...(ignoreCase ? ['--ignore-case'] : []),
				// `-e`, so a pattern starting with a dash is never read as an option.
				'-e',
				pattern,
			],
			signal,
		);
		// 1 means no match; anything above is a failure, such as a pattern that does not compile.
		if (exitCode > 1) {
			throw new Error(`git could not search for the pattern: ${firstLine(stderr)}`);
		}

		const matches: TextMatch[] = [];
		for (const line of stdout.split('\n')) {
			const [path, number, ...text] = line.split('\0');
			if (path && number) {
				matches.push({ path, line: Number(number), text: text.join('\0').replace(/\r$/, '') });
			}
		}
		return matches;
	}

	private git(args: string[], signal: AbortSignal) {
		// Colour codes would end up inside the text the model reads.
		return runProcess('git', ['-c', 'color.ui=never', ...args], { cwd: this.root, signal });
	}
}
