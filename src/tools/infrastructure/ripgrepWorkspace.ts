import type { TextMatch } from '../domain/workspace.ts';
import { BoundedWorkspace } from './boundedWorkspace.ts';
import { firstLine, runProcess } from './runProcess.ts';

// Every call sees what git would. Each flag is ours; nothing a model writes ever reaches the
// command line except the pattern, and that only after `-e`.
const sameViewAsGit = [
	// A user's ripgrep configuration could switch the ignore rules off.
	'--no-config',
	// ripgrep's own `.ignore` and `.rgignore` outrank `.gitignore`, so a `!.env` line in either
	// would show a secret git hides. Only git's ignore sources count.
	'--no-ignore-dot',
	// Hidden files such as `.github/` are part of the repository; ripgrep skips them by default.
	'--hidden',
	// `.gitignore` applies even outside a git repository.
	'--no-require-git',
	// `--hidden` would otherwise search git's own folder.
	'--glob',
	'!.git',
	// Windows would print `\`; every path in a `Workspace` is written with `/`.
	'--path-separator',
	'/',
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

	constructor({
		ripgrepPath,
		...options
	}: {
		root: string;
		ripgrepPath: string;
		timeoutMs?: number;
		hidden?: (path: string) => boolean;
	}) {
		super(options);
		this.ripgrepPath = ripgrepPath;
	}

	protected async listUnignored(signal: AbortSignal): Promise<string[]> {
		const { stdout, stderr, exitCode } = await this.ripgrep(['--files', '--null'], signal);
		// 1 means nothing to list, which an empty repository is. 2 with a listing means some
		// folder could not be read, which git skips with a warning too; without one, it failed.
		if (exitCode > 1 && stdout === '') {
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
		keep: (match: TextMatch) => void,
	): Promise<void> {
		// ripgrep ends every search it ran with a summary. A failure before searching, such as a
		// pattern that does not compile, prints none. A count, not a flag: TypeScript cannot see
		// the callback change it.
		let summaries = 0;
		const { stderr, exitCode } = await this.ripgrep(
			['--json', ...(ignoreCase ? ['--ignore-case'] : []), '-e', pattern],
			signal,
			line => {
				if (line === '') {
					return;
				}
				const event = JSON.parse(line) as RipgrepEvent;
				if (event.type === 'summary') {
					summaries++;
				}
				if (event.type === 'match') {
					keep({
						path: decode(event.data.path).replace(/^\.\//, ''),
						line: event.data.line_number,
						text: decode(event.data.lines).replace(/\r?\n$/, ''),
					});
				}
			},
		);

		// 1 means no match. 2 after a search means some file could not be read, and the rest
		// stands, as it does on git; 2 with no search is the failure.
		if (exitCode > 1 && summaries === 0) {
			throw new Error(`ripgrep could not search for the pattern: ${firstLine(stderr)}`);
		}
	}

	private ripgrep(args: string[], signal: AbortSignal, onLine?: (line: string) => void) {
		return runProcess(this.ripgrepPath, [...sameViewAsGit, ...args], {
			cwd: this.root,
			signal,
			onLine,
		});
	}
}
