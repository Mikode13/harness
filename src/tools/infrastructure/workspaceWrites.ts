import type { RunContext } from '#src/agent/domain/runContext';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import { FileEditor } from './fileEditor.ts';
import { WriteSession } from './writeSession.ts';

/**
 * The writing side of a workspace, shared by every write tool built over it: one policy and
 * one recovery store, and one `WriteSession` per run, ended with that run. A session lives
 * only as long as its run's context, so nothing here outlives a run.
 */
export class WorkspaceWrites {
	private readonly policy: AccessPolicy;
	private readonly store: RecoveryStore;
	private readonly sessions = new WeakMap<RunContext, WriteSession>();

	constructor({ policy, store }: { policy: AccessPolicy; store: RecoveryStore }) {
		this.policy = policy;
		this.store = store;
	}

	/** An editor over this run's session, created on the run's first write tool call. */
	editorFor(context: RunContext): FileEditor {
		let session = this.sessions.get(context);
		if (!session) {
			const created = new WriteSession({
				store: this.store,
				// So every turn of the run, in every role, can be tied to what it wrote.
				onStart: runId => {
					context.historyRun.runId = runId;
				},
				// A run that changed nothing is not in the history, so its turns wrote nothing.
				onDiscard: () => {
					delete context.historyRun.runId;
				},
			});
			context.onFinish(end => created.finish(end));
			this.sessions.set(context, created);
			session = created;
		}
		return new FileEditor({ policy: this.policy, session });
	}
}
