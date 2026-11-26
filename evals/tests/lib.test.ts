import { describe, expect, it } from 'vitest';
import type { ProgressEvent, RunEntry } from '../../src/index.ts';
import { compare, moveOf } from '../lib/compare.ts';
import { itemsOf, planCoverage, rubricScore } from '../lib/judge.ts';
import { metricsOf } from '../lib/metrics.ts';
import { costOf } from '../lib/prices.ts';
import type { TaskResult } from '../lib/runners.ts';
import { type RunSummary, summaryOf } from '../lib/summary.ts';

const tokens = { inputTokens: 100, readCacheTokens: 900, writtenCacheTokens: 0, outputTokens: 10 };
const progress = (event: ProgressEvent): RunEntry => ({ version: 1, type: 'progress', event });
const step = (agent?: 'planner' | 'executor'): ProgressEvent => ({
	type: 'step',
	step: 1,
	tokens,
	context: {
		instructions: 0,
		tools: 0,
		messages: 0,
		reasoning: 0,
		toolCalls: 0,
		toolResults: [],
		largestResults: [],
	},
	...(agent ? { agent } : {}),
});
const read = (summary: string, agent: 'planner' | 'executor'): ProgressEvent => ({
	type: 'tool',
	id: summary,
	name: 'readFile',
	summary,
	status: 'completed',
	agent,
});

describe('metricsOf', () => {
	it('splits steps by role and explorer, prices them, and counts shared and repeated reads', () => {
		const metrics = metricsOf(
			[
				progress(step('planner')),
				progress({
					type: 'subagent',
					callId: 'c',
					subagent: 1,
					name: 'explorer',
					task: 'find it',
					event: step(),
					agent: 'planner',
				}),
				progress(read('src/a.ts:1-200', 'planner')),
				progress(read('src/a.ts:1-200', 'executor')),
				progress(read('src/a.ts:201-400', 'executor')),
				progress({ type: 'turnStarted', agent: 'executor' }),
				{ version: 1, type: 'end', outcome: 'cancelled', by: 'abort' },
			],
			{ planner: 'opus', 'planner/explorer': 'haiku' },
		);

		expect(Object.keys(metrics.byAgent)).toEqual(['planner', 'planner/explorer']);
		expect(metrics.byAgent.planner?.cost).toBeCloseTo((100 * 4 + 900 * 0.2 + 10 * 20) / 1e6);
		expect(metrics.cacheShare).toBeCloseTo(0.9);
		expect(metrics.repeatedReads).toBe(2);
		expect(metrics.sharedReads).toBe(1);
		expect(metrics.turns).toEqual({ executor: 1 });
		expect(metrics.outcome).toBe('cancelled');
	});

	it('leaves the cost unknown for a model without a price', () => {
		expect(
			metricsOf([progress(step('planner'))], { planner: 'unknown-model' }).cost,
		).toBeUndefined();
	});
});

describe('costOf', () => {
	it("prices Haiku's long prompts at its higher rates", () => {
		const long = {
			inputTokens: 150_000,
			readCacheTokens: 0,
			writtenCacheTokens: 0,
			outputTokens: 0,
		};
		expect(costOf('haiku', long)).toBeCloseTo((150_000 * 0.5) / 1e6);
		expect(costOf('haiku', tokens)).toBeCloseTo((100 * 0.1 + 900 * 0.01 + 10 * 0.5) / 1e6);
	});
});

describe('itemsOf', () => {
	it('reads one item per line, skipping anything else', () => {
		expect(itemsOf('scope: Only what it asks.\n\nnot an item\ntests: Each guarantee.')).toEqual([
			{ id: 'scope', text: 'Only what it asks.' },
			{ id: 'tests', text: 'Each guarantee.' },
		]);
	});
});

describe("the judges' scores", () => {
	const items = itemsOf('a: First.\nb: Second.\nc: Third.');

	it('count each known item once, an unknown one not at all, and a missing one as 0', () => {
		const reason = 'because';
		expect(
			rubricScore(
				{
					items: [
						{ id: 'a', score: 2, reason },
						{ id: 'a', score: 0, reason },
						{ id: 'invented', score: 2, reason },
					],
				},
				items,
			),
		).toBeCloseTo(2 / 6);
	});

	it('never cover more than the whole checklist', () => {
		const reason = 'because';
		expect(
			planCoverage(
				{
					items: [
						{ id: 'a', covered: true, reason },
						{ id: 'a', covered: true, reason },
						{ id: 'x', covered: true, reason },
						{ id: 'b', covered: false, reason },
					],
				},
				items,
			),
		).toBeCloseTo(1 / 3);
	});
});

describe('compare', () => {
	const runs = (costs: number[], passed = true, quality = 0.8): RunSummary[] =>
		costs.map(cost => ({ cost, passed, quality, seconds: 1 }));

	it('counts only a move past the spread of the runs before', () => {
		expect(moveOf([1, 1.2, 1.4], [0.8, 0.9, 0.95], false)).toBe('better');
		expect(moveOf([1, 1.2, 1.4], [1.1, 1.3, 1.5], false)).toBe('same');
		expect(moveOf([0.7, 0.8], [0.5, 0.6], true)).toBe('worse');
	});

	it('says a change works when it is cheaper in two tasks and worse in none', () => {
		const before = { a: runs([1, 1.1, 1.2]), b: runs([2, 2.2, 2.4]), c: runs([3, 3.1, 3.2]) };
		const after = { a: runs([0.5, 0.6, 0.7]), b: runs([1, 1.1, 1.2]), c: runs([3, 3.1, 3.2]) };

		expect(compare(before, after)).toMatchObject({
			cheaper: ['a', 'b'],
			worse: [],
			verdict: 'works',
		});
	});

	it('calls a cheaper change that passes less a regression', () => {
		const before = { a: runs([1, 1.1, 1.2]), b: runs([2, 2.2, 2.4]) };
		const after = {
			a: runs([0.5, 0.6, 0.7]),
			b: [...runs([1, 1.1]), { cost: 1.2, passed: false, quality: 0.8, seconds: 1 }],
		};

		expect(compare(before, after)).toMatchObject({ worse: ['b'], verdict: 'regression' });
	});
});

describe('summaryOf', () => {
	it("gives no mutant a kill when the agents' tests fail without one", () => {
		const result = {
			kind: 'task',
			prompts: [],
			cost: 1,
			checks: { test: false, typecheck: true, lint: true },
			forbidden: [],
			mutants: { killed: [], survived: ['a.ts', 'b.ts'], baselinePassed: false },
			falseApproval: false,
			passed: false,
			workspace: '/tmp/none',
		} satisfies TaskResult;

		expect(summaryOf(result).mutantsKilled).toBe(0);
	});
});
