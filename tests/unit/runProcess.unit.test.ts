import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { gitEnvironment, runProcess } from '../../src/shared/infrastructure/runProcess.ts';
import { isAlive } from '../support/processes.ts';

// Node itself is the one program every machine running these tests has.
const node = process.execPath;
const cwd = process.cwd();
const signal = new AbortController().signal;

describe('runProcess', () => {
	it('collects the output and the exit code', async () => {
		await expect(
			runProcess(node, ['-e', 'process.stdout.write("a\\nb"); process.exit(3)'], { cwd, signal }),
		).resolves.toMatchObject({ stdout: 'a\nb', exitCode: 3 });
	});

	it('hands over each line as it arrives, the last one too, and keeps nothing', async () => {
		const onLine = vi.fn();

		const result = await runProcess(node, ['-e', 'process.stdout.write("a\\nb\\nc")'], {
			cwd,
			signal,
			onLine,
		});

		expect(onLine.mock.calls).toEqual([['a'], ['b'], ['c']]);
		expect(result.stdout).toBe('');
	});

	// The caller's limit, such as the most matches a search may hold, must stop the program.
	it('stops the program and rejects with the error a line handler throws', async () => {
		const limit = new Error('too many lines');

		await expect(
			runProcess(node, ['-e', 'setInterval(() => console.log("x"), 1)'], {
				cwd,
				signal,
				onLine: () => {
					throw limit;
				},
			}),
		).rejects.toBe(limit);
	});

	// A model's argument must never become a command.
	it('gives the program the environment it is passed instead of its own', async () => {
		const { stdout } = await runProcess(
			node,
			['-e', 'process.stdout.write(`${process.env.ONLY ?? ""}|${process.env.HOME ?? ""}`)'],
			{ cwd, signal, env: { ONLY: 'yes' } },
		);

		expect(stdout).toBe('yes|');
	});

	it('passes every argument as it is, never through a shell', async () => {
		const { stdout } = await runProcess(
			node,
			['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); rm -rf /'],
			{ cwd, signal },
		);

		expect(stdout).toBe('$(echo injected); rm -rf /');
	});

	// Stopped from outside, a program has not said everything: its output must not pass for a result.
	it('rejects when the program is stopped by a signal it did not expect', async () => {
		await expect(
			runProcess(
				node,
				['-e', 'process.stdout.write("partial\\n"); process.kill(process.pid, "SIGKILL")'],
				{
					cwd,
					signal,
				},
			),
		).rejects.toThrow(/SIGKILL/);
	});

	it('kills the program and rejects with the cancellation', async () => {
		const controller = new AbortController();
		const pending = runProcess(node, ['-e', 'setInterval(() => {}, 1000)'], {
			cwd,
			signal: controller.signal,
		});
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('keeps the first megabyte of the error output and drops the rest, without failing', async () => {
		const { stderr, exitCode } = await runProcess(
			node,
			['-e', 'process.stderr.write("first line\\n" + "x".repeat(3 * 1024 * 1024))'],
			{ cwd, signal },
		);

		expect(exitCode).toBe(0);
		expect(stderr.startsWith('first line\n')).toBe(true);
		expect(stderr).toHaveLength(1024 * 1024);
	});

	// git runs the repository's hooks, which can start programs of their own.
	describe.skipIf(process.platform === 'win32')('what the program started', () => {
		/**
		 * Runs `sh`, which starts a `sleep` and writes its pid, then stops the run: by cancelling it,
		 * or through `onLine` when one is given.
		 */
		async function withGrandchild(
			onLine?: (line: string) => void,
		): Promise<{ failure: unknown; grandchild: number }> {
			const folder = realpathSync(mkdtempSync(join(tmpdir(), 'harness-process-')));
			try {
				const controller = new AbortController();
				const running = runProcess('sh', ['-c', 'sleep 30 & echo $! > child; echo started; wait'], {
					cwd: folder,
					signal: controller.signal,
					...(onLine ? { onLine } : {}),
				}).catch((error: unknown) => error);
				const grandchild = await pidIn(join(folder, 'child'));
				if (!onLine) controller.abort();
				const failure = await running;
				// Signalled, not reaped: give the system a moment.
				for (let attempt = 0; attempt < 100 && isAlive(grandchild); attempt++) await delay(20);
				return { failure, grandchild };
			} finally {
				rmSync(folder, { recursive: true, force: true });
			}
		}

		it('stops it too when the run is cancelled, rejecting with the cancellation', async () => {
			const { failure, grandchild } = await withGrandchild();

			expect(failure).toMatchObject({ name: 'AbortError' });
			expect(isAlive(grandchild)).toBe(false);
		});

		it('stops it too when a line handler fails', async () => {
			const limit = new Error('too many lines');
			const { failure, grandchild } = await withGrandchild(() => {
				throw limit;
			});

			expect(failure).toBe(limit);
			expect(isAlive(grandchild)).toBe(false);
		});
	});
});

/** The pid a script wrote to `path`, waiting for it to appear. */
async function pidIn(path: string): Promise<number> {
	for (;;) {
		try {
			const pid = Number(readFileSync(path, 'utf8'));
			if (pid > 0) return pid;
		} catch {
			// Not written yet.
		}
		await delay(10);
	}
}

describe('gitEnvironment', () => {
	it("gives git a command's variables, what signing needs and who commits, never a secret or another GIT_ variable", () => {
		vi.stubEnv('OPENAI_API_KEY', 'a secret');
		vi.stubEnv('GIT_DIR', '/elsewhere');
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');
		vi.stubEnv('LC_ALL', 'C');
		vi.stubEnv('GIT_AUTHOR_NAME', 'CI Bot');
		vi.stubEnv('EMAIL', 'ci@example.com');
		try {
			const env = gitEnvironment();

			expect(env).not.toHaveProperty('OPENAI_API_KEY');
			expect(env).not.toHaveProperty('GIT_DIR');
			expect(env).toMatchObject({
				SSH_AUTH_SOCK: '/tmp/agent.sock',
				LC_ALL: 'C',
				GIT_AUTHOR_NAME: 'CI Bot',
				EMAIL: 'ci@example.com',
			});
			expect(env.PATH).toBe(process.env.PATH);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
