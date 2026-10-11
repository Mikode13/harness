import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandsConfigPath, loadCommands } from '../../commandsConfig.ts';

let parent: string;
let repository: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-cli-commands-')));
	repository = join(parent, 'repo');
	mkdirSync(repository);
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

const test = { description: 'Runs the tests', executable: 'pnpm', args: ['test'] };

function config(content: unknown, path = join(parent, 'config', 'commands.json')): string {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
	return path;
}

describe('commandsConfigPath', () => {
	it("is in the user's configuration folder, never a relative XDG one", () => {
		expect(commandsConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe(
			'/xdg/mikode-harness/commands.json',
		);
		expect(commandsConfigPath({ XDG_CONFIG_HOME: 'relative' }, '/home/me')).toBe(
			'/home/me/.config/mikode-harness/commands.json',
		);
	});
});

describe('loadCommands', () => {
	it("reads the repository's entry, by its real path", async () => {
		const path = config({ [repository]: { test } });
		symlinkSync(repository, join(parent, 'link'));

		await expect(loadCommands(join(parent, 'link'), path)).resolves.toEqual({ test });
	});

	it('has no commands without a file, or without an entry for the repository', async () => {
		await expect(loadCommands(repository, join(parent, 'missing.json'))).resolves.toBeUndefined();
		await expect(
			loadCommands(repository, config({ '/elsewhere': { test } })),
		).resolves.toBeUndefined();
	});

	it('refuses a file inside the repository, where the agent could rewrite it', async () => {
		const path = config({ [repository]: { test } }, join(repository, '.mikode', 'commands.json'));

		await expect(loadCommands(repository, path)).rejects.toThrow(/inside the repository/);
	});

	it.each([
		['not JSON', '{', /not valid JSON/],
		['not an object of repositories', '[]', /must map each repository/],
	])('refuses a file that is %s', async (_, content, message) => {
		await expect(loadCommands(repository, config(content))).rejects.toThrow(message);
	});
});
