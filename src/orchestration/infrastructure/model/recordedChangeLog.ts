import type { RunOptions } from '#src/agent/domain/agent';
import { runContextOf } from '#src/agent/domain/runContext';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import { latestChange, showChanges } from '#src/recovery/domain/runChanges';
import { AccessDeniedError, type AccessPolicy } from '#src/tools/domain/accessPolicy';
import type { ChangeLog } from '../../domain/model/changeLog.ts';

// As `showChanges` gives the reviewer: a change read whole, not a rewrite of the repository.
const maxLines = 600;

/**
 * The run's changes from its record in the workspace's history, showing only what the policy
 * lets a role read: a secret the executor was allowed to write is counted, never shown.
 */
export class RecordedChangeLog implements ChangeLog {
	private readonly store: RecoveryStore;
	private readonly policy: AccessPolicy;

	constructor({ store, policy }: { store: RecoveryStore; policy: AccessPolicy }) {
		this.store = store;
		this.policy = policy;
	}

	async mark(options: RunOptions): Promise<number> {
		const runId = this.runIdOf(options);
		return runId === undefined ? 0 : latestChange(this.store, runId);
	}

	async since(mark: number, options: RunOptions): Promise<string> {
		const runId = this.runIdOf(options);
		if (runId === undefined) return '';
		return showChanges(this.store, runId, {
			since: mark,
			maxLines,
			visible: async path => {
				try {
					await this.policy.check(path, 'read', options.signal);
					return true;
				} catch (error) {
					if (error instanceof AccessDeniedError) return false;
					throw error;
				}
			},
		});
	}

	/** This history's run: the run may have written to another's too. */
	private runIdOf(options: RunOptions): string | undefined {
		return runContextOf(options)?.historyRunOf(this.store.workspaceId).runId;
	}
}
