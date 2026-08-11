import type { ILoop } from './loopInterface.js';
import * as readline from 'node:readline/promises';
import { clearLine, cursorTo } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import type { Agent } from './agent.ts';

function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}

export class Loop implements ILoop {
	private rl: readline.Interface;
	private abortController?: AbortController;
	private agent: Agent;

	constructor(agent: Agent) {
		this.rl = readline.createInterface({ input, output });
		this.agent = agent;

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

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			try {
				this.abortController = new AbortController();
				const prompt = await this.rl.question('> ', {
					signal: this.abortController.signal,
				});

				const spinnerId = setInterval(() => {
					// eslint-disable-next-line @typescript-eslint/restrict-plus-operands
					process.stdout.write('\r' + frames[frame % frames.length]);
					frame++;
				}, 80);
				let response;
				try {
					response = await this.agent.run(prompt, this.abortController.signal);
				} finally {
					cursorTo(output, 0);
					clearLine(output, 0);
					clearInterval(spinnerId);
				}
				if (response) {
					console.log(response);
				}
			} catch (e) {
				if (!isAbortError(e)) {
					console.error(e);
					break;
				}

				if (await this.confirmExit()) {
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
