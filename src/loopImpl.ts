import type { ILoop } from './models/loopInterface.ts';
import type { Agent, Callback } from './models/agent.ts';
import { isAbortError, UnrecoverableError } from './models/errors.ts';
import { createReadlineTerminal, type LoopTerminal } from './terminal.ts';

export class Loop implements ILoop {
	private readonly terminal: LoopTerminal;
	private readonly unsubscribeFromInterrupt: () => void;
	private abortController?: AbortController;
	private agent: Agent;
	private callback: Callback;

	constructor(agent: Agent, callback: Callback, terminal: LoopTerminal = createReadlineTerminal()) {
		this.agent = agent;
		this.callback = callback;
		this.terminal = terminal;

		this.unsubscribeFromInterrupt = this.terminal.onInterrupt(() => {
			this.handleSigint();
		});
	}

	private handleSigint(): void {
		this.abortController?.abort();
	}

	private async confirmExit(): Promise<boolean> {
		try {
			this.abortController = new AbortController();

			const reply = await this.terminal.question(
				'Are you sure you want to exit? ',
				this.abortController.signal,
			);
			if (/^y(es)?$/i.exec(reply)) {
				return true;
			}
			return false;
		} catch (e) {
			if (isAbortError(e)) {
				return this.confirmExit();
			}
			this.terminal.error(e);
			return false;
		}
	}

	async start(): Promise<void> {
		const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
		let frame = 0;

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deliberate infinite loop, exited via `break` on user confirmation or an unrecoverable error
		while (true) {
			try {
				this.abortController = new AbortController();
				const prompt = await this.terminal.question('> ', this.abortController.signal);

				const spinnerId = setInterval(() => {
					// eslint-disable-next-line @typescript-eslint/restrict-plus-operands -- noUncheckedIndexedAccess types frames[i] as string | undefined, but `frame % frames.length` is always a valid index into the non-empty `frames` array
					this.terminal.write('\r' + frames[frame % frames.length]);
					frame++;
				}, 80);
				let agentResponse;
				try {
					agentResponse = await this.agent.run(prompt, this.abortController.signal, item => {
						this.terminal.cursorToStart();
						this.terminal.clearLine();
						this.callback(item);
					});
				} finally {
					this.terminal.cursorToStart();
					this.terminal.clearLine();
					clearInterval(spinnerId);
				}
				if (agentResponse) {
					this.terminal.log('usage:');
					this.terminal.log(`duration: ${String(agentResponse.duration)}s`);
					this.terminal.log(`inputTokens: ${String(agentResponse.inputTokens)}`);
					this.terminal.log(`outputTokens: ${String(agentResponse.outputTokens)}`);
				}
			} catch (e) {
				if (isAbortError(e)) {
					if (await this.confirmExit()) {
						break;
					}
					continue;
				}

				if (e instanceof UnrecoverableError) {
					this.terminal.log(e);
					break;
				}

				this.terminal.error(e);
			}
		}
	}

	close(): void {
		this.unsubscribeFromInterrupt();
		this.terminal.close();
		this.terminal.log('thanks, bye!');
	}
}
