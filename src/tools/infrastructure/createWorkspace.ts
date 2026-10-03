import { UnrecoverableError } from '#src/agent/domain/errors';
import { classifyHostFailure, treatErrors } from '#src/agent/domain/providerFailure';
import type { ILogger } from '#src/shared/domain/logger';
import type { Workspace } from '../domain/workspace.ts';
import { GitWorkspace } from './gitWorkspace.ts';
import { RipgrepWorkspace } from './ripgrepWorkspace.ts';
import { runProcess } from './runProcess.ts';

// Long enough for a slow disk; short enough that a hung git does not hold up building an agent.
const gitCheckTimeoutMs = 5_000;

async function loadRipgrep(): Promise<string | undefined> {
	try {
		// Dynamic: the package throws on import when the platform has no binary.
		const { rgPath } = await import('@vscode/ripgrep');
		return rgPath;
	} catch {
		return undefined;
	}
}

async function isGitWorkTree(root: string): Promise<boolean> {
	try {
		const { stdout, exitCode } = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], {
			cwd: root,
			signal: AbortSignal.timeout(gitCheckTimeoutMs),
		});
		return exitCode === 0 && stdout.trim() === 'true';
	} catch {
		// No git at all, or one that never answered.
		return false;
	}
}

/**
 * Picks how to read `root`: the ripgrep that ships with the package, or git when this platform
 * has no ripgrep binary, which is logged because it is a degraded path. Plain `grep` is never a
 * fallback: it knows nothing of `.gitignore`. See "`.gitignore` is the boundary of what an agent
 * reads" in decisions.md.
 *
 * @throws {UnrecoverableError} when neither ripgrep nor a git repository is available.
 */
export async function createWorkspace({
	root,
	logger,
}: {
	root: string;
	logger: ILogger;
}): Promise<Workspace> {
	const ripgrepPath = await loadRipgrep();
	if (ripgrepPath !== undefined) {
		return new RipgrepWorkspace({ root, ripgrepPath });
	}

	if (await isGitWorkTree(root)) {
		treatErrors(
			() => {
				logger.warn(
					'ripgrep is not available on this platform; reading the repository through git',
				);
			},
			classifyHostFailure,
			'Workspace logger failed while choosing an implementation',
		);
		return new GitWorkspace({ root });
	}

	throw new UnrecoverableError('No program can read the workspace', {
		cause: `ripgrep is not available on this platform, and ${root} is not a git repository.`,
	});
}
