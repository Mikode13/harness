import {
	type Agent,
	type AgentResponse,
	type Callback,
	type ProgressEvent,
	type RunOptions,
	ignoreProgress,
} from '#src/agent/domain/agent';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/agent/domain/errors';
import {
	classifyHostFailure,
	classifyProviderFailure,
	describeFailure,
	treatErrors,
} from '#src/agent/domain/providerFailure';
import { Conversation } from '#src/llm/domain/conversation';
import type { LLMClient, LLMResponse } from '#src/llm/domain/llm';
import type { Message, MessagePart, ToolCallPart, ToolResultPart } from '#src/llm/domain/message';
import type { ToolDefinition } from '#src/llm/domain/tool';
import type { Tool } from '#src/tools/domain/tool';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';

function describePart(part: MessagePart): ProgressEvent | undefined {
	switch (part.type) {
		case 'text':
			return { type: 'agentMessage', message: part.text };
		case 'reasoning':
			return { type: 'reasoning', message: part.text };
		case 'toolCall':
			return { type: 'tool', id: part.id, name: part.name, status: 'in_progress' };
		case 'toolResult':
			return {
				type: 'tool',
				id: part.callId,
				name: part.name,
				status: part.isError ? 'error' : 'completed',
			};
		case 'providerData':
			// Opaque by design: its readable side, if any, arrives as a reasoning part.
			return undefined;
	}
}

function narrate(part: MessagePart, callback: Callback): void {
	const event = describePart(part);
	if (!event) {
		return;
	}

	treatErrors(
		() => {
			callback(event);
		},
		classifyHostFailure,
		'LLM agent progress callback failed',
	);
}

/**
 * An agent whose conversation is owned by MiKode: every run sends the whole context to a
 * stateless `LLMClient`. Within a run the model may call the agent's tools; the agent runs them
 * and sends their results back until the model answers without calling one. Turn boundaries
 * are the consumer's to emit, as with the other engines; this agent only narrates what the
 * model produced and what its tools did.
 */
export class LLMAgent implements Agent {
	private readonly llmClient: LLMClient;
	private readonly conversation: Conversation;
	private readonly tools: Map<string, Tool>;
	private readonly toolDefinitions: ToolDefinition[];
	private readonly maxSteps: number;

	constructor({
		llmClient,
		messages,
		tools = [],
		maxSteps = 25,
	}: {
		llmClient: LLMClient;
		messages?: Message[];
		tools?: Tool[];
		/** How many calls to the model one run may make before it fails. */
		maxSteps?: number;
	}) {
		if (!Number.isInteger(maxSteps) || maxSteps < 1) {
			throw new InvalidAgentConfigError(
				`maxSteps must be a positive integer; got ${String(maxSteps)}`,
			);
		}

		this.llmClient = llmClient;
		this.conversation = new Conversation(messages);
		this.maxSteps = maxSteps;
		this.tools = new Map(tools.map(tool => [tool.name, tool]));
		if (this.tools.size !== tools.length) {
			// The model calls tools by name, so a second one with the same name could never run.
			throw new InvalidAgentConfigError('Two tools share a name; each name must be unique');
		}
		// The client only describes the tools to the model; running them stays with the agent.
		this.toolDefinitions = tools.map(({ name, description, inputSchema }) => ({
			name,
			description,
			inputSchema,
		}));
	}

	private async llmCall(runMessages: Message[], signal: AbortSignal): Promise<LLMResponse> {
		let response: LLMResponse;
		try {
			// Sent as a copy, so what the run records is what the agent built, whatever the client does.
			response = await this.llmClient.send(
				{
					context: [...this.conversation.getContext(), ...structuredClone(runMessages)],
					tools: this.toolDefinitions,
				},
				signal,
			);
		} catch (error) {
			throw classifyProviderFailure(error, 'The LLM call failed');
		}

		if (response.stopReason !== 'completed') {
			throw new UnrecoverableError('The LLM stopped before completing its answer', {
				cause: `The model stopped with "${response.stopReason}".`,
				// The call was billed even though its answer is unusable.
				tokens: response.usage,
				usageUnreported: !response.usage,
			});
		}

		return response;
	}

	/**
	 * Always answers the call: a missing tool or a failing one becomes an error result, so the
	 * model can correct itself. Only a cancellation escapes, whatever error the tool turned it into.
	 */
	private async runTool(call: ToolCallPart, signal: AbortSignal): Promise<ToolResultPart> {
		const result = { type: 'toolResult' as const, callId: call.id, name: call.name };
		const tool = this.tools.get(call.name);
		if (!tool) {
			return {
				...result,
				output: `There is no tool named "${call.name}". Available tools: ${[...this.tools.keys()].join(', ') || 'none'}.`,
				isError: true,
			};
		}

		// Checked again at the last moment: the consumer may cancel on the announcement itself.
		signal.throwIfAborted();
		try {
			return { ...result, output: await tool.execute(call.input, signal), isError: false };
		} catch (error) {
			signal.throwIfAborted();
			return { ...result, output: describeFailure(error), isError: true };
		}
	}

	/** One at a time and in order, so their effects and their narration never interleave. */
	private async runTools(
		calls: ToolCallPart[],
		signal: AbortSignal,
		callback: Callback,
	): Promise<Message> {
		const results: MessagePart[] = [];
		for (const call of calls) {
			// A call before this one may have ignored the cancellation; this one must not start,
			// nor be announced as running.
			signal.throwIfAborted();
			// Announced only as its turn comes, so a consumer never shows a call as running early.
			narrate(call, callback);
			const result = await this.runTool(call, signal);
			narrate(result, callback);
			results.push(result);
		}

		return { role: 'tool', content: results };
	}

	async run(
		prompt: string,
		{ signal, onProgress: callback = ignoreProgress }: RunOptions,
	): Promise<AgentResponse> {
		const start = Date.now();
		const runMessages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
		let tokens: Tokens | undefined;
		// Once one call went unreported the run's total is unknown, however many report later.
		let unreported = false;
		let toolRan = false;

		try {
			for (let step = 1; step <= this.maxSteps; step++) {
				const response = await this.llmCall(runMessages, signal);
				tokens = addTokens(tokens, response.usage);
				unreported ||= !response.usage;
				runMessages.push(response.message);

				// Tool calls are narrated as they start, in `runTools`, and never if they do not run.
				for (const part of response.message.content) {
					if (part.type !== 'toolCall') narrate(part, callback);
				}

				const calls = response.message.content.filter(part => part.type === 'toolCall');
				if (calls.length === 0) {
					// Recorded only now, so a failed run leaves no tool call without its result.
					this.conversation.addRun(runMessages);

					return {
						// Only the final answer: text from earlier steps was narrated as it came.
						response: response.message.content
							.filter(part => part.type === 'text')
							.map(part => part.text)
							.join('\n'),
						tokens: unreported ? undefined : tokens,
						duration: (Date.now() - start) / 1000,
					};
				}

				// On the last step no call is left to send the results to, so the tools do not run.
				if (step < this.maxSteps) {
					// Only a call to a tool the agent has reaches `execute`; a missing one has no
					// effect a retry could repeat.
					toolRan ||= calls.some(call => this.tools.has(call.name));
					runMessages.push(await this.runTools(calls, signal, callback));
				}
			}

			throw new UnrecoverableError('The LLM did not finish within its step limit', {
				cause: `The model was still calling tools after ${String(this.maxSteps)} steps.`,
			});
		} catch (error) {
			let failure = error;
			if (toolRan && error instanceof RecoverableError) {
				// RetryingAgent would run the whole prompt again, and with it every tool this run
				// already executed, so a failure after one ran must not invite a retry.
				const unrecoverable = new UnrecoverableError(error.message, {
					cause: error.cause,
					tokens: error.tokens,
					usageUnreported: error.usageUnreported,
				});
				unrecoverable.stack = error.stack;
				failure = unrecoverable;
			}

			// The run spent the tokens of every step before the one that failed.
			throw withSpentTokens(failure, tokens, unreported);
		}
	}
}
