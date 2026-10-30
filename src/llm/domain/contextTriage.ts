/** A tool result the agent may still need word for word, with the call it answers. */
export interface TriagedResult {
	tool: string;
	input: unknown;
	output: string;
}

/**
 * Judges which tool results an agent needs word for word once its context is compacted: Jev's
 * decision, behind its own port, so a compactor works the same without it. Internal.
 */
export interface ContextTriage {
	/**
	 * How much the agent needs each of `results` word for word to go on from its latest answer,
	 * in their order: from 0, not again, to 3, word for word.
	 *
	 * @param task the user's request for the run.
	 * @param latestAnswer the model's latest answer, as text.
	 */
	score(
		request: { task: string; latestAnswer: string; results: TriagedResult[] },
		signal: AbortSignal,
	): Promise<number[]>;
}

/** The score from which a tool result is kept word for word: its exact details matter. */
export const keptScore = 2;
