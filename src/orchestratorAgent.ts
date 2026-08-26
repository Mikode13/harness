import type { Agent, AgentResponse, Callback } from './models/agent.ts';
import { RecoverableError } from './models/errors.ts';

const getPlannerPrompt = (userPrompt: string, reviewerPrompt?: string) => {
	if (reviewerPrompt) {
		return `The last plan failed, the reviewer had spoted the following defects, ${reviewerPrompt}, please generate a new plan so the executor will fix them`;
	}

	return `this is the user prompt: ${userPrompt}. You are the planner agent, your task is to create a plan for the next agent that will be the executor, the same plan will be shared with the reviewer to validate the executor work. keep it accurated short and simple.`;
};

const getExecutorPrompt = (plannerPrompt: string) =>
	`You are an spanwned agent which role is to be the executor for the following plan: ${plannerPrompt}. Make sure that follow it.`;

const getReviewerPrompt = (plannerPrompt: string, executorResult: string) =>
	`Hey you are an agent which role is to review that the previus agent executor have done the following plan ${plannerPrompt} correctly, if it's okay say just the word "OK" if it's not okay, say KO and reply why is not okay and the new solution, if it helps here's the executor response: ${executorResult}`;

export class OrchestratorAgent implements Agent {
	private plannerAgent: Agent;
	private executorAgent: Agent;
	private reviewerAgent: Agent;
	private duration: number;
	private inputTokens: number;
	private outputTokens: number;

	increaseDuration(newDuration: number) {
		this.duration += newDuration;
	}

	increaseInputTokens(newInputTokens: number) {
		this.inputTokens += newInputTokens;
	}

	increaseOutputTokens(newOutputTokens: number) {
		this.outputTokens += newOutputTokens;
	}

	constructor(plannerAgent: Agent, executorAgent: Agent, reviewerAgent: Agent) {
		this.plannerAgent = plannerAgent;
		this.executorAgent = executorAgent;
		this.reviewerAgent = reviewerAgent;

		this.duration = 0;
		this.inputTokens = 0;
		this.outputTokens = 0;
	}

	private updateValues(response: AgentResponse) {
		this.increaseDuration(response.duration);
		this.increaseInputTokens(response.inputTokens);
		this.increaseOutputTokens(response.outputTokens);
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		callback: Callback,
	): Promise<AgentResponse | undefined> {
		let reviewerResponse: AgentResponse | undefined = undefined;

		while (reviewerResponse?.response !== 'OK') {
			const plannerResponse = await this.plannerAgent.run(
				getPlannerPrompt(prompt, reviewerResponse?.response),
				signal,
				callback,
			);

			if (!plannerResponse?.response) {
				throw new RecoverableError(`There's no plan from the planner, something went wrong`, {
					cause: 'Plan is missing.',
				});
			}

			this.updateValues(plannerResponse);

			const executorResponse = await this.executorAgent.run(
				getExecutorPrompt(plannerResponse.response),
				signal,
				callback,
			);

			if (!executorResponse?.response) {
				throw new RecoverableError(`There's no response from the executor, something went wrong`, {
					cause: 'Executor is missing.',
				});
			}

			this.updateValues(executorResponse);

			reviewerResponse = await this.reviewerAgent.run(
				getReviewerPrompt(plannerResponse.response, executorResponse.response),
				signal,
				callback,
			);

			if (reviewerResponse) {
				this.updateValues(reviewerResponse);
			}
		}

		return {
			response: 'All job has finished',
			duration: this.duration,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
		};
	}
}
