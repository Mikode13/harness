import { isAbsolute, relative } from 'node:path';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import { describeFailure } from '#src/shared/domain/providerFailure';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import {
	defaultFormatterTimeoutMs,
	type Formatter,
	validateFormatter,
} from '../domain/commands.ts';
import { EditUnconfirmedError } from '../domain/fileEdits.ts';
import { CommandCheckpoint } from './commandCheckpoint.ts';
import { type CommandProcessResult, runCommandProcess } from './commandProcess.ts';
import { environmentFor, resolveCwd } from './commandTool.ts';
import type { WriteSession } from './writeSession.ts';

// What the model reads of a formatter that failed: enough for a syntax error, and short, since
// it comes with an edit.
const failureOutputBytes = 4 * 1024;
// How the history names what the formatter changed.
const observer = 'formatter';

/**
 * Runs the consumer's formatter on a file an edit has just written. Only that file is captured
 * around it, so what it changed there is in the run's history and can be undone; a formatter
 * that changes other files leaves those changes out of the history.
 */
export class FileFormatter {
	private readonly formatter: Formatter;
	private readonly cwd: string;
	private readonly runProcess: typeof runCommandProcess;

	private constructor(formatter: Formatter, cwd: string, runProcess: typeof runCommandProcess) {
		this.formatter = formatter;
		this.cwd = cwd;
		this.runProcess = runProcess;
	}

	/**
	 * @throws {InvalidAgentConfigError} for an invalid formatter, a working directory outside every
	 * `write` root, or on Windows, where a process group cannot be stopped.
	 */
	static async create({
		formatter,
		policy,
		base,
		platform = process.platform,
		runProcess = runCommandProcess,
	}: {
		formatter: Formatter;
		policy: AccessPolicy;
		/** The real path of the first root, where a relative `cwd` starts. */
		base: string;
		platform?: NodeJS.Platform;
		/** Runs the program. Replaced in tests, to reach what a real process rarely does. */
		runProcess?: typeof runCommandProcess;
	}): Promise<FileFormatter> {
		if (platform === 'win32') {
			throw new InvalidAgentConfigError(
				'A formatter is not supported on Windows yet: the harness cannot stop it and everything it started there',
			);
		}
		validateFormatter(formatter);
		const cwd = await resolveCwd('The formatter', formatter.cwd, policy, base);
		return new FileFormatter(formatter, cwd, runProcess);
	}

	/**
	 * Formats the file at `absolute` and records in `session` what it changed.
	 *
	 * @returns what the model needs to know when the file may not be formatted, or `undefined`
	 * once the formatter exited with 0.
	 * @throws {EditUnconfirmedError} when what it changed could not be recorded, or it could not be
	 * stopped. Writing stops for the run then, as after such a command.
	 */
	async format(
		absolute: string,
		session: WriteSession,
		signal: AbortSignal,
	): Promise<string | undefined> {
		signal.throwIfAborted();
		let checkpoint: CommandCheckpoint;
		try {
			const journal = await session.journalForChange();
			checkpoint = await CommandCheckpoint.begin({
				journal,
				covered: () => Promise.resolve([absolute]),
				by: observer,
				signal,
			});
		} catch (error) {
			signal.throwIfAborted();
			return `The formatter did not run, so the file is as you wrote it: ${describeFailure(error)}.`;
		}

		const { executable, args = [], timeoutMs = defaultFormatterTimeoutMs } = this.formatter;
		let result: CommandProcessResult | undefined;
		let startFailure: unknown;
		try {
			result = await this.runProcess(executable, [...args, this.argumentFor(absolute)], {
				cwd: this.cwd,
				env: environmentFor(this.formatter),
				timeoutMs,
				outputBytes: failureOutputBytes,
				signal,
			});
		} catch (error) {
			startFailure = error;
		}

		const complete = result?.stopped ?? true;
		try {
			await checkpoint.end({ complete });
		} catch (error) {
			session.stop('Writing stopped: the harness could not record what the formatter changed');
			throw new EditUnconfirmedError(
				'The formatter ran, but the harness could not record what it changed; writing has stopped for this run',
				{ cause: error },
			);
		}
		if (!complete) {
			session.stop('Writing stopped: the formatter could not be stopped');
			throw new EditUnconfirmedError(
				'The formatter could not be stopped: something it started may still be changing files, and the history may not hold all of it. Writing has stopped for this run.',
			);
		}

		if (!result) {
			signal.throwIfAborted();
			return `The formatter could not be started, so the file is as you wrote it: ${describeFailure(startFailure)}.`;
		}
		// After its changes are recorded: a cancelled formatter is never reported as finished.
		if (result.outcome === 'cancelled') signal.throwIfAborted();
		if (result.outcome === 'exited' && result.exitCode === 0) return undefined;
		const ending =
			result.outcome === 'timedOut'
				? `ran past its limit of ${String(timeoutMs / 1000)} s and was stopped`
				: result.exitCode !== null
					? `exited with code ${String(result.exitCode)}`
					: `was killed by ${result.signal ?? 'a signal'}`;
		const output = result.printedBytes === 0 ? '' : `\nIts output:\n${result.output}`;
		return `The formatter ${ending}, so the file may not be formatted.${output}`;
	}

	/** The file as the formatter's last argument: relative to where it runs, never read as a flag. */
	private argumentFor(absolute: string): string {
		const fromCwd = relative(this.cwd, absolute);
		return fromCwd.startsWith('-') && !isAbsolute(fromCwd) ? `./${fromCwd}` : fromCwd;
	}
}
