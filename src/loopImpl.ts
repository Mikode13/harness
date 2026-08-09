import type { ILoop } from './loopInterface.js';
import * as readline from 'node:readline/promises';
import { clearLine, cursorTo } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import type { Thread, ThreadItem } from '@openai/codex-sdk';

function isAbortError(e: unknown): boolean {
	return e instanceof Error && e.name === 'AbortError';
}

function describeItem(item: ThreadItem): string | undefined {
	switch (item.type) {
		case 'agent_message':
			return item.text;
		case 'reasoning':
			return undefined;
		case 'command_execution':
			return `executing: ${item.command}`;
		case 'web_search':
			return `searching: ${item.query}`;
		case 'file_change':
			return item.changes.map(change => `${change.kind}: ${change.path}`).join('\n');
		case 'mcp_tool_call': {
			const status = item.error ? `failed: ${item.error.message}` : item.status;
			return `tool: ${item.server}/${item.tool} (${status})`;
		}
		case 'todo_list':
			return item.items.map(innerItem => innerItem.text).join('\n');
		case 'error':
			// TODO: add retry functionallity at the moment it will fail
			return `error: ${item.message}`;
		default:
			console.warn(item, 'new type');
			return undefined;
	}
}

export class Loop implements ILoop {
	private rl: readline.Interface;
	private abortController?: AbortController;
	private thread: Thread;

	constructor(thread: Thread) {
		this.rl = readline.createInterface({ input, output });
		this.thread = thread;

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

	private parseResponse(threas: ThreadItem[]): void {
		threas
			.map(describeItem)
			.filter(item => !!item)
			.forEach(line => {
				console.log(line);
			});
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
					response = await this.thread.run(prompt, { signal: this.abortController.signal });
				} finally {
					cursorTo(output, 0);
					clearLine(output, 0);
					clearInterval(spinnerId);
				}
				this.parseResponse(response.items);
			} catch (e) {
				if (!isAbortError(e)) {
					console.error(e);
					continue;
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
