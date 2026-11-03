import type { CommitReport } from './commitReport.ts';

/**
 * Where a required check stands, for the files as they are now:
 *
 * - `passed`: its last run exited with code 0, and no file the run changed is different since.
 * - `failed`: its last run did not pass, and no file the run changed is different since.
 * - `stale`: a file the run changed is different since its last run.
 * - `missing`: it never ran to an end in this run.
 * - `unknown`: what the files held when it ran, or since, is not known, because the history could
 *   not record all the run changed.
 */
export type CheckStatus = 'passed' | 'failed' | 'stale' | 'missing' | 'unknown';

/** A required check, and where it stands. */
export interface CheckResult {
	readonly command: string;
	readonly status: CheckStatus;
	/**
	 * How its last run ended, such as "exited with code 1", or why the harness could not run it
	 * now. Absent when it never ran and nothing stopped it.
	 */
	readonly how?: string;
	/** What its last run printed, or the end of it. Absent when it never ran. */
	readonly output?: string;
}

/** Whether every required check passed for the files as they are now, and where each stands. */
export interface Verification {
	readonly met: boolean;
	readonly checks: readonly CheckResult[];
}

/**
 * One phase of the plan a phased run carried out, from `createLLMOrchestrator`:
 *
 * - `approved`: the reviewer approved it, with its required checks passing.
 * - `unfinished`: the run ended in it, such as once it went to the planner too often.
 * - `pending`: the run ended before it began.
 */
export interface PhaseResult {
	readonly goal: string;
	readonly status: 'approved' | 'unfinished' | 'pending';
	/** What the executor said it did, for an approved phase. */
	readonly summary?: string;
	/** Its required checks at its last barrier. Absent with none, or before any ran. */
	readonly verification?: Verification;
	/** What its own commit did, when the run commits after each phase. */
	readonly commits?: CommitReport;
}
