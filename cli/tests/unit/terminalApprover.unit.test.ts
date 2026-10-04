import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../../src/index.ts';
import { createTerminalApprover } from '../../terminalApprover.ts';

const signal = new AbortController().signal;
const request: ApprovalRequest = { tool: 'delete', input: { path: 'a.txt' }, risk: 'destructive' };

function answering(...answers: string[]) {
	return {
		emit: vi.fn(() => {
			const answer = answers.shift();
			return answer === undefined
				? Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
				: Promise.resolve(answer);
		}),
		close: vi.fn(),
	};
}

const output = () => ({ print: vi.fn(), printError: vi.fn() });

describe('createTerminalApprover', () => {
	it('shows the call before asking', async () => {
		const printed = output();

		await createTerminalApprover(answering('y'), printed)(request, signal);

		expect(printed.print).toHaveBeenCalledWith(
			'The agent wants to run "delete", which is destructive:',
		);
		expect(printed.print).toHaveBeenCalledWith(JSON.stringify({ path: 'a.txt' }, null, 2));
	});

	it.each([
		['y', { approved: true }],
		['YES', { approved: true }],
		['a', { approved: true, remember: true }],
		[' always ', { approved: true, remember: true }],
	])('reads %j as %j', async (answer, decision) => {
		await expect(
			createTerminalApprover(answering(answer), output())(request, signal),
		).resolves.toEqual(decision);
	});

	it('asks why on a no, and passes the reason on', async () => {
		const prompts = answering('n', 'rename it instead');

		await expect(createTerminalApprover(prompts, output())(request, signal)).resolves.toEqual({
			approved: false,
			reason: 'rename it instead',
		});
		expect(prompts.emit).toHaveBeenLastCalledWith('Why not? (optional): ', signal);
	});

	it('denies without a reason when the user gives none', async () => {
		await expect(
			createTerminalApprover(answering('no', '  '), output())(request, signal),
		).resolves.toEqual({ approved: false });
	});

	it('asks again until the answer is one it knows', async () => {
		const prompts = answering('maybe', '', 'y');

		await expect(createTerminalApprover(prompts, output())(request, signal)).resolves.toEqual({
			approved: true,
		});
		expect(prompts.emit).toHaveBeenCalledTimes(3);
	});

	it('lets a cancellation while asking through', async () => {
		await expect(
			createTerminalApprover(answering(), output())(request, signal),
		).rejects.toHaveProperty('name', 'AbortError');
	});
});
