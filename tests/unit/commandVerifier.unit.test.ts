import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions } from '../../src/agent/domain/agent.ts';
import { RunContext, withRunContext } from '../../src/agent/domain/runContext.ts';
import {
	assessCheck,
	type CheckRun,
	type RequiredCheck,
} from '../../src/orchestration/domain/model/verification.ts';
import {
	CommandVerifier,
	validateRequiredChecks,
} from '../../src/orchestration/infrastructure/model/commandVerifier.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';
import type { Commands } from '../../src/tools/domain/commands.ts';
import type { PreparingTool } from '../../src/tools/domain/preparedCall.ts';
import { ReadRegistry } from '../../src/tools/domain/readRegistry.ts';
import { commandToolFor, openWorkspace } from '../../src/tools/infrastructure/fileTools.ts';

const signal = new AbortController().signal;

let parent: string;
let root: string;

beforeEach(() => {
	parent = realpathSync(mkdtempSync(join(tmpdir(), 'harness-verifier-')));
	root = join(parent, 'repo');
	execFileSync('git', ['init', '--quiet', '--initial-branch=main', root]);
	writeFileSync(join(root, 'a.txt'), 'one\n');
});

afterEach(() => {
	rmSync(parent, { recursive: true, force: true });
});

/** A command that runs `script` in `sh`, and counts its runs in a file outside the workspace. */
function counted(name: string, script: string): Commands[string] {
	return {
		description: 'A test command',
		executable: 'sh',
		args: ['-c', `echo run >> "${join(parent, `${name}.count`)}"; ${script}`],
	};
}

function runs(name: string): number {
	try {
		return readFileSync(join(parent, `${name}.count`), 'utf8')
			.split('\n')
			.filter(Boolean).length;
	} catch {
		return 0;
	}
}

/** A run over the workspace with `commands`, its `runCommand` tool, and a verifier of `checks`. */
async function verifiedRun(commands: Commands, checks: RequiredCheck[]) {
	const opened = await openWorkspace(
		{ roots: [{ path: root, access: 'write' }], stateDirectory: join(parent, 'state') },
		{ warn: () => undefined },
	);
	const tool = (await commandToolFor(opened, commands)) as PreparingTool;
	const context = new RunContext({ id: 'test-session' });
	const options: RunOptions = withRunContext({ signal }, context);
	/** Runs a command as the model would, through the tool. */
	const run = async (name: string, values: Record<string, unknown> = {}) => {
		const call = await tool.prepare({ command: { name, ...values } }, signal, {
			run: context,
			reads: new ReadRegistry().begin(),
			callId: 'call',
			onProgress: () => undefined,
			spend: () => undefined,
			depth: 0,
		});
		await call.run(signal).catch(() => undefined);
	};
	const verifier = new CommandVerifier({ checks, commands, tool, writes: opened.writes });
	return { context, options, run, verifier, writes: opened.writes };
}

describe('a required check, against the runs of a task', () => {
	const line = { executable: 'pnpm', args: ['test'], cwd: '/repo' };
	const ran = (overrides: Partial<CheckRun> = {}): CheckRun => ({
		name: 'test',
		line,
		passed: true,
		how: 'exited with code 0',
		output: 'ok',
		state: 'one',
		...overrides,
	});

	it('is missing when it never ran', () => {
		expect(assessCheck('test', line, [], 'one')).toEqual({ command: 'test', status: 'missing' });
	});

	it('passed or failed by its last run, while the files are as it saw them', () => {
		expect(assessCheck('test', line, [ran({ passed: false }), ran()], 'one')).toMatchObject({
			status: 'passed',
		});
		expect(
			assessCheck('test', line, [ran(), ran({ passed: false, how: 'exited with code 1' })], 'one'),
		).toEqual({
			command: 'test',
			status: 'failed',
			how: 'exited with code 1',
			output: 'ok',
		});
	});

	it('is stale once the files the task changed hold something else', () => {
		expect(assessCheck('test', line, [ran()], 'two')).toMatchObject({ status: 'stale' });
	});

	it('counts only a run with the same program, arguments and folder', () => {
		const partial = ran({ line: { ...line, args: ['test', 'a.test.ts'] } });
		expect(assessCheck('test', line, [partial], 'one')).toMatchObject({ status: 'missing' });
		expect(
			assessCheck('test', line, [ran({ line: { ...line, cwd: '/other' } })], 'one'),
		).toMatchObject({
			status: 'missing',
		});
		expect(assessCheck('test', line, [ran({ name: 'lint' })], 'one')).toMatchObject({
			status: 'missing',
		});
	});

	it('is unknown when the history could not record what it, or a later command, changed', () => {
		expect(assessCheck('test', line, [ran({ state: undefined })], 'one')).toMatchObject({
			status: 'unknown',
		});
		const unrecorded = ran({ name: 'build', line: { ...line, args: ['build'] }, state: undefined });
		expect(assessCheck('test', line, [ran(), unrecorded], 'one')).toMatchObject({
			status: 'unknown',
		});
		expect(assessCheck('test', line, [ran()], undefined)).toMatchObject({ status: 'unknown' });
	});
});

describe('the command verifier', { timeout: 20_000 }, () => {
	it('runs a check that never ran, itself, and finds it passed', async () => {
		const { options, verifier } = await verifiedRun({ test: counted('test', 'exit 0') }, [
			{ command: 'test' },
		]);

		const result = await verifier.verify(options);

		expect(result).toEqual({
			met: true,
			checks: [{ command: 'test', status: 'passed', how: 'exited with code 0', output: '' }],
		});
		expect(runs('test')).toBe(1);
	});

	it('takes a passing run the task already made for the files as they are, without running it again', async () => {
		const { options, run, verifier } = await verifiedRun(
			{ edit: counted('edit', 'echo two > a.txt'), test: counted('test', 'exit 0') },
			[{ command: 'test' }],
		);
		await run('edit');
		await run('test');

		const result = await verifier.verify(options);

		expect(result.met).toBe(true);
		expect(runs('test')).toBe(1);
	});

	it('runs a check again once the task changed a file after it', async () => {
		const { options, run, verifier } = await verifiedRun(
			{ edit: counted('edit', 'echo two > a.txt'), test: counted('test', 'exit 0') },
			[{ command: 'test' }],
		);
		await run('test');
		await run('edit');

		const result = await verifier.verify(options);

		expect(result.met).toBe(true);
		expect(runs('test')).toBe(2);
	});

	it('keeps a check current when the task changes a file and puts it back', async () => {
		const { options, run, verifier } = await verifiedRun(
			{
				edit: counted('edit', 'echo two > a.txt'),
				back: counted('back', 'echo one > a.txt'),
				test: counted('test', 'exit 0'),
			},
			[{ command: 'test' }],
		);
		await run('edit');
		await run('test');
		await run('back');
		await run('edit');

		await verifier.verify(options);

		expect(runs('test')).toBe(1);
	});

	it('reports a check that failed for the files as they are, with its output, and does not run it again', async () => {
		const { options, run, verifier } = await verifiedRun(
			{ test: counted('test', 'echo "1 test failed"; exit 1') },
			[{ command: 'test' }],
		);
		await run('test');

		const result = await verifier.verify(options);

		expect(result).toEqual({
			met: false,
			checks: [
				{ command: 'test', status: 'failed', how: 'exited with code 1', output: '1 test failed\n' },
			],
		});
		expect(runs('test')).toBe(1);
	});

	it('does not count a run on some files for the whole check', async () => {
		const { options, run, verifier } = await verifiedRun(
			{
				test: {
					...counted('test', 'exit 0'),
					args: [
						...(counted('test', 'exit 0').args as string[]),
						{ type: 'paths', name: 'files', description: 'Files' },
					],
				},
			},
			[{ command: 'test' }],
		);
		await run('test', { files: ['a.txt'] });

		const result = await verifier.verify(options);

		expect(result.met).toBe(true);
		expect(runs('test')).toBe(2);
	});

	it('runs a check with the values the configuration gives it', async () => {
		const { options, run, verifier } = await verifiedRun(
			{
				test: {
					...counted('test', 'exit 0'),
					args: [
						...(counted('test', 'exit 0').args as string[]),
						{ type: 'choice', name: 'suite', description: 'Which suite', values: ['unit', 'e2e'] },
					],
				},
			},
			[{ command: 'test', values: { suite: 'unit' } }],
		);
		await run('test', { suite: 'e2e' });
		await verifier.verify(options);
		expect(runs('test')).toBe(2);

		await run('test', { suite: 'unit' });
		await verifier.verify(options);
		expect(runs('test')).toBe(3);
	});

	it('reports a check stale when a later check changed the files it saw', async () => {
		const { options, verifier } = await verifiedRun(
			{ lint: counted('lint', 'exit 0'), snapshot: counted('snapshot', 'echo new > a.txt') },
			[{ command: 'lint' }, { command: 'snapshot' }],
		);

		const result = await verifier.verify(options);

		expect(result.met).toBe(false);
		expect(result.checks.map(({ command, status }) => `${command} ${status}`)).toEqual([
			'lint stale',
			'snapshot passed',
		]);
	});

	it('reports a check missing, with why, when the run may write no more', async () => {
		const { context, options, verifier, writes } = await verifiedRun(
			{ test: counted('test', 'exit 0') },
			[{ command: 'test' }],
		);
		writes.sessionFor(context).stop('Writing stopped for a test');

		const result = await verifier.verify(options);

		expect(result).toEqual({
			met: false,
			checks: [
				{ command: 'test', status: 'missing', how: 'could not run: Writing stopped for a test' },
			],
		});
		expect(runs('test')).toBe(0);
	});

	it('reports a check that passed unknown, with why, once the run may write no more', async () => {
		const { context, options, run, verifier, writes } = await verifiedRun(
			{ test: counted('test', 'exit 0') },
			[{ command: 'test' }],
		);
		await run('test');
		// As when the harness could not record what a later command changed.
		writes.sessionFor(context).stop('Writing stopped for a test');

		const result = await verifier.verify(options);

		expect(result).toEqual({
			met: false,
			checks: [
				{ command: 'test', status: 'unknown', how: 'could not run: Writing stopped for a test' },
			],
		});
		expect(runs('test')).toBe(1);
	});

	it('propagates a cancellation when every check already has its evidence', async () => {
		const { context, run, verifier } = await verifiedRun({ test: counted('test', 'exit 0') }, [
			{ command: 'test' },
		]);
		await run('test');
		const controller = new AbortController();
		controller.abort();

		await expect(
			verifier.verify(withRunContext({ signal: controller.signal }, context)),
		).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }) as Error);
	});

	it('propagates a cancellation', async () => {
		const { context, verifier } = await verifiedRun({ test: counted('test', 'exit 0') }, [
			{ command: 'test' },
		]);
		const controller = new AbortController();
		controller.abort();

		await expect(
			verifier.verify(withRunContext({ signal: controller.signal }, context)),
		).rejects.toThrow(expect.objectContaining({ name: 'AbortError' }) as Error);
	});
});

describe('the required checks a configuration names', () => {
	const commands: Commands = {
		test: {
			description: 'Tests',
			executable: 'pnpm',
			args: [
				'test',
				{ type: 'choice', name: 'suite', description: 'Suite', values: ['unit', 'e2e'] },
				{
					type: 'text',
					name: 'project',
					description: 'Project',
					pattern: '[a-z]+',
					required: true,
				},
				{ type: 'paths', name: 'files', description: 'Files' },
			],
		},
	};

	it.each<[unknown, string]>([
		[[{ command: 'format' }], 'The required check "format" is not a configured command'],
		[[{ command: 'constructor' }], 'The required check "constructor" is not a configured command'],
		[[{ command: 'toString' }], 'The required check "toString" is not a configured command'],
		[{ command: 'test' }, 'The required checks must be a list'],
		[['test'], 'A required check must be an object'],
		[[{ command: 7 }], 'A required check needs the name of a command'],
		[
			[{ command: 'test', values: ['core'] }],
			'The required check "test" needs its values by parameter name',
		],
		[
			[{ command: 'test', values: { project: 'core', files: [123] } }],
			'The required check "test" gives "files" something other than a list of paths',
		],
		[
			[{ command: 'test', values: { project: 'core', files: 'a.ts' } }],
			'The required check "test" gives "files" something other than a list of paths',
		],
		[
			[{ command: 'test', values: { project: ['core'] } }],
			'The required check "test" gives "project" something other than one value',
		],
		[
			[{ command: 'test', values: { project: 'core', reporter: 'dot' } }],
			'The required check "test" gives values for what is not a parameter of it: reporter',
		],
		[[{ command: 'test' }], 'The required check "test": "project" is required'],
		[
			[{ command: 'test', values: { project: 'core', suite: 'all' } }],
			'The required check "test": "suite" takes one of: unit, e2e',
		],
		[
			[
				{ command: 'test', values: { project: 'core' } },
				{ command: 'test', values: { project: 'core' } },
			],
			'The required check "test" is listed twice',
		],
	])('refuses %j', (checks, message) => {
		expect(() => {
			// As a JSON configuration may hold them, whatever the type says.
			validateRequiredChecks(checks as RequiredCheck[], commands);
		}).toThrow(new InvalidAgentConfigError(message));
	});

	it('takes checks with the values each needs', () => {
		expect(() => {
			validateRequiredChecks(
				[
					{ command: 'test', values: { project: 'core' } },
					{ command: 'test', values: { project: 'core', suite: 'e2e' } },
					{ command: 'test', values: { project: 'core', files: ['a.ts'] } },
				],
				commands,
			);
		}).not.toThrow();
	});
});
