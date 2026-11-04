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
import { EditRefusedError, EditUnconfirmedError } from '#src/tools/domain/fileEdits';
import {
	ToolExecutionError,
	type PreparedCall,
	type PreparingTool,
} from '#src/tools/domain/preparedCall';
import { ReadRegistry } from '#src/tools/domain/readRegistry';
import type { WorkspaceWrites } from '#src/tools/infrastructure/workspaceWrites';
import type { RecordedCommand, WriteSession } from '#src/tools/infrastructure/writeSession';
import type { CheckResult, Verification } from '#src/agent/domain/phaseResult';
import {
	assessCheck,
	type CheckRun,
	type RequiredCheck,
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
 * How many times the harness goes through the checks in one verification: the first runs what
 * is missing, stale or unknown, and each later one what the harness's own runs made stale, so
 * checks that change files settle.
 */
const checkPasses = 3;

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

		const prepare = async (check: RequiredCheck): Promise<PreparedCall> => {
			const definition = this.commands[check.command];
			// The constructor validated every check against the commands.
			if (!definition) throw new Error(`"${check.command}" is not a configured command`);
			return this.tool.prepare(
				{ command: { name: check.command, ...valuesFor(definition, check.values ?? {}) } },
				signal,
				callContext(context, check.command, delegation?.depth ?? 0),
			);
		};
		const prepared: { check: RequiredCheck; call?: PreparedCall; line: CommandLine }[] = [];
		for (const check of this.checks) {
			const call = await prepare(check);
			// The tool always says what it runs; a tool that does not is not `runCommand`.
			if (!call.command) throw new Error(`"${check.command}" did not prepare a command`);
			prepared.push({ check, call, line: call.command });
		}

		// Once every write of the run in progress has ended, so a command still running is never read
		// through: what it changed is only known once it ends.
		const evidence = () =>
			session.exclusive(
				async () => ({ runs: checkRuns(session), current: await session.contentState() }),
				signal,
			);

		const why = new Map<RequiredCheck, string>();
		for (let pass = 0; pass < checkPasses; pass++) {
			let ran = false;
			for (const each of prepared) {
				const { check, line } = each;
				if (why.has(check)) continue;
				const { runs, current } = await evidence();
				const { status } = assessCheck(check.command, line, runs, current);
				if (status === 'passed' || status === 'failed') continue;
				// After the first pass, only a check a later check of the harness's made stale.
				if (pass > 0 && status !== 'stale') continue;
				ran = true;
				// A prepared call runs once: a check run again is prepared again.
				const call = each.call ?? (await prepare(check));
				each.call = undefined;
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
						why.set(check, `could not run: ${error.message}`);
						continue;
					}
					// One that ran but whose changes the harness could not all record stopped writing; it
					// is recorded, if it ended, with no state, and the others are refused from here.
					if (error instanceof EditUnconfirmedError) {
						why.set(check, error.message);
						continue;
					}
					throw error;
				}
			}
			if (!ran) break;
		}

		// Again for every check: running one may have changed what another checked.
		const { runs, current } = await evidence();
		signal.throwIfAborted();
		const results: CheckResult[] = prepared.map(({ check, line }) => {
			const result = assessCheck(check.command, line, runs, current);
			// Why it could not run now says more than how its last run ended; what that printed stays.
			const reason = why.get(check);
			return reason === undefined ? result : { ...result, how: reason };
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
