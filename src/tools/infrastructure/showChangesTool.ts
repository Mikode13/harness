import { z } from 'zod';
import type { RecoveryStore } from '#src/recovery/domain/recoveryStore';
import { showChanges } from '#src/recovery/domain/runChanges';
import type { AccessPolicy } from '../domain/accessPolicy.ts';
import type { PreparingTool } from '../domain/preparedCall.ts';
import { definePreparingTool } from './defineTool.ts';

// A reviewer reads a change whole, but not a rewrite of the whole repository.
const maxLines = 600;

const nothingYet = 'Nothing has been changed in this task yet.';

/**
 * `showChanges` for the planner and the reviewer: what the current task has changed so far, as a
 * diff per file, from the run's own record. It shows only what the role may read: a secret the
 * executor was allowed to write is counted, never shown.
 */
export function createShowChangesTool({
	store,
	policy,
}: {
	store: RecoveryStore;
	policy: AccessPolicy;
}): PreparingTool {
	return definePreparingTool({
		name: 'showChanges',
		description:
			'Shows what this task has changed in the repository so far, as a diff per file, in the order each file was first changed.',
		input: z.object({}),
		prepare: (_, __, { run }) =>
			Promise.resolve({
				risk: 'safe',
				run: async signal => {
					const { runId } = run.historyRun;
					if (runId === undefined) return nothingYet;
					const diff = await showChanges(store, runId, {
						maxLines,
						visible: path =>
							policy.check(path, 'read', signal).then(
								() => true,
								() => false,
							),
					});
					return diff === '' ? nothingYet : diff;
				},
			}),
	});
}
