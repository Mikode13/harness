import {
	InvalidSnapshotError,
	orchestratorRoles,
	sessionFormat,
	sessionVersions,
	UnsupportedSnapshotVersionError,
} from '#src/agent/domain/snapshot';
import type { RestoredConversation } from '#src/engines/domain/model/llmAgent';
import type { Session } from '#src/shared/domain/session';
import { readConversationSnapshot } from './conversationSnapshot.ts';

type OrchestratorRole = (typeof orchestratorRoles)[number];

/** What a `SessionSnapshot` of `createLLMOrchestrator` restores. */
export interface RestoredSession {
	session: Session;
	roles: Record<OrchestratorRole, RestoredConversation>;
}

const keys = ['format', 'version', 'flow', 'boundary', 'session', 'roles'];

/**
 * What `value`, a snapshot `createLLMOrchestrator`'s agent took and passed through JSON,
 * restores. Read before anything is built or opened, so a snapshot that cannot be restored fails
 * before any model or tool runs.
 *
 * @throws {UnsupportedSnapshotVersionError} for a session snapshot of another version, or a role
 * whose conversation is of another version.
 * @throws {InvalidSnapshotError} for anything else that is not a whole, valid snapshot of this
 * flow: another format, another flow, a boundary this release does not support, roles other than
 * the planner, the executor and the reviewer, or a role's conversation that cannot be restored.
 */
export function readSessionSnapshot(value: unknown): RestoredSession {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid('It is not an object.');
	}
	const snapshot = value as Record<string, unknown>;
	const { format, version, flow, boundary, session, roles } = snapshot;
	if (format !== sessionFormat) {
		throw invalid(
			`Its format is ${describe(format)}, not "${sessionFormat}": it is not a snapshot of a composed agent's session.`,
		);
	}
	// A version that is no whole number is no version a release could have written.
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		throw invalid(`Its version is ${describe(version)}, not a version number.`);
	}
	if (!(sessionVersions as readonly unknown[]).includes(version)) {
		throw new UnsupportedSnapshotVersionError(
			'The session snapshot is of a version this release cannot restore',
			{
				cause: `Its version is ${describe(version)}; this release restores version ${sessionVersions.join(', ')}. A later release of the harness may restore it.`,
				version,
			},
		);
	}
	const extra = Object.keys(snapshot).filter(key => !keys.includes(key));
	if (extra.length > 0) throw invalid(`It has keys its format does not: ${extra.join(', ')}.`);
	if (flow !== 'llm-orchestrator') {
		throw invalid(
			`It is a snapshot of ${describe(flow)}, not of createLLMOrchestrator's flow ("llm-orchestrator").`,
		);
	}
	if (boundary !== 'completed') {
		throw invalid(
			`It was taken at the boundary ${describe(boundary)}; this release restores only a session whose runs had all ended ("completed"), not a checkpoint inside a run.`,
		);
	}
	const restoredSession = readSession(session);
	if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) {
		throw invalid('Its roles are not an object.');
	}
	const named = Object.keys(roles).sort();
	const expected = [...orchestratorRoles].sort();
	if (named.join() !== expected.join()) {
		throw invalid(
			`Its roles are ${named.join(', ') || 'none'}; createLLMOrchestrator's are ${orchestratorRoles.join(', ')}.`,
		);
	}
	const byRole = roles as Record<OrchestratorRole, unknown>;
	const read = (role: OrchestratorRole): RestoredConversation => {
		try {
			return readConversationSnapshot(byRole[role]);
		} catch (error) {
			if (!(error instanceof InvalidSnapshotError)) throw error;
			const cause = `The ${role}'s conversation: ${error.cause}`;
			throw error instanceof UnsupportedSnapshotVersionError
				? new UnsupportedSnapshotVersionError(error.message, { cause, version: error.version })
				: new InvalidSnapshotError(error.message, { cause });
		}
	};
	return {
		session: restoredSession,
		roles: { planner: read('planner'), executor: read('executor'), reviewer: read('reviewer') },
	};
}

function readSession(value: unknown): Session {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid('Its session is not an object.');
	}
	const { id, name, ...rest } = value as Record<string, unknown>;
	if (typeof id !== 'string' || id.trim() === '') throw invalid('Its session has no id.');
	if (name !== undefined && typeof name !== 'string') {
		throw invalid("Its session's name is not text.");
	}
	if (Object.keys(rest).length > 0) {
		throw invalid(`Its session has keys a session does not: ${Object.keys(rest).join(', ')}.`);
	}
	// A blank name is none, as `RunOptions.session` takes it.
	return name === undefined || name.trim() === '' ? { id } : { id, name };
}

function invalid(cause: string): InvalidSnapshotError {
	return new InvalidSnapshotError('The session snapshot cannot be restored', { cause });
}

function describe(value: unknown): string {
	return value === undefined ? 'missing' : JSON.stringify(value);
}
