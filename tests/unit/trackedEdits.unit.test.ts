import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { LLMClient, LLMResponse } from '../../src/llm/domain/llm.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import type { RecoveryStore, RunJournal } from '../../src/recovery/domain/recoveryStore.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import type { Formatter } from '../../src/tools/domain/commands.ts';
import type { runCommandProcess } from '../../src/tools/infrastructure/commandProcess.ts';
import { assistantResponse, textResponse, toolCall } from '../support/fakeLlmClient.ts';
import { trackedToolsOver } from '../support/trackedTools.ts';

const signal = new AbortController().signal;

let parent: string;
let root: string;
let store: FileRecoveryStore;

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-tracked-')));
	root = join(parent, 'repo');
	mkdirSync(root);
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	store = await FileRecoveryStore.open({ root, directory: join(parent, 'state') });
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

type Call = [name: string, input: Record<string, unknown>];

/**
 * A model that makes the calls it is given, one response each, and answers once they ran. It
 * keeps the output of every tool call it was sent.
 */
class CallingModel implements LLMClient {
	readonly outputs: { output: string; isError: boolean }[] = [];
	private readonly script: (Call | 'answer' | Error)[] = [];
	private calls = 0;

	then(...calls: Call[]): this {
		this.script.push(...calls, 'answer');
		return this;
	}

	/** Makes these calls, and does not answer after them. */
	makes(...calls: Call[]): this {
		this.script.push(...calls);
		return this;
	}

	fails(): this {
		this.script.push(new Error('the model is down'));
		return this;
	}

	send({ context }: { context: Message[] }): Promise<LLMResponse> {
		for (const part of context.at(-1)?.content ?? []) {
			if (part.type === 'toolResult') {
				this.outputs.push({ output: part.output, isError: part.isError });
			}
		}
		const next = this.script.shift();
		if (next === undefined) return Promise.reject(new Error('The script ran out'));
		if (next instanceof Error) return Promise.reject(next);
		if (next === 'answer') return Promise.resolve(textResponse('done'));
		this.calls++;
		const [name, input] = next;
		return Promise.resolve(
			assistantResponse([toolCall(`call-${String(this.calls)}`, name, input)]),
		);
	}

	/** The output of the last tool call that ran. */
	get last(): { output: string; isError: boolean } | undefined {
		return this.outputs.at(-1);
	}
}

const read = (path: string, fromLine: number | null = null, lineCount: number | null = null) =>
	['readFile', { path, fromLine, lineCount }] as Call;
const modify = (path: string, text: string, replacement: string) =>
	['edit', { op: 'modify', path, text, replacement }] as Call;
const create = (path: string, text: string) =>
	['edit', { op: 'create', path, text, replacement: null }] as Call;
const remove = (path: string) =>
	['edit', { op: 'delete', path, text: null, replacement: null }] as Call;

async function agentOver(
	model: CallingModel,
	{
		formatter,
		runProcess,
		over = store,
		...options
	}: {
		history?: FileRecoveryStore;
		formatter?: Formatter;
		runProcess?: typeof runCommandProcess;
		/** The store its writes are recorded in. */
		over?: RecoveryStore;
	} = {},
) {
	const { readFile, edit } = await trackedToolsOver(root, over, {
		...(formatter ? { formatter } : {}),
		...(runProcess ? { runProcess } : {}),
	});
	return new LLMAgent({ llmClient: model, tools: [readFile, edit], ...options });
}

function onDisk(name: string): string {
	return readFileSync(join(root, name), 'utf8');
}

describe('editing only from a version the model read', () => {
	beforeEach(() => {
		writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
	});

	it('lets an edit follow readFiles, which reports a file the policy refuses in its place', async () => {
		writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
		const model = new CallingModel().then(
			[
				'readFiles',
				{
					files: [
						{ path: '.env', fromLine: null, lineCount: null },
						{ path: 'a.txt', fromLine: 2, lineCount: 1 },
					],
				},
			],
			modify('a.txt', 'two', 'TWO'),
		);
		const { readFiles, edit } = await trackedToolsOver(root, store);

		await new LLMAgent({ llmClient: model, tools: [readFiles, edit] }).run('change it', {
			signal,
		});

		const [reading, editing] = model.outputs;
		expect(reading?.isError).toBe(false);
		expect(reading?.output).toMatch(/^== \.env\nCould not read it: /);
		expect(reading?.output).not.toContain('TOKEN');
		expect(reading?.output).toContain('== a.txt:2-2\n2: two');
		expect(editing?.isError).toBe(false);
		expect(onDisk('a.txt')).toBe('one\nTWO\nthree\n');
	});

	it('refuses to change a file the conversation never read', async () => {
		const model = new CallingModel().then(modify('a.txt', 'two', 'TWO'));

		await (await agentOver(model)).run('change it', { signal });

		expect(model.last).toEqual({
			output: 'READ_REQUIRED: read "a.txt" before changing it',
			isError: true,
		});
		expect(onDisk('a.txt')).toBe('one\ntwo\nthree\n');
	});

	it('changes a file it read, and shows the lines around the change', async () => {
		const model = new CallingModel().then(read('a.txt'), modify('a.txt', 'two', 'TWO'));

		await (await agentOver(model)).run('change it', { signal });

		expect(model.last).toEqual({
			output: [
				'Changed a.txt. It now reads, around the change:',
				'1: one',
				'2: TWO',
				'3: three',
			].join('\n'),
			isError: false,
		});
		expect(onDisk('a.txt')).toBe('one\nTWO\nthree\n');
	});

	it('refuses a file that changed since it was read', async () => {
		const model = new CallingModel().then(read('a.txt'));
		const agent = await agentOver(model);
		await agent.run('read it', { signal });
		writeFileSync(join(root, 'a.txt'), 'edited by hand\n');

		model.then(modify('a.txt', 'edited', 'EDITED'));
		await agent.run('change it', { signal });

		expect(model.last).toEqual({
			output: 'STALE_FILE: "a.txt" changed since you read it; read it again',
			isError: true,
		});
		expect(onDisk('a.txt')).toBe('edited by hand\n');
	});

	it('knows the file as its own edit left it, across runs', async () => {
		const model = new CallingModel().then(read('a.txt'), modify('a.txt', 'one', 'ONE'));
		const agent = await agentOver(model);
		await agent.run('first', { signal });

		model.then(modify('a.txt', 'three', 'THREE'));
		await agent.run('second', { signal });

		expect(model.last?.isError).toBe(false);
		expect(onDisk('a.txt')).toBe('ONE\ntwo\nTHREE\n');
	});

	it('counts a partial read', async () => {
		const model = new CallingModel().then(read('a.txt', 3, 1), modify('a.txt', 'one', '1'));

		await (await agentOver(model)).run('change it', { signal });

		expect(model.outputs[0]?.output).toBe('3: three');
		expect(onDisk('a.txt')).toBe('1\ntwo\nthree\n');
	});

	it('forgets what a failed run read, since its conversation does not keep it', async () => {
		const model = new CallingModel().makes(read('a.txt')).fails();
		const agent = await agentOver(model);
		await expect(agent.run('read it', { signal })).rejects.toThrow();

		model.then(modify('a.txt', 'two', 'TWO'));
		await agent.run('change it', { signal });

		expect(model.last?.output).toMatch(/^READ_REQUIRED/);
	});

	it('forgets every read once the workspace moved through its history', async () => {
		const model = new CallingModel().then(read('a.txt'), modify('a.txt', 'two', 'TWO'));
		const agent = await agentOver(model, { history: store });
		await agent.run('change it', { signal });
		await store.undo();

		model.then(modify('a.txt', 'one', 'ONE'));
		await agent.run('change it again', { signal });

		expect(model.last?.output).toMatch(/^READ_REQUIRED/);
		expect(onDisk('a.txt')).toBe('one\ntwo\nthree\n');
	});

	it('keeps each conversation to its own reads', async () => {
		const reader = new CallingModel().then(read('a.txt'));
		await (await agentOver(reader)).run('read it', { signal });
		const writer = new CallingModel().then(modify('a.txt', 'two', 'TWO'));

		await (await agentOver(writer)).run('change it', { signal });

		expect(writer.last?.output).toMatch(/^READ_REQUIRED/);
	});

	it('creates only a file that does not exist, and knows it afterwards', async () => {
		const model = new CallingModel().then(
			create('a.txt', 'clobbered'),
			create('b.txt', 'new\nfile\n'),
			modify('b.txt', 'new', 'NEW'),
		);

		await (await agentOver(model)).run('make files', { signal });

		expect(model.outputs.map(({ output }) => output)).toEqual([
			'"a.txt" already exists; read it and change it instead',
			'Created b.txt (2 lines, 9 bytes).',
			expect.stringMatching(/^Changed b\.txt\./),
		]);
		expect(onDisk('a.txt')).toBe('one\ntwo\nthree\n');
		expect(onDisk('b.txt')).toBe('NEW\nfile\n');
	});

	it('deletes only a file it read, then knows it is gone', async () => {
		const model = new CallingModel().then(
			remove('a.txt'),
			read('a.txt'),
			remove('a.txt'),
			create('a.txt', 'again'),
		);

		await (await agentOver(model)).run('delete it', { signal });

		expect(model.outputs.map(({ output }) => output)).toEqual([
			'READ_REQUIRED: read "a.txt" before changing it',
			expect.stringMatching(/^1: one/),
			'Deleted a.txt.',
			'Created a.txt (1 line, 5 bytes).',
		]);
	});

	it('asks for a new read of a file it deleted and someone made again', async () => {
		const model = new CallingModel().then(read('a.txt'), remove('a.txt'));
		const agent = await agentOver(model);
		await agent.run('delete it', { signal });
		writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');

		model.then(modify('a.txt', 'two', 'TWO'));
		await agent.run('change it', { signal });

		expect(model.last?.output).toMatch(/^READ_REQUIRED/);
	});

	it('says, without the host path, what is wrong with a call', async () => {
		const model = new CallingModel().then(
			read('a.txt'),
			modify('a.txt', 'o', 'O'),
			modify('missing.txt', 'x', 'y'),
			read('../outside.txt'),
		);

		await (await agentOver(model)).run('try things', { signal });

		const errors = model.outputs.slice(1).map(({ output }) => output);
		expect(errors[0]).toBe('The text appears 2 times in "a.txt"; it must appear once');
		for (const error of errors) expect(error).not.toContain(parent);
	});

	it('narrates a change it made with its diff, and a refused one without', async () => {
		const model = new CallingModel().then(
			modify('a.txt', 'two', 'TWO'),
			read('a.txt'),
			modify('a.txt', 'two', 'TWO'),
		);
		const events: ProgressEvent[] = [];

		await (
			await agentOver(model)
		).run('change it', { signal, onProgress: event => events.push(event) });

		const ends = events.filter(event => event.type === 'tool' && event.status !== 'in_progress');
		expect(ends).toEqual([
			{
				type: 'tool',
				id: 'call-1',
				name: 'edit',
				status: 'error',
				error: expect.stringContaining('READ_REQUIRED') as string,
			},
			{
				type: 'tool',
				id: 'call-2',
				name: 'readFile',
				status: 'completed',
				summary: 'a.txt:1-200',
			},
			{
				type: 'tool',
				id: 'call-3',
				name: 'edit',
				status: 'completed',
				diff: [
					'--- a/a.txt',
					'+++ b/a.txt',
					'@@ -1,3 +1,3 @@',
					' one',
					'-two',
					'+TWO',
					' three',
				].join('\n'),
			},
		]);
	});

	it('names how much of a large change it did not show', async () => {
		const long = Array.from({ length: 100 }, (_, index) => `line ${String(index)}`).join('\n');
		writeFileSync(join(root, 'a.txt'), `${long}\n`);
		const model = new CallingModel().then(
			read('a.txt'),
			modify('a.txt', long, long.replaceAll('line', 'LINE')),
		);

		await (await agentOver(model)).run('shout', { signal });

		const lines = model.last?.output.split('\n') ?? [];
		expect(lines).toHaveLength(62);
		expect(lines.at(-1)).toBe(
			'[40 more lines of the change are not shown. Read the file to see them.]',
		);
	});
});

describe('formatting what an edit wrote', () => {
	/** A formatter that runs `script` in `sh`, the file's path its `$1`. */
	const formatter = (script: string): Formatter => ({
		executable: 'sh',
		args: ['-c', script, 'sh'],
	});
	// Removes the space before every semicolon, as a formatter would.
	const tidy = formatter('sed -i.bak "s/ ;/;/g" "$1" && rm "$1.bak"');

	beforeEach(() => {
		writeFileSync(join(root, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
	});

	it('shows the change as the formatter left it, and edits on from that version', async () => {
		const model = new CallingModel().then(
			read('a.ts'),
			modify('a.ts', 'a = 1;', 'a = 10 ;'),
			// No read in between: the conversation knows the formatted file.
			modify('a.ts', 'b = 2;', 'b = 20;'),
		);

		await (await agentOver(model, { formatter: tidy })).run('change it', { signal });

		expect(model.outputs[1]).toEqual({
			output: [
				'Changed a.ts. It now reads, around the change:',
				'1: const a = 10;',
				'2: const b = 2;',
			].join('\n'),
			isError: false,
		});
		expect(model.last?.isError).toBe(false);
		expect(onDisk('a.ts')).toBe('const a = 10;\nconst b = 20;\n');
	});

	it('formats a file it creates', async () => {
		const model = new CallingModel().then(create('b.ts', 'export const b = 2 ;\n'));

		await (await agentOver(model, { formatter: tidy })).run('create it', { signal });

		expect(model.last?.isError).toBe(false);
		expect(onDisk('b.ts')).toBe('export const b = 2;\n');
	});

	it('records what the formatter changed, so undoing the run undoes both', async () => {
		const model = new CallingModel().then(read('a.ts'), modify('a.ts', 'a = 1;', 'a = 10 ;'));

		await (
			await agentOver(model, { formatter: tidy, history: store })
		).run('change it', {
			signal,
		});
		await store.undo();

		expect(onDisk('a.ts')).toBe('const a = 1;\nconst b = 2;\n');
	});

	it('keeps the file as written, and says why, when the formatter fails', async () => {
		const model = new CallingModel().then(
			read('a.ts'),
			modify('a.ts', 'a = 1;', 'a = 10 ;'),
			modify('a.ts', 'b = 2;', 'b = 20;'),
		);
		const failing = formatter('echo "a.ts: unexpected token" && exit 2');

		await (await agentOver(model, { formatter: failing })).run('change it', { signal });

		expect(model.outputs[1]).toEqual({
			output: [
				'Changed a.ts. It now reads, around the change:',
				'1: const a = 10 ;',
				'2: const b = 2;',
				'The formatter exited with code 2, so the file may not be formatted.',
				'Its output:',
				'a.ts: unexpected token',
				'',
			].join('\n'),
			isError: false,
		});
		// It still knows the file as it is.
		expect(model.last?.isError).toBe(false);
		expect(onDisk('a.ts')).toBe('const a = 10 ;\nconst b = 20;\n');
	});

	it('stops a formatter that runs past its limit, and keeps the file as written', async () => {
		const model = new CallingModel().then(read('a.ts'), modify('a.ts', 'a = 1;', 'a = 10 ;'));
		const slow = { ...formatter('sleep 5'), timeoutMs: 200 };

		await (await agentOver(model, { formatter: slow })).run('change it', { signal });

		expect(model.last?.isError).toBe(false);
		expect(model.last?.output).toContain(
			'The formatter ran past its limit of 0.2 s and was stopped, so the file may not be formatted.',
		);
		expect(onDisk('a.ts')).toBe('const a = 10 ;\nconst b = 2;\n');
	});

	describe('when what the formatter did cannot be known', () => {
		const exited = {
			outcome: 'exited' as const,
			exitCode: 0,
			signal: null,
			output: '',
			printedBytes: 0,
			durationMs: 1,
		};
		const twoEdits = () =>
			new CallingModel().then(
				read('a.ts'),
				modify('a.ts', 'a = 1;', 'a = 10;'),
				create('b.ts', 'export const b = 2;\n'),
			);

		it('fails the edit and stops writing when the formatter cannot be stopped', async () => {
			const model = twoEdits();
			const runProcess = () => Promise.resolve({ ...exited, stopped: false });

			await (await agentOver(model, { formatter: tidy, runProcess })).run('change it', { signal });

			expect(model.outputs[1]?.isError).toBe(true);
			expect(model.outputs[1]?.output).toContain('The formatter could not be stopped');
			expect(model.last).toEqual({
				output: 'Writing stopped: the formatter could not be stopped',
				isError: true,
			});
			expect(existsSync(join(root, 'b.ts'))).toBe(false);
		});

		it('fails the edit and stops writing when its changes cannot be recorded', async () => {
			const model = twoEdits();
			const runProcess = () => Promise.resolve({ ...exited, stopped: true });
			// The journal cannot close the formatter's observation.
			const over = withJournal(store, journal =>
				Object.assign(Object.create(journal) as RunJournal, {
					observed: () => Promise.reject(new Error('the disk is full')),
				}),
			);

			await (
				await agentOver(model, { formatter: tidy, runProcess, over })
			).run('change it', {
				signal,
			});

			expect(model.outputs[1]?.isError).toBe(true);
			expect(model.outputs[1]?.output).toContain(
				'The formatter ran, but the harness could not record what it changed',
			);
			expect(model.last).toEqual({
				output: 'Writing stopped: the harness could not record what the formatter changed',
				isError: true,
			});
			expect(existsSync(join(root, 'b.ts'))).toBe(false);
		});
	});

	it('says so when the formatter cannot be started', async () => {
		const model = new CallingModel().then(read('a.ts'), modify('a.ts', 'a = 1;', 'a = 10;'));
		const missing = { executable: join(parent, 'no-such-formatter') };

		await (await agentOver(model, { formatter: missing })).run('change it', { signal });

		expect(model.last?.isError).toBe(false);
		expect(model.last?.output).toContain(
			'The formatter could not be started, so the file is as you wrote it:',
		);
		expect(onDisk('a.ts')).toBe('const a = 10;\nconst b = 2;\n');
	});

	it('gives the path relative to where it runs, never as a flag', async () => {
		const model = new CallingModel().then(create('-x.ts', 'x\n'));
		const recording = formatter('printf %s "$1" > ../argument');

		await (await agentOver(model, { formatter: recording })).run('create it', { signal });

		expect(readFileSync(join(parent, 'argument'), 'utf8')).toBe('./-x.ts');
	});

	it('does not run on a file it deletes', async () => {
		const model = new CallingModel().then(read('a.ts'), remove('a.ts'));
		const recording = formatter('printf %s "$1" > ../argument');

		await (await agentOver(model, { formatter: recording })).run('delete it', { signal });

		expect(model.last?.isError).toBe(false);
		expect(existsSync(join(parent, 'argument'))).toBe(false);
	});

	it('refuses an invalid formatter, or one outside every write root, before any run', async () => {
		await expect(
			agentOver(new CallingModel(), {
				formatter: { executable: 'sh', args: [1] } as unknown as Formatter,
			}),
		).rejects.toThrow(
			new InvalidAgentConfigError(
				'The formatter needs args to be a list of text without NUL characters',
			),
		);
		await expect(
			agentOver(new CallingModel(), {
				formatter: { executable: 'sh', shell: true } as unknown as Formatter,
			}),
		).rejects.toThrow(new InvalidAgentConfigError('The formatter has unknown settings: shell'));
		await expect(
			agentOver(new CallingModel(), { formatter: { executable: 'sh', cwd: parent } }),
		).rejects.toThrow(
			new InvalidAgentConfigError('The formatter needs a cwd inside a write root of the workspace'),
		);
	});
});

/** `store`, with every run's journal replaced by what `change` makes of it. */
function withJournal(
	store: RecoveryStore,
	change: (journal: RunJournal) => RunJournal,
): RecoveryStore {
	return Object.assign(Object.create(store) as RecoveryStore, {
		startRun: async () => change(await store.startRun()),
	});
}
