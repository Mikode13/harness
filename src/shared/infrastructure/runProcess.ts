import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// What a program may print, or one line of it may hold, before it is stopped. Beyond this it
// has printed far more than anyone can read.
const maxOutputBytes = 64 * 1024 * 1024;
// What is kept of its error output. Callers read its first line; the rest is dropped, so a
// program that writes without end to it cannot fill this process's memory.
const maxErrorBytes = 1024 * 1024;

// On POSIX the program leads a process group of its own, so a stop reaches what it started too,
// such as the hooks git runs. Windows has no process groups.
const inOwnGroup = process.platform !== 'win32';

export interface ProcessResult {
	/** Empty when the output went to `onLine` instead. */
	stdout: string;
	/** Its first megabyte, and nothing past it. */
	stderr: string;
	exitCode: number;
}

/**
 * Runs a program with its arguments as an array, never through a shell, so nothing a model
 * writes can become a command. Standard input is closed: ripgrep given no path searches its
 * standard input whenever that is a pipe. A cancelled signal kills the process and rejects
 * with the signal's `AbortError`. On POSIX the program runs as the leader of its own process
 * group, and every stop, the cancellation included, signals the whole group, so nothing it
 * started outlives the stop. Only the first megabyte of its error output is kept.
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
		// The signal stays with `spawn`, which turns the cancellation into the `AbortError` callers
		// expect and kills the leader; `killGroup` reaches the rest of the group.
		const child = spawn(command, args, {
			cwd,
			signal,
			env,
			detached: inOwnGroup,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const decoder = new StringDecoder('utf8');
		const stdout: string[] = [];
		const stderr: Buffer[] = [];
		let stderrSize = 0;
		let pending = '';
		let size = 0;
		let failure: Error | undefined;

		const killGroup = () => {
			if (inOwnGroup && child.pid !== undefined) {
				try {
					process.kill(-child.pid, 'SIGTERM');
					return;
				} catch {
					// The group is gone, or this process may not signal it: the leader is all that is left.
				}
			}
			child.kill();
		};
		const onAbort = killGroup;
		if (signal.aborted) killGroup();
		else signal.addEventListener('abort', onAbort, { once: true });

		const stop = (error: Error) => {
			failure ??= error;
			killGroup();
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
		child.stderr.on('data', (chunk: Buffer) => {
			const kept = chunk.subarray(0, maxErrorBytes - stderrSize);
			stderrSize += kept.length;
			if (kept.length > 0) stderr.push(kept);
		});

		// A missing program, or the cancellation, which arrives as an `AbortError`.
		child.on('error', error => {
			// Not on the cancellation: `spawn`'s own listener raises it while the signal still
			// dispatches, and removing `onAbort` then would keep the rest of the group running.
			if (!signal.aborted) signal.removeEventListener('abort', onAbort);
			reject(error);
		});
		child.on('close', (code, killedBy) => {
			signal.removeEventListener('abort', onAbort);
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

// Only what a toolchain needs to find itself and its locale. Everything else, the provider
// keys included, stays in this process.
const inheritedVariables = ['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG'];
// What git needs to find its own configuration, to sign a commit, with gpg or ssh, and to name
// who made it, as a CI that sets no `user.name` names it.
const gitVariables = [
	'XDG_CONFIG_HOME',
	'SSH_AUTH_SOCK',
	'GPG_TTY',
	'GNUPGHOME',
	'GPG_AGENT_INFO',
	'GIT_AUTHOR_NAME',
	'GIT_AUTHOR_EMAIL',
	'GIT_COMMITTER_NAME',
	'GIT_COMMITTER_EMAIL',
	'EMAIL',
];

/** What a program of the repository's, such as a configured command, gets of `env`. */
export function inheritedEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return pick(env, variable => inheritedVariables.includes(variable) || variable.startsWith('LC_'));
}

/**
 * git's environment: a command's, since git runs the repository's own programs, its hooks,
 * filters, merge drivers, `core.fsmonitor` and `gpg.program`, and what git needs to find its
 * configuration, sign and name the commit's author. No other `GIT_*`: `GIT_DIR` or `GIT_WORK_TREE`
 * inherited from the host would make it answer about another repository.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...inheritedEnvironment(),
		...pick(process.env, variable => gitVariables.includes(variable)),
	};
}

function pick(env: NodeJS.ProcessEnv, wanted: (variable: string) => boolean): NodeJS.ProcessEnv {
	const picked: NodeJS.ProcessEnv = {};
	for (const [variable, value] of Object.entries(env)) {
		if (value !== undefined && wanted(variable)) picked[variable] = value;
	}
	return picked;
}
