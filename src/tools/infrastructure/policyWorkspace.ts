import type { AccessPolicy } from '../domain/accessPolicy.ts';
import type { TextMatch, Workspace } from '../domain/workspace.ts';

/**
 * The read `Workspace` of the file tools, under their access policy.
 *
 * `listFiles` and `searchText` rely on the workspace beneath, which is built with the policy's
 * `hidesFromReading` as its `hidden` filter. That filter leaves out a protected file, or a secret
 * the host did not open, before anything is counted or stored, so no page, total, limit or error
 * can tell that one matched. Its candidates are already free of what `.gitignore` excludes, are
 * inside the root, and are never reached through a link: the program that lists them does not
 * follow links, and links are not regular files. Running the whole policy on every path a
 * listing returns would add nothing for these paths, and would cost one `git check-ignore` each.
 *
 * `readFile` is given a path by the model, which can be anything, so the whole policy decides it.
 */
export class PolicyWorkspace implements Workspace {
	private readonly inner: Workspace;
	private readonly policy: AccessPolicy;

	constructor({ inner, policy }: { inner: Workspace; policy: AccessPolicy }) {
		this.inner = inner;
		this.policy = policy;
	}

	listFiles(
		query: { path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ files: string[]; total: number; truncated: boolean }> {
		return this.inner.listFiles(query, signal);
	}

	searchText(
		query: { pattern: string; ignoreCase: boolean; path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ matches: TextMatch[]; total: number; truncated: boolean }> {
		return this.inner.searchText(query, signal);
	}

	async readFile(
		query: { path: string; fromLine: number; lineCount: number },
		signal: AbortSignal,
	): Promise<{ lines: string[]; totalLines: number; truncated: boolean }> {
		await this.policy.check(query.path, 'read', signal);
		return this.inner.readFile(query, signal);
	}
}
