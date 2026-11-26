import OpenAI from 'openai';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMOrchestrator } from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';

// The error classes stay real: the client classifies failures by them.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const logger = { warn: vi.fn() };
const folders: string[] = [];

afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
	vi.clearAllMocks();
});

/** A plan of one phase, its report, and its approval: an answer every role accepts. */
const everyRole = JSON.stringify({
	summary: 'plan',
	phases: [{ goal: 'Change it', files: [], done: 'It is changed' }],
	status: 'done',
	decision: 'approved',
});

interface Request {
	model?: string;
	instructions?: string;
	reasoning?: { effort?: string };
}

/** The model and effort each role's requests named, by the role its instructions name. */
function openAIRecording(): Record<string, { model?: string; effort?: string }> {
	const seen: Record<string, { model?: string; effort?: string }> = {};
	const create = vi.fn((request: Request) => {
		const role = /^You are the (\w+) agent/.exec(request.instructions ?? '')?.[1] ?? 'other';
		seen[role] = {
			...(request.model === undefined ? {} : { model: request.model }),
			...(request.reasoning?.effort === undefined ? {} : { effort: request.reasoning.effort }),
		};
		return Promise.resolve({
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
				input_tokens: 1,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				output_tokens: 1,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: 2,
			},
		});
	});
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return seen;
}

function repository(): { roots: { path: string; access: 'write' }[]; stateDirectory: string } {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-role-models-')));
	folders.push(parent);
	const repo = join(parent, 'repo');
	execFileSync('git', ['init', '--quiet', repo]);
	return { roots: [{ path: repo, access: 'write' }], stateDirectory: join(parent, 'state') };
}

describe('createLLMOrchestrator roles', () => {
	it("runs each role it names on its model and effort, and the others on the provider's", async () => {
		const seen = openAIRecording();
		const orchestrator = await createLLMOrchestrator({
			provider: 'openai',
			workspace: repository(),
			logger,
			roles: {
				executor: { provider: 'openai', model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
				reviewer: { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high' },
			},
		});
		await orchestrator.run('Change it', { signal: new AbortController().signal });

		expect(seen).toMatchObject({
			planner: { model: 'gpt-5.6-sol', effort: 'high' },
			executor: { model: 'gpt-5.6-terra', effort: 'medium' },
			reviewer: { model: 'gpt-6-astra', effort: 'high' },
		});
	});

	it.each([
		['not an object', 'reviewer'],
		[
			'a role that does not exist',
			{ critic: { provider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'high' } },
		],
		['a role with no model', { reviewer: { provider: 'openai', reasoningEffort: 'high' } }],
		[
			'a role on an unknown provider',
			{ reviewer: { provider: 'acme', model: 'x', reasoningEffort: 'high' } },
		],
	])('refuses roles that are %s', async (_, roles) => {
		openAIRecording();

		await expect(
			createLLMOrchestrator({
				provider: 'openai',
				workspace: repository(),
				logger,
				roles: roles as never,
			}),
		).rejects.toBeInstanceOf(InvalidAgentConfigError);
	});

	it('refuses a model its provider does not support', async () => {
		openAIRecording();

		await expect(
			createLLMOrchestrator({
				provider: 'openai',
				workspace: repository(),
				logger,
				roles: { reviewer: { provider: 'openai', model: 'opus', reasoningEffort: 'high' } },
			}),
		).rejects.toBeInstanceOf(InvalidAgentConfigError);
	});
});
