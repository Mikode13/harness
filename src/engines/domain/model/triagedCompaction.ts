import type { TriagedResult } from '#src/llm/domain/contextTriage';
import type { Message, MessagePart } from '#src/llm/domain/message';
import { withoutReplayedReasoning } from './recentCompaction.ts';

/** A tool result before the model's last answer, which a triage judges. */
export interface TriageCandidate extends TriagedResult {
	callId: string;
}

/**
 * The tool results of `context` a triage judges: each one before the model's last answer whose
 * call is there too. The last answer's own results are always kept.
 */
export function triageCandidates(context: Message[]): TriageCandidate[] {
	const last = context.findLastIndex(message => message.role === 'assistant');
	const before = context.slice(0, Math.max(last, 0));
	const calls = new Map(
		before.flatMap(message =>
			message.content.flatMap(part => (part.type === 'toolCall' ? [[part.id, part] as const] : [])),
		),
	);
	return before.flatMap(message =>
		message.content.flatMap(part => {
			const call = part.type === 'toolResult' ? calls.get(part.callId) : undefined;
			return part.type === 'toolResult' && call
				? [{ callId: part.callId, tool: call.name, input: call.input, output: part.output }]
				: [];
		}),
	);
}

/**
 * Where a triaged compaction cuts `context`: the run's prompt, each tool call the triage kept
 * with its result, and the model's last answer with everything after it are kept word for word,
 * in their order; everything else is summarized. `undefined` when the model has answered once
 * at most, or the triage kept every answer whole, so a summary would replace nothing.
 *
 * @param prompt the run's prompt, found by identity as in `recentCut`; when it is not there, it
 * is kept first.
 * @param kept the ids of the tool calls kept with their results.
 */
export function triagedCut(
	context: Message[],
	prompt: Message,
	kept: ReadonlySet<string>,
): { summarized: Message[]; kept: Message[] } | undefined {
	const last = context.findLastIndex(message => message.role === 'assistant');
	const found = context.indexOf(prompt);
	const isKept = (part: MessagePart) =>
		(part.type === 'toolCall' && kept.has(part.id)) ||
		(part.type === 'toolResult' && kept.has(part.callId));
	const keptMessages: Message[] = found === -1 ? [prompt] : [];
	const summarized: Message[] = [];
	context.slice(0, Math.max(last, 0)).forEach((message, index) => {
		if (index === found) {
			keptMessages.push(prompt);
			return;
		}
		const keptParts = message.content.filter(isKept);
		const rest = message.content.filter(part => !isKept(part));
		if (keptParts.length > 0) keptMessages.push({ role: message.role, content: keptParts });
		if (rest.length > 0) summarized.push({ role: message.role, content: rest });
	});
	if (!summarized.some(message => message.role === 'assistant')) return undefined;
	return { summarized, kept: withoutReplayedReasoning([...keptMessages, ...context.slice(last)]) };
}

/** What a triaged compaction keeps, as its summary requests tell the model. */
export function triagedKept(kept: TriageCandidate[]): string {
	const calls = kept.map(({ tool, input }) => `${tool} ${shorten(JSON.stringify(input), 200)}`);
	return calls.length === 0
		? "the user's request for this run and your last answer, with its tool results,"
		: `the user's request for this run, your last answer with its tool results, and the results of these earlier tool calls: ${calls.join('; ')},`;
}

function shorten(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
