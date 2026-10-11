import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandProcess } from '../../src/tools/infrastructure/commandProcess.ts';

let folder: string;

beforeEach(() => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), 'harness-command-')));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

const signal = new AbortController().signal;
const env = { PATH: process.env.PATH ?? '' };

function run(
	script: string,
	options: { timeoutMs?: number; outputBytes?: number; signal?: AbortSignal } = {},
) {
	return runCommandProcess('sh', ['-c', script], {
		cwd: folder,
		env,
		timeoutMs: options.timeoutMs ?? 10_000,
		outputBytes: options.outputBytes ?? 1024,
		signal: options.signal ?? signal,
		gracePeriodMs: 200,
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The pid a script wrote to `name`, waiting for it to appear. */
async function pidIn(name: string): Promise<number> {
	for (;;) {
		try {
			const pid = Number(readFileSync(join(folder, name), 'utf8'));
			if (pid > 0) return pid;
		} catch {
			// Not written yet.
		}
		await delay(10);
	}
}

describe('runCommandProcess', () => {
	it('returns the exit code and what the command printed, both streams in order', async () => {
		const result = await run('echo out; echo err >&2; exit 3');

		expect(result).toMatchObject({
			outcome: 'exited',
			exitCode: 3,
			signal: null,
			output: 'out\nerr\n',
			printedBytes: 8,
			stopped: true,
		});
	});

	it('runs in its working directory with only the environment it is given', async () => {
		process.env.HARNESS_TEST_PROVIDER_KEY = 'must-not-leak';
		try {
			const result = await run('pwd; env', { outputBytes: 64 * 1024 });

			expect(result.output.split('\n')[0]).toBe(folder);
			expect(result.output).not.toContain('must-not-leak');
		} finally {
			delete process.env.HARNESS_TEST_PROVIDER_KEY;
		}
	});

	it('keeps the end of a long output, and counts all of it', async () => {
		// awk buffers its output, so it arrives in a few large chunks, not one per line.
		const result = await run(`awk 'BEGIN { for (i = 0; i < 2000; i++) printf "line %d\\n", i }'`, {
			outputBytes: 100,
		});

		expect(result.printedBytes).toBeGreaterThan(10_000);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(100);
		expect(result.output.endsWith('line 1999\n')).toBe(true);
	});

	it('stops the whole group when it runs past its time, and says so', async () => {
		const started = Date.now();
		const result = await run('sleep 30 & echo $! > child; wait', { timeoutMs: 300 });

		expect(result).toMatchObject({ outcome: 'timedOut', stopped: true });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(isAlive(await pidIn('child'))).toBe(false);
	});

	it('stops the whole group when the run is cancelled', async () => {
		const controller = new AbortController();
		const running = run('sleep 30 & echo $! > child; wait', { signal: controller.signal });
		const child = await pidIn('child');

		controller.abort();
		const result = await running;

		expect(result).toMatchObject({ outcome: 'cancelled', stopped: true });
		expect(isAlive(child)).toBe(false);
	});

	it('kills a group that ignores the request to stop', async () => {
		const result = await run("trap '' TERM; echo $$ > leader; while :; do sleep 0.05; done", {
			timeoutMs: 300,
		});

		expect(result).toMatchObject({ outcome: 'timedOut', stopped: true });
		expect(isAlive(await pidIn('leader'))).toBe(false);
	});

	it('stops what a command left running in its group once it ends', async () => {
		const result = await run('sleep 30 > /dev/null 2>&1 & echo $! > child; exit 0');

		expect(result).toMatchObject({ outcome: 'exited', exitCode: 0, stopped: true });
		expect(isAlive(await pidIn('child'))).toBe(false);
	});

	it('kills a command still running when this process exits', async () => {
		const runner = join(folder, 'runner.ts');
		const module = resolve('src/tools/infrastructure/commandProcess.ts');
		writeFileSync(
			runner,
			[
				`import { runCommandProcess } from ${JSON.stringify(module)};`,
				`void runCommandProcess('sh', ['-c', 'sleep 30 & echo $! > child; wait'], { cwd: ${JSON.stringify(folder)}, env: { PATH: process.env.PATH }, timeoutMs: 60000, outputBytes: 100, signal: new AbortController().signal });`,
				// Exits as an uncaught failure would, with the command still running.
				`setTimeout(() => process.exit(1), 300);`,
			].join('\n'),
		);

		await promisify(execFile)(process.execPath, ['--experimental-strip-types', runner]).catch(
			() => undefined,
		);

		const child = await pidIn('child');
		// Killed on the way out: give the system a moment to reap it.
		for (let attempt = 0; attempt < 50 && isAlive(child); attempt++) await delay(20);
		expect(isAlive(child)).toBe(false);
	});

	it('rejects, having run nothing, when the program does not exist', async () => {
		await expect(
			runCommandProcess('no-such-program-harness', [], {
				cwd: folder,
				env,
				timeoutMs: 1000,
				outputBytes: 100,
				signal,
			}),
		).rejects.toHaveProperty('code', 'ENOENT');
	});

	it('starts nothing when the run is already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(run('echo ran > ran', { signal: controller.signal })).rejects.toHaveProperty(
			'name',
			'AbortError',
		);
		expect(() => readFileSync(join(folder, 'ran'))).toThrow();
	});
});
