import { canonical } from '#src/shared/domain/canonical';
import type { Message, ToolCallPart } from '#src/llm/domain/message';
import type { FileAccess } from '#src/tools/domain/preparedCall';

// The most recent calls stay whole, whatever made them stale: they are what the model is
// working with right now.
const keptCalls = 3;
// A clearing rewrites the provider's cache from the first part it changes, so it must save
// more than that rewrite costs. Estimated, as the harness does not tokenize.
export const minCompactionSaving = 8_000;
// Rough characters per token: text, and the encrypted reasoning blocks providers send back,
// which measured about 15 per token on OpenAI.
const textCharsPerToken = 4;
const encryptedCharsPerToken = 15;

/**
 * What an agent no longer sends of its conversation, layered over it: the conversation itself
 * keeps every original turn, so nothing cleared is lost to the run's record or to a move back
 * through the history. Keyed by tool call, which survives such moves.
 */
export interface Compaction {
	/** Each cleared tool result, by call id, with why it was cleared. */
	readonly cleared: Map<string, string>;
	/** Reasoning is sent back only from the prompt with this index on, counting from 0. */
	reasoningFromPrompt: number;
}

export function emptyCompaction(): Compaction {
	return { cleared: new Map(), reasoningFromPrompt: 0 };
}

/** `context` as the model receives it under `compaction`: a copy, the original untouched. */
export function compacted(context: Message[], compaction: Compaction): Message[] {
	const prompts = promptIndexes(context);
	const reasoningStart = prompts[Math.min(compaction.reasoningFromPrompt, prompts.length - 1)] ?? 0;
	return context.map((message, index) => ({
		...message,
		content: message.content.flatMap(part => {
			if (part.type === 'providerData' && index < reasoningStart) return [];
			if (part.type === 'toolResult') {
				const reason = compaction.cleared.get(part.callId);
				if (reason !== undefined) return [{ ...part, output: clearedOutput(reason) }];
			}
			return [part];
		}),
	}));
}

/** What a cleared result says instead, so the model knows it may ask again. */
export function clearedOutput(reason: string): string {
	return `[Cleared to keep the context short: ${reason}. Call the tool again if you still need it.]`;
}

/** What one clearing would change, and about how many tokens it would save. */
export interface Clearing {
	cleared: Map<string, string>;
	reasoningFromPrompt: number;
	estimatedTokens: number;
}

/**
 * The stale parts of `context` not yet cleared: results a later identical call replaced,
 * results about a file written since, and reasoning from before the last prompt. Never the
 * prompts, the last calls, or the reasoning of the turn in progress. `files` gives the file
 * each call read or wrote when it ran.
 */
export function findClearing(
	context: Message[],
	compaction: Compaction,
	files: (callId: string) => FileAccess | undefined,
): Clearing {
	const calls = context.flatMap(message =>
		message.content.filter((part): part is ToolCallPart => part.type === 'toolCall'),
	);
	const results = new Map(
		context.flatMap(message =>
			message.content.flatMap(part =>
				part.type === 'toolResult' ? [[part.callId, part.output] as const] : [],
			),
		),
	);
	const kept = new Set(calls.slice(-keptCalls).map(call => call.id));
	const cleared = new Map<string, string>();
	let estimatedTokens = 0;

	for (const [index, call] of calls.entries()) {
		const output = results.get(call.id);
		if (output === undefined || kept.has(call.id) || compaction.cleared.has(call.id)) continue;
		const reason = staleBecause(call, calls.slice(index + 1), files);
		if (reason === undefined) continue;
		cleared.set(call.id, reason);
		estimatedTokens +=
			Math.max(0, output.length - clearedOutput(reason).length) / textCharsPerToken;
	}

	const prompts = promptIndexes(context);
	const reasoningFromPrompt = Math.max(compaction.reasoningFromPrompt, prompts.length - 1);
	const from = prompts[compaction.reasoningFromPrompt] ?? 0;
	const to = prompts[reasoningFromPrompt] ?? 0;
	for (const message of context.slice(from, to)) {
		for (const part of message.content) {
			if (part.type === 'providerData') {
				estimatedTokens += JSON.stringify(part.data).length / encryptedCharsPerToken;
			}
		}
	}

	return { cleared, reasoningFromPrompt, estimatedTokens: Math.round(estimatedTokens) };
}

/** Why a later call made `call`'s result stale, if one did. */
function staleBecause(
	call: ToolCallPart,
	later: ToolCallPart[],
	files: (callId: string) => FileAccess | undefined,
): string | undefined {
	const input = JSON.stringify(canonical(call.input));
	if (
		later.some(next => next.name === call.name && JSON.stringify(canonical(next.input)) === input)
	) {
		return 'a later identical call replaced it';
	}
	const file = files(call.id);
	if (
		file &&
		later.some(next => files(next.id)?.access === 'write' && files(next.id)?.path === file.path)
	) {
		return 'the file changed after it';
	}
	return undefined;
}

/** Where each of the user's prompts is in `context`: a user message with text. */
function promptIndexes(context: Message[]): number[] {
	return context.flatMap((message, index) =>
		message.role === 'user' && message.content.some(part => part.type === 'text') ? [index] : [],
	);
}
