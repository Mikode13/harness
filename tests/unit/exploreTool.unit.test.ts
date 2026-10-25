import { describe, expect, it, vi } from 'vitest';
import type {
	Agent,
	AgentResponse,
	ProgressEvent,
	RunOptions,
} from '../../src/agent/domain/agent.ts';
import { RunContext, runContextOf } from '../../src/agent/domain/runContext.ts';
import { RecoverableError, UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type { Tokens } from '../../src/shared/domain/tokens.ts';
import { ReadRegistry, type ToolCallContext } from '../../src/tools/domain/readRegistry.ts';
import { createExploreTool, maxExplorers } from '../../src/tools/infrastructure/exploreTool.ts';

const signal = new AbortController().signal;

function tokens(inputTokens: number): Tokens {
	return { inputTokens, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0 };
}

function callContext() {
	const events: ProgressEvent[] = [];
	const spent: [Tokens | undefined, boolean][] = [];
	const call: ToolCallContext = {
		run: new RunContext({ id: 'test-session' }),
		reads: new ReadRegistry().begin(),
		callId: 'call-7',
		onProgress: event => events.push(event),
		spend: (used, unreported) => spent.push([used, unreported]),
		depth: 0,
	};
	return { call, events, spent };
}

/** Explorers that answer each question with `answer(question, options)`, recording each one made. */
function explorers(answer: (question: string, options: RunOptions) => Promise<AgentResponse>) {
	const made: Agent[] = [];
	const explorer = () => {
		const agent: Agent = { run: vi.fn(answer) };
		made.push(agent);
		return agent;
	};
	return { explorer, made };
}

/** Sends the explorers, and gives what each one answers once every one has. */
async function explore(
	explorer: () => Agent,
	questions: unknown,
	call: ToolCallContext,
	runSignal = signal,
) {
	const prepared = await createExploreTool(explorer).delegate({ questions }, runSignal, call);
	const sent = prepared.start(runSignal);
	return {
		risk: prepared.risk,
		sent: sent.map(({ name, task }) => ({ name, task })),
		answers: await Promise.all(sent.map(({ answer }) => answer)),
	};
}

describe('explore', () => {
	it('sends a new explorer for each question, all at once, each answering when it finishes', async () => {
		const started: string[] = [];
		const finish: Record<string, (response: AgentResponse) => void> = {};
		const { explorer, made } = explorers(
			question =>
				new Promise(resolve => {
					started.push(question);
					finish[question] = resolve;
				}),
		);
		const { call, spent } = callContext();

		const prepared = await createExploreTool(explorer).delegate(
			{ questions: ['  Where is add?', 'Who calls it?'] },
			signal,
			call,
		);
		const [first, second] = prepared.start(signal);
		// Both run before either answers.
		await vi.waitFor(() => {
			expect(started).toEqual(['Where is add?', 'Who calls it?']);
		});
		finish['Who calls it?']?.({ response: 'main.ts calls it.', duration: 1, tokens: tokens(5) });

		// The second answers while the first still works.
		await expect(second?.answer).resolves.toEqual({ text: 'main.ts calls it.' });
		expect(spent).toEqual([[tokens(5), false]]);
		finish['Where is add?']?.({ response: 'In math.ts.', duration: 1, tokens: tokens(3) });
		await expect(first?.answer).resolves.toEqual({ text: 'In math.ts.' });

		expect(prepared.risk).toBe('safe');
		expect([first, second].map(agent => [agent?.name, agent?.subagent, agent?.task])).toEqual([
			['explorer', 1, 'Where is add?'],
			['explorer', 2, 'Who calls it?'],
		]);
		expect(made).toHaveLength(2);
		expect(spent).toEqual([
			[tokens(5), false],
			[tokens(3), false],
		]);
	});

	it('narrates each explorer apart, within the run that made the call', async () => {
		const contexts: (RunContext | undefined)[] = [];
		const { explorer } = explorers((question, options) => {
			contexts.push(runContextOf(options));
			options.onProgress?.({ type: 'agentMessage', message: `looking for ${question}` });
			return Promise.resolve({ response: 'found', duration: 1, tokens: tokens(1) });
		});
		const { call, events } = callContext();

		await explore(explorer, ['a', 'b'], call);

		expect(contexts).toEqual([call.run, call.run]);
		expect(events).toEqual([
			{
				type: 'subagent',
				callId: 'call-7',
				subagent: 1,
				name: 'explorer',
				task: 'a',
				event: { type: 'agentMessage', message: 'looking for a' },
			},
			{
				type: 'subagent',
				callId: 'call-7',
				subagent: 2,
				name: 'explorer',
				task: 'b',
				event: { type: 'agentMessage', message: 'looking for b' },
			},
		]);
	});

	it('reports an explorer that failed, counting what it spent, and keeps the others', async () => {
		const { explorer } = explorers(question =>
			question === 'b'
				? Promise.reject(
						new UnrecoverableError('The LLM did not finish within its step limit', {
							cause: 'The model was still calling tools after 30 steps.',
							tokens: tokens(9),
						}),
					)
				: Promise.resolve({ response: 'found a', duration: 1, tokens: tokens(2) }),
		);
		const { call, spent } = callContext();

		const { answers } = await explore(explorer, ['a', 'b'], call);

		expect(answers).toEqual([
			{ text: 'found a' },
			{
				text: 'The explorer failed: The LLM did not finish within its step limit: The model was still calling tools after 30 steps.',
				failed: true,
			},
		]);
		expect(spent).toEqual([
			[tokens(2), false],
			[tokens(9), false],
		]);
	});

	it('leaves the usage unreported for an explorer whose usage went unreported', async () => {
		const { explorer } = explorers(question =>
			question === 'a'
				? Promise.resolve({ response: 'found', duration: 1 })
				: Promise.reject(
						new RecoverableError('The Claude stream broke off', {
							cause: 'terminated',
							usageUnreported: true,
						}),
					),
		);
		const { call, spent } = callContext();

		await explore(explorer, ['a', 'b'], call);

		expect(spent).toEqual([
			[undefined, true],
			[undefined, true],
		]);
	});

	it('says when an explorer found nothing, and cuts an answer longer than a read', async () => {
		const long = 'x'.repeat(16_001);
		const { explorer } = explorers(question =>
			Promise.resolve({ response: question === 'a' ? '' : long, duration: 1, tokens: tokens(1) }),
		);
		const { call } = callContext();

		const { answers } = await explore(explorer, ['a', 'b'], call);

		expect(answers).toEqual([
			{ text: 'It found nothing to report.' },
			{ text: `${'x'.repeat(16_000)}\n[The answer was cut at 16000 characters.]` },
		]);
	});

	it('ends as cancelled when the run is, whatever the explorers threw', async () => {
		const controller = new AbortController();
		const { explorer } = explorers(() => {
			controller.abort();
			return Promise.reject(
				new UnrecoverableError('The Claude request failed', { cause: 'aborted' }),
			);
		});
		const { call } = callContext();

		await expect(explore(explorer, ['a'], call, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
	});

	it.each([
		['no questions', [], `Ask between 1 and ${String(maxExplorers)} questions in one call.`],
		[
			'more questions than explorers',
			['a', 'b', 'c', 'd', 'e'],
			`Ask between 1 and ${String(maxExplorers)} questions in one call.`,
		],
		['a blank question', ['a', '  '], 'Every question needs some text.'],
	])('refuses %s before sending any explorer', async (_, questions, message) => {
		const { explorer, made } = explorers(() =>
			Promise.resolve({ response: 'found', duration: 1, tokens: tokens(1) }),
		);
		const { call } = callContext();

		await expect(explore(explorer, questions, call)).rejects.toThrow(message);
		expect(made).toHaveLength(0);
	});

	it('summarizes a call by its question, or by how many it asked', () => {
		const tool = createExploreTool(() => ({ run: vi.fn() }));

		expect(tool.summarize?.({ questions: ['Where is add?'] })).toBe('Where is add?');
		expect(tool.summarize?.({ questions: ['a', 'b', 'c'] })).toBe('3 questions');
	});
});
