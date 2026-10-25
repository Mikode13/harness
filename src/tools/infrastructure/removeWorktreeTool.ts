import { lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { WorktreeRemoval } from '#src/agent/domain/approval';
import { WorkspaceBusyError } from '#src/recovery/domain/recoveryStore';
import { FolderClaims } from '#src/recovery/infrastructure/folderClaims';
import type { WorkspaceRoot } from '../domain/accessPolicy.ts';
import type { PreparingTool } from '../domain/preparedCall.ts';
import { definePreparingTool } from './defineTool.ts';
import { git, listWorktrees } from './worktrees.ts';

function within(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}${sep}`);
}

/**
 * The paths `git status --porcelain -z` names, each with its two-letter code. A rename or copy
 * names its source after it, which is skipped.
 */
function statusEntries(status: string): { code: string; path: string }[] {
	const fields = status.split('\0');
	const entries: { code: string; path: string }[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index] ?? '';
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		entries.push({ code, path: field.slice(3) });
		if (code.startsWith('R') || code.startsWith('C')) index++;
	}
	return entries;
}

async function gitOutput(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	const { stdout, stderr, exitCode } = await git(args, cwd, signal);
	if (exitCode !== 0) {
		throw new Error(
			`git could not tell what removing ${cwd} would lose, so nothing was removed: ${stderr.trim()}`,
		);
	}
	return stdout;
}

/**
 * What removing the worktree at `path` would lose, and a fingerprint of all it rests on: its
 * HEAD, its branch, the commits at risk, and each file `git status` names, by size and time of
 * change. Throws when
 * any of it cannot be read, since a removal must never be asked about with less than it loses.
 */
async function inspect(
	path: string,
	branch: string | undefined,
	signal: AbortSignal,
): Promise<{ removal: WorktreeRemoval; fingerprint: string }> {
	const head = (await gitOutput(['rev-parse', '--verify', 'HEAD'], path, signal)).trim();
	const changed = statusEntries(
		await gitOutput(['status', '--porcelain=v1', '-z', '--untracked-files=all'], path, signal),
	);
	// A folder `.gitignore` excludes whole is named once, however much it holds.
	const ignored = statusEntries(
		await gitOutput(
			['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching'],
			path,
			signal,
		),
	).filter(({ code }) => code === '!!');
	// The commits only a detached HEAD holds, which are lost with it.
	const atRisk: string[] = [];
	if (branch === undefined) {
		const listed = (
			await gitOutput(
				['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes'],
				path,
				signal,
			)
		)
			.split('\n')
			.filter(line => line !== '');
		if (!listed.every(line => /^[0-9a-f]{40,64}$/.test(line))) {
			throw new Error(
				`git could not list the commits only ${path} holds, so nothing was removed: it answered "${listed.join(' ')}".`,
			);
		}
		atRisk.push(...listed);
	}
	const files = await Promise.all(
		[...changed, ...ignored].map(async ({ code, path: file }) => {
			const stats = await lstat(join(path, file)).catch(() => undefined);
			return `${code} ${file} ${String(stats?.size)} ${String(stats?.mtimeMs)}`;
		}),
	);
	return {
		removal: {
			path,
			...(branch === undefined ? {} : { branch }),
			uncommitted: changed.length,
			ignored: ignored.length,
			commitsOnlyHere: atRisk.length,
		},
		fingerprint: JSON.stringify([head, branch ?? null, atRisk, files.sort()]),
	};
}

/**
 * The worktree of this repository at `target`, checked as removable: not the main folder, not
 * one the agent works in, and not locked. Throws a message for the model otherwise.
 */
async function removableWorktree(
	target: string,
	{ base, roots }: { base: string; roots: readonly WorkspaceRoot[] },
	signal: AbortSignal,
) {
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
	return worktree;
}

/**
 * `removeWorktree`: removes a git worktree of the repository the first root is in, its folder
 * and every file in it, never its branch, which keeps its commits. Each call is `destructive`,
 * so it is asked about, and the request names what is lost: changes no commit has, files
 * `.gitignore` excludes, and with a detached HEAD the commits no branch, tag or remote holds. It
 * refuses the repository's main folder, a worktree the agent works in, which holds one of its
 * roots or lies inside one, and a locked one.
 *
 * Once approved it claims the worktree (`FolderClaims`), so no run that may write in it starts,
 * and removes nothing while one works; it checks again that nothing it rests on changed while
 * the user was asked, and otherwise removes nothing, so the model calls it again to have the
 * user asked anew. A folder `.gitignore` excludes whole is checked as a folder, never looked
 * into, and its result tells the model so.
 */
export function createRemoveWorktreeTool({
	base,
	roots,
	stateDirectory,
}: {
	/** The real path of the first root. */
	base: string;
	roots: readonly WorkspaceRoot[];
	/** Where the histories are kept, as a real path: their runs' claims are there. */
	stateDirectory: string;
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
			const worktree = await removableWorktree(target, { base, roots }, signal);
			const { removal, fingerprint } = await inspect(target, worktree.branch, signal);
			return {
				risk: 'destructive',
				worktree: removal,
				run: async runSignal => {
					let release: () => Promise<void>;
					try {
						release = await new FolderClaims(stateDirectory).claimRemoval(target);
					} catch (error) {
						if (!(error instanceof WorkspaceBusyError)) throw error;
						throw new Error(
							`A run, or a move through a history, may write in ${target}, so nothing was removed. The harness removes no worktree a run may write in; tell the user, and try again once it ends.`,
							{ cause: error },
						);
					}
					try {
						const now = await removableWorktree(target, { base, roots }, runSignal);
						const current = await inspect(target, now.branch, runSignal);
						if (current.fingerprint !== fingerprint) {
							throw new Error(
								`${target} changed since the user was asked, so nothing was removed. Call removeWorktree again to have them asked with what it holds now.`,
							);
						}
						// Forced: what it holds unsaved is what the user approved losing.
						const removed = await git(
							['worktree', 'remove', '--force', '--', target],
							base,
							runSignal,
						);
						if (removed.exitCode !== 0) {
							throw new Error(`git could not remove ${target}: ${removed.stderr.trim()}`);
						}
					} finally {
						await release();
					}
					const done = `Removed the worktree at ${target}.`;
					const kept =
						removal.branch === undefined
							? ''
							: ` Its branch ${removal.branch} stays, with its commits.`;
					// Told to the model, which may have to mention it: an ignored folder went unchecked.
					const ignored =
						removal.ignored === 0
							? ''
							: ` It held ${String(removal.ignored)} ${removal.ignored === 1 ? 'path' : 'paths'} .gitignore excludes, removed whole without looking into them, so anything written in them while the user was asked went too.`;
					return `${done}${kept}${ignored}`;
				},
			};
		},
	});
}
