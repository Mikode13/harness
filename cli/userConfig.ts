import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { Commands, RoleSteps, RoleTokens } from '../src/index.ts';

/** What the CLI reads for one repository from the user's configuration. */
export interface RepositoryConfig {
	/** The commands the agents may run there. */
	commands?: Commands;
	/** The step limit of every role, or of each. */
	maxSteps?: number | RoleSteps;
	/** The input tokens at which the provider compacts every role's conversation, or each one's. */
	compactAt?: number | RoleTokens;
}

/**
 * Where the CLI reads its configuration: a file of the user's, outside every repository, so
 * neither a cloned repository nor the agent can decide what runs, or for how long.
 */
export function userConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	// The XDG spec says to ignore a relative path.
	const xdg = env.XDG_CONFIG_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
	return join(base, 'mikode-harness', 'config.json');
}

/**
 * The configuration for `repository`, from a file that maps each repository's real path to its
 * settings, or an empty one when there is no file or no entry for it.
 *
 * ```json
 * {
 *   "/Users/me/code/app": {
 *     "commands": { "test": { "description": "Runs the tests", "executable": "pnpm", "args": ["test"] } },
 *     "maxSteps": { "executor": 120 }
 *   }
 * }
 * ```
 *
 * @throws {Error} when the file is not valid JSON, has the wrong shape, or lies inside
 * `repository`, where the agent could rewrite it.
 */
export async function loadUserConfig(
	repository: string,
	path: string = userConfigPath(),
): Promise<RepositoryConfig> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
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
	if (!isRecord(config)) {
		throw new Error(`${path} must map each repository's path to its settings`);
	}
	const entry = config[real];
	if (entry === undefined) return {};
	if (!isRecord(entry)) throw new Error(`${path} must give ${real} an object of settings`);
	const known = ['commands', 'maxSteps', 'compactAt'];
	const unknown = Object.keys(entry).filter(key => !known.includes(key));
	if (unknown.length > 0) {
		throw new Error(`${path} has unknown settings for ${real}: ${unknown.join(', ')}`);
	}
	// Each value is checked when the agents are built, with an error naming what is wrong.
	return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
