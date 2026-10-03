import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../../src/tools/infrastructure/runProcess.ts';

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
});
