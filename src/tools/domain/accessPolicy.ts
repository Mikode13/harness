export type Access = 'read' | 'write';

/** A folder the agent may reach, and what it may do inside it. */
export interface WorkspaceRoot {
	path: string;
	access: Access;
}

/** A path the policy allowed, and where it really is. */
export interface AllowedPath {
	/** Every symlink resolved: the one place to read or write, whatever the model called it. */
	absolute: string;
	/** The real path of the root that holds it. */
	root: string;
	/** Relative to that root, written with `/`. */
	relative: string;
}

/**
 * Why a path was refused, worded for the model. It names the path only as the model wrote it,
 * never a path of the host: a host path in an error sends the model looking for it.
 */
export class AccessDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AccessDeniedError';
	}
}

/**
 * Decides whether an agent may read or write a path, for every tool that touches files. A
 * path the model sends is relative to the first root, or absolute.
 */
export interface AccessPolicy {
	/** @throws {AccessDeniedError} when the path may not be accessed this way. */
	check(path: string, access: Access, signal: AbortSignal): Promise<AllowedPath>;
}
