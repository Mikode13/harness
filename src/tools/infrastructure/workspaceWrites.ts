import type { RunContext } from '#src/agent/domain/runContext';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import { FileEditor } from './fileEditor.ts';
import type { FileFormatter } from './fileFormatter.ts';
import { WriteSession } from './writeSession.ts';

// One session per run and history on disk, whichever set of tools asks for it: two sets built
// apart over one workspace, such as two stages of a workflow, record one run. Each keeps its own
// policy. Kept by the run's context, so nothing here outlives a run.
const sessions = new WeakMap<RunContext, Map<string, WriteSession>>();

/**
 * The writing side of a workspace, shared by every write tool built over it: one policy and
 * one recovery store. Every set of tools over the same history shares the run's `WriteSession`,
 * ended with that run.
 */
export class WorkspaceWrites {
	/** What the edit tools run on each file they create or change, when the consumer gave one. */
	readonly formatter: FileFormatter | undefined;
	private readonly policy: AccessPolicy;
	private readonly store: RecoveryStore;

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

	/** An editor over this run's session, under this set of tools' policy. */
	editorFor(context: RunContext): FileEditor {
		return new FileEditor({ policy: this.policy, session: this.sessionFor(context) });
	}

	/**
	 * Everything this run writes to this history, its commands' changes included, from any set of
	 * tools. Created on its first write, and registered before anything is awaited, so two tools
	 * asking at once get the same one.
	 */
	sessionFor(context: RunContext): WriteSession {
		let ofRun = sessions.get(context);
		if (!ofRun) {
			ofRun = new Map();
			sessions.set(context, ofRun);
		}
		let session = ofRun.get(this.store.workspaceId);
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
			ofRun.set(this.store.workspaceId, created);
			session = created;
		}
		return session;
	}
}
