import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/agent/domain/agent.ts';
import type { RepositoryCommit } from '../../src/agent/domain/commitReport.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { ChangeLog } from '../../src/orchestration/domain/model/changeLog.ts';
import type {
	Committer,
	FrozenRepository,
} from '../../src/orchestration/domain/model/committer.ts';
import {
	type ComposedSessionSnapshot,
	parseComposedSessionSnapshot,
} from '../../src/orchestration/domain/model/composedSessionSnapshot.ts';
import {
	ModelAPIPhasedOrchestrator,
} from '../../src/orchestration/domain/model/phasedOrchestrator.ts';
import {
	phaseReportValidator,
	phaseReviewValidator,
	planValidator,
} from '../../src/orchestration/infrastructure/model/phaseValidators.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import { FakeLLMClient, textResponse } from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

const plan = JSON.stringify({
	summary: 'The task',
	phases: [{ goal: 'a', files: ['a.txt'], done: 'a works' }],
});
const done = JSON.stringify({ status: 'done', summary: 'a is changed' });
const approved = JSON.stringify({ decision: 'approved' });

/** A model-API agent that answers each run with the next of `replies`, in order. */
function modelRole(...replies: string[]): LLMAgent {
	const script = replies.map(reply => textResponse(reply));
	return new LLMAgent({ llmClient: new FakeLLMClient(...script) });
}

const repository: FrozenRepository = {
	repository: '/repo',
	branch: 'main',
	paths: ['a.txt'],
	leftOut: [],
	diff: 'diff --git a/a.txt b/a.txt',
	style: [],
};

const committed: RepositoryCommit = {
	repository: '/repo',
	branch: 'main',
	outcome: 'done',
	commits: [{ sha: 'a'.repeat(40), subject: 'Change a' }],
	paths: ['a.txt'],
	leftOut: [],
	unreviewed: [],
};

const committer: Committer = {
	freeze: () => Promise.resolve({ repositories: [repository] }),
	commit: () => Promise.resolve([committed]),
};

const changes: ChangeLog = { mark: () => Promise.resolve(0), since: () => Promise.resolve('diff') };

/** A session whose roles answer each of its `runs` runs, and whose committers write 'Change a'. */
function session({
	runs = 1,
	createCommitter = () => modelRole('Change a'),
	auxiliary,
}: {
	runs?: number;
	createCommitter?: () => Agent;
	auxiliary?: ComposedSessionSnapshot['auxiliary'];
} = {}) {
	const each = (text: string) => Array.from({ length: runs }, () => text);
	return new ModelAPIPhasedOrchestrator({
		planner: modelRole(...each(plan)),
		executor: modelRole(...each(done)),
		reviewer: modelRole(...each(approved)),
		validators: { plan: planValidator, report: phaseReportValidator, review: phaseReviewValidator },
		changes,
		committer,
		createCommitter,
		autoCommit: true,
		...(auxiliary ? { auxiliary } : {}),
		logger: { warn: vi.fn() },
	});
}

const roundTrip = (saved: ComposedSessionSnapshot) =>
	parseComposedSessionSnapshot(JSON.parse(JSON.stringify(saved)));

function thrownBy(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error('nothing was thrown');
}

describe('the committer records of a model-API session', () => {
	it('keeps the committer that wrote each message, with the attempt and repository it wrote for', async () => {
		const orchestrator = session();
		await orchestrator.run('task', { signal });

		const [record, ...others] = orchestrator.snapshot().auxiliary;

		expect(others).toEqual([]);
		expect(record).toMatchObject({
			origin: { role: 'committer', attempt: 1, repository: '/repo' },
			agent: { children: [] },
		});
		// The committer's own conversation holds the change it wrote a message for.
		expect(JSON.stringify(record?.agent.conversation)).toContain('diff --git a/a.txt b/a.txt');
	});

	it('numbers the commits of a session across its runs, and keeps each committer', async () => {
		const orchestrator = session({ runs: 2 });
		await orchestrator.run('first task', { signal });
		await orchestrator.run('second task', { signal });

		expect(orchestrator.snapshot().auxiliary.map(({ origin }) => origin)).toEqual([
			{ role: 'committer', attempt: 1, repository: '/repo' },
			{ role: 'committer', attempt: 2, repository: '/repo' },
		]);
	});

	it('takes up a restored session with its committers kept, and numbers its next commit after them', async () => {
		const first = session({ runs: 2 });
		await first.run('first task', { signal });
		await first.run('second task', { signal });
		const saved = roundTrip(first.snapshot());

		const resumed = session({ auxiliary: saved.auxiliary });
		await resumed.run('third task', { signal });

		expect(resumed.snapshot().auxiliary).toEqual([
			...saved.auxiliary,
			{
				origin: { role: 'committer', attempt: 3, repository: '/repo' },
				agent: expect.objectContaining({ children: [] }),
			},
		]);
	});

	it('refuses to save a committer that is not an agent on the model APIs, and names it', async () => {
		const notAModelAgent: Agent = {
			run: () => Promise.resolve({ response: 'Change a', duration: 1 }),
		};
		const orchestrator = session({ createCommitter: () => notAModelAgent });
		await orchestrator.run('task', { signal });

		const failure = thrownBy(() => orchestrator.snapshot());
		expect(failure).toBeInstanceOf(UnrecoverableError);
		expect(failure).toMatchObject({
			message: 'The committer of attempt 1 in /repo cannot be saved',
			cause: 'it is not an agent on the model APIs',
		});
	});
});
