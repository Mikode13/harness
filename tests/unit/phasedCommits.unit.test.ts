import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentResponse } from '../../src/agent/domain/agent.ts';
import type { RepositoryCommit } from '../../src/agent/domain/commitReport.ts';
import { Inbox } from '../../src/agent/domain/inbox.ts';
import type { Verification } from '../../src/agent/domain/phaseResult.ts';
import type { Asker, UserQuestion } from '../../src/agent/domain/question.ts';
import {
	RecoverableCommittedRunError,
	UnrecoverableCommittedRunError,
} from '../../src/agent/domain/committedRunError.ts';
import { RunContext, runContextOf, withRunContext } from '../../src/agent/domain/runContext.ts';
import type { ChangeLog } from '../../src/orchestration/domain/model/changeLog.ts';
import type {
	Committer,
	FrozenChanges,
	FrozenRepository,
} from '../../src/orchestration/domain/model/committer.ts';
import { PhasedOrchestrator } from '../../src/orchestration/domain/model/phasedOrchestrator.ts';
import type { CommitQuestion, Plan } from '../../src/orchestration/domain/model/phases.ts';
import type { Verifier } from '../../src/orchestration/domain/model/verification.ts';
import {
	phaseReportValidator,
	phaseReviewValidator,
	planValidator,
} from '../../src/orchestration/infrastructure/model/phaseValidators.ts';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/shared/domain/errors.ts';
import { isAbortError } from '../../src/shared/domain/isAbortError.ts';

const tokens = { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0 };

function respond(response: string): AgentResponse {
	return { response, duration: 1, tokens };
}

/** An agent that answers from its script, in order: text as it is, anything else as JSON. */
function scripted(...responses: unknown[]) {
	const run = vi.fn<Agent['run']>(() => {
		if (responses.length === 0) throw new Error('the fake agent ran out of responses');
		const next = responses.shift();
		return Promise.resolve(respond(typeof next === 'string' ? next : JSON.stringify(next)));
	});
	return { agent: { run } satisfies Agent, run };
}

function planOf(...goals: string[]): Plan {
	return {
		summary: 'The task',
		phases: goals.map(goal => ({ goal, files: [`${goal}.txt`], done: `${goal} works` })),
	};
}

const done = (summary: string) => ({ status: 'done', summary });
const approved = { decision: 'approved' };

const repository: FrozenRepository = {
	repository: '/repo',
	branch: 'main',
	paths: ['a.txt'],
	leftOut: [{ path: 'b.txt', reason: 'it held changes of yours before this task' }],
	diff: 'diff --git a/a.txt b/a.txt',
	style: ['feat: earlier'],
};

const committed: RepositoryCommit = {
	repository: '/repo',
	branch: 'main',
	outcome: 'done',
	commits: [{ sha: 'a'.repeat(40), subject: 'Change a' }],
	paths: ['a.txt'],
	leftOut: [{ path: 'b.txt', reason: 'it held changes of yours before this task' }],
	unreviewed: [],
};

function fakeCommitter(frozen: FrozenChanges = { repositories: [repository] }) {
	const freeze = vi.fn<Committer['freeze']>(() => Promise.resolve(frozen));
	const commit = vi.fn<Committer['commit']>(() => Promise.resolve([committed]));
	return { committer: { freeze, commit } satisfies Committer, freeze, commit };
}

const changes: ChangeLog = { mark: () => Promise.resolve(0), since: () => Promise.resolve('diff') };

const logger = { warn: vi.fn() };

function orchestrator({
	goals = ['a'],
	committer = fakeCommitter().committer,
	committerAgent = scripted('Change a').agent,
	autoCommit = false,
	commitQuestion,
	verifier,
	reviews = [approved],
	executor = scripted(...reviews.map((_, index) => done(String(index)))).agent,
	planner = scripted(planOf(...goals)).agent,
}: {
	executor?: Agent;
	planner?: Agent;
	goals?: string[];
	committer?: Committer;
	committerAgent?: Agent;
	autoCommit?: boolean;
	commitQuestion?: CommitQuestion;
	verifier?: Verifier;
	reviews?: unknown[];
} = {}) {
	return new PhasedOrchestrator({
		planner,
		executor,
		reviewer: scripted(...reviews).agent,
		validators: { plan: planValidator, report: phaseReportValidator, review: phaseReviewValidator },
		changes,
		...(verifier ? { verifier } : {}),
		committer,
		createCommitter: () => committerAgent,
		autoCommit,
		...(commitQuestion ? { commitQuestion } : {}),
		logger,
	});
}

const signal = new AbortController().signal;

/** Approves the plan, and answers `commit` to every question about a commit. */
function asker(commit = 'Commit', plan = 'Approve') {
	return vi.fn<Asker>(([question]) => (isPlanQuestion(question) ? [plan] : [commit]));
}

function isPlanQuestion(question: UserQuestion | undefined): boolean {
	return question?.question.startsWith('Carry out this plan?') ?? false;
}

/** The questions about a commit the asker was asked, by their text. */
function commitQuestionsOf(ask: ReturnType<typeof asker>): string[] {
	return ask.mock.calls
		.map(([[question]]) => question)
		.filter(question => !isPlanQuestion(question))
		.map(question => question?.question ?? '');
}

describe("the phased orchestrator's committer", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('asks once the reviewer approves, has the committer write the message, and reports the commit', async () => {
		const { committer, freeze, commit } = fakeCommitter();
		const writer = scripted('```\nChange a\n```');
		const ask = asker();

		const response = await orchestrator({ committer, committerAgent: writer.agent }).run('task', {
			signal,
			ask,
			approve: () => ({ approved: true }),
		});

		expect(freeze).toHaveBeenCalledOnce();
		expect(commitQuestionsOf(ask)).toEqual([
			'The reviewer approved the change. Commit it? It would commit 1 file in /repo on main. 1 file the task changed would be left out: b.txt (it held changes of yours before this task).',
		]);
		const [prompt, options] = writer.run.mock.calls[0] ?? [];
		expect(prompt).toContain('Original user request:\n---\ntask\n---');
		expect(prompt).toContain('- feat: earlier');
		expect(prompt).toContain('diff --git a/a.txt b/a.txt');
		// It writes a message only: nothing to ask, nothing to approve.
		expect(options).toMatchObject({ ask: undefined, approve: undefined });
		expect(commit.mock.calls[0]?.[1]).toEqual(new Map([['/repo', 'Change a']]));
		expect(response.commits).toEqual({ outcome: 'committed', repositories: [committed] });
		// The committer's message was billed with the rest.
		expect(response.tokens?.inputTokens).toBe(4);
	});

	it('names in the question a repository nothing would be committed in, and what it leaves out', async () => {
		const { committer } = fakeCommitter({
			repositories: [
				repository,
				{
					repository: '/other',
					branch: 'main',
					paths: [],
					leftOut: [{ path: 'c.txt', reason: 'it changed after the task last changed it' }],
					diff: '',
					style: [],
				},
			],
		});
		const ask = asker();

		await orchestrator({ committer }).run('task', { signal, ask });

		expect(commitQuestionsOf(ask)).toEqual([
			'The reviewer approved the change. Commit it? It would commit 1 file in /repo on main. Nothing would be committed in /other: nothing the run changed there can be committed. 2 files the task changed would be left out: b.txt (it held changes of yours before this task), c.txt (it changed after the task last changed it).',
		]);
	});

	it('writes each message with a new committer, so none carries an earlier commit', async () => {
		const createCommitter = vi.fn(() => scripted('Change a').agent);
		const agent = new PhasedOrchestrator({
			planner: scripted(planOf('a'), planOf('b')).agent,
			executor: scripted(done('a'), done('b')).agent,
			reviewer: scripted(approved, approved).agent,
			validators: {
				plan: planValidator,
				report: phaseReportValidator,
				review: phaseReviewValidator,
			},
			changes,
			committer: fakeCommitter().committer,
			createCommitter,
			logger,
		});

		await agent.run('task', { signal, ask: asker() });
		await agent.run('another task', { signal, ask: asker() });

		expect(createCommitter).toHaveBeenCalledTimes(2);
	});

	it("names the committer's progress as its own", async () => {
		const writer: Agent = {
			run: (_prompt, { onProgress }) => {
				onProgress?.({ type: 'reasoning', message: 'writing' });
				return Promise.resolve(respond('Change a'));
			},
		};
		const events: unknown[] = [];

		await orchestrator({ committerAgent: writer }).run('task', {
			signal,
			ask: asker(),
			onProgress: event => events.push(event),
		});

		expect(events).toContainEqual({ type: 'reasoning', message: 'writing', agent: 'committer' });
	});

	it('keeps the inbox from the committer, so what the user sends meanwhile stays for the next run', async () => {
		const { agent, run } = scripted('Change a');
		const inbox = new Inbox();
		const ask: Asker = ([question]) => {
			inbox.send('also rename b');
			return isPlanQuestion(question) ? ['Approve'] : ['Commit'];
		};

		await orchestrator({ committerAgent: agent }).run('task', { signal, ask, inbox });

		expect(run.mock.calls[0]?.[1].inbox).toBeUndefined();
		expect(inbox.close()).toEqual(['also rename b', 'also rename b']);
	});

	it('commits nothing, and reports it declined, when the user answers anything but Commit', async () => {
		const { committer, commit } = fakeCommitter();

		const response = await orchestrator({ committer }).run('task', {
			signal,
			ask: asker('commit it, but later'),
		});

		expect(commit).not.toHaveBeenCalled();
		expect(response.commits).toEqual({ outcome: 'declined', repositories: [] });
	});

	it('commits without asking with autoCommit', async () => {
		const { committer, commit } = fakeCommitter();

		const response = await orchestrator({ committer, autoCommit: true }).run('task', { signal });

		expect(commit).toHaveBeenCalledOnce();
		expect(response.commits?.outcome).toBe('committed');
	});

	it('does nothing with nobody to ask and no autoCommit, not even freeze the changes', async () => {
		const { committer, freeze } = fakeCommitter();

		const response = await orchestrator({ committer }).run('task', { signal });

		expect(freeze).not.toHaveBeenCalled();
		expect(response).not.toHaveProperty('commits');
	});

	it("commits nothing in another agent's run, whose changes are not all its own", async () => {
		const { committer, freeze } = fakeCommitter();
		const outer = new RunContext({ id: 'outer-session' });

		const response = await orchestrator({ committer }).run(
			'task',
			withRunContext({ signal, ask: asker() }, outer),
		);

		expect(freeze).not.toHaveBeenCalled();
		expect(response).not.toHaveProperty('commits');
	});

	it('asks nothing for a run that changed no file', async () => {
		const ask = asker();
		const unchanged: Committer = { freeze: () => Promise.resolve(undefined), commit: vi.fn() };

		const response = await orchestrator({ committer: unchanged }).run('task', { signal, ask });

		expect(commitQuestionsOf(ask)).toEqual([]);
		expect(response).not.toHaveProperty('commits');
	});

	it('asks nothing, and reports why, when nothing the run changed can be committed', async () => {
		const ask = asker();
		const detached = { ...repository, paths: [], refused: 'no branch is checked out there' };

		const response = await orchestrator({
			committer: fakeCommitter({ repositories: [detached] }).committer,
		}).run('task', { signal, ask });

		expect(commitQuestionsOf(ask)).toEqual([]);
		expect(response.commits).toEqual({
			outcome: 'nothing',
			repositories: [
				expect.objectContaining({
					outcome: 'left',
					reason: 'no branch is checked out there',
					leftOut: repository.leftOut,
				}),
			],
		});
		expect(logger.warn).toHaveBeenCalledWith(
			'The committer made no commit in /repo: no branch is checked out there',
		);
	});

	it('commits what was frozen before the review that approved, not an earlier one', async () => {
		const first = { repositories: [{ ...repository, paths: ['old.txt'] }] };
		const second = { repositories: [repository] };
		const freeze = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const commit = vi.fn().mockResolvedValue([committed]);

		await orchestrator({
			committer: { freeze, commit },
			reviews: [{ decision: 'rejected', feedback: 'fix it' }, approved],
		}).run('task', { signal, ask: asker() });

		expect(freeze).toHaveBeenCalledTimes(2);
		expect(commit.mock.calls[0]?.[0]).toBe(second);
	});

	it('leaves out a repository the committer wrote no message for', async () => {
		const { committer, commit } = fakeCommitter();

		await orchestrator({ committer, committerAgent: scripted('  ').agent }).run('task', {
			signal,
			ask: asker(),
		});

		expect(commit.mock.calls[0]?.[1]).toEqual(new Map());
	});

	it('reports a commit git refused as failed, and the run still succeeds', async () => {
		const rejected: RepositoryCommit = {
			...committed,
			outcome: 'rejected',
			reason: 'lint failed',
			commits: [],
			paths: [],
		};
		const commit = vi.fn().mockResolvedValue([rejected]);

		const response = await orchestrator({
			committer: { freeze: fakeCommitter().freeze, commit },
		}).run('task', { signal, ask: asker() });

		expect(response.commits).toEqual({ outcome: 'failed', repositories: [rejected] });
		expect(logger.warn).toHaveBeenCalledWith('The committer made no commit in /repo: lint failed');
	});

	it('tells the logger when git failed after it made the commit', async () => {
		const late: RepositoryCommit = {
			...committed,
			reason: 'git ran past its limit and was stopped',
		};
		const commit = vi.fn<Committer['commit']>(() => Promise.resolve([late]));

		const response = await orchestrator({
			committer: { freeze: fakeCommitter().freeze, commit },
		}).run('task', { signal, ask: asker() });

		expect(response.commits?.outcome).toBe('committed');
		expect(logger.warn).toHaveBeenCalledWith(
			"The committer's commit in /repo was made, but git failed after it: git ran past its limit and was stopped",
		);
	});

	it('ends the run with an UnrecoverableError when the asker fails or answers wrongly about the commit', async () => {
		const failing: Asker = ([question]) => {
			if (isPlanQuestion(question)) return ['Approve'];
			throw new Error('terminal gone');
		};
		const silent: Asker = ([question]) => (isPlanQuestion(question) ? ['Approve'] : []);

		await expect(orchestrator().run('task', { signal, ask: failing })).rejects.toBeInstanceOf(
			UnrecoverableError,
		);
		await expect(orchestrator().run('task', { signal, ask: silent })).rejects.toBeInstanceOf(
			UnrecoverableError,
		);
	});

	it('ends with the cancellation when the run is cancelled while the user is asked', async () => {
		const controller = new AbortController();
		const { committer, commit } = fakeCommitter();

		await expect(
			orchestrator({ committer }).run('task', {
				signal: controller.signal,
				ask: ([question]) => {
					if (isPlanQuestion(question)) return ['Approve'];
					controller.abort();
					return ['Commit'];
				},
			}),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(commit).not.toHaveBeenCalled();
	});

	it('ends the run with an UnrecoverableError when git cannot be read', async () => {
		const freeze = vi.fn().mockRejectedValue(new Error('git is gone'));

		await expect(
			orchestrator({ committer: { freeze, commit: vi.fn() } }).run('task', {
				signal,
				ask: asker(),
			}),
		).rejects.toBeInstanceOf(UnrecoverableError);
	});

	describe('after each phase', () => {
		it('asks after each approved phase, names it, and reports each commit with its phase', async () => {
			const { committer, freeze, commit } = fakeCommitter();
			const writer = scripted('Change a', 'Change b');
			const ask = asker();

			const response = await orchestrator({
				goals: ['a', 'b'],
				committer,
				committerAgent: writer.agent,
				commitQuestion: 'phase',
				reviews: [approved, approved],
			}).run('task', { signal, ask });

			expect(freeze).toHaveBeenCalledTimes(2);
			expect(commit).toHaveBeenCalledTimes(2);
			expect(commitQuestionsOf(ask).map(question => question.split('. Commit it?')[0])).toEqual([
				'The reviewer approved phase 1 of 2, "a"',
				'The reviewer approved phase 2 of 2, "b"',
			]);
			expect(writer.run.mock.calls[1]?.[0]).toContain(
				'This commit is for phase 2 of 2, "b", and any earlier phase left uncommitted.',
			);
			expect(response.phases?.map(phase => phase.commits?.outcome)).toEqual([
				'committed',
				'committed',
			]);
			expect(response.commits).toEqual({
				outcome: 'committed',
				repositories: [committed, committed],
			});
		});

		it('asks again with the next phase after the user declines one, and the run commits', async () => {
			const { committer, commit } = fakeCommitter();
			const ask = vi
				.fn<Asker>()
				.mockReturnValueOnce(['Approve'])
				.mockReturnValueOnce(['Not yet'])
				.mockReturnValueOnce(['Commit']);

			const response = await orchestrator({
				goals: ['a', 'b'],
				committer,
				commitQuestion: 'phase',
				reviews: [approved, approved],
			}).run('task', { signal, ask });

			expect(commit).toHaveBeenCalledOnce();
			expect(response.phases?.map(phase => phase.commits?.outcome)).toEqual([
				'declined',
				'committed',
			]);
			expect(response.commits?.outcome).toBe('committed');
		});

		/** An executor that carries out the first phase, writing as run `run-1`, and then fails with `failure`. */
		function failingAfterOne(failure: unknown): Agent {
			const run = vi
				.fn<Agent['run']>()
				.mockImplementationOnce((_prompt, options) => {
					const context = runContextOf(options);
					if (context) context.historyRunOf('workspace').runId = 'run-1';
					return Promise.resolve(respond(JSON.stringify(done('0'))));
				})
				.mockRejectedValueOnce(failure);
			return { run };
		}

		it.each([
			[
				'recoverable',
				new RecoverableError('Overloaded', { cause: 'busy', tokens }),
				RecoverableCommittedRunError,
			],
			[
				'unrecoverable',
				new UnrecoverableError('Out of steps', { cause: 'the limit', tokens }),
				UnrecoverableCommittedRunError,
			],
		])(
			'fails a run with what it committed when a %s failure ends it after a commit',
			async (_, failure, kind) => {
				const promise = orchestrator({
					goals: ['a', 'b'],
					commitQuestion: 'phase',
					autoCommit: true,
					reviews: [approved, approved],
					executor: failingAfterOne(failure),
				}).run('task', { signal });

				await expect(promise).rejects.toBeInstanceOf(kind);
				const error = await promise.catch((caught: unknown) => caught);
				// The same failure, and the same kind of it, with what stays in git.
				expect(error).toBeInstanceOf(failure.constructor);
				expect(error).toMatchObject({
					message: failure.message,
					cause: failure.cause,
					stack: failure.stack,
					runId: 'run-1',
					commits: { outcome: 'committed', repositories: [committed] },
					phases: [
						{
							goal: 'a',
							status: 'approved',
							summary: '0',
							commits: { outcome: 'committed', repositories: [committed] },
						},
						{ goal: 'b', status: 'unfinished' },
					],
				});
				// The executor's, the reviewer's and the committer's answers, and the failure's own.
				expect((error as RecoverableError).tokens).toEqual({
					...tokens,
					inputTokens: 5,
					outputTokens: 5,
				});
			},
		);

		it('reports the phases of the plan as the planner last changed it', async () => {
			const failure = new UnrecoverableError('Out of steps', { cause: 'the limit' });
			const run = vi
				.fn<Agent['run']>()
				.mockResolvedValueOnce(respond(JSON.stringify(done('0'))))
				.mockResolvedValueOnce(respond(JSON.stringify({ status: 'replan', reason: 'no b' })))
				.mockRejectedValueOnce(failure);

			const error = await orchestrator({
				goals: ['a', 'b'],
				planner: scripted(planOf('a', 'b'), planOf('c', 'd')).agent,
				commitQuestion: 'phase',
				autoCommit: true,
				reviews: [approved],
				executor: { run },
			})
				.run('task', { signal })
				.catch((caught: unknown) => caught);

			expect((error as UnrecoverableCommittedRunError).phases).toEqual([
				expect.objectContaining({ goal: 'a', status: 'approved' }),
				{ goal: 'c', status: 'unfinished' },
				{ goal: 'd', status: 'pending' },
			]);
		});

		it('fails as it would with nothing committed, the first phase declined', async () => {
			const failure = new UnrecoverableError('Out of steps', { cause: 'the limit' });
			const ask = vi.fn<Asker>().mockReturnValueOnce(['Approve']).mockReturnValueOnce(['Not yet']);

			const error = await orchestrator({
				goals: ['a', 'b'],
				commitQuestion: 'phase',
				reviews: [approved, approved],
				executor: failingAfterOne(failure),
			})
				.run('task', { signal, ask })
				.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(UnrecoverableError);
			expect(error).not.toBeInstanceOf(UnrecoverableCommittedRunError);
		});

		it('fails with the commit when the progress callback fails once it is made', async () => {
			const error = await orchestrator({ autoCommit: true })
				.run('task', {
					signal,
					onProgress: event => {
						if (event.type === 'workflowTransition' && event.stage === 'commit') {
							throw new Error('the host broke');
						}
					},
				})
				.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(UnrecoverableCommittedRunError);
			expect(error).toMatchObject({
				commits: { outcome: 'committed', repositories: [committed] },
				phases: [{ goal: 'a', status: 'approved' }],
			});
		});

		it('lets a cancellation after a commit through as it is', async () => {
			const controller = new AbortController();
			const run = vi
				.fn<Agent['run']>()
				.mockResolvedValueOnce(respond(JSON.stringify(done('0'))))
				.mockImplementationOnce(() => {
					controller.abort();
					return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
				});

			await expect(
				orchestrator({
					goals: ['a', 'b'],
					commitQuestion: 'phase',
					autoCommit: true,
					reviews: [approved, approved],
					executor: { run },
				}).run('task', { signal: controller.signal }),
			).rejects.toSatisfy(isAbortError);
		});

		it('commits each phase without asking with autoCommit', async () => {
			const { committer, commit } = fakeCommitter();

			await orchestrator({
				goals: ['a', 'b'],
				committer,
				committerAgent: scripted('Change a', 'Change b').agent,
				commitQuestion: 'phase',
				autoCommit: true,
				reviews: [approved, approved],
			}).run('task', { signal });

			expect(commit).toHaveBeenCalledTimes(2);
		});
	});

	describe('with the plan', () => {
		it.each([
			['Approve, commit at the end', 1],
			['Approve, commit each phase', 2],
			['Approve, do not commit', 0],
		])('lets the user choose how to commit: %s', async (answer, commits) => {
			const { committer, commit } = fakeCommitter();
			const ask = vi.fn<Asker>(() => [answer]);

			await orchestrator({
				goals: ['a', 'b'],
				committer,
				committerAgent: scripted('Change a', 'Change b').agent,
				commitQuestion: 'plan',
				reviews: [approved, approved],
			}).run('task', { signal, ask });

			// Asked once, with the plan: the answer stands for the whole run.
			expect(ask).toHaveBeenCalledOnce();
			expect(ask.mock.calls[0]?.[0][0]?.options.map(({ label }) => label)).toEqual([
				'Approve, commit at the end',
				'Approve, commit each phase',
				'Approve, do not commit',
				'Stop',
			]);
			expect(commit).toHaveBeenCalledTimes(commits);
		});

		it('offers only Approve when the run cannot commit', async () => {
			const ask = vi.fn<Asker>(() => ['Approve']);

			await orchestrator({ commitQuestion: 'plan' }).run(
				'task',
				withRunContext({ signal, ask }, new RunContext({ id: 'outer' })),
			);

			expect(ask.mock.calls[0]?.[0][0]?.options.map(({ label }) => label)).toEqual([
				'Approve',
				'Stop',
			]);
		});

		it('refuses autoCommit, which asks nothing', () => {
			expect(() => orchestrator({ commitQuestion: 'plan', autoCommit: true })).toThrow(
				InvalidAgentConfigError,
			);
		});
	});

	it('refuses a commitQuestion that is not one', () => {
		expect(() => orchestrator({ commitQuestion: 'never' as CommitQuestion })).toThrow(
			new InvalidAgentConfigError('commitQuestion must be one of: end, phase, plan'),
		);
	});

	describe('with required checks', () => {
		const passed: Verification = {
			met: true,
			checks: [{ command: 'test', status: 'passed', how: 'exited with code 0', output: '' }],
		};
		const failing: Verification = {
			met: false,
			checks: [
				{ command: 'test', status: 'failed', how: 'exited with code 1', output: '1 failed' },
			],
		};

		it('checks again before the commit, and sends the phase back to the executor when they no longer pass', async () => {
			const results = [passed, failing, passed, passed];
			const verify = vi.fn<Verifier['verify']>(() => Promise.resolve(results.shift() ?? passed));
			const verifier: Verifier = { verify };
			const { committer, freeze, commit } = fakeCommitter();
			const executor = scripted(done('first'), done('fixed'));
			const agent = new PhasedOrchestrator({
				planner: scripted(planOf('a')).agent,
				executor: executor.agent,
				reviewer: scripted(approved, approved).agent,
				validators: {
					plan: planValidator,
					report: phaseReportValidator,
					review: phaseReviewValidator,
				},
				changes,
				verifier,
				committer,
				createCommitter: () => scripted('Change a').agent,
				logger,
			});

			const response = await agent.run('task', { signal, ask: asker() });

			expect(executor.run.mock.calls[1]?.[0]).toContain(
				'After the review, the required checks do not pass for the files as they are:\n- test: failed, exited with code 1\n1 failed',
			);
			// Frozen again before the second review, and committed only after the checks passed.
			expect(freeze).toHaveBeenCalledTimes(2);
			expect(commit).toHaveBeenCalledOnce();
			expect(verify).toHaveBeenCalledTimes(4);
			expect(response.verification).toEqual(passed);
			expect(response.phases).toEqual([
				{ goal: 'a', status: 'approved', summary: 'fixed', verification: passed },
			]);
		});
	});
});
