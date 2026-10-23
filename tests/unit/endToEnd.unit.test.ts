import Anthropic from '@anthropic-ai/sdk';
import type {
	ContentBlock,
	Message as AnthropicMessage,
} from '@anthropic-ai/sdk/resources/messages';
import OpenAI from 'openai';
import type { Response, ResponseOutputItem } from 'openai/resources/responses/responses';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Only the published surface: this is what a consumer can reach.
import {
	type ApprovalRequest,
	type Approver,
	type Commands,
	createHistory,
	createLLMOrchestrator,
	historyStart,
	type ProgressEvent,
	type Transcript,
	type WorkspaceOptions,
} from '../../src/index.ts';
import { fakeClaudeSdk } from '../support/fakeClaudeSdk.ts';

vi.mock('openai', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	default: vi.fn(),
}));

const signal = new AbortController().signal;
const broken = 'export const add = (a: number, b: number) => a - b;\n';
const fixed = 'export const add = (a: number, b: number) => a + b;\n';

let parent: string;
let repo: string;
let workspace: WorkspaceOptions;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-end-to-end-')));
	repo = join(parent, 'repo');
	mkdirSync(join(repo, 'src'), { recursive: true });
	execFileSync('git', ['init', '--quiet'], { cwd: repo });
	writeFileSync(join(repo, 'src', 'math.ts'), broken);
	workspace = { roots: [{ path: repo, access: 'write' }], stateDirectory: join(parent, 'state') };
});

afterEach(() => {
	vi.clearAllMocks();
	rmSync(parent, { recursive: true, force: true });
});

/**
 * The project's commands, as a consumer would configure them: a test that fails until `add`
 * adds, leaving a report behind while it fails, and a formatter that collapses spaces.
 */
const commands: Commands = {
	test: {
		description: 'Runs the tests, or only those for the files given',
		executable: 'sh',
		args: [
			'-c',
			'if grep -q "a + b" src/math.ts; then rm -f failure.txt; echo "1 passed"; else echo "add(1, 2) returned -1" > failure.txt; echo "1 failed"; exit 1; fi',
			'sh',
			{ type: 'paths', name: 'files', description: 'Test files' },
		],
	},
	format: {
		description: 'Formats the source',
		executable: 'sh',
		args: ['-c', "sed -i.bak 's/  */ /g' src/math.ts && rm src/math.ts.bak"],
	},
};

/** A file under the repository, or `undefined` when it does not exist. */
function read(name: string): string | undefined {
	const path = join(repo, name);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** An approver that allows everything and keeps what it was asked. */
function approving(): { approve: Approver; requests: ApprovalRequest[] } {
	const requests: ApprovalRequest[] = [];
	return {
		requests,
		approve: request => {
			requests.push(request);
			return { approved: true };
		},
	};
}

// OpenAI's Responses API, scripted one answer per call.

function openAIResponse(...output: ResponseOutputItem[]): Response {
	return {
		status: 'completed',
		incomplete_details: null,
		error: null,
		output,
		usage: {
			input_tokens: 10,
			input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 15,
		},
	} as Response;
}

const call = (callId: string, name: string, input: unknown): ResponseOutputItem => ({
	type: 'function_call',
	id: `fc-${callId}`,
	call_id: callId,
	name,
	arguments: JSON.stringify(input),
});

const text = (content: string): ResponseOutputItem => ({
	type: 'message',
	id: 'msg',
	role: 'assistant',
	status: 'completed',
	content: [{ type: 'output_text', text: content, annotations: [] }],
});

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

function scriptOpenAI(...responses: Response[]) {
	const create = vi.fn();
	for (const next of responses) create.mockResolvedValueOnce(next);
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return create;
}

// Anthropic's Messages API, scripted one answer per call.

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

const say = (content: string): ContentBlock => ({ type: 'text', text: content, citations: null });

function scriptClaude(...responses: AnthropicMessage[]) {
	const create = vi.fn();
	for (const next of responses) create.mockResolvedValueOnce(next);
	vi.mocked(Anthropic).mockImplementation(function () {
		return fakeClaudeSdk(create);
	});
	return create;
}

// Only an explorer's instructions say so.
const explorerMark = 'You find things in a repository';

/**
 * Answers the roles and the explorers apart, each from its own script, told by their
 * instructions: explorers work in the background while the role that sent them goes on. They
 * answer only once the roles have made `rolesFirst` calls, so a role's answer that waits for them
 * comes before their reports.
 */
function apart<Answer>(roles: Answer[], explorers: Answer[], rolesFirst: number) {
	let roleCalls = 0;
	let reached!: () => void;
	const rolesWent = new Promise<void>(resolve => {
		reached = resolve;
	});
	const next = (script: Answer[]) => script.shift() ?? Promise.reject(new Error('Not scripted'));
	return vi.fn(async (request: unknown) => {
		if (JSON.stringify(request).includes(explorerMark)) {
			await rolesWent;
			return next(explorers);
		}
		roleCalls++;
		if (roleCalls >= rolesFirst) reached();
		return next(roles);
	});
}

function scriptOpenAIApart(roles: Response[], explorers: Response[], rolesFirst: number) {
	const create = apart(roles, explorers, rolesFirst);
	vi.mocked(OpenAI).mockImplementation(function () {
		return { responses: { create } } as unknown as OpenAI;
	});
	return create;
}

function scriptClaudeApart(
	roles: AnthropicMessage[],
	explorers: AnthropicMessage[],
	rolesFirst: number,
) {
	const create = apart(roles, explorers, rolesFirst);
	vi.mocked(Anthropic).mockImplementation(function () {
		return fakeClaudeSdk(create);
	});
	return create;
}

/** What a role, not an explorer, sent on its `index`th call, as text. */
function sentByRoles(create: ReturnType<typeof vi.fn>, index: number): string {
	const roles = create.mock.calls
		.map(([request]) => JSON.stringify(request))
		.filter(request => !request.includes(explorerMark));
	return roles[index] ?? '';
}

/** What an explorer sent on its `index`th call. */
function sentByExplorers(create: ReturnType<typeof vi.fn>, index: number): unknown {
	return create.mock.calls
		.map(([request]) => request as unknown)
		.filter(request => JSON.stringify(request).includes(explorerMark))[index];
}

/** Everything one SDK was sent, as text, to find what a tool returned to the model. */
function sent(create: ReturnType<typeof vi.fn>, index: number): string {
	return JSON.stringify(create.mock.calls[index]?.[0]);
}

describe('the write tools, end to end through the public exports', () => {
	it('plans, fixes, formats and tests on OpenAI, reviews on Claude, and goes back and forth', async () => {
		const openAI = scriptOpenAI(
			// The planner reads, then plans.
			openAIResponse(
				call('p1', 'readFile', { path: 'src/math.ts', fromLine: null, lineCount: null }),
			),
			openAIResponse(text('Make add add, then format and test.')),
			// The executor sees the test fail, reads, patches sloppily, formats, and tests again.
			openAIResponse(
				call('e1', 'runCommand', { command: { name: 'test', files: ['src/math.ts'] } }),
			),
			openAIResponse(
				call('e2', 'readFile', { path: 'src/math.ts', fromLine: null, lineCount: null }),
			),
			openAIResponse(
				patch('e3', {
					type: 'update_file',
					path: 'src/math.ts',
					diff: '@@\n-export const add = (a: number, b: number) => a - b;\n+export const add = (a: number, b: number) => a  +  b;',
				}),
			),
			openAIResponse(call('e4', 'runCommand', { command: { name: 'format' } })),
			openAIResponse(call('e5', 'runCommand', { command: { name: 'test', files: [] } })),
			openAIResponse(text('add adds now, and the test passes.')),
		);
		const claude = scriptClaude(
			// The reviewer looks at what the task changed, then approves.
			claudeResponse(use('r1', 'showChanges', {})),
			claudeResponse(say('{"decision":"approved"}')),
		);
		const { approve, requests } = approving();
		const events: ProgressEvent[] = [];

		const agent = await createLLMOrchestrator({ workspace, commands, logger: { warn: vi.fn() } });
		const response = await agent.run('Fix add.', {
			signal,
			approve,
			onProgress: event => events.push(event),
		});

		// What the repository holds: the fix, formatted, and no report of the failure that passed.
		expect(read('src/math.ts')).toBe(fixed);
		expect(read('failure.txt')).toBeUndefined();

		// Every command asked first, showing what would run.
		expect(requests.map(request => request.command?.args.at(-1))).toEqual([
			'src/math.ts',
			"sed -i.bak 's/  */ /g' src/math.ts && rm src/math.ts.bak",
			'sh',
		]);
		expect(requests.every(request => request.command?.cwd === repo)).toBe(true);

		// What each command told the model.
		expect(sent(openAI, 3)).toContain('\\"test\\" exited with code 1');
		expect(sent(openAI, 3)).toContain('Files it changed, recorded in the history: failure.txt.');
		expect(sent(openAI, 7)).toContain('\\"test\\" exited with code 0');
		// The patch's change was narrated as a diff.
		const narrated = events.find(
			event =>
				event.type === 'tool' && event.name === 'apply_patch' && event.status === 'completed',
		);
		expect(narrated && 'diff' in narrated ? narrated.diff : undefined).toContain(
			'+export const add = (a: number, b: number) => a  +  b;',
		);

		// The reviewer saw the task's changes, the formatter's marked as seen around it.
		const review = sent(claude, 1);
		expect(review).toContain('+export const add = (a: number, b: number) => a + b;');
		expect(review).toContain('changed while the command \\"format\\" ran');
		expect(review).not.toContain('failure.txt');

		// One run of the history, named in the response.
		const history = await createHistory({ root: repo, stateDirectory: workspace.stateDirectory });
		const { head, runs } = await history.list();
		expect(response.runId).toBe(head);
		expect(runs).toEqual([
			expect.objectContaining({ runId: head, status: 'completed', files: ['src/math.ts'] }),
		]);

		await history.undo({ reason: 'see it broken again' });
		expect(read('src/math.ts')).toBe(broken);
		expect(read('failure.txt')).toBeUndefined();
		await history.redo();
		expect(read('src/math.ts')).toBe(fixed);
		await expect(history.goTo(historyStart)).resolves.toMatchObject({ complete: true });
		expect(read('src/math.ts')).toBe(broken);
	});

	it('lets the planner send an explorer, which reads on a cheaper model and reports back', async () => {
		const openAI = scriptOpenAIApart(
			[
				// The planner explores, waits for the report, then plans from it.
				openAIResponse(call('p1', 'explore', { questions: ['What does add in src/math.ts do?'] })),
				openAIResponse(text('I wait for the explorer.')),
				openAIResponse(text('Make add add.')),
				openAIResponse(text('Nothing to change yet.')),
			],
			[
				// The explorer reads, then reports.
				openAIResponse(
					call('x1', 'readFile', { path: 'src/math.ts', fromLine: null, lineCount: null }),
				),
				openAIResponse(text('add in src/math.ts subtracts: a - b.')),
			],
			2,
		);
		scriptClaude(claudeResponse(say('{"decision":"approved"}')));
		const events: ProgressEvent[] = [];

		const agent = await createLLMOrchestrator({ workspace, logger: { warn: vi.fn() } });
		const response = await agent.run('Fix add.', {
			signal,
			onProgress: event => events.push(event),
		});

		const explorerRequest = sentByExplorers(openAI, 0) as {
			model: string;
			reasoning: { effort: string };
			tools: { name?: string }[];
			input: unknown[];
		};
		expect(explorerRequest.model).toBe('gpt-5.6-luna');
		expect(explorerRequest.reasoning.effort).toBe('medium');
		expect(explorerRequest.tools.map(tool => tool.name)).toEqual([
			'listFiles',
			'searchText',
			'readFile',
			'readFiles',
		]);
		// It starts from the question alone.
		expect(JSON.stringify(explorerRequest.input)).toContain('What does add in src/math.ts do?');
		expect(JSON.stringify(explorerRequest.input)).not.toContain('Fix add.');
		// The planner's call answers at once, and the planner reads the report, not the file, once
		// the explorer finished.
		expect(sentByRoles(openAI, 1)).toContain('Sent to work in the background: explorer 1.');
		expect(sentByRoles(openAI, 1)).not.toContain('subtracts');
		expect(sentByRoles(openAI, 2)).toContain(
			'explorer 1, sent by your call p1 with the task: What does add in src/math.ts do?',
		);
		expect(sentByRoles(openAI, 2)).toContain('add in src/math.ts subtracts: a - b.');
		// The explorer's narration comes apart, stamped with the planner that sent it.
		const explorerRead = events.find(
			event =>
				event.type === 'subagent' &&
				event.event.type === 'tool' &&
				event.event.name === 'readFile' &&
				event.event.status === 'completed',
		);
		expect(explorerRead).toMatchObject({
			callId: 'p1',
			subagent: 1,
			task: 'What does add in src/math.ts do?',
			agent: 'planner',
		});
		// Seven calls, ten tokens in and five out each: the explorer's two count too.
		expect(response.tokens).toMatchObject({ inputTokens: 70, outputTokens: 35 });
	});

	it('hands over every run of every role and explorer, each named by its agent', async () => {
		scriptOpenAIApart(
			[
				openAIResponse(call('p1', 'explore', { questions: ['Where is add?'] })),
				openAIResponse(text('I wait for the explorer.')),
				openAIResponse(text('Make add add.')),
				openAIResponse(text('Nothing to change yet.')),
			],
			[openAIResponse(text('add is in src/math.ts.'))],
			2,
		);
		scriptClaude(claudeResponse(say('{"decision":"approved"}')));
		const transcripts: Transcript[] = [];

		const agent = await createLLMOrchestrator({
			workspace,
			logger: { warn: vi.fn() },
			onTranscript: transcript => {
				transcripts.push(transcript);
			},
		});
		await agent.run('Fix add.', { signal });

		// Each once its run ended: the explorer's inside the planner's.
		expect(transcripts.map(({ agent, outcome }) => [agent, outcome])).toEqual([
			['explorer', 'completed'],
			['planner', 'completed'],
			['executor', 'completed'],
			['reviewer', 'completed'],
		]);
		expect(JSON.stringify(transcripts[0]?.content)).toContain('Where is add?');
		expect(JSON.stringify(transcripts[0]?.content)).not.toContain('Fix add.');
		expect(JSON.stringify(transcripts[1]?.content)).toContain('add is in src/math.ts.');
	});

	it('sends Claude Haiku 5.5, at medium effort, as the explorer of a role on Claude', async () => {
		const claude = scriptClaudeApart(
			[
				claudeResponse(use('p1', 'explore', { questions: ['Where is add?'] })),
				claudeResponse(say('I wait for the explorer.')),
				claudeResponse(say('Make add add.')),
				claudeResponse(say('Nothing to change yet.')),
				claudeResponse(say('{"decision":"approved"}')),
			],
			[claudeResponse(say('add is in src/math.ts.'))],
			2,
		);

		const agent = await createLLMOrchestrator({
			provider: 'anthropic',
			workspace,
			logger: { warn: vi.fn() },
		});
		await agent.run('Fix add.', { signal });

		const explorerRequest = sentByExplorers(claude, 0) as Record<string, unknown>;
		expect(explorerRequest.model).toBe('claude-haiku-5-5');
		expect(explorerRequest.output_config).toEqual({ effort: 'medium' });
		expect(sentByRoles(claude, 2)).toContain('add is in src/math.ts.');
	});

	it('does the same with every role on Claude, the executor with its text editor', async () => {
		const claude = scriptClaude(
			claudeResponse(say('Make add add, then test.')),
			claudeResponse(
				use('e1', 'str_replace_based_edit_tool', { command: 'view', path: 'src/math.ts' }),
			),
			claudeResponse(
				use('e2', 'str_replace_based_edit_tool', {
					command: 'str_replace',
					path: 'src/math.ts',
					old_str: 'a - b',
					new_str: 'a + b',
				}),
			),
			claudeResponse(
				use('e3', 'runCommand', { command: { name: 'test', files: ['src/math.ts'] } }),
			),
			claudeResponse(say('add adds now.')),
			claudeResponse(say('{"decision":"approved"}')),
		);
		const { approve, requests } = approving();

		const agent = await createLLMOrchestrator({
			provider: 'anthropic',
			workspace,
			commands,
			logger: { warn: vi.fn() },
		});
		const response = await agent.run('Fix add.', { signal, approve });

		expect(read('src/math.ts')).toBe(fixed);
		expect(requests).toHaveLength(1);
		expect(sent(claude, 4)).toContain('\\"test\\" exited with code 0');

		const history = await createHistory({ root: repo, stateDirectory: workspace.stateDirectory });
		expect((await history.list()).head).toBe(response.runId);
		await history.undo();
		expect(read('src/math.ts')).toBe(broken);
	});

	it('denies a command nobody approved, and the run carries on without it', async () => {
		scriptOpenAI(
			openAIResponse(text('Run the tests.')),
			openAIResponse(call('e1', 'runCommand', { command: { name: 'test', files: [] } })),
			openAIResponse(text('The tests were not allowed to run.')),
		);
		scriptClaude(claudeResponse(say('{"decision":"approved"}')));

		const agent = await createLLMOrchestrator({ workspace, commands, logger: { warn: vi.fn() } });
		const response = await agent.run('Test it.', { signal });

		// No approver: the destructive call was denied, so the failing test never wrote its report.
		expect(read('failure.txt')).toBeUndefined();
		expect(response.runId).toBeUndefined();
	});
});
