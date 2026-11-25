import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type ComposedSessionSnapshot,
	type CreateLLMOrchestratorOptions,
	createLLMOrchestrator,
	isAbortError,
	RunInProgressError,
	type WorkspaceOptions,
} from '../../src/index.ts';
import { parseComposedSessionSnapshot } from '../../src/orchestration/domain/model/composedSessionSnapshot.ts';

vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

type Role = 'planner' | 'executor' | 'reviewer';
const roles: Role[] = ['planner', 'executor', 'reviewer'];

// Each role's answer: the planner plans one phase, the executor reports it done, and the
// reviewer approves it. The executor's answer carries a marker its own history alone holds.
const answers: Record<Role, string> = {
	planner: JSON.stringify({
		summary: 'plan',
		phases: [{ goal: 'Change it', files: [], done: 'It is changed' }],
	}),
	executor: JSON.stringify({ status: 'done', summary: 'EXECUTOR-MARK: changed it' }),
	reviewer: JSON.stringify({ decision: 'approved' }),
};

const signal = new AbortController().signal;

/** Which role sent a request, from the `ROLE <name>` each role's system prompt starts with. */
function roleOf(request: { instructions?: unknown }): Role {
	const role = roles.find(name => String(request.instructions).includes(`ROLE ${name}`));
	if (role === undefined) throw new Error(`no role in ${String(request.instructions)}`);
	return role;
}

function answer(role: Role): Promise<Response> {
	return Promise.resolve({
		status: 'completed',
		incomplete_details: null,
		error: null,
		output: [
			{
				type: 'message',
				id: `msg-${role}`,
				role: 'assistant',
				status: 'completed',
				content: [{ type: 'output_text', text: answers[role], annotations: [] }],
			},
		],
		usage: {
			input_tokens: 10,
			input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 15,
		},
	} as unknown as Response);
}

/** Every role's request goes to `reply`, which answers it; returns the spy that records them. */
function modelReplying(reply: (role: Role) => Promise<Response> = answer) {
	const create = vi.fn((request: { instructions?: unknown }) => reply(roleOf(request)));
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return create;
}

interface Sent {
	instructions: unknown;
	input: unknown;
}

/** What each request from `from` on sent, as the model saw its system prompt and input. */
function sentFrom(create: { mock: { calls: unknown[][] } }, from: number): Sent[] {
	return create.mock.calls.slice(from).map(([request]) => {
		const { instructions, input } = request as Sent;
		return { instructions, input };
	});
}

const createLogger = () => ({ warn: vi.fn() });

describe('ModelAPIOrchestrator.snapshot', () => {
	let parent: string;
	let repo: string;
	let workspace: WorkspaceOptions;

	beforeEach(() => {
		parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-snapshot-')));
		repo = join(parent, 'repo');
		mkdirSync(repo);
		execFileSync('git', ['init', '--quiet'], { cwd: repo });
		workspace = {
			roots: [{ path: repo, access: 'write' }],
			stateDirectory: join(parent, 'state'),
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
		rmSync(parent, { recursive: true, force: true });
	});

	const options = (
		overrides: Partial<CreateLLMOrchestratorOptions> = {},
	): CreateLLMOrchestratorOptions => ({
		provider: 'openai',
		workspace,
		systemPrompts: {
			planner: 'ROLE planner.',
			executor: 'ROLE executor.',
			reviewer: 'ROLE reviewer.',
		},
		logger: createLogger(),
		...overrides,
	});

	const roundTrip = (saved: ComposedSessionSnapshot) =>
		JSON.parse(JSON.stringify(saved)) as ComposedSessionSnapshot;

	it('saves each role as plain data, with no subagent or committer records', async () => {
		modelReplying();
		const orchestrator = await createLLMOrchestrator(options());

		const saved = orchestrator.snapshot();

		expect(Object.keys(saved).sort()).toEqual(['auxiliary', 'kind', 'roles', 'version']);
		expect(Object.keys(saved.roles).sort()).toEqual(['executor', 'planner', 'reviewer']);
		for (const role of roles) {
			expect(Object.keys(saved.roles[role]).sort()).toEqual(['children', 'conversation']);
			expect(saved.roles[role].children).toEqual([]);
		}
		expect(saved.auxiliary).toEqual([]);
		expect(parseComposedSessionSnapshot(roundTrip(saved))).toEqual(saved);
	});

	it('continues a restored session as an uninterrupted one would', async () => {
		const create = modelReplying();
		const first = await createLLMOrchestrator(options());
		await first.run('first task', { signal });
		const saved = roundTrip(first.snapshot());

		const beforeUninterrupted = create.mock.calls.length;
		await first.run('second task', { signal });
		const uninterrupted = sentFrom(create, beforeUninterrupted);

		const resumed = await createLLMOrchestrator(options({ snapshot: saved }));
		const beforeResumed = create.mock.calls.length;
		await resumed.run('second task', { signal });

		expect(uninterrupted).toHaveLength(3);
		expect(sentFrom(create, beforeResumed)).toEqual(uninterrupted);
	});

	it("keeps each role's history its own", async () => {
		modelReplying();
		const orchestrator = await createLLMOrchestrator(options());
		await orchestrator.run('task', { signal });

		const { planner, executor } = orchestrator.snapshot().roles;
		expect(JSON.stringify(executor.conversation)).toContain('EXECUTOR-MARK');
		expect(JSON.stringify(planner.conversation)).not.toContain('EXECUTOR-MARK');
		for (const role of roles) {
			expect(orchestrator.snapshot().roles[role].conversation.turns.length).toBeGreaterThan(0);
		}
	});

	it('gives a restored session the prompts it is created with, and keeps its history', async () => {
		const create = modelReplying();
		const first = await createLLMOrchestrator(options());
		await first.run('first task', { signal });
		const saved = roundTrip(first.snapshot());

		const before = create.mock.calls.length;
		const resumed = await createLLMOrchestrator(
			options({
				snapshot: saved,
				systemPrompts: {
					planner: 'ROLE planner, changed.',
					executor: 'ROLE executor, changed.',
					reviewer: 'ROLE reviewer, changed.',
				},
			}),
		);
		await resumed.run('second task', { signal });

		const sent = sentFrom(create, before);
		expect(sent.map(request => request.instructions)).toEqual([
			expect.stringMatching(/^ROLE planner, changed\./),
			expect.stringMatching(/^ROLE executor, changed\./),
			expect.stringMatching(/^ROLE reviewer, changed\./),
		]);
		expect(JSON.stringify(sent[0]?.input)).toContain('first task');
		expect(JSON.stringify(sent[0]?.input)).toContain('second task');
	});

	it('refuses to save while a run is in progress, in any role', async () => {
		const refusals: unknown[] = [];
		modelReplying(role => {
			try {
				orchestrator.snapshot();
			} catch (error) {
				refusals.push(error);
			}
			return answer(role);
		});
		const orchestrator = await createLLMOrchestrator(options());

		await orchestrator.run('task', { signal });

		expect(refusals).toHaveLength(3);
		for (const refusal of refusals) {
			expect(refusal).toBeInstanceOf(RunInProgressError);
			expect(refusal).toHaveProperty(
				'message',
				'The agent has a run in progress, so it cannot be saved yet',
			);
		}
		expect(orchestrator.snapshot().roles.planner.conversation.turns.length).toBeGreaterThan(0);
	});

	it('saves a session after a failed run, which then resumes as the failed one continues', async () => {
		const controller = new AbortController();
		let failing = false;
		const create = modelReplying(role => {
			if (failing && role === 'executor') {
				controller.abort();
				return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
			}
			return answer(role);
		});
		const orchestrator = await createLLMOrchestrator(options());
		await orchestrator.run('first task', { signal });

		failing = true;
		const failure = await orchestrator.run('second task', { signal: controller.signal }).then(
			() => undefined,
			(error: unknown) => error,
		);
		failing = false;
		expect(isAbortError(failure)).toBe(true);
		const saved = roundTrip(orchestrator.snapshot());

		const beforeContinued = create.mock.calls.length;
		await orchestrator.run('third task', { signal });
		const continued = sentFrom(create, beforeContinued);

		const resumed = await createLLMOrchestrator(options({ snapshot: saved }));
		const beforeResumed = create.mock.calls.length;
		await resumed.run('third task', { signal });

		expect(continued).toHaveLength(3);
		expect(sentFrom(create, beforeResumed)).toEqual(continued);
	});
});
