import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import { historyStart } from '../../src/recovery/domain/recoveryStore.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import type { ILogger } from '../../src/shared/domain/logger.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';
import { replaceTool, writesOver } from '../support/replaceTool.ts';

const signal = new AbortController().signal;

let parent: string;
let repo: string;
let store: FileRecoveryStore;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-history-')));
	repo = join(parent, 'repo');
	mkdirSync(repo);
	execFileSync('git', ['init', '--quiet'], { cwd: repo });
	// The test tool replaces a file, so the file a run writes exists before it.
	writeFileSync(join(repo, 'a.txt'), 'original');
	store = await FileRecoveryStore.open({ root: repo, directory: join(parent, 'state') });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

/**
 * A model that answers each run from its own script, and remembers the context of each run's
 * first call. A run that writes replaces one file, then answers.
 */
class ScriptedModel implements LLMClient {
	readonly firstContexts: Message[][] = [];
	private readonly script: ({ write: [string, string] } | { answer: string } | Error)[] = [];
	private waitingForAnswer = false;

	writes(path: string, content: string): this {
		this.script.push({ write: [path, content] });
		return this;
	}

	answers(text: string): this {
		this.script.push({ answer: text });
		return this;
	}

	fails(error: Error): this {
		this.script.push(error);
		return this;
	}

	send({ context }: { context: Message[] }): Promise<LLMResponse> {
		if (this.waitingForAnswer) {
			this.waitingForAnswer = false;
			return Promise.resolve(textResponse('done'));
		}
		this.firstContexts.push(structuredClone(context));
		const next = this.script.shift();
		if (!next) return Promise.reject(new Error('The script ran out'));
		if (next instanceof Error) return Promise.reject(next);
		if ('answer' in next) return Promise.resolve(textResponse(next.answer));
		this.waitingForAnswer = true;
		const [path, content] = next.write;
		return Promise.resolve(assistantResponse([toolCall('call', 'replace', { path, content })]));
	}
}

async function agentOver(
	model: ScriptedModel,
	options: { summarizer?: LLMClient; logger?: ILogger } = {},
): Promise<LLMAgent> {
	return new LLMAgent({
		llmClient: model,
		tools: [replaceTool(await writesOver(repo, store))],
		history: store,
		...options,
	});
}

/** The text of every message, so a test can tell which turns a context holds. */
function texts(context: Message[] | undefined): string[] {
	return (context ?? []).flatMap(message =>
		message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])),
	);
}

/** The texts of the prompt the run sent: the note, if any, then the prompt. */
function prompt(context: Message[] | undefined): string[] {
	return texts(context?.slice(-1));
}

function read(name: string): string {
	return readFileSync(join(repo, name), 'utf8');
}

describe('LLMAgent following moves through the workspace history', () => {
	it('goes back with the workspace, and tells the model what was undone and why', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').writes('a.txt', 'two').answers('ok');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await agent.run('second', { signal });

		await store.undo({ reason: 'the second change was wrong' });
		await agent.run('third', { signal });

		expect(read('a.txt')).toBe('one');
		const seen = texts(model.firstContexts[2]);
		expect(seen).toContain('first');
		expect(seen).not.toContain('second');
		const note = seen.find(text => text.startsWith('Note from the harness'));
		expect(note).toContain('«second»');
		expect(note).toContain('Files those runs had changed: a.txt');
		expect(note).toContain('«the second change was wrong»');
		expect(seen.at(-1)).toBe('third');
	});

	it('keeps a read-only turn in the context of the runs after it', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').answers('it says one').answers('ok');
		const agent = await agentOver(model);
		await agent.run('write one', { signal });
		await agent.run('what does it say?', { signal });

		await agent.run('thanks', { signal });

		expect(texts(model.firstContexts[2])).toEqual(
			expect.arrayContaining(['write one', 'what does it say?', 'thanks']),
		);
	});

	it('tells the model only once, and takes a read-only turn with the turn before it', async () => {
		const model = new ScriptedModel()
			.writes('a.txt', 'one')
			.answers('it says one')
			.answers('ok')
			.answers('ok again');
		const agent = await agentOver(model);
		await agent.run('write one', { signal });
		await agent.run('what does it say?', { signal });

		await store.goTo(historyStart);
		await agent.run('start over', { signal });
		await agent.run('and now?', { signal });

		const afterMove = texts(model.firstContexts[2]);
		expect(afterMove).not.toContain('write one');
		expect(afterMove).not.toContain('what does it say?');
		expect(afterMove[0]).toContain('before any change an agent made');
		expect(afterMove[0]).toContain('«write one»');
		expect(afterMove[0]).toContain('«what does it say?»');
		const next = texts(model.firstContexts[3]);
		expect(next.filter(text => text.startsWith('Note from the harness'))).toHaveLength(1);
		expect(next.at(-1)).toBe('and now?');
	});

	it('brings the undone turns back on redo, without a note', async () => {
		const model = new ScriptedModel()
			.writes('a.txt', 'one')
			.writes('a.txt', 'two')
			.answers('asked while back')
			.answers('ok');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await agent.run('second', { signal });
		await store.undo();
		await agent.run('a question while back', { signal });

		await store.redo();
		await agent.run('after redo', { signal });

		const seen = texts(model.firstContexts[3]);
		expect(seen).toEqual(expect.arrayContaining(['first', 'second']));
		expect(seen).not.toContain('a question while back');
		expect(seen.some(text => text.startsWith('Note from the harness'))).toBe(false);
	});

	it('names, in a later note, the prompt of an undone turn that carried a note, and only new reasons', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').writes('a.txt', 'two').answers('ok');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await store.undo({ reason: 'not like that' });
		await agent.run('second', { signal });

		await store.undo();
		await agent.run('third', { signal });

		const note = prompt(model.firstContexts[2])[0];
		expect(note).toContain('«second»');
		expect(note).not.toContain('«Note from the harness');
		expect(note).not.toContain('not like that');
	});

	it('names the files a move left as they were', async () => {
		const model = new ScriptedModel().writes('a.txt', 'agent').answers('ok');
		const agent = await agentOver(model);
		await agent.run('write', { signal });
		writeFileSync(join(repo, 'a.txt'), 'edited by hand');

		await store.undo();
		await agent.run('again', { signal });

		expect(prompt(model.firstContexts[1])[0]).toContain(
			'Files left as they were, because they had changed since: a.txt',
		);
	});

	it('gives the note again to the next run when the run that carried it failed', async () => {
		const model = new ScriptedModel()
			.writes('a.txt', 'one')
			.fails(new Error('the model is down'))
			.answers('ok');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await store.undo();

		await expect(agent.run('retry me', { signal })).rejects.toThrow();
		await agent.run('retry me', { signal });

		for (const context of model.firstContexts.slice(1)) {
			expect(prompt(context)[0]).toContain('«first»');
		}
	});

	it('uses a summary from the summarizer in place of the prompts, and counts its tokens', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').answers('ok');
		const summarizer = new FakeLLMClient(
			textResponse('Tried to rewrite a.txt; the user wanted it kept.', {
				usage: { inputTokens: 100, outputTokens: 10 },
			}),
		);
		const agent = await agentOver(model, { summarizer });
		await agent.run('rewrite a.txt', { signal });
		await store.undo({ reason: 'keep it' });

		const response = await agent.run('next', { signal });

		const note = prompt(model.firstContexts[1])[0];
		expect(note).toContain('Tried to rewrite a.txt; the user wanted it kept.');
		expect(note).not.toContain('«rewrite a.txt»');
		expect(texts(summarizer.contexts[0])[0]).toContain('rewrite a.txt');
		expect(texts(summarizer.contexts[0])[0]).toContain('«keep it»');
		expect(response.tokens?.inputTokens).toBe(101);
	});

	it('falls back to the prompts when the summary fails, and reports it', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').answers('ok');
		const logger: ILogger = { warn: vi.fn() };
		const summarizer = new FakeLLMClient(new Error('quota exceeded'));
		const agent = await agentOver(model, { summarizer, logger });
		await agent.run('rewrite a.txt', { signal });
		await store.undo();

		await agent.run('next', { signal });

		expect(prompt(model.firstContexts[1])[0]).toContain('«rewrite a.txt»');
		expect(logger.warn).toHaveBeenCalledWith(
			'The summary of the undone turns failed: quota exceeded',
		);
	});
});
