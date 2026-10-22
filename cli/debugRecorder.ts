import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProgressEvent, Transcript } from '../src/index.ts';

// What the model read and what the commands printed: for this user's eyes only.
const privateFolder = 0o700;
const privateFile = 0o600;

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
		mkdirSync(this.folder, { recursive: true, mode: privateFolder });
		this.events = join(this.folder, 'events.jsonl');
		appendFileSync(this.events, '', { mode: privateFile });
	}

	event(event: ProgressEvent): void {
		this.write(() => {
			appendFileSync(
				this.events,
				`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
				{ mode: privateFile },
			);
		});
	}

	transcript(transcript: Transcript): void {
		this.transcripts++;
		// A delegated agent by the tool that delegated to it; the file holds the call it served.
		const agent = transcript.agent ?? transcript.delegation?.tool ?? 'agent';
		const name = `${String(this.transcripts).padStart(3, '0')}-${agent}-${transcript.outcome}.json`;
		this.write(() => {
			writeFileSync(join(this.folder, name), `${JSON.stringify(transcript, null, '\t')}\n`, {
				mode: privateFile,
			});
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
