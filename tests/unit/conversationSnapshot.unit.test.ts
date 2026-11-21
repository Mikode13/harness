import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunInProgressError } from '../../src/agent/domain/oneRunAtATime.ts';
import { RunContext, withRunContext } from '../../src/agent/domain/runContext.ts';
import {
	type ConversationSnapshot,
	InvalidSnapshotError,
	UnsupportedSnapshotVersionError,
} from '../../src/agent/domain/snapshot.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { Compactor } from '../../src/engines/domain/model/compactor.ts';
import { readConversationSnapshot } from '../../src/factory/infrastructure/conversationSnapshot.ts';
import { Conversation } from '../../src/llm/domain/conversation.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import type { RunJournal } from '../../src/recovery/domain/recoveryStore.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { UnrecoverableError } from '../../src/shared/domain/errors.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import type { WorkspaceWrites } from '../../src/tools/infrastructure/workspaceWrites.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
	toolMessage,
	toolResult,
	userMessage,
} from '../support/fakeLlmClient.ts';
import { recordRun } from '../support/recordedRuns.ts';
import { replaceTool, writesOver } from '../support/replaceTool.ts';
import { trackedToolsOver } from '../support/trackedTools.ts';

const signal = new AbortController().signal;

let parent: string;
let repo: string;
let store: FileRecoveryStore;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-snapshot-')));
	repo = join(parent, 'repo');
	mkdirSync(repo);
	execFileSync('git', ['init', '--quiet'], { cwd: repo });
	writeFileSync(join(repo, 'a.txt'), 'original');
	store = await FileRecoveryStore.open({ root: repo, directory: join(parent, 'state') });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

/** What a snapshot restores once it has been stored as JSON and read back. */
function throughJson(snapshot: ConversationSnapshot) {
	return readConversationSnapshot(JSON.parse(JSON.stringify(snapshot)));
}

/**
 * A model that answers each run from its own script, and remembers the context of every call. A
 * run that writes replaces one file, then answers.
 */
class ScriptedModel implements LLMClient {
	readonly contexts: Message[][] = [];
	private readonly script: ({ write: [string, string] } | { answer: string } | { cut: string })[] =
		[];
	private waitingForAnswer = false;

	writes(path: string, content: string): this {
		this.script.push({ write: [path, content] });
		return this;
	}

	answers(text: string): this {
		this.script.push({ answer: text });
		return this;
	}

	cuts(text: string): this {
		this.script.push({ cut: text });
		return this;
	}

	send({ context }: { context: Message[] }): Promise<LLMResponse> {
		this.contexts.push(structuredClone(context));
		if (this.waitingForAnswer) {
			this.waitingForAnswer = false;
			return Promise.resolve(textResponse('done'));
		}
		const next = this.script.shift();
		if (!next) return Promise.reject(new Error('The script ran out'));
		if ('answer' in next) return Promise.resolve(textResponse(next.answer));
		if ('cut' in next) return Promise.resolve(textResponse(next.cut, { stopReason: 'truncated' }));
		this.waitingForAnswer = true;
		const [path, content] = next.write;
		return Promise.resolve(assistantResponse([toolCall('call', 'replace', { path, content })]));
	}
}

async function agentOver(
	model: LLMClient,
	options: { restore?: ConversationSnapshot; history?: FileRecoveryStore } = {},
): Promise<LLMAgent> {
	const history = options.history ?? store;
	return new LLMAgent({
		llmClient: model,
		tools: [replaceTool(await writesOver(repo, history))],
		history,
		...(options.restore ? { restore: throughJson(options.restore) } : {}),
	});
}

function texts(context: Message[] | undefined): string[] {
	return (context ?? []).flatMap(message =>
		message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])),
	);
}

describe('a snapshot of a model-API agent', () => {
	it('round-trips the turn tree and the current turn through JSON', async () => {
		const model = new ScriptedModel()
			.writes('a.txt', 'one')
			.writes('a.txt', 'two')
			.answers('ok')
			.answers('again');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await agent.run('second', { signal });
		// A branch: the third turn follows the first, and the second stays in the tree.
		await store.undo();
		await agent.run('third', { signal });
		const snapshot = agent.snapshot();

		const restored = await agentOver(new ScriptedModel(), { restore: snapshot });

		expect(restored.snapshot()).toEqual(snapshot);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(snapshot.turns.map(({ parent }) => parent)).toEqual([undefined, 0, 0]);
		expect(snapshot.currentTurn).toBe(2);
		expect(snapshot.turns[0]?.runId).toBeDefined();
		expect(snapshot.turns[1]?.runId).toBeDefined();
		expect(snapshot.turns[2]?.runId).toBeUndefined();
	});

	it('restores initial messages, and a conversation with no turn yet', () => {
		const conversation = new Conversation([userMessage('before everything')]);
		const state = conversation.state();

		expect(Conversation.fromState(state).getContext()).toEqual([userMessage('before everything')]);
		expect(state).toEqual({ initial: [userMessage('before everything')], turns: [] });
	});

	it('sends the same context, and the same opaque data, as the agent it was taken from', async () => {
		const reasoning = {
			type: 'providerData' as const,
			source: 'fake',
			data: { signature: 'sig==', nested: { z: 1, a: [2, { k: null }] } },
		};
		const script = () =>
			new FakeLLMClient(
				assistantResponse([reasoning, toolCall('c1', 'replace', { path: 'a.txt', content: 'x' })]),
				textResponse('changed'),
				textResponse('next answer'),
			);
		const uninterrupted = script();
		const original = await agentOver(uninterrupted);
		await original.run('change a.txt', { signal });
		const snapshot = original.snapshot();
		await original.run('and now?', { signal });

		writeFileSync(join(repo, 'a.txt'), 'x');
		const resumed = new FakeLLMClient(textResponse('next answer'));
		await (await agentOver(resumed, { restore: snapshot })).run('and now?', { signal });

		expect(resumed.contexts[0]).toEqual(uninterrupted.contexts[2]);
		const sent = resumed.contexts[0]?.flatMap(message => message.content);
		expect(JSON.stringify(sent?.find(part => part.type === 'providerData'))).toBe(
			JSON.stringify(reasoning),
		);
	});

	it('keeps the session its runs belonged to', async () => {
		const agent = await agentOver(new ScriptedModel().answers('ok'));
		const { session } = await agent.run('hello', { signal });

		const restored = await agentOver(new ScriptedModel().answers('ok'), {
			restore: agent.snapshot(),
		});

		await expect(restored.run('again', { signal })).resolves.toMatchObject({ session });
	});

	it('cannot be taken while a run works on the agent, and holds the run once it ends', async () => {
		let answer!: (response: LLMResponse) => void;
		const model: LLMClient = {
			send: () =>
				new Promise(resolve => {
					answer = resolve;
				}),
		};
		const agent = new LLMAgent({ llmClient: model });
		const before = agent.snapshot();
		const running = agent.run('a long question', { signal });
		await Promise.resolve();

		expect(() => agent.snapshot()).toThrow(RunInProgressError);
		expect(() => agent.snapshot()).toThrow(UnrecoverableError);

		answer(textResponse('a long answer'));
		await running;
		expect(before.turns).toEqual([]);
		expect(agent.snapshot().turns).toHaveLength(1);
	});

	it('keeps a run cut by the output limit, and one stopped on repeated calls, with every call answered', async () => {
		const repeated = () => assistantResponse([toolCall('same', 'replace', { path: 'a.txt' })]);
		const script = () =>
			new FakeLLMClient(
				textResponse('I was saying', { stopReason: 'truncated' }),
				repeated(),
				repeated(),
				repeated(),
				repeated(),
				repeated(),
				textResponse('next'),
			);
		const uninterrupted = script();
		const agent = new LLMAgent({
			llmClient: uninterrupted,
			tools: [
				{
					name: 'replace',
					description: 'Does nothing',
					inputSchema: { type: 'object', properties: {}, required: [] },
					risk: () => 'safe',
					execute: () => Promise.resolve('done'),
				},
			],
		});
		await expect(agent.run('cut', { signal })).rejects.toThrow(UnrecoverableError);
		await expect(agent.run('loop', { signal })).rejects.toThrow('repeated the same tool calls');
		const snapshot = agent.snapshot();
		await agent.run('next', { signal });

		const resumed = new FakeLLMClient(textResponse('next'));
		await new LLMAgent({ llmClient: resumed, restore: throughJson(snapshot) }).run('next', {
			signal,
		});

		expect(snapshot.turns).toHaveLength(2);
		expect(resumed.contexts[0]).toEqual(uninterrupted.contexts.at(-1));
		expect(texts(resumed.contexts[0])).toContain('I was saying');
		const parts = resumed.contexts[0]?.flatMap(message => message.content) ?? [];
		const calls = parts.filter(part => part.type === 'toolCall');
		const results = parts.filter(part => part.type === 'toolResult');
		expect(calls).toHaveLength(5);
		expect(results).toHaveLength(5);
	});

	it('restores the size of the context for the same provider, so it compacts when the original would', async () => {
		const compactor: Compactor = { by: 'harness', at: 10, keptSteps: 10 };
		const big = textResponse('a big answer', { usage: { inputTokens: 50 } });
		const uninterrupted = new FakeLLMClient(big, textResponse('summary'), textResponse('next'));
		const agent = new LLMAgent({ llmClient: uninterrupted, compactor });
		await agent.run('first', { signal });
		const snapshot = agent.snapshot();
		await agent.run('next', { signal });

		const resumed = new FakeLLMClient(textResponse('summary'), textResponse('next'));
		await new LLMAgent({ llmClient: resumed, compactor, restore: throughJson(snapshot) }).run(
			'next',
			{ signal },
		);

		expect(snapshot.context).toEqual({ tokens: 50 });
		expect(resumed.contexts).toEqual(uninterrupted.contexts.slice(1));
	});

	it('measures the context anew for another provider', async () => {
		const compactor: Compactor = { by: 'harness', at: 10, keptSteps: 10 };
		const restore = throughJson({
			...new LLMAgent({ llmClient: new FakeLLMClient() }).snapshot(),
			context: { tokens: 50, source: 'another' },
		});
		const resumed = new FakeLLMClient(textResponse('next'));

		await new LLMAgent({ llmClient: resumed, compactor, restore }).run('next', { signal });

		expect(resumed.contexts).toHaveLength(1);
	});
});

describe('a restored agent and the files', () => {
	it('reads a file again before it changes it', async () => {
		const calls: [string, Record<string, unknown>][] = [
			['readFile', { path: 'a.txt', fromLine: null, lineCount: null }],
			['edit', { op: 'modify', path: 'a.txt', text: 'original', replacement: 'one' }],
		];
		const outputs: string[] = [];
		const model = (script: ([string, Record<string, unknown>] | 'answer')[]): LLMClient => ({
			send: ({ context }) => {
				for (const part of context.at(-1)?.content ?? []) {
					if (part.type === 'toolResult') outputs.push(part.output);
				}
				const next = script.shift();
				if (next === undefined || next === 'answer') return Promise.resolve(textResponse('done'));
				const [name, input] = next;
				return Promise.resolve(assistantResponse([toolCall(`call-${name}`, name, input)]));
			},
		});
		const { readFile, edit } = await trackedToolsOver(repo, store);
		const agent = new LLMAgent({
			llmClient: model([calls[0] ?? 'answer', 'answer']),
			tools: [readFile, edit],
		});
		await agent.run('read it', { signal });

		const restored = new LLMAgent({
			llmClient: model([calls[1] ?? 'answer', 'answer']),
			tools: [readFile, edit],
			restore: throughJson(agent.snapshot()),
		});
		await restored.run('now change it', { signal });

		expect(outputs.at(-1)).toBe('READ_REQUIRED: read "a.txt" before changing it');
		expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('original');
	});
});

describe('a restored agent following the history', () => {
	it('follows an undo made after the snapshot, and tells the model what was undone', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').writes('a.txt', 'two');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await agent.run('second', { signal });
		const snapshot = agent.snapshot();

		await store.undo({ reason: 'not that' });
		const resumed = new ScriptedModel().answers('ok');
		await (await agentOver(resumed, { restore: snapshot })).run('third', { signal });

		const seen = texts(resumed.contexts[0]);
		expect(seen).toContain('first');
		expect(seen).not.toContain('second');
		const note = seen.find(text => text.startsWith('Note from the harness'));
		expect(note).toContain('«second»');
		expect(note).toContain('Files those runs had changed: a.txt');
		expect(note).toContain('«not that»');
	});

	it('follows an undo and a redo made after the snapshot, keeping every turn', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').writes('a.txt', 'two');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await agent.run('second', { signal });
		const snapshot = agent.snapshot();

		await store.undo();
		await store.redo();
		const resumed = new ScriptedModel().answers('ok');
		await (await agentOver(resumed, { restore: snapshot })).run('third', { signal });

		const seen = texts(resumed.contexts[0]);
		expect(seen).toEqual(expect.arrayContaining(['first', 'second', 'third']));
		expect(seen.some(text => text.startsWith('Note from the harness'))).toBe(false);
	});

	it('does not tell the model again about an undo the agent had followed', async () => {
		const model = new ScriptedModel().writes('a.txt', 'one').writes('a.txt', 'two').answers('ok');
		const agent = await agentOver(model);
		await agent.run('first', { signal });
		await agent.run('second', { signal });
		await store.undo();
		await agent.run('third', { signal });
		const snapshot = agent.snapshot();

		const resumed = new ScriptedModel().answers('ok');
		await (await agentOver(resumed, { restore: snapshot })).run('fourth', { signal });

		const seen = texts(resumed.contexts[0]);
		expect(seen).toEqual(expect.arrayContaining(['first', 'third', 'fourth']));
		expect(seen).not.toContain('second');
		// The third prompt carried the note, and the fourth does not carry it again.
		expect(texts(resumed.contexts[0]?.slice(-1))).toEqual(['fourth']);
	});

	describe('with a history that keeps 3 runs', () => {
		let small: FileRecoveryStore;

		beforeEach(async () => {
			small = await FileRecoveryStore.open({
				root: repo,
				directory: join(parent, 'small'),
				keepRuns: 3,
			});
		});

		it('keeps a turn whose run retention chained into a later one, as that run', async () => {
			const agent = await agentOver(new ScriptedModel().writes('a.txt', 'one'), {
				history: small,
			});
			await agent.run('first', { signal });
			const snapshot = agent.snapshot();
			for (const content of ['b', 'c', 'd']) await recordRun(small, repo, [['b.txt', content]]);
			const [first] = snapshot.turns;
			expect((await small.listRuns()).runs.some(run => run.runId === first?.runId)).toBe(false);

			const resumed = new ScriptedModel().answers('ok');
			await (
				await agentOver(resumed, { restore: snapshot, history: small })
			).run('next', {
				signal,
			});

			const seen = texts(resumed.contexts[0]);
			expect(seen).toContain('first');
			expect(seen.some(text => text.startsWith('Note from the harness'))).toBe(false);
		});

		it('takes a turn whose abandoned run retention removed as undone, naming no files', async () => {
			const agent = await agentOver(
				new ScriptedModel().writes('a.txt', 'one').writes('a.txt', 'two'),
				{ history: small },
			);
			await agent.run('first', { signal });
			await agent.run('second', { signal });
			const snapshot = agent.snapshot();
			// The second run is left on a branch of its own, which retention removes whole.
			await small.undo();
			for (const content of ['b', 'c']) await recordRun(small, repo, [['b.txt', content]]);
			const second = snapshot.turns[1]?.runId ?? '';
			await expect(small.readRun(second)).rejects.toThrow('is no longer kept');

			const resumed = new ScriptedModel().answers('ok');
			await (
				await agentOver(resumed, { restore: snapshot, history: small })
			).run('next', {
				signal,
			});

			const seen = texts(resumed.contexts[0]);
			expect(seen).toContain('first');
			expect(seen).not.toContain('second');
			const note = seen.find(text => text.startsWith('Note from the harness'));
			expect(note).toContain('«second»');
			expect(note).not.toContain('Files those runs had changed');
		});
	});

	describe('when a turn names a run whose process died before it changed anything', () => {
		const left: RunJournal[] = [];

		afterEach(async () => {
			for (const journal of left.splice(0)) await journal.finish('failed').catch(() => undefined);
		});

		/**
		 * A run that records a change as prepared and dies before the change reaches the file, as a
		 * process killed between the two would leave it: a turn names the run, which changed
		 * nothing.
		 */
		function preparesOnly(writes: WorkspaceWrites): PreparingTool {
			return {
				name: 'replace',
				description: 'Replaces a file',
				inputSchema: { type: 'object', properties: {}, required: [] },
				prepare: (_input, _signal, call) =>
					Promise.resolve({
						risk: 'mutating',
						run: async () => {
							const journal = await writes.sessionFor(call.run).journalForChange();
							left.push(journal);
							const path = join(repo, 'a.txt');
							await journal.prepare({
								path,
								before: {
									exists: true,
									hash: await journal.saveContent(readFileSync(path)),
									mode: statSync(path).mode & 0o7777,
								},
								after: {
									exists: true,
									hash: await journal.saveContent(Buffer.from('one')),
									mode: 0o644,
								},
							});
							return 'Changed a.txt';
						},
					}),
			};
		}

		/** Leaves the run of `journal` as a dead process would: its lock naming a dead pid. */
		function kill(journal: RunJournal): void {
			const workspaces = join(parent, 'state', 'workspaces');
			const pid = Number(
				execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']),
			);
			writeFileSync(
				join(workspaces, readdirSync(workspaces)[0] ?? '', 'lock'),
				JSON.stringify({ runId: journal.runId, pid }),
			);
		}

		/**
		 * @param settled whether the change is recorded as abandoned before the process dies, as
		 * settling the run records it, which hides the run before a later run removes it.
		 */
		async function snapshotOfDeadRun({ settled = false } = {}): Promise<{
			snapshot: ConversationSnapshot;
			runId: string;
		}> {
			const model = new ScriptedModel().writes('a.txt', 'one');
			const agent = new LLMAgent({
				llmClient: model,
				tools: [preparesOnly(await writesOver(repo, store))],
				history: store,
			});
			// Inside an outer run, as a role's is, so the run is still recording when the turn ends.
			const outer = new RunContext({ id: 'outer' });
			await agent.run('first', withRunContext({ signal }, outer));
			const snapshot = agent.snapshot();
			const [journal] = left;
			if (!journal) throw new Error('The run never started');
			if (settled) await journal.abandoned(1);
			kill(journal);
			return { snapshot, runId: journal.runId };
		}

		it('keeps the turn while the dead run is listed as interrupted', async () => {
			const { snapshot } = await snapshotOfDeadRun();
			const reopened = await FileRecoveryStore.open({
				root: repo,
				directory: join(parent, 'state'),
			});
			expect((await reopened.listRuns()).runs).toMatchObject([{ status: 'interrupted' }]);

			const resumed = new ScriptedModel().answers('ok');
			await (
				await agentOver(resumed, { restore: snapshot, history: reopened })
			).run('next', {
				signal,
			});

			const seen = texts(resumed.contexts[0]);
			expect(seen).toContain('first');
			expect(seen.some(text => text.startsWith('Note from the harness'))).toBe(false);
		});

		it('keeps the turn for the next call while the dead run is hidden, and tells of no undo', async () => {
			const { snapshot, runId } = await snapshotOfDeadRun({ settled: true });
			const reopened = await FileRecoveryStore.open({
				root: repo,
				directory: join(parent, 'state'),
			});
			expect(snapshot.turns[0]?.runId).toBe(runId);
			expect((await reopened.listRuns()).runs).toEqual([]);

			const resumed = new ScriptedModel().answers('ok');
			await (
				await agentOver(resumed, { restore: snapshot, history: reopened })
			).run('next', {
				signal,
			});

			const seen = texts(resumed.contexts[0]);
			expect(seen).toContain('first');
			expect(seen.some(text => text.startsWith('Note from the harness'))).toBe(false);
		});

		it('keeps the turn once a later run removed the dead run, and writes after it', async () => {
			const { snapshot, runId } = await snapshotOfDeadRun();
			const reopened = await FileRecoveryStore.open({
				root: repo,
				directory: join(parent, 'state'),
			});
			// The next run settles the dead one, which changed nothing, and removes it.
			await recordRun(reopened, repo, [['b.txt', 'b']]);
			await expect(reopened.readRun(runId)).rejects.toThrow('is not in the history');

			const resumed = new ScriptedModel().writes('a.txt', 'two').answers('ok');
			const agent = await agentOver(resumed, { restore: snapshot, history: reopened });
			await agent.run('write', { signal });
			await agent.run('next', { signal });

			expect(texts(resumed.contexts[0])).toContain('first');
			const seen = texts(resumed.contexts.at(-1));
			expect(seen).toEqual(expect.arrayContaining(['first', 'write', 'next']));
			expect(seen.some(text => text.startsWith('Note from the harness'))).toBe(false);
		});

		it('still tells of an undo of the run before it, without failing on the dead one', async () => {
			const { snapshot } = await snapshotOfDeadRun();
			const reopened = await FileRecoveryStore.open({
				root: repo,
				directory: join(parent, 'state'),
			});
			const resumed = new ScriptedModel().writes('a.txt', 'two').answers('ok');
			const agent = await agentOver(resumed, { restore: snapshot, history: reopened });
			await agent.run('write', { signal });
			await reopened.undo();
			await agent.run('next', { signal });

			const seen = texts(resumed.contexts.at(-1));
			expect(seen).toContain('first');
			expect(seen).not.toContain('write');
			expect(seen.find(text => text.startsWith('Note from the harness'))).toContain('«write»');
		});
	});
});

describe('reading a conversation snapshot', () => {
	async function valid(): Promise<ConversationSnapshot> {
		const agent = new LLMAgent({
			llmClient: new FakeLLMClient(
				assistantResponse([toolCall('c1', 'look', {})]),
				textResponse('seen'),
			),
			tools: [
				{
					name: 'look',
					description: 'Looks',
					inputSchema: { type: 'object', properties: {}, required: [] },
					risk: () => 'safe',
					execute: () => Promise.resolve('nothing'),
				},
			],
		});
		await agent.run('look', { signal });
		return JSON.parse(JSON.stringify(agent.snapshot())) as ConversationSnapshot;
	}

	it('reads one it took', async () => {
		const snapshot = await valid();

		expect(readConversationSnapshot(snapshot).conversation.turns[0]?.messages).toEqual([
			userMessage('look'),
			{ role: 'assistant', content: [toolCall('c1', 'look', {})] },
			toolMessage(toolResult('c1', 'look', 'nothing')),
			{ role: 'assistant', content: [{ type: 'text', text: 'seen' }] },
		]);
	});

	it('refuses a version it does not restore, with the version', async () => {
		const snapshot = { ...(await valid()), version: 2 };

		const read = () => readConversationSnapshot(snapshot);

		expect(read).toThrow(UnsupportedSnapshotVersionError);
		expect(read).toThrow(InvalidSnapshotError);
		expect(read).toThrow(UnrecoverableError);
		try {
			read();
		} catch (error) {
			expect((error as UnsupportedSnapshotVersionError).version).toBe(2);
		}
	});

	const broken: [string, (snapshot: ConversationSnapshot) => unknown][] = [
		['is not an object', () => 'snapshot'],
		['is an array', () => []],
		['is of another format', snapshot => ({ ...snapshot, format: 'something-else' })],
		['has no format', snapshot => ({ ...snapshot, format: undefined })],
		['has a key the format lacks', snapshot => ({ ...snapshot, extra: true })],
		['has a session without an id', snapshot => ({ ...snapshot, session: { id: ' ' } })],
		[
			'has a part of an unknown type',
			snapshot => ({
				...snapshot,
				turns: [{ messages: [{ role: 'user', content: [{ type: 'image', url: 'x' }] }] }],
			}),
		],
		[
			'has a turn that follows a later one',
			snapshot => ({
				...snapshot,
				turns: [{ parent: 1, messages: snapshot.turns[0]?.messages }, ...snapshot.turns],
			}),
		],
		['names a current turn it does not have', snapshot => ({ ...snapshot, currentTurn: 7 })],
		[
			'has a tool call without its result',
			snapshot => ({
				...snapshot,
				turns: [{ messages: snapshot.turns[0]?.messages.filter((_, at) => at !== 2) }],
			}),
		],
		[
			'has a turn that does not start with a prompt',
			snapshot => ({
				...snapshot,
				turns: [{ messages: snapshot.turns[0]?.messages.slice(1) }],
			}),
		],
		['has a negative revision', snapshot => ({ ...snapshot, seenRevision: -1 })],
	];

	it.each(broken)('refuses one that %s, classified', async (_, breakIt) => {
		const snapshot = breakIt(await valid());

		expect(() => readConversationSnapshot(snapshot)).toThrow(InvalidSnapshotError);
		expect(() => readConversationSnapshot(snapshot)).not.toThrow(UnsupportedSnapshotVersionError);
	});
});
