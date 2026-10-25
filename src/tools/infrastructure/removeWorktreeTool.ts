import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { WorkspaceRoot } from '../domain/accessPolicy.ts';
import type { PreparingTool } from '../domain/preparedCall.ts';
import { definePreparingTool } from './defineTool.ts';
import { git, listWorktrees } from './worktrees.ts';

function within(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}${sep}`);
}

/** How many paths `git status --porcelain -z` names: a rename or copy names its source after it. */
function changedFiles(status: string): number {
	const fields = status.split('\0');
	let count = 0;
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index] ?? '';
		if (field.length < 4) continue;
		count++;
		if (field.startsWith('R') || field.startsWith('C')) index++;
	}
	return count;
}

/**
 * `removeWorktree`: removes a git worktree of the repository the first root is in, its folder
 * and working files, never its branch, which keeps its commits. Each call is `destructive`, so
 * it is asked about, and the request names what is lost: changes no commit has, and with a
 * detached HEAD the commits no branch, tag or remote holds. It refuses the repository's main
 * folder, and a worktree the agent works in, which holds one of its roots or lies inside one.
 */
export function createRemoveWorktreeTool({
	base,
	roots,
}: {
	/** The real path of the first root. */
	base: string;
	roots: readonly WorkspaceRoot[];
}): PreparingTool {
	return definePreparingTool({
		name: 'removeWorktree',
		description:
			'Removes a git worktree of this repository: its folder and every file in it, committed or not. Its branch stays, with its commits. Only when the user asks for it.',
		input: z.object({
			path: z
				.string()
				.describe('The folder of the worktree, absolute or relative to the first root.'),
		}),
		summarize: ({ path }) => path,
		prepare: async ({ path }, signal) => {
			const asked = resolve(base, path);
			const target = await realpath(asked).catch(() => {
				throw new Error(`There is no folder at ${asked}.`);
			});
			const worktrees = await listWorktrees(base, signal);
			const [main] = worktrees;
			if (main?.path === target) {
				throw new Error(
					`${target} is the repository's main folder, not a worktree. Only a worktree can be removed.`,
				);
			}
			const worktree = worktrees.find(listed => listed.path === target);
			if (!worktree) {
				const others = worktrees.slice(1).map(listed => listed.path);
				throw new Error(
					`${target} is not a worktree of this repository. Its worktrees: ${others.join(', ') || 'none'}.`,
				);
			}
			const own = await Promise.all(
				// From the working directory, as the workspace reads them.
				roots.map(root => realpath(resolve(root.path)).catch(() => resolve(root.path))),
			);
			if (own.some(root => within(root, target) || within(target, root))) {
				throw new Error(`You work in ${target}, so it cannot be removed from this run.`);
			}
			if (worktree.locked) {
				throw new Error(`${target} is locked. The user must unlock it to remove it.`);
			}

			const status = await git(
				['status', '--porcelain=v1', '-z', '--untracked-files=all'],
				target,
				signal,
			);
			if (status.exitCode !== 0) {
				throw new Error(`git could not read what ${target} holds: ${status.stderr.trim()}`);
			}
			let commitsOnlyHere = 0;
			if (worktree.branch === undefined) {
				const count = await git(
					['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes'],
					target,
					signal,
				);
				commitsOnlyHere = Number(count.stdout.trim()) || 0;
			}
			const removal = {
				path: target,
				...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
				uncommitted: changedFiles(status.stdout),
				commitsOnlyHere,
			};
			return {
				risk: 'destructive',
				worktree: removal,
				run: async runSignal => {
					// Forced: what it held unsaved is what the user approved losing.
					const removed = await git(
						['worktree', 'remove', '--force', '--', target],
						base,
						runSignal,
					);
					if (removed.exitCode !== 0) {
						throw new Error(`git could not remove ${target}: ${removed.stderr.trim()}`);
					}
					return removal.branch === undefined
						? `Removed the worktree at ${target}.`
						: `Removed the worktree at ${target}. Its branch ${removal.branch} stays, with its commits.`;
				},
			};
		},
	});
}
