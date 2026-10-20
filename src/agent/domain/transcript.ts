import type { ProgressAgent } from './agent.ts';

/**
 * What the model of one run saw, for a person debugging a run that went wrong. Only agents on
 * the model APIs produce one.
 */
export interface Transcript {
	/**
	 * In `createLLMOrchestrator`, the role the run was of, or `explorer` for an explorer a role
	 * sent. Missing for an agent from `createLLMAgent`.
	 */
	agent?: ProgressAgent | 'explorer';
	/** How the run ended. A failed run may be retried, and each attempt has its own transcript. */
	outcome: 'completed' | 'failed' | 'cancelled';
	/**
	 * Plain JSON for a person to read: the instructions, the tool definitions, every message of
	 * the run's context with the model's last answer and what the tools returned, and the error
	 * a run that did not complete ended with. Unstable: its shape can change in any release, so
	 * read it, but do not build on it.
	 */
	content: unknown;
}

/**
 * Receives each run's transcript once the run ended, however it ended. A failure here is
 * logged, never the run's: debugging must not change what it observes.
 */
export type TranscriptCallback = (transcript: Transcript) => void | Promise<void>;
