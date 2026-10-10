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
import { RunContext } from '../../src/agent/domain/runContext.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry, type RunReads } from '../../src/tools/domain/readRegistry.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import { RootsAccessPolicy } from '../../src/tools/infrastructure/rootsAccessPolicy.ts';
import { createTrackedReadFile } from '../../src/tools/infrastructure/trackedReadFile.ts';

const signal = new AbortController().signal;

let parent: string;
let root: string;
let tool: PreparingTool;
let reads: RunReads;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-tracked-read-')));
	root = join(parent, 'repo');
	mkdirSync(root);
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	tool = createTrackedReadFile(
		await RootsAccessPolicy.create({
			roots: [{ path: root, access: 'write' }],
			ignoreRules: new GitIgnoreRules(),
		}),
	);
	reads = new ReadRegistry().begin();
});

afterEach(() => {
	chmodSync(root, 0o755);
	rmSync(parent, { recursive: true, force: true });
});

/** What the model gets back: the output, or the error message, of one call. */
async function readFile(
	path: string,
	fromLine: number | null = null,
	lineCount: number | null = null,
): Promise<string> {
	try {
		const prepared = await tool.prepare({ path, fromLine, lineCount }, signal, {
			run: new RunContext(),
			reads,
		});
		return await prepared.run(signal);
	} catch (error) {
		return `error: ${(error as Error).message}`;
	}
}

function file(name: string, content: string | Buffer): string {
	const path = join(root, name);
	writeFileSync(path, content);
	return path;
}

describe('the readFile of an editing agent', () => {
	it('shows the lines without their CRLF endings, and records the version it showed', async () => {
		const path = file('a.txt', 'one\r\ntwo\r\nthree');

		await expect(readFile('a.txt', 2, 5)).resolves.toBe('2: two\n3: three');
		expect(reads.versionOf(path)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('says where to continue a read it cut', async () => {
		file('a.txt', 'one\ntwo\nthree\n');

		await expect(readFile('a.txt', 1, 2)).resolves.toBe(
			'1: one\n2: two\n[The file has 3 lines. Read from line 3 to continue.]',
		);
	});

	it.each([
		['an ignored file', 'build/out.txt', /excluded by \.gitignore/],
		['a secret', '.env', /may hold secrets/],
		['a binary file', 'image.bin', /^error: Not a text file: image\.bin$/],
		['a folder', 'src', /^error: No such file: src$/],
		['a missing file', 'missing.txt', /^error: No such file: missing\.txt$/],
		['a file too large', 'large.txt', /too large to read/],
	])('refuses %s, and records nothing', async (_, name, message) => {
		file('.gitignore', 'build/\n');
		mkdirSync(join(root, 'build'));
		file('build/out.txt', 'built');
		file('.env', 'TOKEN=secret');
		file('image.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
		mkdirSync(join(root, 'src'));
		file('large.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));

		await expect(readFile(name)).resolves.toMatch(message);
		expect(reads.versionOf(join(root, name))).toBeUndefined();
	});

	it('refuses input that does not match its schema before reading anything', async () => {
		await expect(readFile(42 as unknown as string)).resolves.toMatch(/^error: .*path/s);
	});

	it.each([
		[
			'a file it may not open',
			() => {
				chmodSync(file('locked.txt', 'x'), 0o000);
				return 'locked.txt';
			},
		],
		[
			'a loop of links',
			() => {
				symlinkSync(join(root, 'loop2'), join(root, 'loop1'));
				symlinkSync(join(root, 'loop1'), join(root, 'loop2'));
				return 'loop1';
			},
		],
		[
			'a folder it may not enter',
			() => {
				mkdirSync(join(root, 'closed'));
				file('closed/a.txt', 'x');
				chmodSync(join(root, 'closed'), 0o000);
				return 'closed/a.txt';
			},
		],
	])('names %s only as the model wrote it', async (_, make) => {
		const name = make();
		try {
			const answer = await readFile(name);

			expect(answer).toMatch(/^error: /);
			expect(answer).toContain(name);
			expect(answer).not.toContain(parent);
		} finally {
			chmodSync(join(root), 0o755);
			for (const folder of ['closed']) {
				try {
					chmodSync(join(root, folder), 0o755);
				} catch {
					// Not made by this case.
				}
			}
		}
	});

	it('gives a path through a hidden file the answer its name gets, whether or not it exists', async () => {
		const without = await readFile('.env/x');
		file('.env', 'TOKEN=secret');
		const withIt = await readFile('.env/x');

		expect(withIt).toBe(without);
		expect(withIt).toMatch(/may hold secrets/);
	});
});
