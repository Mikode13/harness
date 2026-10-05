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
	/** The editor's own copy, taken in `prepare`: changing the caller's buffer later changes nothing. */
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

/**
 * A change the file may hold but the run's record does not confirm, worded for the model: it was
 * made and could not be recorded as made, or whether it was made cannot be told. The record keeps
 * the change as prepared, so an undo can still check the file, and writing stops for the run.
 */
export class EditUnconfirmedError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EditUnconfirmedError';
	}
}
