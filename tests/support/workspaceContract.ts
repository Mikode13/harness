import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/tools/domain/workspace.ts';
import { createTemporaryRepository } from './temporaryRepository.ts';

const signal = new AbortController().signal;

const everyFile = [
	'.github/workflows/ci.yml',
	'.gitignore',
	'docs/new.md',
	'image.bin',
	'src/agent.ts',
	'src/flags.md',
	'src/nested/loop.ts',
];

/**
 * What every `Workspace` must do, whatever program it runs underneath. Each implementation
 * runs this same suite against the same real repository, so the fallback cannot see more, or
 * less, than the preferred one.
 */
export function describeWorkspaceContract(
	name: string,
	createWorkspace: (root: string) => Workspace,
): void {
	describe(`${name} as a Workspace`, () => {
		let repository: ReturnType<typeof createTemporaryRepository>;
		let workspace: Workspace;

		beforeAll(() => {
			repository = createTemporaryRepository();
			workspace = createWorkspace(repository.root);
		});

		afterAll(() => {
			repository.remove();
		});

		const list = (query: { path?: string; glob?: string; limit?: number } = {}) =>
			workspace.listFiles({ limit: 100, ...query }, signal);
		const search = (
			pattern: string,
			query: { ignoreCase?: boolean; path?: string; glob?: string; limit?: number } = {},
		) => workspace.searchText({ pattern, ignoreCase: false, limit: 100, ...query }, signal);
		const read = (path: string, fromLine = 1, lineCount = 100) =>
			workspace.readFile({ path, fromLine, lineCount }, signal);
		const found = async (...args: Parameters<typeof search>) =>
			(await search(...args)).matches.map(match => `${match.path}:${String(match.line)}`);

		describe('listFiles', () => {
			// Hidden files and new files count; ignored files, deleted files, symlinks and `.git` do not.
			it('lists what git tracks or would track, sorted, as paths relative to the root', async () => {
				expect(await list()).toEqual({ files: everyFile, total: 7, truncated: false });
			});

			it('narrows to a folder', async () => {
				expect((await list({ path: 'src' })).files).toEqual([
					'src/agent.ts',
					'src/flags.md',
					'src/nested/loop.ts',
				]);
				expect((await list({ path: 'src/nested' })).files).toEqual(['src/nested/loop.ts']);
			});

			it('narrows to a glob, alone or inside a folder', async () => {
				expect((await list({ glob: '**/*.md' })).files).toEqual(['docs/new.md', 'src/flags.md']);
				expect((await list({ path: 'src', glob: '**/*.ts' })).files).toEqual([
					'src/agent.ts',
					'src/nested/loop.ts',
				]);
			});

			it('cuts at the limit and still counts everything', async () => {
				expect(await list({ limit: 3 })).toEqual({
					files: everyFile.slice(0, 3),
					total: 7,
					truncated: true,
				});
			});

			it.each([
				['an ignored file', { path: '.env' }],
				['a tracked file .gitignore names', { path: 'tracked-secret.txt' }],
				['an ignored folder', { path: 'node_modules' }],
				['a glob naming an ignored file', { glob: '.env' }],
				['a glob naming an ignored folder', { glob: 'node_modules/**' }],
				['a glob naming every hidden file', { glob: '**/.env' }],
				['the git folder', { path: '.git' }],
				['a folder above the root', { path: '../outside' }],
				['a folder that does not exist', { path: 'missing' }],
			])('finds nothing in %s', async (_, query) => {
				expect(await list(query)).toEqual({ files: [], total: 0, truncated: false });
			});

			it('finds nothing in an absolute path outside the root', async () => {
				expect((await list({ path: repository.outside })).files).toEqual([]);
			});
		});

		describe('searchText', () => {
			// Not the ignored `.env` or `node_modules`, the binary file, the deleted file or the symlink.
			it('finds a pattern with its path, line and text, sorted by path and line', async () => {
				expect(await search('needle')).toEqual({
					matches: [
						{ path: '.github/workflows/ci.yml', line: 1, text: 'name: needle-ci' },
						{ path: 'docs/new.md', line: 1, text: 'a new needle' },
						{ path: 'src/agent.ts', line: 1, text: 'export const needle = 1;' },
						{ path: 'src/nested/loop.ts', line: 2, text: 'const needle = 2;' },
					],
					total: 4,
					truncated: false,
				});
			});

			it('ignores case only when asked to', async () => {
				expect(await found('needle', { ignoreCase: true })).toEqual([
					'.github/workflows/ci.yml:1',
					'docs/new.md:1',
					'src/agent.ts:1',
					'src/nested/loop.ts:1',
					'src/nested/loop.ts:2',
				]);
			});

			// The same syntax has to work on every implementation, or the fallback finds less.
			it.each([
				['a digit class', 'version = \\d+', ['src/agent.ts:3']],
				['an alternative', 'run\\(\\)|version', ['src/agent.ts:2', 'src/agent.ts:3']],
				['a word boundary', '\\brun\\b', ['src/agent.ts:2']],
				['an anchor', '^const', ['src/agent.ts:3', 'src/nested/loop.ts:2']],
			])('takes a regular expression with %s', async (_, pattern, expected) => {
				expect(await found(pattern)).toEqual(expected);
			});

			// The pattern comes from the model: it must never be read as an option of the program.
			it('takes a pattern that looks like a command-line flag as text', async () => {
				expect(await found('--files')).toEqual(['src/flags.md:1']);
			});

			it('rejects a pattern that is not a valid regular expression', async () => {
				await expect(search('(')).rejects.toBeInstanceOf(Error);
			});

			it('narrows to a folder, a file or a glob', async () => {
				expect(await found('needle', { path: 'src' })).toEqual([
					'src/agent.ts:1',
					'src/nested/loop.ts:2',
				]);
				expect(await found('needle', { path: 'src/agent.ts' })).toEqual(['src/agent.ts:1']);
				expect(await found('needle', { glob: '**/*.md' })).toEqual(['docs/new.md:1']);
			});

			it('cuts at the limit and still counts everything', async () => {
				expect(await search('needle', { limit: 2 })).toMatchObject({
					matches: [{ path: '.github/workflows/ci.yml' }, { path: 'docs/new.md' }],
					total: 4,
					truncated: true,
				});
			});

			// The scope is what the model writes, so it is the way a secret would leak.
			it.each([
				['an ignored file', { path: '.env' }],
				['a tracked file .gitignore names', { path: 'tracked-secret.txt' }],
				['an ignored folder', { path: 'node_modules' }],
				['a glob naming an ignored file', { glob: '.env' }],
				['a glob naming an ignored folder', { glob: 'node_modules/**' }],
				['a symlink out of the root', { path: 'link.txt' }],
				['a folder above the root', { path: '../outside' }],
			])('finds nothing when the scope is %s', async (_, query) => {
				expect(await search('needle', query)).toEqual({ matches: [], total: 0, truncated: false });
			});

			it('finds nothing in an absolute path outside the root', async () => {
				expect((await search('needle', { path: repository.outside })).matches).toEqual([]);
			});
		});

		describe('readFile', () => {
			it('reads a file as lines, without a last empty one', async () => {
				expect(await read('src/agent.ts')).toEqual({
					lines: ['export const needle = 1;', 'export function run() {}', 'const version = 42;'],
					totalLines: 3,
					truncated: false,
				});
			});

			it('reads a range of lines and says whether more follow', async () => {
				expect(await read('src/agent.ts', 2, 1)).toEqual({
					lines: ['export function run() {}'],
					totalLines: 3,
					truncated: true,
				});
				expect(await read('src/agent.ts', 3, 50)).toEqual({
					lines: ['const version = 42;'],
					totalLines: 3,
					truncated: false,
				});
			});

			it('reads nothing past the end of the file', async () => {
				expect(await read('src/agent.ts', 10)).toEqual({
					lines: [],
					totalLines: 3,
					truncated: false,
				});
			});

			it('reads a hidden file and a new file git has not seen yet', async () => {
				expect((await read('.github/workflows/ci.yml')).lines).toEqual(['name: needle-ci']);
				expect((await read('docs/new.md')).lines).toEqual(['a new needle']);
			});

			it.each([
				['an ignored file', '.env'],
				['a tracked file .gitignore names', 'tracked-secret.txt'],
				['a file in an ignored folder', 'node_modules/pkg/index.js'],
				['a file above the root', '../outside/secret.txt'],
				['a symlink out of the root', 'link.txt'],
				['a file inside the git folder', '.git/config'],
				['a file that does not exist', 'missing.ts'],
				['a file deleted from disk', 'removed.ts'],
				['a folder', 'src'],
				['a binary file', 'image.bin'],
			])('rejects %s', async (_, path) => {
				await expect(read(path)).rejects.toBeInstanceOf(Error);
			});

			it('rejects an absolute path outside the root', async () => {
				await expect(read(join(repository.outside, 'secret.txt'))).rejects.toBeInstanceOf(Error);
			});

			// A different answer would tell the model that the ignored file is there.
			it('rejects an ignored file exactly as it rejects a missing one', async () => {
				const messageFor = (path: string) =>
					read(path).then(
						() => 'resolved',
						(error: unknown) => (error as Error).message.replaceAll(path, '<path>'),
					);

				expect(await messageFor('.env')).toBe(await messageFor('missing.ts'));
			});
		});

		describe('cancellation', () => {
			const cancelled = AbortSignal.abort();

			it.each([
				['listFiles', () => workspace.listFiles({ limit: 100 }, cancelled)],
				[
					'searchText',
					() =>
						workspace.searchText({ pattern: 'needle', ignoreCase: false, limit: 100 }, cancelled),
				],
				[
					'readFile',
					() =>
						workspace.readFile({ path: 'src/agent.ts', fromLine: 1, lineCount: 100 }, cancelled),
				],
			])('%s rejects with the cancellation, not with a failure', async (_, operation) => {
				await expect(operation()).rejects.toMatchObject({ name: 'AbortError' });
			});
		});
	});
}
