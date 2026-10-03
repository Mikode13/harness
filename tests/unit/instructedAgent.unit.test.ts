import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/domain/agent.ts';
import { InstructedAgent } from '../../src/orchestration/domain/model/instructedAgent.ts';

describe('InstructedAgent', () => {
	it('puts the instructions ahead of every prompt and returns what the inner agent answers', async () => {
		const response = { response: 'done', duration: 1, tokens: undefined };
		const run = vi.fn<Agent['run']>(() => Promise.resolve(response));
		const inner: Agent = { run };
		const signal = new AbortController().signal;
		const callback = vi.fn();

		const agent = new InstructedAgent({ inner, instructions: 'You are the planner agent.' });

		await expect(agent.run('Original user request', signal, callback)).resolves.toBe(response);
		expect(run).toHaveBeenCalledWith(
			'You are the planner agent.\n\nOriginal user request',
			signal,
			callback,
		);
	});

	it('lets the inner agent fail unchanged', async () => {
		const failure = new Error('provider down');
		const inner: Agent = { run: vi.fn(() => Promise.reject(failure)) };

		await expect(
			new InstructedAgent({ inner, instructions: '' }).run(
				'prompt',
				new AbortController().signal,
				vi.fn(),
			),
		).rejects.toBe(failure);
	});
});
