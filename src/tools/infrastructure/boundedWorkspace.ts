import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { TextMatch, Workspace } from '../domain/workspace.ts';

// A NUL byte this early means a binary file, as git and ripgrep both judge it.
const binaryProbeBytes = 8000;

// What a search holds while it sorts. A minified file can put a whole bundle on one line, and
// a careless pattern can match every line of a repository.
const maxStoredMatches = 50_000;
const maxStoredLineLength = 1_000;

// Far beyond what ripgrep needs on a large repository, so only a runaway search reaches it,
// such as a pattern that backtracks without end in git's Perl engine.
const defaultTimeoutMs = 30_000;

function compareText(a: string, b: string): number {
	// Plain code-unit order: `localeCompare` would sort differently on every machine.
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Everything both implementations share: the boundary and the shape of every answer. A
 * subclass only says which files are visible and where a pattern matches, across the whole
 * root; the scope a model asks for is applied here, to those results, and never handed to the
 * program underneath. ripgrep stops honouring `.gitignore` for a path it is given explicitly,
 * so passing the model's scope down is how a secret would leak. See "`.gitignore` is the
 * boundary of what an agent reads" in decisions.md.
 *
 * Every operation also stops after `timeoutMs`. A timeout is a failure the model reads and
 * narrows its query from, not a cancellation: only the run's own signal cancels the run.
 */
export abstract class BoundedWorkspace implements Workspace {
	protected readonly root: string;
	private readonly timeoutMs: number;

	constructor({ root, timeoutMs = defaultTimeoutMs }: { root: string; timeoutMs?: number }) {
		this.root = root;
		this.timeoutMs = timeoutMs;
	}

	/** Every file the program does not ignore, relative to the root, in any order. */
	protected abstract listCandidates(signal: AbortSignal): Promise<string[]>;

	/**
	 * Hands `keep` every line matching `pattern` in a file the program does not ignore, in any
	 * order, as the program prints it. Nothing is held here: `keep` decides what to store.
	 */
	protected abstract findMatches(
		pattern: string,
		ignoreCase: boolean,
		signal: AbortSignal,
		keep: (match: TextMatch) => void,
	): Promise<void>;

	listFiles(
		query: { path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ files: string[]; total: number; truncated: boolean }> {
		return this.withTimeout(signal, async bounded => {
			const inScope = [...new Set(await this.listCandidates(bounded))].filter(path =>
				this.inScope(path, query),
			);
			const files = (await this.regularFiles(inScope)).sort(compareText);

			return {
				files: files.slice(0, query.limit),
				total: files.length,
				truncated: files.length > query.limit,
			};
		});
	}

	searchText(
		query: { pattern: string; ignoreCase: boolean; path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ matches: TextMatch[]; total: number; truncated: boolean }> {
		return this.withTimeout(signal, async bounded => {
			const listed = new Set(await this.listCandidates(bounded));
			// The scope applies as the output arrives, so narrowing a search is what makes it
			// lighter: matches outside it are never stored, however many the program prints.
			const kept: TextMatch[] = [];
			await this.findMatches(query.pattern, query.ignoreCase, bounded, match => {
				if (!listed.has(match.path) || !this.inScope(match.path, query)) {
					return;
				}
				if (kept.length === maxStoredMatches) {
					throw new Error(
						`More than ${String(maxStoredMatches)} lines match; narrow the pattern, path or glob`,
					);
				}
				kept.push({ ...match, text: match.text.slice(0, maxStoredLineLength) });
			});

			// Only the files that matched are checked on disk, not the whole repository.
			const regular = new Set(await this.regularFiles([...new Set(kept.map(match => match.path))]));
			const matches = kept
				.filter(match => regular.has(match.path))
				.sort((a, b) => compareText(a.path, b.path) || a.line - b.line);

			return {
				matches: matches.slice(0, query.limit),
				total: matches.length,
				truncated: matches.length > query.limit,
			};
		});
	}

	readFile(
		query: { path: string; fromLine: number; lineCount: number },
		signal: AbortSignal,
	): Promise<{ lines: string[]; totalLines: number; truncated: boolean }> {
		return this.withTimeout(signal, async bounded => {
			const path = this.toRelative(query.path);
			const visible =
				path !== undefined &&
				(await this.listCandidates(bounded)).includes(path) &&
				(await this.regularFiles([path])).length === 1;
			// One answer for a missing file and an ignored one, or the model would learn the secret exists.
			if (!visible) {
				throw new Error(`No such file: ${query.path}`);
			}

			const absolute = join(this.root, path);
			if (await isBinary(absolute)) {
				throw new Error(`Not a text file: ${query.path}`);
			}

			// Streamed, so a large file costs its length in lines, not in memory.
			const reader = createInterface({
				input: createReadStream(absolute, { encoding: 'utf8', signal: bounded }),
				crlfDelay: Infinity,
			});
			const last = query.fromLine + query.lineCount - 1;
			const lines: string[] = [];
			let totalLines = 0;
			for await (const line of reader) {
				totalLines++;
				if (totalLines >= query.fromLine && totalLines <= last) {
					lines.push(line);
				}
			}

			return { lines, totalLines, truncated: totalLines > last };
		});
	}

	/**
	 * Runs an operation under the run's signal and this workspace's time limit together. The
	 * run's cancellation escapes unchanged; the time limit becomes an error the model can act on.
	 */
	private async withTimeout<Result>(
		signal: AbortSignal,
		operation: (bounded: AbortSignal) => Promise<Result>,
	): Promise<Result> {
		signal.throwIfAborted();
		const timeout = AbortSignal.timeout(this.timeoutMs);
		try {
			return await operation(AbortSignal.any([signal, timeout]));
		} catch (error) {
			signal.throwIfAborted();
			if (timeout.aborted) {
				throw new Error(
					`The operation took longer than ${String(this.timeoutMs / 1000)} s; narrow the pattern, path or glob`,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	/** Regular files only: a symlink could point out of the root, and a deleted file is gone. */
	private async regularFiles(paths: string[]): Promise<string[]> {
		const regular = await Promise.all(
			paths.map(path =>
				lstat(join(this.root, path)).then(
					stats => stats.isFile(),
					() => false,
				),
			),
		);

		return paths.filter((_, index) => regular[index]);
	}

	private inScope(path: string, { path: scope, glob }: { path?: string; glob?: string }): boolean {
		if (scope !== undefined) {
			const folder = this.toRelative(scope);
			if (folder === undefined) {
				return false;
			}
			if (folder !== '' && path !== folder && !path.startsWith(`${folder}/`)) {
				return false;
			}
		}

		return glob === undefined || matchesGlob(path, glob);
	}

	/** A path relative to the root with `/`, '' for the root itself, or undefined when it leaves it. */
	private toRelative(path: string): string | undefined {
		const relativePath = relative(this.root, resolve(this.root, path));
		if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			return undefined;
		}

		return relativePath.split(sep).join('/');
	}
}

async function isBinary(path: string): Promise<boolean> {
	const file = await open(path);
	try {
		const probe = Buffer.alloc(binaryProbeBytes);
		const { bytesRead } = await file.read(probe, 0, probe.length, 0);
		return probe.subarray(0, bytesRead).includes(0);
	} finally {
		await file.close();
	}
}
