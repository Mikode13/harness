import { describe, expect, it } from 'vitest';
import type { AgentResponse, ProgressEvent, RunOptions } from '../../src/agent/domain/agent.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import { isAbortError } from '../../src/shared/domain/isAbortError.ts';
import type { DelegatingTool } from '../../src/tools/domain/preparedCall.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import { agentAsTool } from '../../src/tools/infrastructure/agentAsTool.ts';
import { assistantResponse, textResponse, toolCall } from '../support/fakeLlmClient.ts';

// The validation scenario of #28: three runs at once, a simple agent, one that hands work to
// another agent, and an unrelated one, held so they overlap.

type Step = (context: Message[], signal: AbortSignal) => LLMResponse | Promise<LLMResponse>;

/** A model that takes each step in order, records what it was sent, and stops when cancelled. */
class GatedModel implements LLMClient {
	readonly contexts: Message[][] = [];
	readonly signals: AbortSignal[] = [];
	private readonly steps: Step[];

	constructor(...steps: Step[]) {
		this.steps = steps;
	}

	async send({ context }: { context: Message[] }, signal: AbortSignal): Promise<LLMResponse> {
		signal.throwIfAborted();
		this.contexts.push(structuredClone(context));
		this.signals.push(signal);
		const step = this.steps.shift();
		if (!step) throw new Error('GatedModel ran out of steps');
		const cancelled = new Promise<never>((_, reject) => {
			signal.addEventListener('abort', () => {
				reject(new DOMException('The operation was aborted', 'AbortError'));
			});
		});
		return structuredClone(await Promise.race([step(context, signal), cancelled]));
	}
}

function deferred<T = void>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>(settle => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** Resolves once `count` callers have arrived, so none goes on before all are in flight. */
function barrier(count: number): () => Promise<void> {
	const all = deferred();
	let arrived = 0;
	return () => {
		arrived++;
		if (arrived === count) all.resolve();
		return all.promise;
	};
}

/** A tool that writes nothing and answers at once, so a run takes a second step. */
function noteTool(name: string, risk: 'safe' | 'destructive' = 'safe'): Tool {
	return {
		name,
		description: `Notes something for ${name}`,
		inputSchema: { type: 'object', properties: {}, required: [] },
		risk: () => risk,
		execute: () => Promise.resolve(`${name} noted`),
	};
}

/** Every text the model was sent across its calls, to check no other run's words reached it. */
function seen(model: GatedModel): string {
	return JSON.stringify(model.contexts);
}

/** Answers once the model has read its agent's answer, and waits until then. */
const waitForAnswer =
	(final: string): Step =>
	context =>
		JSON.stringify(context).includes('This message is from the harness')
			? textResponse(final)
			: textResponse('I wait.');

/**
 * The three runs. Each model takes a first step only once all three are in flight, and a
 * second only once the agent the second run started is working too; `release` lets the
 * second steps of the simple and the unrelated run end.
 */
function scenario() {
	const firstSteps = barrier(3);
	const secondSteps = barrier(3);
	const release = deferred();
	const childStarted = deferred();

	const simpleModel = new GatedModel(
		async () => {
			await firstSteps();
			return assistantResponse([toolCall('a-1', 'noteAlpha')]);
		},
		async () => {
			await secondSteps();
			await release.promise;
			return textResponse('alpha done');
		},
	);
	const childModel = new GatedModel(async (_, signal) => {
		childStarted.resolve();
		await secondSteps();
		// Works until the others end, or until it is cancelled.
		await release.promise;
		signal.throwIfAborted();
		return textResponse('beta researched');
	});
	const parentModel = new GatedModel(
		async () => {
			await firstSteps();
			return assistantResponse([toolCall('b-1', 'research', { task: 'Look into beta' })]);
		},
		...Array.from({ length: 5 }, () => waitForAnswer('beta done')),
	);
	const unrelatedModel = new GatedModel(
		async () => {
			await firstSteps();
			return assistantResponse([toolCall('c-1', 'noteGamma')]);
		},
		async () => {
			await secondSteps();
			await release.promise;
			return textResponse('gamma done');
		},
	);

	const simple = new LLMAgent({ llmClient: simpleModel, tools: [noteTool('noteAlpha')] });
	const parent = new LLMAgent({
		llmClient: parentModel,
		tools: [
			agentAsTool({
				name: 'research',
				description: 'Researches a question',
				createAgent: () => new LLMAgent({ llmClient: childModel }),
				// The public type hides how the agent loop runs it.
			}) as unknown as DelegatingTool,
		],
	});
	const unrelated = new LLMAgent({ llmClient: unrelatedModel, tools: [noteTool('noteGamma')] });

	const events = {
		simple: [] as ProgressEvent[],
		parent: [] as ProgressEvent[],
		unrelated: [] as ProgressEvent[],
	};
	const controllers = {
		simple: new AbortController(),
		parent: new AbortController(),
		unrelated: new AbortController(),
	};
	const optionsFor = (name: keyof typeof events, extra: Partial<RunOptions> = {}): RunOptions => ({
		signal: controllers[name].signal,
		onProgress: event => events[name].push(event),
		...extra,
	});

	return {
		models: { simpleModel, parentModel, childModel, unrelatedModel },
		agents: { simple, parent, unrelated },
		events,
		controllers,
		optionsFor,
		release,
		childStarted,
	};
}

/** The names of the tools a run's events narrate, its agents' included. */
function toolsNarrated(events: ProgressEvent[]): string[] {
	return [
		...new Set(
			events.flatMap(event => {
				if (event.type === 'tool') return [event.name];
				if (event.type === 'subagent' && event.event.type === 'tool') return [event.event.name];
				return [];
			}),
		),
	].sort();
}

describe('three runs at once', () => {
	it('each sees only its own context, events, usage and session', async () => {
		const { models, agents, events, optionsFor, release, childStarted } = scenario();

		const running = Promise.all([
			agents.simple.run('Alpha task', optionsFor('simple')),
			agents.parent.run('Beta task', optionsFor('parent')),
			agents.unrelated.run('Gamma task', optionsFor('unrelated')),
		]);
		// Every run is past its first step, and the second run's agent is working.
		await childStarted.promise;
		release.resolve();
		const [simple, parent, unrelated] = await running;

		expect([simple.response, parent.response, unrelated.response]).toEqual([
			'alpha done',
			'beta done',
			'gamma done',
		]);
		// No run's words reached another run's model, and the agent saw only its task.
		expect(seen(models.simpleModel)).not.toMatch(/[Bb]eta|[Gg]amma/);
		expect(seen(models.unrelatedModel)).not.toMatch(/[Aa]lpha|[Bb]eta task|research/);
		expect(seen(models.parentModel)).not.toMatch(/[Aa]lpha|[Gg]amma/);
		expect(seen(models.childModel)).toContain('Look into beta');
		expect(seen(models.childModel)).not.toMatch(/Beta task|[Aa]lpha|[Gg]amma/);
		// Each run's callback narrated its own tools only.
		expect(toolsNarrated(events.simple)).toEqual(['noteAlpha']);
		expect(toolsNarrated(events.parent)).toEqual(['research']);
		expect(toolsNarrated(events.unrelated)).toEqual(['noteGamma']);
		expect(events.parent.some(event => event.type === 'subagent')).toBe(true);
		expect([...events.simple, ...events.unrelated].some(event => event.type === 'subagent')).toBe(
			false,
		);
		// Each run counts its own model calls, its agent's included: one token each way per call.
		const calls = (...counts: number[]) => counts.reduce((sum, count) => sum + count, 0);
		expect(simple.tokens?.inputTokens).toBe(calls(models.simpleModel.contexts.length));
		expect(unrelated.tokens?.inputTokens).toBe(calls(models.unrelatedModel.contexts.length));
		expect(parent.tokens?.inputTokens).toBe(
			calls(models.parentModel.contexts.length, models.childModel.contexts.length),
		);
		expect(new Set([simple.session?.id, parent.session?.id, unrelated.session?.id]).size).toBe(3);
	});

	it('cancelling one, while its agent works, leaves the others running', async () => {
		const { models, agents, controllers, optionsFor, release, childStarted } = scenario();

		const simple = agents.simple.run('Alpha task', optionsFor('simple'));
		const parent = agents.parent.run('Beta task', optionsFor('parent'));
		const unrelated = agents.unrelated.run('Gamma task', optionsFor('unrelated'));
		await childStarted.promise;
		controllers.parent.abort();

		const cancelled: unknown = await parent.catch((error: unknown) => error);
		expect(isAbortError(cancelled)).toBe(true);
		// The agent it started was cancelled with it.
		expect(models.childModel.signals[0]?.aborted).toBe(true);
		release.resolve();
		const answers: AgentResponse[] = await Promise.all([simple, unrelated]);
		expect(answers.map(answer => answer.response)).toEqual(['alpha done', 'gamma done']);
	});

	it('a host callback failing in one ends that run alone', async () => {
		const { agents, optionsFor, release, childStarted } = scenario();
		const failing = new LLMAgent({
			llmClient: new GatedModel(() => assistantResponse([toolCall('d-1', 'wipe')])),
			tools: [noteTool('wipe', 'destructive')],
		});

		const simple = agents.simple.run('Alpha task', optionsFor('simple'));
		const parent = agents.parent.run('Beta task', optionsFor('parent'));
		const unrelated = agents.unrelated.run('Gamma task', optionsFor('unrelated'));
		// While all three are in flight.
		await childStarted.promise;
		await expect(
			failing.run('Delta task', {
				signal: new AbortController().signal,
				approve: () => {
					throw new Error('the approver broke');
				},
			}),
		).rejects.toThrow(UnrecoverableError);
		release.resolve();

		const answers = await Promise.all([simple, parent, unrelated]);
		expect(answers.map(answer => answer.response)).toEqual([
			'alpha done',
			'beta done',
			'gamma done',
		]);
	});
});
