import { z } from 'zod';
import {
	conversationFormat,
	conversationVersions,
	InvalidSnapshotError,
	UnsupportedSnapshotVersionError,
} from '#src/agent/domain/snapshot';
import type { RestoredConversation } from '#src/engines/domain/model/llmAgent';
import { checkConversationState } from '#src/llm/domain/conversation';
import type { Message, MessagePart } from '#src/llm/domain/message';

// Strict at every level: a key the format does not have is a snapshot of something else, and
// one dropped on the way through would no longer be what the provider sent.
const messageSchema: z.ZodType<Message> = z.lazy(() =>
	z.strictObject({
		role: z.enum(['user', 'assistant', 'tool']),
		content: z.array(partSchema),
	}),
);

const partSchema: z.ZodType<MessagePart> = z.lazy(() =>
	z.discriminatedUnion('type', [
		z.strictObject({ type: z.literal('text'), text: z.string() }),
		z.strictObject({ type: z.literal('reasoning'), text: z.string() }),
		z.strictObject({
			type: z.literal('toolCall'),
			id: z.string(),
			name: z.string(),
			input: z.json(),
		}),
		z.strictObject({
			type: z.literal('toolResult'),
			callId: z.string(),
			name: z.string(),
			output: z.string(),
			isError: z.boolean(),
		}),
		z.strictObject({ type: z.literal('providerData'), source: z.string(), data: z.json() }),
		z.strictObject({ type: z.literal('compaction'), source: z.string(), data: z.json() }),
		z.strictObject({
			type: z.literal('contextSummary'),
			summary: z.string(),
			kept: z.array(messageSchema),
		}),
	]),
);

const index = z.int().nonnegative();

const snapshotSchema = z.strictObject({
	format: z.literal(conversationFormat),
	version: z.literal(1),
	session: z.strictObject({ id: z.string().trim().min(1), name: z.string().optional() }),
	initial: z.array(messageSchema),
	turns: z.array(
		z.strictObject({
			parent: index.optional(),
			runId: z.string().min(1).optional(),
			messages: z.array(messageSchema).min(1),
		}),
	),
	currentTurn: index.optional(),
	seenRevision: index,
	context: z
		.strictObject({ tokens: z.int().nonnegative(), source: z.string().optional() })
		.optional(),
});

/**
 * What `value`, a snapshot taken with `ConversationAgent.snapshot()` and passed through JSON,
 * restores. Read before anything is built, so a snapshot that cannot be restored fails before any
 * model or tool runs.
 *
 * @throws {UnsupportedSnapshotVersionError} for a conversation snapshot of another version.
 * @throws {InvalidSnapshotError} for anything else that is not a whole, valid snapshot.
 */
export function readConversationSnapshot(value: unknown): RestoredConversation {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid('It is not an object.');
	}
	const { format, version } = value as { format?: unknown; version?: unknown };
	if (format !== conversationFormat) {
		throw invalid(
			`Its format is ${describe(format)}, not "${conversationFormat}": it is not a snapshot of an agent's conversation.`,
		);
	}
	// A version that is no whole number is no version a release could have written.
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		throw invalid(`Its version is ${describe(version)}, not a version number.`);
	}
	if (!(conversationVersions as readonly unknown[]).includes(version)) {
		throw new UnsupportedSnapshotVersionError(
			'The conversation snapshot is of a version this release cannot restore',
			{
				cause: `Its version is ${describe(version)}; this release restores version ${conversationVersions.join(', ')}. A later release of the harness may restore it.`,
				version,
			},
		);
	}

	const parsed = snapshotSchema.safeParse(value);
	if (!parsed.success) {
		throw invalid(
			parsed.error.issues
				.slice(0, 5)
				.map(issue => `${issue.path.map(String).join('.') || 'the snapshot'}: ${issue.message}`)
				.join('; '),
		);
	}
	// What was given, not what was parsed: every key was checked, and the providers' data keeps
	// its keys in the order the provider sent them.
	const { session, initial, turns, currentTurn, seenRevision, context } = structuredClone(
		value as z.infer<typeof snapshotSchema>,
	);
	const conversation = {
		initial,
		turns,
		...(currentTurn === undefined ? {} : { current: currentTurn }),
	};
	const problem = checkConversationState(conversation);
	if (problem !== undefined) throw invalid(`Its ${problem}.`);
	return {
		conversation,
		// A blank name is none, as `RunOptions.session` takes it.
		session:
			session.name === undefined || session.name.trim() === ''
				? { id: session.id }
				: { id: session.id, name: session.name },
		seenRevision,
		...(context ? { context } : {}),
	};
}

function invalid(cause: string): InvalidSnapshotError {
	return new InvalidSnapshotError('The conversation snapshot cannot be restored', { cause });
}

function describe(value: unknown): string {
	return value === undefined ? 'missing' : JSON.stringify(value);
}
