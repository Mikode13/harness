import { describe, expect, it, vi } from 'vitest';
import { RunContext, runContextOf, withRunContext } from '../../src/agent/domain/runContext.ts';

const signal = new AbortController().signal;

describe('RunContext', () => {
	it('ends everything registered, in order, with how the run ended', async () => {
		const context = new RunContext({ id: 'test-session' });
		const ends: string[] = [];
		context.onFinish(end => Promise.resolve(void ends.push(`first ${end}`)));
		context.onFinish(end => Promise.resolve(void ends.push(`second ${end}`)));

		await context.finish('cancelled');

		expect(ends).toEqual(['first cancelled', 'second cancelled']);
	});

	it('ends the rest when one fails, then throws the first failure', async () => {
		const context = new RunContext({ id: 'test-session' });
		const last = vi.fn(() => Promise.resolve());
		context.onFinish(() => Promise.reject(new Error('first')));
		context.onFinish(() => Promise.reject(new Error('second')));
		context.onFinish(last);

		await expect(context.finish('failed')).rejects.toThrow('first');
		expect(last).toHaveBeenCalledOnce();
	});

	it('ends each thing once, however often it is finished', async () => {
		const context = new RunContext({ id: 'test-session' });
		const finisher = vi.fn(() => Promise.resolve());
		context.onFinish(finisher);

		await context.finish('completed');
		await context.finish('completed');

		expect(finisher).toHaveBeenCalledOnce();
	});
});

describe('RunContext history runs', () => {
	it("keeps each history's run apart, and shares it with whoever asked before", () => {
		const context = new RunContext({ id: 'test-session' });
		const early = context.historyRunOf('here');

		context.historyRunOf('elsewhere').runId = 'run-elsewhere';
		context.historyRunOf('here').runId = 'run-here';

		expect(early.runId).toBe('run-here');
		expect(context.historyRunOf('elsewhere').runId).toBe('run-elsewhere');
	});

	it('takes the first history reached that recorded a run, not the first written', () => {
		const context = new RunContext({ id: 'test-session' });
		context.historyRunOf('first');
		context.historyRunOf('second').runId = 'run-second';

		expect(context.firstRunId).toBe('run-second');
		context.historyRunOf('first').runId = 'run-first';
		expect(context.firstRunId).toBe('run-first');
	});
});

describe('withRunContext', () => {
	it('carries the context without changing the options it was given', () => {
		const options = { signal };
		const context = new RunContext({ id: 'test-session' });

		const carried = withRunContext(options, context);

		expect(runContextOf(carried)).toBe(context);
		expect(runContextOf(options)).toBeUndefined();
	});

	// A consumer that logs or copies its options never meets the context.
	it('keeps the context out of sight of anything that lists or serializes the options', () => {
		const carried = withRunContext({ signal }, new RunContext({ id: 'test-session' }));

		expect(Object.keys(carried)).toEqual(['signal']);
		expect(JSON.stringify({ ...carried, signal: undefined })).toBe('{}');
	});
});
