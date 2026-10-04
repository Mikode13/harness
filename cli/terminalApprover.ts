import type { ApprovalRequest, RememberableDecision } from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

/**
 * Asks the user in the terminal whether a destructive tool call may run. "Always" is answered
 * with `remember`, which `rememberApprovals` turns into not asking again for that tool. A denial
 * asks for an optional reason, which the model receives.
 */
export function createTerminalApprover(promptEmitter: IPromptEmitter, output: IOutput) {
	return async (request: ApprovalRequest, signal: AbortSignal): Promise<RememberableDecision> => {
		output.print(`The agent wants to run "${request.tool}", which is ${request.risk}:`);
		output.print(JSON.stringify(request.input, null, 2));

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
