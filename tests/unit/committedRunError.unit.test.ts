import { describe, expect, it } from 'vitest';
import type { RepositoryCommit } from '../../src/agent/domain/commitReport.ts';
import {
	RecoverableCommittedRunError,
	UnrecoverableCommittedRunError,
} from '../../src/agent/domain/committedRunError.ts';
import { withSpentTokens } from '../../src/shared/domain/errors.ts';

const tokens = { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0 };

const committed: RepositoryCommit = {
	repository: '/repo',
	branch: 'main',
	outcome: 'done',
	commits: [{ sha: 'a'.repeat(40), subject: 'Change a' }],
	paths: ['a.txt'],
	leftOut: [],
	unreviewed: [],
};

const run = {
	commits: { outcome: 'committed' as const, repositories: [committed] },
	phases: [{ goal: 'a', status: 'approved' as const, summary: 'done' }],
	runId: 'run-1',
};

describe('the error of a run that committed', () => {
	it.each([RecoverableCommittedRunError, UnrecoverableCommittedRunError])(
		'keeps what the run committed when an outer layer adds what it spent: %o',
		ErrorClass => {
			const failure = new ErrorClass('Out of steps', { cause: 'the limit', tokens, ...run });

			const copy = withSpentTokens(failure, tokens);

			expect(copy).toBeInstanceOf(ErrorClass);
			expect(copy).toMatchObject({
				message: 'Out of steps',
				cause: 'the limit',
				tokens: { ...tokens, inputTokens: 2, outputTokens: 2 },
				...run,
			});
		},
	);
});
