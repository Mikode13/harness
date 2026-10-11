import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Commands } from '../src/index.ts';

/**
 * Where the CLI reads the commands the agent may run: a file of the user's, outside every
 * repository, so neither a cloned repository nor the agent can decide what runs.
 */
export function commandsConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	// The XDG spec says to ignore a relative path.
	const xdg = env.XDG_CONFIG_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
	return join(base, 'mikode-harness', 'commands.json');
}

/**
 * The commands configured for `repository`, from a file that maps each repository's real path
 * to its commands, or `undefined` when there is no file or no entry for it.
 *
 * ```json
 * { "/Users/me/code/app": { "test": { "description": "Runs the tests", "executable": "pnpm", "args": ["test"] } } }
 * ```
 *
 * @throws {Error} when the file is not valid JSON, or lies inside `repository`, where the
 * agent could rewrite it.
 */
export async function loadCommands(
	repository: string,
	path: string = commandsConfigPath(),
): Promise<Commands | undefined> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
	const real = await realpath(repository);
	const inside = relative(real, await realpath(path));
	if (!inside.startsWith('..') && !isAbsolute(inside)) {
		throw new Error(`${path} is inside the repository, where the agent could change it`);
	}

	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not valid JSON`, { cause: error });
	}
	if (typeof config !== 'object' || config === null || Array.isArray(config)) {
		throw new Error(`${path} must map each repository's path to its commands`);
	}
	// Each command is checked when the agent is built, with an error naming what is wrong.
	return (config as Record<string, Commands | undefined>)[real];
}
