import type { Agent, Approver, Asker, Callback, CommitReport, Tokens } from '../src/index.ts';
import {
	RecoverableCommittedRunError,
	RecoverableError,
	UnrecoverableCommittedRunError,
	UnrecoverableError,
	isAbortError,
} from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

/** Lines the user types that are commands for the CLI, not prompts for the agent. */
export interface Commands {
	handles(line: string): boolean;
	run(line: string, signal: AbortSignal): Promise<void>;
}

export class ConversationLoop {
	private readonly promptEmitter: IPromptEmitter;
	private readonly output: IOutput;
	private abortController?: AbortController;
	private agent: Agent;
	private callback: Callback;
	private readonly approve: Approver | undefined;
	private readonly commands: Commands | undefined;
	private readonly ask: Asker | undefined;

	constructor(
		agent: Agent,
		callback: Callback,
		promptEmitter: IPromptEmitter,
		output: IOutput,
		approve?: Approver,
		commands?: Commands,
		ask?: Asker,
	) {
		this.agent = agent;
		this.callback = callback;
		this.promptEmitter = promptEmitter;
		this.output = output;
		this.approve = approve;
		this.commands = commands;
		this.ask = ask;
	}

	async start(): Promise<void> {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deliberate infinite loop, exited via `break` on an idle interrupt or an unrecoverable error
		while (true) {
			let prompt: string;
			try {
				this.abortController = new AbortController();
				prompt = await this.promptEmitter.emit('> ', this.abortController.signal);
			} catch (e) {
				if (isAbortError(e)) break;
				this.output.printError(e);
				continue;
			}

			if (this.commands?.handles(prompt)) {
				try {
					// Under the prompt's signal: a command waits on the user, as the prompt did.
					await this.commands.run(prompt, this.abortController.signal);
				} catch (e) {
					if (isAbortError(e)) break;
					this.output.printError(e);
				}
				continue;
			}

			this.callback({ type: 'turnStarted' });
			try {
				this.abortController = new AbortController();
				const agentResponse = await this.agent.run(prompt, {
					signal: this.abortController.signal,
					onProgress: this.callback,
					approve: this.approve,
					ask: this.ask,
				});

				if (agentResponse.runId) this.output.print(`run: ${agentResponse.runId}`);
				for (const line of commitLines(agentResponse.commits)) this.output.print(line);
				this.output.print('usage:');
				this.output.print(`duration: ${String(agentResponse.duration)}s`);
				this.printTokens(agentResponse.tokens);
			} catch (e) {
				if (isAbortError(e)) continue;

				// A failed run was billed for whatever it spent before failing.
				if (
					(e instanceof RecoverableError || e instanceof UnrecoverableError) &&
					(e.tokens || e.usageUnreported)
				) {
					this.output.print('usage before the failure:');
					this.printTokens(e.tokens);
				}
				// What the run committed before it failed stays in git.
				if (
					e instanceof RecoverableCommittedRunError ||
					e instanceof UnrecoverableCommittedRunError
				) {
					for (const line of commitLines(e.commits)) this.output.print(line);
				}

				if (e instanceof UnrecoverableError) {
					this.output.printError(e);
					break;
				}

				this.output.printError(e);
			} finally {
				this.callback({ type: 'turnEnded' });
			}
		}
	}

	private printTokens(tokens: Tokens | undefined): void {
		if (!tokens) {
			this.output.print('tokens: unknown, a call did not report its usage');
			return;
		}

		this.output.print(`inputTokens: ${String(tokens.inputTokens)}`);
		this.output.print(`readCacheTokens: ${String(tokens.readCacheTokens)}`);
		this.output.print(`writtenCacheTokens: ${String(tokens.writtenCacheTokens)}`);
		this.output.print(`outputTokens: ${String(tokens.outputTokens)}`);
	}

	cancel(): void {
		this.abortController?.abort();
	}

	close(): void {
		this.promptEmitter.close();
		this.output.print('thanks, bye!');
	}
}

/** One line per repository of what the committer did, or none when it did not run. */
function commitLines(commits: CommitReport | undefined): string[] {
	if (!commits) return [];
	if (commits.outcome === 'declined') return ['commit: declined'];
	return commits.repositories.map(({ repository, branch, outcome, reason, commits: made }) => {
		const where = `${repository}${branch === undefined ? '' : ` (${branch})`}`;
		const shas = made.map(({ sha, subject }) => `${sha.slice(0, 7)} ${subject}`).join('; ');
		if (outcome !== 'done') return `commit: ${where}: ${outcome}, ${reason ?? 'no reason given'}`;
		return `commit: ${where}: ${shas}${reason === undefined ? '' : `, then git failed: ${reason}`}`;
	});
}
