import type { FileState } from '#src/recovery/domain/recoveryStore';
import type { AllowedPath } from './accessPolicy.ts';

/**
 * One change to one file, with the path as the model wrote it. Each edit format, such as a
 * patch or a text replacement, works out the whole new content and asks for one of these.
 *
 * `expected` is the hash of the content the change was worked out from. It is refused if the
 * file no longer holds it, so a change is never applied to a version nobody looked at.
 */
export type FileChange =
	| { kind: 'create'; path: string; content: Buffer }
	| { kind: 'replace'; path: string; content: Buffer; expected?: string }
	| { kind: 'delete'; path: string; expected?: string };

/**
 * A change checked and ready to apply, and the only thing that can be applied: what is
 * approved is exactly what is written. It is applied only if the file still holds `before`.
 */
export interface PreparedEdit {
	readonly kind: FileChange['kind'];
	/** As the model wrote it, for every message about it. */
	readonly path: string;
	readonly target: AllowedPath;
	readonly before: FileState;
	readonly content: Buffer | undefined;
	/**
	 * The change can make `.gitignore` hide less, which would open paths to every tool. It
	 * takes effect only if the user allows it: a tool asks for it as `destructive`.
	 */
	readonly widensIgnoreRules: boolean;
}

/**
 * Why a change was not made, worded for the model. Nothing was written: the file is as it was.
 */
export class EditRefusedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EditRefusedError';
	}
}
