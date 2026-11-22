import OpenAI from 'openai';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ProgressEvent } from '../../src/agent/domain/agent.ts';
import { RunInProgressError } from '../../src/agent/domain/oneRunAtATime.ts';
import {
	InvalidSnapshotError,
	type SessionSnapshot,
	UnsupportedSnapshotVersionError,
} from '../../src/agent/domain/snapshot.ts';
import {
	createLLMAgent,
	createLLMOrchestrator,
} from '../../src/factory/infrastructure/agentLLMFactory.ts';
import type { RunJournal } from '../../src/recovery/domain/recoveryStore.ts';
import { createHistory } from '../../src/recovery/infrastructure/createHistory.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import { agentAsTool } from '../../src/tools/infrastructure/agentAsTool.ts';
import type { WorkspaceOptions } from '../../src/tools/infrastructure/fileTools.ts';

// The error classes stay real: the client classifies failures by them.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;
const logger = { warn: vi.fn() };

/** A plan of one phase, its report, and its approval: an answer for every role. */
const everyRole = JSON.stringify({
	summary: 'plan',
	phases: [{ goal: 'Change it', files: [], done: 'It is changed' }],
	status: 'done',
	decision: 'approved',
});

const usage = {
	input_tokens: 1,
	input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
	output_tokens: 1,
	output_tokens_details: { reasoning_tokens: 0 },
	total_tokens: 2,
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

function calls(name: string, input: unknown) {
	return {
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [
			{
				type: 'function_call',
				id: 'fc-1',
				call_id: 'call-specialist',
				name,
				arguments: JSON.stringify(input),
				status: 'completed',
			},
		],
		usage,
	};
}

interface Request {
	instructions?: string;
	input: unknown[];
}

/**
 * Every role answers with `everyRole`, unless `executor` answers it first. Returns the spy that
 * records each request.
 */
function openAIAnswering(executor?: (request: Request) => unknown) {
	const create = vi.fn((request: Request) =>
		Promise.resolve(
			executor && request.instructions?.startsWith('You are the executor agent')
				? executor(request)
				: says(everyRole),
		),
	);
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return create;
}

function roleOf(request: Request): string {
	return /^You are the (\w+) agent/.exec(request.instructions ?? '')?.[1] ?? 'unknown';
}

let parent: string;
let repo: string;
let stateDirectory: string;
let workspace: WorkspaceOptions;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-session-')));
	repo = join(parent, 'repo');
	mkdirSync(repo);
	execFileSync('git', ['init', '--quiet'], { cwd: repo });
	writeFileSync(join(repo, 'a.txt'), 'original');
	stateDirectory = join(parent, 'state');
	workspace = { roots: [{ path: repo, access: 'write' }], stateDirectory };
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
	vi.clearAllMocks();
});

function orchestrator(options: Parameters<typeof createLLMOrchestrator>[0] = {}) {
	return createLLMOrchestrator({ provider: 'openai', workspace, logger, ...options });
}

/** A snapshot as it comes back from storage. */
function stored(snapshot: SessionSnapshot): SessionSnapshot {
	return JSON.parse(JSON.stringify(snapshot)) as SessionSnapshot;
}

describe('a snapshot of createLLMOrchestrator', () => {
	it("round-trips every role's conversation, and the session, through JSON", async () => {
		openAIAnswering();
		const agent = await orchestrator();
		const { session } = await agent.run('ship it', { signal });
		const snapshot = agent.snapshot();

		const restored = await orchestrator({ restore: stored(snapshot) });

		expect(restored.snapshot()).toEqual(snapshot);
		expect(snapshot).toMatchObject({
			format: 'mikode-harness/session',
			version: 1,
			flow: 'llm-orchestrator',
			boundary: 'completed',
			session,
		});
		for (const role of ['planner', 'executor', 'reviewer'] as const) {
			expect(snapshot.roles[role].turns).toHaveLength(1);
		}
		await expect(restored.run('again', { signal })).resolves.toMatchObject({ session });
	});

	it('sends every role what an orchestrator that never stopped sends', async () => {
		const create = openAIAnswering();
		const uninterrupted = await orchestrator();
		await uninterrupted.run('ship it', { signal });
		const snapshot = stored(uninterrupted.snapshot());
		await uninterrupted.run('and the docs', { signal });
		const expected = create.mock.calls.slice(3).map(([request]) => request);

		create.mockClear();
		await (await orchestrator({ restore: snapshot })).run('and the docs', { signal });

		expect(create.mock.calls.map(([request]) => request)).toEqual(expected);
		expect(expected.map(roleOf)).toEqual(['planner', 'executor', 'reviewer']);
		expect(JSON.stringify(expected[0]?.input)).toContain('ship it');
	});

	it('takes no snapshot while a run works, between its stages included', async () => {
		openAIAnswering();
		const agent = await orchestrator();
		const refused: unknown[] = [];
		const onProgress = (event: ProgressEvent) => {
			if (event.type !== 'workflowStage') return;
			try {
				agent.snapshot();
			} catch (error) {
				refused.push(error);
			}
		};

		await agent.run('ship it', { signal, onProgress });

		expect(refused.length).toBeGreaterThanOrEqual(3);
		for (const error of refused) expect(error).toBeInstanceOf(RunInProgressError);
		expect(agent.snapshot().roles.planner.turns).toHaveLength(1);
	});

	it('keeps what a delegated specialist handed over, and does not run it again', async () => {
		let specialists = 0;
		const specialist = () =>
			agentAsTool({
				name: 'specialist',
				description: 'Looks things up',
				createAgent: (): Agent => ({
					run: () => {
						specialists++;
						return Promise.resolve({ response: 'specialist found the answer', duration: 0 });
					},
				}),
			});
		const executor = (request: Request) => {
			const seen = JSON.stringify(request.input);
			if (seen.includes('specialist found the answer')) return says(everyRole);
			// While the specialist works, the executor waits for its answer.
			if (seen.includes('call-specialist')) return says('waiting');
			return calls('specialist', { task: 'look it up' });
		};
		const create = openAIAnswering(executor);
		const agent = await orchestrator({ agents: { executor: [specialist()] } });
		await agent.run('ship it', { signal });
		const snapshot = stored(agent.snapshot());
		expect(specialists).toBe(1);

		create.mockClear();
		await (
			await orchestrator({ agents: { executor: [specialist()] }, restore: snapshot })
		).run('and the docs', { signal });

		expect(specialists).toBe(1);
		const [executorRequest] = create.mock.calls
			.map(([request]) => request)
			.filter(request => roleOf(request) === 'executor');
		expect(JSON.stringify(executorRequest?.input)).toContain('specialist found the answer');
	});

	describe('after a run the process did not finish', () => {
		const left: RunJournal[] = [];

		afterEach(async () => {
			for (const journal of left.splice(0)) await journal.finish('failed').catch(() => undefined);
		});

		/**
		 * A run of `session` that changed a.txt and whose process died before it ended, as a run cut
		 * short after the last snapshot leaves the history.
		 */
		async function diedWhileRunning(session: { id: string }): Promise<string> {
			const store = await FileRecoveryStore.open({ root: repo, directory: stateDirectory });
			const journal = await store.startRun({ session });
			left.push(journal);
			const path = join(repo, 'a.txt');
			const sequence = await journal.prepare({
				path,
				before: {
					exists: true,
					hash: await journal.saveContent(readFileSync(path)),
					mode: 0o644,
				},
				after: { exists: true, hash: await journal.saveContent(Buffer.from('half')), mode: 0o644 },
			});
			writeFileSync(path, 'half');
			await journal.applied(sequence);
			const workspaces = join(stateDirectory, 'workspaces');
			const pid = Number(
				execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']),
			);
			writeFileSync(
				join(workspaces, readdirSync(workspaces)[0] ?? '', 'lock'),
				JSON.stringify({ runId: journal.runId, pid }),
			);
			return journal.runId;
		}

		it('restores the last completed session, lists the cut run as interrupted, and runs nothing of it again', async () => {
			const create = openAIAnswering();
			const before = await orchestrator();
			const { session } = await before.run('ship it', { signal });
			const snapshot = stored(before.snapshot());
			const cut = await diedWhileRunning(session ?? { id: 'none' });

			create.mockClear();
			const restored = await orchestrator({ restore: snapshot });
			const history = await createHistory({ root: repo, stateDirectory });
			expect((await history.list()).runs).toContainEqual(
				expect.objectContaining({ runId: cut, status: 'interrupted', session, files: ['a.txt'] }),
			);
			expect(create).not.toHaveBeenCalled();

			await expect(restored.run('carry on with the docs', { signal })).resolves.toMatchObject({
				session,
			});

			const planner = create.mock.calls
				.map(([request]) => request)
				.find(r => roleOf(r) === 'planner');
			const seen = JSON.stringify(planner?.input);
			expect(seen).toContain('ship it');
			expect(seen).toContain('carry on with the docs');
			// Snapshots never roll files back: what the cut run changed stays.
			expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('half');
		});
	});
});

describe('restoring a session snapshot that cannot be restored', () => {
	async function valid(): Promise<SessionSnapshot> {
		openAIAnswering();
		const agent = await orchestrator();
		await agent.run('ship it', { signal });
		return stored(agent.snapshot());
	}

	const broken: [string, (snapshot: SessionSnapshot) => unknown, string][] = [
		['is not an object', () => null, 'not an object'],
		[
			"is one agent's conversation",
			snapshot => snapshot.roles.planner,
			'not a snapshot of a composed',
		],
		[
			'is of another flow',
			snapshot => ({ ...snapshot, flow: 'workflow' }),
			'not of createLLMOrchestrator',
		],
		[
			'is a checkpoint inside a run',
			snapshot => ({ ...snapshot, boundary: 'stage' }),
			'not a checkpoint inside a run',
		],
		[
			'lacks a role',
			snapshot => ({
				...snapshot,
				roles: { planner: snapshot.roles.planner, executor: snapshot.roles.executor },
			}),
			'Its roles are executor, planner',
		],
		[
			'has a role the flow does not',
			snapshot => ({ ...snapshot, roles: { ...snapshot.roles, tester: snapshot.roles.planner } }),
			'Its roles are',
		],
		[
			"has a role's conversation that is malformed",
			snapshot => ({
				...snapshot,
				roles: { ...snapshot.roles, executor: { ...snapshot.roles.executor, turns: 'none' } },
			}),
			"The executor's conversation",
		],
		['has a key its format does not', snapshot => ({ ...snapshot, extra: 1 }), 'extra'],
		['has a session without an id', snapshot => ({ ...snapshot, session: {} }), 'no id'],
	];

	it.each(broken)(
		'refuses one that %s, before opening the workspace or building an agent',
		async (_, breakIt, cause) => {
			const restore = breakIt(await valid()) as SessionSnapshot;
			rmSync(stateDirectory, { recursive: true, force: true });
			vi.mocked(OpenAI).mockClear();

			const restoring = orchestrator({ restore });

			await expect(restoring).rejects.toThrow(InvalidSnapshotError);
			await expect(restoring).rejects.not.toThrow(UnsupportedSnapshotVersionError);
			await expect(restoring).rejects.toMatchObject({
				cause: expect.stringContaining(cause) as string,
			});
			expect(OpenAI).not.toHaveBeenCalled();
			expect(existsSync(stateDirectory)).toBe(false);
		},
	);

	it('refuses a version it cannot restore, of the session or of a role, with the version', async () => {
		const snapshot = await valid();

		await expect(orchestrator({ restore: { ...snapshot, version: 2 } as never })).rejects.toThrow(
			UnsupportedSnapshotVersionError,
		);
		const role = orchestrator({
			restore: {
				...snapshot,
				roles: { ...snapshot.roles, reviewer: { ...snapshot.roles.reviewer, version: 3 } },
			} as never,
		});
		await expect(role).rejects.toThrow(UnsupportedSnapshotVersionError);
		await expect(role).rejects.toMatchObject({
			version: 3,
			cause: expect.stringContaining("The reviewer's conversation") as string,
		});
		await expect(role).rejects.toThrow(UnrecoverableError);
	});

	it("refuses a session snapshot given to createLLMAgent, and one agent's given to the orchestrator", async () => {
		const snapshot = await valid();

		expect(() =>
			createLLMAgent('openai', { systemPrompt: '', logger, restore: snapshot as never }),
		).toThrow(InvalidSnapshotError);
		await expect(orchestrator({ restore: snapshot.roles.executor as never })).rejects.toThrow(
			InvalidSnapshotError,
		);
	});
});
