import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// How long a group asked to stop gets before it is killed, and how long a kill gets to take.
const defaultGracePeriodMs = 5_000;
const killWaitMs = 5_000;
const pollMs = 25;
// Output still in the pipes once every process is gone arrives at once; a process that left
// the group and holds a pipe open must not hold up the result.
const drainMs = 1_000;

/**
 * How a command ended:
 * - `exited`: it ended by itself, with `exitCode`, or killed by `signal` from outside.
 * - `timedOut`: it ran past its time and was stopped.
 * - `cancelled`: the run was cancelled while it ran, and it was stopped.
 */
export interface CommandProcessResult {
	outcome: 'exited' | 'timedOut' | 'cancelled';
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** The end of what it printed, standard output and error together, as they arrived. */
	output: string;
	/** Everything it printed, of which `output` is the end. */
	printedBytes: number;
	durationMs: number;
	/**
	 * Every process of its group is gone. When false, something it started may still be
	 * changing files, so nothing observed after it can be taken as its final effect.
	 */
	stopped: boolean;
}

/**
 * Runs a configured command in a process group of its own, never through a shell, and returns
 * once that group is gone. A timeout or a cancellation stops the whole group: first asked with
 * `SIGTERM`, then killed. A command that ends by itself has whatever it left running in its
 * group stopped too, so nothing it started outlives it. A process that leaves the group, as a
 * daemon does, is out of reach; the docs say so.
 *
 * Only for POSIX: Windows has no process groups to stop.
 *
 * @throws {Error} when the program cannot be started, such as when it is not found; nothing ran.
 */
export function runCommandProcess(
	executable: string,
	args: string[],
	{
		cwd,
		env,
		timeoutMs,
		outputBytes,
		signal,
		gracePeriodMs = defaultGracePeriodMs,
	}: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
		outputBytes: number;
		signal: AbortSignal;
		/** How long the group gets to stop on `SIGTERM` before it is killed. Defaults to 5 s. */
		gracePeriodMs?: number;
	},
): Promise<CommandProcessResult> {
	// A rejection, not a throw: a caller awaiting the result must see it as one.
	if (signal.aborted) return Promise.reject(signal.reason as Error);
	const started = performance.now();

	return new Promise((resolve, reject) => {
		// `detached` makes it the leader of a new process group, whose id is its pid.
		const child = spawn(executable, args, {
			cwd,
			env,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const tail = new OutputTail(outputBytes);
		let outcome: CommandProcessResult['outcome'] = 'exited';
		let stopping: Promise<boolean> | undefined;
		let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

		const streamsClosed = Promise.all(
			[child.stdout, child.stderr].map(
				stream =>
					new Promise<void>(done =>
						stream.once('close', () => {
							done();
						}),
					),
			),
		);
		child.stdout.on('data', (chunk: Buffer) => {
			tail.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			tail.push(chunk);
		});

		let finished = false;
		const finish = async (stopped: boolean) => {
			if (finished) return;
			finished = true;
			await Promise.race([streamsClosed, delay(drainMs)]);
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({
				outcome,
				exitCode: exit?.code ?? null,
				signal: exit?.signal ?? null,
				output: tail.text(),
				printedBytes: tail.total,
				durationMs: Math.round(performance.now() - started),
				stopped,
			});
		};

		const stop = (why: 'timedOut' | 'cancelled') => {
			if (exit || child.pid === undefined) return;
			outcome = why;
			stopping ??= stopGroup(child.pid, gracePeriodMs);
			// A leader that outlives even the kill never exits, so the result cannot wait for it.
			void stopping.then(gone => {
				if (!gone) void finish(false);
			});
		};
		const timer = setTimeout(() => {
			stop('timedOut');
		}, timeoutMs);
		const onAbort = () => {
			stop('cancelled');
		};
		signal.addEventListener('abort', onAbort, { once: true });
		const detach = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
		};

		child.once('error', error => {
			// Only a program that never started: nothing here signals the child through Node.
			if (child.pid !== undefined) return;
			detach();
			reject(error);
		});
		child.once('exit', (code, exitSignal) => {
			exit = { code, signal: exitSignal };
			detach();
			const pid = child.pid;
			// What it left in its group is stopped as well; an empty group is gone at once.
			void (
				stopping ?? (pid === undefined ? Promise.resolve(true) : stopGroup(pid, gracePeriodMs))
			).then(finish);
		});
	});
}

/**
 * Stops every process in the group `pgid` and waits until none is left. Whether it is gone is
 * asked of the system, never assumed from a signal being sent.
 *
 * @returns whether the group is confirmed gone.
 */
async function stopGroup(pgid: number, gracePeriodMs: number): Promise<boolean> {
	if (!signalGroup(pgid, 'SIGTERM')) return true;
	if (await goneWithin(pgid, gracePeriodMs)) return true;
	if (!signalGroup(pgid, 'SIGKILL')) return true;
	return goneWithin(pgid, killWaitMs);
}

/** Sends `signal` to the group; false when the group no longer exists. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		// EPERM: a process of the group exists, but this one may not signal it.
		return true;
	}
}

async function goneWithin(pgid: number, ms: number): Promise<boolean> {
	const deadline = performance.now() + ms;
	while (performance.now() < deadline) {
		if (!signalGroup(pgid, 0)) return true;
		await delay(pollMs);
	}
	return !signalGroup(pgid, 0);
}

/** Keeps only the last `limit` bytes of what is pushed, and counts all of it. */
class OutputTail {
	private readonly limit: number;
	private chunks: Buffer[] = [];
	private kept = 0;
	total = 0;

	constructor(limit: number) {
		this.limit = limit;
	}

	push(chunk: Buffer): void {
		this.total += chunk.length;
		this.chunks.push(chunk);
		this.kept += chunk.length;
		while (this.chunks.length > 1 && this.kept - (this.chunks[0]?.length ?? 0) >= this.limit) {
			this.kept -= this.chunks.shift()?.length ?? 0;
		}
	}

	text(): string {
		const all = Buffer.concat(this.chunks);
		const cut = all.length > this.limit;
		const text = (cut ? all.subarray(all.length - this.limit) : all).toString('utf8');
		// A cut can land inside a character, which decodes as replacement characters.
		return cut ? text.replace(/^�+/u, '') : text;
	}
}
