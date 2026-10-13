import { describe, expect, it, vi } from 'vitest';
import type { UserQuestion } from '../../../src/index.ts';
import { createTerminalAsker, nobodyToAnswer } from '../../terminalAsker.ts';

const signal = new AbortController().signal;

const question = (multiSelect: boolean): UserQuestion => ({
	question: 'Which roles?',
	options: [
		{ label: 'Planner', description: 'Plans.' },
		{ label: 'Executor', description: 'Changes files.' },
		{ label: 'Reviewer', description: 'Reviews.' },
	],
	multiSelect,
});

function answering(...answers: string[]) {
	return {
		interactive: true,
		emit: vi.fn(() => Promise.resolve(answers.shift() ?? '')),
		close: vi.fn(),
	};
}

const output = () => ({ print: vi.fn(), printError: vi.fn() });

describe('createTerminalAsker', () => {
	it('shows each question with numbered options, and answers with the chosen label', async () => {
		const printed = output();

		await expect(
			createTerminalAsker(answering('2'), printed)([question(false)], signal),
		).resolves.toEqual(['Executor']);
		expect(printed.print).toHaveBeenCalledWith('  2. Executor: Changes files.');
	});

	it('takes several numbers where the question allows it, and only there', async () => {
		await expect(
			createTerminalAsker(answering('1, 3', '1, 3'), output())(
				[question(true), question(false)],
				signal,
			),
		).resolves.toEqual(['Planner, Reviewer', '1, 3']);
	});

	it("keeps the user's own words, a number with no option included, and skips empty lines", async () => {
		const prompts = answering('', 'neither, ask me later', '7');

		await expect(
			createTerminalAsker(prompts, output())([question(false), question(false)], signal),
		).resolves.toEqual(['neither, ask me later', '7']);
		expect(prompts.emit).toHaveBeenCalledTimes(3);
	});

	it('reads nothing when nobody is at a terminal, and tells the model to decide', async () => {
		const piped = { ...answering('1'), interactive: false };

		await expect(createTerminalAsker(piped, output())([question(false)], signal)).resolves.toEqual([
			nobodyToAnswer,
		]);
		expect(piped.emit).not.toHaveBeenCalled();
	});
});
