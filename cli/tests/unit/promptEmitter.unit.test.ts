import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PromptEmitter } from '../../adapters/promptEmitter.ts';
import { isAbortError } from '../../../src/index.ts';

const signal = new AbortController().signal;

function emitter() {
	const input = new PassThrough();
	return { input, prompts: new PromptEmitter({ input, output: new PassThrough() }) };
}

describe('PromptEmitter', () => {
	it('answers a question with the line typed', async () => {
		const { input, prompts } = emitter();
		const answer = prompts.emit('> ', signal);

		input.write('hello\n');

		await expect(answer).resolves.toBe('hello');
		prompts.close();
	});

	it('answers later questions with the piped lines that arrived before them, then stops', async () => {
		const { input, prompts } = emitter();
		input.end('/history\n/undo\n');
		// Let readline read it all while no question is asked.
		await new Promise(resolve => setImmediate(resolve));

		await expect(prompts.emit('> ', signal)).resolves.toBe('/history');
		await expect(prompts.emit('> ', signal)).resolves.toBe('/undo');
		await expect(prompts.emit('> ', signal)).rejects.toSatisfy(isAbortError);
	});

	it('says whether a person answers at a terminal', () => {
		const piped = emitter().prompts;
		const terminal = new PromptEmitter({
			input: Object.assign(new PassThrough(), { isTTY: true }),
			output: new PassThrough(),
		});

		expect([piped.interactive, terminal.interactive]).toEqual([false, true]);
		piped.close();
		terminal.close();
	});

	it('drops what a terminal typed while no question was asked', async () => {
		const input = Object.assign(new PassThrough(), { isTTY: true });
		const prompts = new PromptEmitter({ input, output: new PassThrough() });
		input.write('y\n');
		await new Promise(resolve => setImmediate(resolve));

		const answer = prompts.emit('Allow it? ', signal);
		input.write('n\n');

		await expect(answer).resolves.toBe('n');
		prompts.close();
	});

	it('withdraws a question when its signal aborts, and keeps answering later ones', async () => {
		const { input, prompts } = emitter();
		const controller = new AbortController();
		const withdrawn = prompts.emit('> ', controller.signal);

		controller.abort();
		await expect(withdrawn).rejects.toSatisfy(isAbortError);
		const next = prompts.emit('> ', signal);
		input.write('hello\n');

		await expect(next).resolves.toBe('hello');
		prompts.close();
	});

	it('stops the question it is asking when the input ends, as the user stopping', async () => {
		const { input, prompts } = emitter();
		const answer = prompts.emit('> ', signal);

		input.end();

		await expect(answer).rejects.toSatisfy(isAbortError);
	});

	it('stops every question asked after the input ended', async () => {
		const { input, prompts } = emitter();
		input.end();
		await expect(prompts.emit('> ', signal)).rejects.toSatisfy(isAbortError);

		await expect(prompts.emit('> ', signal)).rejects.toSatisfy(isAbortError);
	});
});
