import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentResponse } from './models/agent.ts';
import { RecoverableError } from './models/errors.ts';

type Model = 'sonnet' | 'opus' | 'haiku' | 'claude-fable-5';

export class ClaudeAgent implements Agent {
	private model: Model;
	private sessionId?: string;

	constructor(model: Model) {
		this.model = model;
	}

	async run(prompt: string, signal: AbortSignal): Promise<AgentResponse | undefined> {
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

	private async parseResponse(stream: Query): Promise<AgentResponse | undefined> {
		const lines: string[] = [];
		let resultMessage: SDKResultSuccess | undefined;

		for await (const message of stream) {
			this.sessionId ??= message.session_id;

			if (message.type === 'result') {
				if (message.subtype === 'success') {
					lines.push(message.result);
					resultMessage = message;
				} else {
					// lines.push(message.stop_reason ?? 'Claude sdk failed');
					throw new RecoverableError('Claude sdk error', { cause: message });
				}
			}
		}

		if (!lines.length || !resultMessage) {
			return undefined;
		}

		return {
			response: lines.join('\n'),
			inputTokens: resultMessage.usage.input_tokens,
			outputTokens: resultMessage.usage.output_tokens,
			duration: String(resultMessage.duration_ms / 1000) + 's',
		};
	}
}
