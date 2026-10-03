import { spawn } from 'node:child_process';

// Beyond this a search matched far more than anyone can read; asking for a narrower one is
// better than holding the whole repository in memory.
const maxOutputBytes = 64 * 1024 * 1024;

export interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Runs a program with its arguments as an array, never through a shell, so nothing a model
 * writes can become a command. Standard input is closed: ripgrep given no path searches its
 * standard input whenever that is a pipe. A cancelled signal kills the process and rejects
 * with the signal's `AbortError`.
 */
export function runProcess(
	command: string,
	args: string[],
	{ cwd, signal }: { cwd: string; signal: AbortSignal },
): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let size = 0;
		let overflowed = false;

		child.stdout.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxOutputBytes) {
				overflowed = true;
				child.kill();
				return;
			}
			stdout.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

		// A missing program, or the cancellation, which arrives as an `AbortError`.
		child.on('error', reject);
		child.on('close', code => {
			if (overflowed) {
				reject(new Error('The result is too large to read; narrow the pattern, path or glob'));
				return;
			}
			resolve({
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
				exitCode: code ?? 1,
			});
		});
	});
}

/** The first line of a program's error output, which is the part a model can act on. */
export function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}
