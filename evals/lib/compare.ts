import { costOfKeys } from './prices.ts';
import type { RunSummary } from './summary.ts';

/** How one number moved from the runs before a change to the runs after it. */
export type Move = 'better' | 'worse' | 'same' | 'unknown';

/** What a change did to one task. */
export interface TaskComparison {
	task: string;
	/** Median cost before and after, in USD. */
	cost: { before: number | undefined; after: number | undefined; move: Move };
	/** A number per measure: its median before and after, and how it moved. */
	measures: Record<string, { before: number; after: number; move: Move }>;
	/** A side has fewer than `minimumRuns` runs, so nothing of the task moved past noise. */
	tooFewRuns: boolean;
}

/** The runs a side needs before a move counts: with fewer, its spread says nothing of the noise. */
export const minimumRuns = 3;

/** The verdict on a change over every task both sides ran. */
export interface Comparison {
	tasks: TaskComparison[];
	cheaper: string[];
	worse: string[];
	/** Tasks left out of the verdict, a side having fewer than `minimumRuns` runs. */
	tooFewRuns: string[];
	verdict: 'works' | 'regression' | 'inconclusive';
}

const median = (values: readonly number[]): number | undefined => {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const low = sorted[middle - 1];
	const high = sorted[middle];
	if (high === undefined) return undefined;
	return sorted.length % 2 === 0 && low !== undefined ? (low + high) / 2 : high;
};

/**
 * How a number moved: only past the spread of the runs before the change counts, since a model
 * does not answer the same way twice. `higherIsBetter` says which way is better.
 */
export function moveOf(
	before: readonly number[],
	after: readonly number[],
	higherIsBetter: boolean,
): Move {
	const middle = median(after);
	if (before.length === 0 || middle === undefined) return 'unknown';
	const low = Math.min(...before);
	const high = Math.max(...before);
	if (middle < low) return higherIsBetter ? 'worse' : 'better';
	if (middle > high) return higherIsBetter ? 'better' : 'worse';
	return 'same';
}

const numbers = (
	runs: readonly RunSummary[],
	pick: (run: RunSummary) => number | undefined,
): number[] =>
	runs.flatMap(run => {
		const value = pick(run);
		return value === undefined ? [] : [value];
	});

// Each measure, and whether a higher value is better. A rate of `true` counts as 1.
const measures: Record<
	string,
	{ pick: (run: RunSummary) => number | undefined; higherIsBetter: boolean }
> = {
	passRate: {
		pick: run => (run.passed === undefined ? undefined : Number(run.passed)),
		higherIsBetter: true,
	},
	quality: { pick: run => run.quality, higherIsBetter: true },
	coverage: { pick: run => run.coverage, higherIsBetter: true },
	recall: { pick: run => run.recall, higherIsBetter: true },
	falseAlarms: { pick: run => run.falseAlarms, higherIsBetter: false },
	mutantsKilled: { pick: run => run.mutantsKilled, higherIsBetter: true },
	falseApprovals: {
		pick: run => (run.falseApproval === undefined ? undefined : Number(run.falseApproval)),
		higherIsBetter: false,
	},
};

/**
 * A run's cost at the prices of the table as it is now, so both sides of a comparison are priced
 * alike: unknown when a call's usage went unreported.
 */
function pricedNow(run: RunSummary): number | undefined {
	if (run.unreported) return undefined;
	return costOfKeys(run.tokensByModel);
}

/** A pass rate is compared as a rate, not past a spread: one run fewer passing is worse. */
const rate = (values: readonly number[]): number | undefined =>
	values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Compares the runs of each task before and after a change. A change works when it lowers the
 * median cost past the spread of the runs before it in at least two tasks, and makes no task
 * worse: no lower pass rate, and no quality measure past the spread on its wrong side. A task with
 * fewer than `minimumRuns` runs on a side moves nowhere, and counts for neither.
 */
export function compare(
	before: Record<string, readonly RunSummary[]>,
	after: Record<string, readonly RunSummary[]>,
): Comparison {
	const tasks: TaskComparison[] = [];
	// A task one side never ran is listed too, as one with too few runs, never dropped unseen.
	for (const task of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		const was = before[task] ?? [];
		const is = after[task] ?? [];
		const tooFewRuns = was.length < minimumRuns || is.length < minimumRuns;
		const costBefore = numbers(was, pricedNow);
		const costAfter = numbers(is, pricedNow);
		const compared: TaskComparison['measures'] = {};
		for (const [name, { pick, higherIsBetter }] of Object.entries(measures)) {
			const a = numbers(was, pick);
			const b = numbers(is, pick);
			const isRate = name === 'passRate' || name === 'falseApprovals';
			const beforeValue = isRate ? rate(a) : median(a);
			const afterValue = isRate ? rate(b) : median(b);
			if (beforeValue === undefined || afterValue === undefined) continue;
			const move: Move = isRate
				? afterValue === beforeValue
					? 'same'
					: afterValue > beforeValue === higherIsBetter
						? 'better'
						: 'worse'
				: moveOf(a, b, higherIsBetter);
			compared[name] = {
				before: beforeValue,
				after: afterValue,
				move: tooFewRuns ? 'unknown' : move,
			};
		}
		tasks.push({
			task,
			cost: {
				before: median(costBefore),
				after: median(costAfter),
				move: tooFewRuns ? 'unknown' : moveOf(costBefore, costAfter, false),
			},
			measures: compared,
			tooFewRuns,
		});
	}
	const cheaper = tasks.filter(each => each.cost.move === 'better').map(each => each.task);
	const worse = tasks
		.filter(each => Object.values(each.measures).some(measure => measure.move === 'worse'))
		.map(each => each.task);
	return {
		tasks,
		cheaper,
		worse,
		tooFewRuns: tasks.filter(each => each.tooFewRuns).map(each => each.task),
		verdict: worse.length > 0 ? 'regression' : cheaper.length >= 2 ? 'works' : 'inconclusive',
	};
}
