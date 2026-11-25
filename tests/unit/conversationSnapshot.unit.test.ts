import { describe, expect, it } from 'vitest';
import { Conversation } from '../../src/llm/domain/conversation.ts';
import {
	type ConversationSnapshot,
	parseConversationSnapshot,
} from '../../src/llm/domain/conversationSnapshot.ts';
import { compactedContext, type Message } from '../../src/llm/domain/message.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';

const user = (value: string): Message => ({
	role: 'user',
	content: [{ type: 'text', text: value }],
});
const assistant = (value: string): Message => ({
	role: 'assistant',
	content: [{ type: 'text', text: value }],
});

/** The snapshot of `conversation` as the agent composes it: its state and the two counters. */
function snapshotOf(
	conversation: Conversation,
	seenRevision = 0,
	contextTokens: number | null = null,
): ConversationSnapshot {
	return parseConversationSnapshot({
		version: 1,
		...conversation.capture(),
		seenRevision,
		contextTokens,
	});
}

/** The snapshot after a trip through JSON text, as a consumer persists and reads it. */
function persisted(snapshot: ConversationSnapshot): ConversationSnapshot {
	return parseConversationSnapshot(JSON.parse(JSON.stringify(snapshot)));
}

/** A conversation with branches: turns 1 and 2 both follow turn 0, and turn 2 is the current one. */
function branchedConversation(): Conversation {
	const conversation = new Conversation([user('Task: fix the parser.')]);
	conversation.addRun([user('Read the file.'), assistant('Read it.')]);
	conversation.addRunAfter(0, [user('Edit it.'), assistant('Edited.')], { runId: 'run-edit' });
	conversation.addRunAfter(0, [user('Edit it another way.'), assistant('Edited again.')], {});
	return conversation;
}

/** Rewrites every text in `messages` in place, so a copy that shares any of it shows the change. */
function scramble(messages: readonly Message[]): void {
	for (const message of messages) {
		for (const part of message.content) {
			if (part.type === 'text') part.text = 'changed';
		}
	}
}

describe('a conversation snapshot, version 1', () => {
	it('round-trips through JSON to the same snapshot and a conversation that continues the same way', () => {
		const conversation = branchedConversation();
		const snapshot = snapshotOf(conversation, 3, 1200);

		const text = JSON.stringify(snapshot);
		const parsed = parseConversationSnapshot(JSON.parse(text));
		expect(parsed).toEqual(snapshot);
		expect(JSON.stringify(parsed)).toBe(text);

		const restored = Conversation.restore(parsed);
		expect(restored.getContext()).toEqual(conversation.getContext());
		expect(restored.describeTurns()).toEqual(conversation.describeTurns());
		expect(restored.currentTurn).toBe(2);

		for (const continued of [conversation, restored]) {
			continued.addRun([user('Next.')]);
		}
		expect(restored.capture()).toEqual(conversation.capture());
	});

	it('keeps the branches, and a current turn that is not the latest', () => {
		const conversation = branchedConversation();
		const snapshot = parseConversationSnapshot({
			version: 1,
			...conversation.capture(),
			current: 1,
			seenRevision: 0,
			contextTokens: null,
		});

		const restored = Conversation.restore(persisted(snapshot));
		expect(restored.currentTurn).toBe(1);
		expect(restored.getContext()).toEqual(conversation.contextAfter(1));
		expect(restored.contextAfter(2)).toEqual(conversation.contextAfter(2));
		expect(restored.path(2)).toEqual([0, 2]);

		restored.addRun([user('Follow turn 1.')]);
		expect(restored.describeTurns().at(-1)).toEqual({ index: 3, parent: 1, runId: undefined });
	});

	it('keeps the initial messages, and an empty conversation has no turns', () => {
		const withTask = snapshotOf(new Conversation([user('Task.'), assistant('Ready.')]));
		expect(withTask.initial).toEqual([user('Task.'), assistant('Ready.')]);
		expect(withTask.turns).toEqual([]);
		expect(withTask.current).toBeNull();
		expect(Conversation.restore(persisted(withTask)).getContext()).toEqual([
			user('Task.'),
			assistant('Ready.'),
		]);

		const empty = snapshotOf(new Conversation());
		expect(empty).toEqual({
			version: 1,
			initial: [],
			turns: [],
			current: null,
			seenRevision: 0,
			contextTokens: null,
		});
		expect(Conversation.restore(persisted(empty)).getContext()).toEqual([]);
	});

	it('keeps nested context summaries, and compacts them the same way after a restore', () => {
		const conversation = new Conversation([user('Task.')]);
		conversation.addRun([
			{
				role: 'user',
				content: [
					{
						type: 'contextSummary',
						summary: 'The parser was read and one edit failed.',
						kept: [
							user('Keep this prompt.'),
							{
								role: 'assistant',
								content: [
									{ type: 'toolCall', id: 'call-1', name: 'read', input: { path: 'a.ts' } },
								],
							},
							{
								role: 'tool',
								content: [
									{
										type: 'toolResult',
										callId: 'call-1',
										name: 'read',
										output: 'export {};',
										isError: false,
									},
								],
							},
							{
								role: 'user',
								content: [
									{
										type: 'contextSummary',
										summary: 'An older summary.',
										kept: [user('Older prompt.')],
									},
								],
							},
						],
					},
				],
			},
			assistant('Continuing.'),
		]);

		const restored = Conversation.restore(persisted(snapshotOf(conversation)));
		expect(restored.getContext()).toEqual(conversation.getContext());
		expect(compactedContext(restored.getContext())).toEqual(
			compactedContext(conversation.getContext()),
		);
	});

	it('keeps opaque provider data and compaction payloads exactly, as JSON', () => {
		const conversation = new Conversation();
		conversation.addRun([
			{
				role: 'assistant',
				content: [
					{
						type: 'providerData',
						source: 'openai',
						data: {
							id: 'rs_1',
							encrypted: 'abc==',
							nested: { list: [1, 2.5, -3, null, true, { deep: 'x' }], empty: {} },
						},
					},
					{ type: 'compaction', source: 'openai', data: { id: 'cmp_1', items: [] } },
					{
						type: 'toolCall',
						id: 'call-1',
						name: 'apply',
						input: { operation: { type: 'create_file', diff: '+ export {};' } },
					},
				],
			},
			{
				role: 'tool',
				content: [
					{ type: 'toolResult', callId: 'call-1', name: 'apply', output: 'done', isError: false },
				],
			},
		]);

		const text = JSON.stringify(snapshotOf(conversation));
		const restored = Conversation.restore(parseConversationSnapshot(JSON.parse(text)));
		expect(JSON.stringify(restored.getContext())).toBe(JSON.stringify(conversation.getContext()));
		expect(JSON.stringify(snapshotOf(restored))).toBe(text);
	});

	it('shares nothing with the conversation, the snapshots it returns, or the one it restores from', () => {
		const task = [user('Task.')];
		const conversation = new Conversation(task);
		const prompt = [user('Prompt.'), assistant('Answer.')];
		conversation.addRun(prompt);
		const context = JSON.stringify(conversation.getContext());

		scramble(task);
		scramble(prompt);
		expect(JSON.stringify(conversation.getContext())).toBe(context);

		const snapshot = snapshotOf(conversation);
		const expected = persisted(snapshot);
		scramble(snapshot.initial);
		for (const turn of snapshot.turns) scramble(turn.messages);
		expect(snapshotOf(conversation)).toEqual(expected);

		const input = structuredClone(expected);
		const parsed = parseConversationSnapshot(input);
		scramble(input.initial);
		for (const turn of input.turns) scramble(turn.messages);
		expect(parsed).toEqual(expected);

		const restored = Conversation.restore(parsed);
		scramble(parsed.initial);
		for (const turn of parsed.turns) scramble(turn.messages);
		expect(restored.getContext()).toEqual(conversation.getContext());

		scramble(restored.getContext());
		expect(JSON.stringify(restored.getContext())).toBe(context);
	});
});

/** A valid snapshot, built fresh, for each malformed variant to change one thing of. */
function validSnapshot() {
	return {
		version: 1,
		initial: [user('Task.')],
		turns: [
			{ messages: [user('First.'), assistant('One.')], parent: null, runId: 'run-1' },
			{ messages: [user('Second.')], parent: 0, runId: null },
		],
		current: 1,
		seenRevision: 2,
		contextTokens: 100,
	};
}

/** A valid snapshot whose initial messages hold one part, changed as the case needs. */
function withPart(part: unknown): unknown {
	return { ...validSnapshot(), initial: [{ role: 'user', content: [part] }] };
}

function withTurns(turns: unknown[]): unknown {
	return { ...validSnapshot(), turns };
}

function without(snapshot: object, field: string): object {
	return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== field));
}

function cyclicData(): Record<string, unknown> {
	const data: Record<string, unknown> = { name: 'loop' };
	data.self = data;
	return data;
}

function sparseData(): unknown[] {
	const data: unknown[] = [];
	data[1] = 'hole before';
	return data;
}

function getterData(): object {
	return Object.defineProperty({}, 'field', { enumerable: true, get: () => 'computed' });
}

describe('parsing a conversation snapshot', () => {
	it('accepts a valid snapshot and returns an equal copy', () => {
		expect(parseConversationSnapshot(validSnapshot())).toEqual(validSnapshot());
	});

	const malformed: [string, () => unknown][] = [
		['a string', () => 'a snapshot'],
		['an array', () => [validSnapshot()]],
		['null', () => null],
		['an unknown top-level field', () => ({ ...validSnapshot(), extra: true })],
		['a missing field', () => without(validSnapshot(), 'seenRevision')],
		['a turns field that is not a list', () => ({ ...validSnapshot(), turns: {} })],
		['a non-whole seenRevision', () => ({ ...validSnapshot(), seenRevision: 1.5 })],
		['a string seenRevision', () => ({ ...validSnapshot(), seenRevision: '2' })],
		['a negative contextTokens', () => ({ ...validSnapshot(), contextTokens: -1 })],
		['a NaN contextTokens', () => ({ ...validSnapshot(), contextTokens: NaN })],
		['an unknown role', () => ({ ...validSnapshot(), initial: [{ role: 'system', content: [] }] })],
		[
			'content that is not a list',
			() => ({ ...validSnapshot(), initial: [{ role: 'user', content: 'Task.' }] }),
		],
		['an unknown part type', () => withPart({ type: 'image', url: 'a.png' })],
		['a text part without text', () => withPart({ type: 'text' })],
		['a part with an extra field', () => withPart({ type: 'text', text: 'Task.', extra: 1 })],
		[
			'a tool result whose error flag is not a boolean',
			() =>
				withPart({
					type: 'toolResult',
					callId: 'call-1',
					name: 'read',
					output: 'x',
					isError: 'no',
				}),
		],
		['a tool call without input', () => withPart({ type: 'toolCall', id: 'call-1', name: 'read' })],
		[
			'a tool call whose input is undefined',
			() => withPart({ type: 'toolCall', id: 'call-1', name: 'read', input: undefined }),
		],
		[
			'a tool call whose input is a non-finite number',
			() => withPart({ type: 'toolCall', id: 'call-1', name: 'read', input: Infinity }),
		],
		[
			'an undefined field in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: { gone: undefined } }),
		],
		[
			'a NaN in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: { n: NaN } }),
		],
		[
			'a function in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: { run: () => 1 } }),
		],
		[
			'a Date in compaction data',
			() => withPart({ type: 'compaction', source: 'openai', data: new Date(0) }),
		],
		[
			'a Map in compaction data',
			() => withPart({ type: 'compaction', source: 'openai', data: new Map() }),
		],
		[
			'a bigint in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: BigInt(1) }),
		],
		[
			'a symbol in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: Symbol('x') }),
		],
		[
			'a sparse list in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: sparseData() }),
		],
		[
			'a cycle in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: cyclicData() }),
		],
		[
			'a getter in provider data',
			() => withPart({ type: 'providerData', source: 'openai', data: getterData() }),
		],
		[
			'a context summary with a malformed kept message',
			() =>
				withPart({
					type: 'contextSummary',
					summary: 'Earlier.',
					kept: [{ role: 'bot', content: [] }],
				}),
		],
		[
			'a turn that is its own parent, a cycle',
			() => withTurns([{ messages: [], parent: 0, runId: null }]),
		],
		[
			'two turns that name each other as parent, a cycle',
			() =>
				withTurns([
					{ messages: [], parent: 1, runId: null },
					{ messages: [], parent: 0, runId: null },
				]),
		],
		[
			'a parent past the last turn',
			() =>
				withTurns([
					{ messages: [], parent: null, runId: null },
					{ messages: [], parent: 5, runId: null },
				]),
		],
		[
			'a fractional parent',
			() =>
				withTurns([
					{ messages: [], parent: null, runId: null },
					{ messages: [], parent: 0.5, runId: null },
				]),
		],
		['a current turn past the last', () => ({ ...validSnapshot(), current: 2 })],
		['a negative current turn', () => ({ ...validSnapshot(), current: -1 })],
		[
			'a current turn when there are no turns',
			() => ({ ...validSnapshot(), turns: [], current: 0 }),
		],
		['no current turn when there are turns', () => ({ ...validSnapshot(), current: null })],
		['a run id that is not text', () => withTurns([{ messages: [], parent: null, runId: 7 }])],
	];

	it.each(malformed)('rejects %s with an invalid snapshot error', (_name, build) => {
		expect(() => parseConversationSnapshot(build())).toThrow(InvalidAgentConfigError);
		expect(() => parseConversationSnapshot(build())).toThrow(/Invalid conversation snapshot/);
	});

	const unsupported: [string, unknown][] = [
		['version 2', { ...validSnapshot(), version: 2 }],
		['version 0', { ...validSnapshot(), version: 0 }],
		['the string "1"', { ...validSnapshot(), version: '1' }],
		['no version', without(validSnapshot(), 'version')],
		['version 2 with a payload that is malformed too', { version: 2, turns: 'nothing' }],
	];

	it.each(unsupported)('rejects %s before reading anything else', (_name, value) => {
		expect(() => parseConversationSnapshot(value)).toThrow(InvalidAgentConfigError);
		expect(() => parseConversationSnapshot(value)).toThrow(
			/Unsupported conversation snapshot version/,
		);
	});
});
