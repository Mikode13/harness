import { describe, expect, it, vi } from 'vitest';
import {
	rememberApprovals,
	type ApprovalRequest,
	type RememberableDecision,
} from '../../src/agent/domain/approval.ts';

const signal = new AbortController().signal;
const request = (tool: string, input: unknown = {}): ApprovalRequest => ({
	tool,
	input,
	risk: 'destructive',
});

describe('rememberApprovals', () => {
	it('asks about every call the user allowed only once', async () => {
		const ask = vi.fn((): RememberableDecision => ({ approved: true }));
		const approve = rememberApprovals(ask);

		await expect(approve(request('delete'), signal)).resolves.toEqual({ approved: true });
		await expect(approve(request('delete'), signal)).resolves.toEqual({ approved: true });

		expect(ask).toHaveBeenCalledTimes(2);
		expect(ask).toHaveBeenCalledWith(request('delete'), signal);
	});

	it('stops asking about a tool the user allowed with remember', async () => {
		const ask = vi.fn((): RememberableDecision => ({ approved: true, remember: true }));
		const approve = rememberApprovals(ask);

		await approve(request('delete'), signal);
		await expect(approve(request('delete', { path: 'other' }), signal)).resolves.toEqual({
			approved: true,
		});

		expect(ask).toHaveBeenCalledOnce();
	});

	it('still asks about other tools', async () => {
		const ask = vi.fn((): RememberableDecision => ({ approved: true, remember: true }));
		const approve = rememberApprovals(ask);

		await approve(request('delete'), signal);
		await approve(request('move'), signal);

		expect(ask).toHaveBeenCalledTimes(2);
	});

	it('never remembers a denial, and passes its reason on', async () => {
		const ask = vi.fn((): RememberableDecision => ({
			approved: false,
			reason: 'rename it instead',
		}));
		const approve = rememberApprovals(ask);

		await expect(approve(request('delete'), signal)).resolves.toEqual({
			approved: false,
			reason: 'rename it instead',
		});
		await approve(request('delete'), signal);

		expect(ask).toHaveBeenCalledTimes(2);
	});

	it('tells calls apart by the key it is given', async () => {
		const ask = vi.fn((): RememberableDecision => ({ approved: true, remember: true }));
		const approve = rememberApprovals(ask, {
			key: ({ tool, input }) => `${tool}:${(input as { path: string }).path}`,
		});

		await approve(request('delete', { path: 'a.txt' }), signal);
		await approve(request('delete', { path: 'a.txt' }), signal);
		await approve(request('delete', { path: 'b.txt' }), signal);

		expect(ask).toHaveBeenCalledTimes(2);
	});

	// Each wrapper is a separate memory: a consumer chooses its lifetime by when it creates one.
	it('keeps what one approver remembered out of another', async () => {
		const ask = vi.fn((): RememberableDecision => ({ approved: true, remember: true }));

		await rememberApprovals(ask)(request('delete'), signal);
		await rememberApprovals(ask)(request('delete'), signal);

		expect(ask).toHaveBeenCalledTimes(2);
	});

	it('forgets an "always" that arrived after the run was cancelled', async () => {
		const controller = new AbortController();
		const ask = vi
			.fn<(request: ApprovalRequest, signal: AbortSignal) => RememberableDecision>()
			.mockImplementationOnce(() => {
				controller.abort();
				return { approved: true, remember: true };
			})
			.mockReturnValueOnce({ approved: true });
		const approve = rememberApprovals(ask);

		await expect(approve(request('delete'), controller.signal)).rejects.toHaveProperty(
			'name',
			'AbortError',
		);
		await approve(request('delete'), signal);

		expect(ask).toHaveBeenCalledTimes(2);
	});

	// An untyped consumer can answer anything, and a truthy string must not become an "always".
	it.each([
		['a string approved', { approved: 'false', remember: true }],
		['a string remember', { approved: true, remember: 'false' }],
	])('rejects an answer with %s, and remembers nothing', async (_, answer) => {
		const ask = vi
			.fn<(request: ApprovalRequest, signal: AbortSignal) => RememberableDecision>()
			.mockReturnValueOnce(answer as unknown as RememberableDecision)
			.mockReturnValueOnce({ approved: true });
		const approve = rememberApprovals(ask);

		await expect(approve(request('delete'), signal)).rejects.toBeInstanceOf(TypeError);
		await approve(request('delete'), signal);

		expect(ask).toHaveBeenCalledTimes(2);
	});
});
