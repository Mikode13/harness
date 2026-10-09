import {
	type ApprovalDecision,
	type Approver,
	type ToolRisk,
	readDecision,
} from '#src/agent/domain/approval';
import {
	type Agent,
	type AgentResponse,
	type Callback,
	type ProgressEvent,
	type RunOptions,
	ignoreProgress,
} from '#src/agent/domain/agent';
import {
	type RunEnd,
	RunContext,
	runContextOf,
	withRunContext,
} from '#src/agent/domain/runContext';
import {
	InvalidAgentConfigError,
	RecoverableError,
	UnrecoverableError,
	withSpentTokens,
} from '#src/shared/domain/errors';
import {
	classifyHostFailure,
	classifyLocalFailure,
	classifyProviderFailure,
	describeFailure,
	treatErrors,
} from '#src/shared/domain/providerFailure';
import { Conversation } from '#src/llm/domain/conversation';
import type { LLMClient, LLMResponse } from '#src/llm/domain/llm';
import type { Message, MessagePart, ToolCallPart, ToolResultPart } from '#src/llm/domain/message';
import type { ToolDefinition } from '#src/llm/domain/tool';
import { type AgentTool, type PreparedCall, prepareCall } from '#src/tools/domain/preparedCall';
import { isAbortError } from '#src/shared/domain/isAbortError';
import type { ILogger } from '#src/shared/domain/logger';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import {
	type Followed,
	followHistory,
	type HistoryReader,
	transcriptOf,
	undoNote,
} from './historyFollower.ts';

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

/**
 * Whether a run reached a tool's `execute`. A missing tool or a denied call never does, so it
 * has no effect a retry could repeat.
 */
interface RunEffects {
	toolRan: boolean;
}

function narrate(part: MessagePart, callback: Callback): void {
	const event = describePart(part);
	if (event) emit(event, callback);
}

function emit(event: ProgressEvent, callback: Callback): void {
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
	private readonly tools: Map<string, AgentTool>;
	private readonly toolDefinitions: ToolDefinition[];
	private readonly maxSteps: number;
	private readonly autoApprove: boolean;
	private readonly logger: ILogger | undefined;
	private readonly history: HistoryReader | undefined;
	private readonly summarizer: LLMClient | undefined;
	// The latest move through the history this conversation has followed.
	private seenRevision = 0;

	constructor({
		llmClient,
		messages,
		tools = [],
		maxSteps = 25,
		autoApprove = false,
		logger,
		history,
		summarizer,
	}: {
		llmClient: LLMClient;
		messages?: Message[];
		tools?: AgentTool[];
		/** How many calls to the model one run may make before it fails. */
		maxSteps?: number;
		/** Runs every tool call without asking, `destructive` ones included. Meant for CI. */
		autoApprove?: boolean;
		/** Where a failure the agent absorbs is reported. The factories always pass one. */
		logger?: ILogger;
		/**
		 * The history of the workspace this agent writes to. With it, each run first follows the
		 * moves the user made through that history: the conversation goes back with the
		 * workspace, and the model is told what was undone.
		 */
		history?: HistoryReader;
		/**
		 * A cheap model that summarizes what the undone turns tried and what went wrong. Without
		 * one, the model is told what those turns asked, word for word.
		 */
		summarizer?: LLMClient;
	}) {
		if (!Number.isInteger(maxSteps) || maxSteps < 1) {
			throw new InvalidAgentConfigError(
				`maxSteps must be a positive integer; got ${String(maxSteps)}`,
			);
		}

		this.llmClient = llmClient;
		this.conversation = new Conversation(messages);
		this.maxSteps = maxSteps;
		this.autoApprove = autoApprove;
		this.logger = logger;
		this.history = history;
		this.summarizer = summarizer;
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

	private async followHistory(history: HistoryReader): Promise<Followed> {
		try {
			return await followHistory(this.conversation, history, this.seenRevision);
		} catch (error) {
			throw classifyLocalFailure(error, 'The workspace history could not be read');
		}
	}

	/**
	 * Asks the summarizer what the undone turns tried and what went wrong. A summary is a help,
	 * not a need: one that fails is reported and the plain note is used instead.
	 */
	private async summarizeUndone(
		followed: Followed,
		signal: AbortSignal,
	): Promise<{ text?: string; usage?: Tokens; called: boolean }> {
		if (!this.summarizer) return { called: false };
		const reasons = followed.revisions.flatMap(revision =>
			revision.reason ? [revision.reason] : [],
		);
		const prompt = [
			'The user undid the work in the conversation below and moved the workspace back to before it.',
			reasons.length > 0 ? `Their reason: ${reasons.map(reason => `«${reason}»`).join(' ')}` : '',
			'In at most five short lines, say what was tried, why it went wrong or why the user went back, and what could be done better. Plain text, no preamble.',
			'',
			transcriptOf(this.conversation, followed.undone),
		].join('\n');

		let response: LLMResponse;
		try {
			response = await this.summarizer.send(
				{ context: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [] },
				signal,
			);
		} catch (error) {
			if (isAbortError(error)) throw error;
			this.warnSummaryFailed(describeFailure(error));
			return { called: true };
		}

		const usage = response.usage ? { usage: response.usage } : {};
		// A refused or cut summary is not one: the model would read it as what was tried.
		if (response.stopReason !== 'completed') {
			this.warnSummaryFailed(`the model stopped with "${response.stopReason}"`);
			return { ...usage, called: true };
		}
		const text = response.message.content
			.filter(part => part.type === 'text')
			.map(part => part.text)
			.join('\n')
			.trim();
		return { ...(text ? { text } : {}), ...usage, called: true };
	}

	private warnSummaryFailed(why: string): void {
		treatErrors(
			() => {
				this.logger?.warn(`The summary of the undone turns failed: ${why}`);
			},
			classifyHostFailure,
			'LLM agent logger failed',
		);
	}

	private async llmCall(
		runMessages: Message[],
		after: number | undefined,
		signal: AbortSignal,
	): Promise<LLMResponse> {
		let response: LLMResponse;
		try {
			// Sent as a copy, so what the run records is what the agent built, whatever the client does.
			response = await this.llmClient.send(
				{
					context: [...this.conversation.contextAfter(after), ...structuredClone(runMessages)],
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
	 * Undefined when the call may run; otherwise why it may not, which the model receives in its
	 * place. Only a `destructive` call is asked about: git can undo a `mutating` one. A throwing
	 * approver ends the run, as any host callback does.
	 */
	private async denial(
		call: ToolCallPart,
		risk: ToolRisk,
		signal: AbortSignal,
		approve: Approver | undefined,
	): Promise<string | undefined> {
		if (this.autoApprove || risk !== 'destructive') return undefined;

		const retry = 'Do not retry the same call; choose another way, or ask the user.';
		if (!approve) {
			return `The call to "${call.name}" was denied: it is destructive, and no one was asked to allow it. ${retry}`;
		}

		let decision: ApprovalDecision;
		try {
			// A copy, so what runs and what the conversation keeps is exactly what was approved.
			const input: unknown = structuredClone(call.input);
			// Read inside the boundary: an untyped approver can answer anything, and a bad answer
			// is its failure, which must carry the run's tokens like any other.
			decision = readDecision(await approve({ tool: call.name, input, risk }, signal));
		} catch (error) {
			// An approver that gives up on a cancellation, whatever it throws, did not fail.
			signal.throwIfAborted();
			throw classifyHostFailure(error, 'The tool call approver failed');
		}
		// The user may cancel the run while they are being asked.
		signal.throwIfAborted();
		if (decision.approved) return undefined;

		const reason = decision.reason ? ` Their reason: ${decision.reason}` : '';
		return `The user denied the call to "${call.name}".${reason} ${retry}`;
	}

	/**
	 * Always answers the call: a missing tool, a denied call or a failing one becomes an error
	 * result, so the model can correct itself. Only a cancellation, or a failing approver,
	 * escapes, whatever error the tool turned it into.
	 */
	private async runTool(
		call: ToolCallPart,
		{ signal, onProgress: callback = ignoreProgress, approve }: RunOptions,
		effects: RunEffects,
		context: RunContext,
	): Promise<{ result: ToolResultPart; denied: boolean }> {
		const result = { type: 'toolResult' as const, callId: call.id, name: call.name };
		const tool = this.tools.get(call.name);
		if (!tool) {
			return {
				result: {
					...result,
					output: `There is no tool named "${call.name}". Available tools: ${[...this.tools.keys()].join(', ') || 'none'}.`,
					isError: true,
				},
				denied: false,
			};
		}

		let prepared: PreparedCall;
		try {
			prepared = await prepareCall(tool, call.input, signal, context);
		} catch (error) {
			signal.throwIfAborted();
			// A call that cannot be prepared, or whose tool cannot judge it, does not run; the
			// model reads why, such as a refused path, and can correct itself.
			return {
				result: { ...result, output: describeFailure(error), isError: true },
				denied: false,
			};
		}

		// Preparing may have finished after a cancellation it did not notice; nobody is asked to
		// approve a call in a run that has already stopped.
		signal.throwIfAborted();
		const denial = await this.denial(call, prepared.risk, signal, approve);
		if (denial !== undefined) {
			return { result: { ...result, output: denial, isError: true }, denied: true };
		}

		// Deciding took at least one await, and the run may have been cancelled meanwhile.
		signal.throwIfAborted();
		// Announced only once it will run: a missing, failing-to-judge or denied call never is.
		narrate(call, callback);
		// Checked again at the last moment: the consumer may cancel on the announcement itself.
		signal.throwIfAborted();
		// Set before `execute`, so a tool that fails halfway still counts: it may have had effects.
		effects.toolRan = true;
		try {
			return {
				result: { ...result, output: await prepared.run(signal), isError: false },
				denied: false,
			};
		} catch (error) {
			signal.throwIfAborted();
			return {
				result: { ...result, output: describeFailure(error), isError: true },
				denied: false,
			};
		}
	}

	/** One at a time and in order, so their effects and their narration never interleave. */
	private async runTools(
		calls: ToolCallPart[],
		options: RunOptions,
		effects: RunEffects,
		context: RunContext,
	): Promise<Message> {
		const { signal, onProgress: callback = ignoreProgress } = options;
		const results: MessagePart[] = [];
		for (const call of calls) {
			// A call before this one may have ignored the cancellation; this one must not start,
			// nor be announced as running.
			signal.throwIfAborted();
			// `runTool` announces the call only once it is allowed to run, so a consumer never
			// shows a call as running early, nor while the user is still being asked.
			const { result, denied } = await this.runTool(call, options, effects, context);
			if (denied) emit({ type: 'tool', id: call.id, name: call.name, status: 'denied' }, callback);
			else narrate(result, callback);
			results.push(result);
		}

		return { role: 'tool', content: results };
	}

	/**
	 * Runs inside the context of the run that reached it, or in one of its own that it ends with
	 * the run: completed, failed or cancelled.
	 */
	async run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const inherited = runContextOf(options);
		if (inherited) return this.runSteps(prompt, options, inherited);

		const context = new RunContext();
		let end: RunEnd = 'failed';
		try {
			const response = await this.runSteps(prompt, withRunContext(options, context), context);
			end = 'completed';
			return response;
		} catch (error) {
			if (isAbortError(error)) end = 'cancelled';
			throw error;
		} finally {
			await this.finishContext(context, end);
		}
	}

	/**
	 * What the run started ends here, but its result stands: the changes it recorded are already
	 * on disk, so a record that could not be closed is reported, not turned into a failure.
	 */
	private async finishContext(context: RunContext, end: RunEnd): Promise<void> {
		try {
			await context.finish(end);
		} catch (error) {
			treatErrors(
				() => {
					this.logger?.warn(`The run could not close its records: ${describeFailure(error)}`);
				},
				classifyHostFailure,
				'LLM agent logger failed',
			);
		}
	}

	private async runSteps(
		prompt: string,
		options: RunOptions,
		context: RunContext,
	): Promise<AgentResponse> {
		const { signal, onProgress: callback = ignoreProgress } = options;
		const start = Date.now();
		const runMessages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
		let tokens: Tokens | undefined;
		// Once one call went unreported the run's total is unknown, however many report later.
		let unreported = false;
		// Per run, not per instance: what one run executed says nothing about another.
		const effects: RunEffects = { toolRan: false };
		// The turn this one follows: the last recorded, unless the workspace moved since.
		let after = this.conversation.currentTurn;
		let followed: Followed | undefined;

		try {
			if (this.history) {
				followed = await this.followHistory(this.history);
				after = followed.turn;
				if (followed.undone.length > 0) {
					const summary = await this.summarizeUndone(followed, signal);
					tokens = addTokens(tokens, summary.usage);
					unreported ||= summary.called && !summary.usage;
					const note = await undoNote({
						conversation: this.conversation,
						history: this.history,
						followed,
						...(summary.text ? { summary: summary.text } : {}),
					}).catch((error: unknown) => {
						throw classifyLocalFailure(error, 'The workspace history could not be read');
					});
					runMessages[0]?.content.unshift({ type: 'text', text: note });
				}
			}

			for (let step = 1; step <= this.maxSteps; step++) {
				const response = await this.llmCall(runMessages, after, signal);
				tokens = addTokens(tokens, response.usage);
				unreported ||= !response.usage;
				runMessages.push(response.message);

				// Tool calls are narrated as they start, in `runTools`, and never if they do not run.
				for (const part of response.message.content) {
					if (part.type !== 'toolCall') narrate(part, callback);
				}

				const calls = response.message.content.filter(part => part.type === 'toolCall');
				if (calls.length === 0) {
					// Recorded only now, so a failed run leaves no tool call without its result, and a
					// note about what was undone is given again to the next run.
					this.conversation.addRunAfter(after, runMessages, context.historyRun);
					if (followed) this.seenRevision = followed.latestRevision;

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
					runMessages.push(await this.runTools(calls, options, effects, context));
				}
			}

			throw new UnrecoverableError('The LLM did not finish within its step limit', {
				cause: `The model was still calling tools after ${String(this.maxSteps)} steps.`,
			});
		} catch (error) {
			let failure = error;
			if (effects.toolRan && error instanceof RecoverableError) {
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
