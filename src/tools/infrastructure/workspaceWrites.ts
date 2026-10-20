import type { RunContext } from '#src/agent/domain/runContext';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import { FileEditor } from './fileEditor.ts';
import type { FileFormatter } from './fileFormatter.ts';
import { WriteSession } from './writeSession.ts';

/**
 * The writing side of a workspace, shared by every write tool built over it: one policy and
 * one recovery store, and one `WriteSession` per run, ended with that run. A session lives
 * only as long as its run's context, so nothing here outlives a run.
 */
export class WorkspaceWrites {
	/** What the edit tools run on each file they create or change, when the consumer gave one. */
	readonly formatter: FileFormatter | undefined;
	private readonly policy: AccessPolicy;
	private readonly store: RecoveryStore;
	private readonly sessions = new WeakMap<RunContext, WriteSession>();

	constructor({
		policy,
		store,
		formatter,
	}: {
		policy: AccessPolicy;
		store: RecoveryStore;
		formatter?: FileFormatter;
	}) {
		this.policy = policy;
		this.store = store;
		this.formatter = formatter;
	}

	/** An editor over this run's session, created on the run's first write tool call. */
	editorFor(context: RunContext): FileEditor {
		return new FileEditor({ policy: this.policy, session: this.sessionFor(context) });
	}

	/** Everything this run writes, its commands' changes included, created on its first write. */
	sessionFor(context: RunContext): WriteSession {
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
		return session;
	}
}
