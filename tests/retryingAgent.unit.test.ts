import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentResponse } from '../src/models/agent.ts';
import { RecoverableError, UnrecoverableError } from '../src/models/errors.ts';
import { RetryingAgent } from '../src/retryingAgent.ts';

const okResponse: AgentResponse = {
	response: 'pong',
	inputTokens: 1,
	outputTokens: 1,
	duration: '1s',
};

const signal = new AbortController().signal;

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

		const result = await retryingAgent.run('hi', signal);

		expect(result).toBe(okResponse);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('retries on RecoverableError and returns the eventual success', async () => {
		const { agent, run } = fakeAgent(
			new RecoverableError('flaky'),
			new RecoverableError('flaky again'),
			okResponse,
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		const result = await retryingAgent.run('hi', signal);

		expect(result).toBe(okResponse);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('gives up after maxAttempts and rethrows the last error', async () => {
		const { agent, run } = fakeAgent(
			new RecoverableError('1'),
			new RecoverableError('2'),
			new RecoverableError('3'),
		);
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal)).rejects.toThrow('3');
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('does not retry on UnrecoverableError', async () => {
		const { agent, run } = fakeAgent(new UnrecoverableError('broken'), okResponse);
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal)).rejects.toThrow('broken');
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('does not retry when the call was aborted', async () => {
		const abortError = new DOMException('The operation was aborted', 'AbortError');
		const { agent, run } = fakeAgent(abortError, okResponse);
		const retryingAgent = new RetryingAgent(agent, 3);

		await expect(retryingAgent.run('hi', signal)).rejects.toThrow('aborted');
		expect(run).toHaveBeenCalledTimes(1);
	});
});
