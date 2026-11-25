import { InvalidAgentConfigError } from '#src/shared/domain/errors';
import type { Message, MessagePart } from './message.ts';

/**
 * A conversation as plain JSON data, version 1: what the next run needs to go on with the same
 * context. It holds the prompts, file contents and command output the conversation holds, so it
 * is as sensitive as they are. Every value is JSON and an absent one is `null`, never `undefined`,
 * so the snapshot survives `JSON.stringify` and `JSON.parse` unchanged.
 */
export interface ConversationSnapshot {
	readonly version: 1;
	/** The messages the conversation starts with, before any of its turns. */
	readonly initial: readonly Message[];
	/** Every turn recorded, oldest first. */
	readonly turns: readonly SnapshotTurn[];
	/** The turn the next one follows by default, or `null` when there are no turns. */
	readonly current: number | null;
	/** The last history revision the conversation followed. */
	readonly seenRevision: number;
	/** The tokens of context the model was last sent in a kept run, or `null` when not known. */
	readonly contextTokens: number | null;
}

/** One recorded turn: its messages, the earlier turn it followed and the history run it belongs to. */
export interface SnapshotTurn {
	readonly messages: readonly Message[];
	/** The index of the earlier turn it followed, or `null` for one that followed only the initial messages. */
	readonly parent: number | null;
	/** The history run it belongs to, or `null` when that run wrote nothing. */
	readonly runId: string | null;
}

/** The conversation's own part of a snapshot: what `Conversation` captures and restores. */
export type ConversationState = Pick<ConversationSnapshot, 'initial' | 'turns' | 'current'>;

const roles = ['user', 'assistant', 'tool'] as const;
const snapshotFields = ['version', 'initial', 'turns', 'current', 'seenRevision', 'contextTokens'];

/**
 * Checks `value` as a version 1 conversation snapshot and returns a copy that shares nothing with
 * it. The version is checked before anything else, so a snapshot of another version is reported
 * as one, whatever else it holds.
 *
 * @throws {InvalidAgentConfigError} when `value` is not a version 1 snapshot, naming what is wrong.
 */
export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
	const record = plainObject(value, 'the snapshot');
	if (record.version !== 1) {
		throw new InvalidAgentConfigError(
			`Unsupported conversation snapshot version: ${versionText(record.version)}; this harness reads version 1`,
		);
	}
	exactFields(record, 'the snapshot', snapshotFields);
	const turns = turnsOf(record.turns);
	return {
		version: 1,
		initial: messagesOf(record.initial, 'initial'),
		turns,
		current: currentOf(record.current, turns.length),
		seenRevision: wholeOf(record.seenRevision, 'seenRevision'),
		contextTokens:
			record.contextTokens === null ? null : wholeOf(record.contextTokens, 'contextTokens'),
	};
}

function invalid(problem: string): InvalidAgentConfigError {
	return new InvalidAgentConfigError(`Invalid conversation snapshot: ${problem}`);
}

function versionText(version: unknown): string {
	if (version === undefined) return 'missing';
	if (typeof version === 'string' || typeof version === 'number') return String(version);
	return typeof version;
}

/** `value` as an object of plain data fields, or an error naming `path`. */
function plainObject(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid(`${path} must be an object`);
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw invalid(`${path} must be plain data, not an instance of a class`);
	}
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
			throw invalid(`${path} must hold only data fields with string names`);
		}
	}
	return value as Record<string, unknown>;
}

/** Checks that `record` has exactly `names` as its fields, so an unknown field is an error. */
function exactFields(
	record: Record<string, unknown>,
	path: string,
	names: readonly string[],
): void {
	for (const key of Object.getOwnPropertyNames(record)) {
		if (!names.includes(key)) throw invalid(`${path} has an unknown field "${key}"`);
	}
	for (const name of names) {
		if (!Object.hasOwn(record, name)) throw invalid(`${path} is missing "${name}"`);
	}
}

/** The items of a list, copied out, so that a hole in it reads as a missing item. */
function listOf(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw invalid(`${path} must be a list`);
	return Array.from(value as unknown[]);
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
	return options.some(option => option === value);
}

function stringOf(value: unknown, path: string): string {
	if (typeof value !== 'string') throw invalid(`${path} must be a string`);
	return value;
}

function nullableText(value: unknown, path: string): string | null {
	return value === null ? null : stringOf(value, path);
}

function booleanOf(value: unknown, path: string): boolean {
	if (typeof value !== 'boolean') throw invalid(`${path} must be true or false`);
	return value;
}

function wholeOf(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw invalid(`${path} must be a whole number, zero or more`);
	}
	return value;
}

function currentOf(value: unknown, turnCount: number): number | null {
	if (value === null && turnCount === 0) return null;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < turnCount) {
		return value;
	}
	throw invalid(
		turnCount === 0
			? 'current must be null when there are no turns'
			: 'current must be the index of one of the turns',
	);
}

function turnsOf(value: unknown): SnapshotTurn[] {
	return listOf(value, 'turns').map((item, index) => {
		const path = `turns[${String(index)}]`;
		const record = plainObject(item, path);
		exactFields(record, path, ['messages', 'parent', 'runId']);
		return {
			messages: messagesOf(record.messages, `${path}.messages`),
			parent: parentOf(record.parent, index, path),
			runId: nullableText(record.runId, `${path}.runId`),
		};
	});
}

/** A turn follows an earlier one. A parent at or after its own turn would make a cycle. */
function parentOf(value: unknown, index: number, path: string): number | null {
	if (value === null) return null;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= index) {
		throw invalid(
			`${path}.parent must be null or the index of an earlier turn; a parent at or after its own turn would make a cycle`,
		);
	}
	return value;
}

function messagesOf(value: unknown, path: string): Message[] {
	return listOf(value, path).map((item, index) => messageOf(item, `${path}[${String(index)}]`));
}

function messageOf(value: unknown, path: string): Message {
	const record = plainObject(value, path);
	exactFields(record, path, ['role', 'content']);
	const role = record.role;
	if (!isOneOf(roles, role)) throw invalid(`${path}.role must be user, assistant or tool`);
	return { role, content: partsOf(record.content, `${path}.content`) };
}

function partsOf(value: unknown, path: string): MessagePart[] {
	return listOf(value, path).map((item, index) => partOf(item, `${path}[${String(index)}]`));
}

function partOf(value: unknown, path: string): MessagePart {
	const record = plainObject(value, path);
	switch (record.type) {
		case 'text':
			exactFields(record, path, ['type', 'text']);
			return { type: 'text', text: stringOf(record.text, `${path}.text`) };
		case 'reasoning':
			exactFields(record, path, ['type', 'text']);
			return { type: 'reasoning', text: stringOf(record.text, `${path}.text`) };
		case 'toolCall':
			exactFields(record, path, ['type', 'id', 'name', 'input']);
			return {
				type: 'toolCall',
				id: stringOf(record.id, `${path}.id`),
				name: stringOf(record.name, `${path}.name`),
				input: jsonOf(record.input, `${path}.input`),
			};
		case 'toolResult':
			exactFields(record, path, ['type', 'callId', 'name', 'output', 'isError']);
			return {
				type: 'toolResult',
				callId: stringOf(record.callId, `${path}.callId`),
				name: stringOf(record.name, `${path}.name`),
				output: stringOf(record.output, `${path}.output`),
				isError: booleanOf(record.isError, `${path}.isError`),
			};
		case 'providerData':
			exactFields(record, path, ['type', 'source', 'data']);
			return {
				type: 'providerData',
				source: stringOf(record.source, `${path}.source`),
				data: jsonOf(record.data, `${path}.data`),
			};
		case 'compaction':
			exactFields(record, path, ['type', 'source', 'data']);
			return {
				type: 'compaction',
				source: stringOf(record.source, `${path}.source`),
				data: jsonOf(record.data, `${path}.data`),
			};
		case 'contextSummary':
			exactFields(record, path, ['type', 'summary', 'kept']);
			return {
				type: 'contextSummary',
				summary: stringOf(record.summary, `${path}.summary`),
				kept: messagesOf(record.kept, `${path}.kept`),
			};
		default:
			throw invalid(
				`${path}.type must be text, reasoning, toolCall, toolResult, providerData, compaction or contextSummary`,
			);
	}
}

/**
 * `value` as JSON data, copied: what `JSON.parse` could have produced, and nothing else. A cycle
 * or a value JSON would lose or change, such as `undefined`, a class instance or `NaN`, is an error.
 */
function jsonOf(value: unknown, path: string, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw invalid(`${path} must be a finite number`);
		return value;
	}
	if (typeof value !== 'object') throw invalid(`${path} must be JSON data; got ${typeof value}`);
	if (ancestors.has(value)) throw invalid(`${path} contains itself`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const items = value as unknown[];
			return Array.from({ length: items.length }, (_, index) =>
				jsonOf(items[index], `${path}[${String(index)}]`, ancestors),
			);
		}
		const record = plainObject(value, path);
		return Object.fromEntries(
			Object.keys(record).map((key): [string, unknown] => [
				key,
				jsonOf(record[key], `${path}.${key}`, ancestors),
			]),
		);
	} finally {
		ancestors.delete(value);
	}
}
