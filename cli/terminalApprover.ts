import type { ApprovalRequest, RememberableDecision } from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

/**
 * Asks the user in the terminal whether a destructive tool call may run. "Always" is answered
 * with `remember`, which `rememberApprovals` turns into not asking again for that tool. A denial
 * asks for an optional reason, which the model receives. Without a person at a terminal, such as
 * with piped input, every call is denied: a line written beforehand for another question must
 * never approve one.
 */
export function createTerminalApprover(promptEmitter: IPromptEmitter, output: IOutput) {
	return async (request: ApprovalRequest, signal: AbortSignal): Promise<RememberableDecision> => {
		output.print(`The agent wants to run "${request.tool}", which is ${request.risk}:`);
		output.print(JSON.stringify(request.input, null, 2));

		if (promptEmitter.interactive !== true) {
			output.print('Denied: nobody is at a terminal to approve it.');
			return { approved: false, reason: 'Nobody was at a terminal to approve it' };
		}

		for (;;) {
			const answer = (
				await promptEmitter.emit('Allow it? [y]es, [a]lways for this tool, [n]o: ', signal)
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
