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
import { RunContext } from '../../src/agent/domain/runContext.ts';
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

		const { output } = await call(tool as PreparingTool, { command: { name: 'test' } });

		expect(output).toContain('"test" exited with code 1');
		expect(output).toContain('src/__snapshots__/a.snap');
		expect(output).toContain('src/b.ts');
		expect(output).toContain('Output:\n1 failed\n');
		await opened.store.undo();
		expect(read('src/__snapshots__/a.snap')).toBeUndefined();
		expect(read('src/b.ts')).toBe('export const b = 2;\n');
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
			'Not recorded, because the history cannot copy them (a folder, a link, or a file over 64 MB): src/b.ts.',
		);
		expect(output).not.toContain('big.bin');
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
