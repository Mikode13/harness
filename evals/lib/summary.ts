import type { Tokens } from '../../src/index.ts';
import type { RunMetrics } from './metrics.ts';
import type { PlanResult, ReviewResult, TaskResult } from './runners.ts';

/** What any eval run gives, in one shape: the numbers `compare.ts` compares. */
export interface RunSummary {
	/** USD at the list prices of when it ran, or `undefined` when a price or a usage is unknown. */
	cost: number | undefined;
	/** Its tokens by model, which `compare.ts` prices again with today's table. */
	tokensByModel: Record<string, Tokens>;
	/** A call's usage went unreported: its cost is unknown, whatever the table says. */
	unreported: boolean;
	/** A task's hidden tests and checks all pass; a review's every decision is correct. */
	passed?: boolean;
	/** The judges' rubric score, 0 to 1. */
	quality?: number;
	/** A plan's share of the checklist covered, 0 to 1, when a judge graded it. */
	coverage?: number;
	/** The planner gave a plan to carry out: known with or without judges. */
	planProduced?: boolean;
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

/** Every metric's tokens by model, summed, and whether any call went unreported. */
function usageOf(metrics: readonly RunMetrics[]): Pick<RunSummary, 'tokensByModel' | 'unreported'> {
	const tokensByModel: Record<string, Tokens> = {};
	for (const { byModel } of metrics) {
		for (const [key, tokens] of Object.entries(byModel)) {
			const sum = tokensByModel[key];
			tokensByModel[key] = sum
				? {
						inputTokens: sum.inputTokens + tokens.inputTokens,
						readCacheTokens: sum.readCacheTokens + tokens.readCacheTokens,
						writtenCacheTokens: sum.writtenCacheTokens + tokens.writtenCacheTokens,
						outputTokens: sum.outputTokens + tokens.outputTokens,
					}
				: { ...tokens };
		}
	}
	return { tokensByModel, unreported: metrics.some(each => each.unreported) };
}

/** The numbers of one run. */
export function summaryOf(result: EvalResult): RunSummary {
	switch (result.kind) {
		case 'task': {
			const mutants = result.mutants;
			const total = mutants ? mutants.killed.length + mutants.survived.length : 0;
			return {
				cost: result.cost,
				...usageOf(result.prompts.map(prompt => prompt.metrics)),
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
				...usageOf([result.metrics]),
				...(result.coverage === undefined ? {} : { coverage: result.coverage }),
				planProduced: result.plan !== undefined,
				seconds: result.seconds,
			};
		case 'review':
			return {
				cost: result.cost,
				...usageOf(result.cases.map(each => each.metrics)),
				passed: result.cases.every(each => each.correct),
				recall: result.recall,
				falseAlarms: result.falseAlarms,
				seconds: result.cases.reduce((sum, each) => sum + each.seconds, 0),
			};
	}
}
