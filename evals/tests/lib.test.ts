import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProgressEvent, RunEntry } from '../../src/index.ts';
import { compare, moveOf } from '../lib/compare.ts';
import { itemsOf, planCoverage, rubricScore } from '../lib/judge.ts';
import { metricsOf } from '../lib/metrics.ts';
import { costOf } from '../lib/prices.ts';
import { runHidden, type TaskResult } from '../lib/runners.ts';
import { loadTask } from '../lib/tasks.ts';
import { prepareWorkspace, removeWorkspace } from '../lib/workspace.ts';
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
		expect(metrics.byModel).toEqual({ opus: tokens, haiku: tokens });
	});

	it('counts a read with the text editor, and prices a call without usage as unknown', () => {
		const metrics = metricsOf(
			[
				progress(read('src/a.ts:1-200', 'planner')),
				progress({
					type: 'tool',
					id: 'v',
					name: 'str_replace_based_edit_tool',
					summary: 'view src/a.ts:1-end',
					status: 'completed',
					agent: 'executor',
				}),
				progress({
					type: 'step',
					step: 2,
					context: {
						instructions: 0,
						tools: 0,
						messages: 0,
						reasoning: 0,
						toolCalls: 0,
						toolResults: [],
						largestResults: [],
					},
					agent: 'executor',
				}),
			],
			{ executor: 'haiku' },
		);

		expect(metrics.repeatedReads).toBe(1);
		expect(metrics.unreportedSteps).toBe(1);
		expect(metrics.cost).toBeUndefined();
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
	// Opus input costs $4 a million tokens, so a cost of `cost` dollars is `cost * 250,000` tokens.
	const run = (cost: number, passed = true, quality = 0.8): RunSummary => ({
		cost,
		tokensByModel: {
			opus: {
				inputTokens: cost * 250_000,
				readCacheTokens: 0,
				writtenCacheTokens: 0,
				outputTokens: 0,
			},
		},
		unreported: false,
		passed,
		quality,
		seconds: 1,
	});
	const runs = (costs: number[], passed = true, quality = 0.8): RunSummary[] =>
		costs.map(cost => run(cost, passed, quality));

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
			b: [...runs([1, 1.1]), run(1.2, false)],
		};

		expect(compare(before, after)).toMatchObject({ worse: ['b'], verdict: 'regression' });
	});

	it('prices both sides with the table as it is, not with what each run recorded', () => {
		// The cost each side recorded says the change doubled it; their tokens say it did not.
		const recordedHigher = (cost: number): RunSummary => ({ ...run(cost), cost: cost * 2 });
		const before = { a: runs([1, 1.1, 1.2]) };
		const after = { a: [1, 1.1, 1.2].map(recordedHigher) };

		expect(compare(before, after).tasks[0]?.cost.move).toBe('same');
	});

	it('leaves out a task with fewer than three runs on a side', () => {
		const before = { a: runs([1]), b: runs([2, 2.2]) };
		const after = { a: runs([0.1]), b: runs([0.5, 0.6]) };

		expect(compare(before, after)).toMatchObject({
			cheaper: [],
			tooFewRuns: ['a', 'b'],
			verdict: 'inconclusive',
		});
		expect(compare(before, after).tasks[0]?.measures.passRate?.move).toBe('unknown');
	});

	it('leaves the cost of a run with unreported usage unknown', () => {
		const before = { a: runs([1]) };
		const after = { a: [{ ...run(0.1), unreported: true }] };

		expect(compare(before, after).tasks[0]?.cost.move).toBe('unknown');
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

describe('runHidden', () => {
	const hiddenRun = (test: string) => {
		const task = loadTask('bugfix');
		const workspace = prepareWorkspace(task);
		const directory = mkdtempSync(join(tmpdir(), 'eval-hidden-'));
		mkdirSync(join(directory, 'hidden', 'tests', 'hidden'), { recursive: true });
		writeFileSync(join(directory, 'hidden', 'tests', 'hidden', 'probe.hidden.test.ts'), test);
		try {
			return runHidden({ ...task, directory, hidden: 'hidden' }, workspace, directory);
		} finally {
			removeWorkspace(workspace);
			rmSync(directory, { recursive: true, force: true });
		}
	};

	it('passes a run whose tests all pass', () => {
		const hidden = hiddenRun(
			"import { expect, it } from 'vitest';\nit('passes', () => {\n\texpect(1).toBe(1);\n});\n",
		);

		expect(hidden).toEqual({ passed: 1, total: 1, failed: [] });
	});

	it('fails a run Vitest fails outside its tests, though every test passed', () => {
		const hidden = hiddenRun(
			"import { expect, it } from 'vitest';\nit('passes, then lets an error escape', () => {\n\tsetTimeout(() => {\n\t\tthrow new Error('escaped');\n\t}, 0);\n\texpect(1).toBe(1);\n});\nit('waits for it', async () => {\n\tawait new Promise(resolve => setTimeout(resolve, 50));\n});\n",
		);

		expect(hidden?.passed).toBeLessThan(hidden?.total ?? 0);
		expect(hidden?.failed.join('\n')).toContain('outside any test');
	});

	it('fails a hidden file that does not load', () => {
		const hidden = hiddenRun("import { missing } from '../../src/missing.ts';\nmissing();\n");

		expect(hidden?.passed).toBe(0);
		expect(hidden?.failed.length).toBeGreaterThan(0);
	});
});
