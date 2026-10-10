import type { AccessPolicy } from '../domain/accessPolicy.ts';
import type { TextMatch, Workspace } from '../domain/workspace.ts';

/**
 * The read `Workspace` with the access policy's word on every path it returns: a secret the
 * policy closes is neither listed, nor searched, nor read, even where `.gitignore` lets it
 * through. What it leaves out is not counted either, so `total` never reveals it.
 */
export class PolicyWorkspace implements Workspace {
	private readonly inner: Workspace;
	private readonly policy: AccessPolicy;

	constructor({ inner, policy }: { inner: Workspace; policy: AccessPolicy }) {
		this.inner = inner;
		this.policy = policy;
	}

	async listFiles(
		query: { path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ files: string[]; total: number; truncated: boolean }> {
		const { files, total, truncated } = await this.inner.listFiles(query, signal);
		const open = await this.readable(files, file => file, signal);
		return { files: open, total: total - (files.length - open.length), truncated };
	}

	async searchText(
		query: { pattern: string; ignoreCase: boolean; path?: string; glob?: string; limit: number },
		signal: AbortSignal,
	): Promise<{ matches: TextMatch[]; total: number; truncated: boolean }> {
		const { matches, total, truncated } = await this.inner.searchText(query, signal);
		const open = await this.readable(matches, match => match.path, signal);
		return { matches: open, total: total - (matches.length - open.length), truncated };
	}

	async readFile(
		query: { path: string; fromLine: number; lineCount: number },
		signal: AbortSignal,
	): Promise<{ lines: string[]; totalLines: number; truncated: boolean }> {
		await this.policy.check(query.path, 'read', signal);
		return this.inner.readFile(query, signal);
	}

	/** The items whose path the policy lets this agent read. */
	private async readable<Item>(
		items: Item[],
		pathOf: (item: Item) => string,
		signal: AbortSignal,
	): Promise<Item[]> {
		const verdicts = new Map<string, boolean>();
		const open: Item[] = [];
		for (const item of items) {
			const path = pathOf(item);
			let allowed = verdicts.get(path);
			if (allowed === undefined) {
				allowed = await this.policy.check(path, 'read', signal).then(
					() => true,
					() => false,
				);
				verdicts.set(path, allowed);
			}
			if (allowed) open.push(item);
		}
		return open;
	}
}
