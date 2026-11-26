import OpenAI from 'openai';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createLLMAgent,
	createLLMOrchestrator,
	orchestratorRolesOf,
} from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';

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

describe('orchestratorRolesOf', () => {
	it('gives the roles an orchestrator built, each one runnable alone', async () => {
		const create = vi.fn((request: { instructions?: string }) =>
			Promise.resolve({
				status: 'completed',
				incomplete_details: null,
				error: null,
				output: [
					{
						type: 'message',
						id: 'msg-1',
						role: 'assistant',
						status: 'completed',
						content: [
							{
								type: 'output_text',
								text: request.instructions?.slice(0, 30) ?? '',
								annotations: [],
							},
						],
					},
				],
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 2,
				},
			}),
		);
		vi.mocked(OpenAI).mockImplementation(function () {
			return { responses: { create } } as unknown as OpenAI;
		});
		const parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-roles-')));
		folders.push(parent);
		execFileSync('git', ['init', '--quiet'], { cwd: parent });
		const orchestrator = await createLLMOrchestrator({
			provider: 'openai',
			workspace: {
				roots: [{ path: parent, access: 'read' }],
				stateDirectory: join(parent, '.state'),
			},
			logger,
		});

		const roles = orchestratorRolesOf(orchestrator);
		expect(Object.keys(roles).sort()).toEqual(['executor', 'planner', 'reviewer']);
		const { response } = await roles.reviewer.run('Review this', {
			signal: new AbortController().signal,
		});
		expect(response).toMatch(/^You are the reviewer agent\./);
	});

	it('refuses an agent createLLMOrchestrator did not build', () => {
		const agent = createLLMAgent('openai', { systemPrompt: '', logger });

		expect(() => orchestratorRolesOf(agent as never)).toThrow(InvalidAgentConfigError);
	});
});
