import { describe, expect, it, vi } from 'vitest';
import { OrchestratorAgent } from '../../src/orchestratorAgent.ts';
import type { Agent, AgentResponse } from '../../src/models/agent.ts';
import { UnrecoverableError } from '../../src/models/errors.ts';

function createResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
	return {
		response: 'response',
		inputTokens: 1,
		outputTokens: 1,
		duration: 1,
		...overrides,
	};
}

function createFakeAgent(...responses: (AgentResponse | undefined)[]) {
	const run = vi.fn(() => {
		if (responses.length === 0) {
			throw new Error('fake agent ran out of scripted responses');
		}

		return Promise.resolve(responses.shift());
	});
	const agent: Agent = { run };

	return { agent, run };
}

describe('OrchestratorAgent', () => {
	it('completes the planner, executor, and reviewer flow with forwarded inputs and summed usage', async () => {
		const planner = createFakeAgent(
			createResponse({ response: 'draft plan', inputTokens: 2, outputTokens: 3, duration: 1 }),
		);
		const executor = createFakeAgent(
			createResponse({
				response: 'implemented changes',
				inputTokens: 5,
				outputTokens: 6,
				duration: 4,
			}),
		);
		const reviewer = createFakeAgent(
			createResponse({
				response: '{"decision":"approved"}',
				inputTokens: 8,
				outputTokens: 9,
				duration: 7,
			}),
		);
		const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent);
		const signal = new AbortController().signal;
		const callback = vi.fn();

		await expect(orchestrator.run('ship feature', signal, callback)).resolves.toEqual({
			response: 'All job has finished',
			duration: 12,
			inputTokens: 15,
			outputTokens: 18,
		});

		expect(planner.run).toHaveBeenCalledWith(
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(planner.run).toHaveBeenCalledWith(
			expect.stringContaining('mikode-skills:mikode-code-philosophy'),
			signal,
			callback,
		);
		expect(planner.run).toHaveBeenCalledWith(
			expect.stringContaining('do not require an architecture skill yet'),
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenCalledWith(
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenCalledWith(
			expect.stringContaining('Current implementation plan:\n---\ndraft plan\n---'),
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenCalledWith(
			expect.stringContaining('mikode-skills:mikode-code-philosophy'),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			expect.stringContaining("Planner's current plan:\n---\ndraft plan\n---"),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			expect.stringContaining(
				'Executor response (context only; verify it independently):\n---\nimplemented changes\n---',
			),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			expect.stringContaining('mikode-skills:mikode-code-philosophy-review'),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			expect.stringContaining('plan compliance is secondary'),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			expect.stringContaining(
				'{"decision":"rejected","feedback":"list concrete, prioritized findings',
			),
			signal,
			callback,
		);
	});

	it('starts another round with reviewer feedback after a rejection and accumulates every round usage', async () => {
		const planner = createFakeAgent(
			createResponse({ response: 'first plan' }),
			createResponse({ response: 'revised plan' }),
		);
		const executor = createFakeAgent(
			createResponse({ response: 'first implementation' }),
			createResponse({ response: 'revised implementation' }),
		);
		const reviewer = createFakeAgent(
			createResponse({ response: '{"decision":"rejected","feedback":"add coverage"}' }),
			createResponse({ response: '{"decision":"approved"}' }),
		);
		const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent);
		const signal = new AbortController().signal;
		const callback = vi.fn();

		await expect(orchestrator.run('ship feature', signal, callback)).resolves.toEqual({
			response: 'All job has finished',
			duration: 6,
			inputTokens: 6,
			outputTokens: 6,
		});

		expect(planner.run).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(planner.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(planner.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('Feedback from the previous attempt:\n---\nadd coverage\n---'),
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('Current implementation plan:\n---\nrevised plan\n---'),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('Original user request:\n---\nship feature\n---'),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("Planner's current plan:\n---\nrevised plan\n---"),
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining(
				'Executor response (context only; verify it independently):\n---\nrevised implementation\n---',
			),
			signal,
			callback,
		);
	});

	it('retries only the reviewer, without re-running the planner or executor, after a malformed decision', async () => {
		const planner = createFakeAgent(createResponse({ response: 'draft plan' }));
		const executor = createFakeAgent(createResponse({ response: 'implemented changes' }));
		const reviewer = createFakeAgent(
			createResponse({ response: 'not json' }),
			createResponse({ response: '{"decision":"approved"}' }),
		);
		const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent);
		const signal = new AbortController().signal;
		const callback = vi.fn();

		await expect(orchestrator.run('ship feature', signal, callback)).resolves.toMatchObject({
			response: 'All job has finished',
		});

		expect(planner.run).toHaveBeenCalledTimes(1);
		expect(executor.run).toHaveBeenCalledTimes(1);
		expect(reviewer.run).toHaveBeenCalledTimes(2);
		expect(reviewer.run).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining('Your previous response could not be used'),
			signal,
			callback,
		);
	});

	it('throws an UnrecoverableError after exhausting reviewer decision attempts', async () => {
		const planner = createFakeAgent(createResponse({ response: 'draft plan' }));
		const executor = createFakeAgent(createResponse({ response: 'implementation' }));
		const reviewer = createFakeAgent(undefined);
		const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent, 1);

		await expect(
			orchestrator.run('ship feature', new AbortController().signal, vi.fn()),
		).rejects.toMatchObject({
			message: 'Max attempts exhausted',
			cause: 'Reviewer decision is missing.',
		});
	});

	it.each([
		['invalid JSON', 'not json', 'Reviewer response must be valid JSON.'],
		[
			'missing rejection feedback',
			'{"decision":"rejected"}',
			'Reviewer response did not match the decision schema.',
		],
		[
			'unknown decision',
			'{"decision":"needs-work","feedback":"fix it"}',
			'Reviewer response did not match the decision schema.',
		],
	] as const)(
		'throws an UnrecoverableError for a malformed reviewer response (%s)',
		async (_case, response, cause) => {
			const planner = createFakeAgent(createResponse({ response: 'draft plan' }));
			const executor = createFakeAgent(createResponse({ response: 'implementation' }));
			const reviewer = createFakeAgent(createResponse({ response }));
			const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent, 1);

			await expect(
				orchestrator.run('ship feature', new AbortController().signal, vi.fn()),
			).rejects.toMatchObject({
				message: 'Max attempts exhausted',
				cause,
			});
		},
	);

	it('throws an UnrecoverableError with the latest feedback after maxAttempts', async () => {
		const planner = createFakeAgent(
			createResponse({ response: 'first plan' }),
			createResponse({ response: 'second plan' }),
		);
		const executor = createFakeAgent(
			createResponse({ response: 'first implementation' }),
			createResponse({ response: 'second implementation' }),
		);
		const reviewer = createFakeAgent(
			createResponse({ response: '{"decision":"rejected","feedback":"first feedback"}' }),
			createResponse({ response: '{"decision":"rejected","feedback":"latest feedback"}' }),
		);
		const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent, 2);
		const error = orchestrator.run('ship feature', new AbortController().signal, vi.fn());

		await expect(error).rejects.toBeInstanceOf(UnrecoverableError);
		await expect(error).rejects.toMatchObject({
			message: 'Max attempts exhausted',
			cause: 'latest feedback',
		});
		expect(planner.run).toHaveBeenCalledTimes(2);
		expect(executor.run).toHaveBeenCalledTimes(2);
		expect(reviewer.run).toHaveBeenCalledTimes(2);
	});

	it.each([
		['missing', undefined],
		['blank', createResponse({ response: '' })],
	] as const)(
		'throws an UnrecoverableError for a %s planner response after exhausting attempts',
		async (_case, plannerResponse) => {
			const planner = createFakeAgent(plannerResponse);
			const executor = createFakeAgent();
			const reviewer = createFakeAgent();
			const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent, 1);

			const error = orchestrator.run('ship feature', new AbortController().signal, vi.fn());

			await expect(error).rejects.toBeInstanceOf(UnrecoverableError);
			await expect(error).rejects.toMatchObject({
				message: 'Max attempts exhausted',
				cause: 'The planner produced no response.',
			});
			expect(executor.run).not.toHaveBeenCalled();
			expect(reviewer.run).not.toHaveBeenCalled();
		},
	);

	it.each([
		['missing', undefined],
		['blank', createResponse({ response: '' })],
	] as const)(
		'throws an UnrecoverableError for a %s executor response after exhausting attempts',
		async (_case, executorResponse) => {
			const planner = createFakeAgent(createResponse({ response: 'draft plan' }));
			const executor = createFakeAgent(executorResponse);
			const reviewer = createFakeAgent();
			const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent, 1);

			const error = orchestrator.run('ship feature', new AbortController().signal, vi.fn());

			await expect(error).rejects.toBeInstanceOf(UnrecoverableError);
			await expect(error).rejects.toMatchObject({
				message: 'Max attempts exhausted',
				cause: 'The executor produced no response.',
			});
			expect(reviewer.run).not.toHaveBeenCalled();
		},
	);

	it('rejects a non-positive-integer maxAttempts', () => {
		const planner = createFakeAgent();
		const executor = createFakeAgent();
		const reviewer = createFakeAgent();

		expect(() => new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent, 0)).toThrow(
			RangeError,
		);
	});
});
