import type { TextMatch } from '../domain/workspace.ts';
import { BoundedWorkspace } from './boundedWorkspace.ts';
import { firstLine, runProcess } from './runProcess.ts';

// Every call sees what git would. Each flag is ours; nothing a model writes ever reaches the
// command line except the pattern, and that only after `-e`.
const sameViewAsGit = [
	// A user's ripgrep configuration could switch the ignore rules off.
	'--no-config',
	// Hidden files such as `.github/` are part of the repository; ripgrep skips them by default.
	'--hidden',
	// `.gitignore` applies even outside a git repository.
	'--no-require-git',
	// `--hidden` would otherwise search git's own folder.
	'--glob',
	'!.git',
];

interface RipgrepText {
	text?: string;
	// ripgrep sends what is not valid UTF-8 as base64 instead.
	bytes?: string;
}

interface RipgrepEvent {
	type: string;
	data: { path: RipgrepText; line_number: number; lines: RipgrepText };
}

function decode({ text, bytes }: RipgrepText): string {
	return text ?? Buffer.from(bytes ?? '', 'base64').toString('utf8');
}

/**
 * The preferred `Workspace`, on the ripgrep binary that ships with the package. It always runs
 * from the root with no path: ripgrep ignores nothing that it is given explicitly.
 *
 * It takes the binary's path instead of importing `@vscode/ripgrep`, which throws on import when
 * the platform has no binary; `createWorkspace` loads it where that failure can be handled.
 */
export class RipgrepWorkspace extends BoundedWorkspace {
	private readonly ripgrepPath: string;

	constructor({ root, ripgrepPath }: { root: string; ripgrepPath: string }) {
		super({ root });
		this.ripgrepPath = ripgrepPath;
	}

	protected async listCandidates(signal: AbortSignal): Promise<string[]> {
		const { stdout, stderr, exitCode } = await this.ripgrep(['--files', '--null'], signal);
		// 1 means nothing to list, which an empty repository is.
		if (exitCode > 1) {
			throw new Error(`ripgrep could not list the files: ${firstLine(stderr)}`);
		}

		return stdout
			.split('\0')
			.filter(path => path !== '')
			.map(path => path.replace(/^\.\//, ''));
	}

	protected async findMatches(
		pattern: string,
		ignoreCase: boolean,
		signal: AbortSignal,
	): Promise<TextMatch[]> {
		const { stdout, stderr, exitCode } = await this.ripgrep(
			['--json', ...(ignoreCase ? ['--ignore-case'] : []), '-e', pattern],
			signal,
		);

		const matches: TextMatch[] = [];
		for (const line of stdout.split('\n')) {
			if (line === '') {
				continue;
			}
			const event = JSON.parse(line) as RipgrepEvent;
			if (event.type === 'match') {
				matches.push({
					path: decode(event.data.path).replace(/^\.\//, ''),
					line: event.data.line_number,
					text: decode(event.data.lines).replace(/\r?\n$/, ''),
				});
			}
		}

		// 1 means no match. 2 is a failure, such as a pattern that does not compile, unless
		// matches came back: then only some file could not be read.
		if (exitCode > 1 && matches.length === 0) {
			throw new Error(`ripgrep could not search for the pattern: ${firstLine(stderr)}`);
		}
		return matches;
	}

	private ripgrep(args: string[], signal: AbortSignal) {
		return runProcess(this.ripgrepPath, [...sameViewAsGit, ...args], { cwd: this.root, signal });
	}
}
