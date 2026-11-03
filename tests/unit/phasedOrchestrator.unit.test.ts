import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentResponse, ProgressEvent } from '../../src/agent/domain/agent.ts';
import type { RepositoryCommit } from '../../src/agent/domain/commitReport.ts';
import { Inbox } from '../../src/agent/domain/inbox.ts';
import type { Asker } from '../../src/agent/domain/question.ts';
import { RunContext, withRunContext } from '../../src/agent/domain/runContext.ts';
import type { ChangeLog } from '../../src/orchestration/domain/model/changeLog.ts';
import type { Committer, FrozenChanges } from '../../src/orchestration/domain/model/committer.ts';
import { PhasedOrchestrator } from '../../src/orchestration/domain/model/phasedOrchestrator.ts';
import type { PhaseLimits, Plan } from '../../src/orchestration/domain/model/phases.ts';
import type { Verification, Verifier } from '../../src/orchestration/domain/model/verification.ts';
import {
	phaseReportValidator,
	phaseReviewValidator,
	planValidator,
} from '../../src/orchestration/infrastructure/model/phaseValidators.ts';
import { isAbortError } from '../../src/shared/domain/isAbortError.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';

const signal = new AbortController().signal;
const tokens = { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0 };

/** An agent that answers from its script, in order, and records every prompt it got. */
function scripted(...answers: unknown[]) {
	const prompts: string[] = [];
	const run = vi.fn<Agent['run']>(prompt => {
		prompts.push(prompt);
		if (answers.length === 0) throw new Error('the fake agent ran out of answers');
		const next = answers.shift();
		const response: AgentResponse = {
			response: typeof next === 'string' ? next : JSON.stringify(next),
			duration: 1,
			tokens,
		};
		return Promise.resolve(response);
	});
	return { agent: { run } satisfies Agent, run, prompts };
}

function planOf(...goals: string[]): Plan {
	return {
		summary: `The task, in ${String(goals.length)}`,
		phases: goals.map(goal => ({ goal, files: [`${goal}.ts`], done: `${goal} works` })),
	};
}

const done = (summary: string) => ({ status: 'done', summary });
const approved = { decision: 'approved' };
const rejected = (feedback: string) => ({ decision: 'rejected', feedback });

/** A change log that marks each phase with a number and shows its diff by that number. */
function fakeChanges() {
	let marks = 0;
	const since = vi.fn<ChangeLog['since']>(mark => Promise.resolve(`diff since ${String(mark)}`));
	const mark = vi.fn<ChangeLog['mark']>(() => Promise.resolve(++marks));
	return { changes: { mark, since } satisfies ChangeLog, mark, since };
}

function verifierOf(...results: Verification[]) {
	const verify = vi.fn<Verifier['verify']>(() => {
		const next = results.shift();
		if (!next) throw new Error('the fake verifier ran out of results');
		return Promise.resolve(next);
	});
	return { verifier: { verify } satisfies Verifier, verify };
}

const passed: Verification = {
	met: true,
	checks: [{ command: 'test', status: 'passed', how: 'exited with code 0', output: '' }],
};
const failing: Verification = {
	met: false,
	checks: [{ command: 'test', status: 'failed', how: 'exited with code 1', output: '1 failed' }],
};

const frozen: FrozenChanges = {
	repositories: [
		{ repository: '/repo', branch: 'main', paths: ['a.ts'], leftOut: [], diff: 'diff', style: [] },
	],
};
const committed: RepositoryCommit = {
	repository: '/repo',
	branch: 'main',
	outcome: 'done',
	commits: [{ sha: 'a'.repeat(40), subject: 'Change a' }],
	paths: ['a.ts'],
	leftOut: [],
	unreviewed: [],
};

function fakeCommitter() {
	const freeze = vi.fn<Committer['freeze']>(() => Promise.resolve(frozen));
	const commit = vi.fn<Committer['commit']>(() => Promise.resolve([committed]));
	return { committer: { freeze, commit } satisfies Committer, freeze, commit };
}

function orchestrator({
	planner,
	executor,
	reviewer,
	changes = fakeChanges().changes,
	verifier,
	committer,
	committerAgent,
	autoCommit,
	limits,
	logger = { warn: vi.fn() },
}: {
	planner: Agent;
	executor: Agent;
	reviewer: Agent;
	changes?: ChangeLog;
	verifier?: Verifier;
	committer?: Committer;
	committerAgent?: Agent;
	autoCommit?: boolean;
	limits?: Partial<PhaseLimits>;
	logger?: { warn: (...args: unknown[]) => void };
}) {
	return new PhasedOrchestrator({
		planner,
		executor,
		reviewer,
		validators: {
			plan: planValidator,
			report: phaseReportValidator,
			review: phaseReviewValidator,
		},
		changes,
		...(verifier ? { verifier } : {}),
		...(committer ? { committer } : {}),
		...(committerAgent ? { createCommitter: () => committerAgent } : {}),
		...(autoCommit === undefined ? {} : { autoCommit }),
		...(limits ? { limits } : {}),
		logger,
	});
}

describe('the phased orchestrator', () => {
	it('carries out the plan phase by phase, each reviewed on its own diff', async () => {
		const planner = scripted(planOf('parse', 'render'));
		const executor = scripted(done('parsed'), done('rendered'));
		const reviewer = scripted(approved, approved);

		const result = await orchestrator({
			planner: planner.agent,
			executor: executor.agent,
			reviewer: reviewer.agent,
		}).run('Add a markdown preview', { signal });

		expect(result.response).toBe(
			'Carried out the plan in 2 phases:\n1. parse: parsed\n2. render: rendered',
		);
		expect(result.tokens).toEqual({ ...tokens, inputTokens: 5, outputTokens: 5 });
		expect(planner.prompts[0]).toContain('Add a markdown preview');
		// The executor gets the plan, never the request.
		for (const prompt of executor.prompts) expect(prompt).not.toContain('markdown preview');
		expect(executor.prompts[0]).toContain('Phase 1 of 2: parse');
		expect(executor.prompts[1]).toContain('Phase 2 of 2: render');
		expect(executor.prompts[1]).toContain('The executor said: parsed');
		expect(reviewer.prompts[0]).toContain('Phase 1 of 2: parse');
		expect(reviewer.prompts[0]).toContain('diff since 1');
		expect(reviewer.prompts[1]).toContain('diff since 2');
		expect(reviewer.prompts[1]).toContain('Add a markdown preview');
	});

	it('sends a rejection back to the executor with its feedback, and keeps the same executor', async () => {
		const executor = scripted(done('first try'), done('fixed'));
		const reviewer = scripted(rejected('the null case breaks'), approved);

		const result = await orchestrator({
			planner: scripted(planOf('parse')).agent,
			executor: executor.agent,
			reviewer: reviewer.agent,
		}).run('task', { signal });

		expect(result.response).toContain('1. parse: fixed');
		expect(executor.prompts[1]).toContain('Fix this first:\n---\nthe null case breaks');
		expect(executor.run).toHaveBeenCalledTimes(2);
	});

	it('sends a phase to the planner after rejections in a row, which replaces what is left', async () => {
		const planner = scripted(planOf('parse', 'render'), planOf('parse safely', 'render'));
		const executor = scripted(done('a'), done('b'), done('c'), done('d'));
		const reviewer = scripted(rejected('wrong'), rejected('still wrong'), approved, approved);

		const result = await orchestrator({
			planner: planner.agent,
			executor: executor.agent,
			reviewer: reviewer.agent,
		}).run('task', { signal });

		expect(planner.prompts[1]).toContain('Phase 1 cannot be finished as planned');
		expect(planner.prompts[1]).toContain('Rejected 2 times in a row; the last time:\nstill wrong');
		expect(executor.prompts[2]).toContain('Phase 1 of 2: parse safely');
		expect(executor.prompts[2]).not.toContain('Fix this first');
		expect(result.response).toBe(
			'Carried out the plan in 2 phases:\n1. parse safely: c\n2. render: d',
		);
	});

	it('ends the run unfinished, without throwing, once a phase used up its replans', async () => {
		const logger = { warn: vi.fn() };
		const executor = scripted(done('a'), done('b'), done('c'), done('d'));
		const reviewer = scripted(...['1', '2', '3', '4'].map(n => rejected(`no ${n}`)));

		const result = await orchestrator({
			planner: scripted(planOf('parse'), planOf('parse again')).agent,
			executor: executor.agent,
			reviewer: reviewer.agent,
			limits: { replans: 1 },
			logger,
		}).run('task', { signal });

		expect(result.response).toBe(
			'The task is unfinished: phase 1 of 1, "parse again", could not be completed after 1 replan. The last reason:\nRejected 2 times in a row; the last time:\nno 4\nWhat the phases changed stays on disk, uncommitted.',
		);
		expect(logger.warn).toHaveBeenCalledWith(result.response);
	});

	it('goes to the planner when the executor or the reviewer says the plan is wrong', async () => {
		const planner = scripted(planOf('parse'), planOf('tokenize'), planOf('lex'));
		const executor = scripted(
			{ status: 'replan', reason: 'there is no parser' },
			done('t'),
			done('l'),
		);
		const reviewer = scripted(
			{ decision: 'replan', feedback: 'tokens are the wrong level' },
			approved,
		);

		const result = await orchestrator({
			planner: planner.agent,
			executor: executor.agent,
			reviewer: reviewer.agent,
		}).run('task', { signal });

		expect(planner.prompts[1]).toContain('The executor: there is no parser');
		expect(planner.prompts[2]).toContain('The reviewer: tokens are the wrong level');
		expect(result.response).toBe('Carried out the plan in 1 phase:\n1. lex: l');
	});

	it('asks the planner again for a first plan past its phase limit', async () => {
		const planner = scripted(planOf('a', 'b'), planOf('all'));

		const result = await orchestrator({
			planner: planner.agent,
			executor: scripted(done('done')).agent,
			reviewer: scripted(approved).agent,
			limits: { phases: 1 },
		}).run('task', { signal });

		expect(planner.prompts[0]).toContain('at most 1 phases');
		expect(planner.prompts[1]).toContain('it did not match the schema');
		expect(result.response).toBe('Carried out the plan in 1 phase:\n1. all: done');
	});

	it('ends a replan that grows the plan past its phase limit', async () => {
		const result = await orchestrator({
			planner: scripted(planOf('a', 'b'), planOf('c', 'd')).agent,
			executor: scripted(done('a'), done('b'), done('c')).agent,
			reviewer: scripted(approved, { decision: 'replan', feedback: 'split it' }).agent,
			limits: { phases: 2 },
		}).run('task', { signal });

		expect(result.response).toContain('the plan grew past 2 phases, the most a run may hold');
	});

	describe('with the user to approve the plan', () => {
		it('asks once, and carries out the plan the user approves', async () => {
			const ask = vi.fn<Asker>(() => ['Approve']);

			const result = await orchestrator({
				planner: scripted(planOf('parse')).agent,
				executor: scripted(done('parsed')).agent,
				reviewer: scripted(approved).agent,
			}).run('task', { signal, ask });

			expect(ask).toHaveBeenCalledTimes(1);
			expect(ask.mock.calls[0]?.[0][0]?.question).toContain('Carry out this plan?');
			expect(ask.mock.calls[0]?.[0][0]?.question).toContain('1. parse');
			expect(result.response).toContain('1. parse: parsed');
		});

		it('plans again with what the user said, and asks again', async () => {
			const ask = vi
				.fn<Asker>()
				.mockReturnValueOnce(['Split it in two'])
				.mockReturnValue(['Approve']);
			const planner = scripted(planOf('all'), planOf('one', 'two'));

			const result = await orchestrator({
				planner: planner.agent,
				executor: scripted(done('1'), done('2')).agent,
				reviewer: scripted(approved, approved).agent,
			}).run('task', { signal, ask });

			expect(planner.prompts[1]).toContain("The user's answer to it:\n---\nSplit it in two");
			expect(ask).toHaveBeenCalledTimes(2);
			expect(result.response).toContain('2 phases');
		});

		it('ends with nothing done when the user stops it', async () => {
			const executor = scripted();

			const result = await orchestrator({
				planner: scripted(planOf('all')).agent,
				executor: executor.agent,
				reviewer: scripted().agent,
			}).run('task', { signal, ask: () => ['Stop'] });

			expect(result.response).toBe('The user stopped the task before it began.');
			expect(executor.run).not.toHaveBeenCalled();
		});

		it('fails as a host failure when the asker answers wrongly', async () => {
			await expect(
				orchestrator({
					planner: scripted(planOf('all')).agent,
					executor: scripted().agent,
					reviewer: scripted().agent,
				}).run('task', { signal, ask: () => [] }),
			).rejects.toSatisfy(error => error instanceof UnrecoverableError);
		});

		it('names why the asker failed', async () => {
			await expect(
				orchestrator({
					planner: scripted(planOf('all')).agent,
					executor: scripted().agent,
					reviewer: scripted().agent,
				}).run('task', { signal, ask: () => [] }),
			).rejects.toMatchObject({
				message: 'The asker failed',
				cause: 'It must answer the question with some text.',
			});
		});
	});

	describe('with required checks', () => {
		it('sends a phase whose checks fail back to the executor, with their output, before any review', async () => {
			const { verifier, verify } = verifierOf(failing, passed);
			const executor = scripted(done('first'), done('fixed'));
			const reviewer = scripted(approved);

			await orchestrator({
				planner: scripted(planOf('parse')).agent,
				executor: executor.agent,
				reviewer: reviewer.agent,
				verifier,
			}).run('task', { signal });

			expect(verify).toHaveBeenCalledTimes(2);
			expect(executor.prompts[1]).toContain(
				'The required checks do not pass for the files as they are:\n- test: failed, exited with code 1\n1 failed',
			);
			expect(reviewer.run).toHaveBeenCalledTimes(1);
			expect(reviewer.prompts[0]).toContain('The harness ran the required checks itself');
			expect(reviewer.prompts[0]).toContain('- test: passed, exited with code 0');
		});

		it('counts failing checks as rejections, so a phase that never passes reaches the planner', async () => {
			const planner = scripted(planOf('parse'), planOf('parse differently'));

			await orchestrator({
				planner: planner.agent,
				executor: scripted(done('a'), done('b'), done('c')).agent,
				reviewer: scripted(approved).agent,
				verifier: verifierOf(failing, failing, passed).verifier,
			}).run('task', { signal });

			expect(planner.prompts[1]).toContain('The required checks do not pass');
		});

		it('classifies a verifier that fails as a local failure', async () => {
			const verify = vi.fn<Verifier['verify']>(() => Promise.reject(new Error('git broke')));

			await expect(
				orchestrator({
					planner: scripted(planOf('parse')).agent,
					executor: scripted(done('a')).agent,
					reviewer: scripted().agent,
					verifier: { verify },
				}).run('task', { signal }),
			).rejects.toBeInstanceOf(UnrecoverableError);
		});
	});

	describe('with a committer', () => {
		it('freezes before the last review only, and commits once at the end with what the user approved', async () => {
			const { committer, freeze, commit } = fakeCommitter();
			const committerAgent = scripted('Add the preview');
			const ask = vi.fn<Asker>().mockReturnValueOnce(['Approve']).mockReturnValueOnce(['Commit']);

			const result = await orchestrator({
				planner: scripted(planOf('parse', 'render')).agent,
				executor: scripted(done('a'), done('b')).agent,
				reviewer: scripted(approved, approved).agent,
				committer,
				committerAgent: committerAgent.agent,
			}).run('task', { signal, ask });

			expect(freeze).toHaveBeenCalledTimes(1);
			expect(commit).toHaveBeenCalledWith(
				frozen,
				new Map([['/repo', 'Add the preview']]),
				expect.anything(),
			);
			expect(result.commits).toEqual({ outcome: 'committed', repositories: [committed] });
			// The committer's answer is paid for too.
			expect(result.tokens).toEqual({ ...tokens, inputTokens: 6, outputTokens: 6 });
			expect(committerAgent.prompts[0]).toContain('1. parse');
		});

		it('keeps the inbox from the committer, so what the user sends meanwhile stays for the next run', async () => {
			const committerAgent = scripted('Parse');
			const inbox = new Inbox();
			inbox.send('also rename b');

			await orchestrator({
				planner: scripted(planOf('parse')).agent,
				executor: scripted(done('a')).agent,
				reviewer: scripted(approved).agent,
				committer: fakeCommitter().committer,
				committerAgent: committerAgent.agent,
				autoCommit: true,
			}).run('task', { signal, inbox });

			expect(committerAgent.run.mock.calls[0]?.[1].inbox).toBeUndefined();
			expect(inbox.close()).toEqual(['also rename b']);
		});

		it('commits without asking with autoCommit, and not at all inside another run', async () => {
			const first = fakeCommitter();
			const own = await orchestrator({
				planner: scripted(planOf('parse')).agent,
				executor: scripted(done('a')).agent,
				reviewer: scripted(approved).agent,
				committer: first.committer,
				committerAgent: scripted('Parse').agent,
				autoCommit: true,
			}).run('task', { signal });
			expect(own.commits?.outcome).toBe('committed');

			const second = fakeCommitter();
			const context = new RunContext({ id: 'outer' });
			const inner = await orchestrator({
				planner: scripted(planOf('parse')).agent,
				executor: scripted(done('a')).agent,
				reviewer: scripted(approved).agent,
				committer: second.committer,
				committerAgent: scripted('Parse').agent,
				autoCommit: true,
			}).run('task', withRunContext({ signal }, context));
			expect(second.freeze).not.toHaveBeenCalled();
			expect(inner).not.toHaveProperty('commits');
			expect(inner).not.toHaveProperty('runId');
		});
	});

	it("names each role in its agents' events", async () => {
		const events: ProgressEvent[] = [];
		const talking = (role: string, answer: unknown): Agent => ({
			run: (_prompt, options) => {
				options.onProgress?.({ type: 'agentMessage', message: role });
				return Promise.resolve({ response: JSON.stringify(answer), duration: 1 });
			},
		});

		await orchestrator({
			planner: talking('planner', planOf('parse')),
			executor: talking('executor', done('a')),
			reviewer: talking('reviewer', approved),
		}).run('task', { signal, onProgress: event => events.push(event) });

		expect(events.filter(({ type }) => type === 'agentMessage')).toEqual([
			{ type: 'agentMessage', message: 'planner', agent: 'planner' },
			{ type: 'agentMessage', message: 'executor', agent: 'executor' },
			{ type: 'agentMessage', message: 'reviewer', agent: 'reviewer' },
		]);
	});

	it('keeps each role agent across runs, so the CLI goes on with its conversations', async () => {
		const executor = scripted(done('a'), done('b'));
		const phased = orchestrator({
			planner: scripted(planOf('one'), planOf('two')).agent,
			executor: executor.agent,
			reviewer: scripted(approved, approved).agent,
		});

		await phased.run('first', { signal });
		await phased.run('second', { signal });

		expect(executor.run).toHaveBeenCalledTimes(2);
	});

	it('stops on cancellation', async () => {
		const controller = new AbortController();
		const executor: Agent = {
			run: () => {
				controller.abort();
				return Promise.resolve({ response: JSON.stringify(done('a')), duration: 1 });
			},
		};

		await expect(
			orchestrator({
				planner: scripted(planOf('parse')).agent,
				executor,
				reviewer: scripted().agent,
			}).run('task', { signal: controller.signal }),
		).rejects.toSatisfy(isAbortError);
	});

	it('refuses a limit that is not a positive integer', () => {
		expect(() =>
			orchestrator({
				planner: scripted().agent,
				executor: scripted().agent,
				reviewer: scripted().agent,
				limits: { rejections: 0 },
			}),
		).toThrow(new RangeError('limits.rejections must be a positive integer'));
	});
});
