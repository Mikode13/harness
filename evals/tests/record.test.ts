import OpenAI from 'openai';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLLMOrchestrator, type RunEntry } from '../../src/index.ts';
import { metricsOf } from '../lib/metrics.ts';
import { modelsOf } from '../lib/runners.ts';

// The metrics read a real orchestrator's record, here with the provider's SDK faked, so a metric
// that counts an event the orchestrator never emits fails here rather than read zero in a paid run.

// The error classes stay real: the client classifies failures by them.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

/** A plan of one phase, its report, and its approval: an answer every role accepts. */
const everyRole = JSON.stringify({
	summary: 'plan',
	phases: [{ goal: 'Change it', files: [], done: 'It is changed' }],
	status: 'done',
	decision: 'approved',
});

const answer = {
	status: 'completed',
	incomplete_details: null,
	error: null,
	output: [
		{
			type: 'message',
			id: 'msg-1',
			role: 'assistant',
			status: 'completed',
			content: [{ type: 'output_text', text: everyRole, annotations: [] }],
		},
	],
	usage: {
		input_tokens: 100,
		input_tokens_details: { cached_tokens: 60, cache_write_tokens: 0 },
		output_tokens: 10,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 110,
	},
};

let parent: string | undefined;

afterEach(() => {
	if (parent) rmSync(parent, { recursive: true, force: true });
	vi.clearAllMocks();
});

it("counts each role's rounds and steps from a real orchestrator's record", async () => {
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create: vi.fn(() => Promise.resolve(answer)) } } as unknown as OpenAI;
	});
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'eval-record-')));
	const repo = join(parent, 'repo');
	mkdirSync(repo);
	execFileSync('git', ['init', '--quiet'], { cwd: repo });
	writeFileSync(join(repo, 'a.txt'), 'original');
	const entries: RunEntry[] = [];

	const agent = await createLLMOrchestrator({
		provider: 'openai',
		workspace: { roots: [{ path: repo, access: 'write' }], stateDirectory: join(parent, 'state') },
		logger: { warn: vi.fn() },
	});
	await agent.run('Change it', {
		signal: new AbortController().signal,
		onRecord: entry => {
			entries.push(entry);
		},
	});
	const metrics = metricsOf(entries, modelsOf({ profile: 'openai' }));

	expect(metrics.stages).toMatchObject({ plan: 1, execute: 1, review: 1 });
	expect(Object.keys(metrics.byAgent).sort()).toEqual(['executor', 'planner', 'reviewer']);
	expect(metrics.byAgent.planner?.steps).toBe(1);
	expect(metrics.unreportedSteps).toBe(0);
	expect(metrics.cost).toBeGreaterThan(0);
	expect(metrics.outcome).toBe('completed');
});
