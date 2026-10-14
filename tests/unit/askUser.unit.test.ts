import { describe, expect, it, vi } from 'vitest';
import type { ProgressEvent, RunOptions } from '../../src/agent/domain/agent.ts';
import { rememberAnswers, type UserQuestion } from '../../src/agent/domain/question.ts';
import { readAnswers, readQuestions } from '../../src/engines/domain/model/askUser.ts';
import { RetryingAgent } from '../../src/retry/domain/model/retryingAgent.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
} from '../../src/shared/domain/errors.ts';
import { assistantResponse, FakeLLMClient, textResponse } from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

const question: UserQuestion = {
	question: 'Which shape should the API take?',
	options: [
		{ label: 'One function', description: 'Simpler, one more parameter.' },
		{ label: 'Two functions', description: 'One per path.' },
	],
	multiSelect: false,
};

const askCall = (input: unknown) => ({
	type: 'toolCall' as const,
	id: 'ask-1',
	name: 'askUser',
	input,
});

describe('readQuestions', () => {
	it('reads well-formed questions', () => {
		expect(readQuestions({ questions: [question] })).toEqual([question]);
	});

	it.each([
		['no questions', { questions: [] }, 'Ask 1 to 4 questions.'],
		['five questions', { questions: Array(5).fill(question) }, 'Ask 1 to 4 questions.'],
		['no text', { questions: [{ ...question, question: ' ' }] }, 'Question 1 has no text.'],
		[
			'one option',
			{ questions: [{ ...question, options: question.options.slice(0, 1) }] },
			'Question 1 needs 2 to 4 options.',
		],
		[
			'an option without a label',
			{
				questions: [
					{ ...question, options: [{ label: '', description: '' }, ...question.options] },
				],
			},
			'Every option of question 1 needs a label and a description.',
		],
		[
			'no multiSelect',
			{ questions: [{ question: question.question, options: question.options }] },
			'Question 1 must say whether it is multiSelect.',
		],
	])('refuses %s, saying what to fix', (_, input, reason) => {
		expect(readQuestions(input)).toBe(reason);
	});
});

describe('readAnswers', () => {
	it('takes one non-empty answer per question, and nothing else', () => {
		expect(readAnswers(['Two functions'], [question])).toEqual(['Two functions']);
		expect(readAnswers([], [question])).toBeUndefined();
		expect(readAnswers([''], [question])).toBeUndefined();
		expect(readAnswers([42], [question])).toBeUndefined();
		expect(readAnswers('Two functions', [question])).toBeUndefined();
	});
});

describe('LLMAgent with askUser', () => {
	it('offers askUser only to a run that can answer it', async () => {
		const llmClient = new FakeLLMClient(textResponse('a'), textResponse('b'));
		const agent = new LLMAgent({ llmClient });

		await agent.run('prompt', { signal });
		await agent.run('prompt', { signal, ask: () => [] });

		expect(llmClient.tools[0]?.map(tool => tool.name)).toEqual([]);
		expect(llmClient.tools[1]?.map(tool => tool.name)).toEqual(['askUser']);
	});

	it('asks the user and gives the model each question with its answer', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([askCall({ questions: [question] })]),
			textResponse('done'),
		);
		const ask = vi.fn(() => ['Two functions']);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient }).run('prompt', {
			signal,
			ask,
			onProgress: event => events.push(event),
		});

		expect(ask).toHaveBeenCalledWith([question], signal);
		expect(llmClient.contexts[1]?.at(-1)).toEqual({
			role: 'tool',
			content: [
				{
					type: 'toolResult',
					callId: 'ask-1',
					name: 'askUser',
					output: 'The user answered:\n1. Which shape should the API take?\n   Two functions',
					isError: false,
				},
			],
		});
		expect(events.filter(event => event.type === 'tool')).toEqual([
			{ type: 'tool', id: 'ask-1', name: 'askUser', status: 'in_progress', summary: '1 question' },
			{ type: 'tool', id: 'ask-1', name: 'askUser', status: 'completed', summary: '1 question' },
		]);
	});

	it('gives questions the model wrote wrong back to it, without asking', async () => {
		const llmClient = new FakeLLMClient(
			assistantResponse([askCall({ questions: [] })]),
			textResponse('done'),
		);
		const ask = vi.fn(() => []);

		await new LLMAgent({ llmClient }).run('prompt', { signal, ask });

		expect(ask).not.toHaveBeenCalled();
		expect(llmClient.contexts[1]?.at(-1)?.content).toEqual([
			expect.objectContaining({ output: 'Ask 1 to 4 questions.', isError: true }),
		]);
	});

	it.each([
		[
			'throws',
			() => {
				throw new Error('terminal closed');
			},
		],
		['answers fewer questions than it was asked', () => []],
	])('ends the run when the asker %s, since it is host code', async (_, ask) => {
		const llmClient = new FakeLLMClient(assistantResponse([askCall({ questions: [question] })]));

		await expect(new LLMAgent({ llmClient }).run('prompt', { signal, ask })).rejects.toMatchObject({
			constructor: UnrecoverableError,
			message: 'The asker failed',
		});
	});

	it("refuses a consumer's tool named askUser, which a run's own would hide", () => {
		const tool: Tool = {
			name: 'askUser',
			description: 'Mine',
			inputSchema: { type: 'object' },
			risk: () => 'safe',
			execute: () => Promise.resolve(''),
		};

		expect(() => new LLMAgent({ llmClient: new FakeLLMClient(), tools: [tool] })).toThrow(
			InvalidAgentConfigError,
		);
	});

	it.each([
		['while the user is answering', true],
		['after the user answered', false],
	])('stops with the AbortError when cancelled %s', async (_, beforeAnswer) => {
		const controller = new AbortController();
		const llmClient = new FakeLLMClient(
			assistantResponse([askCall({ questions: [question] })]),
			textResponse('never sent'),
		);
		const ask = (_questions: UserQuestion[], askSignal: AbortSignal) => {
			controller.abort();
			return beforeAnswer
				? Promise.reject(askSignal.reason as Error)
				: Promise.resolve(['Two functions']);
		};

		const events: ProgressEvent[] = [];
		const run = new LLMAgent({ llmClient }).run('prompt', {
			signal: controller.signal,
			ask,
			onProgress: event => events.push(event),
		});

		await expect(run).rejects.toMatchObject({ name: 'AbortError' });
		// The question is never shown as answered, and the answer never reaches the model.
		expect(events.filter(event => event.type === 'tool').map(event => event.status)).toEqual([
			'in_progress',
		]);
		expect(llmClient.contexts).toHaveLength(1);
	});
});

describe('rememberAnswers', () => {
	it('asks only what was not answered before, and keeps every answer', async () => {
		const other: UserQuestion = { ...question, question: 'Which name?' };
		const ask = vi.fn((questions: UserQuestion[]) =>
			questions.map(({ question: q }) => `answer to ${q}`),
		);
		const remembered = rememberAnswers(ask);

		await remembered.ask([question], signal);
		await expect(remembered.ask([question, other], signal)).resolves.toEqual([
			'answer to Which shape should the API take?',
			'answer to Which name?',
		]);

		expect(ask).toHaveBeenLastCalledWith([other], signal);
		expect(remembered.answered).toEqual([
			{ question: question.question, answer: 'answer to Which shape should the API take?' },
			{ question: 'Which name?', answer: 'answer to Which name?' },
		]);
	});
});

describe('RetryingAgent with answered questions', () => {
	it('tells a retry what the user answered, and never asks the same question twice', async () => {
		const prompts: string[] = [];
		let attempt = 0;
		const inner = {
			run: vi.fn(async (prompt: string, options: RunOptions) => {
				prompts.push(prompt);
				attempt += 1;
				await options.ask?.([question], options.signal);
				if (attempt === 1)
					throw new RecoverableError('The LLM call failed', { cause: 'overloaded' });
				return { response: 'done', tokens: undefined, duration: 0 };
			}),
		};
		const ask = vi.fn(() => ['Two functions']);

		await new RetryingAgent({ inner, logger: { warn: vi.fn() }, noteFailures: false }).run(
			'prompt',
			{ signal, ask },
		);

		expect(ask).toHaveBeenCalledOnce();
		expect(prompts[0]).toBe('prompt');
		expect(prompts[1]).toBe(
			'prompt\n\nThe user already answered these questions in an earlier attempt; do not ask them again:\n1. Which shape should the API take?\n   Two functions',
		);
	});
});
