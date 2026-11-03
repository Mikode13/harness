import type { RunOptions } from '#src/agent/domain/agent';
import type { CommandLine } from '#src/agent/domain/approval';
import type { CheckResult, Verification } from '#src/agent/domain/phaseResult';

/**
 * A configured command whose passing a coding task requires, run with exactly these values for
 * its parameters. A parameter left out is not given, so `{ command: 'test' }` is the whole run of
 * `test`, and a run of it on some files never counts for it.
 */
export interface RequiredCheck {
	/** The command's name, as configured. */
	readonly command: string;
	/** By parameter name: a `paths` parameter takes a list, a `choice` or a `text` one value. */
	readonly values?: Readonly<Record<string, string | readonly string[]>>;
}

/** One run of a configured command, as the evidence of what the run checked. */
export interface CheckRun {
	readonly name: string;
	readonly line: CommandLine;
	readonly passed: boolean;
	readonly how: string;
	readonly output: string;
	/**
	 * What the files the run changed held when it ended, as one hash. Absent when it changed
	 * something the history could not record.
	 */
	readonly state?: string;
}

/**
 * Verifies a run's required checks with real command results, never with what a model says of
 * them. Git, the commands and the workspace's history stay behind it, in infrastructure.
 */
export interface Verifier {
	/**
	 * Where each required check stands now. Those missing, stale or unknown are run first, by the
	 * harness, with no model: a check that already failed for these files is not run again. One the
	 * harness could not run says why in `how`.
	 *
	 * @throws whatever stopped a check before it ran to an end, other than a refusal to write or a
	 * change the harness could not record, unclassified: the caller classifies it, as the run's own
	 * failure.
	 */
	verify(options: RunOptions): Promise<Verification>;
}

/**
 * Where the check that runs as `expected` stands, from `runs`, every command the run ran in order,
 * and `current`, what the files the run changed hold now. Only a run with the same program,
 * arguments and folder counts. A later run of any command that changed something the history could
 * not record makes it `unknown`, since the files may differ in a way no hash shows.
 */
export function assessCheck(
	command: string,
	expected: CommandLine,
	runs: readonly CheckRun[],
	current: string | undefined,
): CheckResult {
	const last = runs.findLastIndex(run => run.name === command && sameLine(run.line, expected));
	const run = runs[last];
	if (!run) return { command, status: 'missing' };
	const ran = { command, how: run.how, output: run.output };
	const unrecordedSince = runs.slice(last + 1).some(later => later.state === undefined);
	if (run.state === undefined || current === undefined || unrecordedSince) {
		return { ...ran, status: 'unknown' };
	}
	if (run.state !== current) return { ...ran, status: 'stale' };
	return { ...ran, status: run.passed ? 'passed' : 'failed' };
}

/** Whether `checks` meet the requirement: every one passed. */
export function verification(checks: readonly CheckResult[]): Verification {
	return { met: checks.every(({ status }) => status === 'passed'), checks };
}

function sameLine(a: CommandLine, b: CommandLine): boolean {
	return (
		a.executable === b.executable &&
		a.cwd === b.cwd &&
		a.args.length === b.args.length &&
		a.args.every((arg, at) => arg === b.args[at])
	);
}
