import type { Message, MessagePart } from '#src/llm/domain/message';

/**
 * Where the recent compactor cuts `context`, the context the model was last sent with what the
 * run added since: everything before the cut is summarized, and the run's prompt and its last
 * answers, each with its tool results, are kept word for word after the summary. Answers of
 * earlier runs are always summarized, so what is kept starts at the prompt and keeps its order.
 * `undefined` when there is no answer to summarize.
 *
 * @param prompt the run's prompt. Found by identity; when it is not there, an earlier compaction
 * of this run kept it, first, so it is in the summary's message, which is summarized again.
 */
export function recentCut(
	context: Message[],
	prompt: Message,
	keptSteps: number,
): { summarized: Message[]; kept: Message[] } | undefined {
	const found = context.indexOf(prompt);
	const promptAt = Math.max(found, 0);
	const answers = context.flatMap((message, index) =>
		message.role === 'assistant' && index > promptAt ? [index] : [],
	);
	const earlier = context.slice(0, promptAt).some(message => message.role === 'assistant');
	// At least one answer is summarized, or compacting would only add a summary.
	const kept = Math.max(0, Math.min(keptSteps, earlier ? answers.length : answers.length - 1));
	// A step starts at an answer, so each call keeps its results, which follow it.
	const cut = kept === 0 ? context.length : (answers[answers.length - kept] ?? context.length);
	const summarized =
		found === -1
			? context.slice(0, cut)
			: [...context.slice(0, found), ...context.slice(found + 1, cut)];
	if (!summarized.some(message => message.role === 'assistant')) return undefined;
	return {
		summarized,
		kept: withoutReplayedReasoning([prompt, ...context.slice(cut)]),
	};
}

/**
 * Copies of `messages` without what only a provider reads back, which a changed context before
 * it may no longer accept: its signed reasoning and its compactions. The last answer keeps its
 * reasoning, since the provider needs it to go on with that answer's tool calls.
 */
function withoutReplayedReasoning(messages: Message[]): Message[] {
	const last = messages.findLastIndex(message => message.role === 'assistant');
	return messages.flatMap((message, index) => {
		const content = structuredClone(message.content).filter(
			part =>
				part.type !== 'compaction' &&
				part.type !== 'contextSummary' &&
				(part.type !== 'providerData' || index === last),
		);
		return content.length > 0 ? [{ role: message.role, content }] : [];
	});
}

/** What the model is asked once its context passed the threshold, after that whole context. */
export function summaryRequest(keptSteps: number): Message {
	return {
		role: 'user',
		content: [
			{
				type: 'text',
				text: `Your context is about to be compacted. Write a summary of this conversation so far that lets you go on without it: what the user asked, what you found and decided, what you changed and why, what is left to do, and what you would need to read again. After your summary, only the user's request for this run and your last ${String(keptSteps)} answers, with their tool results, are kept word for word, and not your reasoning in them: say what you were thinking and planning there too. Answer with the summary alone, in plain text, and call no tool.`,
			},
		],
	};
}

// A context that no longer fits cannot be sent again to ask for its summary, so the model reads
// it as text, bounded to fit any model the harness offers.
const transcriptCharacters = 300_000;
const partCharacters = 3_000;

/**
 * What the model is asked when the context no longer fit: the part to summarize, as text, since
 * it can no longer be sent as it was.
 */
export function transcriptSummaryRequest(summarized: Message[], keptSteps: number): Message {
	return {
		role: 'user',
		content: [
			{
				type: 'text',
				text: [
					`Below is the start of a conversation in which you, an agent, work on a task for the user. It no longer fits your context, so write a summary of it that lets you go on without it: what the user asked, what you found and decided, what you changed and why, what is left to do, and what you would need to read again. The user's request for this run and your last ${String(keptSteps)} answers, with their tool results, are kept word for word after your summary. Answer with the summary alone, in plain text.`,
					'',
					messagesAsText(summarized, transcriptCharacters, partCharacters),
				].join('\n'),
			},
		],
	};
}

/**
 * `messages` as plain text, for a model to summarize: who said or did what, each part cut at
 * `partChars`, and the whole at `maxChars`, marked when cut.
 */
export function messagesAsText(messages: Message[], maxChars: number, partChars: number): string {
	const lines = messages.flatMap(message =>
		message.content.flatMap(part => partAsText(message, part, partChars)),
	);
	const text = lines.join('\n');
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[the rest was cut]`;
}

function partAsText(message: Message, part: MessagePart, partChars: number): string[] {
	switch (part.type) {
		case 'text':
			return [`${message.role}: ${shorten(part.text, partChars)}`];
		case 'toolCall':
			return [
				`${message.role} called ${part.name} ${shorten(JSON.stringify(part.input), partChars)}`,
			];
		case 'toolResult':
			return [
				`${part.name} ${part.isError ? 'failed' : 'returned'}: ${shorten(part.output, partChars)}`,
			];
		// Readable reasoning, signed blocks and summaries only a provider reads are not the work.
		case 'reasoning':
		case 'providerData':
		case 'compaction':
		case 'contextSummary':
			return [];
	}
}

function shorten(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
