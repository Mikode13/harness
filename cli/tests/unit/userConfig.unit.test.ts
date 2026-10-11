import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadUserConfig, userConfigPath } from '../../userConfig.ts';

let parent: string;
let repository: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-config-')));
	repository = join(parent, 'repo');
	mkdirSync(repository);
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

const test = { description: 'Runs the tests', executable: 'pnpm', args: ['test'] };

function config(content: unknown, path = join(parent, 'config', 'config.json')): string {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
	return path;
}

describe('userConfigPath', () => {
	it("is in the user's configuration folder, never a relative XDG one", () => {
		expect(userConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe(
			'/xdg/mikode-harness/config.json',
		);
		expect(userConfigPath({ XDG_CONFIG_HOME: 'relative' }, '/home/me')).toBe(
			'/home/me/.config/mikode-harness/config.json',
		);
	});
});

describe('loadUserConfig', () => {
	it("reads the repository's commands and step limits, by its real path", async () => {
		const path = config({ [repository]: { commands: { test }, maxSteps: { executor: 120 } } });
		symlinkSync(repository, join(parent, 'link'));

		await expect(loadUserConfig(join(parent, 'link'), path)).resolves.toEqual({
			commands: { test },
			maxSteps: { executor: 120 },
		});
	});

	it('has nothing without a file, or without an entry for the repository', async () => {
		await expect(loadUserConfig(repository, join(parent, 'missing.json'))).resolves.toEqual({});
		await expect(
			loadUserConfig(repository, config({ '/elsewhere': { commands: { test } } })),
		).resolves.toEqual({});
	});

	it('refuses a file inside the repository, where the agent could rewrite it', async () => {
		const path = config({ [repository]: {} }, join(repository, '.mikode', 'config.json'));

		await expect(loadUserConfig(repository, path)).rejects.toThrow(/inside the repository/);
	});

	it.each([
		['not JSON', () => '{', /not valid JSON/],
		['not an object of repositories', () => '[]', /must map each repository/],
		[
			'a repository entry that is not an object',
			() => ({ [repository]: [] }),
			/object of settings/,
		],
		// The old shape, commands straight under the repository, is caught rather than misread.
		[
			'a setting it does not know',
			() => ({ [repository]: { test } }),
			/unknown settings for .*: test/,
		],
	])('refuses a file with %s', async (_, content, message) => {
		await expect(loadUserConfig(repository, config(content()))).rejects.toThrow(message);
	});
});
