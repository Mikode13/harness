import {
	type ApprovalDecision,
	type ApprovalRequest,
	type Approver,
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
import { asNative, nativeOf, type ToolDefinition } from '#src/llm/domain/tool';
import type { Asker } from '#src/agent/domain/question';
import type { Transcript, TranscriptCallback } from '#src/agent/domain/transcript';
import {
	type AgentTool,
	type PreparedCall,
	prepareCall,
	ToolExecutionError,
} from '#src/tools/domain/preparedCall';
import { ReadRegistry, type ToolCallContext } from '#src/tools/domain/readRegistry';

/** What every tool call of one batch shares; each call adds its own id. */
type RunToolContext = Omit<ToolCallContext, 'callId'>;
import { InvalidToolInputError } from '#src/tools/domain/tool';
import { isAbortError } from '#src/shared/domain/isAbortError';
import type { ILogger } from '#src/shared/domain/logger';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import { measureContext } from './stepContext.ts';
import {
	askUserDefinition,
	askUserName,
	describeAnswers,
	readAnswers,
	readQuestions,
	summarizeQuestions,
} from './askUser.ts';
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
				...(part.isError ? { error: part.output } : {}),
			};
		case 'providerData':
			// Opaque by design: its readable side, if any, arrives as a reasoning part.
			return undefined;
		case 'compaction':
			// The provider's, for its client to send back; the step's context shows its effect.
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

/** What a run has shown the model, for its transcript. */
interface Seen {
	messages: () => Message[];
	tools: ToolDefinition[];
}

function narrate(part: MessagePart, callback: Callback, summary?: string, exitCode?: number): void {
	const event = describePart(part);
	if (!event) return;
	if (event.type === 'tool') {
		if (summary !== undefined) event.summary = summary;
		if (exitCode !== undefined) event.exitCode = exitCode;
	}
	emit(event, callback);
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

/** `value` with the keys of every object sorted, so equal inputs serialize alike. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value !== 'object' || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, inner]) => [key, canonical(inner)]),
	);
}

// A model that asks for exactly the same calls this many times in a row is stuck: it already
// has what they return, and running them again changes nothing.
const maxRepeatedSteps = 5;

/** How many steps in a row have asked for exactly the same tool calls, with the same input. */
class RepeatedCalls {
	private last: string | undefined;
	private times = 0;

	count(calls: readonly ToolCallPart[]): number {
		// Keys sorted at every level: the same input with its properties in another order is the
		// same call. Arrays, and the order of the calls, keep theirs.
		const key = JSON.stringify(calls.map(call => [call.name, canonical(call.input)]));
		this.times = key === this.last ? this.times + 1 : 1;
		this.last = key;
		return this.times;
	}
}

// A command that ends exactly as it did the last times, in output too, this many times in a row
// means the model's changes in between are not reaching what the command checks.
const maxRepeatedEndings = 5;

/**
 * How many times in a row each command call, by tool and input, has ended exactly the same way.
 * Calls in between to other tools, or to other commands, do not break the count.
 */
class RepeatedEndings {
	private readonly last = new Map<string, { ending: string; times: number }>();

	count(call: ToolCallPart, ending: string | undefined): number {
		const key = JSON.stringify([call.name, canonical(call.input)]);
		// A call that never ran a command, such as one denied, says nothing of how it ends.
		if (ending === undefined) {
			this.last.delete(key);
			return 0;
		}
		const previous = this.last.get(key);
		const times = previous?.ending === ending ? previous.times + 1 : 1;
		this.last.set(key, { ending, times });
		return times;
	}
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
	// Each call's summary, as its tool gave it when the call ran, so measuring a step that
	// resends the call never runs a consumer's summarizer again.
	private readonly callSummaries = new Map<string, string>();
	private readonly maxSteps: number;
	private readonly autoApprove: boolean;
	private readonly logger: ILogger | undefined;
	private readonly history: HistoryReader | undefined;
	private readonly summarizer: LLMClient | undefined;
	private readonly onTranscript: TranscriptCallback | undefined;
	// The latest move through the history this conversation has followed.
	private seenRevision = 0;
	// What this conversation has seen of each file, so an edit starts from a version it read.
	private readonly reads = new ReadRegistry();

	constructor({
		llmClient,
		messages,
		tools = [],
		maxSteps = 65,
		autoApprove = false,
		logger,
		history,
		summarizer,
		onTranscript,
	}: {
		llmClient: LLMClient;
		messages?: Message[];
		tools?: AgentTool[];
		/** How many calls to the model one run may make before it fails. Defaults to 65. */
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
		/** Receives what the model saw in each run, once the run ended. */
		onTranscript?: TranscriptCallback;
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
		this.onTranscript = onTranscript;
		this.tools = new Map(tools.map(tool => [tool.name, tool]));
		if (this.tools.size !== tools.length) {
			// The model calls tools by name, so a second one with the same name could never run.
			throw new InvalidAgentConfigError('Two tools share a name; each name must be unique');
		}
		// The client only describes the tools to the model; running them stays with the agent.
		this.toolDefinitions = tools.map(tool => {
			const definition = {
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			};
			const native = nativeOf(tool);
			if (native === undefined) return definition;
			// Checked now, not on the first call: an agent its client cannot serve is a setup error.
			if (llmClient.supportsNative?.(native) !== true) {
				throw new InvalidAgentConfigError(
					`The tool "${tool.name}" is the native "${native}" tool, which this model client cannot declare`,
				);
			}
			return asNative(definition, native);
		});
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
		{
			signal,
			step,
			callback,
			tools,
		}: { signal: AbortSignal; step: number; callback: Callback; tools: ToolDefinition[] },
	): Promise<{ response: LLMResponse; context: Message[] }> {
		// Sent as a copy, so what the run records is what the agent built, whatever the client does.
		const context = [...this.conversation.contextAfter(after), ...structuredClone(runMessages)];
		let response: LLMResponse;
		try {
			response = await this.llmClient.send({ context, tools }, signal);
		} catch (error) {
			const failure = classifyProviderFailure(error, 'The LLM call failed');
			// A client turns some answers into errors, such as a stop at the context window. The
			// call was billed, and the failure carries what it spent: it is still a step.
			if (
				(failure instanceof RecoverableError || failure instanceof UnrecoverableError) &&
				(failure.tokens !== undefined || failure.usageUnreported)
			) {
				try {
					this.narrateStep(step, failure.tokens, { context, tools }, callback);
				} catch (hostFailure) {
					// The callback's failure ends the run, and must carry this call's tokens too.
					throw withSpentTokens(hostFailure, failure.tokens, failure.usageUnreported);
				}
			}
			throw failure;
		}

		return { response, context };
	}

	private narrateStep(
		step: number,
		tokens: Tokens | undefined,
		sent: { context: Message[]; tools: ToolDefinition[] },
		callback: Callback,
	) {
		emit(
			{
				type: 'step',
				step,
				...(tokens ? { tokens } : {}),
				context: measureContext({
					instructions: this.llmClient.systemPrompt,
					providerDataSource: this.llmClient.providerDataSource,
					tools: sent.tools,
					context: sent.context,
					summarize: call => this.callSummaries.get(call.id),
				}),
			},
			callback,
		);
	}

	/**
	 * Undefined when the call may run; otherwise why it may not, which the model receives in its
	 * place. Only a `destructive` call is asked about: git can undo a `mutating` one. A throwing
	 * approver ends the run, as any host callback does.
	 */
	private async denial(
		call: ToolCallPart,
		{ risk, command }: PreparedCall,
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
			const request: ApprovalRequest = {
				tool: call.name,
				input,
				risk,
				// A copy too: the approver must not be able to change what runs.
				...(command ? { command: structuredClone(command) } : {}),
			};
			decision = readDecision(await approve(request, signal));
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
		{ signal, onProgress: callback = ignoreProgress, approve, ask }: RunOptions,
		effects: RunEffects,
		toolCall: RunToolContext,
	): Promise<{
		result: ToolResultPart;
		denied: boolean;
		diff?: string;
		summary?: string;
		exitCode?: number;
		ending?: string;
	}> {
		const result = { type: 'toolResult' as const, callId: call.id, name: call.name };
		signal.throwIfAborted();
		if (call.name === askUserName && ask && !this.tools.has(askUserName)) {
			return this.askUser(call, ask, signal, callback);
		}
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

		let summary: string | undefined;
		try {
			// This is deliberately before preparation and approval. A consumer-supplied
			// summarizer is host code, and a failed one must never leave an ambiguous call that
			// could be replayed by RetryingAgent.
			summary = tool.summarize?.(call.input);
			if (summary !== undefined) this.callSummaries.set(call.id, summary);
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof InvalidToolInputError) {
				return {
					result: { ...result, output: describeFailure(error), isError: true },
					denied: false,
				};
			}
			throw classifyHostFailure(error, 'The tool call summarizer failed');
		}

		let prepared: PreparedCall;
		try {
			prepared = await prepareCall(tool, call.input, signal, { ...toolCall, callId: call.id });
		} catch (error) {
			signal.throwIfAborted();
			// A call that cannot be prepared, or whose tool cannot judge it, does not run; the
			// model reads why, such as a refused path, and can correct itself.
			return {
				result: { ...result, output: describeFailure(error), isError: true },
				denied: false,
				...(summary === undefined ? {} : { summary }),
			};
		}

		// Preparing may have finished after a cancellation it did not notice; nobody is asked to
		// approve a call in a run that has already stopped.
		signal.throwIfAborted();
		const denial = await this.denial(call, prepared, signal, approve);
		if (denial !== undefined) {
			return {
				result: { ...result, output: denial, isError: true },
				denied: true,
				...(summary === undefined ? {} : { summary }),
			};
		}

		// Deciding took at least one await, and the run may have been cancelled meanwhile.
		signal.throwIfAborted();
		// Announced only once it will run: a missing, failing-to-judge or denied call never is.
		emit(
			{
				type: 'tool',
				id: call.id,
				name: call.name,
				status: 'in_progress',
				...(summary === undefined ? {} : { summary }),
			},
			callback,
		);
		// Checked again at the last moment: the consumer may cancel on the announcement itself.
		signal.throwIfAborted();
		// Set before `execute`, so a tool that fails halfway still counts: it may have had effects.
		effects.toolRan = true;
		try {
			const output = await prepared.run(signal);
			const ending = prepared.ending?.();
			return {
				result: { ...result, output, isError: false },
				denied: false,
				...(summary === undefined ? {} : { summary }),
				...(prepared.diff === undefined ? {} : { diff: prepared.diff }),
				...(ending === undefined ? {} : { ending }),
			};
		} catch (error) {
			signal.throwIfAborted();
			const ending = prepared.ending?.();
			return {
				result: { ...result, output: describeFailure(error), isError: true },
				denied: false,
				...(summary === undefined ? {} : { summary }),
				...(error instanceof ToolExecutionError && error.exitCode !== undefined
					? { exitCode: error.exitCode }
					: {}),
				...(ending === undefined ? {} : { ending }),
			};
		}
	}

	/**
	 * Asks the user through the run's `ask`. Questions the model wrote wrong go back to it, to
	 * correct; an asker that fails or answers wrongly is host code, and ends the run.
	 */
	private async askUser(
		call: ToolCallPart,
		ask: Asker,
		signal: AbortSignal,
		callback: Callback,
	): Promise<{ result: ToolResultPart; denied: boolean; summary?: string }> {
		const result = { type: 'toolResult' as const, callId: call.id, name: call.name };
		const questions = readQuestions(call.input);
		if (typeof questions === 'string') {
			return { result: { ...result, output: questions, isError: true }, denied: false };
		}
		const summary = summarizeQuestions(questions);
		this.callSummaries.set(call.id, summary);
		emit({ type: 'tool', id: call.id, name: call.name, status: 'in_progress', summary }, callback);
		signal.throwIfAborted();

		let answers: unknown;
		try {
			answers = await ask(questions, signal);
		} catch (error) {
			signal.throwIfAborted();
			throw classifyHostFailure(error, 'The asker failed');
		}
		// An answer that arrives after a cancellation is not given to the model.
		signal.throwIfAborted();
		const read = readAnswers(answers, questions);
		if (!read) {
			throw new UnrecoverableError('The asker failed', {
				cause: `It must answer each of the ${String(questions.length)} questions with some text, in order.`,
			});
		}
		return {
			result: { ...result, output: describeAnswers(questions, read), isError: false },
			denied: false,
			summary,
		};
	}

	/** One at a time and in order, so their effects and their narration never interleave. */
	private async runTools(
		calls: ToolCallPart[],
		options: RunOptions,
		effects: RunEffects,
		toolCall: RunToolContext,
		// Throws the failure of a progress callback a call narrated through.
		throwIfProgressFailed: () => void,
		endings: RepeatedEndings,
	): Promise<Message> {
		const { signal, onProgress: callback = ignoreProgress } = options;
		const results: MessagePart[] = [];
		for (const call of calls) {
			// A call before this one may have ignored the cancellation; this one must not start,
			// nor be announced as running.
			signal.throwIfAborted();
			// `runTool` announces the call only once it is allowed to run, so a consumer never
			// shows a call as running early, nor while the user is still being asked.
			const { result, denied, diff, summary, exitCode, ending } = await this.runTool(
				call,
				options,
				effects,
				toolCall,
			);
			// A call that failed to narrate ends the run before the next one can start.
			throwIfProgressFailed();
			if (denied) {
				emit(
					{
						type: 'tool',
						id: call.id,
						name: call.name,
						status: 'denied',
						...(summary === undefined ? {} : { summary }),
					},
					callback,
				);
			}
			// The diff of a change it made, for the person watching; only once it was made.
			else if (diff !== undefined) {
				emit(
					{
						type: 'tool',
						id: call.id,
						name: call.name,
						status: 'completed',
						diff,
						...(summary === undefined ? {} : { summary }),
					},
					callback,
				);
			} else narrate(result, callback, summary, exitCode);
			results.push(result);
			// After its result is narrated, so the consumer sees the ending that stopped the run.
			if (endings.count(call, ending) >= maxRepeatedEndings) {
				throw new UnrecoverableError('The LLM kept getting the same result from a command', {
					cause: `${summary === undefined ? `"${call.name}"` : `"${summary}"`} ended the same way, with the same output, ${String(maxRepeatedEndings)} times in a row.`,
				});
			}
		}

		return { role: 'tool', content: results };
	}

	/**
	 * Runs inside the context of the run that reached it, or in one of its own that it ends with
	 * the run: completed, failed or cancelled. Only a run that owns its context names the history
	 * run it recorded, since the run is over only when that context ends.
	 */
	async run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const inherited = runContextOf(options);
		if (inherited) return this.runSteps(prompt, options, inherited);

		const context = new RunContext();
		let end: RunEnd = 'failed';
		let response: AgentResponse;
		try {
			response = await this.runSteps(prompt, withRunContext(options, context), context);
			end = 'completed';
		} catch (error) {
			if (isAbortError(error)) end = 'cancelled';
			throw error;
		} finally {
			await this.finishContext(context, end);
		}
		// Read once the run ended: a run that changed nothing left the history then.
		const { runId } = context.historyRun;
		return runId ? { ...response, runId } : response;
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
		const seen: Seen = { messages: () => [], tools: this.toolDefinitions };
		let response: AgentResponse;
		try {
			response = await this.takeSteps(prompt, options, context, seen);
		} catch (error) {
			await this.transcribe(seen, isAbortError(error) ? 'cancelled' : 'failed', error);
			throw error;
		}
		await this.transcribe(seen, 'completed');
		return response;
	}

	/** Hands the run's transcript to the consumer, whose failure is logged, not the run's. */
	private async transcribe(
		seen: Seen,
		outcome: Transcript['outcome'],
		error?: unknown,
	): Promise<void> {
		if (!this.onTranscript) return;
		const content = {
			instructions: this.llmClient.systemPrompt,
			tools: seen.tools.map(({ name, description, inputSchema }) => ({
				name,
				description,
				inputSchema,
			})),
			messages: structuredClone(seen.messages()),
			...(outcome === 'completed' ? {} : { error: describeFailure(error) }),
		};
		try {
			await this.onTranscript({ outcome, content });
		} catch (failure) {
			treatErrors(
				() => {
					this.logger?.warn(
						`The run's transcript could not be handed over: ${describeFailure(failure)}`,
					);
				},
				classifyHostFailure,
				'LLM agent logger failed',
			);
		}
	}

	private async takeSteps(
		prompt: string,
		options: RunOptions,
		context: RunContext,
		seen: Seen,
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
		// What the model has seen so far, whichever turn the run ends up following.
		seen.messages = () => [...this.conversation.contextAfter(after), ...runMessages];

		try {
			if (this.history) {
				followed = await this.followHistory(this.history);
				after = followed.turn;
				// The files may no longer hold what the conversation saw of them.
				if (followed.revisions.length > 0) this.reads.clear();
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

			// After following the history, which may have made every earlier read stale.
			const reads = this.reads.begin();
			const repeats = new RepeatedCalls();
			const endings = new RepeatedEndings();
			// A tool that does its own work on the model, such as running subagents, counts it here.
			const spend = (spent: Tokens | undefined, unreportedCall: boolean) => {
				tokens = addTokens(tokens, spent);
				unreported ||= unreportedCall;
			};
			// A tool narrates through this without ever failing: a failing callback would reach
			// only the tool, which turns any failure into a result for the model. The run ends on
			// it once that tool returns.
			let progressFailure: { error: unknown } | undefined;
			const onProgress = (event: ProgressEvent) => {
				if (progressFailure) return;
				try {
					emit(event, callback);
				} catch (error) {
					progressFailure = { error };
				}
			};
			const throwIfProgressFailed = () => {
				if (progressFailure) throw progressFailure.error;
			};
			// The agent's own `askUser` exists only for a run someone can answer, and never beside
			// a consumer's tool of that name, which the consumer gave first and which stays theirs.
			const offersAsk = options.ask !== undefined && !this.tools.has(askUserName);
			const tools = offersAsk ? [...this.toolDefinitions, askUserDefinition] : this.toolDefinitions;
			seen.tools = tools;
			for (let step = 1; step <= this.maxSteps; step++) {
				const { response, context: sent } = await this.llmCall(runMessages, after, {
					signal,
					step,
					callback,
					tools,
				});
				tokens = addTokens(tokens, response.usage);
				unreported ||= !response.usage;
				// After the tokens are counted, so a throwing callback still reports them, and for an
				// unusable answer too: the call was sent, and billed.
				this.narrateStep(step, response.usage, { context: sent, tools }, callback);
				if (response.stopReason !== 'completed') {
					// Its tokens are already counted with the run's, which the failure carries.
					throw new UnrecoverableError('The LLM stopped before completing its answer', {
						cause: `The model stopped with "${response.stopReason}".`,
					});
				}
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
					// With the turns that read them, and only then: a failed run is not remembered.
					reads.commit();
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

				// Before running them again: the model has already seen what they return.
				if (repeats.count(calls) >= maxRepeatedSteps) {
					throw new UnrecoverableError('The LLM repeated the same tool calls', {
						cause: `The model asked for the same tool calls ${String(maxRepeatedSteps)} times in a row.`,
					});
				}

				// On the last step no call is left to send the results to, so the tools do not run.
				if (step < this.maxSteps) {
					const results = await this.runTools(
						calls,
						options,
						effects,
						{ run: context, reads, onProgress, spend },
						throwIfProgressFailed,
						endings,
					);
					runMessages.push(results);
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
