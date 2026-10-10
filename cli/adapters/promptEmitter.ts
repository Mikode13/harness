import type { IPromptEmitter } from '../promptEmitter.ts';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * The end of the input, such as Ctrl+D or the end of piped input, read as the user stopping:
 * every consumer already ends cleanly on an `AbortError`, as on Ctrl+C at an idle prompt.
 */
function inputClosed(): DOMException {
	return new DOMException('The input was closed', 'AbortError');
}

export class PromptEmitter implements IPromptEmitter {
	private readonly rl: readline.Interface;
	private closed = false;
	// A question readline never settles once its input is gone.
	private readonly pending = new Set<(error: Error) => void>();

	constructor({
		input = stdin,
		output = stdout,
	}: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}) {
		this.rl = readline.createInterface({ input, output });
		this.rl.on('close', () => {
			this.closed = true;
			for (const reject of this.pending) reject(inputClosed());
			this.pending.clear();
		});
	}

	emit(prompt: string, signal: AbortSignal): Promise<string> {
		// Asking again after the input ended throws, and would never wait for an answer.
		if (this.closed) return Promise.reject(inputClosed());
		return new Promise((resolve, reject) => {
			this.pending.add(reject);
			this.rl
				.question(prompt, { signal })
				.then(resolve, reject)
				.finally(() => this.pending.delete(reject));
		});
	}

	// Registering a 'SIGINT' listener directly on the readline instance tells
	// Node not to auto-reject a pending question() on Ctrl+C — without this,
	// readline rejects it internally before any caller-provided AbortController
	// gets a chance to decide what should happen.
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
