import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, RunOptions } from '../../src/agent/domain/agent.ts';
import type { UserQuestion } from '../../src/agent/domain/question.ts';
import {
	recorderOf,
	recordRun,
	type RunRecorder,
	type RunRecordEntry,
} from '../../src/agent/domain/runRecord.ts';
import { RecoverableError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import { isAbortError } from '../../src/shared/domain/isAbortError.ts';

const tokens = { inputTokens: 3, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 2 };
const response: AgentResponse = { response: 'done', tokens, duration: 1 };
const signal = new AbortController().signal;
const questions: UserQuestion[] = [
	{
		question: 'Which file?',
		options: [{ label: 'a.ts', description: 'The first' }],
		multiSelect: false,
	},
];

/** Options whose record goes to `entries`, plus what the test adds. */
function recordingOptions(entries: RunRecordEntry[], extra: Partial<RunOptions> = {}): RunOptions {
	return {
		signal,
		onRecord: entry => {
			entries.push(entry);
		},
		...extra,
	};
}

/** The error the run's record ends with, when it ends with a failure. */
function failedWith(entries: RunRecordEntry[]): unknown {
	const last = entries.at(-1);
	return last?.type === 'failed' ? last.error : undefined;
}

/** The reason the run's record ends with, when it ends with a cancellation. */
function cancelledWith(entries: RunRecordEntry[]): unknown {
	const last = entries.at(-1);
	return last?.type === 'cancelled' ? last.error : undefined;
}

/** The error a run rejected with, so the test can check what it is. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('The run was expected to reject');
}

describe('recordRun', () => {
	it('records progress in order when no onProgress is given, then one completed entry', async () => {
		const entries: RunRecordEntry[] = [];

		const result = await recordRun(recordingOptions(entries), options => {
			options.onProgress?.({ type: 'reasoning', message: 'first' });
			options.onProgress?.({ type: 'turnEnded' });
			return response;
		});

		expect(result).toBe(response);
		expect(entries).toEqual([
			{ type: 'progress', event: { type: 'reasoning', message: 'first' } },
			{ type: 'progress', event: { type: 'turnEnded' } },
			{ type: 'completed', response },
		]);
	});

	it('records each progress event before onProgress receives it', async () => {
		const entries: RunRecordEntry[] = [];
		const seenByCallback: number[] = [];

		await recordRun(
			recordingOptions(entries, {
				onProgress: () => {
					seenByCallback.push(entries.length);
				},
			}),
			options => {
				options.onProgress?.({ type: 'turnEnded' });
				options.onProgress?.({ type: 'turnEnded' });
				return response;
			},
		);

		expect(seenByCallback).toEqual([1, 2]);
		expect(entries.map(entry => entry.type)).toEqual(['progress', 'progress', 'completed']);
	});

	it('passes the options on whole when nothing records them', async () => {
		const options: RunOptions = { signal, onProgress: () => undefined };

		const result = await recordRun(options, received => {
			expect(received).toBe(options);
			return response;
		});

		expect(result).toBe(response);
	});

	it('records a copy of each payload, so the record and the run cannot change each other', async () => {
		const event = { type: 'reasoning' as const, message: 'kept' };

		const result = await recordRun(
			{
				signal,
				onRecord: entry => {
					if (entry.type === 'progress' && entry.event.type === 'reasoning') {
						entry.event.message = 'changed by the consumer';
					}
					if (entry.type === 'completed') entry.response.response = 'changed by the consumer';
				},
			},
			options => {
				options.onProgress?.(event);
				return response;
			},
		);

		expect(event.message).toBe('kept');
		expect(result.response).toBe('done');
	});

	it('records the questions as they were asked, even when the asker changes them afterwards', async () => {
		const asked: UserQuestion[] = structuredClone(questions);
		const entries: RunRecordEntry[] = [];

		await recordRun(recordingOptions(entries), outer => {
			recorderOf(outer)?.record({ type: 'question', questions: asked });
			for (const question of asked) question.question = 'changed afterwards';
			return response;
		});

		expect(entries[0]).toEqual({ type: 'question', questions });
	});

	it('ends the record with the classified failure, the same instance the run rejects with', async () => {
		const entries: RunRecordEntry[] = [];
		const error = new RecoverableError('The provider is down', { cause: 'socket closed', tokens });

		const rejection = await rejectionOf(
			recordRun(recordingOptions(entries), () => {
				throw error;
			}),
		);

		expect(rejection).toBe(error);
		expect(entries.map(entry => entry.type)).toEqual(['failed']);
		expect(failedWith(entries)).toBe(error);
	});

	it('records an unclassified failure as unrecoverable, and rejects with that same error', async () => {
		const entries: RunRecordEntry[] = [];
		const raw = new TypeError('malformed reply');

		const rejection = await rejectionOf(
			recordRun(recordingOptions(entries), () => {
				throw raw;
			}),
		);

		expect(rejection).toBeInstanceOf(UnrecoverableError);
		expect(rejection).not.toBe(raw);
		expect(rejection).toMatchObject({
			message: 'The agent failed without classifying the failure',
			cause: 'malformed reply',
		});
		expect(failedWith(entries)).toBe(rejection);
	});

	it.each<[string, () => unknown]>([
		['an abort', (): unknown => AbortSignal.abort().reason],
		['a timeout', () => new DOMException('timed out', 'TimeoutError')],
	])(
		'records %s as cancelled, distinct from a failure, and rejects with the same error',
		async (_, makeError) => {
			const entries: RunRecordEntry[] = [];
			const error = makeError();

			const rejection = await rejectionOf(
				recordRun(recordingOptions(entries), () => {
					throw error;
				}),
			);

			expect(rejection).toBe(error);
			expect(isAbortError(rejection)).toBe(true);
			expect(entries.map(entry => entry.type)).toEqual(['cancelled']);
			expect(cancelledWith(entries)).toBe(error);
		},
	);

	it('ends a nested run inside the outer record, which ends it once', async () => {
		const entries: RunRecordEntry[] = [];

		const result = await recordRun(recordingOptions(entries), outer => {
			recorderOf(outer)?.record({ type: 'question', questions });
			return recordRun(outer, inner => {
				inner.onProgress?.({ type: 'turnEnded' });
				return response;
			});
		});

		expect(result).toBe(response);
		expect(entries.map(entry => entry.type)).toEqual(['question', 'progress', 'completed']);
	});

	it('leaves a nested failure to the outer run, which records it once', async () => {
		const entries: RunRecordEntry[] = [];
		const error = new UnrecoverableError('The workspace is gone', { cause: 'deleted' });

		const rejection = await rejectionOf(
			recordRun(recordingOptions(entries), outer =>
				recordRun(outer, () => {
					throw error;
				}),
			),
		);

		expect(rejection).toBe(error);
		expect(entries.map(entry => entry.type)).toEqual(['failed']);
		expect(failedWith(entries)).toBe(error);
	});

	it('keeps a delegated run outcome nested, with its error the same instance', async () => {
		const entries: RunRecordEntry[] = [];
		const childError = new UnrecoverableError('The child broke', { cause: 'malformed' });

		await recordRun(recordingOptions(entries), outer => {
			recorderOf(outer)?.record({
				type: 'subagent',
				callId: 'call-1',
				subagent: 1,
				name: 'explore',
				task: 'find the entry point',
				entry: { type: 'failed', error: childError },
			});
			return response;
		});

		expect(entries.map(entry => entry.type)).toEqual(['subagent', 'completed']);
		const [first] = entries;
		expect(first?.type === 'subagent' && first.entry.type === 'failed' && first.entry.error).toBe(
			childError,
		);
	});

	it('refuses to record anything after the run ended', async () => {
		const entries: RunRecordEntry[] = [];
		const late: RunRecorder[] = [];

		await recordRun(recordingOptions(entries), outer => {
			const recorder = recorderOf(outer);
			if (recorder) late.push(recorder);
			return response;
		});

		expect(() => late[0]?.record({ type: 'answer', answers: ['too late'] })).toThrow(
			'A run record takes nothing after its terminal entry',
		);
		expect(entries.map(entry => entry.type)).toEqual(['completed']);
	});

	it('ends the run as unrecoverable when a record is refused, and delivers nothing after it', async () => {
		const sink = vi.fn((): void => {
			throw new Error('The disk is full');
		});

		const rejection = await rejectionOf(
			recordRun({ signal, onRecord: sink }, options => {
				options.onProgress?.({ type: 'turnEnded' });
				return response;
			}),
		);

		expect(rejection).toBeInstanceOf(UnrecoverableError);
		expect(rejection).toMatchObject({
			message: 'The run record could not be delivered',
			cause: 'The disk is full',
		});
		expect(sink).toHaveBeenCalledOnce();
	});

	it('does not let a run that swallowed a refused record succeed', async () => {
		const sink = vi.fn((): void => {
			throw new Error('The disk is full');
		});

		const rejection = await rejectionOf(
			recordRun({ signal, onRecord: sink }, options => {
				try {
					options.onProgress?.({ type: 'turnEnded' });
				} catch {
					// The run ignores the failure: the record still refuses to say it succeeded.
				}
				return response;
			}),
		);

		expect(rejection).toBeInstanceOf(UnrecoverableError);
		expect(sink).toHaveBeenCalledOnce();
	});

	it('fails the run as unrecoverable when the completed entry cannot be delivered, with its tokens', async () => {
		const sink = vi.fn((entry: RunRecordEntry): void => {
			if (entry.type === 'completed') throw new Error('The sink closed');
		});

		const rejection = await rejectionOf(recordRun({ signal, onRecord: sink }, () => response));

		expect(rejection).toBeInstanceOf(UnrecoverableError);
		expect(rejection).toMatchObject({
			message: 'The run record could not be delivered',
			cause: 'The sink closed',
			tokens,
		});
		expect(sink).toHaveBeenCalledOnce();
	});

	it.each<[string, () => unknown]>([
		['an abort', (): unknown => AbortSignal.abort().reason],
		['a timeout', () => new DOMException('timed out', 'TimeoutError')],
	])(
		'rejects with %s itself when its cancelled entry cannot be delivered, and delivers nothing after',
		async (_, makeError) => {
			const sink = vi.fn((entry: RunRecordEntry): void => {
				if (entry.type === 'cancelled') throw new Error('The sink closed');
			});
			const error = makeError();

			const rejection = await rejectionOf(
				recordRun({ signal, onRecord: sink }, () => {
					throw error;
				}),
			);

			expect(rejection).toBe(error);
			expect(isAbortError(rejection)).toBe(true);
			expect(sink).toHaveBeenCalledOnce();
		},
	);

	it('keeps the failure tokens when the failed entry cannot be delivered', async () => {
		const sink = vi.fn((entry: RunRecordEntry): void => {
			if (entry.type === 'failed') throw new Error('The sink closed');
		});
		const failure = new RecoverableError('The provider is down', {
			cause: 'socket closed',
			tokens,
		});

		const rejection = await rejectionOf(
			recordRun({ signal, onRecord: sink }, () => {
				throw failure;
			}),
		);

		expect(rejection).toBeInstanceOf(UnrecoverableError);
		expect(rejection).toMatchObject({ cause: 'The sink closed', tokens });
		expect(sink).toHaveBeenCalledOnce();
	});

	it('treats a record callback that returns a promise as a failure, without an unhandled rejection', async () => {
		const sink = vi.fn((): unknown => Promise.reject(new Error('It failed later')));

		const rejection = await rejectionOf(recordRun({ signal, onRecord: sink }, () => response));

		expect(rejection).toMatchObject({
			message: 'The run record could not be delivered',
			cause: 'The run record callback returned a promise, but it must be synchronous',
		});
		expect(sink).toHaveBeenCalledOnce();
	});
});
