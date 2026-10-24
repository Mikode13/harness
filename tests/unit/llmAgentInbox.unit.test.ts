import { describe, expect, it } from 'vitest';
import type { Agent, AgentResponse } from '../../src/agent/domain/agent.ts';
import { Inbox } from '../../src/agent/domain/inbox.ts';
import { RunInProgressError } from '../../src/agent/domain/oneRunAtATime.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import { RetryingAgent } from '../../src/retry/domain/model/retryingAgent.ts';
import {
	RecoverableError,
	UnrecoverableError,
	withSpentTokens,
} from '../../src/shared/domain/errors.ts';
import type { DelegatingTool, PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { agentAsTool } from '../../src/tools/infrastructure/agentAsTool.ts';
import { assistantResponse, textResponse, toolCall } from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;
const schema = { type: 'object' as const, properties: {}, required: [] };
const logger = { warn: () => undefined };

type Step = (context: Message[]) => LLMResponse | Promise<LLMResponse>;

/** A model that takes each step in order, given what it was sent, and records every context. */
class ScriptedModel implements LLMClient {
	readonly contexts: Message[][] = [];
	private readonly steps: Step[];

	constructor(...steps: Step[]) {
		this.steps = steps;
	}

	send({ context }: { context: Message[] }): Promise<LLMResponse> {
		this.contexts.push(structuredClone(context));
		const step = this.steps.shift();
		if (!step) return Promise.reject(new Error('ScriptedModel ran out of steps'));
		try {
			return Promise.resolve(step(context));
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>(settle => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** What the user sent while the run worked, as the model read it in `context`. */
function sentIn(context: Message[] | undefined): string[][] {
	return (context ?? [])
		.filter(message => message.role === 'user')
		.map(message => message.content.map(part => (part.type === 'text' ? part.text : '')))
		.filter(([note]) => note === 'The user sent this while you worked:')
		.map(([, ...texts]) => texts);
}

/** A tool whose call runs `run`. */
function tool(run: () => void): PreparingTool {
	return {
		name: 'edit',
		description: 'Edits',
		inputSchema: schema,
		prepare: () =>
			Promise.resolve({
				risk: 'safe',
				run: () => {
					run();
					return Promise.resolve('edited');
				},
			}),
	};
}

describe('Inbox', () => {
	it('hands back what was sent in order once closed, and takes nothing after', () => {
		const inbox = new Inbox();

		expect(inbox.send('first')).toBe(true);
		expect(inbox.send('second')).toBe(true);

		expect(inbox.close()).toEqual(['first', 'second']);
		expect(inbox.send('late')).toBe(false);
		expect(inbox.close()).toEqual([]);
	});

	it('refuses a message with no text, which a provider may refuse', () => {
		const inbox = new Inbox();

		expect(() => inbox.send(' \n')).toThrow(RangeError);
		expect(inbox.close()).toEqual([]);
	});
});

describe('LLMAgent with an inbox', () => {
	it('reads what the user sent during a step after its tool results, and goes on', async () => {
		const inbox = new Inbox();
		const llmClient = new ScriptedModel(
			() => assistantResponse([toolCall('call-1', 'edit')]),
			() => textResponse('done'),
		);
		const agent = new LLMAgent({
			llmClient,
			tools: [tool(() => inbox.send('also rename it'))],
		});

		const response = await agent.run('edit it', { signal, inbox });

		expect(response.response).toBe('done');
		const context = llmClient.contexts[1];
		expect(context?.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
		expect(sentIn(context)).toEqual([['also rename it']]);
		expect(inbox.close()).toEqual([]);
	});

	it('takes an answer given before it read what the user sent as a step, not the end', async () => {
		const inbox = new Inbox();
		const llmClient = new ScriptedModel(
			() => {
				inbox.send('one more thing');
				inbox.send('and another');
				return textResponse('done');
			},
			() => textResponse('done with both'),
		);
		const agent = new LLMAgent({ llmClient });

		const response = await agent.run('do it', { signal, inbox });

		expect(response.response).toBe('done with both');
		expect(sentIn(llmClient.contexts[1])).toEqual([['one more thing', 'and another']]);
		expect(inbox.close()).toEqual([]);
	});

	it('keeps what it read in the conversation, for the runs after', async () => {
		const inbox = new Inbox();
		const llmClient = new ScriptedModel(
			() => {
				inbox.send('one more thing');
				return textResponse('done');
			},
			() => textResponse('done with it'),
			() => textResponse('next done'),
		);
		const agent = new LLMAgent({ llmClient });

		await agent.run('do it', { signal, inbox });
		inbox.close();
		await agent.run('next', { signal });

		expect(sentIn(llmClient.contexts[2])).toEqual([['one more thing']]);
	});

	it('leaves in the inbox what arrives on its last step, which has none left to answer it', async () => {
		const inbox = new Inbox();
		const llmClient = new ScriptedModel(() => {
			inbox.send('too late');
			return textResponse('done');
		});
		const agent = new LLMAgent({ llmClient, maxSteps: 1 });

		const response = await agent.run('do it', { signal, inbox });

		expect(response.response).toBe('done');
		expect(inbox.close()).toEqual(['too late']);
	});

	it('leaves in the inbox what arrives once it answered', async () => {
		const inbox = new Inbox();
		const agent = new LLMAgent({ llmClient: new ScriptedModel(() => textResponse('done')) });

		await agent.run('do it', { signal, inbox });

		expect(inbox.send('after the end')).toBe(true);
		expect(inbox.close()).toEqual(['after the end']);
	});

	it('gives back what it read when the run is not kept', async () => {
		const inbox = new Inbox();
		const llmClient = new ScriptedModel(
			() => {
				inbox.send('one more thing');
				return textResponse('done');
			},
			() => {
				throw new UnrecoverableError('The model failed', { cause: 'It broke.' });
			},
		);
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('do it', { signal, inbox })).rejects.toThrow('The model failed');

		expect(inbox.close()).toEqual(['one more thing']);
	});

	it('reads again, in a retried attempt, what a failed attempt read', async () => {
		const inbox = new Inbox();
		const llmClient = new ScriptedModel(
			() => {
				inbox.send('one more thing');
				return textResponse('done');
			},
			() => {
				throw new RecoverableError('The provider is busy', { cause: 'Try again.' });
			},
			() => textResponse('done'),
			() => textResponse('done with it'),
		);
		const agent = new RetryingAgent({ inner: new LLMAgent({ llmClient }), logger });

		const response = await agent.run('do it', { signal, inbox });

		expect(response.response).toBe('done with it');
		expect(sentIn(llmClient.contexts[2])).toEqual([]);
		expect(sentIn(llmClient.contexts[3])).toEqual([['one more thing']]);
		expect(inbox.close()).toEqual([]);
	});

	it('wakes for what the user sent while it waits for its agents, which keep working', async () => {
		const inbox = new Inbox();
		const answer = deferred<AgentResponse>();
		const committer: Agent = { run: () => answer.promise };
		const llmClient = new ScriptedModel(
			() => assistantResponse([toolCall('call-1', 'commit', { task: 'commit it' })]),
			() => {
				// Once the run waits for the agent.
				setTimeout(() => inbox.send('also push it'), 0);
				return textResponse('I wait.');
			},
			context => {
				expect(sentIn(context)).toEqual([['also push it']]);
				setTimeout(() => {
					answer.resolve({ response: 'committed', duration: 1 });
				}, 0);
				return textResponse('Noted; I still wait.');
			},
			() => textResponse('parent done'),
		);
		const agent = new LLMAgent({
			llmClient,
			tools: [
				agentAsTool({
					name: 'commit',
					description: 'Commits the work',
					createAgent: () => committer,
				}) as unknown as DelegatingTool,
			],
		});

		const response = await agent.run('commit it', { signal, inbox });

		expect(response.response).toBe('parent done');
		expect(llmClient.contexts).toHaveLength(4);
		expect(inbox.close()).toEqual([]);
	});
});

describe('LLMAgent with a run in progress', () => {
	it('rejects a second run without sending it, and takes one once the first ends', async () => {
		const first = deferred<LLMResponse>();
		const llmClient = new ScriptedModel(
			() => first.promise,
			() => textResponse('next done'),
		);
		const agent = new LLMAgent({ llmClient });

		const running = agent.run('first', { signal });
		const second = agent.run('second', { signal });

		await expect(second).rejects.toBeInstanceOf(RunInProgressError);
		await expect(second).rejects.toBeInstanceOf(UnrecoverableError);
		first.resolve(textResponse('first done'));
		await expect(running).resolves.toMatchObject({ response: 'first done' });
		await expect(agent.run('next', { signal })).resolves.toMatchObject({ response: 'next done' });
		expect(llmClient.contexts).toHaveLength(2);
	});

	it('takes a run once a failed one ends', async () => {
		const llmClient = new ScriptedModel(
			() => {
				throw new UnrecoverableError('The model failed', { cause: 'It broke.' });
			},
			() => textResponse('done'),
		);
		const agent = new LLMAgent({ llmClient });

		await expect(agent.run('first', { signal })).rejects.toThrow('The model failed');

		await expect(agent.run('next', { signal })).resolves.toMatchObject({ response: 'done' });
	});

	it('stays itself when an outer agent adds what it spent', () => {
		const tokens = { inputTokens: 1, outputTokens: 1, readCacheTokens: 0, writtenCacheTokens: 0 };

		const counted = withSpentTokens(new RunInProgressError(), tokens);

		expect(counted).toBeInstanceOf(RunInProgressError);
		expect(counted).toMatchObject({ tokens, message: 'The agent already has a run in progress' });
	});
});
