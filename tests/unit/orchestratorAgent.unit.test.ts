import { describe, expect, it, vi } from 'vitest';
import { OrchestratorAgent } from '../../src/orchestratorAgent.ts';
import type { Agent, AgentResponse } from '../../src/models/agent.ts';
import { RecoverableError } from '../../src/models/errors.ts';

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
			createResponse({ response: 'OK', inputTokens: 8, outputTokens: 9, duration: 7 }),
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
			'this is the user prompt: ship feature. You are the planner agent, your task is to create a plan for the next agent that will be the executor, the same plan will be shared with the reviewer to validate the executor work. keep it accurated short and simple.',
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenCalledWith(
			'You are an spanwned agent which role is to be the executor for the following plan: draft plan. Make sure that follow it.',
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenCalledWith(
			"Hey you are an agent which role is to review that the previus agent executor have done the following plan draft plan correctly, if it's okay say just the word \"OK\" if it's not okay, say KO and reply why is not okay and the new solution, if it helps here's the executor response: implemented changes",
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
			createResponse({ response: 'KO: add coverage' }),
			createResponse({ response: 'OK' }),
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
			'this is the user prompt: ship feature. You are the planner agent, your task is to create a plan for the next agent that will be the executor, the same plan will be shared with the reviewer to validate the executor work. keep it accurated short and simple.',
			signal,
			callback,
		);
		expect(planner.run).toHaveBeenNthCalledWith(
			2,
			'The last plan failed, the reviewer had spoted the following defects, KO: add coverage, please generate a new plan so the executor will fix them',
			signal,
			callback,
		);
		expect(executor.run).toHaveBeenNthCalledWith(
			2,
			'You are an spanwned agent which role is to be the executor for the following plan: revised plan. Make sure that follow it.',
			signal,
			callback,
		);
		expect(reviewer.run).toHaveBeenNthCalledWith(
			2,
			"Hey you are an agent which role is to review that the previus agent executor have done the following plan revised plan correctly, if it's okay say just the word \"OK\" if it's not okay, say KO and reply why is not okay and the new solution, if it helps here's the executor response: revised implementation",
			signal,
			callback,
		);
	});

	it('starts another round without feedback when the reviewer has no response', async () => {
		const planner = createFakeAgent(
			createResponse({ response: 'first plan' }),
			createResponse({ response: 'second plan' }),
		);
		const executor = createFakeAgent(
			createResponse({ response: 'first implementation' }),
			createResponse({ response: 'second implementation' }),
		);
		const reviewer = createFakeAgent(undefined, createResponse({ response: 'OK' }));
		const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent);
		const signal = new AbortController().signal;
		const callback = vi.fn();

		await orchestrator.run('ship feature', signal, callback);

		expect(planner.run).toHaveBeenNthCalledWith(
			2,
			'this is the user prompt: ship feature. You are the planner agent, your task is to create a plan for the next agent that will be the executor, the same plan will be shared with the reviewer to validate the executor work. keep it accurated short and simple.',
			signal,
			callback,
		);
		expect(planner.run).toHaveBeenCalledTimes(2);
		expect(executor.run).toHaveBeenCalledTimes(2);
		expect(reviewer.run).toHaveBeenCalledTimes(2);
	});

	it.each([
		['missing', undefined],
		['blank', createResponse({ response: '' })],
	] as const)(
		'raises a RecoverableError for a %s planner response',
		async (_case, plannerResponse) => {
			const planner = createFakeAgent(plannerResponse);
			const executor = createFakeAgent();
			const reviewer = createFakeAgent();
			const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent);

			const error = orchestrator.run('ship feature', new AbortController().signal, vi.fn());

			await expect(error).rejects.toBeInstanceOf(RecoverableError);
			await expect(error).rejects.toMatchObject({
				message: "There's no plan from the planner, something went wrong",
				cause: 'Plan is missing.',
			});
			expect(executor.run).not.toHaveBeenCalled();
			expect(reviewer.run).not.toHaveBeenCalled();
		},
	);

	it.each([
		['missing', undefined],
		['blank', createResponse({ response: '' })],
	] as const)(
		'raises a RecoverableError for a %s executor response',
		async (_case, executorResponse) => {
			const planner = createFakeAgent(createResponse({ response: 'draft plan' }));
			const executor = createFakeAgent(executorResponse);
			const reviewer = createFakeAgent();
			const orchestrator = new OrchestratorAgent(planner.agent, executor.agent, reviewer.agent);

			const error = orchestrator.run('ship feature', new AbortController().signal, vi.fn());

			await expect(error).rejects.toBeInstanceOf(RecoverableError);
			await expect(error).rejects.toMatchObject({
				message: "There's no response from the executor, something went wrong",
				cause: 'Executor is missing.',
			});
			expect(reviewer.run).not.toHaveBeenCalled();
		},
	);
});
