import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import { isOneOf } from '#src/shared/domain/isOneOf';

/**
 * Something the model fills in a command's arguments. It never writes free arguments: each
 * value is checked against what the consumer declared here, and none can become a flag it did
 * not declare.
 *
 * - `paths`: files or folders inside the roots that the agent may read, each its own argument,
 *   relative to the command's working directory. The model may give none.
 * - `choice`: one of `values`, as the consumer wrote them, so a value may be a flag.
 * - `text`: a value that matches `pattern` whole, and never starts with `-`.
 *
 * A `choice` or `text` that is not `required` may be left out, and then adds no argument.
 */
export type CommandParameter =
	| { type: 'paths'; name: string; description: string }
	| { type: 'choice'; name: string; description: string; values: string[]; required?: boolean }
	| { type: 'text'; name: string; description: string; pattern: string; required?: boolean };

/** One argument of a command: fixed text, or the place where a parameter goes. */
export type CommandArgument = string | CommandParameter;

/** The roles of the model-backed orchestrator a command can be given to. */
export const commandRoles = ['planner', 'executor', 'reviewer'] as const;
export type CommandRole = (typeof commandRoles)[number];

/**
 * A command the consumer lets the agent run, such as the project's tests or its formatter. It
 * runs without a shell, so nothing in an argument is ever read as shell syntax.
 */
export interface CommandDefinition {
	/** What it does and when to run it, for the model. */
	description: string;
	/**
	 * The program: a name looked up in the command's `PATH`, or a path. A relative path is from
	 * `cwd`.
	 */
	executable: string;
	args?: CommandArgument[];
	/**
	 * Where it runs, inside a `write` root: relative to the first root, or absolute. Defaults to
	 * the first root.
	 */
	cwd?: string;
	/**
	 * Variables set for it, on top of the few it inherits: `PATH`, `HOME`, `TMPDIR`, `USER`,
	 * `SHELL`, `LANG` and `LC_*`. Nothing else of this process's environment reaches it, so
	 * neither do the provider keys.
	 */
	env?: Record<string, string>;
	/** How long it may run before its whole process group is stopped. Defaults to 10 minutes. */
	timeoutMs?: number;
	/** How much of the end of its output the model reads. Defaults to 16 KB. */
	outputBytes?: number;
	/**
	 * Which roles of `createLLMOrchestrator` may run it, such as the planner for a command that
	 * reads an issue. Defaults to the executor only. Whoever runs it, the files are captured
	 * around it, so what it changes is in the history. `createFileTools` offers every command.
	 */
	roles?: CommandRole[];
}

/** The commands an agent may run, by the name the model calls each one. */
export type Commands = Record<string, CommandDefinition>;

export const defaultCommandTimeoutMs = 10 * 60 * 1000;
export const defaultCommandOutputBytes = 16 * 1024;
// A test filter or a snapshot name, not a script.
const maxTextLength = 1000;
const maxOutputBytes = 1024 * 1024;
const maxTimeoutMs = 24 * 60 * 60 * 1000;

const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The tool's input names the command with this key, so no parameter may take it.
const reservedParameter = 'name';

/** A parameter's value as the model sent it, with `paths` already checked and resolved. */
export type ParameterValue = string[] | string | null;

/**
 * Checks every command before an agent is built, so a mistake in the configuration fails there
 * and never as a refused call in the middle of a run.
 *
 * @throws {InvalidAgentConfigError} for the first thing that is wrong.
 */
export function validateCommands(commands: Commands): void {
	// Unknown throughout: the configuration may come from a JSON file, whatever its type says.
	if (!isRecord(commands)) throw new InvalidAgentConfigError('Commands must be an object');
	const entries = Object.entries(commands as Record<string, unknown>);
	if (entries.length === 0) throw new InvalidAgentConfigError('No command is configured');
	for (const [name, definition] of entries) {
		const fail = (problem: string) => {
			throw new InvalidAgentConfigError(`Command "${name}" ${problem}`);
		};
		if (!namePattern.test(name)) {
			fail('needs a name of letters, digits, "-" and "_", starting with a letter');
		}
		if (!isRecord(definition)) fail('must be an object');
		const { description, executable, cwd, timeoutMs, outputBytes, env, args, roles } =
			definition as Record<string, unknown>;
		if (typeof description !== 'string' || description.trim() === '') {
			fail('needs a description');
		}
		if (typeof executable !== 'string' || !isArgument(executable)) fail('needs an executable');
		if (cwd !== undefined && (typeof cwd !== 'string' || !isArgument(cwd))) {
			fail('has an invalid cwd');
		}
		checkLimit(timeoutMs, maxTimeoutMs, 'timeoutMs', fail);
		checkLimit(outputBytes, maxOutputBytes, 'outputBytes', fail);
		if (env !== undefined && !isRecord(env)) fail('needs env to map names to values');
		for (const [variable, value] of Object.entries((env ?? {}) as Record<string, unknown>)) {
			if (!variablePattern.test(variable)) fail(`sets an invalid variable name "${variable}"`);
			if (typeof value !== 'string' || value.includes('\0')) {
				fail(`sets "${variable}" to a non-string`);
			}
		}

		if (
			roles !== undefined &&
			(!Array.isArray(roles) ||
				roles.length === 0 ||
				new Set(roles).size !== roles.length ||
				!roles.every(role => typeof role === 'string' && isOneOf(commandRoles, role)))
		) {
			fail(`needs roles to list some of ${commandRoles.join(', ')}, each once`);
		}
		if (args !== undefined && !Array.isArray(args)) fail('needs args to be a list');
		const seen = new Set<string>();
		for (const argument of (args ?? []) as unknown[]) {
			if (typeof argument === 'string') {
				if (!isArgument(argument, { allowEmpty: true })) {
					fail('has an argument with a NUL character');
				}
				continue;
			}
			if (!isRecord(argument)) fail('has an argument that is neither text nor a parameter');
			checkParameter(argument as CommandParameter, seen, fail);
		}
	}
}

function isRecord(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkLimit(
	value: unknown,
	max: number,
	field: string,
	fail: (problem: string) => never,
): void {
	if (value === undefined) return;
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
		fail(`needs ${field} to be a whole number from 1 to ${String(max)}`);
	}
}

function checkParameter(
	parameter: CommandParameter,
	seen: Set<string>,
	fail: (problem: string) => never,
): void {
	// Unknown: the configuration may come from a JSON file, whatever its type says.
	const name: unknown = parameter.name;
	if (typeof name !== 'string' || !namePattern.test(name) || name === reservedParameter) {
		fail(
			`has a parameter with an invalid name ${typeof name === 'string' ? `"${name}"` : 'that is not text'}`,
		);
	}
	if (seen.has(name)) fail(`uses the parameter "${name}" twice`);
	seen.add(name);
	if (typeof parameter.description !== 'string' || parameter.description.trim() === '') {
		fail(`needs a description for the parameter "${name}"`);
	}
	const { required } = parameter as { required?: unknown };
	if (required !== undefined && typeof required !== 'boolean') {
		fail(`needs required to be true or false for the parameter "${name}"`);
	}

	switch (parameter.type) {
		case 'paths':
			return;
		case 'choice':
			if (
				!Array.isArray(parameter.values) ||
				parameter.values.length === 0 ||
				!parameter.values.every(value => typeof value === 'string' && isArgument(value))
			) {
				fail(`needs the choice "${name}" to list at least one value`);
			}
			return;
		case 'text':
			if (typeof parameter.pattern !== 'string') fail(`needs a pattern for the text "${name}"`);
			try {
				textMatcher(parameter.pattern);
			} catch {
				fail(`has a pattern for the text "${name}" that is not a valid regular expression`);
			}
			return;
		default:
			fail(`has a parameter "${name}" of an unknown type`);
	}
}

function isArgument(value: string, { allowEmpty = false } = {}): boolean {
	return (allowEmpty || value !== '') && !value.includes('\0');
}

function textMatcher(pattern: string): RegExp {
	return new RegExp(`^(?:${pattern})$`, 'u');
}

/** The commands `role` may run: those that name it, or, without `roles`, the executor. */
export function commandsFor(commands: Commands, role: CommandRole): Commands {
	return Object.fromEntries(
		Object.entries(commands).filter(([, definition]) =>
			(definition.roles ?? ['executor']).includes(role),
		),
	);
}

/** The parameters of a command, in the order its arguments use them. */
export function parametersOf(definition: CommandDefinition): CommandParameter[] {
	return (definition.args ?? []).filter(argument => typeof argument !== 'string');
}

/**
 * The arguments a call runs with: the fixed ones as declared, and each parameter replaced by
 * the value the model gave, once checked.
 *
 * @throws {Error} worded for the model, when a value is not one the parameter takes.
 */
export function buildArguments(
	definition: CommandDefinition,
	values: Record<string, ParameterValue>,
): string[] {
	const args: string[] = [];
	for (const argument of definition.args ?? []) {
		if (typeof argument === 'string') {
			args.push(argument);
			continue;
		}
		const value = values[argument.name] ?? null;
		args.push(...valueArguments(argument, value));
	}
	return args;
}

function valueArguments(parameter: CommandParameter, value: ParameterValue): string[] {
	const { name } = parameter;
	if (parameter.type === 'paths') {
		if (!Array.isArray(value)) throw new Error(`"${name}" takes a list of paths`);
		return value;
	}
	if (value === null) {
		if (parameter.required === true) throw new Error(`"${name}" is required`);
		return [];
	}
	if (typeof value !== 'string') throw new Error(`"${name}" takes one value`);

	if (parameter.type === 'choice') {
		if (!parameter.values.includes(value)) {
			throw new Error(`"${name}" takes one of: ${parameter.values.join(', ')}`);
		}
		return [value];
	}

	if (value.startsWith('-')) throw new Error(`"${name}" may not start with "-"`);
	if (
		value.length > maxTextLength ||
		value.includes('\0') ||
		!textMatcher(parameter.pattern).test(value)
	) {
		throw new Error(`"${name}" must match ${parameter.pattern}`);
	}
	return [value];
}
