import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, Approver } from '../../src/agent/domain/approval.ts';
import type { ProgressEvent } from '../../src/agent/domain/agent.ts';
import { RunContext, withRunContext } from '../../src/agent/domain/runContext.ts';
import { LLMAgent } from '../../src/engines/domain/model/llmAgent.ts';
import { historyStart } from '../../src/recovery/domain/recoveryStore.ts';
import { showChanges } from '../../src/recovery/domain/runChanges.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import type { Commands } from '../../src/tools/domain/commands.ts';
import { EditRefusedError, EditUnconfirmedError } from '../../src/tools/domain/fileEdits.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { createCommandTool } from '../../src/tools/infrastructure/commandTool.ts';
import { runCommandProcess } from '../../src/tools/infrastructure/commandProcess.ts';
import {
	commandToolFor,
	fileToolsFor,
	type OpenedWorkspace,
	openWorkspace,
	type WorkspaceOptions,
} from '../../src/tools/infrastructure/fileTools.ts';
import {
	assistantResponse,
	FakeLLMClient,
	textResponse,
	toolCall,
} from '../support/fakeLlmClient.ts';

const signal = new AbortController().signal;

let parent: string;
let root: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-commands-')));
	root = join(parent, 'repo');
	mkdirSync(join(root, 'src'), { recursive: true });
	execFileSync('git', ['init', '--quiet'], { cwd: root });
	write('.gitignore', 'node_modules\n');
	write('src/a.ts', 'export const a = 1 ;\n');
	write('src/b.ts', 'export const b = 2;\n');
	// Not in .gitignore: only the policy keeps it closed.
	write('.envrc', 'export TOKEN=secret\n');
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(parent, { recursive: true, force: true });
});

function write(name: string, content: string): void {
	mkdirSync(dirname(join(root, name)), { recursive: true });
	writeFileSync(join(root, name), content);
}

function read(name: string): string | undefined {
	const path = join(root, name);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** A command that runs `script` in `sh`, in the root, with `extra` on top. */
function shell(script: string, extra: Partial<Commands[string]> = {}): Commands[string] {
	return { description: 'A test command', executable: 'sh', args: ['-c', script], ...extra };
}

function options(
	roots: WorkspaceOptions['roots'] = [{ path: root, access: 'write' }],
): WorkspaceOptions {
	return { roots, stateDirectory: join(parent, 'state') };
}

async function open(): Promise<OpenedWorkspace> {
	return openWorkspace(options(), { warn: () => undefined });
}

/** Prepares and runs one call in its own run, then ends the run as `end`. */
async function call(
	tool: PreparingTool,
	input: unknown,
	{
		context = new RunContext(),
		runSignal = signal,
	}: { context?: RunContext; runSignal?: AbortSignal } = {},
): Promise<{ output?: string; error?: unknown; context: RunContext }> {
	try {
		const prepared = await tool.prepare(input, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
		});
		const output = await prepared.run(runSignal);
		await context.finish('completed');
		return { output, context };
	} catch (error) {
		await context.finish('failed');
		return { error, context };
	}
}

// Each test opens a git repository, lists it twice and starts real processes: alone that takes
// well under a second, but beside the whole suite running in parallel it has taken over five.
describe('runCommand', { timeout: 20_000 }, () => {
	it('records what a formatter-like command changed, and it can be undone', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			format: shell("sed -i.bak 's/ ;/;/' src/a.ts && rm src/a.ts.bak"),
		});

		expect((tool as PreparingTool).summarize?.({ command: { name: 'format' } })).toBe(
			"sh -c sed -i.bak 's/ ;/;/' src/a.ts && rm src/a.ts.bak",
		);
		const { output, context } = await call(tool as PreparingTool, { command: { name: 'format' } });

		expect(output).toContain('"format" exited with code 0');
		expect(output).toContain('Files it changed, recorded in the history: src/a.ts.');
		expect(read('src/a.ts')).toBe('export const a = 1;\n');
		const runId = context.historyRun.runId ?? '';
		const { entries } = await opened.store.readRun(runId);
		expect(entries).toMatchObject([
			{ path: join(root, 'src', 'a.ts'), status: 'applied', observedBy: 'format' },
		]);
		await expect(showChanges(opened.store, runId)).resolves.toContain(
			'# src/a.ts: changed while the command "format" ran, seen by comparing before and after',
		);

		await opened.store.goTo(historyStart);
		expect(read('src/a.ts')).toBe('export const a = 1 ;\n');
	});

	it('reports a failing test-like command, and records what it wrote before failing', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			test: shell(
				'mkdir -p src/__snapshots__ && echo snap > src/__snapshots__/a.snap; rm src/b.ts; echo "1 failed"; exit 1',
			),
		});

		const { error } = await call(tool as PreparingTool, { command: { name: 'test' } });
		const output = (error as Error).message;

		expect(output).toContain('"test" exited with code 1');
		expect(output).toContain('src/__snapshots__/a.snap');
		expect(output).toContain('src/b.ts');
		expect(output).toContain('Output:\n1 failed\n');
		await opened.store.undo();
		expect(read('src/__snapshots__/a.snap')).toBeUndefined();
		expect(read('src/b.ts')).toBe('export const b = 2;\n');
	});

	/** Prepares and runs `name` in `context`, returning its report and how it ended. */
	async function runIn(tool: PreparingTool, context: RunContext, name: string) {
		const prepared = await tool.prepare({ command: { name } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
		});
		expect(prepared.ending?.()).toBeUndefined();
		const report = await prepared.run(signal).catch((error: unknown) => (error as Error).message);
		return { report, ending: prepared.ending?.() };
	}

	// What the agent compares to tell a model whose changes never reach what a check reports.
	it('ends two runs that printed the same alike, however long each took', async () => {
		const opened = await open();
		// Slow and with a change the first time only: the report differs, the output does not.
		const tool = (await commandToolFor(opened, {
			test: shell('[ -f done ] || { touch done; sleep 0.3; }; echo "1 failed"; exit 1'),
			other: shell('echo "2 failed"; exit 1'),
			passing: shell('echo "1 failed"'),
		})) as PreparingTool;
		const context = new RunContext();

		const first = await runIn(tool, context, 'test');
		const second = await runIn(tool, context, 'test');
		const other = await runIn(tool, context, 'other');
		const passing = await runIn(tool, context, 'passing');
		await context.finish('completed');

		expect(first.report).not.toBe(second.report);
		expect(first.ending).toEqual({
			passed: false,
			how: 'exited with code 1',
			output: '1 failed\n',
			fingerprint: expect.any(String) as unknown,
			state: expect.any(String) as unknown,
			changed: ['done'],
		});
		expect(second.ending).toEqual(first.ending);
		expect(other.ending?.fingerprint).not.toBe(first.ending?.fingerprint);
		expect(passing.ending).toMatchObject({ passed: true, how: 'exited with code 0' });
	});

	it('leaves colors and the times of a known runner out, and keeps every other time', async () => {
		const opened = await open();
		const tool = (await commandToolFor(opened, {
			slow: shell(
				String.raw`printf '\033[32m✓\033[0m a.test.ts (3 tests) 1.32s\n   Duration  2.1s (setup 12ms)\nexpected 1s, received 2s\n'`,
			),
			fast: shell(
				String.raw`printf '\033[31m✓\033[0m a.test.ts (3 tests) 9ms\n   Duration  0.4 s (setup 9ms)\nexpected 1s, received 2s\n'`,
			),
			changed: shell(
				String.raw`printf '✓ a.test.ts (3 tests) 9ms\n   Duration  0.4 s (setup 9ms)\nexpected 1s, received 3s\n'`,
			),
		})) as PreparingTool;
		const context = new RunContext();

		const slow = await runIn(tool, context, 'slow');
		const fast = await runIn(tool, context, 'fast');
		const changed = await runIn(tool, context, 'changed');
		await context.finish('completed');

		expect(slow.ending?.output).toBe(
			'✓ a.test.ts (3 tests) 1.32s\n   Duration  2.1s (setup 12ms)\nexpected 1s, received 2s\n',
		);
		expect(fast.ending?.fingerprint).toBe(slow.ending?.fingerprint);
		expect(changed.ending?.fingerprint).not.toBe(fast.ending?.fingerprint);
	});

	it('tells apart two outputs whose kept ends are the same', async () => {
		const opened = await open();
		const end = 'x'.repeat(200);
		const tool = (await commandToolFor(opened, {
			first: shell(`echo "error in a.ts"; echo ${end}; exit 1`, { outputBytes: 100 }),
			second: shell(`echo "error in b.ts"; echo ${end}; exit 1`, { outputBytes: 100 }),
		})) as PreparingTool;
		const context = new RunContext();

		const first = await runIn(tool, context, 'first');
		const second = await runIn(tool, context, 'second');
		await context.finish('completed');

		expect(second.ending?.output).toBe(first.ending?.output);
		expect(second.ending?.fingerprint).not.toBe(first.ending?.fingerprint);
	});

	it("gives the state of the run's files, the same again once a change is undone", async () => {
		const opened = await open();
		const tool = (await commandToolFor(opened, {
			check: shell('true'),
			change: shell("printf 'export const a = 2;\\n' > src/a.ts"),
			undo: shell("printf 'export const a = 1 ;\\n' > src/a.ts"),
			ignored: shell('mkdir -p node_modules && echo x > node_modules/out.js'),
		})) as PreparingTool;
		const context = new RunContext();

		const before = await runIn(tool, context, 'check');
		await runIn(tool, context, 'change');
		const changed = await runIn(tool, context, 'check');
		await runIn(tool, context, 'undo');
		const undone = await runIn(tool, context, 'check');
		await runIn(tool, context, 'ignored');
		const ignored = await runIn(tool, context, 'check');
		await context.finish('completed');

		expect(changed.ending?.state).not.toBe(before.ending?.state);
		expect(undone.ending?.state).toBe(before.ending?.state);
		expect(undone.ending?.changed).toEqual(['src/a.ts', 'src/a.ts']);
		// What the history leaves out is not part of the state.
		expect(ignored.ending?.state).toBe(before.ending?.state);
	});

	it('has no state for a command that changed what the history cannot copy', async () => {
		const opened = await open();
		const tool = (await commandToolFor(opened, {
			swap: shell('rm src/b.ts && mkdir src/b.ts'),
		})) as PreparingTool;
		const context = new RunContext();

		const swap = await runIn(tool, context, 'swap');
		await context.finish('completed');

		expect(swap.ending).toBeDefined();
		expect(swap.ending?.state).toBeUndefined();
	});

	it('stops a run whose command fails with the same output five times, with no one to ask', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			test: shell('echo "1 failed"; exit 1'),
			lint: shell('echo "1 problem"; exit 1'),
		});
		const run = (name: string, id: string) =>
			assistantResponse([toolCall(id, 'runCommand', { command: { name } })]);
		const llmClient = new FakeLLMClient(
			...['1', '2', '3', '4', '5'].flatMap(id => [
				run('test', `test-${id}`),
				run('lint', `lint-${id}`),
			]),
			textResponse('never'),
		);

		await expect(
			new LLMAgent({ llmClient, tools: [tool], autoApprove: true }).run('prompt', { signal }),
		).rejects.toMatchObject({
			message: 'The LLM kept getting the same result from a command',
			cause:
				'"sh -c echo "1 failed"; exit 1" exited with code 1 with the same output 5 times. No file the history covers changed between them. No one could be asked whether to go on. The run is kept in the conversation.',
		});
		expect(llmClient.contexts).toHaveLength(9);
	});

	// The executor of a #22 run was stopped so, with every check it ran green.
	it('lets a check that passes run after every change, however many times', async () => {
		const opened = await open();
		const check = await commandToolFor(opened, { typecheck: shell('true') });
		const editor = fileToolsFor('anthropic', opened).find(
			tool => tool.name === 'str_replace_based_edit_tool',
		);
		if (!editor) throw new Error('Expected the text editor');
		const ids = ['1', '2', '3', '4', '5', '6'];
		// Claude's client, which declares the text editor.
		const llmClient = Object.assign(
			new FakeLLMClient(
				...ids.flatMap(id => [
					assistantResponse([
						toolCall(`check-${id}`, 'runCommand', { command: { name: 'typecheck' } }),
					]),
					assistantResponse([
						toolCall(`edit-${id}`, 'str_replace_based_edit_tool', {
							command: 'create',
							path: `src/c${id}.ts`,
							file_text: `export const c = ${id};\n`,
						}),
					]),
				]),
				textResponse('done'),
			),
			{ supportsNative: () => true },
		);
		const context = new RunContext();

		await expect(
			new LLMAgent({ llmClient, tools: [check, editor], autoApprove: true }).run(
				'prompt',
				withRunContext({ signal }, context),
			),
		).resolves.toMatchObject({ response: 'done' });
		await context.finish('completed');
		expect(read('src/c6.ts')).toBe('export const c = 6;\n');
	});

	it('returns a non-zero exit as an error result, narrated with its exit code and output', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			test: shell('echo "1 failed"; exit 1'),
		});
		const llmClient = new FakeLLMClient(
			assistantResponse([toolCall('call-1', 'runCommand', { command: { name: 'test' } })]),
			textResponse('done'),
		);
		const events: ProgressEvent[] = [];

		await new LLMAgent({ llmClient, tools: [tool], autoApprove: true }).run('run the tests', {
			signal,
			onProgress: event => events.push(event),
		});

		const result = llmClient.contexts[1]?.at(-1)?.content[0];
		expect(result?.type).toBe('toolResult');
		if (result?.type !== 'toolResult') throw new Error('Expected a tool result');
		expect(result.callId).toBe('call-1');
		expect(result.isError).toBe(true);
		expect(result.output).toContain('"test" exited with code 1');
		expect(result.output).toContain('Output:\n1 failed\n');
		const toolEvents = events.filter(
			(event): event is Extract<ProgressEvent, { type: 'tool' }> => event.type === 'tool',
		);
		expect(toolEvents).toHaveLength(2);
		expect(toolEvents[0]).toMatchObject({ status: 'in_progress', id: 'call-1' });
		expect(toolEvents[1]).toMatchObject({
			status: 'error',
			id: 'call-1',
			exitCode: 1,
			error: result.output,
		});
	});

	it('leaves out what .gitignore excludes and secrets the host did not open', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			build: shell('mkdir -p node_modules && echo x > node_modules/out.js; echo changed > .envrc'),
		});

		const { output, context } = await call(tool as PreparingTool, { command: { name: 'build' } });

		expect(output).toContain('It changed no file the history covers.');
		// Nothing it recorded may have changed a file, so the run is not in the history.
		expect(context.historyRun.runId).toBeUndefined();
		// The capture never copied the secret into the history.
		const stored = readdirSync(join(parent, 'state'), { recursive: true, withFileTypes: true })
			.filter(entry => entry.isFile())
			.map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
		expect(stored.some(content => content.includes('TOKEN=secret'))).toBe(false);
	});

	it('names only what the command made uncopyable, not a large file it left alone', async () => {
		// Sparse: over the size limit without writing 64 MB.
		write('big.bin', '');
		truncateSync(join(root, 'big.bin'), 65 * 1024 * 1024);
		const opened = await open();
		const tool = await commandToolFor(opened, {
			swap: shell('rm src/b.ts && mkdir src/b.ts'),
		});

		const { output = '' } = await call(tool as PreparingTool, { command: { name: 'swap' } });

		expect(output).toContain(
			'Not recorded, because the history cannot copy them (a folder, a link, or a file over 64 MB) before or after: src/b.ts. Undo leaves them as they are.',
		);
		expect(output).not.toContain('big.bin');
	});

	it('never undoes a file too large to capture as one the command created', async () => {
		// Sparse: over the size limit without writing 64 MB.
		write('big.bin', '');
		truncateSync(join(root, 'big.bin'), 65 * 1024 * 1024);
		const opened = await open();
		const tool = await commandToolFor(opened, { shrink: shell('echo small > big.bin') });

		const { output = '', context } = await call(tool as PreparingTool, {
			command: { name: 'shrink' },
		});

		expect(output).toContain('history cannot copy them (a folder, a link, or a file over 64 MB)');
		expect(output).toContain('before or after: big.bin.');
		// The run stays in the history, though it recorded no change it could take back.
		const runId = context.historyRun.runId ?? '';
		await expect(opened.store.readRun(runId)).resolves.toMatchObject({
			entries: [],
			unrecorded: [{ path: join(root, 'big.bin'), by: 'shrink' }],
		});
		await expect(showChanges(opened.store, runId)).resolves.toBe(
			'# big.bin: changed while the command "shrink" ran, into or from something the history cannot copy (a folder, a link, or a file over 64 MB); undo leaves it as it is',
		);

		await expect(opened.store.undo()).resolves.toMatchObject({
			complete: false,
			conflicts: [{ path: join(root, 'big.bin'), runId }],
		});
		expect(read('big.bin')).toBe('small\n');
		await expect(opened.store.redo()).resolves.toMatchObject({ complete: false });
		expect(read('big.bin')).toBe('small\n');
	});

	it('names a file too large to capture that the command deleted, and leaves it out of undo', async () => {
		write('big.bin', '');
		truncateSync(join(root, 'big.bin'), 65 * 1024 * 1024);
		const opened = await open();
		const tool = await commandToolFor(opened, { clean: shell('rm big.bin') });

		const { output = '' } = await call(tool as PreparingTool, { command: { name: 'clean' } });

		expect(output).toContain('before or after: big.bin.');
		await expect(opened.store.undo()).resolves.toMatchObject({ complete: false });
		expect(read('big.bin')).toBeUndefined();
	});

	it('gives the command no provider key, only the few variables it inherits and its own', async () => {
		vi.stubEnv('OPENAI_API_KEY', 'sk-test-not-a-real-key');
		vi.stubEnv('LC_ALL', 'C');
		const opened = await open();
		const tool = await commandToolFor(opened, {
			env: shell('env', { env: { CI: '1' }, outputBytes: 64 * 1024 }),
		});

		const { output = '' } = await call(tool as PreparingTool, { command: { name: 'env' } });

		expect(output).not.toContain('sk-test-not-a-real-key');
		expect(output).not.toContain('OPENAI_API_KEY');
		expect(output).toMatch(/^PATH=/m);
		expect(output).toMatch(/^LC_ALL=C$/m);
		expect(output).toMatch(/^CI=1$/m);
	});

	it('gives each path as the policy resolves it, relative to the command, never as a flag', async () => {
		write('src/-x.ts', 'export {};\n');
		const opened = await open();
		const tool = await commandToolFor(opened, {
			list: {
				description: 'Prints its arguments',
				executable: 'sh',
				args: [
					'-c',
					'printf "%s\\n" "$@"',
					'sh',
					{ type: 'paths', name: 'paths', description: 'Files' },
				],
				cwd: 'src',
			},
		});

		const { output } = await call(tool as PreparingTool, {
			command: { name: 'list', paths: ['src/a.ts', 'src/-x.ts', 'src'] },
		});

		expect(output).toContain('Output:\na.ts\n./-x.ts\n.\n');
	});

	it.each([
		['a secret', '.envrc', /may hold secrets/],
		['a path outside the workspace', '../outside.txt', /outside the workspace/],
	])('refuses %s as a path, before asking anyone', async (_, path, message) => {
		const opened = await open();
		const tool = (await commandToolFor(opened, {
			list: shell('true', {
				args: ['-c', 'true', { type: 'paths', name: 'paths', description: 'x' }],
			}),
		})) as PreparingTool;

		await expect(
			tool.prepare({ command: { name: 'list', paths: [path] } }, signal, {
				run: new RunContext(),
				reads: new ReadRegistry().begin(),
				callId: 'call',
				onProgress: () => undefined,
				spend: () => undefined,
			}),
		).rejects.toThrow(message);
	});

	it('shows the approver the program exactly as it will run, and never starts a denied one', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			mark: shell('echo ran > marker', {
				args: [
					'-c',
					'echo ran > marker',
					{ type: 'choice', name: 'mode', description: 'x', values: ['--fast'] },
				],
			}),
		});
		const requests: ApprovalRequest[] = [];
		const approve = vi.fn<Approver>(request => {
			requests.push(request);
			return { approved: false, reason: 'not now' };
		});
		const llmClient = new FakeLLMClient(
			assistantResponse([
				toolCall('call-1', 'runCommand', { command: { name: 'mark', mode: '--fast' } }),
			]),
			textResponse('done'),
		);

		await new LLMAgent({ llmClient, tools: [tool] }).run('prompt', {
			signal,
			approve,
		});

		expect(requests).toEqual([
			{
				tool: 'runCommand',
				input: { command: { name: 'mark', mode: '--fast' } },
				risk: 'destructive',
				command: { executable: 'sh', args: ['-c', 'echo ran > marker', '--fast'], cwd: root },
			},
		]);
		expect(read('marker')).toBeUndefined();
	});

	it('reports a timeout as a failure, never as a finished command, and keeps what it changed', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			slow: shell('echo half > src/a.ts; sleep 30', { timeoutMs: 300 }),
		});

		const { error, context } = await call(tool as PreparingTool, { command: { name: 'slow' } });

		expect((error as Error).message).toContain(
			'"slow" ran past its limit of 0.3 s and was stopped.',
		);
		expect((error as Error).message).toContain('src/a.ts');
		const { entries } = await opened.store.readRun(context.historyRun.runId ?? '');
		expect(entries).toMatchObject([{ path: join(root, 'src', 'a.ts'), observedBy: 'slow' }]);
	});

	it('ends a cancelled command as a cancellation, once what it changed is recorded', async () => {
		const opened = await open();
		const tool = (await commandToolFor(opened, {
			slow: shell('echo half > src/a.ts; echo started > started; sleep 30'),
		})) as PreparingTool;
		const controller = new AbortController();
		const context = new RunContext();
		const prepared = await tool.prepare({ command: { name: 'slow' } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
		});

		const running = prepared.run(controller.signal);
		while (read('started') === undefined) await new Promise(done => setTimeout(done, 10));
		controller.abort();

		await expect(running).rejects.toHaveProperty('name', 'AbortError');
		await context.finish('cancelled');
		const { entries } = await opened.store.readRun(context.historyRun.runId ?? '');
		expect(entries.map(entry => entry.path)).toContain(join(root, 'src', 'a.ts'));
	});

	it('does not run the command when the files cannot be captured first', async () => {
		const opened = await open();
		const tool = await createCommandTool({
			commands: { mark: shell('echo ran > marker') },
			policy: opened.policy,
			writes: opened.writes,
			covered: () => Promise.reject(new Error('listing failed')),
			base: opened.base,
		});

		const { error } = await call(tool, { command: { name: 'mark' } });

		expect(error).toBeInstanceOf(EditRefusedError);
		expect((error as Error).message).toBe(
			'The harness could not capture the files before "mark", so it did not run',
		);
		expect(read('marker')).toBeUndefined();
	});

	it('says a program that cannot start did not run, and leaves no run in the history', async () => {
		const opened = await open();
		const tool = await commandToolFor(opened, {
			missing: { description: 'x', executable: 'no-such-program-harness' },
		});

		const { error, context } = await call(tool as PreparingTool, { command: { name: 'missing' } });

		expect((error as Error).message).toBe('"missing" could not be started');
		expect(context.historyRun.runId).toBeUndefined();
	});

	it('stops writing for the run when a command cannot be confirmed stopped', async () => {
		const opened = await open();
		const tool = await createCommandTool({
			commands: { stuck: shell('true') },
			policy: opened.policy,
			writes: opened.writes,
			covered: opened.covered,
			base: opened.base,
			runProcess: async (...args) => {
				write('src/a.ts', 'changed by something still running\n');
				const result = await runCommandProcess(...args);
				return { ...result, outcome: 'timedOut', stopped: false };
			},
		});
		const context = new RunContext();
		const prepared = await tool.prepare({ command: { name: 'stuck' } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
		});
		const stopped = prepared.run(signal);

		await expect(stopped).rejects.toBeInstanceOf(EditUnconfirmedError);
		await expect(stopped).rejects.toThrow(/could not be stopped/);
		// Nothing more may be written in this run.
		await expect(opened.writes.sessionFor(context).journalForChange()).rejects.toThrow(
			/a command could not be stopped/,
		);
		await context.finish('failed');
	});
});

describe('createCommandTool', () => {
	it('refuses to run commands on Windows', async () => {
		const opened = await open();

		await expect(
			createCommandTool({
				commands: { test: shell('true') },
				policy: opened.policy,
				writes: opened.writes,
				covered: opened.covered,
				base: opened.base,
				platform: 'win32',
			}),
		).rejects.toBeInstanceOf(InvalidAgentConfigError);
	});

	it('refuses a working directory outside every write root', async () => {
		mkdirSync(join(parent, 'docs'));
		const opened = await openWorkspace(
			options([
				{ path: root, access: 'write' },
				{ path: join(parent, 'docs'), access: 'read' },
			]),
			{ warn: () => undefined },
		);

		await expect(
			commandToolFor(opened, { test: shell('true', { cwd: join(parent, 'docs') }) }),
		).rejects.toThrow('Command "test" needs a cwd inside a write root of the workspace');
	});
});
