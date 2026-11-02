import type { RunOptions } from '#src/agent/domain/agent';
import type { CommandLine } from '#src/agent/domain/approval';
import { delegationOf, runContextOf, type RunContext } from '#src/agent/domain/runContext';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import {
	buildArguments,
	type CommandDefinition,
	type Commands,
	type ParameterValue,
	parametersOf,
} from '#src/tools/domain/commands';
import { EditRefusedError } from '#src/tools/domain/fileEdits';
import {
	ToolExecutionError,
	type PreparedCall,
	type PreparingTool,
} from '#src/tools/domain/preparedCall';
import { ReadRegistry } from '#src/tools/domain/readRegistry';
import type { WorkspaceWrites } from '#src/tools/infrastructure/workspaceWrites';
import type { RecordedCommand, WriteSession } from '#src/tools/infrastructure/writeSession';
import {
	assessCheck,
	type CheckResult,
	type CheckRun,
	type RequiredCheck,
	type Verification,
	type Verifier,
	verification,
} from '../../domain/model/verification.ts';

/**
 * Checks `checks` against `commands` before an agent is built, so a mistake in the configuration
 * fails there and never in the middle of a run: each names a configured command, gives only
 * values for its parameters, of the right kind, and every one it requires. Paths are checked
 * where the check runs, as the model's are.
 *
 * @throws {InvalidAgentConfigError} for the first thing that is wrong.
 */
export function validateRequiredChecks(checks: readonly RequiredCheck[], commands: Commands): void {
	// Unknown throughout, as `validateCommands`: the configuration may come from a JSON file.
	if (!Array.isArray(checks)) {
		throw new InvalidAgentConfigError('The required checks must be a list');
	}
	const seen = new Set<string>();
	for (const check of checks as unknown[]) {
		if (typeof check !== 'object' || check === null) {
			throw new InvalidAgentConfigError('A required check must be an object');
		}
		const { command, values = {} } = check as Record<string, unknown>;
		if (typeof command !== 'string') {
			throw new InvalidAgentConfigError('A required check needs the name of a command');
		}
		// Own entries only: an inherited name such as "constructor" is no configured command.
		const definition = Object.hasOwn(commands, command) ? commands[command] : undefined;
		if (!definition) {
			throw new InvalidAgentConfigError(
				`The required check "${command}" is not a configured command`,
			);
		}
		const fail = (problem: string) => {
			throw new InvalidAgentConfigError(`The required check "${command}" ${problem}`);
		};
		if (typeof values !== 'object' || values === null || Array.isArray(values)) {
			fail('needs its values by parameter name');
		}
		const parameters = new Map(parametersOf(definition).map(p => [p.name, p]));
		const entries = Object.entries(values as Record<string, unknown>);
		const unknown = entries.filter(([name]) => !parameters.has(name)).map(([name]) => name);
		if (unknown.length > 0) {
			fail(`gives values for what is not a parameter of it: ${unknown.join(', ')}`);
		}
		for (const [name, value] of entries) {
			if (parameters.get(name)?.type === 'paths') {
				if (!Array.isArray(value) || !value.every(path => typeof path === 'string')) {
					fail(`gives "${name}" something other than a list of paths`);
				}
				// What no workspace accepts; whether the rest are inside it is checked where it runs.
				if ((value as string[]).some(path => path === '' || path.includes('\0'))) {
					fail(`gives "${name}" a path that is empty or holds a NUL character`);
				}
			} else if (typeof value !== 'string') {
				fail(`gives "${name}" something other than one value`);
			}
		}
		const given = valuesFor(
			definition,
			values as Readonly<Record<string, string | readonly string[]>>,
		);
		try {
			buildArguments(definition, given);
		} catch (error) {
			throw new InvalidAgentConfigError(
				`The required check "${command}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const key = JSON.stringify([command, given]);
		if (seen.has(key)) {
			throw new InvalidAgentConfigError(`The required check "${command}" is listed twice`);
		}
		seen.add(key);
	}
}

/**
 * Verifies a run's required checks with the runs of its configured commands, through the
 * `runCommand` tool, so a check the harness runs is captured, recorded and attributed as one the
 * model runs. The consumer declared each check, so running it asks nobody.
 */
export class CommandVerifier implements Verifier {
	private readonly checks: readonly RequiredCheck[];
	private readonly commands: Commands;
	private readonly tool: PreparingTool;
	private readonly writes: WorkspaceWrites;

	constructor({
		checks,
		commands,
		tool,
		writes,
	}: {
		checks: readonly RequiredCheck[];
		/** The commands `tool` runs, which every check names. */
		commands: Commands;
		/** The `runCommand` tool over `commands`, writing through `writes`. */
		tool: PreparingTool;
		writes: WorkspaceWrites;
	}) {
		validateRequiredChecks(checks, commands);
		this.checks = checks;
		this.commands = commands;
		this.tool = tool;
		this.writes = writes;
	}

	async verify(options: RunOptions): Promise<Verification> {
		const context = runContextOf(options);
		if (!context) throw new Error('A run is verified inside its own context');
		const session = this.writes.sessionFor(context);
		const { signal } = options;
		const delegation = delegationOf(options);
		// Checked here and before the answer too: a verification that runs nothing reaches no other
		// point that notices a cancellation.
		signal.throwIfAborted();

		const prepared: { check: RequiredCheck; call: PreparedCall; line: CommandLine }[] = [];
		for (const check of this.checks) {
			const definition = this.commands[check.command];
			// The constructor validated every check against the commands.
			if (!definition) throw new Error(`"${check.command}" is not a configured command`);
			const call = await this.tool.prepare(
				{ command: { name: check.command, ...valuesFor(definition, check.values ?? {}) } },
				signal,
				callContext(context, check.command, delegation?.depth ?? 0),
			);
			// The tool always says what it runs; a tool that does not is not `runCommand`.
			if (!call.command) throw new Error(`"${check.command}" did not prepare a command`);
			prepared.push({ check, call, line: call.command });
		}

		const refused = new Map<RequiredCheck, string>();
		for (const { check, call, line } of prepared) {
			const { status } = assessCheck(
				check.command,
				line,
				checkRuns(session),
				await session.contentState(),
			);
			if (status === 'passed' || status === 'failed') continue;
			try {
				// Here, not in `prepare`, which only says what the check runs: a run another agent
				// delegated to never writes beyond its caller's limit, a check included.
				await this.writes.checkCeiling(
					delegation?.writeCeiling ? { writeCeiling: delegation.writeCeiling } : {},
				);
				await call.run(signal);
			} catch (error) {
				// A check that ran and did not pass is evidence, recorded with how it ended.
				if (error instanceof ToolExecutionError) continue;
				// One the harness may not run, such as when the run may write no more, keeps its status.
				if (error instanceof EditRefusedError) {
					refused.set(check, `could not run: ${error.message}`);
					continue;
				}
				throw error;
			}
		}

		// Again for every check: running one may have changed what another checked.
		const runs = checkRuns(session);
		const current = await session.contentState();
		signal.throwIfAborted();
		const results: CheckResult[] = prepared.map(({ check, line }) => {
			const result = assessCheck(check.command, line, runs, current);
			// Why it could not run now says more than how its last run ended; what that printed stays.
			const why = refused.get(check);
			return why === undefined ? result : { ...result, how: why };
		});
		return verification(results);
	}
}

/** The values a check runs `definition` with: every parameter it leaves out, not given. */
function valuesFor(
	definition: CommandDefinition,
	values: Readonly<Record<string, string | readonly string[]>>,
): Record<string, ParameterValue> {
	const given: Record<string, ParameterValue> = {};
	for (const parameter of parametersOf(definition)) {
		// Own values only: a parameter may be named as something every object inherits.
		const value = Object.hasOwn(values, parameter.name) ? values[parameter.name] : undefined;
		given[parameter.name] =
			value === undefined
				? parameter.type === 'paths'
					? []
					: null
				: typeof value === 'string'
					? value
					: [...value];
	}
	return given;
}

function checkRuns(session: WriteSession): CheckRun[] {
	return session.commandsRun.map(({ name, line, ending }: RecordedCommand) => ({
		name,
		line,
		passed: ending.passed,
		how: ending.how,
		output: ending.output,
		...(ending.state === undefined ? {} : { state: ending.state }),
	}));
}

function callContext(run: RunContext, command: string, depth: number) {
	return {
		run,
		reads: new ReadRegistry().begin(),
		callId: `check-${command}`,
		onProgress: () => undefined,
		spend: () => undefined,
		depth,
	};
}
