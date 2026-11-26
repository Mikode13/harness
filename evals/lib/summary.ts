import type { PlanResult, ReviewResult, TaskResult } from './runners.ts';

/** What any eval run gives, in one shape: the numbers `compare.ts` compares. */
export interface RunSummary {
	/** USD at list prices, or `undefined` when a model's price is unknown. */
	cost: number | undefined;
	/** A task's hidden tests and checks all pass; a review's every decision is correct. */
	passed?: boolean;
	/** The judges' rubric score, 0 to 1. */
	quality?: number;
	/** A plan's share of the checklist covered, 0 to 1. */
	coverage?: number;
	/** A review's bugs found, and its correct changes rejected, each 0 to 1. */
	recall?: number;
	falseAlarms?: number;
	/** Mutants the agent's own tests killed, 0 to 1. */
	mutantsKilled?: number;
	/** The reviewer approved a result that fails. */
	falseApproval?: boolean;
	seconds: number;
}

export type EvalResult = TaskResult | PlanResult | ReviewResult;

/** The numbers of one run. */
export function summaryOf(result: EvalResult): RunSummary {
	switch (result.kind) {
		case 'task': {
			const mutants = result.mutants;
			const total = mutants ? mutants.killed.length + mutants.survived.length : 0;
			return {
				cost: result.cost,
				passed: result.passed,
				...(result.quality?.score === undefined ? {} : { quality: result.quality.score }),
				// Tests that fail without a mutant catch none: they score 0, not every mutant killed.
				...(mutants && total > 0
					? { mutantsKilled: mutants.baselinePassed ? mutants.killed.length / total : 0 }
					: {}),
				falseApproval: result.falseApproval,
				seconds: result.prompts.reduce((sum, prompt) => sum + prompt.seconds, 0),
			};
		}
		case 'plan':
			return {
				cost: result.metrics.cost,
				...(result.coverage === undefined ? {} : { coverage: result.coverage }),
				seconds: result.seconds,
			};
		case 'review':
			return {
				cost: result.cost,
				passed: result.cases.every(each => each.correct),
				recall: result.recall,
				falseAlarms: result.falseAlarms,
				seconds: result.cases.reduce((sum, each) => sum + each.seconds, 0),
			};
	}
}
