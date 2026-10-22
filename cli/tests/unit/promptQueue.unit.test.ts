import { describe, expect, it, vi } from 'vitest';
import { createPromptQueue } from '../../promptQueue.ts';

const signal = new AbortController().signal;

describe('createPromptQueue', () => {
	it('asks one prompt at a time, in the order they came, across every queued prompt', async () => {
		const queued = createPromptQueue();
		const asked: string[] = [];
		let answerFirst!: (answer: string) => void;
		const approve = queued((request: string) => {
			asked.push(request);
			return request === 'first'
				? new Promise<string>(resolve => {
						answerFirst = resolve;
					})
				: `${request} answered`;
		});
		const ask = queued((questions: string[]) => {
			asked.push(questions.join());
			return Promise.resolve(questions.map(question => `${question}?`));
		});

		const first = approve('first', signal);
		const second = ask(['which'], signal);
		const third = approve('third', signal);
		await vi.waitFor(() => {
			expect(asked).toEqual(['first']);
		});
		answerFirst('yes');

		await expect(Promise.all([first, second, third])).resolves.toEqual([
			'yes',
			['which?'],
			'third answered',
		]);
		expect(asked).toEqual(['first', 'which', 'third']);
	});

	it('never asks a prompt cancelled while it waits, and asks the ones after it', async () => {
		const queued = createPromptQueue();
		const asked: string[] = [];
		let answerFirst!: () => void;
		const prompt = queued((request: string) => {
			asked.push(request);
			return request === 'first'
				? new Promise<string>(resolve => {
						answerFirst = () => {
							resolve('done');
						};
					})
				: 'done';
		});
		const controller = new AbortController();

		const first = prompt('first', signal);
		const cancelled = prompt('cancelled', controller.signal);
		const last = prompt('last', signal);
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
		answerFirst();
		await Promise.all([first, last]);

		expect(asked).toEqual(['first', 'last']);
	});
});
