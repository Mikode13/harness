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
	delegationOf,
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
import { keptScore } from '#src/llm/domain/contextTriage';
import { MaxContextError } from '#src/llm/domain/errors';
import type { LLMClient, LLMResponse } from '#src/llm/domain/llm';
import {
	compactedContext,
	type Message,
	type MessagePart,
	type ToolCallPart,
	type ToolResultPart,
} from '#src/llm/domain/message';
import { asNative, nativeOf, type ToolDefinition } from '#src/llm/domain/tool';
import { type Asker, readAnswers, type UserQuestion } from '#src/agent/domain/question';
import type { Transcript, TranscriptCallback } from '#src/agent/domain/transcript';
import { type InboxReader, readerOf } from '#src/agent/domain/inbox';
import { OneRunAtATime } from '#src/agent/domain/oneRunAtATime';
import { newSession, sessionOf } from '#src/agent/domain/session';
import {
	type AgentTool,
	type CommandEnding,
	isDelegating,
	type PreparedCall,
	type PreparedDelegation,
	prepareCall,
	RunEndingToolError,
	ToolExecutionError,
} from '#src/tools/domain/preparedCall';
import { ReadRegistry, type ToolCallContext } from '#src/tools/domain/readRegistry';

/** What every tool call of one batch shares; each call adds its own id. */
type RunToolContext = Omit<ToolCallContext, 'callId'>;
import { InvalidToolInputError } from '#src/tools/domain/tool';
import { isAbortError } from '#src/shared/domain/isAbortError';
import type { ILogger } from '#src/shared/domain/logger';
import { addTokens, type Tokens } from '#src/shared/domain/tokens';
import {
	anotherAttempt,
	askAt,
	CommandLoops,
	extensionNote,
	loopQuestion,
	loopStop,
	loopWarning,
	repeatedAnswersAt,
	repeatNote,
	repeatQuestion,
	repeatStop,
	stop,
	warnAt,
} from './commandLoops.ts';
import { BackgroundAgents, sentNote } from './backgroundAgents.ts';
import { compactionOff, type Compactor, type RecentCompactor } from './compactor.ts';
import {
	messagesAsText,
	recentCut,
	recentlyKept,
	summaryRequest,
	transcriptSummaryRequest,
} from './recentCompaction.ts';
import { triageCandidates, triagedCut, triagedKept } from './triagedCompaction.ts';
import { measureContext } from './stepContext.ts';
import {
	askUserDefinition,
	askUserName,
	describeAnswers,
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
		case 'contextSummary':
			// Narrated as a `compaction` event when it is written.
			return undefined;
	}
}

/** The tokens of context a call sent: all its input, cached or not. */
function contextSize(tokens: Tokens): number {
	return tokens.inputTokens + tokens.readCacheTokens + tokens.writtenCacheTokens;
}

/**
 * Whether a run reached a tool's `execute`. A missing tool or a denied call never does, so it
 * has no effect a retry could repeat.
 */
interface RunEffects {
	toolRan: boolean;
}

/**
 * `message` with each summary in it reduced to its text: what a summary kept is in the
 * conversation before it already.
 */
function withoutKeptCopies(
	message: Message,
): Message | { role: Message['role']; content: unknown[] } {
	return {
		role: message.role,
		content: message.content.map(part =>
			part.type === 'contextSummary' ? { type: part.type, summary: part.summary } : part,
		),
	};
}

/** What a harness compaction did, and what its summary call spent. */
interface CompactionOutcome {
	compacted: boolean;
	/** Whether it spent a call that is not asked for again in the same run. */
	called: boolean;
	usage: Tokens | undefined;
	unreported: boolean;
	/** Why it did not compact, when it did not. */
	why?: string;
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

/**
 * How many steps in a row have asked for exactly the same tool calls, with the same input. A
 * model that keeps asking is likely stuck: it already has what they return.
 */
class RepeatedCalls {
	private last: string | undefined;
	private times = 0;

	/** The user let the run go on: the count starts again. */
	reset(): void {
		this.times = 0;
	}

	count(calls: readonly ToolCallPart[]): number {
		// Keys sorted at every level: the same input with its properties in another order is the
		// same call. Arrays, and the order of the calls, keep theirs.
		const key = JSON.stringify(calls.map(call => [call.name, canonical(call.input)]));
		this.times = key === this.last ? this.times + 1 : 1;
		this.last = key;
		return this.times;
	}
}

/** A call by its tool and input, its properties in any order. */
function callKey(call: ToolCallPart): string {
	return JSON.stringify([call.name, canonical(call.input)]);
}

// How a call the user is asked about is shown: its tool and input, cut short.
const shownCallCharacters = 300;

function describeCall(call: ToolCallPart): string {
	const text = `${call.name} ${JSON.stringify(canonical(call.input))}`;
	return text.length > shownCallCharacters ? `${text.slice(0, shownCallCharacters)}…` : text;
}

/** The result of a call the run stopped before. */
function notRun(call: ToolCallPart): ToolResultPart {
	return {
		type: 'toolResult',
		callId: call.id,
		name: call.name,
		output: 'Not run: the run stopped before it.',
		isError: true,
	};
}

/** The tool results, with `note` for the model after the last of them. */
function withNote(message: Message, note: string): Message {
	const last = message.content.at(-1);
	if (last?.type !== 'toolResult') return message;
	return {
		...message,
		content: [...message.content.slice(0, -1), { ...last, output: `${last.output}\n\n${note}` }],
	};
}

// What the model is told of a message from its inbox, ahead of the message itself.
const sentByUser = 'The user sent this while you worked:';

/** What the user sent since the run last looked, and the message the model reads it in. */
function takeInbox(
	inbox: InboxReader | undefined,
): { texts: string[]; message: Message } | undefined {
	const texts = inbox?.take() ?? [];
	if (texts.length === 0) return undefined;
	const content = [sentByUser, ...texts].map(text => ({ type: 'text' as const, text }));
	return { texts, message: { role: 'user', content } };
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
	private readonly writeRoots: readonly string[] | undefined;
	private readonly compactor: Compactor;
	// The tokens of context the model was last sent in a run that was kept, as its provider
	// reported them, which the recent compactor measures against its threshold: the
	// conversation's size, not a run's count.
	private contextTokens: number | undefined;
	// The latest move through the history this conversation has followed.
	private seenRevision = 0;
	// What this conversation has seen of each file, so an edit starts from a version it read.
	private readonly reads = new ReadRegistry();
	private readonly runs = new OneRunAtATime();
	// The session its runs belong to when their options name none.
	private readonly session = newSession();

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
		writeRoots,
		compactor = compactionOff,
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
		/**
		 * The `write` roots of the agent's workspace: an agent it delegates to writes only within
		 * them. Empty when it only reads; without it, it sets no limit of its own.
		 */
		writeRoots?: readonly string[];
		/** How the context is compacted. Defaults to off: only a context that no longer fits is. */
		compactor?: Compactor;
	}) {
		if (!Number.isInteger(maxSteps) || maxSteps < 1) {
			throw new InvalidAgentConfigError(
				`maxSteps must be a positive integer; got ${String(maxSteps)}`,
			);
		}
		if (compactor.by === 'harness') {
			if (compactor.at !== undefined && !(Number.isInteger(compactor.at) && compactor.at > 0)) {
				throw new InvalidAgentConfigError(
					`compactAt must be a positive whole number of tokens, not ${String(compactor.at)}`,
				);
			}
		} else if (compactor.at !== undefined) {
			if (!llmClient.checkCompactAt) {
				throw new InvalidAgentConfigError('This model client cannot compact; leave compactAt out');
			}
			llmClient.checkCompactAt(compactor.at);
		}

		this.llmClient = llmClient;
		this.conversation = new Conversation(messages);
		this.maxSteps = maxSteps;
		this.autoApprove = autoApprove;
		this.logger = logger;
		this.history = history;
		this.summarizer = summarizer;
		this.onTranscript = onTranscript;
		this.writeRoots = writeRoots;
		this.compactor = compactor;
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

	private warnContextOutgrown(): void {
		treatErrors(
			() => {
				this.logger?.warn(
					'The context no longer fits the model; the next call compacts it and tries again',
				);
			},
			classifyHostFailure,
			'LLM agent logger failed',
		);
	}

	private warnTriageFailed(why: string): void {
		treatErrors(
			() => {
				this.logger?.warn(`Jev could not choose what to keep, so the recent compactor did: ${why}`);
			},
			classifyHostFailure,
			'LLM agent logger failed',
		);
	}

	private warnCompactionFailed(why: string): void {
		treatErrors(
			() => {
				this.logger?.warn(`The context could not be compacted: ${why}`);
			},
			classifyHostFailure,
			'LLM agent logger failed',
		);
	}

	/**
	 * Warns that a summary the model was called for failed. A logger that throws ends the run,
	 * carrying what that call spent, which the run has not counted yet.
	 */
	private warnSummaryCallFailed(
		why: string,
		{ usage, unreported }: { usage: Tokens | undefined; unreported: boolean },
	): void {
		try {
			this.warnCompactionFailed(why);
		} catch (hostFailure) {
			throw withSpentTokens(hostFailure, usage, unreported);
		}
	}

	/**
	 * Has the agent's own model summarize the context before the harness compactor's cut, and
	 * records the summary in the run, with what it keeps word for word. With a triage, Jev chooses
	 * what is kept; when it fails, which it logs, the recent cut does. `compacted` is false when
	 * the model had answered too few times, which costs no call, when Jev kept every answer
	 * whole, unless the context no longer fits, or when the summary failed as `summarize` says.
	 */
	private async compactHarness(
		compactor: RecentCompactor,
		runMessages: Message[],
		after: number | undefined,
		options: { signal: AbortSignal; tools: ToolDefinition[]; outgrown: boolean },
	): Promise<CompactionOutcome> {
		// The run's messages are not copied, so its prompt is found where it is.
		const context = compactedContext([...this.conversation.contextAfter(after), ...runMessages]);
		const [prompt] = runMessages;
		let chosen = prompt && (await this.harnessCut(compactor, context, prompt, options.signal));
		// A context that no longer fits must lose something: when Jev's cut keeps it all, even the
		// last answer it always keeps, recent cuts.
		if (prompt && compactor.triage && !chosen?.cut && options.outgrown) {
			chosen = this.recentChoice(compactor, context, prompt);
		}
		if (!chosen?.cut) {
			const why = chosen?.triaged
				? 'Jev kept every answer whole, so there is nothing to summarize'
				: 'the model has not answered yet, so there is nothing to summarize';
			// A context that no longer fits ends the run, with why in its error rather than the log.
			if (!options.outgrown) this.warnCompactionFailed(why);
			// Jev would keep the same again: it is not asked again in the same run.
			return {
				compacted: false,
				called: chosen?.triaged ?? false,
				usage: undefined,
				unreported: false,
				why,
			};
		}
		// The run's context no longer fitting is what makes a failure end it.
		return this.summarize(chosen.cut, chosen.kept, runMessages, {
			...options,
			context,
			endsRun: options.outgrown,
		});
	}

	/**
	 * Where the harness compactor cuts `context`, and what it keeps, as the summary request says
	 * it. `triaged` when Jev was asked and answered.
	 */
	private async harnessCut(
		compactor: RecentCompactor,
		context: Message[],
		prompt: Message,
		signal: AbortSignal,
	): Promise<{
		cut: { summarized: Message[]; kept: Message[] } | undefined;
		kept: string;
		triaged: boolean;
	}> {
		const { triage } = compactor;
		const candidates = triage ? triageCandidates(context) : [];
		let scores: number[] | undefined = triage && candidates.length === 0 ? [] : undefined;
		if (triage && candidates.length > 0) {
			const latest = context.findLast(message => message.role === 'assistant');
			try {
				scores = await triage.score(
					{
						task: prompt.content
							.flatMap(part => (part.type === 'text' ? [part.text] : []))
							.join('\n'),
						latestAnswer: latest ? messagesAsText([latest], 8_000, 3_000) : '',
						results: candidates.map(({ tool, input, output }) => ({ tool, input, output })),
					},
					signal,
				);
			} catch (error) {
				if (isAbortError(error)) throw error;
				signal.throwIfAborted();
				this.warnTriageFailed(describeFailure(error));
			}
		}
		if (scores) {
			const kept = candidates.filter((_, index) => (scores[index] ?? 0) >= keptScore);
			return {
				cut: triagedCut(context, prompt, new Set(kept.map(({ callId }) => callId))),
				kept: triagedKept(kept),
				triaged: candidates.length > 0,
			};
		}
		return this.recentChoice(compactor, context, prompt);
	}

	private recentChoice(compactor: RecentCompactor, context: Message[], prompt: Message) {
		return {
			cut: recentCut(context, prompt, compactor.keptSteps),
			kept: recentlyKept(compactor.keptSteps),
			triaged: false,
		};
	}

	/**
	 * Has the agent's own model summarize what `cut` does not keep, and records the summary in the
	 * run. Once the threshold passed, the model reads `context`, the context as it was last sent,
	 * from its provider's cache; once the context no longer fit, it reads what it summarizes as
	 * text. `compacted` is false when the model wrote no summary or the provider failed in
	 * passing, which it logs; any other failure is thrown. The summary's usage is the run's either
	 * way.
	 *
	 * @param kept what `cut` keeps, as the summary request tells the model.
	 * @param endsRun whether a failure ends the run, which throws why instead of logging it: the
	 * run's context no longer fits. `outgrown` alone may be this call's own fallback.
	 */
	private async summarize(
		cut: { summarized: Message[]; kept: Message[] },
		kept: string,
		runMessages: Message[],
		{
			context,
			signal,
			tools,
			outgrown,
			endsRun,
		}: {
			context: Message[];
			signal: AbortSignal;
			tools: ToolDefinition[];
			outgrown: boolean;
			endsRun: boolean;
		},
	): Promise<CompactionOutcome> {
		const request = outgrown
			? { context: [transcriptSummaryRequest(cut.summarized, kept)], tools: [] }
			: { context: [...structuredClone(context), summaryRequest(kept)], tools };

		let response: LLMResponse;
		try {
			response = await this.llmClient.send(request, signal);
		} catch (error) {
			if (isAbortError(error)) throw error;
			const failure = classifyProviderFailure(error, 'The context summary failed');
			if (failure instanceof MaxContextError && !outgrown) {
				// The context grew past the model since it was last sent: the model reads what it
				// summarizes as text instead, and this call is the run's too.
				let fallback: CompactionOutcome;
				try {
					fallback = await this.summarize(cut, kept, runMessages, {
						context,
						signal,
						tools,
						outgrown: true,
						endsRun,
					});
				} catch (fallbackFailure) {
					throw withSpentTokens(fallbackFailure, failure.tokens, failure.usageUnreported);
				}
				return {
					...fallback,
					usage: addTokens(failure.tokens, fallback.usage),
					unreported: fallback.unreported || failure.usageUnreported,
				};
			}
			// Only a passing failure of the provider goes without a summary: anything else, such as
			// a logger or a response the client could not map, ends the run as any call's would.
			if (!(failure instanceof RecoverableError)) throw failure;
			const failed = {
				compacted: false,
				called: true,
				usage: failure.tokens,
				unreported: failure.usageUnreported,
				why: describeFailure(failure),
			};
			if (!endsRun) this.warnSummaryCallFailed(failed.why, failed);
			return failed;
		}

		const spent = { called: true, usage: response.usage, unreported: !response.usage };
		const summary = response.message.content
			.flatMap(part => (part.type === 'text' ? [part.text] : []))
			.join('\n')
			.trim();
		// A cut or refused answer, or one that calls a tool, is no summary of the work.
		if (
			response.stopReason !== 'completed' ||
			response.message.content.some(part => part.type === 'toolCall') ||
			summary === ''
		) {
			const why = 'the model did not answer with a summary';
			if (!endsRun) this.warnSummaryCallFailed(why, spent);
			return { compacted: false, ...spent, why };
		}
		runMessages.push({
			role: 'user',
			content: [{ type: 'contextSummary', summary, kept: cut.kept }],
		});
		return { compacted: true, ...spent };
	}

	private async llmCall(
		runMessages: Message[],
		after: number | undefined,
		{
			signal,
			step,
			callback,
			tools,
			compactAt,
		}: {
			signal: AbortSignal;
			step: number;
			callback: Callback;
			tools: ToolDefinition[];
			compactAt: number | 'now' | undefined;
		},
	): Promise<{ response: LLMResponse; context: Message[] }> {
		// Sent as a copy, so what the run records is what the agent built, whatever the client does.
		const context = compactedContext([
			...this.conversation.contextAfter(after),
			...structuredClone(runMessages),
		]);
		let response: LLMResponse;
		try {
			response = await this.llmClient.send({ context, tools, compactAt }, signal);
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
		prepared: PreparedCall | PreparedDelegation,
		signal: AbortSignal,
		approve: Approver | undefined,
	): Promise<string | undefined> {
		const { risk } = prepared;
		if (this.autoApprove || risk !== 'destructive') return undefined;
		const command = 'command' in prepared ? prepared.command : undefined;
		const worktree = 'worktree' in prepared ? prepared.worktree : undefined;

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
				...(worktree ? { worktree: structuredClone(worktree) } : {}),
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
	 * result, so the model can correct itself. Only a cancellation, a failing approver, or host
	 * code that failed inside the call escapes. A call that hands tasks to agents answers once
	 * it sent them, and `background` watches them from then on.
	 */
	private async runTool(
		call: ToolCallPart,
		{ signal, onProgress: callback = ignoreProgress, approve, ask }: RunOptions,
		effects: RunEffects,
		toolCall: RunToolContext,
		background: BackgroundAgents,
	): Promise<{
		result: ToolResultPart;
		denied: boolean;
		diff?: string;
		summary?: string;
		exitCode?: number;
		ending?: CommandEnding;
		// It sent agents to work in the background.
		sent?: boolean;
		// It ran, and may have changed files the history does not record.
		unrecorded?: boolean;
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

		let prepared: PreparedCall | PreparedDelegation;
		try {
			const context = { ...toolCall, callId: call.id };
			prepared = isDelegating(tool)
				? await tool.delegate(call.input, signal, context)
				: await prepareCall(tool, call.input, signal, context);
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
		const unrecorded = prepared.unrecorded === true && prepared.risk !== 'safe';
		if ('start' in prepared) {
			// Before its agents start, so the person watching reads it before anything they narrate.
			emit(
				{
					type: 'tool',
					id: call.id,
					name: call.name,
					status: 'sent',
					...(summary === undefined ? {} : { summary }),
				},
				callback,
			);
			const agents = prepared.start(background.signal);
			background.add(call.id, agents, unrecorded);
			return {
				result: { ...result, output: sentNote(agents), isError: false },
				denied: false,
				sent: true,
				unrecorded,
				...(summary === undefined ? {} : { summary }),
			};
		}
		try {
			const output = await prepared.run(signal);
			const ending = prepared.ending?.();
			return {
				result: { ...result, output, isError: false },
				denied: false,
				unrecorded,
				...(summary === undefined ? {} : { summary }),
				...(prepared.diff === undefined ? {} : { diff: prepared.diff }),
				...(ending === undefined ? {} : { ending }),
			};
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof RunEndingToolError) throw error.failure;
			const ending = prepared.ending?.();
			return {
				result: { ...result, output: describeFailure(error), isError: true },
				denied: false,
				unrecorded,
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

	/**
	 * One at a time and in order, so their effects and their narration never interleave. Agents a
	 * call hands tasks to keep working in the background once it answered.
	 */
	private async runTools(
		calls: ToolCallPart[],
		options: RunOptions,
		effects: RunEffects,
		toolCall: RunToolContext,
		// Throws the failure of a progress callback a call narrated through.
		throwIfProgressFailed: () => void,
		loops: CommandLoops,
		background: BackgroundAgents,
	): Promise<{ message: Message; stopped?: UnrecoverableError }> {
		const { signal } = options;
		const results: MessagePart[] = [];
		for (const [index, call] of calls.entries()) {
			// A call before this one may have ignored the cancellation; this one must not start,
			// nor be announced as running.
			signal.throwIfAborted();
			// `runTool` announces the call only once it is allowed to run, so a consumer never
			// shows a call as running early, nor while the user is still being asked.
			const ran = await this.runTool(call, options, effects, toolCall, background);
			// A call that failed to narrate ends the run before the next one can start.
			throwIfProgressFailed();
			// An agent at work since the last call may have changed what the history cannot copy.
			if (background.mayHaveChangedUnseen()) loops.unrecordedCallRan();
			const settled = this.settle(call, ran, loops, options);
			let { result } = settled;
			const { alike, key, label } = settled;
			// After its result is narrated, so the user is asked about the ending they have seen.
			if (alike !== undefined && alike.times >= askAt) {
				const decision = await this.decideOnLoop(
					{
						question: loopQuestion(label, alike),
						failure: 'The LLM kept getting the same result from a command',
						stopped: reason => loopStop(label, alike, reason),
						note: words => extensionNote(alike, words),
					},
					() => loops.extend([key]),
					options,
				);
				if (typeof decision !== 'string') {
					// So the next run's model reads why this one ended where it did.
					results.push({
						...result,
						output: `${result.output}\n\nThe run stopped here: ${decision.cause}`,
					});
					// The calls after it never run, but each still gets a result, so the run that is
					// kept has none without one.
					results.push(...calls.slice(index + 1).map(notRun));
					return { message: { role: 'tool', content: results }, stopped: decision };
				}
				result = { ...result, output: `${result.output}\n\n${decision}` };
			}
			results.push(result);
		}

		return { message: { role: 'tool', content: results } };
	}

	/**
	 * Narrates how a call ended and notes its command's ending, with the warning for the model
	 * when that ending keeps coming back alike.
	 */
	private settle(
		call: ToolCallPart,
		ran: Awaited<ReturnType<LLMAgent['runTool']>>,
		loops: CommandLoops,
		{ onProgress: callback = ignoreProgress, ask }: RunOptions,
	): {
		result: ToolResultPart;
		alike: ReturnType<CommandLoops['observe']> | undefined;
		key: string;
		label: string;
	} {
		const { denied, diff, summary, exitCode, ending, sent } = ran;
		let { result } = ran;
		if (ran.unrecorded) loops.unrecordedCallRan();
		const key = callKey(call);
		const label = summary ?? call.name;
		const alike = ending === undefined ? undefined : loops.observe(key, ending);
		// A command that changed what the history cannot copy hides that change from the next.
		if (ending !== undefined && ending.state === undefined) loops.unrecordedCallRan();
		// Narrated with it, so the person watching reads what the model is told.
		if (alike?.times === warnAt) {
			result = {
				...result,
				output: `${result.output}\n\n${loopWarning(label, alike, ask !== undefined && !loops.wentOn)}`,
			};
		}
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
		} else if (sent === true) {
			// Narrated as it sent its agents, which go on after it until each one ends.
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
		return { result, alike, key, label };
	}

	/**
	 * On a loop found, the fifth ending alike of a command or the fifth answer in a row asking for
	 * the same calls: the note for the model if the user lets the run go on, or the failure that
	 * stops it. The run goes on once at most, and never without someone to ask.
	 */
	private async decideOnLoop(
		loop: {
			question: UserQuestion;
			failure: string;
			stopped: (reason: string) => string;
			note: (words?: string) => string;
		},
		extend: () => boolean,
		{ ask, signal }: RunOptions,
	): Promise<string | UnrecoverableError> {
		const stopped = (reason: string) =>
			new UnrecoverableError(loop.failure, { cause: loop.stopped(reason) });
		if (!ask) return stopped('No one could be asked whether to go on.');
		if (!extend()) return stopped('The user had already let the run go on once.');

		const questions = [loop.question];
		let answers: unknown;
		try {
			answers = await ask(questions, signal);
		} catch (error) {
			signal.throwIfAborted();
			throw classifyHostFailure(error, 'The asker failed');
		}
		// An answer that arrives after a cancellation is not acted on.
		signal.throwIfAborted();
		const [answer] = readAnswers(answers, questions) ?? [];
		if (answer === undefined) {
			throw new UnrecoverableError('The asker failed', {
				cause: 'It must answer the question with some text.',
			});
		}
		if (answer === stop) return stopped('The user stopped it.');
		return loop.note(answer === anotherAttempt ? undefined : answer);
	}

	/**
	 * Runs inside the context of the run that reached it, or in one of its own that it ends with
	 * the run: completed, failed or cancelled. Only a run that owns its context names the history
	 * run it recorded, since the run is over only when that context ends.
	 *
	 * @throws {RunInProgressError} when another run on this agent is still working.
	 */
	run(prompt: string, options: RunOptions): Promise<AgentResponse> {
		return this.runs.run(() => this.runAlone(prompt, options));
	}

	private async runAlone(prompt: string, options: RunOptions): Promise<AgentResponse> {
		const session = sessionOf(options) ?? this.session;
		// Returned as copies: a consumer changing one must not change what later runs record.
		const inherited = runContextOf(options);
		if (inherited) {
			return { ...(await this.runSteps(prompt, options, inherited)), session: { ...session } };
		}

		const context = new RunContext(session);
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
		return { ...response, ...(runId ? { runId } : {}), session: { ...session } };
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
			await this.transcribe(seen, options, isAbortError(error) ? 'cancelled' : 'failed', error);
			throw error;
		}
		await this.transcribe(seen, options, 'completed');
		return response;
	}

	/** Hands the run's transcript to the consumer, whose failure is logged, not the run's. */
	private async transcribe(
		seen: Seen,
		options: RunOptions,
		outcome: Transcript['outcome'],
		error?: unknown,
	): Promise<void> {
		if (!this.onTranscript) return;
		const delegation = delegationOf(options);
		try {
			// A copy, so a consumer that changes it cannot change the agent's tools or conversation.
			const content: unknown = structuredClone({
				instructions: this.llmClient.systemPrompt,
				tools: seen.tools.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
				messages: seen.messages().map(withoutKeptCopies),
				...(outcome === 'completed' ? {} : { error: describeFailure(error) }),
			});
			await this.onTranscript({
				...(delegation
					? {
							delegation: {
								tool: delegation.tool,
								callId: delegation.callId,
								subagent: delegation.subagent,
							},
						}
					: {}),
				outcome,
				content,
			});
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
		const delegation = delegationOf(options);
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
		// The agents the run's calls send to work in the background.
		const background = new BackgroundAgents(signal, onProgress);
		// Checked whatever it is, as a JavaScript consumer can pass anything.
		const inbox = options.inbox === undefined ? undefined : readerOf(options.inbox);
		// What the user sends while the run waits for its agents is worth the model's attention.
		const stopListening = inbox?.onMessage(() => {
			background.interrupt();
		});
		// What the run read from its inbox and has not kept yet, which goes back there if the run
		// is not kept.
		const unkept: string[] = [];
		const takeSent = () => {
			const sent = takeInbox(inbox);
			if (sent) unkept.push(...sent.texts);
			return sent?.message;
		};
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
		// The context's size as this run knows it, the agent's once the run is kept: a run that
		// is not kept leaves the conversation, and so its size, as they were.
		let contextTokens = this.contextTokens;
		// What the model has seen so far, whichever turn the run ends up following: every message,
		// those a summary replaced too, for a person debugging the run.
		seen.messages = () => [...this.conversation.contextAfter(after), ...runMessages];

		try {
			if (this.history) {
				followed = await this.followHistory(this.history);
				after = followed.turn;
				// The files may no longer hold what the conversation saw of them.
				if (followed.revisions.length > 0) {
					this.reads.clear();
					// Its context is no longer the one last sent.
					contextTokens = undefined;
				}
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
			const loops = new CommandLoops();
			// A tool that does its own work on the model, such as running subagents, counts it here.
			const spend = (spent: Tokens | undefined, unreportedCall: boolean) => {
				tokens = addTokens(tokens, spent);
				unreported ||= unreportedCall;
			};
			// Also ends the run at its next boundary when an agent at work failed in a way that ends it.
			const throwIfProgressFailed = () => {
				if (progressFailure) throw progressFailure.error;
				background.throwIfEnded();
			};
			// The agent's own `askUser` exists only for a run someone can answer, and never beside
			// a consumer's tool of that name, which the consumer gave first and which stays theirs.
			const offersAsk = options.ask !== undefined && !this.tools.has(askUserName);
			const tools = offersAsk ? [...this.toolDefinitions, askUserDefinition] : this.toolDefinitions;
			seen.tools = tools;
			// Recorded only once the run ends in a way that keeps it, so it never leaves a tool call
			// without its result; a run that is not kept gives its note on what was undone again.
			const remember = () => {
				unkept.length = 0;
				this.conversation.addRunAfter(after, runMessages, context.historyRun);
				// With the turns that read them, and only then.
				reads.commit();
				if (followed) this.seenRevision = followed.latestRevision;
				this.contextTokens = contextTokens;
			};
			// A run kept although it failed stops its agents first, and tells the next run what
			// became of each one, which would otherwise wait for answers that never come.
			const keepFailed = async () => {
				await background.stop();
				const ended = background.takeAnswers();
				if (ended) runMessages.push(ended);
				remember();
			};
			// Whether the context outgrew the model at the last call, so this one compacts it first,
			// and how large it was, when the provider said.
			let outgrown = false;
			let outgrownTokens: number | undefined;
			// A summary the model failed to write is not asked for again in the same run, unless the
			// context no longer fits.
			let summaryFailed = false;
			// A summary was just written, so the next call measures what it left.
			let summarized = false;
			const { compactor } = this;
			for (let step = 1; step <= this.maxSteps; step++) {
				// An agent at work may have narrated through a callback that failed.
				throwIfProgressFailed();
				if (
					compactor.by === 'harness' &&
					(outgrown ||
						(!summaryFailed &&
							compactor.at !== undefined &&
							contextTokens !== undefined &&
							contextTokens >= compactor.at))
				) {
					const compaction = await this.compactHarness(compactor, runMessages, after, {
						signal,
						tools,
						outgrown,
					});
					tokens = addTokens(tokens, compaction.usage);
					unreported ||= compaction.unreported;
					if (compaction.compacted) {
						const compacted = outgrown ? outgrownTokens : contextTokens;
						contextTokens = undefined;
						summarized = true;
						emit(
							{
								type: 'compaction',
								by: 'harness',
								reason: outgrown ? 'maxContext' : 'threshold',
								...(compacted === undefined ? {} : { contextTokens: compacted }),
							},
							callback,
						);
					} else if (outgrown) {
						throw new MaxContextError('The context no longer fits the model', {
							cause: `It no longer fit, and could not be compacted: ${compaction.why ?? 'it is unknown why'}.`,
						});
					} else {
						summaryFailed = compaction.called;
					}
					// An agent at work may have ended the run while the summary was written.
					throwIfProgressFailed();
				}
				let called: Awaited<ReturnType<typeof this.llmCall>>;
				try {
					called = await this.llmCall(runMessages, after, {
						signal,
						step,
						callback,
						tools,
						// The harness's own compactor leaves the provider's off.
						compactAt: compactor.by === 'harness' ? undefined : outgrown ? 'now' : compactor.at,
					});
				} catch (error) {
					// Compacted once and tried again, even with compaction off: a second time in a row,
					// with nothing to compact it, or no step left to try ends the run.
					if (
						!(error instanceof MaxContextError) ||
						outgrown ||
						(compactor.by === 'provider' && !this.llmClient.checkCompactAt) ||
						step === this.maxSteps
					) {
						throw error;
					}
					// Billed, and already narrated as a step.
					tokens = addTokens(tokens, error.tokens);
					unreported ||= error.usageUnreported;
					this.warnContextOutgrown();
					outgrown = true;
					outgrownTokens = error.tokens && contextSize(error.tokens);
					continue;
				}
				const { response, context: sent } = called;
				tokens = addTokens(tokens, response.usage);
				unreported ||= !response.usage;
				contextTokens = response.usage && contextSize(response.usage);
				// What a summary keeps word for word may stay past the threshold: summarizing it again
				// on every step would cost a whole context each time and keep nothing less.
				if (
					summarized &&
					compactor.at !== undefined &&
					contextTokens !== undefined &&
					contextTokens >= compactor.at
				) {
					summaryFailed = true;
					this.warnCompactionFailed(
						`what the summary kept is still ${String(contextTokens)} tokens, past the threshold of ${String(compactor.at)}, so the context is not compacted again in this run unless it no longer fits`,
					);
				}
				summarized = false;
				// After the tokens are counted, so a throwing callback still reports them, and for an
				// unusable answer too: the call was sent, and billed.
				this.narrateStep(step, response.usage, { context: sent, tools }, callback);
				if (response.message.content.some(part => part.type === 'compaction')) {
					emit(
						{
							type: 'compaction',
							by: 'provider',
							reason: outgrown ? 'maxContext' : 'threshold',
							...(response.compactedContextTokens === undefined
								? {}
								: { contextTokens: response.compactedContextTokens }),
						},
						callback,
					);
				}
				outgrown = false;
				throwIfProgressFailed();
				if (response.stopReason === 'truncated') {
					// What it wrote before the output limit, kept with the run so the next run can
					// take it up. Not its calls, whose input may be cut, nor what only the provider
					// reads back, which it may refuse incomplete.
					const written = response.message.content.filter(
						part => part.type === 'text' || part.type === 'reasoning',
					);
					for (const part of written) narrate(part, callback);
					if (written.length > 0) runMessages.push({ role: 'assistant', content: written });
					await keepFailed();
					throw new UnrecoverableError('The LLM stopped before completing its answer', {
						cause:
							'The model stopped with "truncated". The run, and what the answer held before the limit, are kept in the conversation.',
					});
				}
				if (response.stopReason !== 'completed') {
					// Its tokens are already counted with the run's, which the failure carries. A run
					// that ends so is not remembered.
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
					// An answer given while agents work, or before the model read what they answered,
					// is a wait: the model goes on with their answers. So is one given before it read
					// what the user sent, while a step is left to answer it; otherwise the message waits
					// in the inbox for the next run.
					const lastStep = step === this.maxSteps;
					let answers = background.takeAnswers();
					let sent = lastStep ? undefined : takeSent();
					if (!answers && !sent && background.working && !lastStep) {
						await background.nextAnswer();
						throwIfProgressFailed();
						answers = background.takeAnswers();
						sent = takeSent();
					}
					if (answers || sent || background.working) {
						if (lastStep) {
							throw new UnrecoverableError('The LLM did not finish within its step limit', {
								cause: `The model was still waiting for the agents it sent after ${String(this.maxSteps)} steps.`,
							});
						}
						if (answers) runMessages.push(answers);
						if (sent) runMessages.push(sent);
						continue;
					}
					remember();

					return {
						// Only the final answer: text from earlier steps was narrated as it came.
						response: response.message.content
							.filter(part => part.type === 'text')
							.map(part => part.text)
							.join('\n'),
						tokens: unreported || background.usageUnknown ? undefined : tokens,
						duration: (Date.now() - start) / 1000,
					};
				}

				// Before running them again: the model has already seen what they return.
				let repeatedNote: string | undefined;
				// Not on the last step, whose calls never run: there is nothing to let go on.
				if (step < this.maxSteps && repeats.count(calls) >= repeatedAnswersAt) {
					const decision = await this.decideOnLoop(
						{
							question: repeatQuestion(calls.map(describeCall).join('\n')),
							failure: 'The LLM repeated the same tool calls',
							stopped: repeatStop,
							note: repeatNote,
						},
						() => loops.extend(calls.map(callKey)),
						options,
					);
					if (typeof decision !== 'string') {
						// Kept like a run stopped on a command, every call given a result.
						const [first, ...rest] = calls.map(notRun);
						runMessages.push({
							role: 'tool',
							content: [
								...(first
									? [
											{
												...first,
												output: `Not run: the run stopped here. ${decision.cause}`,
											},
										]
									: []),
								...rest,
							],
						});
						await keepFailed();
						throw decision;
					}
					repeats.reset();
					repeatedNote = decision;
				}

				// On the last step no call is left to send the results to, so the tools do not run.
				if (step < this.maxSteps) {
					const { message, stopped } = await this.runTools(
						calls,
						options,
						effects,
						{
							run: context,
							reads,
							onProgress,
							spend,
							depth: delegation?.depth ?? 0,
							...(delegation?.writeCeiling ? { writeCeiling: delegation.writeCeiling } : {}),
							...(this.writeRoots ? { agentWriteRoots: this.writeRoots } : {}),
							...(options.approve ? { approve: options.approve } : {}),
							...(options.ask ? { ask: options.ask } : {}),
						},
						throwIfProgressFailed,
						loops,
						background,
					);
					runMessages.push(repeatedNote === undefined ? message : withNote(message, repeatedNote));
					// Kept like a run cut by the output limit: the user may take it up.
					if (stopped) {
						await keepFailed();
						throw stopped;
					}
					// What agents answered and the user sent meanwhile, after the results the model is
					// waiting for.
					const answers = background.takeAnswers();
					if (answers) runMessages.push(answers);
					const sent = takeSent();
					if (sent) runMessages.push(sent);
				}
			}

			throw new UnrecoverableError('The LLM did not finish within its step limit', {
				cause: `The model was still calling tools after ${String(this.maxSteps)} steps.`,
			});
		} catch (error) {
			// The run ends only after the agents still working, which stop with it: what they
			// changed and spent is the run's.
			await background.stop();
			// A run not kept read nothing: what it took belongs to the next attempt or run.
			inbox?.giveBack(unkept);
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
			throw withSpentTokens(failure, tokens, unreported || background.usageUnknown);
		} finally {
			stopListening?.();
		}
	}
}
