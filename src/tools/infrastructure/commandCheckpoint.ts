import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { sameState } from '#src/recovery/domain/fileChanges';
import type { FileState, Manifest, RunJournal } from '#src/recovery/domain/recoveryStore';

// The same bound the history uses for a file it records: a larger one is not copied.
const maxCoveredBytes = 64 * 1024 * 1024;

/**
 * Every file a command's checkpoint covers now, by its real path, absolute: what `.gitignore`
 * does not exclude in the `write` roots, less what the access policy closes to writing by name.
 */
export type CoveredFiles = (signal: AbortSignal) => Promise<string[]>;

/** A file a command changed, as the checkpoint found it. */
export interface ObservedChange {
	path: string;
	before: FileState;
	after: FileState;
}

function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/**
 * The files a command may change, captured right before it runs and compared right after, so
 * what it changed is in the run's history like any tool's change, and can be undone.
 *
 * `begin` stores the content of every covered file and a manifest of them, then records the
 * observation in the journal; if any of that fails, the command must not run. `end` lists the
 * covered files again, and records each one that differs from the manifest as a change made by
 * the command. This first version reads and hashes everything both times, trusting neither size
 * nor modification time, and keeps what that cost with the observation.
 */
export class CommandCheckpoint {
	private readonly journal: RunJournal;
	private readonly covered: CoveredFiles;
	private readonly by: string;
	private readonly manifest: Manifest;
	private readonly sequence: number;
	private readonly measure: { bytesRead: number; durationMs: number; storedBefore: number };

	private constructor(fields: {
		journal: RunJournal;
		covered: CoveredFiles;
		by: string;
		manifest: Manifest;
		sequence: number;
		measure: { bytesRead: number; durationMs: number; storedBefore: number };
	}) {
		this.journal = fields.journal;
		this.covered = fields.covered;
		this.by = fields.by;
		this.manifest = fields.manifest;
		this.sequence = fields.sequence;
		this.measure = fields.measure;
	}

	/** Captures every covered file. Cancelling it, or any failure, leaves the command unstarted. */
	static async begin({
		journal,
		covered,
		by,
		signal,
	}: {
		journal: RunJournal;
		covered: CoveredFiles;
		/** The command, as the history will name it. */
		by: string;
		signal: AbortSignal;
	}): Promise<CommandCheckpoint> {
		const started = performance.now();
		const storedBefore = journal.storedBytes;
		const files: Manifest['files'] = {};
		let bytesRead = 0;
		for (const path of await covered(signal)) {
			signal.throwIfAborted();
			const read = await readState(path);
			// A folder, a link or a file too large: no entry records it, so it is not covered.
			if (!read) continue;
			if (read.content) {
				bytesRead += read.content.length;
				const hash = await journal.saveContent(read.content);
				files[path] = { exists: true, hash, mode: read.mode };
			}
		}
		const manifest: Manifest = { files };
		const hash = await journal.saveContent(Buffer.from(JSON.stringify(manifest)));
		signal.throwIfAborted();
		const sequence = await journal.observe(hash, by);
		return new CommandCheckpoint({
			journal,
			covered,
			by,
			manifest,
			sequence,
			measure: { bytesRead, durationMs: performance.now() - started, storedBefore },
		});
	}

	/**
	 * Compares the covered files with the capture and records every change found. It is never
	 * cancelled: once the command has run, what it changed must reach the history. Unless
	 * `complete`, the observation stays open, because the command may still be changing files.
	 *
	 * @returns the changes, and the paths it could not record because they are no longer regular
	 * files it can copy, such as a file the command replaced with a folder.
	 */
	async end({ complete }: { complete: boolean }): Promise<{
		changes: ObservedChange[];
		unrecorded: string[];
	}> {
		const started = performance.now();
		const signal = new AbortController().signal;
		const paths = new Set([...Object.keys(this.manifest.files), ...(await this.covered(signal))]);
		const changes: ObservedChange[] = [];
		const unrecorded: string[] = [];
		let bytesRead = this.measure.bytesRead;

		for (const path of paths) {
			const before: FileState = this.manifest.files[path] ?? { exists: false };
			const read = await readState(path);
			if (!read) {
				unrecorded.push(path);
				continue;
			}
			let after: FileState = { exists: false };
			if (read.content) {
				bytesRead += read.content.length;
				const hash = createHash('sha256').update(read.content).digest('hex');
				after = { exists: true, hash, mode: read.mode };
			}
			if (sameState(before, after)) continue;
			// Stored only now that it changed, so an unchanged file costs no write.
			if (read.content) await this.journal.saveContent(read.content);
			const sequence = await this.journal.prepare({ path, before, after, observedBy: this.by });
			await this.journal.applied(sequence);
			changes.push({ path, before, after });
		}

		// Left open when something the command started may still be running: the record then says
		// that what it changed may not all be here.
		if (!complete) return { changes, unrecorded };
		await this.journal.observed(this.sequence, {
			files: paths.size,
			bytesRead,
			bytesStored: this.journal.storedBytes - this.measure.storedBefore,
			durationMs: Math.round(this.measure.durationMs + performance.now() - started),
		});
		return { changes, unrecorded };
	}
}

/**
 * What `path` holds: nothing, or a regular file's content and mode. `undefined` for anything an
 * entry cannot record: a folder, a link, or a file too large to copy.
 */
async function readState(path: string): Promise<{ content?: Buffer; mode: number } | undefined> {
	let stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if (code(error) === 'ENOENT') return { mode: 0 };
		throw error;
	}
	if (!stats.isFile() || stats.size > maxCoveredBytes) return undefined;
	try {
		return { content: await readFile(path), mode: stats.mode & 0o7777 };
	} catch (error) {
		// Deleted between the two calls.
		if (code(error) === 'ENOENT') return { mode: 0 };
		throw error;
	}
}
