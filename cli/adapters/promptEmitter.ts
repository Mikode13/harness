import type { IPromptEmitter } from '../promptEmitter.ts';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export class PromptEmitter implements IPromptEmitter {
	private readonly rl: readline.Interface;

	constructor() {
		this.rl = readline.createInterface({ input, output });
	}

	emit(prompt: string, signal: AbortSignal): Promise<string> {
		return this.rl.question(prompt, { signal });
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
