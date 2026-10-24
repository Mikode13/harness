import { describe, expect, it, vi, type Mock } from 'vitest';
import {
	createWorkflow,
	defineWorkflowStages,
	Inbox,
	isAbortError,
	RecoverableError,
	UnrecoverableError,
	type Agent,
	type AgentResponse,
	type ProgressEvent,
	type RunOptions,
	type Tokens,
	type Validator,
	type WorkflowStage,
	type WorkflowTransition,
} from '../../src/index.ts';
import { RunContext, runContextOf, withRunContext } from '../../src/agent/domain/runContext.ts';

const signal = new AbortController().signal;

function tokens(inputTokens: number): Tokens {
	return { inputTokens, readCacheTokens: 0, writtenCacheTokens: 0, outputTokens: 1 };
}

function answer(value: unknown, inputTokens?: number): AgentResponse {
	return {
		response: JSON.stringify(value),
		duration: 0,
		...(inputTokens !== undefined && { tokens: tokens(inputTokens) }),
	};
}

function fakeAgent(...responses: (AgentResponse | Error)[]): {
	agent: () => Agent;
	run: Mock<Agent['run']>;
} {
	const run = vi.fn<Agent['run']>(() => {
		const next = responses.shift();
		if (!next) throw new Error('fake agent ran out of responses');
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	});
	return { agent: () => ({ run }), run };
}

/**
 * Agents that remember, as the harness's agents do: each one created records every prompt its
 * own conversation received, and all of them answer from one shared script.
 */
function rememberingAgents(...responses: AgentResponse[]) {
	const conversations: string[][] = [];
	const agent = (): Agent => {
		const conversation: string[] = [];
		conversations.push(conversation);
		return {
			run: prompt => {
				conversation.push(prompt);
				const next = responses.shift();
				return next ? Promise.resolve(next) : Promise.reject(new Error('no answer left'));
			},
		};
	};
	return { agent, conversations };
}

/** Accepts `{ value: string }`, as a consumer's Zod `safeParse` would. */
const valueValidator: Validator<{ value: string }> = {
	validate: input =>
		typeof input === 'object' &&
		input !== null &&
		'value' in input &&
		typeof input.value === 'string'
			? { value: input.value }
			: undefined,
};

const anything: Validator<unknown> = { validate: input => input };

/** Stages whose names and inputs the tests choose freely. */
type Loose = Record<string, unknown>;
const stage = defineWorkflowStages<Loose, string>();

/** A stage that completes with its answer's `value`. */
function finalStage(name: string, agent: () => Agent): WorkflowStage<Loose, string> {
	return stage(name, {
		agent,
		prompt: input => `${name}:${String(input)}`,
		validator: valueValidator,
		transition: output => ({ type: 'complete', result: output.value }),
	});
}

/** A stage that goes to `next` with its answer's `value`. */
function passingStage(
	name: string,
	agent: () => Agent,
	next: string,
): WorkflowStage<Loose, string> {
	return stage(name, {
		agent,
		prompt: input => `${name}:${String(input)}`,
		validator: valueValidator,
		transition: output => ({ type: 'go', stage: next, input: output.value }),
	});
}

function stagesOf(
	...stages: WorkflowStage<Loose, string>[]
): Record<string, WorkflowStage<Loose, string>> {
	return Object.fromEntries(stages.map(each => [each.name, each]));
}

function workflowOf(initialStage: string, ...stages: WorkflowStage<Loose, string>[]) {
	return createWorkflow({ initialStage, stages: stagesOf(...stages), logger: { warn: vi.fn() } });
}

describe('workflow', () => {
	it('checks at compile time every go against the stage it names', () => {
		interface Inputs {
			triage: string;
			draft: { topic: string };
		}
		const typed = defineWorkflowStages<Inputs, string>();
		const draft = typed('draft', {
			agent: fakeAgent().agent,
			prompt: input => input.topic,
			validator: valueValidator,
			transition: output => ({ type: 'complete', result: output.value }),
		});
		const triage = typed('triage', {
			agent: fakeAgent().agent,
			prompt: input => input.toUpperCase(),
			validator: valueValidator,
			transition: output => ({ type: 'go', stage: 'draft', input: { topic: output.value } }),
		});
		const workflow = createWorkflow({ initialStage: 'triage', stages: { triage, draft } });
		const run: (input: string, options: { signal: AbortSignal }) => unknown =
			workflow.run.bind(workflow);
		void run;

		// @ts-expect-error The draft stage receives `{ topic }`, not a number.
		const wrongInput: WorkflowTransition<Inputs, string> = { type: 'go', stage: 'draft', input: 1 };
		const wrongStage: WorkflowTransition<Inputs, string> = {
			type: 'go',
			// @ts-expect-error There is no stage "drafft".
			stage: 'drafft',
			input: '',
		};
		// @ts-expect-error The workflow's result is a string.
		const wrongResult: WorkflowTransition<Inputs, string> = { type: 'stop', result: 1 };
		// Only compiled: each call would also throw when built.
		const wrongStages = () => {
			// @ts-expect-error Every stage must be present.
			createWorkflow({ initialStage: 'triage', stages: { triage } });
			// @ts-expect-error A stage is listed under its own name.
			createWorkflow({ initialStage: 'triage', stages: { triage: draft, draft } });
		};
		void [wrongInput, wrongStage, wrongResult, wrongStages];
	});

	it('runs three stages with different agents, passing only each handoff', async () => {
		const first = fakeAgent(answer({ value: 'a' }, 1));
		const second = fakeAgent(answer({ value: 'b' }, 2));
		const third = fakeAgent(answer({ value: 'done' }, 3));

		const result = await workflowOf(
			'start',
			passingStage('start', first.agent, 'middle'),
			passingStage('middle', second.agent, 'finish'),
			finalStage('finish', third.agent),
		).run('input', { signal });

		expect(first.run).toHaveBeenCalledWith('start:input', expect.anything());
		expect(second.run).toHaveBeenCalledWith('middle:a', expect.anything());
		expect(third.run).toHaveBeenCalledWith('finish:b', expect.anything());
		expect(result).toMatchObject({
			status: 'completed',
			result: 'done',
			tokens: { inputTokens: 6, outputTokens: 3 },
		});
		const duration = expect.any(Number) as number;
		expect(result.stages).toEqual([
			{
				stage: 'start',
				input: 'input',
				output: { value: 'a' },
				attempts: 1,
				duration,
				tokens: tokens(1),
				transition: 'go',
				nextStage: 'middle',
			},
			{
				stage: 'middle',
				input: 'a',
				output: { value: 'b' },
				attempts: 1,
				duration,
				tokens: tokens(2),
				transition: 'go',
				nextStage: 'finish',
			},
			{
				stage: 'finish',
				input: 'b',
				output: { value: 'done' },
				attempts: 1,
				duration,
				tokens: tokens(3),
				transition: 'complete',
			},
		]);
	});

	it('gives each stage an agent of its own, even one created async, which the run goes on with when it comes back', async () => {
		const drafts = rememberingAgents(answer({ value: 'draft 1' }), answer({ value: 'draft 2' }));
		const reviews = rememberingAgents(answer({ value: 'redo' }), answer({ value: 'ok' }));
		const workflow = workflowOf(
			'draft',
			passingStage('draft', drafts.agent, 'review'),
			stage('review', {
				agent: () => Promise.resolve(reviews.agent()),
				prompt: input => `review:${String(input)}`,
				validator: valueValidator,
				transition: (output, input) =>
					output.value === 'ok'
						? { type: 'complete', result: String(input) }
						: { type: 'go', stage: 'draft', input: output.value },
			}),
		);

		const result = await workflow.run('topic', { signal });

		expect(result.result).toBe('draft 2');
		expect(drafts.conversations).toEqual([['draft:topic', 'draft:redo']]);
		expect(reviews.conversations).toEqual([['review:draft 1', 'review:draft 2']]);
	});

	it('creates new agents for every run, so runs, even concurrent ones, never share a conversation', async () => {
		const agents = rememberingAgents(
			answer({ value: 'a' }),
			answer({ value: 'b' }),
			answer({ value: 'c' }),
			answer({ value: 'd' }),
			answer({ value: 'e' }),
			answer({ value: 'f' }),
		);
		const workflow = workflowOf(
			'first',
			passingStage('first', agents.agent, 'last'),
			finalStage('last', agents.agent),
		);

		await workflow.run('one', { signal });
		await Promise.all([workflow.run('two', { signal }), workflow.run('three', { signal })]);

		expect(agents.conversations).toHaveLength(6);
		for (const conversation of agents.conversations) expect(conversation).toHaveLength(1);
		expect(agents.conversations.slice(0, 2)).toEqual([['first:one'], ['last:a']]);
	});

	it('stops on purpose without running the stages after it', async () => {
		const downstream = fakeAgent();
		const result = await workflowOf(
			'gate',
			stage('gate', {
				agent: fakeAgent(answer({ value: 'not eligible' })).agent,
				prompt: () => 'gate',
				validator: valueValidator,
				transition: output => ({ type: 'stop', result: output.value }),
			}),
			finalStage('downstream', downstream.agent),
		).run(null, { signal });

		expect(result).toMatchObject({ status: 'stopped', result: 'not eligible' });
		expect(result.stages).toMatchObject([{ stage: 'gate', transition: 'stop' }]);
		expect(downstream.run).not.toHaveBeenCalled();
	});

	it('goes to the stage a transition chooses, skipping the others', async () => {
		const unused = fakeAgent();
		const chosen = fakeAgent(answer({ value: 'chosen' }));
		const result = await workflowOf(
			'router',
			passingStage('router', fakeAgent(answer({ value: 'chosen' })).agent, 'chosen'),
			finalStage('unused', unused.agent),
			finalStage('chosen', chosen.agent),
		).run(null, { signal });

		expect(result.result).toBe('chosen');
		expect(chosen.run).toHaveBeenCalledWith('chosen:chosen', expect.anything());
		expect(unused.run).not.toHaveBeenCalled();
	});

	it('asks the same agent again after an answer that is not JSON or not valid', async () => {
		const parse = rememberingAgents(
			{ response: 'not json', tokens: tokens(1), duration: 0 },
			answer({ wrong: true }, 2),
			{ response: '```json\n{"value":"ok"}\n```', tokens: tokens(3), duration: 0 },
		);
		const next = fakeAgent(answer({ value: 'next' }, 4));
		const logger = { warn: vi.fn() };

		const result = await createWorkflow({
			initialStage: 'parse',
			stages: stagesOf(passingStage('parse', parse.agent, 'next'), finalStage('next', next.agent)),
			logger,
		}).run(null, { signal });

		expect(result.result).toBe('next');
		expect(parse.conversations).toEqual([
			[
				'parse:null',
				expect.stringContaining('it was not valid JSON.') as string,
				expect.stringContaining('it did not match the schema.') as string,
			],
		]);
		expect(next.run).toHaveBeenCalledOnce();
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(result.stages[0]).toMatchObject({ attempts: 3, tokens: { inputTokens: 6 } });
		expect(result.tokens).toMatchObject({ inputTokens: 10 });
	});

	it('fails after the stage runs out of attempts, carrying every answer it paid for', async () => {
		const bad = fakeAgent(
			{ response: 'bad', tokens: tokens(2), duration: 0 },
			answer({ wrong: true }, 3),
		);
		const downstream = fakeAgent();

		const failure = createWorkflow({
			initialStage: 'earlier',
			stages: stagesOf(
				passingStage('earlier', fakeAgent(answer({ value: 'a' }, 1)).agent, 'bad'),
				{ ...passingStage('bad', bad.agent, 'downstream'), maxAttempts: 2 },
				finalStage('downstream', downstream.agent),
			),
			maxAttempts: 5,
			logger: { warn: vi.fn() },
		}).run(null, { signal });

		await expect(failure).rejects.toBeInstanceOf(UnrecoverableError);
		await expect(failure).rejects.toMatchObject({
			message: 'Workflow stage attempts exhausted',
			tokens: { inputTokens: 6 },
		});
		expect(bad.run).toHaveBeenCalledTimes(2);
		expect(downstream.run).not.toHaveBeenCalled();
	});

	it("keeps a failing stage's own classification and usage, adding the stages before it", async () => {
		const leaf = new RecoverableError('provider busy', { cause: '429', tokens: tokens(7) });

		const failure = workflowOf(
			'first',
			passingStage('first', fakeAgent(answer({ value: 'a' }, 4)).agent, 'second'),
			finalStage('second', fakeAgent(leaf).agent),
		).run(null, { signal });

		await expect(failure).rejects.toBeInstanceOf(RecoverableError);
		await expect(failure).rejects.toMatchObject({
			message: 'provider busy',
			tokens: { inputTokens: 11 },
		});
	});

	it('classifies an agent that throws an unclassified error', async () => {
		await expect(
			workflowOf('broken', finalStage('broken', fakeAgent(new TypeError('boom')).agent)).run(null, {
				signal,
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'Workflow stage "broken" failed',
		});
	});

	it('reports no total when any answer did not report its usage', async () => {
		const result = await workflowOf(
			'reported',
			passingStage('reported', fakeAgent(answer({ value: 'a' }, 1)).agent, 'unreported'),
			finalStage('unreported', fakeAgent(answer({ value: 'b' })).agent),
		).run(null, { signal });

		expect(result.tokens).toBeUndefined();
		expect(result.stages[0]?.tokens).toEqual(tokens(1));
		expect(result.stages[1]).not.toHaveProperty('tokens');
	});

	it('narrates each attempt and transition, and passes its agents events through unchanged', async () => {
		const events: ProgressEvent[] = [];
		const answers = [{ response: 'bad', duration: 0 }, answer({ value: 'a' })];
		const run = vi.fn<Agent['run']>((_prompt, options) => {
			options.onProgress?.({ type: 'agentMessage', message: 'working', agent: 'reviewer' });
			const next = answers.shift();
			return next ? Promise.resolve(next) : Promise.reject(new Error('no answer left'));
		});

		await workflowOf(
			'first',
			passingStage('first', () => ({ run }), 'last'),
			finalStage('last', fakeAgent(answer({ value: 'done' })).agent),
		).run(null, { signal, onProgress: event => events.push(event) });

		expect(events).toEqual([
			{ type: 'workflowStage', stage: 'first', attempt: 1 },
			{ type: 'agentMessage', message: 'working', agent: 'reviewer' },
			{ type: 'workflowStage', stage: 'first', attempt: 2 },
			{ type: 'agentMessage', message: 'working', agent: 'reviewer' },
			{ type: 'workflowTransition', stage: 'first', transition: 'go', nextStage: 'last' },
			{ type: 'workflowStage', stage: 'last', attempt: 1 },
			{ type: 'workflowTransition', stage: 'last', transition: 'complete' },
		]);
	});

	it('classifies a throwing agent factory, prompt, validator, transition, progress callback or logger as a host failure', async () => {
		const host = new Error('host');
		const throwing = () => {
			throw host;
		};
		const cases: { change: Partial<WorkflowStage<Loose, string>>; message: string }[] = [
			{ change: { agent: throwing }, message: 'Workflow stage "host" could not create its agent' },
			{
				change: { agent: () => Promise.reject(host) },
				message: 'Workflow stage "host" could not create its agent',
			},
			{ change: { prompt: throwing }, message: 'Workflow stage "host" could not build its prompt' },
			{
				change: { validator: { validate: throwing } },
				message: 'Workflow stage "host" could not validate its answer',
			},
			{
				change: { transition: throwing },
				message: 'Workflow stage "host" could not choose its transition',
			},
		];
		for (const { change, message } of cases) {
			const broken = { ...finalStage('host', fakeAgent(answer({ value: 'a' })).agent), ...change };
			await expect(workflowOf('host', broken).run(null, { signal })).rejects.toMatchObject({
				constructor: UnrecoverableError,
				message,
				cause: 'host',
			});
		}

		const silent = fakeAgent(answer({ value: 'a' }));
		await expect(
			workflowOf('progress', finalStage('progress', silent.agent)).run(null, {
				signal,
				onProgress: throwing,
			}),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'Workflow progress callback failed',
		});
		expect(silent.run).not.toHaveBeenCalled();

		await expect(
			createWorkflow({
				initialStage: 'logged',
				stages: stagesOf(finalStage('logged', fakeAgent({ response: 'bad', duration: 0 }).agent)),
				logger: { warn: throwing },
			}).run(null, { signal }),
		).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'Workflow logger failed while reporting a retry',
		});
	});

	it('rejects a transition that is not one, or that leads nowhere, before any later stage runs', async () => {
		const downstream = fakeAgent();
		const cases: unknown[] = [
			{ type: 'go', input: null },
			{ type: 'go', stage: 'downstream' },
			{ type: 'unknown', input: null },
			{ type: 'complete' },
			{ type: 'go', stage: 'missing', input: null },
		];
		for (const transition of cases) {
			const source = stage('source', {
				agent: fakeAgent(answer({})).agent,
				prompt: () => 'source',
				validator: anything,
				transition: () => transition as WorkflowTransition<Loose, string>,
			});
			await expect(
				workflowOf('source', source, finalStage('downstream', downstream.agent)).run(null, {
					signal,
				}),
			).rejects.toBeInstanceOf(UnrecoverableError);
		}
		expect(downstream.run).not.toHaveBeenCalled();
	});

	it('ends a loop of stages at maxTransitions', async () => {
		const loop = fakeAgent(answer({ value: '1' }), answer({ value: '2' }), answer({ value: '3' }));

		await expect(
			createWorkflow({
				initialStage: 'loop',
				stages: stagesOf(passingStage('loop', loop.agent, 'loop')),
				maxTransitions: 2,
			}).run(null, { signal }),
		).rejects.toMatchObject({ message: 'Workflow transition limit exhausted' });
		expect(loop.run).toHaveBeenCalledTimes(3);
	});

	it('rejects stages that cannot run when it is built', () => {
		const agent = fakeAgent().agent;
		const only = finalStage('stage', agent);
		const build =
			(
				stages: Record<string, WorkflowStage<Loose, string>>,
				options: { initialStage?: string; maxAttempts?: number; maxTransitions?: number } = {},
			) =>
			() =>
				createWorkflow({ initialStage: 'stage', stages, ...options });

		expect(build({})).toThrow(RangeError);
		expect(build({ stage: only }, { initialStage: 'orphan' })).toThrow(/not among the stages/);
		expect(build({ stage: only, other: only })).toThrow(/listed as "other"/);
		expect(build({ stage: only, ' ': finalStage(' ', agent) })).toThrow(/non-empty/);
		expect(build({ stage: { ...only, maxAttempts: 0 } })).toThrow(/maxAttempts/);
		expect(build({ stage: only }, { maxAttempts: 1.5 })).toThrow(/maxAttempts/);
		expect(build({ stage: only }, { maxTransitions: 0 })).toThrow(/maxTransitions/);
	});

	it('stops before any later stage on cancellation, rejecting with the signal reason', async () => {
		const controller = new AbortController();
		const first = fakeAgent();
		first.run.mockImplementation(() => {
			controller.abort();
			return Promise.resolve(answer({ value: 'late' }));
		});
		const second = fakeAgent();
		const workflow = workflowOf(
			'first',
			passingStage('first', first.agent, 'second'),
			finalStage('second', second.agent),
		);

		await expect(workflow.run(null, { signal: controller.signal })).rejects.toSatisfy(
			error => error === controller.signal.reason,
		);
		expect(second.run).not.toHaveBeenCalled();

		const thrownAfterAbort = new AbortController();
		first.run.mockImplementation(() => {
			thrownAfterAbort.abort();
			return Promise.reject(new Error('the agent noticed late'));
		});
		await expect(workflow.run(null, { signal: thrownAfterAbort.signal })).rejects.toSatisfy(
			error => error === thrownAfterAbort.signal.reason,
		);

		first.run.mockClear();
		await expect(workflow.run(null, { signal: AbortSignal.abort() })).rejects.toSatisfy(
			isAbortError,
		);
		expect(first.run).not.toHaveBeenCalled();
		expect(second.run).not.toHaveBeenCalled();
	});

	it('times out through AbortSignal.timeout, which isAbortError recognizes', async () => {
		const slow = fakeAgent();
		slow.run.mockImplementation(
			(_prompt, options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => {
						reject(options.signal.reason as Error);
					});
				}),
		);
		const second = fakeAgent();

		const failure = workflowOf(
			'slow',
			passingStage('slow', slow.agent, 'second'),
			finalStage('second', second.agent),
		).run(null, { signal: AbortSignal.timeout(5) });

		await expect(failure).rejects.toMatchObject({ name: 'TimeoutError' });
		await expect(failure).rejects.toSatisfy(isAbortError);
		expect(second.run).not.toHaveBeenCalled();
	});

	it('shares one run context across its stages and keeps concurrent runs apart', async () => {
		const contexts: { signal: AbortSignal; context: RunContext | undefined }[] = [];
		const run = vi.fn<Agent['run']>((_prompt, options) => {
			contexts.push({ signal: options.signal, context: runContextOf(options) });
			return Promise.resolve(answer({ value: 'a' }, 1));
		});
		const workflow = workflowOf(
			'first',
			passingStage('first', () => ({ run }), 'last'),
			finalStage('last', () => ({ run })),
		);
		const one = new AbortController().signal;
		const two = new AbortController().signal;

		const [first, second] = await Promise.all([
			workflow.run(null, { signal: one }),
			workflow.run(null, { signal: two }),
		]);

		expect(first.tokens).toMatchObject({ inputTokens: 2 });
		expect(second.tokens).toMatchObject({ inputTokens: 2 });
		const ofOne = contexts.filter(item => item.signal === one).map(item => item.context);
		const ofTwo = contexts.filter(item => item.signal === two).map(item => item.context);
		expect(ofOne).toHaveLength(2);
		expect(ofOne[0]).toBeInstanceOf(RunContext);
		expect(ofOne[0]).toBe(ofOne[1]);
		expect(ofTwo[0]).toBe(ofTwo[1]);
		expect(ofOne[0]).not.toBe(ofTwo[0]);
	});

	it('passes its stages no inbox, so what was sent stays for the next run', async () => {
		const received: RunOptions[] = [];
		const run = vi.fn<Agent['run']>((_prompt, options) => {
			received.push(options);
			return Promise.resolve(answer({ value: 'a' }));
		});
		const workflow = workflowOf(
			'stage',
			finalStage('stage', () => ({ run })),
		);
		const inbox = new Inbox();
		inbox.send('one more thing');

		await workflow.run(null, { signal, inbox });

		const [options] = received;
		expect(options?.inbox).toBeUndefined();
		expect(options && runContextOf(options)).toBeInstanceOf(RunContext);
		expect(inbox.close()).toEqual(['one more thing']);
	});

	it('reports its runId and closes its context only when it owns them', async () => {
		const finished = vi.fn(() => Promise.resolve());
		const agent = (): Agent => ({
			run: (_prompt, options) => {
				const context = runContextOf(options);
				if (context) {
					context.historyRun.runId = 'run-1';
					context.onFinish(finished);
				}
				return Promise.resolve(answer({ value: 'done' }));
			},
		});
		const workflow = workflowOf('stage', finalStage('stage', agent));

		await expect(workflow.run(null, { signal })).resolves.toMatchObject({ runId: 'run-1' });
		expect(finished).toHaveBeenCalledWith('completed');

		finished.mockClear();
		const inherited = await workflow.run(null, withRunContext({ signal }, new RunContext()));
		expect(inherited).not.toHaveProperty('runId');
		expect(finished).not.toHaveBeenCalled();
	});

	it('keeps its result when the run context cannot close, and warns', async () => {
		const agent = (): Agent => ({
			run: (_prompt, options) => {
				runContextOf(options)?.onFinish(() => Promise.reject(new Error('cleanup failed')));
				return Promise.resolve(answer({ value: 'done' }));
			},
		});
		const logger = { warn: vi.fn() };

		await expect(
			createWorkflow({
				initialStage: 'stage',
				stages: stagesOf(finalStage('stage', agent)),
				logger,
			}).run(null, { signal }),
		).resolves.toMatchObject({ result: 'done' });
		expect(logger.warn).toHaveBeenCalledWith('The run could not close its records: cleanup failed');
	});
});
