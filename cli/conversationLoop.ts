import type { Agent, Callback } from '../src/index.ts';
import { UnrecoverableError, isAbortError } from '../src/index.ts';
import type { IOutput } from './output.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

export class ConversationLoop {
	private readonly promptEmitter: IPromptEmitter;
	private readonly output: IOutput;
	private abortController?: AbortController;
	private agent: Agent;
	private callback: Callback;

	constructor(agent: Agent, callback: Callback, promptEmitter: IPromptEmitter, output: IOutput) {
		this.agent = agent;
		this.callback = callback;
		this.promptEmitter = promptEmitter;
		this.output = output;
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

			this.callback({ type: 'turnStarted' });
			try {
				this.abortController = new AbortController();
				const agentResponse = await this.agent.run(
					prompt,
					this.abortController.signal,
					this.callback,
				);

				if (agentResponse) {
					this.output.print('usage:');
					this.output.print(`duration: ${String(agentResponse.duration)}s`);
					this.output.print(`inputTokens: ${String(agentResponse.inputTokens)}`);
					this.output.print(`outputTokens: ${String(agentResponse.outputTokens)}`);
				}
			} catch (e) {
				if (isAbortError(e)) continue;

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

	cancel(): void {
		this.abortController?.abort();
	}

	close(): void {
		this.promptEmitter.close();
		this.output.print('thanks, bye!');
	}
}
