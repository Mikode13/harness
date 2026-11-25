import { describe, expect, it } from 'vitest';
import {
	type ConversationSnapshot,
	parseConversationSnapshot,
} from '../../src/llm/domain/conversationSnapshot.ts';
import type { Message } from '../../src/llm/domain/message.ts';
import {
	type AuxiliaryRecord,
	type ComposedSessionSnapshot,
	parseComposedSessionSnapshot,
} from '../../src/orchestration/domain/model/composedSessionSnapshot.ts';
import { InvalidAgentConfigError } from '../../src/shared/domain/errors.ts';

/** A JSON object, as a consumer reads a snapshot off disk before any check. */
type Json = Record<string, unknown>;

const user = (value: string): Message => ({
	role: 'user',
	content: [{ type: 'text', text: value }],
});
const assistant = (value: string): Message => ({
	role: 'assistant',
	content: [{ type: 'text', text: value }],
});

/** A version 1 conversation as JSON: one initial message, and one turn answering it. */
function conversationJson(text: string): Json {
	return {
		version: 1,
		initial: [user(text)],
		turns: [{ messages: [assistant(`Answer to ${text}.`)], parent: null, runId: null }],
		current: 0,
		seenRevision: 1,
		contextTokens: 100,
	};
}

/** The conversation `conversationJson(text)` parses to. */
function conversation(text: string): ConversationSnapshot {
	return parseConversationSnapshot(conversationJson(text));
}

/** A conversation with nothing in it, as JSON. */
function emptyConversationJson(): Json {
	return {
		version: 1,
		initial: [],
		turns: [],
		current: null,
		seenRevision: 0,
		contextTokens: null,
	};
}

/** A model agent record as JSON: its conversation holds `text`, and it completed `children`. */
function agentJson(text: string, children: Json[] = []): Json {
	return { conversation: conversationJson(text), children };
}

/** A subagent origin as JSON: a planner's explorer subagent number 1 of call `call-1`, with `overrides`. */
function originJson(overrides: Json = {}): Json {
	return {
		role: 'planner',
		tool: 'explore',
		name: 'explorer',
		callId: 'call-1',
		subagent: 1,
		task: 'Find the parser.',
		outcome: 'answered',
		...overrides,
	};
}

/** A completed subagent as JSON, started by call `callId`, whose agent's conversation holds `callId`. */
function childJson(callId: string, overrides: Json = {}, children: Json[] = []): Json {
	return {
		origin: originJson({ callId, ...overrides }),
		agent: agentJson(callId, children),
	};
}

/** A committer record as JSON: the committer that wrote `repository`'s message in commit attempt `attempt`. */
function committerJson(attempt: number, repository = 'repo-a'): Json {
	return {
		origin: { role: 'committer', attempt, repository },
		agent: agentJson(`committer ${repository}`),
	};
}

/** A whole session as JSON: the planner has a subagent tree, and one commit attempt ran. */
function sessionJson(): Json {
	return {
		version: 1,
		kind: 'llmOrchestrator',
		roles: {
			planner: agentJson('planner', [childJson('call-1', {}, [childJson('call-2')])]),
			executor: agentJson('executor'),
			reviewer: agentJson('reviewer'),
		},
		auxiliary: [committerJson(1)],
	};
}

/** A session as JSON whose planner completed `children`, with the rest as `sessionJson` has them. */
function sessionWithPlannerChildren(children: Json[]): Json {
	return {
		...sessionJson(),
		roles: {
			planner: agentJson('planner', children),
			executor: agentJson('executor'),
			reviewer: agentJson('reviewer'),
		},
	};
}

/** The snapshot after a trip through JSON text, as a consumer persists and reads it. */
function persisted(snapshot: ComposedSessionSnapshot): ComposedSessionSnapshot {
	return parseComposedSessionSnapshot(JSON.parse(JSON.stringify(snapshot)));
}

/** The planner record of `raw`, as JSON, so a test can change one part of it. */
function plannerOf(raw: Json): Json {
	return (raw.roles as Json).planner as Json;
}

describe('a composed session snapshot, version 1', () => {
	it('round-trips through JSON to the same snapshot', () => {
		const snapshot = parseComposedSessionSnapshot(sessionJson());

		expect(persisted(snapshot)).toEqual(snapshot);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(sessionJson());
	});

	it('keeps the conversation of each role on its own', () => {
		const snapshot = persisted(parseComposedSessionSnapshot(sessionJson()));

		expect(snapshot.roles.planner.conversation).toEqual(conversation('planner'));
		expect(snapshot.roles.executor.conversation).toEqual(conversation('executor'));
		expect(snapshot.roles.reviewer.conversation).toEqual(conversation('reviewer'));
	});

	it('keeps nested delegation trees, each child under the record that started it', () => {
		const snapshot = persisted(parseComposedSessionSnapshot(sessionJson()));
		const [first] = snapshot.roles.planner.children;
		const [nested] = first?.agent.children ?? [];

		expect(snapshot.roles.planner.children.map(child => child.origin.callId)).toEqual(['call-1']);
		expect(nested?.origin).toEqual({
			role: 'planner',
			tool: 'explore',
			name: 'explorer',
			callId: 'call-2',
			subagent: 1,
			task: 'Find the parser.',
			outcome: 'answered',
		});
		expect(nested?.agent.conversation).toEqual(conversation('call-2'));
	});

	it('keeps the outcome of each child: answered, failed or stopped', () => {
		const snapshot = parseComposedSessionSnapshot(
			sessionWithPlannerChildren([
				childJson('call-1', { outcome: 'answered' }),
				childJson('call-2', { outcome: 'failed' }),
				childJson('call-3', { outcome: 'stopped' }),
			]),
		);

		expect(snapshot.roles.planner.children.map(child => child.origin.outcome)).toEqual([
			'answered',
			'failed',
			'stopped',
		]);
	});

	it('accepts an empty list of auxiliary records, and an auxiliary record with nothing in it', () => {
		expect(parseComposedSessionSnapshot({ ...sessionJson(), auxiliary: [] }).auxiliary).toEqual([]);

		const snapshot = parseComposedSessionSnapshot({
			...sessionJson(),
			auxiliary: [
				{
					origin: { role: 'committer', attempt: 1, repository: 'repo-a' },
					agent: { conversation: emptyConversationJson(), children: [] },
				},
			],
		});

		expect(snapshot.auxiliary).toEqual([
			{
				origin: { role: 'committer', attempt: 1, repository: 'repo-a' },
				agent: { conversation: parseConversationSnapshot(emptyConversationJson()), children: [] },
			},
		]);
	});

	it('accepts one committer per repository in one commit attempt, and later attempts for the same repository', () => {
		const snapshot = parseComposedSessionSnapshot({
			...sessionJson(),
			auxiliary: [
				committerJson(1, 'repo-a'),
				committerJson(1, 'repo-b'),
				committerJson(2, 'repo-a'),
			],
		});

		expect(
			snapshot.auxiliary.map(record => [record.origin.attempt, record.origin.repository]),
		).toEqual([
			[1, 'repo-a'],
			[1, 'repo-b'],
			[2, 'repo-a'],
		]);
		expect(persisted(snapshot)).toEqual(snapshot);
	});

	it('keeps subagents that share a call when their numbers differ', () => {
		const snapshot = parseComposedSessionSnapshot(
			sessionWithPlannerChildren([
				childJson('call-1', { subagent: 1 }),
				childJson('call-1', { subagent: 2 }),
			]),
		);

		expect(snapshot.roles.planner.children.map(child => child.origin.subagent)).toEqual([1, 2]);
	});

	it('rejects fields that are not exactly the fields of version 1', () => {
		expect(() => parseComposedSessionSnapshot({ ...sessionJson(), extra: true })).toThrow(
			'Invalid composed session snapshot: the snapshot has an unknown field "extra"',
		);

		const missingRoles = sessionJson();
		delete missingRoles.roles;
		expect(() => parseComposedSessionSnapshot(missingRoles)).toThrow(
			'Invalid composed session snapshot: the snapshot is missing "roles"',
		);

		const extraRole = sessionJson();
		(extraRole.roles as Json).coordinator = agentJson('coordinator');
		expect(() => parseComposedSessionSnapshot(extraRole)).toThrow(
			'roles has an unknown field "coordinator"',
		);

		const missingReviewer = sessionJson();
		delete (missingReviewer.roles as Json).reviewer;
		expect(() => parseComposedSessionSnapshot(missingReviewer)).toThrow(
			'roles is missing "reviewer"',
		);

		expect(() =>
			parseComposedSessionSnapshot(
				sessionWithPlannerChildren([{ ...childJson('call-1'), extra: true }]),
			),
		).toThrow('has an unknown field "extra"');

		expect(() =>
			parseComposedSessionSnapshot(
				sessionWithPlannerChildren([childJson('call-1', { extra: true })]),
			),
		).toThrow('origin has an unknown field "extra"');

		const missingTask = childJson('call-1');
		delete (missingTask.origin as Json).task;
		expect(() => parseComposedSessionSnapshot(sessionWithPlannerChildren([missingTask]))).toThrow(
			'origin is missing "task"',
		);

		expect(() =>
			parseComposedSessionSnapshot({
				...sessionJson(),
				auxiliary: [
					{
						origin: { role: 'committer', attempt: 1, repository: 'repo-a', extra: true },
						agent: agentJson('c'),
					},
				],
			}),
		).toThrow('origin has an unknown field "extra"');

		const missingRepository = committerJson(1);
		delete (missingRepository.origin as Json).repository;
		expect(() =>
			parseComposedSessionSnapshot({ ...sessionJson(), auxiliary: [missingRepository] }),
		).toThrow('origin is missing "repository"');
	});

	it('rejects a committer record whose repository is empty', () => {
		expect(() =>
			parseComposedSessionSnapshot({
				...sessionJson(),
				auxiliary: [committerJson(1, '')],
			}),
		).toThrow('origin.repository must not be empty');
	});

	it('rejects a child outcome that is not answered, failed or stopped', () => {
		expect(() =>
			parseComposedSessionSnapshot(
				sessionWithPlannerChildren([childJson('call-1', { outcome: 'done' })]),
			),
		).toThrow('origin.outcome must be answered, failed or stopped');
	});

	it.each([0, 1.5, -1, '1', null])('rejects a subagent number of %s', subagent => {
		expect(() =>
			parseComposedSessionSnapshot(sessionWithPlannerChildren([childJson('call-1', { subagent })])),
		).toThrow('origin.subagent must be a whole number, 1 or more');
	});

	it.each([0, 2.5, '1', null])('rejects a commit attempt of %s', attempt => {
		expect(() =>
			parseComposedSessionSnapshot({
				...sessionJson(),
				auxiliary: [
					{ origin: { role: 'committer', attempt, repository: 'repo-a' }, agent: agentJson('c') },
				],
			}),
		).toThrow('origin.attempt must be a whole number, 1 or more');
	});

	it('rejects two records with the same origin', () => {
		expect(() =>
			parseComposedSessionSnapshot(
				sessionWithPlannerChildren([
					childJson('call-1', { subagent: 1 }),
					childJson('call-1', { subagent: 1 }),
				]),
			),
		).toThrow('repeats the origin of another record in the snapshot');

		expect(() =>
			parseComposedSessionSnapshot({
				...sessionJson(),
				auxiliary: [committerJson(1, 'repo-a'), committerJson(1, 'repo-a')],
			}),
		).toThrow('repeats the origin of another record in the snapshot');

		expect(() =>
			parseComposedSessionSnapshot({
				...sessionJson(),
				auxiliary: [
					committerJson(1, 'repo-a'),
					committerJson(1, 'repo-b'),
					committerJson(1, 'repo-b'),
				],
			}),
		).toThrow('repeats the origin of another record in the snapshot');
	});

	it('reads the value as plain data before it reads the version, so a getter does not run', () => {
		const raw = sessionJson();
		let reads = 0;
		for (const key of ['version', 'kind']) {
			Object.defineProperty(raw, key, {
				get: () => {
					reads += 1;
					return key === 'version' ? 1 : 'llmOrchestrator';
				},
				enumerable: true,
			});
		}

		expect(() => parseComposedSessionSnapshot(raw)).toThrow(
			'the snapshot must hold only data fields with string names',
		);
		expect(reads).toBe(0);
	});

	it('rejects a child whose role is not the role of the record it sits under', () => {
		expect(() =>
			parseComposedSessionSnapshot(
				sessionWithPlannerChildren([childJson('call-1', { role: 'executor' })]),
			),
		).toThrow('origin.role must be planner, the role of the record it sits under');
	});

	it('reports the version before any other field, then the kind', () => {
		expect(() =>
			parseComposedSessionSnapshot({ version: 2, kind: 'other', roles: 'bad', auxiliary: 'bad' }),
		).toThrow('Unsupported composed session snapshot version: 2; this harness reads version 1');

		expect(() => parseComposedSessionSnapshot({ kind: 'llmOrchestrator', roles: 'bad' })).toThrow(
			'Unsupported composed session snapshot version: missing',
		);

		expect(() => parseComposedSessionSnapshot({ version: 1, kind: 'other', roles: 'bad' })).toThrow(
			'Invalid composed session snapshot: kind must be llmOrchestrator',
		);
	});

	it('rejects a value that is not a plain object of JSON data', () => {
		expect(() => parseComposedSessionSnapshot(null)).toThrow(
			'Invalid composed session snapshot: the snapshot must be an object',
		);
		expect(() => parseComposedSessionSnapshot([])).toThrow('the snapshot must be an object');

		class Snapshot {
			readonly version = 1;
			readonly kind = 'llmOrchestrator';
			readonly roles = {};
			readonly auxiliary = [];
		}
		expect(() => parseComposedSessionSnapshot(new Snapshot())).toThrow(
			'the snapshot must be plain data, not an instance of a class',
		);

		const accessor = sessionJson();
		Object.defineProperty(accessor, 'extra', { get: () => 1, enumerable: true });
		expect(() => parseComposedSessionSnapshot(accessor)).toThrow(
			'the snapshot must hold only data fields with string names',
		);
	});

	it('rejects a conversation of another version, as the conversation parser does', () => {
		const raw = sessionJson();
		(plannerOf(raw).conversation as Json).version = 2;

		expect(() => parseComposedSessionSnapshot(raw)).toThrow(
			'Unsupported conversation snapshot version: 2; this harness reads version 1',
		);
	});

	it('returns a copy that shares nothing with the value it was parsed from', () => {
		const raw = sessionJson();
		const snapshot = parseComposedSessionSnapshot(raw);
		const expected = persisted(snapshot);

		plannerOf(raw).children = [];
		(plannerOf(raw).conversation as Json).initial = [];

		expect(snapshot).toEqual(expected);
	});

	it('keeps the value it was parsed from unchanged when a returned snapshot is changed', () => {
		const raw = sessionJson();
		const first = parseComposedSessionSnapshot(raw);
		(first.roles.planner.conversation.initial as Message[]).push(user('added'));
		(first.auxiliary as AuxiliaryRecord[]).length = 0;

		const second = parseComposedSessionSnapshot(raw);

		expect(second.roles.planner.conversation).toEqual(conversation('planner'));
		expect(second.auxiliary).toHaveLength(1);
	});

	it('throws the configuration error type for every rejected snapshot', () => {
		expect(() => parseComposedSessionSnapshot({ version: 2 })).toThrow(InvalidAgentConfigError);
		expect(() =>
			parseComposedSessionSnapshot(sessionWithPlannerChildren([childJson('c', { outcome: 'x' })])),
		).toThrow(InvalidAgentConfigError);
	});
});
