import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentResponse } from '../../src/agent/domain/agent.ts';
import type { RepositoryCommit } from '../../src/agent/domain/commitReport.ts';
import type { Asker } from '../../src/agent/domain/question.ts';
import type {
	Committer,
	FrozenChanges,
	FrozenRepository,
} from '../../src/orchestration/domain/model/committer.ts';
import { OrchestratorAgent } from '../../src/orchestration/domain/model/orchestratorAgent.ts';
import { ReviewerDecisionValidator } from '../../src/orchestration/infrastructure/model/reviewerDecisionValidator.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';

const tokens = { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0 };

function respond(response: string): AgentResponse {
	return { response, duration: 1, tokens };
}

function scripted(...responses: string[]) {
	const run = vi.fn<Agent['run']>(() => {
		const next = responses.shift();
		if (next === undefined) throw new Error('the fake agent ran out of responses');
		return Promise.resolve(respond(next));
	});
	return { agent: { run } satisfies Agent, run };
}

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

const logger = { warn: vi.fn() };

function orchestrator({
	committer = fakeCommitter().committer,
	committerAgent = scripted('Change a').agent,
	autoCommit = false,
	reviews = ['{"decision":"approved"}'],
}: {
	committer?: Committer;
	committerAgent?: Agent;
	autoCommit?: boolean;
	reviews?: string[];
} = {}) {
	const rounds = reviews.length;
	return new OrchestratorAgent({
		plannerAgent: scripted(...Array.from({ length: rounds }, () => 'the plan')).agent,
		executorAgent: scripted(...Array.from({ length: rounds }, () => 'done')).agent,
		reviewerAgent: scripted(...reviews).agent,
		reviewerDecisionValidator: new ReviewerDecisionValidator(),
		logger,
		committer,
		createCommitter: () => committerAgent,
		autoCommit,
	});
}

const signal = new AbortController().signal;
const yes: Asker = () => ['Commit'];

describe("the orchestrator's committer", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('asks once the reviewer approves, has the committer write the message, and reports the commit', async () => {
		const { committer, freeze, commit } = fakeCommitter();
		const writer = scripted('```\nChange a\n```');
		const ask = vi.fn(yes);
		const events: unknown[] = [];

		const response = await orchestrator({ committer, committerAgent: writer.agent }).run('task', {
			signal,
			ask,
			approve: () => ({ approved: true }),
			onProgress: event => events.push(event),
		});

		expect(freeze).toHaveBeenCalledOnce();
		expect(ask).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					question:
						'The reviewer approved the change. Commit it? It would commit 1 file in /repo on main. 1 file the task changed would be left out: b.txt (it held changes of yours before this task).',
				}),
			],
			signal,
		);
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

	it('writes each message with a new committer, so none carries an earlier commit', async () => {
		const createCommitter = vi.fn(() => scripted('Change a').agent);
		const agent = new OrchestratorAgent({
			plannerAgent: scripted('the plan', 'the plan').agent,
			executorAgent: scripted('done', 'done').agent,
			reviewerAgent: scripted('{"decision":"approved"}', '{"decision":"approved"}').agent,
			reviewerDecisionValidator: new ReviewerDecisionValidator(),
			logger,
			committer: fakeCommitter().committer,
			createCommitter,
		});

		await agent.run('task', { signal, ask: yes });
		await agent.run('another task', { signal, ask: yes });

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
			ask: yes,
			onProgress: event => events.push(event),
		});

		expect(events).toContainEqual({ type: 'reasoning', message: 'writing', agent: 'committer' });
	});

	it('commits nothing, and reports it declined, when the user answers anything but Commit', async () => {
		const { committer, commit } = fakeCommitter();

		const response = await orchestrator({ committer }).run('task', {
			signal,
			ask: () => ['commit it, but later'],
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

	it('asks nothing for a run that changed no file', async () => {
		const ask = vi.fn(yes);

		const unchanged: Committer = { freeze: () => Promise.resolve(undefined), commit: vi.fn() };

		const response = await orchestrator({ committer: unchanged }).run('task', { signal, ask });

		expect(ask).not.toHaveBeenCalled();
		expect(response).not.toHaveProperty('commits');
	});

	it('asks nothing, and reports why, when nothing the run changed can be committed', async () => {
		const ask = vi.fn(yes);
		const detached = { ...repository, paths: [], refused: 'no branch is checked out there' };

		const response = await orchestrator({
			committer: fakeCommitter({ repositories: [detached] }).committer,
		}).run('task', { signal, ask });

		expect(ask).not.toHaveBeenCalled();
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
			reviews: ['{"decision":"rejected","feedback":"fix it"}', '{"decision":"approved"}'],
		}).run('task', { signal, ask: yes });

		expect(freeze).toHaveBeenCalledTimes(2);
		expect(commit.mock.calls[0]?.[0]).toBe(second);
	});

	it('leaves out a repository the committer wrote no message for', async () => {
		const { committer, commit } = fakeCommitter();

		await orchestrator({ committer, committerAgent: scripted('  ').agent }).run('task', {
			signal,
			ask: yes,
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
		}).run('task', { signal, ask: yes });

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
		}).run('task', { signal, ask: yes });

		expect(response.commits?.outcome).toBe('committed');
		expect(logger.warn).toHaveBeenCalledWith(
			"The committer's commit in /repo was made, but git failed after it: git ran past its limit and was stopped",
		);
	});

	it('ends the run with an UnrecoverableError when the asker fails or answers wrongly', async () => {
		await expect(
			orchestrator().run('task', {
				signal,
				ask: () => {
					throw new Error('terminal gone');
				},
			}),
		).rejects.toBeInstanceOf(UnrecoverableError);
		await expect(orchestrator().run('task', { signal, ask: () => [] })).rejects.toBeInstanceOf(
			UnrecoverableError,
		);
	});

	it('ends with the cancellation when the run is cancelled while the user is asked', async () => {
		const controller = new AbortController();
		const { committer, commit } = fakeCommitter();

		await expect(
			orchestrator({ committer }).run('task', {
				signal: controller.signal,
				ask: () => {
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
			orchestrator({ committer: { freeze, commit: vi.fn() } }).run('task', { signal, ask: yes }),
		).rejects.toBeInstanceOf(UnrecoverableError);
	});
});
