import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { TextMatch, Workspace } from '../domain/workspace.ts';

// A NUL byte this early means a binary file, as git and ripgrep both judge it.
const binaryProbeBytes = 8000;

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
 */
export abstract class BoundedWorkspace implements Workspace {
	protected readonly root: string;

	constructor({ root }: { root: string }) {
		this.root = root;
	}

	/** Every file the program does not ignore, relative to the root, in any order. */
	protected abstract listCandidates(signal: AbortSignal): Promise<string[]>;

	/** Every line matching `pattern` in a file the program does not ignore, in any order. */
	protected abstract findMatches(
		pattern: string,
		ignoreCase: boolean,
		signal: AbortSignal,
	): Promise<TextMatch[]>;

	async listFiles(
		query: { path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ files: string[]; total: number; truncated: boolean }> {
		signal.throwIfAborted();
		const files = (await this.visibleFiles(signal)).filter(path => this.inScope(path, query));

		return {
			files: files.slice(0, query.limit),
			total: files.length,
			truncated: files.length > query.limit,
		};
	}

	async searchText(
		query: { pattern: string; ignoreCase: boolean; path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ matches: TextMatch[]; total: number; truncated: boolean }> {
		signal.throwIfAborted();
		const [visible, found] = await Promise.all([
			this.visibleFiles(signal),
			this.findMatches(query.pattern, query.ignoreCase, signal),
		]);
		// The programs search symlinks and files git still tracks but the disk lost; neither is visible.
		const visibleSet = new Set(visible);
		const matches = found
			.filter(match => visibleSet.has(match.path) && this.inScope(match.path, query))
			.sort((a, b) => compareText(a.path, b.path) || a.line - b.line);

		return {
			matches: matches.slice(0, query.limit),
			total: matches.length,
			truncated: matches.length > query.limit,
		};
	}

	async readFile(
		query: { path: string; fromLine: number; lineCount: number },
		signal: AbortSignal,
	): Promise<{ lines: string[]; totalLines: number; truncated: boolean }> {
		signal.throwIfAborted();
		const path = this.toRelative(query.path);
		// One answer for a missing file and an ignored one, or the model would learn the secret exists.
		if (path === undefined || !(await this.visibleFiles(signal)).includes(path)) {
			throw new Error(`No such file: ${query.path}`);
		}

		const absolute = join(this.root, path);
		if (await isBinary(absolute)) {
			throw new Error(`Not a text file: ${query.path}`);
		}

		// Streamed, so a large file costs its length in lines, not in memory.
		const reader = createInterface({
			input: createReadStream(absolute, { encoding: 'utf8', signal }),
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
	}

	/** Sorted regular files only: a symlink could point out of the root, and a deleted file is gone. */
	private async visibleFiles(signal: AbortSignal): Promise<string[]> {
		const candidates = [...new Set(await this.listCandidates(signal))];
		const regular = await Promise.all(
			candidates.map(path =>
				lstat(join(this.root, path)).then(
					stats => stats.isFile(),
					() => false,
				),
			),
		);

		return candidates.filter((_, index) => regular[index]).sort(compareText);
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
