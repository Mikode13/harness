import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ToolCallContext } from '../domain/readRegistry.ts';

function within(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}${sep}`);
}

/** Each folder as a real path, or resolved when it does not exist. */
export function realFolders(folders: readonly string[]): Promise<string[]> {
	return Promise.all(folders.map(folder => realpath(folder).catch(() => resolve(folder))));
}

/** The folders of `folders` that lie in none of `ceiling`'s. */
export function outsideCeiling(folders: readonly string[], ceiling: readonly string[]): string[] {
	return folders.filter(folder => !ceiling.some(allowed => within(folder, allowed)));
}

/**
 * Where an agent the call starts may write, as real paths: within the call's own ceiling, and
 * within the `write` roots of the agent that made it. Absent only when neither sets a limit, as
 * for an agent with no workspace that no other agent started.
 */
export async function delegateCeiling(
	call: Pick<ToolCallContext, 'writeCeiling' | 'agentWriteRoots'>,
): Promise<readonly string[] | undefined> {
	const { writeCeiling, agentWriteRoots } = call;
	if (agentWriteRoots === undefined) return writeCeiling;
	const own = await realFolders(agentWriteRoots);
	if (writeCeiling === undefined) return own;
	// Each folder both allow: the narrower one wherever one lies in the other.
	return [
		...new Set([
			...own.filter(folder => writeCeiling.some(allowed => within(folder, allowed))),
			...writeCeiling.filter(folder => own.some(allowed => within(folder, allowed))),
		]),
	];
}

/**
 * Why a set of tools that may write in `folders` cannot write under `ceiling`, for the model, or
 * `undefined` when it can.
 */
export function ceilingRefusal(
	folders: readonly string[],
	ceiling: readonly string[] | undefined,
): string | undefined {
	if (ceiling === undefined) return undefined;
	const outside = outsideCeiling(folders, ceiling);
	if (outside.length === 0) return undefined;
	const allowed =
		ceiling.length === 0
			? 'the agent that handed you this task only reads, and your tools may write in'
			: `the agent that handed you this task may write only in ${ceiling.join(', ')}, and your tools may also write in`;
	return `Nothing was changed: ${allowed} ${outside.join(', ')}. An agent another agent started never writes more than that agent may. Answer with what you found, and say what you would have changed.`;
}
