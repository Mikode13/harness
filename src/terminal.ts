import * as readline from 'node:readline/promises';
import { clearLine, cursorTo } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

export interface ReadlineInput {
	question(prompt: string, signal: AbortSignal): Promise<string>;
	onInterrupt(listener: () => void): () => void;
	close(): void;
}

export interface TerminalOutput {
	clearLine(): void;
	cursorToStart(): void;
	write(text: string): void;
	log(...messages: unknown[]): void;
	error(error: unknown): void;
}

export interface LoopTerminal {
	question(prompt: string, signal: AbortSignal): Promise<string>;
	onInterrupt(listener: () => void): () => void;
	clearLine(): void;
	cursorToStart(): void;
	write(text: string): void;
	log(...messages: unknown[]): void;
	error(error: unknown): void;
	close(): void;
}

export class ReadlineTerminal implements LoopTerminal {
	constructor(
		private readonly readlineInput: ReadlineInput,
		private readonly terminalOutput: TerminalOutput,
	) {}

	question(prompt: string, signal: AbortSignal): Promise<string> {
		return this.readlineInput.question(prompt, signal);
	}

	onInterrupt(listener: () => void): () => void {
		return this.readlineInput.onInterrupt(listener);
	}

	clearLine(): void {
		this.terminalOutput.clearLine();
	}

	cursorToStart(): void {
		this.terminalOutput.cursorToStart();
	}

	write(text: string): void {
		this.terminalOutput.write(text);
	}

	log(...messages: unknown[]): void {
		this.terminalOutput.log(...messages);
	}

	error(error: unknown): void {
		this.terminalOutput.error(error);
	}

	close(): void {
		this.readlineInput.close();
	}
}

class NodeReadlineInput implements ReadlineInput {
	private readonly readlineInterface: readline.Interface;

	constructor() {
		this.readlineInterface = readline.createInterface({ input, output });
	}

	question(prompt: string, signal: AbortSignal): Promise<string> {
		return this.readlineInterface.question(prompt, { signal });
	}

	onInterrupt(listener: () => void): () => void {
		this.readlineInterface.on('SIGINT', listener);
		return () => {
			this.readlineInterface.off('SIGINT', listener);
		};
	}

	close(): void {
		this.readlineInterface.close();
	}
}

class ProcessTerminalOutput implements TerminalOutput {
	clearLine(): void {
		clearLine(output, 0);
	}

	cursorToStart(): void {
		cursorTo(output, 0);
	}

	write(text: string): void {
		process.stdout.write(text);
	}

	log(...messages: unknown[]): void {
		console.log(...messages);
	}

	error(error: unknown): void {
		console.error(error);
	}
}

export function createReadlineTerminal(): LoopTerminal {
	return new ReadlineTerminal(new NodeReadlineInput(), new ProcessTerminalOutput());
}
