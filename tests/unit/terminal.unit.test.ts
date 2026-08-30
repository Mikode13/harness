import { describe, expect, it, vi } from 'vitest';
import { ReadlineTerminal, type ReadlineInput, type TerminalOutput } from '../../src/terminal.ts';

function createCollaborators() {
	const listeners = new Set<() => void>();
	const question = vi.fn(() => Promise.resolve('answer'));
	const onInterrupt = vi.fn((listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	});
	const closeInput = vi.fn();
	const readlineInput: ReadlineInput = { question, onInterrupt, close: closeInput };

	const clearLine = vi.fn();
	const cursorToStart = vi.fn();
	const write = vi.fn();
	const log = vi.fn();
	const error = vi.fn();
	const terminalOutput: TerminalOutput = { clearLine, cursorToStart, write, log, error };

	return {
		closeInput,
		cursorToStart,
		error,
		listeners,
		clearLine,
		log,
		onInterrupt,
		question,
		terminal: new ReadlineTerminal(readlineInput, terminalOutput),
		write,
	};
}

describe('ReadlineTerminal', () => {
	it('forwards questions with their abort signal', async () => {
		const { question, terminal } = createCollaborators();
		const signal = new AbortController().signal;

		await expect(terminal.question('> ', signal)).resolves.toBe('answer');

		expect(question).toHaveBeenCalledWith('> ', signal);
	});

	it('delivers interrupt events to every active subscription', () => {
		const { listeners, onInterrupt, terminal } = createCollaborators();
		const firstListener = vi.fn();
		const secondListener = vi.fn();

		const removeFirst = terminal.onInterrupt(firstListener);
		terminal.onInterrupt(secondListener);
		for (const listener of listeners) listener();

		expect(onInterrupt).toHaveBeenCalledTimes(2);
		expect(firstListener).toHaveBeenCalledOnce();
		expect(secondListener).toHaveBeenCalledOnce();

		removeFirst();
		for (const listener of listeners) listener();

		expect(firstListener).toHaveBeenCalledOnce();
		expect(secondListener).toHaveBeenCalledTimes(2);
	});

	it('delegates output and close operations to its collaborators', () => {
		const { clearLine, closeInput, cursorToStart, error, log, terminal, write } =
			createCollaborators();
		const failure = new Error('terminal failure');

		terminal.clearLine();
		terminal.cursorToStart();
		terminal.write('spinner');
		terminal.log('message');
		terminal.error(failure);
		terminal.close();

		expect(clearLine).toHaveBeenCalledOnce();
		expect(cursorToStart).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith('spinner');
		expect(log).toHaveBeenCalledWith('message');
		expect(error).toHaveBeenCalledWith(failure);
		expect(closeInput).toHaveBeenCalledOnce();
	});
});
