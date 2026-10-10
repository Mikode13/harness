import Anthropic from '@anthropic-ai/sdk';
import type {
	ContentBlock,
	Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages';
import OpenAI from 'openai';
import type { Response, ResponseOutputItem } from 'openai/resources/responses/responses';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { ClaudeLLMClient } from '../../src/llm/infrastructure/claudeLLMClient.ts';
import { OpenAILLMClient } from '../../src/llm/infrastructure/openAILLMClient.ts';
import { FileRecoveryStore } from '../../src/recovery/infrastructure/fileRecoveryStore.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import { createWorkspace } from '../../src/tools/infrastructure/createWorkspace.ts';
import {
	createApplyPatchTool,
	createDeleteFileTool,
	createTextEditorTool,
} from '../../src/tools/infrastructure/editFormats.ts';
import { GitIgnoreRules } from '../../src/tools/infrastructure/gitIgnoreRules.ts';
import { RootsAccessPolicy } from '../../src/tools/infrastructure/rootsAccessPolicy.ts';
import { createTrackedReadFile } from '../../src/tools/infrastructure/trackedReadFile.ts';
import { WorkspaceWrites } from '../../src/tools/infrastructure/workspaceWrites.ts';

// The error classes stay real; only the clients the SDKs build are fakes.
vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;

// Matchers typed as the text they stand for, so they sit inside expected objects.
const containing = (text: string) => expect.stringContaining(text) as string;
const matching = (pattern: RegExp) => expect.stringMatching(pattern) as string;
const logger = { warn: vi.fn() };

let parent: string;
let root: string;
let writes: WorkspaceWrites;
let policy: RootsAccessPolicy;

const greet = [
	'export function greet(name: string): string {',
	"\treturn 'Hello, ' + name;",
	'}',
	'',
].join('\n');

beforeEach(async () => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-formats-')));
	root = join(parent, 'repo');
	mkdirSync(join(root, 'src'), { recursive: true });
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	writeFileSync(join(root, 'src', 'greet.ts'), greet);
	writeFileSync(join(root, 'notes.txt'), 'obsolete\n');
	policy = await RootsAccessPolicy.create({
		roots: [{ path: root, access: 'write' }],
		ignoreRules: new GitIgnoreRules(),
	});
	writes = new WorkspaceWrites({
		policy,
		store: await FileRecoveryStore.open({ root, directory: join(parent, 'state') }),
	});
});

afterEach(() => {
	vi.clearAllMocks();
	rmSync(parent, { recursive: true, force: true });
});

function onDisk(name: string): string | undefined {
	try {
		return readFileSync(join(root, name), 'utf8');
	} catch {
		return undefined;
	}
}

describe('OpenAI apply_patch on the shared edit engine', () => {
	function openAIResponse(...output: ResponseOutputItem[]): Response {
		return {
			status: 'completed',
			incomplete_details: null,
			error: null,
			output,
			usage: {
				input_tokens: 10,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens: 5,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: 15,
			},
		} as Response;
	}

	const patch = (
		callId: string,
		operation: { type: string; path: string; diff?: string },
	): ResponseOutputItem =>
		({
			type: 'apply_patch_call',
			id: `apc-${callId}`,
			call_id: callId,
			status: 'completed',
			operation,
		}) as ResponseOutputItem;

	const readCall = (callId: string, path: string): ResponseOutputItem => ({
		type: 'function_call',
		id: `fc-${callId}`,
		call_id: callId,
		name: 'readFile',
		arguments: JSON.stringify({ path, fromLine: null, lineCount: null }),
	});

	const answer = (): ResponseOutputItem => ({
		type: 'message',
		id: 'msg',
		role: 'assistant',
		status: 'completed',
		content: [{ type: 'output_text', text: 'done', annotations: [] }],
	});

	function agentOver(...responses: Response[]) {
		const create = vi.fn();
		for (const next of responses) create.mockResolvedValueOnce(next);
		vi.mocked(OpenAI).mockImplementation(function () {
			return { responses: { create } } as unknown as OpenAI;
		});
		const agent = new LLMAgent({
			llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
			tools: [createTrackedReadFile(policy), createApplyPatchTool(writes)],
		});
		return { agent, create };
	}

	it('edits, creates and deletes through patches, after reading, and sends the results back', async () => {
		const { agent, create } = agentOver(
			openAIResponse(
				patch('early', {
					type: 'update_file',
					path: 'src/greet.ts',
					diff: '@@\n-}\n+};',
				}),
			),
			openAIResponse(readCall('read-1', 'src/greet.ts'), readCall('read-2', 'notes.txt')),
			openAIResponse(
				patch('update', {
					type: 'update_file',
					path: 'src/greet.ts',
					diff: "@@\n-export function greet(name: string): string {\n-\treturn 'Hello, ' + name;\n+export function welcome(name: string): string {\n+\treturn `Hello, ${name}`;\n }",
				}),
				patch('create', { type: 'create_file', path: 'docs/greet.md', diff: '+Says hello.\n' }),
				patch('delete', { type: 'delete_file', path: 'notes.txt' }),
				patch('wrong', { type: 'update_file', path: 'src/greet.ts', diff: '@@\n-missing\n+x' }),
			),
			openAIResponse(answer()),
		);

		await agent.run('rename greet', { signal });

		expect(create.mock.calls[0]?.[0]).toMatchObject({
			tools: [{ type: 'function' }, { type: 'apply_patch' }],
		});
		expect(onDisk('src/greet.ts')).toBe(
			'export function welcome(name: string): string {\n\treturn `Hello, ${name}`;\n}\n',
		);
		expect(onDisk('docs/greet.md')).toBe('Says hello.\n');
		expect(onDisk('notes.txt')).toBeUndefined();

		const outputs = (call: number) =>
			(create.mock.calls[call]?.[0] as { input: { type?: string }[] }).input.filter(
				item => item.type === 'apply_patch_call_output',
			);
		expect(outputs(1)).toEqual([
			{
				type: 'apply_patch_call_output',
				call_id: 'early',
				status: 'failed',
				output: 'READ_REQUIRED: read "src/greet.ts" before changing it',
			},
		]);
		expect(outputs(3).slice(1)).toEqual([
			expect.objectContaining({ call_id: 'update', status: 'completed' }),
			expect.objectContaining({
				call_id: 'create',
				status: 'completed',
				output: 'Created docs/greet.md (1 line, 12 bytes).',
			}),
			expect.objectContaining({
				call_id: 'delete',
				status: 'completed',
				output: 'Deleted notes.txt.',
			}),
			expect.objectContaining({
				call_id: 'wrong',
				status: 'failed',
				output: containing('Hunk 1 of the patch for "src/greet.ts" does not match the file'),
			}),
		]);
		// The calls go back as the patches OpenAI sent, beside their outputs.
		const replayed = (create.mock.calls[3]?.[0] as { input: { type?: string }[] }).input.filter(
			item => item.type === 'apply_patch_call',
		);
		expect(replayed).toContainEqual({
			type: 'apply_patch_call',
			call_id: 'delete',
			status: 'completed',
			operation: { type: 'delete_file', path: 'notes.txt' },
		});
	});

	it('cannot be offered to Claude', () => {
		vi.mocked(Anthropic).mockImplementation(function () {
			return { messages: { create: vi.fn() } } as unknown as Anthropic;
		});

		expect(
			() =>
				new LLMAgent({
					llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
					tools: [createApplyPatchTool(writes)],
				}),
		).toThrow(InvalidAgentConfigError);
	});
});

describe("Claude's text editor on the shared edit engine", () => {
	function claudeResponse(...content: ContentBlock[]): AnthropicMessage {
		return {
			stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
			stop_details: null,
			content,
			usage: { input_tokens: 10, output_tokens: 5 },
		} as AnthropicMessage;
	}

	const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({
		type: 'tool_use',
		id,
		name,
		input,
		caller: { type: 'direct' },
	});
	const editor = (id: string, input: Record<string, unknown>) =>
		use(id, 'str_replace_based_edit_tool', input);
	const done = (): ContentBlock => ({ type: 'text', text: 'done', citations: null });

	async function agentOver(...responses: AnthropicMessage[]) {
		const create = vi.fn();
		for (const next of responses) create.mockResolvedValueOnce(next);
		vi.mocked(Anthropic).mockImplementation(function () {
			return { messages: { create } } as unknown as Anthropic;
		});
		const agent = new LLMAgent({
			llmClient: new ClaudeLLMClient({ model: 'sonnet', systemPrompt: '', logger }),
			tools: [
				createTextEditorTool({ writes, policy, workspace: await createWorkspace({ root }) }),
				createDeleteFileTool(writes),
			],
		});
		return { agent, create };
	}

	/** The results Claude was sent in the request `call`, in order. */
	function results(create: ReturnType<typeof vi.fn>, call: number) {
		const messages = (create.mock.calls[call]?.[0] as { messages: { content: unknown }[] })
			.messages;
		const last = messages.at(-1)?.content as { content: string; is_error?: boolean }[];
		return last.map(({ content, is_error }) => ({ content, isError: is_error === true }));
	}

	it('views, replaces, inserts, creates and deletes, refusing what it must', async () => {
		const { agent, create } = await agentOver(
			claudeResponse(
				editor('t1', {
					command: 'str_replace',
					path: 'src/greet.ts',
					old_str: 'greet',
					new_str: 'x',
				}),
				editor('t2', { command: 'view', path: '.' }),
				editor('t3', { command: 'view', path: 'src/greet.ts', view_range: [1, 2] }),
			),
			claudeResponse(
				editor('t4', { command: 'str_replace', path: 'src/greet.ts', old_str: "'", new_str: '`' }),
				editor('t5', {
					command: 'str_replace',
					path: 'src/greet.ts',
					old_str: 'function greet',
					new_str: 'function welcome',
				}),
				editor('t6', {
					command: 'insert',
					path: 'src/greet.ts',
					insert_line: 0,
					insert_text: '// Greets.',
				}),
				editor('t7', { command: 'create', path: 'src/greet.ts', file_text: 'clobbered' }),
				editor('t8', { command: 'create', path: 'docs/greet.md', file_text: 'Says hello.\n' }),
				use('t9', 'delete_file', { path: 'notes.txt' }),
			),
			claudeResponse(done()),
		);

		await agent.run('rename greet', { signal });

		expect((create.mock.calls[0]?.[0] as { tools: unknown[] }).tools).toEqual([
			{ type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
			expect.objectContaining({ name: 'delete_file', strict: true }),
		]);
		expect(results(create, 1)).toEqual([
			{ content: 'READ_REQUIRED: read "src/greet.ts" before changing it', isError: true },
			{ content: containing('src/greet.ts'), isError: false },
			{
				content:
					"1: export function greet(name: string): string {\n2: \treturn 'Hello, ' + name;\n[The file has 3 lines. Read from line 3 to continue.]",
				isError: false,
			},
		]);
		expect(results(create, 2)).toEqual([
			{
				content:
					'old_str appears 2 times in "src/greet.ts"; include more of the lines around it so it appears once',
				isError: true,
			},
			{ content: matching(/^Changed src\/greet\.ts\./), isError: false },
			{ content: matching(/^Changed src\/greet\.ts\./), isError: false },
			{ content: '"src/greet.ts" already exists; read it and change it instead', isError: true },
			{ content: 'Created docs/greet.md (1 line, 12 bytes).', isError: false },
			// The editor's view of the folder did not read notes.txt.
			{ content: 'READ_REQUIRED: read "notes.txt" before changing it', isError: true },
		]);
		expect(onDisk('src/greet.ts')).toBe(
			"// Greets.\nexport function welcome(name: string): string {\n\treturn 'Hello, ' + name;\n}\n",
		);
		expect(onDisk('docs/greet.md')).toBe('Says hello.\n');
		expect(onDisk('notes.txt')).toBe('obsolete\n');
	});

	it('matches the text the model sends with \\n in a CRLF file, and keeps CRLF', async () => {
		writeFileSync(join(root, 'win.txt'), 'one\r\ntwo\r\nthree\r\n');
		const { agent } = await agentOver(
			claudeResponse(editor('t1', { command: 'view', path: 'win.txt' })),
			claudeResponse(
				editor('t2', {
					command: 'str_replace',
					path: 'win.txt',
					old_str: 'one\ntwo',
					new_str: '1\n2',
				}),
			),
			claudeResponse(done()),
		);

		await agent.run('change it', { signal });

		expect(onDisk('win.txt')).toBe('1\r\n2\r\nthree\r\n');
	});

	it('matches text as sent in a file that mixes endings, inserts like its neighbours, and names a bad view_range', async () => {
		writeFileSync(join(root, 'mixed.txt'), 'a\r\nb\nc\n');
		const { agent, create } = await agentOver(
			claudeResponse(
				editor('t1', { command: 'view', path: 'mixed.txt' }),
				editor('t2', { command: 'view', path: 'mixed.txt', view_range: [0, 5] }),
			),
			claudeResponse(
				editor('t3', {
					command: 'str_replace',
					path: 'mixed.txt',
					old_str: 'b\nc',
					new_str: 'B\nC',
				}),
				editor('t4', {
					command: 'insert',
					path: 'mixed.txt',
					insert_line: 1,
					insert_text: 'after a',
				}),
			),
			claudeResponse(done()),
		);

		await agent.run('change it', { signal });

		expect(results(create, 1)[1]).toEqual({
			content: 'view_range starts at line 0; lines count from 1',
			isError: true,
		});
		expect(onDisk('mixed.txt')).toBe('a\r\nafter a\r\nB\nC\n');
	});

	it('cannot be offered to OpenAI', () => {
		vi.mocked(OpenAI).mockImplementation(function () {
			return { responses: { create: vi.fn() } } as unknown as OpenAI;
		});

		return expect(
			(async () =>
				new LLMAgent({
					llmClient: new OpenAILLMClient({ model: 'gpt-5.6-luna', systemPrompt: '', logger }),
					tools: [
						createTextEditorTool({ writes, policy, workspace: await createWorkspace({ root }) }),
					],
				}))(),
		).rejects.toThrow(InvalidAgentConfigError);
	});
});
