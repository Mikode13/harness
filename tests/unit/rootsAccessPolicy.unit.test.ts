import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Access } from '../../src/tools/domain/accessPolicy.ts';
import { AccessDeniedError } from '../../src/tools/domain/accessPolicy.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import {
	RootsAccessPolicy,
	type SecretRules,
} from '../../src/tools/infrastructure/rootsAccessPolicy.ts';

/**
 * ```text
 * parent/repo/                 a git repository, the write root
 *   .gitignore                 ignores node_modules, *.log and .env
 *   .git/config
 *   AGENTS.md, CLAUDE.md       CLAUDE.md is a symlink to AGENTS.md
 *   src/a.ts
 *   .env, .env.example
 *   config/app.pem
 *   store/                     a protected folder, as the recovery store would be
 *   store-link -> store
 *   out-link.txt -> ../outside/secret.txt
 *   dangling -> ../nowhere
 * parent/standards/            not a repository, a read root; .gitignore ignores drafts
 * parent/outside/secret.txt
 * parent/home/                 a home folder with credentials
 * ```
 */
let parent: string;
let repo: string;
let standards: string;
let home: string;
const signal = new AbortController().signal;
const ignoreRules = new GitIgnoreRules();

function write(path: string, content = '') {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

beforeAll(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-policy-')));
	repo = join(parent, 'repo');
	standards = join(parent, 'standards');
	home = join(parent, 'home');

	write(join(repo, '.gitignore'), 'node_modules\n*.log\n.env\n');
	write(join(repo, 'AGENTS.md'), '# agents\n');
	symlinkSync('AGENTS.md', join(repo, 'CLAUDE.md'));
	write(join(repo, 'src', 'a.ts'), 'export {};\n');
	write(join(repo, '.env'), 'KEY=secret\n');
	write(join(repo, '.env.example'), 'KEY=\n');
	write(join(repo, 'config', 'app.pem'), 'key\n');
	write(join(repo, 'store', 'run.json'), '{}');
	symlinkSync('store', join(repo, 'store-link'));
	write(join(parent, 'outside', 'secret.txt'), 'outside\n');
	symlinkSync(join('..', 'outside', 'secret.txt'), join(repo, 'out-link.txt'));
	symlinkSync(join('..', 'nowhere'), join(repo, 'dangling'));
	execFileSync('git', ['init', '--quiet'], { cwd: repo });

	write(join(standards, '.gitignore'), 'drafts\n');
	write(join(standards, 'guide.md'), '# guide\n');
	write(join(standards, 'drafts', 'next.md'), '# next\n');

	write(join(home, '.ssh', 'id_rsa'), 'key');
	write(join(home, '.npmrc'), '//registry:_authToken=x');
	write(join(home, 'notes.txt'), 'notes');
});

afterAll(() => {
	rmSync(parent, { recursive: true, force: true });
});

function policy({
	secrets,
	protectedPaths = [join(repo, 'store')],
}: { secrets?: SecretRules; protectedPaths?: string[] } = {}) {
	return RootsAccessPolicy.create({
		roots: [
			{ path: repo, access: 'write' },
			{ path: standards, access: 'read' },
		],
		protectedPaths,
		secrets,
		ignoreRules,
		home,
	});
}

async function denial(path: string, access: Access, options?: Parameters<typeof policy>[0]) {
	const error: unknown = await (await policy(options)).check(path, access, signal).then(
		() => undefined,
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(AccessDeniedError);
	// The model only ever sees the path it sent, never where the host keeps things.
	if (!path.includes(parent)) expect((error as Error).message).not.toContain(parent);
	return (error as Error).message;
}

describe('RootsAccessPolicy', () => {
	describe('where a path is', () => {
		it('places a relative path in the first root', async () => {
			await expect((await policy()).check('src/a.ts', 'write', signal)).resolves.toEqual({
				absolute: join(repo, 'src', 'a.ts'),
				root: repo,
				relative: 'src/a.ts',
			});
		});

		it('accepts an absolute path inside a root', async () => {
			await expect(
				(await policy()).check(join(standards, 'guide.md'), 'read', signal),
			).resolves.toMatchObject({ root: standards, relative: 'guide.md' });
		});

		it('allows a file that does not exist yet, in a folder that does not either', async () => {
			await expect((await policy()).check('src/new/b.ts', 'write', signal)).resolves.toMatchObject({
				absolute: join(repo, 'src', 'new', 'b.ts'),
				relative: 'src/new/b.ts',
			});
		});

		// `<parent>` stands for the fixture's folder, which only exists once the tests run.
		it.each(['../outside/secret.txt', '<parent>/outside/secret.txt', '/etc/hosts'])(
			'refuses %s, outside every root',
			async path => {
				expect(await denial(path.replace('<parent>', parent), 'read')).toContain(
					'outside the workspace',
				);
			},
		);

		it('follows a symlink to where it leads', async () => {
			await expect((await policy()).check('CLAUDE.md', 'write', signal)).resolves.toMatchObject({
				absolute: join(repo, 'AGENTS.md'),
				relative: 'AGENTS.md',
			});
		});

		it('refuses a symlink that leads out of the roots', async () => {
			expect(await denial('out-link.txt', 'read')).toContain('outside the workspace');
		});

		it.each(['dangling', 'dangling/file.txt'])(
			'refuses %s, through a link to nothing',
			async path => {
				expect(await denial(path, 'write')).toContain('link to nothing');
			},
		);

		it('refuses a path that treats a file as a folder', async () => {
			expect(await denial('src/a.ts/b.ts', 'write')).toContain('treats a file as a folder');
		});

		it.each(['', 'src/\0a.ts'])('refuses %j as a path', async path => {
			expect(await denial(path, 'read')).toContain('not a valid path');
		});
	});

	describe('what a root allows', () => {
		it('lets a read root be read and refuses to write to it', async () => {
			await expect(
				(await policy()).check(join(standards, 'guide.md'), 'read', signal),
			).resolves.toBeDefined();
			expect(await denial(join(standards, 'guide.md'), 'write')).toContain('read-only');
		});

		it('gives a root nested in another its own access', async () => {
			const nested = await RootsAccessPolicy.create({
				roots: [
					{ path: repo, access: 'read' },
					{ path: join(repo, 'src'), access: 'write' },
				],
				ignoreRules,
				home,
			});

			await expect(nested.check('src/a.ts', 'write', signal)).resolves.toMatchObject({
				root: join(repo, 'src'),
				relative: 'a.ts',
			});
			await expect(nested.check('AGENTS.md', 'write', signal)).rejects.toThrow(/read-only/);
		});
	});

	describe('protected paths', () => {
		it.each([
			'.git/config',
			'.GIT/config',
			'.git',
			'src/.git',
			'store/run.json',
			'store-link/run.json',
		])('refuses %s for reading and writing', async path => {
			expect(await denial(path, 'read')).toContain('protected by the harness');
			expect(await denial(path, 'write')).toContain('protected by the harness');
		});

		it('keeps protecting git metadata the host tried to allow', async () => {
			expect(
				await denial('.git/config', 'read', {
					secrets: { allow: [{ path: '.git/config', access: 'write' }] },
				}),
			).toContain('protected by the harness');
		});
	});

	describe('secrets', () => {
		it.each(['.env', '.ENV', 'src/.env.local', 'config/app.pem', 'deploy/server.key'])(
			'refuses %s by default',
			async path => {
				expect(await denial(path, 'read')).toContain('may hold secrets');
			},
		);

		it('lets a template such as .env.example through', async () => {
			await expect((await policy()).check('.env.example', 'write', signal)).resolves.toBeDefined();
		});

		it('refuses the credentials in a home folder that is a root', async () => {
			const atHome = await RootsAccessPolicy.create({
				roots: [{ path: home, access: 'write' }],
				ignoreRules,
				home,
			});

			await expect(atHome.check('.ssh/id_rsa', 'read', signal)).rejects.toThrow(/may hold secrets/);
			await expect(atHome.check('.npmrc', 'read', signal)).rejects.toThrow(/may hold secrets/);
			await expect(atHome.check('notes.txt', 'write', signal)).resolves.toBeDefined();
		});

		it('refuses what the host adds to the list', async () => {
			expect(await denial('src/a.ts', 'read', { secrets: { protect: ['src'] } })).toContain(
				'may hold secrets',
			);
		});

		it('opens an exact file the host allows for reading, and only for reading', async () => {
			const options = { secrets: { allow: [{ path: '.env', access: 'read' as const }] } };

			// Opened past .gitignore too: an opening it still blocked would open nothing.
			await expect((await policy(options)).check('.env', 'read', signal)).resolves.toMatchObject({
				relative: '.env',
			});
			expect(await denial('.env', 'write', options)).toContain('may hold secrets');
			expect(await denial('src/.env.local', 'read', options)).toContain('may hold secrets');
		});

		it('opens an exact file the host allows for writing', async () => {
			const opened = await policy({ secrets: { allow: [{ path: '.env', access: 'write' }] } });

			await expect(opened.check('.env', 'write', signal)).resolves.toBeDefined();
		});
	});

	describe('.gitignore', () => {
		it.each(['debug.log', 'node_modules/pkg/index.js'])(
			'refuses %s, which it excludes even before it exists',
			async path => {
				expect(await denial(path, 'write')).toContain('excluded by .gitignore');
			},
		);

		it('applies it in a root that is not a git repository', async () => {
			expect(await denial(join(standards, 'drafts', 'next.md'), 'read')).toContain(
				'excluded by .gitignore',
			);
		});

		it('ignores a GIT_DIR the host process carries', async () => {
			const previous = process.env.GIT_DIR;
			process.env.GIT_DIR = join(parent, 'outside');
			try {
				expect(await denial('debug.log', 'write')).toContain('excluded by .gitignore');
			} finally {
				if (previous === undefined) delete process.env.GIT_DIR;
				else process.env.GIT_DIR = previous;
			}
		});
	});

	describe('configuration', () => {
		it('needs at least one root', async () => {
			await expect(RootsAccessPolicy.create({ roots: [], ignoreRules })).rejects.toBeInstanceOf(
				InvalidAgentConfigError,
			);
		});

		it('refuses a root that is not an existing folder', async () => {
			await expect(
				RootsAccessPolicy.create({
					roots: [{ path: join(parent, 'missing'), access: 'read' }],
					ignoreRules,
				}),
			).rejects.toBeInstanceOf(InvalidAgentConfigError);
			await expect(
				RootsAccessPolicy.create({
					roots: [{ path: join(repo, 'AGENTS.md'), access: 'read' }],
					ignoreRules,
				}),
			).rejects.toBeInstanceOf(InvalidAgentConfigError);
		});
	});
});
