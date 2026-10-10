import type { IPromptEmitter } from '../promptEmitter.ts';
import * as readline from 'node:readline';
import { stdin, stdout } from 'node:process';

/**
 * The end of the input, such as Ctrl+D or the end of piped input, read as the user stopping:
 * every consumer already ends cleanly on an `AbortError`, as on Ctrl+C at an idle prompt.
 */
function inputClosed(): DOMException {
	return new DOMException('The input was closed', 'AbortError');
}

/** Why a question was withdrawn: the signal's reason, which a plain `abort()` makes an `AbortError`. */
function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException('The operation was aborted', 'AbortError');
}

interface Waiting {
	resolve: (line: string) => void;
	reject: (error: Error) => void;
}

export class PromptEmitter implements IPromptEmitter {
	private readonly rl: readline.Interface;
	private closed = false;
	/**
	 * Piped lines that arrived while no question was asked, answered in order by the next ones.
	 * A terminal's are dropped instead, as before: a "y" typed during a run must never answer
	 * the approval of a destructive call asked after it. Piped input never answers an approval
	 * at all: the approver denies when nobody is at a terminal.
	 */
	private readonly lines: string[] = [];
	readonly interactive: boolean;
	private waiting: Waiting | undefined;

	constructor({
		input = stdin,
		output = stdout,
	}: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}) {
		this.rl = readline.createInterface({ input, output });
		this.interactive = (input as { isTTY?: boolean }).isTTY === true;
		this.rl.on('line', line => {
			const waiting = this.waiting;
			this.waiting = undefined;
			if (waiting) waiting.resolve(line);
			else if (!this.interactive) this.lines.push(line);
		});
		this.rl.on('close', () => {
			this.closed = true;
			const waiting = this.waiting;
			this.waiting = undefined;
			waiting?.reject(inputClosed());
		});
	}

	emit(prompt: string, signal: AbortSignal): Promise<string> {
		if (signal.aborted) return Promise.reject(abortReason(signal));
		const line = this.lines.shift();
		if (line !== undefined) return Promise.resolve(line);
		// After the lines already read: piped input that ended still answers what it holds.
		if (this.closed) return Promise.reject(inputClosed());

		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (this.waiting !== waiting) return;
				this.waiting = undefined;
				// The question is withdrawn: what was typed so far at a terminal is not an answer.
				if (this.rl.terminal) this.rl.write(null, { ctrl: true, name: 'u' });
				reject(abortReason(signal));
			};
			const waiting: Waiting = {
				resolve: answer => {
					signal.removeEventListener('abort', onAbort);
					resolve(answer);
				},
				reject: error => {
					signal.removeEventListener('abort', onAbort);
					reject(error);
				},
			};
			this.waiting = waiting;
			signal.addEventListener('abort', onAbort, { once: true });
			this.rl.setPrompt(prompt);
			this.rl.prompt();
		});
	}

	// Registering a 'SIGINT' listener on the readline instance keeps Node from closing it on
	// Ctrl+C, so the caller's AbortController decides what happens.
	onInterrupt(listener: () => void): () => void {
		this.rl.on('SIGINT', listener);
		return () => {
			this.rl.off('SIGINT', listener);
		};
	}

	close(): void {
		this.rl.close();
	}
}
