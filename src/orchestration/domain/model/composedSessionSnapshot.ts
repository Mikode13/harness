import {
	type ConversationSnapshot,
	parseConversationSnapshot,
} from '#src/llm/domain/conversationSnapshot';
import { InvalidAgentConfigError } from '#src/shared/domain/errors';

/** The roles an agent in a composed session can hold: the three of the orchestrator, and the committer. */
export type AgentRole = RootRole | 'committer';

/** The three roles of the orchestrator. Each has one conversation that lasts the whole session. */
export type RootRole = 'planner' | 'executor' | 'reviewer';

/** How a subagent ended: it answered, failed, or was stopped. */
export type ChildOutcome = 'answered' | 'failed' | 'stopped';

/**
 * A composed LLM orchestrator session as plain JSON data, version 1: the captured state of each
 * role, and of the auxiliary agents that ran outside the roles. It holds the prompts, file contents
 * and command output its conversations hold, so it is as sensitive as they are. Every value is JSON
 * and an absent one is `null`, so the snapshot survives `JSON.stringify` and `JSON.parse` unchanged.
 */
export interface ComposedSessionSnapshot {
	readonly version: 1;
	readonly kind: 'llmOrchestrator';
	readonly roles: ComposedRoles;
	/**
	 * The auxiliary agents that ran: one record per committer run, by its commit attempt and
	 * repository. Empty when none ran.
	 */
	readonly auxiliary: readonly AuxiliaryRecord[];
}

/** The root record of each role. */
export interface ComposedRoles {
	readonly planner: ModelAgentRecord;
	readonly executor: ModelAgentRecord;
	readonly reviewer: ModelAgentRecord;
}

/** One agent's captured state: its own conversation, and the subagents it completed. */
export interface ModelAgentRecord {
	readonly conversation: ConversationSnapshot;
	readonly children: readonly ChildRecord[];
}

/** A completed subagent: the call that started it, and the agent it ran. */
export interface ChildRecord {
	readonly origin: ChildOrigin;
	readonly agent: ModelAgentRecord;
}

/**
 * Where a subagent came from. Subagent numbers count from 1 within their call, so a subagent is
 * identified by its role, its call ID and its number. No two records in a snapshot share one.
 */
export interface ChildOrigin {
	/** The role whose work the subagent was part of: the role of the record it sits under. */
	readonly role: AgentRole;
	/** The tool whose call started the subagent. */
	readonly tool: string;
	/** The name the subagent ran under. */
	readonly name: string;
	/** The ID of the call that started the subagent. */
	readonly callId: string;
	/** The subagent's number within its call, a whole number from 1. */
	readonly subagent: number;
	/** The task the subagent was given. */
	readonly task: string;
	readonly outcome: ChildOutcome;
}

/** An agent that ran outside the roles, such as the committer for one repository in one commit attempt. */
export interface AuxiliaryRecord {
	readonly origin: AuxiliaryOrigin;
	readonly agent: ModelAgentRecord;
}

/**
 * Which auxiliary agent ran. One commit attempt writes one commit message per ready repository, and
 * each message is written by a fresh committer, so an agent is identified by its attempt and its
 * repository. No two records in a snapshot share both.
 */
export interface AuxiliaryOrigin {
	readonly role: 'committer';
	/**
	 * The commit attempt the agent ran for, a whole number from 1. Attempts are counted across the
	 * whole session, not per run, so a number never repeats within a snapshot, including one that
	 * appends the attempts of a restored session.
	 */
	readonly attempt: number;
	/** The repository whose commit message the agent wrote: a non-empty name. */
	readonly repository: string;
}

const rootRoles: readonly RootRole[] = ['planner', 'executor', 'reviewer'];
const outcomes: readonly ChildOutcome[] = ['answered', 'failed', 'stopped'];
const snapshotFields = ['version', 'kind', 'roles', 'auxiliary'];
const agentFields = ['conversation', 'children'];
const childFields = ['origin', 'agent'];
const childOriginFields = ['role', 'tool', 'name', 'callId', 'subagent', 'task', 'outcome'];
const auxiliaryFields = ['origin', 'agent'];
const auxiliaryOriginFields = ['role', 'attempt', 'repository'];

/**
 * Checks `value` as a version 1 composed session snapshot and returns a copy that shares nothing
 * with it. The value is confirmed as plain data first, so no getter runs during validation. Then the
 * version and kind are checked before any other field, so a snapshot of another version is reported
 * as one, whatever else it holds. Each conversation is checked by `parseConversationSnapshot`.
 *
 * @throws {InvalidAgentConfigError} when `value` is not a version 1 composed session snapshot,
 * naming what is wrong.
 */
export function parseComposedSessionSnapshot(value: unknown): ComposedSessionSnapshot {
	const record = plainObject(value, 'the snapshot');
	if (record.version !== 1) {
		throw new InvalidAgentConfigError(
			`Unsupported composed session snapshot version: ${versionText(record.version)}; this harness reads version 1`,
		);
	}
	if (record.kind !== 'llmOrchestrator') throw invalid('kind must be llmOrchestrator');
	exactFields(record, 'the snapshot', snapshotFields);
	const seen = new Set<string>();
	return {
		version: 1,
		kind: 'llmOrchestrator',
		roles: rolesOf(record.roles, seen),
		auxiliary: auxiliaryOf(record.auxiliary, seen),
	};
}

function invalid(problem: string): InvalidAgentConfigError {
	return new InvalidAgentConfigError(`Invalid composed session snapshot: ${problem}`);
}

function versionText(version: unknown): string {
	if (version === undefined) return 'missing';
	if (typeof version === 'string' || typeof version === 'number') return String(version);
	return typeof version;
}

/** `value` as an object, or an error naming `path`. */
function objectOf(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

/** `record` as plain data: a plain object whose own fields are all data fields with string names. */
function plainData(record: Record<string, unknown>, path: string): Record<string, unknown> {
	const prototype: unknown = Object.getPrototypeOf(record);
	if (prototype !== Object.prototype && prototype !== null) {
		throw invalid(`${path} must be plain data, not an instance of a class`);
	}
	for (const key of Reflect.ownKeys(record)) {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) {
			throw invalid(`${path} must hold only data fields with string names`);
		}
	}
	return record;
}

/** `value` as an object of plain data fields, or an error naming `path`. */
function plainObject(value: unknown, path: string): Record<string, unknown> {
	return plainData(objectOf(value, path), path);
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

function nonEmptyStringOf(value: unknown, path: string): string {
	const text = stringOf(value, path);
	if (text.length === 0) throw invalid(`${path} must not be empty`);
	return text;
}

/** A whole number from 1, such as a subagent's number within its call or a commit attempt. */
function numberFromOne(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw invalid(`${path} must be a whole number, 1 or more`);
	}
	return value;
}

/** Records `key` as the origin of a record in the snapshot, or fails when another record has it. */
function claim(seen: Set<string>, key: string, path: string): void {
	if (seen.has(key)) throw invalid(`${path} repeats the origin of another record in the snapshot`);
	seen.add(key);
}

function rolesOf(value: unknown, seen: Set<string>): ComposedRoles {
	const record = plainObject(value, 'roles');
	exactFields(record, 'roles', rootRoles);
	return {
		planner: agentOf(record.planner, 'roles.planner', 'planner', seen),
		executor: agentOf(record.executor, 'roles.executor', 'executor', seen),
		reviewer: agentOf(record.reviewer, 'roles.reviewer', 'reviewer', seen),
	};
}

function agentOf(
	value: unknown,
	path: string,
	role: AgentRole,
	seen: Set<string>,
): ModelAgentRecord {
	const record = plainObject(value, path);
	exactFields(record, path, agentFields);
	return {
		conversation: parseConversationSnapshot(record.conversation),
		children: listOf(record.children, `${path}.children`).map((item, index) =>
			childOf(item, `${path}.children[${String(index)}]`, role, seen),
		),
	};
}

function childOf(value: unknown, path: string, role: AgentRole, seen: Set<string>): ChildRecord {
	const record = plainObject(value, path);
	exactFields(record, path, childFields);
	const origin = childOriginOf(record.origin, `${path}.origin`, role);
	claim(seen, JSON.stringify(['child', role, origin.callId, origin.subagent]), `${path}.origin`);
	return { origin, agent: agentOf(record.agent, `${path}.agent`, role, seen) };
}

function childOriginOf(value: unknown, path: string, role: AgentRole): ChildOrigin {
	const record = plainObject(value, path);
	exactFields(record, path, childOriginFields);
	if (record.role !== role) {
		throw invalid(`${path}.role must be ${role}, the role of the record it sits under`);
	}
	return {
		role,
		tool: stringOf(record.tool, `${path}.tool`),
		name: stringOf(record.name, `${path}.name`),
		callId: stringOf(record.callId, `${path}.callId`),
		subagent: numberFromOne(record.subagent, `${path}.subagent`),
		task: stringOf(record.task, `${path}.task`),
		outcome: outcomeOf(record.outcome, `${path}.outcome`),
	};
}

function outcomeOf(value: unknown, path: string): ChildOutcome {
	if (!isOneOf(outcomes, value)) throw invalid(`${path} must be answered, failed or stopped`);
	return value;
}

function auxiliaryOf(value: unknown, seen: Set<string>): AuxiliaryRecord[] {
	return listOf(value, 'auxiliary').map((item, index) => {
		const path = `auxiliary[${String(index)}]`;
		const record = plainObject(item, path);
		exactFields(record, path, auxiliaryFields);
		const origin = auxiliaryOriginOf(record.origin, `${path}.origin`);
		claim(seen, JSON.stringify(['committer', origin.attempt, origin.repository]), `${path}.origin`);
		return { origin, agent: agentOf(record.agent, `${path}.agent`, origin.role, seen) };
	});
}

function auxiliaryOriginOf(value: unknown, path: string): AuxiliaryOrigin {
	const record = plainObject(value, path);
	exactFields(record, path, auxiliaryOriginFields);
	if (record.role !== 'committer') throw invalid(`${path}.role must be committer`);
	return {
		role: 'committer',
		attempt: numberFromOne(record.attempt, `${path}.attempt`),
		repository: nonEmptyStringOf(record.repository, `${path}.repository`),
	};
}
