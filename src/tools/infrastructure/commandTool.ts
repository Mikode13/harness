import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { CommandLine } from '#src/agent/domain/approval';
import type { RunContext } from '#src/agent/domain/runContext';
import type { Commit, RunJournal } from '#src/recovery/domain/recoveryStore';
import { displayPath } from '#src/recovery/domain/runChanges';
import { type BranchTip, commitsBetween, readTip } from '#src/recovery/infrastructure/gitCommits';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import type { ILogger } from '#src/shared/domain/logger';
import {
	classifyHostFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import {
	buildArguments,
	type CommandDefinition,
	type CommandParameter,
	type Commands,
	defaultCommandOutputBytes,
	defaultCommandTimeoutMs,
	type ParameterValue,
	parametersOf,
	validateCommands,
} from '../domain/commands.ts';
import { EditRefusedError, EditUnconfirmedError } from '../domain/fileEdits.ts';
import {
	type CommandEnding,
	RunEndingToolError,
	ToolExecutionError,
	type PreparingTool,
} from '../domain/preparedCall.ts';
import { CommandCheckpoint, type CoveredFiles } from './commandCheckpoint.ts';
import { OutputFingerprint, withoutColors } from './commandOutput.ts';
import { type CommandProcessResult, runCommandProcess } from './commandProcess.ts';
import { definePreparingTool } from './defineTool.ts';
import type { WorkspaceWrites } from './workspaceWrites.ts';
import type { WriteSession } from './writeSession.ts';

// Only what a toolchain needs to find itself and its locale. Everything else, the provider
// keys included, stays in this process.
const inheritedVariables = ['PATH', 'HOME', 'TMPDIR', 'USER', 'SHELL', 'LANG'];
// Never cancelled: once a command has run, the commits it made must reach the history.
const uncancelled = new AbortController().signal;
// Long enough for a slow disk, short enough not to hold up building an agent.
const cwdCheckMs = 10_000;

/** A command ready to run: its definition, and where it runs as a real path. */
interface ResolvedCommand {
	definition: CommandDefinition;
	cwd: string;
}

/**
 * `runCommand`, which runs one of the commands the consumer configured, by name, with the
 * parameters each one declares. Every call asks the approver, showing the program exactly as
 * it will run; `autoApprove` skips that.
 *
 * Around each command, the covered files are captured before and compared after, so what it
 * changed is in the run's history and can be undone: see `CommandCheckpoint`. If the capture
 * fails, the command does not run. A timeout or a cancellation stops its whole process group,
 * and is never reported as a completed command. If the group cannot be confirmed stopped, what
 * changed so far is recorded, the observation stays open, and writing stops for the run.
 *
 * This is not a sandbox: a command runs the repository's code, with everything this user can
 * reach. See "Configured commands are trusted, not sandboxed" in decisions.md.
 *
 * @throws {InvalidAgentConfigError} for an invalid configuration, a working directory outside
 * every `write` root, or on Windows, where a process group cannot be stopped.
 */
export async function createCommandTool({
	commands,
	policy,
	writes,
	covered,
	base,
	logger,
	platform = process.platform,
	runProcess = runCommandProcess,
}: {
	commands: Commands;
	policy: AccessPolicy;
	writes: WorkspaceWrites;
	covered: CoveredFiles;
	/** The real path of the first root, where a relative `cwd` starts. */
	base: string;
	/** Where a failure it absorbs is logged, such as git failing to list a command's commits. */
	logger: ILogger;
	platform?: NodeJS.Platform;
	/** Runs the program. Replaced in tests, to reach what a real process rarely does. */
	runProcess?: typeof runCommandProcess;
}): Promise<PreparingTool> {
	if (platform === 'win32') {
		throw new InvalidAgentConfigError(
			'Configured commands are not supported on Windows yet: the harness cannot stop a command and everything it started there',
		);
	}
	validateCommands(commands);
	const resolved = new Map<string, ResolvedCommand>();
	for (const [name, definition] of Object.entries(commands)) {
		resolved.set(name, {
			definition,
			cwd: await resolveCwd(`Command "${name}"`, definition.cwd, policy, base),
		});
	}

	return definePreparingTool({
		name: 'runCommand',
		description: describeTool(commands),
		input: inputSchema(commands),
		summarize: ({ command: { name, ...values } }) => {
			const definition = commands[name];
			// The schema only permits configured names, but keep this defensive for callers that
			// use a tool outside LLMAgent. This description never uses the resolved cwd.
			return definition ? visibleCommand(definition, values) : name;
		},
		prepare: async ({ command: { name, ...values } }, signal, call) => {
			const { run } = call;
			const command = resolved.get(name);
			// The schema allows only the configured names.
			if (!command) throw new Error(`There is no command named "${name}"`);
			// A command can change anything in the write roots.
			await writes.checkCeiling(call);
			const paramValues: Record<string, ParameterValue> = {};
			for (const parameter of parametersOf(command.definition)) {
				const value =
					(values as Record<string, ParameterValue | undefined>)[parameter.name] ?? null;
				paramValues[parameter.name] =
					parameter.type === 'paths' && Array.isArray(value)
						? await resolvePaths(value, command.cwd, policy, signal)
						: value;
			}
			const line: CommandLine = Object.freeze({
				executable: command.definition.executable,
				args: Object.freeze(buildArguments(command.definition, paramValues)) as string[],
				cwd: command.cwd,
			});

			// Now, so a set of tools that cannot join the run's writes is refused before the user is asked.
			writes.sessionFor(run);
			let ending: CommandEnding | undefined;
			return {
				// A command can change anything its user can: it is always asked about.
				risk: 'destructive',
				command: line,
				ending: () => ending,
				run: runSignal =>
					runCommand({
						name,
						line,
						definition: command.definition,
						context: run,
						signal: runSignal,
						ended: end => {
							ending = end;
						},
					}),
			};
		},
	});

	interface CommandRun {
		name: string;
		line: CommandLine;
		definition: CommandDefinition;
		context: RunContext;
		signal: AbortSignal;
		/** Told how the command ended, once it ran to an end and everything it changed is recorded. */
		ended: (ending: CommandEnding) => void;
	}

	// Alone: a change another agent of the run made while it ran would be taken for its own.
	function runCommand(run: CommandRun): Promise<string> {
		const session = writes.sessionFor(run.context);
		return session.exclusive(() => runCommandAlone(run, session), run.signal);
	}

	async function runCommandAlone(
		{ name, line, definition, signal, ended }: CommandRun,
		session: WriteSession,
	): Promise<string> {
		signal.throwIfAborted();
		const journal = await session.journalForChange();
		let checkpoint: CommandCheckpoint;
		try {
			checkpoint = await CommandCheckpoint.begin({ journal, covered, by: name, signal });
		} catch (error) {
			signal.throwIfAborted();
			throw new EditRefusedError(
				`The harness could not capture the files before "${name}", so it did not run`,
				{ cause: error },
			);
		}

		// Where its branch is right before it starts, after the files are captured, so the commits it
		// makes are the run's and none made meanwhile is. A cancellation here reaches the command,
		// which ends as cancelled once what it changed is recorded.
		let tip: BranchTip | undefined;
		let unreadTip: unknown;
		// Failures it carries on after, logged once what the command changed is recorded.
		const absorbed: string[] = [];
		try {
			tip = await readTip(line.cwd, signal);
		} catch (error) {
			if (!signal.aborted) {
				unreadTip = error;
				absorbed.push(
					`The harness could not read the branch before "${name}", so the history names none of its commits: ${describeFailure(error)}`,
				);
			}
		}
		let result: CommandProcessResult | undefined;
		let startFailure: unknown;
		const fingerprint = new OutputFingerprint();
		try {
			result = await runProcess(line.executable, line.args, {
				cwd: line.cwd,
				env: environmentFor(definition),
				timeoutMs: definition.timeoutMs ?? defaultCommandTimeoutMs,
				outputBytes: definition.outputBytes ?? defaultCommandOutputBytes,
				signal,
				onOutput: (stream, chunk) => {
					fingerprint.push(stream, chunk);
				},
			});
		} catch (error) {
			startFailure = error;
		}

		const complete = result?.stopped ?? true;
		// Before the files: a failure comparing them must not lose the commits, and with them a run
		// that changed nothing else.
		let commits: CommitsSeen = { made: [] };
		let unrecordedCommits: Error | undefined;
		if (result) {
			try {
				commits =
					unreadTip === undefined
						? await recordCommits({ name, tip, cwd: line.cwd, journal, session, absorbed })
						: { unknown: unreadTip };
			} catch (error) {
				unrecordedCommits = error instanceof Error ? error : new Error(String(error));
			}
		}
		let observed: Awaited<ReturnType<CommandCheckpoint['end']>>;
		try {
			observed = await checkpoint.end({ complete });
		} catch (error) {
			session.stop('Writing stopped: the harness could not record what a command changed');
			logAbsorbed(absorbed);
			throw new EditUnconfirmedError(
				`"${name}" ran, but the harness could not record what it changed; writing has stopped for this run`,
				{ cause: error },
			);
		}
		logAbsorbed(absorbed);

		if (unrecordedCommits !== undefined) throw unrecordedCommits;
		if (!result) {
			signal.throwIfAborted();
			throw new EditRefusedError(`"${name}" could not be started`, { cause: startFailure });
		}
		const report = describeRun(name, definition, result, observed, commits);
		if (!complete) {
			session.stop('Writing stopped: a command could not be stopped');
			throw new EditUnconfirmedError(
				`${report}\n"${name}" could not be stopped: something it started may still be changing files, and the history may not hold all of it. Writing has stopped for this run.`,
			);
		}
		// After its changes are recorded: a cancelled command is never reported as finished.
		if (result.outcome === 'cancelled') signal.throwIfAborted();
		ended({
			passed: result.outcome === 'exited' && result.exitCode === 0,
			how: howItEnded(result),
			output: withoutColors(result.output),
			fingerprint: fingerprint.digest(),
			...(observed.unrecorded.length === 0 ? { state: journal.contentState() } : {}),
			changed: journal.appliedPaths.map(path => displayPath(base, path)),
		});
		if (result.outcome !== 'exited') throw new ToolExecutionError(report);
		if (result.exitCode !== 0) {
			throw new ToolExecutionError(report, {
				...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
			});
		}
		return report;
	}

	/**
	 * Logs what a command absorbed, once what it changed is recorded. A logger that fails is a
	 * host failure, which ends the run.
	 */
	function logAbsorbed(messages: readonly string[]): void {
		try {
			for (const message of messages) {
				treatErrors(
					() => {
						logger.warn(message);
					},
					classifyHostFailure,
					'Command tool logger failed while reporting commits it could not read',
				);
			}
		} catch (error) {
			throw new RunEndingToolError(error);
		}
	}

	/**
	 * Records the commits the command made in the run's journal. One git could not list is told
	 * to the model and left out, since the command has run either way; a journal that could not
	 * record them stops writing, as for a change.
	 */
	async function recordCommits({
		name,
		tip,
		cwd,
		journal,
		session,
		absorbed,
	}: {
		name: string;
		tip: BranchTip | undefined;
		cwd: string;
		journal: RunJournal;
		session: WriteSession;
		absorbed: string[];
	}): Promise<CommitsSeen> {
		// Outside a repository, or with no branch checked out, no commit is the run's.
		if (tip?.branch === undefined) return { made: [] };
		let made: Commit[];
		try {
			const after = await readTip(cwd, uncancelled);
			made = after ? await commitsBetween(tip, after, uncancelled) : [];
		} catch (error) {
			absorbed.push(
				`The harness could not tell whether "${name}" made commits, so the history names none: ${describeFailure(error)}`,
			);
			return { unknown: error };
		}
		if (made.length === 0) return { made };
		try {
			await journal.committed({
				repository: tip.repository,
				branch: tip.branch,
				commits: made,
				by: name,
			});
		} catch (error) {
			session.stop('Writing stopped: the harness could not record the commits a command made');
			throw new EditUnconfirmedError(
				`"${name}" made commits, but the harness could not record them; writing has stopped for this run`,
				{ cause: error },
			);
		}
		return { made, branch: tip.branch };
	}

	function describeRun(
		name: string,
		definition: CommandDefinition,
		result: CommandProcessResult,
		{ changes, unrecorded }: Awaited<ReturnType<CommandCheckpoint['end']>>,
		commits: CommitsSeen,
	): string {
		const seconds = (result.durationMs / 1000).toFixed(1);
		const lines: string[] = [];
		if (result.outcome === 'timedOut') {
			const limit = (definition.timeoutMs ?? defaultCommandTimeoutMs) / 1000;
			lines.push(`"${name}" ran past its limit of ${String(limit)} s and was stopped.`);
		} else if (result.outcome === 'cancelled') {
			lines.push(`"${name}" was stopped: the run was cancelled.`);
		} else if (result.exitCode !== null) {
			lines.push(`"${name}" exited with code ${String(result.exitCode)} after ${seconds} s.`);
		} else {
			lines.push(`"${name}" was killed by ${result.signal ?? 'a signal'} after ${seconds} s.`);
		}

		const shown = (path: string) => displayPath(base, path);
		lines.push(
			changes.length === 0
				? 'It changed no file the history covers.'
				: `Files it changed, recorded in the history: ${changes.map(change => shown(change.path)).join(', ')}.`,
		);
		if (unrecorded.length > 0) {
			lines.push(
				`Not recorded, because the history cannot copy them (a folder, a link, or a file over 64 MB) before or after: ${unrecorded.map(shown).join(', ')}. Undo leaves them as they are.`,
			);
		}
		if ('unknown' in commits) {
			lines.push(
				`The harness could not tell whether it made commits, so the history does not name any: ${describeFailure(commits.unknown)}`,
			);
		} else if (commits.made.length > 0) {
			const listed = commits.made.map(({ sha, subject }) => `${sha.slice(0, 7)} ${subject}`);
			lines.push(
				`Commits it made on ${commits.branch ?? 'its branch'}, recorded in the history: ${listed.join('; ')}.`,
			);
		}

		const limit = definition.outputBytes ?? defaultCommandOutputBytes;
		if (result.printedBytes === 0) {
			lines.push('It printed nothing.');
		} else {
			lines.push(
				result.printedBytes > limit
					? `Output, the last ${kilobytes(limit)} of ${kilobytes(result.printedBytes)}:`
					: 'Output:',
				result.output,
			);
		}
		return lines.join('\n');
	}
}

/** The commits a command made, or why git could not tell. */
type CommitsSeen = { made: Commit[]; branch?: string } | { unknown: unknown };

function howItEnded(result: CommandProcessResult): string {
	if (result.outcome === 'timedOut') return 'ran past its time limit';
	if (result.outcome === 'cancelled') return 'was cancelled';
	if (result.exitCode !== null) return `exited with code ${String(result.exitCode)}`;
	return `was killed by ${result.signal ?? 'a signal'}`;
}

function kilobytes(bytes: number): string {
	return `${String(Math.ceil(bytes / 1024))} KB`;
}

/** The command line the model can see, before paths are resolved against the host workspace. */
function visibleCommand(
	definition: CommandDefinition,
	values: Record<string, ParameterValue | undefined>,
): string {
	const args: string[] = [];
	for (const argument of definition.args ?? []) {
		if (typeof argument === 'string') {
			args.push(argument);
			continue;
		}

		const value = values[argument.name] ?? null;
		if (argument.type === 'paths') {
			if (Array.isArray(value)) args.push(...value);
		} else if (value !== null && typeof value === 'string') {
			args.push(value);
		}
	}

	return [definition.executable, ...args].join(' ');
}

/**
 * Where a configured program runs, as a real path inside a `write` root. `program` names it in
 * the error, as `Command "test"`.
 */
export async function resolveCwd(
	program: string,
	cwd: string | undefined,
	policy: AccessPolicy,
	base: string,
): Promise<string> {
	const named = resolve(base, cwd ?? '.');
	let real: string;
	try {
		real = await realpath(named);
		await policy.check(real, 'write', AbortSignal.timeout(cwdCheckMs));
	} catch (error) {
		throw new InvalidAgentConfigError(
			`${program} needs a cwd inside a write root of the workspace`,
			{ cause: error },
		);
	}
	return real;
}

/**
 * Each path, once the policy lets the agent read it, relative to where the command runs. One
 * that would read as a flag is given as `./` and its name.
 */
async function resolvePaths(
	paths: string[],
	cwd: string,
	policy: AccessPolicy,
	signal: AbortSignal,
): Promise<string[]> {
	const resolved: string[] = [];
	for (const path of paths) {
		const { absolute } = await policy.check(path, 'read', signal);
		const fromCwd = relative(cwd, absolute) || '.';
		resolved.push(fromCwd.startsWith('-') && !isAbsolute(fromCwd) ? `./${fromCwd}` : fromCwd);
	}
	return resolved;
}

/** A small environment of its own: the inherited few, then what the consumer set. */
export function environmentFor(
	definition: Pick<CommandDefinition, 'env'>,
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const inherited: NodeJS.ProcessEnv = {};
	for (const [variable, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (inheritedVariables.includes(variable) || variable.startsWith('LC_')) {
			inherited[variable] = value;
		}
	}
	return { ...inherited, ...definition.env };
}

function describeTool(commands: Commands): string {
	const list = Object.entries(commands)
		.map(([name, { description }]) => `- ${name}: ${description}`)
		.join('\n');
	return [
		"Runs one of the project's configured commands, by name, such as its tests or its formatter.",
		'Files it changes are recorded in the history, so they can be undone. Its output is cut to its end.',
		'Commands:',
		list,
	].join('\n');
}

/**
 * One object per command, told apart by `name`, each with the parameters that command takes.
 * Strict mode needs every key present, so a parameter that may be left out takes `null`.
 */
function inputSchema(commands: Commands) {
	const variants = Object.entries(commands).map(([name, definition]) =>
		z.object({
			name: z.enum([name]),
			...Object.fromEntries(
				parametersOf(definition).map(parameter => [parameter.name, parameterSchema(parameter)]),
			),
		}),
	);
	const [first, ...rest] = variants;
	// `validateCommands` refuses an empty configuration.
	if (!first) throw new InvalidAgentConfigError('No command is configured');
	return z.object({
		command: (rest.length === 0 ? first : z.union([first, ...rest])).describe(
			'The command to run, and its parameters.',
		),
	});
}

function parameterSchema(parameter: CommandParameter): z.ZodType {
	switch (parameter.type) {
		case 'paths':
			return z
				.array(z.string())
				.describe(`${parameter.description} Paths inside the workspace; [] for none.`);
		case 'choice': {
			const values = z.enum(parameter.values as [string, ...string[]]);
			return parameter.required === true
				? values.describe(parameter.description)
				: values.nullable().describe(`${parameter.description} null to leave it out.`);
		}
		case 'text': {
			const text = z.string();
			const description = `${parameter.description} Must match the regular expression ${parameter.pattern}, and not start with "-".`;
			return parameter.required === true
				? text.describe(description)
				: text.nullable().describe(`${description} null to leave it out.`);
		}
	}
}
