import type { ApprovalRequest, RememberableDecision } from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

/**
 * Asks the user in the terminal whether a destructive tool call may run, showing a configured
 * command as the line it will run. "Always" is answered with `remember`, which
 * `rememberApprovals` turns into not asking again for that tool, or with `approvalKey` for that
 * command. A denial
 * asks for an optional reason, which the model receives. Without a person at a terminal, such as
 * with piped input, every call is denied: a line written beforehand for another question must
 * never approve one.
 */
export function createTerminalApprover(promptEmitter: IPromptEmitter, output: IOutput) {
	return async (request: ApprovalRequest, signal: AbortSignal): Promise<RememberableDecision> => {
		const { command } = request;
		if (command) {
			output.print(`The agent wants to run a configured command, in ${command.cwd}:`);
			output.print([command.executable, ...command.args].map(shownArgument).join(' '));
		} else {
			output.print(`The agent wants to run "${request.tool}", which is ${request.risk}:`);
			output.print(JSON.stringify(request.input, null, 2));
		}

		if (promptEmitter.interactive !== true) {
			output.print('Denied: nobody is at a terminal to approve it.');
			return { approved: false, reason: 'Nobody was at a terminal to approve it' };
		}

		for (;;) {
			const answer = (
				await promptEmitter.emit(
					`Allow it? [y]es, [a]lways for this ${command ? 'command' : 'tool'}, [n]o: `,
					signal,
				)
			)
				.trim()
				.toLowerCase();

			if (answer === 'y' || answer === 'yes') return { approved: true };
			if (answer === 'a' || answer === 'always') return { approved: true, remember: true };
			if (answer === 'n' || answer === 'no') {
				const reason = (await promptEmitter.emit('Why not? (optional): ', signal)).trim();
				return reason ? { approved: false, reason } : { approved: false };
			}
		}
	};
}

/** An argument as it would be typed, quoted when it holds anything a reader could misread. */
function shownArgument(argument: string): string {
	return /^[\w@%+=:,./-]+$/u.test(argument) ? argument : JSON.stringify(argument);
}

/**
 * What "always" allows again: one configured command by its name, whatever its arguments, or
 * any other tool by its name. Without this, "always" for one command would allow every one.
 */
export function approvalKey(request: ApprovalRequest): string {
	if (!request.command) return request.tool;
	const { command } = (request.input ?? {}) as { command?: { name?: unknown } };
	const name = command?.name;
	// Unknown input asks again rather than sharing another call's answer.
	return typeof name === 'string'
		? `${request.tool}:${name}`
		: `${request.tool}:${JSON.stringify(request.command)}`;
}
