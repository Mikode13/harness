import { createHash, randomBytes } from 'node:crypto';
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	rmdir,
	stat,
	unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FileState, RunJournal } from '#src/recovery/domain/recoveryStore';
import type { ToolRisk } from '#src/agent/domain/approval';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import {
	EditRefusedError,
	EditUnconfirmedError,
	type FileChange,
	type PreparedEdit,
} from '../domain/fileEdits.ts';
import { isIgnoreFile, widensIgnoreRules } from './ignoreFileChanges.ts';
import type { WriteSession } from './writeSession.ts';

// Larger than any source file a model should rewrite whole, and small enough to keep a copy.
const defaultMaxFileBytes = 5 * 1024 * 1024;

function hashOf(content: Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

function code(error: unknown): string {
	return (error as NodeJS.ErrnoException).code ?? 'an unknown error';
}

function sameState(a: FileState, b: FileState): boolean {
	if (!a.exists || !b.exists) return a.exists === b.exists;
	return a.hash === b.hash && a.mode === b.mode;
}

async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

let newFileMode: Promise<number> | undefined;

/**
 * The mode a new file gets in this process: 0o666 less the umask. Measured once by creating
 * one, because reading the umask directly briefly changes it for every thread.
 */
function getNewFileMode(): Promise<number> {
	newFileMode ??= (async () => {
		const folder = await mkdtemp(join(tmpdir(), 'mikode-harness-mode-'));
		try {
			const probe = join(folder, 'probe');
			await (await open(probe, 'wx', 0o666)).close();
			return (await stat(probe)).mode & 0o7777;
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	})();
	return newFileMode;
}

/** The folders between the nearest existing one and `folder`, outermost first. */
async function missingFolders(folder: string): Promise<string[]> {
	const missing: string[] = [];
	for (let current = folder; ; current = dirname(current)) {
		const exists = await lstat(current).then(
			() => true,
			(error: unknown) => {
				if (code(error) === 'ENOENT') return false;
				throw error;
			},
		);
		if (exists || dirname(current) === current) return missing;
		missing.unshift(current);
	}
}

/**
 * The risk of a prepared change. A change git or the run's record can undo is `mutating`; one
 * that widens `.gitignore` is `destructive`, so it waits for the user, because it would open
 * paths that every tool keeps closed.
 */
export function editRisk(prepared: PreparedEdit): ToolRisk {
	return prepared.widensIgnoreRules ? 'destructive' : 'mutating';
}

/**
 * Makes the changes the edit tools ask for, under the access policy and the run's recovery
 * journal. `prepare` checks a change and fixes what it will do; `apply` makes it, in this order:
 *
 * 1. Check the policy again, and that the file still holds what was prepared.
 * 2. Store the content it replaces and the content it writes, and record the change as
 *    prepared. If either fails, nothing is touched.
 * 3. Write: a new file appears whole and only if nothing took its place meanwhile; a replaced
 *    one is swapped for its new version in one rename; a deleted one is unlinked.
 * 4. Record the change as applied, or as abandoned when the write failed and left the file as
 *    it was. A change the record cannot confirm stops the session and throws
 *    `EditUnconfirmedError`, never a success or a refusal.
 *
 * Every message names the file as the model wrote it, never by its place on the host.
 */
export class FileEditor {
	private readonly policy: AccessPolicy;
	private readonly session: WriteSession;
	private readonly maxFileBytes: number;

	constructor({
		policy,
		session,
		maxFileBytes = defaultMaxFileBytes,
	}: {
		policy: AccessPolicy;
		session: WriteSession;
		maxFileBytes?: number;
	}) {
		this.policy = policy;
		this.session = session;
		this.maxFileBytes = maxFileBytes;
	}

	async prepare(change: FileChange, signal: AbortSignal): Promise<PreparedEdit> {
		const { path } = change;
		const target = await this.policy.check(path, 'write', signal);
		const { state, content: previous } = await this.read(target.absolute, path);

		if (change.kind === 'create') {
			if (state.exists) {
				throw new EditRefusedError(`"${path}" already exists; read it and change it instead`);
			}
		} else {
			if (!state.exists) throw new EditRefusedError(`"${path}" does not exist`);
			if (change.expected !== undefined && change.expected !== state.hash) {
				throw new EditRefusedError(`"${path}" changed since it was read; read it again`);
			}
		}

		const content = change.kind === 'delete' ? undefined : change.content;
		if (content && content.length > this.maxFileBytes) {
			throw new EditRefusedError(
				`The new content of "${path}" is larger than ${String(this.maxFileBytes / 1024 / 1024)} MB`,
			);
		}
		if (content && state.exists && hashOf(content) === state.hash) {
			throw new EditRefusedError(`"${path}" already holds that content; nothing to change`);
		}

		// Copies all the way down: what is approved must not change while the approval waits.
		return Object.freeze({
			kind: change.kind,
			path,
			target: Object.freeze({ ...target }),
			before: Object.freeze({ ...state }),
			content: content && Buffer.from(content),
			widensIgnoreRules: isIgnoreFile(target.absolute) && widensIgnoreRules(previous, content),
		});
	}

	async apply(prepared: PreparedEdit, signal: AbortSignal): Promise<void> {
		const { path, content } = prepared;
		signal.throwIfAborted();
		const target = await this.policy.check(path, 'write', signal);
		if (target.absolute !== prepared.target.absolute) {
			throw new EditRefusedError(`"${path}" now leads somewhere else; prepare the change again`);
		}
		const current = await this.read(target.absolute, path);
		if (!sameState(current.state, prepared.before)) {
			throw new EditRefusedError(`"${path}" changed after this change was prepared; read it again`);
		}

		// Checked again before the first effect: starting the journal takes the workspace.
		signal.throwIfAborted();
		const journal = await this.session.journalForChange();
		const after = await this.record(journal, path, current.content, content, prepared.before);
		const createdFolders =
			prepared.kind === 'create' ? await missingFolders(dirname(target.absolute)) : [];
		const sequence = await this.journal(path, () =>
			journal.prepare({
				path: target.absolute,
				before: current.state,
				after,
				...(createdFolders.length > 0 ? { createdFolders } : {}),
			}),
		);

		// The last moment to stop: past here the file changes.
		if (signal.aborted) {
			await journal.abandoned(sequence);
			signal.throwIfAborted();
		}

		try {
			await this.write(prepared, target.absolute);
		} catch (error) {
			await this.settleFailedWrite({
				journal,
				sequence,
				kind: prepared.kind,
				path,
				target: target.absolute,
				current,
				after,
				createdFolders,
				error,
			});
			return;
		}

		await this.markApplied(journal, sequence, path);
	}

	/**
	 * Records a change that was made. If that fails, its prepared line still holds both states, so
	 * an undo can tell; but the record cannot be trusted to continue, and the caller must know.
	 */
	private async markApplied(journal: RunJournal, sequence: number, path: string): Promise<void> {
		try {
			await journal.applied(sequence);
		} catch (error) {
			this.session.stop('Writing stopped: the harness could not record a change it made');
			throw new EditUnconfirmedError(
				`"${path}" was changed, but the harness could not record it; writing has stopped for this run`,
				{ cause: error },
			);
		}
	}

	/** What `path` holds now. Only a regular file within the size limit can be changed. */
	private async read(
		absolute: string,
		path: string,
	): Promise<{ state: FileState; content?: Buffer }> {
		let stats;
		try {
			stats = await lstat(absolute);
		} catch (error) {
			if (code(error) === 'ENOENT') return { state: { exists: false } };
			throw new EditRefusedError(`Could not read "${path}" (${code(error)})`, { cause: error });
		}
		if (!stats.isFile()) throw new EditRefusedError(`"${path}" is not a regular file`);
		if (stats.size > this.maxFileBytes) {
			throw new EditRefusedError(
				`"${path}" is larger than ${String(this.maxFileBytes / 1024 / 1024)} MB, too large to change`,
			);
		}

		let content: Buffer;
		try {
			content = await readFile(absolute);
		} catch (error) {
			throw new EditRefusedError(`Could not read "${path}" (${code(error)})`, { cause: error });
		}
		return {
			state: { exists: true, hash: hashOf(content), mode: stats.mode & 0o7777 },
			content,
		};
	}

	/** Stores what the change replaces and what it writes, and returns the state it leaves. */
	private async record(
		journal: RunJournal,
		path: string,
		previous: Buffer | undefined,
		content: Buffer | undefined,
		before: FileState,
	): Promise<FileState> {
		if (previous) await this.journal(path, () => journal.saveContent(previous));
		if (!content) return { exists: false };

		const hash = await this.journal(path, () => journal.saveContent(content));
		return { exists: true, hash, mode: before.exists ? before.mode : await getNewFileMode() };
	}

	private async journal<Result>(path: string, step: () => Promise<Result>): Promise<Result> {
		try {
			return await step();
		} catch (error) {
			throw new EditRefusedError(
				`The harness could not record how to undo the change to "${path}", so it was not changed`,
				{ cause: error },
			);
		}
	}

	private async write({ kind, before, content }: PreparedEdit, absolute: string): Promise<void> {
		if (kind === 'delete') {
			await unlink(absolute);
			await syncDirectory(dirname(absolute));
			return;
		}

		await mkdir(dirname(absolute), { recursive: true });
		// Written beside the file, so the final step is one rename or link on the same disk.
		const temporary = join(
			dirname(absolute),
			`.${basename(absolute)}.${randomBytes(6).toString('hex')}.mikode-tmp`,
		);
		try {
			const handle = await open(temporary, 'wx');
			try {
				await handle.writeFile(content ?? Buffer.alloc(0));
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (before.exists) await chmod(temporary, before.mode);

			if (kind === 'create') {
				// A link fails if something appeared at the path meanwhile; a rename would replace it.
				await link(temporary, absolute);
			} else {
				await rename(temporary, absolute);
			}
		} finally {
			await rm(temporary, { force: true });
		}
		await syncDirectory(dirname(absolute));
	}

	/**
	 * A write threw. If the file still holds what it held, nothing happened and the change is
	 * abandoned; if it holds the new state, the change happened anyway. Anything else cannot be
	 * explained, so the session stops writing.
	 */
	private async settleFailedWrite({
		journal,
		sequence,
		kind,
		path,
		target,
		current,
		after,
		createdFolders,
		error,
	}: {
		journal: RunJournal;
		sequence: number;
		kind: PreparedEdit['kind'];
		path: string;
		target: string;
		current: { state: FileState };
		after: FileState;
		createdFolders: string[];
		error: unknown;
	}): Promise<void> {
		const now = await this.read(target, path).catch(() => undefined);
		if (now && sameState(now.state, after)) {
			await this.markApplied(journal, sequence, path);
			return;
		}
		// A link that found the path taken made no change: what is there now is someone else's.
		const appeared = kind === 'create' && code(error) === 'EEXIST';
		if (appeared || (now && sameState(now.state, current.state))) {
			// Innermost first, and only while empty: anything else in them is not this run's.
			for (const folder of [...createdFolders].reverse()) {
				await rmdir(folder).catch(() => undefined);
			}
			await journal.abandoned(sequence).catch(() => undefined);
			throw new EditRefusedError(
				appeared
					? `"${path}" appeared while it was being created; read it before changing it`
					: `Could not write "${path}" (${code(error)}); it was not changed`,
				{ cause: error },
			);
		}

		this.session.stop(
			`Writing stopped: the harness could not tell whether "${path}" was changed; ask the user to check it`,
		);
		throw new EditUnconfirmedError(
			`Could not tell whether "${path}" was changed (${code(error)}); writing has stopped for this run`,
			{ cause: error },
		);
	}
}
