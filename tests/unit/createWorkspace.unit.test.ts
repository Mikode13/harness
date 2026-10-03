import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace } from '../../src/tools/infrastructure/createWorkspace.ts';
import { RipgrepWorkspace } from '../../src/tools/infrastructure/ripgrepWorkspace.ts';
import { createTemporaryRepository } from '../support/temporaryRepository.ts';

/**
 * Loads `createWorkspace` as a platform without a ripgrep binary would: the import throws. The
 * classes come from the same fresh load, or `instanceof` would compare against stale copies.
 */
async function withoutRipgrep() {
	vi.resetModules();
	vi.doMock('@vscode/ripgrep', () => {
		throw new Error('Could not find @vscode/ripgrep-linux-riscv64.');
	});
	const [selection, git, errors] = await Promise.all([
		import('../../src/tools/infrastructure/createWorkspace.ts'),
		import('../../src/tools/infrastructure/gitWorkspace.ts'),
		import('../../src/shared/domain/errors.ts'),
	]);
	return {
		createWorkspace: selection.createWorkspace,
		GitWorkspace: git.GitWorkspace,
		UnrecoverableError: errors.UnrecoverableError,
	};
}

describe('createWorkspace', () => {
	const cleanUp: (() => void)[] = [];

	afterEach(() => {
		vi.doUnmock('@vscode/ripgrep');
		vi.resetModules();
		for (const step of cleanUp.splice(0)) step();
	});

	function repositoryRoot(): string {
		const repository = createTemporaryRepository();
		cleanUp.push(repository.remove);
		return repository.root;
	}

	it('reads through the ripgrep that ships with the package, without a warning', async () => {
		const logger = { warn: vi.fn() };

		const workspace = await createWorkspace({ root: repositoryRoot(), logger });

		expect(workspace).toBeInstanceOf(RipgrepWorkspace);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	// A degraded path the consumer should hear about, since #25 forbids a silent one.
	it('falls back to git when the platform has no ripgrep binary, and warns', async () => {
		const fresh = await withoutRipgrep();
		const logger = { warn: vi.fn() };

		const workspace = await fresh.createWorkspace({ root: repositoryRoot(), logger });

		expect(workspace).toBeInstanceOf(fresh.GitWorkspace);
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	// Never plain `grep`: it would read the ignored files the boundary exists to hide.
	it('fails when there is neither ripgrep nor a git repository', async () => {
		const fresh = await withoutRipgrep();
		const folder = realpathSync(mkdtempSync(join(tmpdir(), 'harness-no-git-')));
		cleanUp.push(() => {
			rmSync(folder, { recursive: true, force: true });
		});

		await expect(
			fresh.createWorkspace({ root: folder, logger: { warn: vi.fn() } }),
		).rejects.toBeInstanceOf(fresh.UnrecoverableError);
	});
});
