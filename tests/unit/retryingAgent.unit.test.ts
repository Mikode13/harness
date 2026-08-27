import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentResponse } from '../../src/models/agent.ts';
import { RecoverableError, UnrecoverableError } from '../../src/models/errors.ts';
import { RetryingAgent } from '../../src/retryingAgent.ts';

const okResponse: AgentResponse = {
	response: 'pong',
	inputTokens: 1,
	outputTokens: 1,
	duration: 1,
};

const signal = new AbortController().signal;
const callback = vi.fn();

// A fake Agent — RetryingAgent only depends on the Agent interface, so we can
// script its behavior directly instead of hitting a real SDK. Returns the
// mock separately (not as `agent.run`) so tests assert on a plain function
// reference, not a bound method access.
function fakeAgent(...behaviors: (Error | AgentResponse)[]) {
	const run = vi.fn((): Promise<AgentResponse> => {
		const next = behaviors.shift();
		if (next instanceof Error) return Promise.reject(next);
		if (!next) return Promise.reject(new Error('fakeAgent ran out of scripted behaviors'));
		return Promise.resolve(next);
	});
	const agent: Agent = { run };
	return { agent, run };
}

describe('RetryingAgent', () => {
	it('returns the result on the first successful attempt', async () => {
		const { agent, run } = fakeAgent(okResponse);
		const retryingAgent = new RetryingAgent(agent);

		const result = await retryingAgent.run('hi', signal, callback);

		expect(result).toBe(okResponse);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('retries on RecoverableError and returns the eventual success', async () => {
		const { agent, run } = fakeAgent(
			new RecoverableError('flaky', { cause: 'network blip' }),
			new RecoverableError('flaky again', { cause: 'timeout' }),
			okResponse,
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		const result = await retryingAgent.run('hi', signal, callback);

		expect(result).toBe(okResponse);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('gives up after maxAttempts and rethrows the last error', async () => {
		const { agent, run } = fakeAgent(
			new RecoverableError('1', { cause: 'first failure' }),
			new RecoverableError('2', { cause: 'second failure' }),
			new RecoverableError('3', { cause: 'third failure' }),
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal, callback)).rejects.toThrow(
			'Max attempts exhausted',
		);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('does not retry on UnrecoverableError', async () => {
		const { agent, run } = fakeAgent(
			new UnrecoverableError('broken', { cause: 'fatal' }),
			okResponse,
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal, callback)).rejects.toThrow('broken');
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('does not retry when the call was aborted', async () => {
		const abortError = new DOMException('The operation was aborted', 'AbortError');
		const { agent, run } = fakeAgent(abortError, okResponse);
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal, callback)).rejects.toThrow('aborted');
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('sends the original prompt unchanged on the first attempt', async () => {
		const { agent, run } = fakeAgent(okResponse);
		const retryingAgent = new RetryingAgent(agent);

		await retryingAgent.run('hi', signal, callback);

		expect(run).toHaveBeenNthCalledWith(1, 'hi', signal, callback);
	});

	it('includes the previous failure reason in the retried prompt', async () => {
		const { agent, run } = fakeAgent(
			new RecoverableError('flaky', { cause: 'network blip' }),
			okResponse,
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		await retryingAgent.run('hi', signal, callback);

		expect(run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('network blip'),
			signal,
			callback,
		);
	});

	it('carries forward only the most recent failure reason across retries', async () => {
		const { agent, run } = fakeAgent(
			new RecoverableError('flaky', { cause: 'first failure' }),
			new RecoverableError('flaky again', { cause: 'second failure' }),
			okResponse,
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		await retryingAgent.run('hi', signal, callback);

		expect(run).toHaveBeenNthCalledWith(
			3,
			expect.stringContaining('second failure'),
			signal,
			callback,
		);
		expect(run).toHaveBeenNthCalledWith(
			3,
			expect.not.stringContaining('first failure'),
			signal,
			callback,
		);
	});

	it('does not rewrite the prompt when the failure is unrecoverable', async () => {
		const { agent, run } = fakeAgent(new UnrecoverableError('broken', { cause: 'fatal' }));
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal, callback)).rejects.toThrow('broken');

		expect(run).toHaveBeenNthCalledWith(1, 'hi', signal, callback);
	});
});
