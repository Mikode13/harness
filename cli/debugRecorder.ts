import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent, Transcript } from '../src/index.ts';

/**
 * Keeps what a session did, for finding out why it went wrong: every progress event, in
 * `events.jsonl`, and the transcript of every run of every agent, one file each, in order. Each
 * session gets its own folder, named by when it started, under the one given.
 */
export class DebugRecorder {
	readonly folder: string;
	private readonly events: string;
	private readonly reportFailure: (error: Error) => void;
	private transcripts = 0;
	private recording = true;

	/** Creates the folder now, so one that cannot be written fails before any call is billed. */
	constructor(parent: string, reportFailure: (error: Error) => void, startedAt = new Date()) {
		this.reportFailure = reportFailure;
		this.folder = join(parent, startedAt.toISOString().replaceAll(':', '-'));
		mkdirSync(this.folder, { recursive: true });
		this.events = join(this.folder, 'events.jsonl');
		appendFileSync(this.events, '');
	}

	event(event: ProgressEvent): void {
		this.write(() => {
			appendFileSync(
				this.events,
				`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
			);
		});
	}

	transcript(transcript: Transcript): void {
		this.transcripts++;
		const name = `${String(this.transcripts).padStart(3, '0')}-${transcript.agent ?? 'agent'}-${transcript.outcome}.json`;
		this.write(() => {
			writeFileSync(join(this.folder, name), `${JSON.stringify(transcript, null, '\t')}\n`);
		});
	}

	// Debugging must never end the run it watches: say so once, and stop recording.
	private write(action: () => void): void {
		if (!this.recording) return;
		try {
			action();
		} catch (error) {
			this.recording = false;
			this.reportFailure(
				new Error(`Could not write to ${this.folder}; nothing more is recorded for debugging`, {
					cause: error,
				}),
			);
		}
	}
}
