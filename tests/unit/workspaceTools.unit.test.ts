import { describe, expect, it } from 'vitest';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import type { Tool } from '../../src/tools/domain/tool.ts';
import { createWorkspaceTools } from '../../src/tools/infrastructure/workspaceTools.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
	toolMessage,
	toolResult,
} from '../support/fakeLlmClient.ts';
import { FakeWorkspace } from '../support/fakeWorkspace.ts';

const signal = new AbortController().signal;

function setUp() {
	const workspace = new FakeWorkspace();
	const tools = createWorkspaceTools(workspace);
	const run = (name: string, input: unknown, runSignal = signal) => {
		const tool = tools.find(candidate => candidate.name === name);
		if (!tool) throw new Error(`There is no tool named ${name}`);
		return tool.execute(input, runSignal);
	};
	return { workspace, tools, run };
}

describe('the workspace tools', () => {
	it('are three, each described to the model with a strict schema', () => {
		const { tools } = setUp();

		expect(tools.map(tool => tool.name)).toEqual(['listFiles', 'searchText', 'readFile']);
		for (const tool of tools) {
			expect(tool.description).not.toBe('');
			expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
			expect(tool.inputSchema.required).toEqual(Object.keys(tool.inputSchema.properties as object));
		}
	});

	describe('listFiles', () => {
		it('asks for at most 200 files and answers one path per line', async () => {
			const { workspace, run } = setUp();
			workspace.files = { files: ['src/a.ts', 'src/b.ts'], total: 2, truncated: false };

			const output = await run('listFiles', { path: null, glob: null });

			expect(workspace.listed).toEqual([{ limit: 200 }]);
			expect(output).toBe('src/a.ts\nsrc/b.ts');
		});

		it('passes the scope the model asked for', async () => {
			const { workspace, run } = setUp();

			await run('listFiles', { path: 'src', glob: '**/*.ts' });

			expect(workspace.listed).toEqual([{ path: 'src', glob: '**/*.ts', limit: 200 }]);
		});

		it('says how many files it left out', async () => {
			const { workspace, run } = setUp();
			workspace.files = { files: ['src/a.ts', 'src/b.ts'], total: 950, truncated: true };

			const output = await run('listFiles', { path: null, glob: null });

			expect(output).toContain('src/a.ts\nsrc/b.ts');
			expect(output).toMatch(/2 of 950/);
		});

		it('says so when there is no file', async () => {
			const { run } = setUp();

			await expect(run('listFiles', { path: 'missing', glob: null })).resolves.toMatch(/no files/i);
		});
	});

	describe('searchText', () => {
		it('asks for at most 100 matches and answers one match per line', async () => {
			const { workspace, run } = setUp();
			workspace.matches = {
				matches: [
					{ path: 'src/agent.ts', line: 1, text: 'export const needle = 1;' },
					{ path: 'src/nested/loop.ts', line: 2, text: 'const needle = 2;' },
				],
				total: 2,
				truncated: false,
			};

			const output = await run('searchText', {
				pattern: 'needle',
				ignoreCase: null,
				path: null,
				glob: null,
			});

			expect(workspace.searched).toEqual([{ pattern: 'needle', ignoreCase: false, limit: 100 }]);
			expect(output).toBe(
				'src/agent.ts:1: export const needle = 1;\nsrc/nested/loop.ts:2: const needle = 2;',
			);
		});

		it('passes the scope and the case option the model asked for', async () => {
			const { workspace, run } = setUp();

			await run('searchText', {
				pattern: 'needle',
				ignoreCase: true,
				path: 'src',
				glob: '**/*.ts',
			});

			expect(workspace.searched).toEqual([
				{ pattern: 'needle', ignoreCase: true, path: 'src', glob: '**/*.ts', limit: 100 },
			]);
		});

		it('says how many matches it left out', async () => {
			const { workspace, run } = setUp();
			workspace.matches = {
				matches: [{ path: 'src/agent.ts', line: 1, text: 'needle' }],
				total: 40,
				truncated: true,
			};

			const output = await run('searchText', {
				pattern: 'needle',
				ignoreCase: null,
				path: null,
				glob: null,
			});

			expect(output).toContain('src/agent.ts:1: needle');
			expect(output).toMatch(/1 of 40/);
		});

		// One minified line can be larger than everything else the model has read.
		it('cuts a very long line', async () => {
			const { workspace, run } = setUp();
			const long = 'x'.repeat(100_000);
			workspace.matches = {
				matches: [{ path: 'dist/app.min.js', line: 1, text: long }],
				total: 1,
				truncated: false,
			};

			const output = await run('searchText', {
				pattern: 'x',
				ignoreCase: null,
				path: null,
				glob: null,
			});

			expect(output).toContain(`dist/app.min.js:1: ${'x'.repeat(300)}`);
			expect(output.length).toBeLessThan(400);
		});

		it('says so when nothing matches', async () => {
			const { run } = setUp();

			await expect(
				run('searchText', { pattern: 'needle', ignoreCase: null, path: null, glob: null }),
			).resolves.toMatch(/no matches/i);
		});

		it('rejects a call without a pattern, without searching', async () => {
			const { workspace, run } = setUp();

			await expect(run('searchText', { ignoreCase: null, path: null, glob: null })).rejects.toThrow(
				/pattern/,
			);

			expect(workspace.searched).toEqual([]);
		});
	});

	describe('readFile', () => {
		it('reads the first 200 lines by default, each with its number', async () => {
			const { workspace, run } = setUp();
			workspace.content = { lines: ['first', 'second'], totalLines: 2, truncated: false };

			const output = await run('readFile', { path: 'src/a.ts', fromLine: null, lineCount: null });

			expect(workspace.read).toEqual([{ path: 'src/a.ts', fromLine: 1, lineCount: 200 }]);
			expect(output).toBe('1: first\n2: second');
		});

		it('reads the range the model asked for, numbered from its first line', async () => {
			const { workspace, run } = setUp();
			workspace.content = { lines: ['first', 'second'], totalLines: 950, truncated: true };

			const output = await run('readFile', { path: 'src/a.ts', fromLine: 40, lineCount: 2 });

			expect(workspace.read).toEqual([{ path: 'src/a.ts', fromLine: 40, lineCount: 2 }]);
			expect(output).toContain('40: first\n41: second');
			// How long the file is, and therefore where to continue.
			expect(output).toMatch(/950/);
		});

		// A minified bundle or a source map holds megabytes on one line.
		it('cuts a very long line and says how many it cut', async () => {
			const { workspace, run } = setUp();
			workspace.content = {
				lines: ['short', 'x'.repeat(100_000)],
				totalLines: 2,
				truncated: false,
			};

			const output = await run('readFile', {
				path: 'dist/app.js',
				fromLine: null,
				lineCount: null,
			});

			expect(output).toContain(`1: short\n2: ${'x'.repeat(300)}…`);
			expect(output).toMatch(/1 lines were longer than 300/);
			expect(output.length).toBeLessThan(500);
		});

		it('never reads more than 200 lines at once, whatever the model asks', async () => {
			const { workspace, run } = setUp();

			await run('readFile', { path: 'src/a.ts', fromLine: null, lineCount: 5000 });

			expect(workspace.read).toEqual([{ path: 'src/a.ts', fromLine: 1, lineCount: 200 }]);
		});

		it.each([
			['a first line below 1', { path: 'src/a.ts', fromLine: 0, lineCount: null }],
			['a line count below 1', { path: 'src/a.ts', fromLine: null, lineCount: 0 }],
			['a line number that is not whole', { path: 'src/a.ts', fromLine: 1.5, lineCount: null }],
		])('rejects %s, without reading', async (_, input) => {
			const { workspace, run } = setUp();

			await expect(run('readFile', input)).rejects.toBeInstanceOf(Error);

			expect(workspace.read).toEqual([]);
		});

		it('says so when the range holds no line', async () => {
			const { workspace, run } = setUp();
			workspace.content = { lines: [], totalLines: 3, truncated: false };

			const output = await run('readFile', { path: 'src/a.ts', fromLine: 10, lineCount: null });

			// The file's length tells the model where it went wrong.
			expect(output).toMatch(/3/);
		});
	});

	it('hand the run signal to the workspace', async () => {
		const { workspace, run } = setUp();
		const controller = new AbortController();

		await run('listFiles', { path: null, glob: null }, controller.signal);
		await run(
			'searchText',
			{ pattern: 'x', ignoreCase: null, path: null, glob: null },
			controller.signal,
		);
		await run('readFile', { path: 'a', fromLine: null, lineCount: null }, controller.signal);

		expect(workspace.signals).toEqual([controller.signal, controller.signal, controller.signal]);
	});

	// The agent turns it into an error result, so the model reads the workspace's own words.
	it('let a failure of the workspace through as it is', async () => {
		const { workspace, run } = setUp();
		workspace.failure = new Error('No such file: .env');

		await expect(run('readFile', { path: '.env', fromLine: null, lineCount: null })).rejects.toBe(
			workspace.failure,
		);
	});

	// #25: the fake model drives the real tools through the real loop, with no provider.
	it('answer a model that searches the repository before it replies', async () => {
		const workspace = new FakeWorkspace();
		workspace.matches = {
			matches: [{ path: 'src/agent.ts', line: 1, text: 'export const needle = 1;' }],
			total: 1,
			truncated: false,
		};
		const call = toolCall('call-1', 'searchText', {
			pattern: 'needle',
			ignoreCase: null,
			path: 'src',
			glob: null,
		});
		const llmClient = new FakeLLMClient(
			assistantResponse([call]),
			textResponse('It is in src/agent.ts.'),
		);
		const tools: Tool[] = createWorkspaceTools(workspace);

		const answer = await new LLMAgent({ llmClient, tools }).run('Where is needle?', { signal });

		expect(llmClient.tools[0]?.map(tool => tool.name)).toEqual([
			'listFiles',
			'searchText',
			'readFile',
		]);
		expect(llmClient.contexts[1]?.at(-1)).toEqual(
			toolMessage(toolResult('call-1', 'searchText', 'src/agent.ts:1: export const needle = 1;')),
		);
		expect(answer.response).toBe('It is in src/agent.ts.');
	});
});
