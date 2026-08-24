import type { ILoop } from './models/loopInterface.ts';
import * as readline from 'node:readline/promises';
import { clearLine, cursorTo } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import type { Agent } from './models/agent.ts';
import { isAbortError, UnrecoverableError } from './models/errors.ts';

export class Loop implements ILoop {
	private rl: readline.Interface;
	private abortController?: AbortController;
	private agent: Agent;

	constructor(agent: Agent) {
		this.agent = agent;
		this.rl = readline.createInterface({ input, output });

		this.rl.on('SIGINT', () => {
			this.handleSigint();
		});
	}

	private handleSigint(): void {
		this.abortController?.abort();
	}

	private async confirmExit(): Promise<boolean> {
		try {
			this.abortController = new AbortController();

			const reply = await this.rl.question('Are you sure you want to exit? ', {
				signal: this.abortController.signal,
			});
			if (/^y(es)?$/i.exec(reply)) {
				return true;
			}
			return false;
		} catch (e) {
			if (isAbortError(e)) {
				return this.confirmExit();
			}
			console.error(e);
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
				const prompt = await this.rl.question('> ', {
					signal: this.abortController.signal,
				});

				const spinnerId = setInterval(() => {
					// eslint-disable-next-line @typescript-eslint/restrict-plus-operands -- noUncheckedIndexedAccess types frames[i] as string | undefined, but `frame % frames.length` is always a valid index into the non-empty `frames` array
					process.stdout.write('\r' + frames[frame % frames.length]);
					frame++;
				}, 80);
				let agentResponse;
				try {
					agentResponse = await this.agent.run(prompt, this.abortController.signal);
				} finally {
					cursorTo(output, 0);
					clearLine(output, 0);
					clearInterval(spinnerId);
				}
				if (agentResponse) {
					console.log(agentResponse.response);
					console.log('usage:');
					console.log(`duration: ${agentResponse.duration}`);
					console.log(`inputTokens: ${String(agentResponse.inputTokens)}`);
					console.log(`outputTokens: ${String(agentResponse.outputTokens)}`);
				}
			} catch (e) {
				if (isAbortError(e)) {
					if (await this.confirmExit()) {
						break;
					}
				}

				if (e instanceof UnrecoverableError) {
					console.log(e);
					break;
				}
			}
		}
	}

	close(): void {
		this.rl.close();
		console.log('thanks, bye!');
	}
}
