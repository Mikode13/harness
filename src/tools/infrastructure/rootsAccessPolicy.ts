import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import {
	type Access,
	AccessDeniedError,
	type AccessPolicy,
	type AllowedPath,
	type WorkspaceRoot,
} from '../domain/accessPolicy.ts';
import type { IgnoreRules } from './gitIgnoreRules.ts';
import { isSecretPath } from './secretPaths.ts';

/** The host's changes to the default secrets list. */
export interface SecretRules {
	/** More files or folders to treat as secrets: absolute, `~/…`, or relative to the first root. */
	protect?: string[];
	/** Exact files the defaults would refuse that the host opens, for reading or also writing. */
	allow?: { path: string; access: Access }[];
}

/** `path` relative to `folder`, or undefined when it is not inside it. */
function within(folder: string, path: string): string | undefined {
	const below = relative(folder, path);
	if (below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return undefined;
	return below;
}

/** The same test without case, for names a case-insensitive disk would treat as one. */
function withinIgnoringCase(folder: string, path: string): boolean {
	return within(folder.toLowerCase(), path.toLowerCase()) !== undefined;
}

/** Whether `path` goes through git's metadata: `.git` as a folder or a worktree's pointer file. */
function hasGitPart(path: string): boolean {
	return path.split(sep).some(part => part.toLowerCase() === '.git');
}

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/**
 * The access policy over the roots a host declared. A path is refused unless every step
 * allows it, in this order:
 *
 * 1. Its real location, every symlink resolved, is inside a root. A symlink is followed, never
 *    refused for being one: what counts is where it leads.
 * 2. That root allows the access: a `read` root refuses a write.
 * 3. It is not protected: git's own files, and the host's protected paths such as the
 *    recovery store, whatever the model calls them.
 * 4. It is not a secret, by the default list and the host's `protect`.
 * 5. `.gitignore` does not exclude it, whether or not it exists yet, nor any symlink it goes
 *    through: git sees a link as an entry of its own, so an ignored link stays closed even when
 *    it leads somewhere that is not ignored.
 *
 * A file the host's `allow` names exactly skips steps 4 and 5: a `.env` is usually both a
 * secret and ignored, and an opening that `.gitignore` still blocked would open nothing.
 * Nothing opens what step 3 protects.
 *
 * The real location is what the caller reads or writes, so a symlink cannot be swapped for
 * another between the check and the access without a second check. That window is the
 * caller's to close; this policy holds for a host that does not race its own agent.
 */
export class RootsAccessPolicy implements AccessPolicy {
	private readonly roots: WorkspaceRoot[];
	private readonly protectedPaths: string[];
	private readonly secretFolders: string[];
	private readonly allowed: { path: string; access: Access }[];
	private readonly ignoreRules: IgnoreRules;
	private readonly home: string;

	private constructor(options: {
		roots: WorkspaceRoot[];
		protectedPaths: string[];
		secretFolders: string[];
		allowed: { path: string; access: Access }[];
		ignoreRules: IgnoreRules;
		home: string;
	}) {
		this.roots = options.roots;
		this.protectedPaths = options.protectedPaths;
		this.secretFolders = options.secretFolders;
		this.allowed = options.allowed;
		this.ignoreRules = options.ignoreRules;
		this.home = options.home;
	}

	/**
	 * @throws {InvalidAgentConfigError} when there is no root, or one is not an existing folder
	 *   or is inside git's metadata, which nothing opens.
	 */
	static async create({
		roots,
		protectedPaths = [],
		secrets = {},
		ignoreRules,
		home = homedir(),
	}: {
		roots: WorkspaceRoot[];
		/** Paths no tool may reach, such as the recovery store and the host's configuration. */
		protectedPaths?: string[];
		secrets?: SecretRules;
		ignoreRules: IgnoreRules;
		home?: string;
	}): Promise<RootsAccessPolicy> {
		const [first] = roots;
		if (!first) throw new InvalidAgentConfigError('A workspace needs at least one root');

		const realRoots = await Promise.all(
			roots.map(async root => {
				const real = await realpath(root.path).catch(() => undefined);
				const isFolder = real !== undefined && (await stat(real)).isDirectory();
				if (!isFolder) {
					throw new InvalidAgentConfigError(
						`Workspace root ${root.path} is not an existing folder`,
					);
				}
				// Protection looks for `.git` below a root, so a root inside it would open it.
				if (hasGitPart(resolve(root.path)) || hasGitPart(real)) {
					throw new InvalidAgentConfigError(
						`Workspace root ${root.path} is inside git's metadata, which no tool may reach`,
					);
				}
				return { path: real, access: root.access };
			}),
		);
		const base = realRoots[0]?.path ?? first.path;
		// A host path may start with `~/`, or be relative to the first root.
		const hostPath = async (path: string) => {
			const absolute = path.startsWith('~/') ? join(home, path.slice(2)) : resolve(base, path);
			// Resolved when it exists, so a protected folder behind a symlink is still found.
			return realpath(absolute).catch(() => absolute);
		};

		return new RootsAccessPolicy({
			roots: realRoots,
			protectedPaths: await Promise.all(protectedPaths.map(hostPath)),
			secretFolders: await Promise.all((secrets.protect ?? []).map(hostPath)),
			allowed: await Promise.all(
				(secrets.allow ?? []).map(async ({ path, access }) => ({
					path: await hostPath(path),
					access,
				})),
			),
			ignoreRules,
			home,
		});
	}

	async check(path: string, access: Access, signal: AbortSignal): Promise<AllowedPath> {
		if (path === '' || path.includes('\0')) {
			throw new AccessDeniedError(`"${path}" is not a valid path`);
		}
		const named = resolve(this.base, path);
		const absolute = await this.realLocation(named, path);

		const root = this.rootOf(absolute);
		if (!root) throw new AccessDeniedError(`"${path}" is outside the workspace`);
		if (access === 'write' && root.access === 'read') {
			throw new AccessDeniedError(`"${path}" is in a read-only folder of the workspace`);
		}

		const relativePath = (within(root.path, absolute) ?? '').split(sep).join('/');
		if (this.isProtected(named, absolute)) {
			throw new AccessDeniedError(`"${path}" is protected by the harness`);
		}
		if (this.isOpened(absolute, access)) {
			return { absolute, root: root.path, relative: relativePath };
		}
		if (this.isSecret(named, absolute)) {
			throw new AccessDeniedError(
				`"${path}" may hold secrets, so the harness keeps it closed; ask the user to allow it in the configuration if it is needed`,
			);
		}
		for (const location of [...(await this.linksAlong(named)), absolute]) {
			if (await this.isIgnored(location, signal)) {
				throw new AccessDeniedError(`"${path}" is excluded by .gitignore`);
			}
		}

		return { absolute, root: root.path, relative: relativePath };
	}

	private get base(): string {
		return this.roots[0]?.path ?? '';
	}

	/**
	 * Where `named` really is. For a path that does not exist yet, that is its nearest existing
	 * folder, resolved, plus the missing names. A link that leads nowhere is refused: writing to
	 * it would create whatever it points at, wherever that is.
	 */
	private async realLocation(named: string, shown: string): Promise<string> {
		const missing: string[] = [];
		let existing = named;
		for (;;) {
			try {
				return join(await realpath(existing), ...missing);
			} catch (error) {
				if (code(error) === 'ENOTDIR') {
					throw new AccessDeniedError(`"${shown}" treats a file as a folder`);
				}
				if (code(error) !== 'ENOENT') throw error;
			}
			const isLink = await lstat(existing).then(
				stats => stats.isSymbolicLink(),
				() => false,
			);
			if (isLink) throw new AccessDeniedError(`"${shown}" is a link to nothing`);

			const parent = dirname(existing);
			// The filesystem root always exists, so this never runs out.
			missing.unshift(basename(existing));
			existing = parent;
		}
	}

	/**
	 * Every symlink `named` goes through on the way to its real location, each at its own real
	 * place. git answers for a link but not for a path beyond one, so each is checked alone.
	 */
	private async linksAlong(named: string): Promise<string[]> {
		const links: string[] = [];
		let pending = named.split(sep).filter(part => part !== '');
		let current: string = sep;
		// `realLocation` already refused a loop; the bound only keeps this walk finite.
		for (let hops = 0; pending.length > 0 && hops < 40;) {
			const [name = '', ...rest] = pending;
			const next = join(current, name);
			const stats = await lstat(next).catch(() => undefined);
			// Missing from here on: nothing below can be a link.
			if (!stats) break;
			if (stats.isSymbolicLink()) {
				hops++;
				links.push(join(await realpath(current), name));
				const target = resolve(current, await readlink(next));
				pending = [...target.split(sep).filter(part => part !== ''), ...rest];
				current = sep;
			} else {
				current = next;
				pending = rest;
			}
		}
		return links;
	}

	/** Whether `.gitignore` excludes a real location, by the root that holds it. */
	private async isIgnored(location: string, signal: AbortSignal): Promise<boolean> {
		const root = this.rootOf(location);
		const below = root && within(root.path, location);
		// A root itself, or a link outside every root, has no rule to answer to.
		if (!root || !below) return false;
		return this.ignoreRules.isIgnored(root.path, below.split(sep).join('/'), signal);
	}

	/** The most specific root holding `absolute`, so a folder nested in another has its own say. */
	private rootOf(absolute: string): WorkspaceRoot | undefined {
		return this.roots
			.filter(root => within(root.path, absolute) !== undefined)
			.sort((a, b) => b.path.length - a.path.length)[0];
	}

	private isProtected(named: string, absolute: string): boolean {
		// `.git` as a folder or as a worktree's pointer file, under any name the model used.
		const isGitMetadata = (path: string) => {
			const root = this.rootOf(path);
			if (!root) return false;
			return hasGitPart(within(root.path, path) ?? '');
		};

		return (
			isGitMetadata(named) ||
			isGitMetadata(absolute) ||
			this.protectedPaths.some(
				folder => withinIgnoringCase(folder, named) || withinIgnoringCase(folder, absolute),
			)
		);
	}

	/** Whether the host's `allow` names this exact file for this access; `write` covers reading. */
	private isOpened(absolute: string, access: Access): boolean {
		return this.allowed.some(
			allowed =>
				// Exact: both are real paths in the disk's own case, and on a case-sensitive disk
				// `.ENV` is a different file from the `.env` the host opened.
				allowed.path === absolute && (allowed.access === 'write' || access === 'read'),
		);
	}

	private isSecret(named: string, absolute: string): boolean {
		return [named, absolute].some(
			path =>
				isSecretPath(path, this.home) ||
				this.secretFolders.some(folder => withinIgnoringCase(folder, path)),
		);
	}
}
