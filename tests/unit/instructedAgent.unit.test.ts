import { describe, expect, it, vi } from 'vitest';
import type { Agent, RunOptions } from '../../src/agent/domain/agent.ts';
import { InstructedAgent } from '../../src/orchestration/domain/model/instructedAgent.ts';

describe('InstructedAgent', () => {
	it('puts the instructions ahead of every prompt and returns what the inner agent answers', async () => {
		const response = { response: 'done', duration: 1, tokens: undefined };
		const run = vi.fn<Agent['run']>(() => Promise.resolve(response));
		const inner: Agent = { run };
		const signal = new AbortController().signal;
		const callback = vi.fn();

		const agent = new InstructedAgent({ inner, instructions: 'You are the planner agent.' });

		await expect(
			agent.run('Original user request', { signal, onProgress: callback }),
		).resolves.toBe(response);
		expect(run).toHaveBeenCalledWith('You are the planner agent.\n\nOriginal user request', {
			signal,
			onProgress: callback,
		});
	});

	it('lets the inner agent fail unchanged', async () => {
		const failure = new Error('provider down');
		const inner: Agent = { run: vi.fn(() => Promise.reject(failure)) };

		await expect(
			new InstructedAgent({ inner, instructions: '' }).run('prompt', {
				signal: new AbortController().signal,
			}),
		).rejects.toBe(failure);
	});

	// Rebuilding the options would drop any field this decorator does not know about.
	it('passes the run options on whole', async () => {
		const run = vi.fn<Agent['run']>(() =>
			Promise.resolve({ response: 'done', duration: 1, tokens: undefined }),
		);
		const options: RunOptions = { signal: new AbortController().signal, onProgress: vi.fn() };

		await new InstructedAgent({ inner: { run }, instructions: 'Plan.' }).run('request', options);

		expect(run.mock.calls[0]?.[1]).toBe(options);
	});
});
