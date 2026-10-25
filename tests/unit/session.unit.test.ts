import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, AgentResponse } from '../../src/agent/domain/agent.ts';
import { RunContext, withRunContext } from '../../src/agent/domain/runContext.ts';
import { newSession } from '../../src/agent/domain/session.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { createFileTools } from '../../src/factory/infrastructure/agentLLMFactory.ts';
import { createWorkflow } from '../../src/factory/infrastructure/workflowFactory.ts';
import { createHistory } from '../../src/recovery/infrastructure/createHistory.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type { Session } from '../../src/shared/domain/session.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { defineWorkflowStages } from '../../src/workflow/domain/workflow.ts';
import { FakeLLMClient, textResponse } from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;
const readable = /^[a-z]+-[a-z]+-\d{4}$/;

function agentAnswering(...answers: string[]): LLMAgent {
	return new LLMAgent({ llmClient: new FakeLLMClient(...answers.map(text => textResponse(text))) });
}

describe('newSession', () => {
	it('names a session in words and a number, and rarely the same twice', () => {
		const ids = Array.from({ length: 200 }, () => newSession().id);

		for (const id of ids) expect(id).toMatch(readable);
		expect(new Set(ids).size).toBeGreaterThan(195);
	});
});

describe('a run’s session', () => {
	it('is the agent’s own for every run that names none', async () => {
		const agent = agentAnswering('one', 'two');
		const other = agentAnswering('three');

		const first = await agent.run('first', { signal });
		const second = await agent.run('second', { signal });
		const elsewhere = await other.run('first', { signal });

		expect(first.session?.id).toMatch(readable);
		expect(second.session).toEqual(first.session);
		expect(elsewhere.session).not.toEqual(first.session);
	});

	it('is the one the run names, kept as it was given', async () => {
		const agent = agentAnswering('one', 'two');
		const given: Session = { id: 'api-42', name: 'fix README typo' };

		const named = await agent.run('first', { signal, session: given });
		given.name = 'renamed later';
		const own = await agent.run('second', { signal });

		expect(named.session).toEqual({ id: 'api-42', name: 'fix README typo' });
		expect(own.session?.id).toMatch(readable);
	});

	it('drops a blank name, so a host shows the id', async () => {
		const response = await agentAnswering('done').run('go', {
			signal,
			session: { id: 'api-3', name: '  ' },
		});

		expect(response.session).toEqual({ id: 'api-3' });
	});

	it('answers with a copy, so changing it changes nothing the agent keeps', async () => {
		const agent = agentAnswering('one', 'two');

		const first = await agent.run('first', { signal });
		const id = first.session?.id;
		if (first.session) first.session.id = 'changed';
		const second = await agent.run('second', { signal });

		expect(second.session?.id).toBe(id);
	});

	it('refuses a session without an id, or with a name that is not text, before anything runs', async () => {
		const llmClient = new FakeLLMClient(textResponse('never'));
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('go', { signal, session: { id: '  ' } })).rejects.toThrow(
			UnrecoverableError,
		);
		await expect(
			agent.run('go', { signal, session: { id: 'api-1', name: 7 } as unknown as Session }),
		).rejects.toThrow('a session whose name is not text');
		expect(llmClient.contexts).toEqual([]);
	});

	it('is the outer run’s for an agent another agent started', async () => {
		const outer = new RunContext({ id: 'outer-session' });

		const response = await agentAnswering('done').run(
			'go',
			withRunContext({ signal, session: { id: 'ignored' } }, outer),
		);

		expect(response.session).toEqual({ id: 'outer-session' });
	});

	it('is a new one for each workflow run that names none, and the given one otherwise', async () => {
		const seen: Session[] = [];
		const stage = defineWorkflowStages<{ only: null }, null>();
		const workflow = createWorkflow({
			initialStage: 'only',
			stages: {
				only: stage('only', {
					agent: (): Agent => ({
						run: (_prompt, options): Promise<AgentResponse> =>
							agentAnswering('null')
								.run('answer', options)
								.then(response => {
									if (response.session) seen.push(response.session);
									return response;
								}),
					}),
					prompt: () => 'answer',
					validator: { validate: () => null },
					transition: () => ({ type: 'complete', result: null }),
				}),
			},
		});

		const first = await workflow.run(null, { signal });
		const second = await workflow.run(null, { signal });
		const named = await workflow.run(null, { signal, session: { id: 'api-7' } });

		expect(first.session?.id).toMatch(readable);
		expect(second.session).not.toEqual(first.session);
		expect(named.session).toEqual({ id: 'api-7' });
		// Each stage's agent answers with the workflow run's session.
		expect(seen).toEqual([first.session, second.session, named.session]);
	});
});

describe('the history', () => {
	let parent: string;
	let repo: string;

	beforeEach(() => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-session-')));
		repo = join(parent, 'repo');
		mkdirSync(repo);
		execFileSync('git', ['init', '--quiet'], { cwd: repo });
	});

	afterEach(() => {
		rmSync(parent, { recursive: true, force: true });
	});

	it('records the session each run came from', async () => {
		const workspace = {
			roots: [{ path: repo, access: 'write' as const }],
			stateDirectory: join(parent, 'state'),
		};
		const tools = await createFileTools('openai', workspace, { logger: { warn: () => undefined } });
		const patch = tools.find(tool => tool.name === 'apply_patch') as unknown as PreparingTool;
		const write = async (session: Session, path: string) => {
			const run = new RunContext(session);
			const prepared = await patch.prepare(
				{ type: 'create_file', path, diff: '+written' },
				signal,
				{
					run,
					reads: new ReadRegistry().begin(),
					callId: path,
					onProgress: () => undefined,
					spend: () => undefined,
					depth: 0,
				},
			);
			await prepared.run(signal);
			await run.finish('completed');
		};

		await write({ id: 'api-1', name: 'fix README typo' }, 'a.txt');
		await write({ id: 'smart-hawk-4821' }, 'b.txt');

		const history = await createHistory({ root: repo, stateDirectory: workspace.stateDirectory });
		const { runs } = await history.list();
		expect(runs.map(run => run.session)).toEqual([
			{ id: 'api-1', name: 'fix README typo' },
			{ id: 'smart-hawk-4821' },
		]);
	});
});
