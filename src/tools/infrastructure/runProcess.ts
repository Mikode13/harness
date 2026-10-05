import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// What a program may print, or one line of it may hold, before it is stopped. Beyond this it
// has printed far more than anyone can read.
const maxOutputBytes = 64 * 1024 * 1024;

export interface ProcessResult {
	/** Empty when the output went to `onLine` instead. */
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Runs a program with its arguments as an array, never through a shell, so nothing a model
 * writes can become a command. Standard input is closed: ripgrep given no path searches its
 * standard input whenever that is a pipe. A cancelled signal kills the process and rejects
 * with the signal's `AbortError`.
 *
 * With `onLine`, each line of the output is handed over as it arrives and nothing is kept, so
 * the caller decides what to hold; only a single line is then bound by the size limit. An
 * error thrown by `onLine` stops the program and rejects with that error.
 *
 * `env` replaces the environment the program inherits; without it, it gets this process's.
 */
export function runProcess(
	command: string,
	args: string[],
	{
		cwd,
		signal,
		onLine,
		env,
	}: {
		cwd: string;
		signal: AbortSignal;
		onLine?: (line: string) => void;
		env?: NodeJS.ProcessEnv;
	},
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, signal, env, stdio: ['ignore', 'pipe', 'pipe'] });
		const decoder = new StringDecoder('utf8');
		const stdout: string[] = [];
		const stderr: Buffer[] = [];
		let pending = '';
		let size = 0;
		let failure: Error | undefined;

		const stop = (error: Error) => {
			failure ??= error;
			child.kill();
		};

		const deliver = (text: string) => {
			if (!onLine) {
				stdout.push(text);
				return;
			}
			const lines = (pending + text).split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) onLine(line);
		};

		child.stdout.on('data', (chunk: Buffer) => {
			if (failure) {
				return;
			}
			size = onLine ? pending.length + chunk.length : size + chunk.length;
			if (size > maxOutputBytes) {
				stop(new Error(`The program printed more than ${String(maxOutputBytes / 1024 / 1024)} MB`));
				return;
			}
			try {
				deliver(decoder.write(chunk));
			} catch (error) {
				stop(error instanceof Error ? error : new Error(String(error)));
			}
		});
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

		// A missing program, or the cancellation, which arrives as an `AbortError`.
		child.on('error', reject);
		child.on('close', (code, killedBy) => {
			// Stopped from outside, such as by the out-of-memory killer: what it printed is not the
			// whole answer, and an exit code would pass it off as one. Its own stops set `failure`.
			if (code === null && !failure) {
				failure = new Error(
					`${command} was stopped by ${killedBy ?? 'a signal'} before it finished`,
				);
			}
			if (!failure) {
				try {
					deliver(decoder.end());
					if (onLine && pending !== '') onLine(pending);
				} catch (error) {
					failure = error instanceof Error ? error : new Error(String(error));
				}
			}
			if (failure) {
				reject(failure);
				return;
			}
			resolve({
				stdout: stdout.join(''),
				stderr: Buffer.concat(stderr).toString('utf8'),
				// Not null here: a process stopped by a signal was rejected above.
				exitCode: code ?? 1,
			});
		});
	});
}

/** The first line of a program's error output, which is the part a model can act on. */
export function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}
