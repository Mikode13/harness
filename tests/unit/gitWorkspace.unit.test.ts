import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitWorkspace } from '../../src/tools/infrastructure/gitWorkspace.ts';
import { createTemporaryRepository } from '../support/temporaryRepository.ts';
import { describeWorkspaceContract } from '../support/workspaceContract.ts';

// git is the fallback, and the one implementation every machine that has a repository can run.
describeWorkspaceContract('GitWorkspace', root => new GitWorkspace({ root }));

describe('GitWorkspace with a user’s git settings', () => {
	const signal = new AbortController().signal;
	let remove: () => void = () => undefined;

	afterEach(() => {
		remove();
	});

	function repositoryWith(setting: string, value: string): string {
		const repository = createTemporaryRepository();
		remove = repository.remove;
		execFileSync('git', ['config', setting, value], { cwd: repository.root });
		return repository.root;
	}

	// The output is parsed by position: an extra column field would land inside the text.
	it('reads the text as it is when grep.column is on', async () => {
		const root = repositoryWith('grep.column', 'true');

		const { matches } = await new GitWorkspace({ root }).searchText(
			{ pattern: 'version', ignoreCase: false, limit: 10 },
			signal,
		);

		expect(matches).toEqual([{ path: 'src/agent.ts', line: 3, text: 'const version = 42;' }]);
	});

	it("lists the files without the harness's secrets, which the repository's fsmonitor would see", async () => {
		const repository = createTemporaryRepository();
		remove = repository.remove;
		const seen = join(repository.root, '.git', 'monitor-env');
		const monitor = join(repository.root, '.git', 'fsmonitor.sh');
		writeFileSync(monitor, `#!/bin/sh\nenv >> "${seen}"\nexit 1\n`);
		chmodSync(monitor, 0o755);
		execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: repository.root });
		vi.stubEnv('OPENAI_API_KEY', 'a secret');
		try {
			await new GitWorkspace({ root: repository.root }).listFiles({ limit: 10 }, signal);
		} finally {
			vi.unstubAllEnvs();
		}

		expect(readFileSync(seen, 'utf8')).not.toContain('OPENAI_API_KEY');
	});

	// With it on, paths would be relative to the repository, and no match would be visible.
	it('finds matches below a root inside the repository when grep.fullName is on', async () => {
		const root = join(repositoryWith('grep.fullName', 'true'), 'src');

		const { matches } = await new GitWorkspace({ root }).searchText(
			{ pattern: 'needle', ignoreCase: false, limit: 10 },
			signal,
		);

		expect(matches.map(match => match.path)).toEqual(['agent.ts', 'nested/loop.ts']);
	});
});
