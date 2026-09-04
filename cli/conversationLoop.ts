import type { Agent, Callback, ILogger } from '../src/index.ts';
import { UnrecoverableError, isAbortError } from '../src/index.ts';
import type { IPromptEmitter } from './promptEmitter.ts';

export class ConversationLoop {
	private readonly promptEmitter: IPromptEmitter;
	private readonly logger: ILogger;
	private abortController?: AbortController;
	private agent: Agent;
	private callback: Callback;

	constructor(agent: Agent, callback: Callback, promptEmitter: IPromptEmitter, logger: ILogger) {
		this.agent = agent;
		this.callback = callback;
		this.promptEmitter = promptEmitter;
		this.logger = logger;
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
				this.logger.error(e);
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
					this.logger.log('usage:');
					this.logger.log(`duration: ${String(agentResponse.duration)}s`);
					this.logger.log(`inputTokens: ${String(agentResponse.inputTokens)}`);
					this.logger.log(`outputTokens: ${String(agentResponse.outputTokens)}`);
				}
			} catch (e) {
				if (isAbortError(e)) continue;

				if (e instanceof UnrecoverableError) {
					this.logger.log(e);
					break;
				}

				this.logger.error(e);
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
		this.logger.log('thanks, bye!');
	}
}
