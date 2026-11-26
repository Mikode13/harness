import OpenAI from 'openai';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlan, runReview, runTask, type RunSettings } from '../lib/runners.ts';
import { summaryOf } from '../lib/summary.ts';
import { loadTask } from '../lib/tasks.ts';
import { removeWorkspace, stateDirectoryOf } from '../lib/workspace.ts';

// The runners end to end, offline: every role on OpenAI's model API, through a fake of its SDK
// that answers each call at once, so the record, the metrics and the checks are what is tested.

vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const usage = {
	input_tokens: 1000,
	input_tokens_details: { cached_tokens: 600, cache_write_tokens: 0 },
	output_tokens: 50,
	output_tokens_details: { reasoning_tokens: 0 },
	total_tokens: 1050,
};

function says(text: string) {
	return {
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [
			{
				type: 'message',
				id: 'msg-1',
				role: 'assistant',
				status: 'completed',
				content: [{ type: 'output_text', text, annotations: [] }],
			},
		],
		usage,
	};
}

/** Every role answers with `text`: a plan, a report and a decision at once. */
function everyRoleSays(text: string): void {
	const create = vi.fn(() => Promise.resolve(says(text)));
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
}

const doneAndApproved = JSON.stringify({
	summary: 'Fix the parser',
	phases: [{ goal: 'Fix it', files: ['src/parse.ts'], done: 'It reads milliseconds' }],
	status: 'done',
	decision: 'approved',
});

const folders: string[] = [];
const workspaces: string[] = [];
const settings = (): RunSettings => {
	const folder = mkdtempSync(join(tmpdir(), 'eval-runner-'));
	folders.push(folder);
	return { profile: 'openai', folder, judges: [] };
};

afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
	for (const workspace of workspaces.splice(0)) removeWorkspace(workspace);
	vi.clearAllMocks();
});

describe('runTask', () => {
	it('records the run, prices it, checks the result and catches an approval of a failing one', async () => {
		everyRoleSays(doneAndApproved);
		const run = settings();
		const result = await runTask(loadTask('bugfix'), run);
		workspaces.push(result.workspace);
		const [prompt] = result.prompts;

		expect(prompt?.metrics.outcome).toBe('completed');
		expect(Object.keys(prompt?.metrics.byAgent ?? {}).sort()).toEqual([
			'executor',
			'planner',
			'reviewer',
		]);
		expect(prompt?.metrics.cacheShare).toBeCloseTo(0.6);
		expect(result.cost).toBeGreaterThan(0);
		// Nothing changed: the checks still pass, and the hidden tests of the bug fail.
		expect(result.checks).toEqual({ test: true, typecheck: true, lint: true });
		expect(result.hidden?.passed).toBeLessThan(result.hidden?.total ?? 0);
		expect(result.passed).toBe(false);
		expect(result.falseApproval).toBe(true);
		expect(readFileSync(join(run.folder, 'record-1.jsonl'), 'utf8')).toContain('"type":"end"');
		// The history the harness kept is beside the workspace, and goes with it.
		expect(existsSync(stateDirectoryOf(result.workspace))).toBe(true);
		expect(summaryOf(result)).toMatchObject({ passed: false, falseApproval: true });
	});
});

describe('runPlan', () => {
	it('stops at the plan, and keeps it for the judges', async () => {
		everyRoleSays(doneAndApproved);
		const run = settings();
		const result = await runPlan(loadTask('plan'), run);
		workspaces.push(result.workspace);

		expect(result.plan).toContain('Fix it');
		expect(Object.keys(result.metrics.byAgent)).toEqual(['planner']);
		expect(existsSync(join(run.folder, 'plan.md'))).toBe(true);
	});
});

describe('runReview', () => {
	it('scores a reviewer that approves everything: no bug found, no false alarm', async () => {
		everyRoleSays('{"decision":"approved"}');
		const result = await runReview(loadTask('review-seeded'), settings());

		expect(result.cases.map(each => [each.name, each.decision, each.correct])).toEqual([
			['correct', 'approved', true],
			['partial-batch', 'approved', false],
			['duplicate-dropped', 'approved', false],
			['failure-swallowed', 'approved', false],
		]);
		expect(result.recall).toBe(0);
		expect(result.falseAlarms).toBe(0);
	});

	it('counts a rejection of a bug as found when no judge grades it', async () => {
		everyRoleSays('{"decision":"rejected","feedback":"The batch is wrong."}');
		const result = await runReview(loadTask('review-seeded'), settings());

		expect(result.recall).toBe(1);
		expect(result.falseAlarms).toBe(1);
	});
});
