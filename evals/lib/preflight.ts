import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { JudgeName } from './judge.ts';
import { type Path, rolesOf, type RunSettings } from './runners.ts';

type Provider = 'anthropic' | 'openai';

const judgeProviders: Record<JudgeName, Provider> = { opus: 'anthropic', astra: 'openai' };
const keyNames: Record<Provider, string> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
};

/**
 * The providers a measurement calls: those of the roles it runs, or of the one agent of the
 * `agent` path, and those of its judges.
 */
export function providersOf(
	settings: Pick<RunSettings, 'profile' | 'roles'> & { path: Path },
	judges: readonly JudgeName[],
): Provider[] {
	const roles = rolesOf(settings);
	const used = new Set<Provider>(
		settings.path === 'agent'
			? [roles.executor.provider]
			: Object.values(roles).map(role => role.provider),
	);
	for (const judge of judges) used.add(judgeProviders[judge]);
	return [...used].sort();
}

/** Lists the provider's models, which costs nothing, to learn whether its key is accepted. */
const probes: Record<Provider, (signal: AbortSignal) => Promise<unknown>> = {
	anthropic: signal => new Anthropic({ maxRetries: 0 }).models.list({ limit: 1 }, { signal }),
	openai: signal => new OpenAI({ maxRetries: 0 }).models.list({ signal }),
};

/**
 * What stops `providers` from being called, one line each, before any run is paid for: a key
 * missing from the environment, or one the provider refuses. Empty when every one answered.
 */
export async function problemsWith(providers: readonly Provider[]): Promise<string[]> {
	const problems = await Promise.all(
		providers.map(async provider => {
			const key = keyNames[provider];
			const value = process.env[key]?.trim();
			if (!value) return `${key} is not set in this shell`;
			try {
				await probes[provider](AbortSignal.timeout(15_000));
				return undefined;
			} catch (error) {
				const ending = value.slice(-4);
				const reason = error instanceof Error ? error.message : String(error);
				return `${provider} refused ${key}, the one ending in "${ending}": ${reason.slice(0, 200)}`;
			}
		}),
	);
	return problems.filter(problem => problem !== undefined);
}
