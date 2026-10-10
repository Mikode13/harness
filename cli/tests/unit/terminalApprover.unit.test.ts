import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../../src/index.ts';
import { PassThrough } from 'node:stream';
import { PromptEmitter } from '../../adapters/promptEmitter.ts';
import { createTerminalApprover } from '../../terminalApprover.ts';

const signal = new AbortController().signal;
const request: ApprovalRequest = { tool: 'delete', input: { path: 'a.txt' }, risk: 'destructive' };

function answering(...answers: string[]) {
	return {
		interactive: true,
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
	it('never approves from a piped line meant for a later question', async () => {
		const input = new PassThrough();
		const prompts = new PromptEmitter({ input, output: new PassThrough() });
		// A script's answer to the confirmation of a later /undo.
		input.end('tidy up the repo\n/undo\ny\n');
		await new Promise(resolve => setImmediate(resolve));
		await prompts.emit('> ', signal);

		await expect(createTerminalApprover(prompts, output())(request, signal)).resolves.toMatchObject(
			{
				approved: false,
			},
		);
		await expect(prompts.emit('> ', signal)).resolves.toBe('/undo');
		await expect(prompts.emit('Go ahead? [y/N]: ', signal)).resolves.toBe('y');
	});

	it('denies without asking when nobody is at a terminal, so piped lines never approve', async () => {
		const printed = output();
		const piped = { ...answering('y'), interactive: false };

		await expect(createTerminalApprover(piped, printed)(request, signal)).resolves.toEqual({
			approved: false,
			reason: 'Nobody was at a terminal to approve it',
		});
		expect(piped.emit).not.toHaveBeenCalled();
		expect(printed.print).toHaveBeenCalledWith('Denied: nobody is at a terminal to approve it.');
	});

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
