import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentResult } from './agent.ts';

type Model = 'sonnet' | 'opus' | 'haiku' | 'claude-fable-5';

export class ClaudeAgent implements Agent {
	private model: Model;
	private sessionId?: string;

	constructor(model: Model) {
		this.model = model;
	}

	async run(prompt: string, signal: AbortSignal): Promise<AgentResult> {
		const stream = query({
			prompt,
			options: {
				model: this.model,
				cwd: process.cwd(),
				resume: this.sessionId,
				maxTurns: 3,
			},
		});

		signal.addEventListener('abort', () => {
			stream.close();
		});

		return await this.parseResponse(stream);
	}

	private async parseResponse(stream: Query) {
		const lines: string[] = [];
		for await (const message of stream) {
			this.sessionId ??= message.session_id;

			if (message.type === 'result') {
				if (message.subtype === 'success') {
					lines.push(message.result);
				} else {
					lines.push(message.stop_reason ?? 'Claude sdk failed');
				}
			}
		}

		if (!lines.length) {
			return undefined;
		}

		return lines.join('\n');
	}
}
