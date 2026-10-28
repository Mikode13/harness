import type { Message, MessagePart } from '#src/llm/domain/message';

/**
 * Where the recent compactor cuts `context`, the context the model was last sent with what the
 * run added since: everything before the cut is summarized, and the messages it keeps word for
 * word follow the summary. `undefined` when the model has answered too few times for anything to
 * be summarized.
 *
 * @param prompt the run's prompt, kept wherever it is. Found by identity: one that is only in an
 * earlier summary's copies is kept again from here.
 */
export function recentCut(
	context: Message[],
	prompt: Message | undefined,
	keptSteps: number,
): { summarized: Message[]; kept: Message[] } | undefined {
	const answers = context.flatMap((message, index) =>
		message.role === 'assistant' ? [index] : [],
	);
	// At least one answer is summarized, or compacting would only add a summary.
	const kept = Math.min(keptSteps, answers.length - 1);
	const cut = answers[answers.length - kept];
	if (kept < 0 || cut === undefined || cut === 0) return undefined;
	// A step starts at an answer, so each call keeps its results, which follow it.
	const tail = context.slice(cut);
	const promptAt = prompt ? context.indexOf(prompt) : -1;
	const keptPrompt = prompt && promptAt < cut ? [prompt] : [];
	return {
		summarized: context.slice(0, cut),
		kept: withoutReplayedReasoning([...keptPrompt, ...tail]),
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
