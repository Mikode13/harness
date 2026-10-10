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
